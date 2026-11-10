"""Preview image contract tests (upload limits, privacy, revisions, dedupe).

Run from the repository root:

    python -m pytest catalog_service/tests -q
"""

from __future__ import annotations

import io
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from catalog_service import images
from catalog_service.app import create_app
from catalog_service.config import Config
from catalog_service.security import hash_password
from catalog_service.store import init_db

ORIGIN = "https://catalog.test"
PASSWORD = "correct horse battery staple"


def preset_data():
    return {"positive": "masterpiece", "negative": "low quality"}


def item_body(name="测试预设"):
    return {
        "kind": "preset",
        "name": name,
        "description": "",
        "category": "test",
        "order": 1,
        "data": preset_data(),
    }


def png_bytes(size=(1200, 800), color=(200, 20, 20)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture()
def ctx(tmp_path):
    db_path = tmp_path / "catalog.db"
    config = Config(
        public_origin=ORIGIN,
        db_path=str(db_path),
        admin_password_hash=hash_password(PASSWORD),
        cookie_secure=False,
        session_ttl_seconds=3600,
    )
    return TestClient(create_app(config), base_url=ORIGIN), config


def login(client) -> str:
    response = client.post(
        "/api/admin/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}
    )
    assert response.status_code == 200, response.text
    return response.json()["csrfToken"]


def write_headers(csrf: str, **extra) -> dict:
    return {"Origin": ORIGIN, "X-CSRF-Token": csrf, **extra}


def create_item(client, csrf, name="测试预设") -> dict:
    response = client.post(
        "/api/admin/items", json=item_body(name), headers=write_headers(csrf)
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload(client, item_id, base_rev, csrf, data: bytes, content_type="image/png"):
    return client.post(
        f"/api/admin/items/{item_id}/preview?baseRev={base_rev}",
        content=data,
        headers=write_headers(csrf, **{"Content-Type": content_type}),
    )


def publish(client, item_id, base_rev, csrf) -> dict:
    response = client.post(
        f"/api/admin/items/{item_id}/publish",
        json={"baseRev": base_rev},
        headers=write_headers(csrf),
    )
    assert response.status_code == 200, response.text
    return response.json()


def asset_count(config) -> int:
    conn = sqlite3.connect(config.db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM preview_assets").fetchone()[0]
    finally:
        conn.close()


# ------------------------------------------------------------------ auth gate


def test_preview_upload_requires_session_origin_and_csrf(ctx):
    client, config = ctx
    anon = TestClient(create_app(config), base_url=ORIGIN)
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]
    body = png_bytes()

    anonymous = anon.post(
        f"/api/admin/items/{item_id}/preview?baseRev=1",
        content=body,
        headers={"Content-Type": "image/png"},
    )
    assert anonymous.status_code == 401
    assert anonymous.headers["cache-control"] == "no-store"

    bad_origin = client.post(
        f"/api/admin/items/{item_id}/preview?baseRev=1",
        content=body,
        headers={
            "Content-Type": "image/png",
            "Origin": "https://evil.test",
            "X-CSRF-Token": csrf,
        },
    )
    assert bad_origin.status_code == 403

    missing_csrf = client.post(
        f"/api/admin/items/{item_id}/preview?baseRev=1",
        content=body,
        headers={"Content-Type": "image/png", "Origin": ORIGIN},
    )
    assert missing_csrf.status_code == 403

    no_rev = client.post(
        f"/api/admin/items/{item_id}/preview",
        content=body,
        headers=write_headers(csrf, **{"Content-Type": "image/png"}),
    )
    assert no_rev.status_code == 400

    assert anon.get(f"/api/admin/items/{item_id}/preview?rev=1").status_code == 401
    assert (
        anon.delete(f"/api/admin/items/{item_id}/preview?baseRev=1").status_code == 401
    )


# --------------------------------------------------------------- compression


def test_upload_compresses_to_webp_within_limits(ctx):
    client, config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]

    response = upload(client, item_id, 1, csrf, png_bytes((1400, 900)))
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["draftRev"] == 2
    assert item["publishedRevision"] is None
    assert item["hasUnpublishedChanges"] is True
    preview = item["preview"]
    assert preview["mime"] == "image/webp"
    assert preview["url"] == f"/api/admin/items/{item_id}/preview?rev=2"
    assert max(preview["width"], preview["height"]) <= images.MAX_OUTPUT_EDGE
    assert 0 < preview["bytes"] <= images.MAX_OUTPUT_BYTES

    image_response = client.get(preview["url"])
    assert image_response.status_code == 200
    assert image_response.headers["content-type"] == "image/webp"
    assert image_response.headers["x-content-type-options"] == "nosniff"
    assert image_response.headers["cache-control"] == "no-store"
    assert len(image_response.content) == preview["bytes"]
    decoded = Image.open(io.BytesIO(image_response.content))
    assert decoded.format == "WEBP"
    assert decoded.size == (preview["width"], preview["height"])

    etag = image_response.headers["etag"]
    revalidated = client.get(preview["url"], headers={"If-None-Match": etag})
    assert revalidated.status_code == 304


def test_upload_rejects_fake_bomb_oversized_animated_and_svg(ctx):
    client, config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]

    fake = upload(client, item_id, 1, csrf, b"definitely not an image")
    assert fake.status_code == 400
    assert "detail" in fake.json()

    bomb = upload(client, item_id, 1, csrf, png_bytes((5000, 5000)))
    assert bomb.status_code == 400
    assert "pixels" in bomb.json()["detail"]

    big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (images.MAX_INPUT_BYTES + 1)
    oversized = upload(client, item_id, 1, csrf, big)
    assert oversized.status_code == 413
    assert oversized.headers["cache-control"] == "no-store"

    svg = upload(
        client,
        item_id,
        1,
        csrf,
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        content_type="image/svg+xml",
    )
    assert svg.status_code == 400

    frames = [
        Image.new("RGB", (64, 64), (i * 40, 0, 0)) for i in range(3)
    ]
    buffer = io.BytesIO()
    frames[0].save(
        buffer,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=100,
        loop=0,
    )
    animated = upload(client, item_id, 1, csrf, buffer.getvalue(), "image/webp")
    assert animated.status_code == 400
    assert "animated" in animated.json()["detail"]

    assert asset_count(config) == 0


# --------------------------------------------------------------- noise edge


def test_noise_image_metadata_matches_encoded_size(ctx):
    """Incompressible input forces shrinking; metadata must match real WebP size."""
    client, _config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]

    noise = Image.frombytes("RGB", (480, 480), os.urandom(480 * 480 * 3))
    buffer = io.BytesIO()
    noise.save(buffer, format="PNG")

    response = upload(client, item_id, 1, csrf, buffer.getvalue())
    assert response.status_code == 200, response.text
    preview = response.json()["preview"]
    assert preview["bytes"] <= images.MAX_OUTPUT_BYTES
    assert max(preview["width"], preview["height"]) <= images.MAX_OUTPUT_EDGE

    served = client.get(preview["url"])
    assert served.status_code == 200
    assert len(served.content) == preview["bytes"]
    decoded = Image.open(io.BytesIO(served.content))
    assert decoded.size == (preview["width"], preview["height"])

    processed = images.process_image(buffer.getvalue())
    assert processed.bytes == len(processed.data)
    assert processed.bytes <= images.MAX_OUTPUT_BYTES
    assert Image.open(io.BytesIO(processed.data)).size == (
        processed.width,
        processed.height,
    )


# ------------------------------------------------------------------- privacy


def test_draft_preview_hidden_until_publish(ctx):
    client, _config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]
    upload(client, item_id, 1, csrf, png_bytes())

    assert client.get(f"/api/catalog/{item_id}/preview?revision=2").status_code == 404
    assert client.get(f"/api/catalog/{item_id}").status_code == 404
    assert client.get("/api/catalog").json()["items"] == []

    published = publish(client, item_id, 2, csrf)
    assert published["preview"]["url"] == f"/api/admin/items/{item_id}/preview?rev=2"
    assert published["preview"]["mime"] == "image/webp"

    catalog = client.get("/api/catalog").json()
    assert catalog["items"][0]["preview"]["url"] == f"/api/catalog/{item_id}/preview?revision=2"
    detail = client.get(f"/api/catalog/{item_id}")
    assert detail.json()["preview"]["width"] == published["preview"]["width"]

    public = client.get(f"/api/catalog/{item_id}/preview?revision=2")
    assert public.status_code == 200
    assert public.headers["content-type"] == "image/webp"
    assert public.headers["x-content-type-options"] == "nosniff"
    assert public.headers["cache-control"] == "no-cache"
    assert public.headers["etag"]


def test_draft_preview_edit_keeps_published_image(ctx):
    client, _config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]

    upload(client, item_id, 1, csrf, png_bytes(color=(10, 200, 10)))
    publish(client, item_id, 2, csrf)
    before = client.get(f"/api/catalog/{item_id}/preview?revision=2").content

    replaced = upload(client, item_id, 2, csrf, png_bytes(color=(10, 10, 200)))
    assert replaced.status_code == 200
    assert replaced.json()["draftRev"] == 3
    assert replaced.json()["publishedRevision"] == 2
    assert replaced.json()["preview"]["url"] == f"/api/admin/items/{item_id}/preview?rev=3"

    after = client.get(f"/api/catalog/{item_id}/preview?revision=2").content
    assert after == before
    assert client.get("/api/catalog").json()["catalogVersion"] == 1

    publish(client, item_id, 3, csrf)
    assert client.get(f"/api/catalog/{item_id}/preview?revision=3").content != before
    # Historical revision stays bound to its own image.
    assert client.get(f"/api/catalog/{item_id}/preview?revision=2").content == before
    # Never-published revision numbers do not resolve.
    assert client.get(f"/api/catalog/{item_id}/preview?revision=99").status_code == 404
    assert client.get(f"/api/catalog/{item_id}/preview?revision=x").status_code == 400


def test_clear_disable_republish_preview(ctx):
    client, config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]
    upload(client, item_id, 1, csrf, png_bytes())
    publish(client, item_id, 2, csrf)
    published_image = client.get(f"/api/catalog/{item_id}/preview?revision=2").content

    cleared = client.delete(
        f"/api/admin/items/{item_id}/preview?baseRev=2", headers=write_headers(csrf)
    )
    assert cleared.status_code == 200
    assert cleared.json()["preview"] is None
    assert cleared.json()["draftRev"] == 3
    # Published snapshot still serves its own image.
    assert client.get(f"/api/catalog/{item_id}/preview?revision=2").content == published_image
    assert asset_count(config) == 1

    stale = client.delete(
        f"/api/admin/items/{item_id}/preview?baseRev=2", headers=write_headers(csrf)
    )
    assert stale.status_code == 409
    assert stale.json()["current"]["draftRev"] == 3

    disabled = client.post(
        f"/api/admin/items/{item_id}/disable", json={"baseRev": 3}, headers=write_headers(csrf)
    )
    assert disabled.status_code == 200
    assert client.get(f"/api/catalog/{item_id}/preview?revision=2").status_code == 410
    assert client.get("/api/catalog").json()["items"] == []

    publish(client, item_id, 3, csrf)
    assert client.get(f"/api/catalog/{item_id}/preview?revision=3").status_code == 404
    assert client.get(f"/api/catalog/{item_id}/preview?revision=2").content == published_image


# ------------------------------------------------------- conflict / dedupe


def test_stale_upload_leaves_no_orphan_blob(ctx):
    client, config = ctx
    csrf = login(client)
    created = create_item(client, csrf)
    item_id = created["id"]

    conflict = upload(client, item_id, 99, csrf, png_bytes())
    assert conflict.status_code == 409
    assert conflict.json()["current"]["draftRev"] == 1
    assert asset_count(config) == 0

    ok = upload(client, item_id, 1, csrf, png_bytes())
    assert ok.status_code == 200
    assert asset_count(config) == 1

    # Same bytes on a second item reuse one blob; draft pointers stay separate.
    other = create_item(client, csrf, name="第二个")
    second = upload(client, other["id"], 1, csrf, png_bytes())
    assert second.status_code == 200
    assert asset_count(config) == 1
    assert second.json()["preview"]["bytes"] == ok.json()["preview"]["bytes"]


def test_preview_fields_cannot_be_written_through_create_or_patch(ctx):
    client, _config = ctx
    csrf = login(client)
    injected = item_body()
    injected["preview"] = {"url": "https://evil.test/x.webp"}
    response = client.post("/api/admin/items", json=injected, headers=write_headers(csrf))
    assert response.status_code == 400

    created = create_item(client, csrf)
    assert created["preview"] is None
    patched = client.patch(
        f"/api/admin/items/{created['id']}",
        json={"baseRev": 1, "preview": None},
        headers=write_headers(csrf),
    )
    assert patched.status_code == 400


# ------------------------------------------------- legacy DB / seed compat


OLD_ITEMS_SQL = """
CREATE TABLE items (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, legacy_id TEXT UNIQUE, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    order_index INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    draft_rev INTEGER NOT NULL, published_revision INTEGER,
    draft_data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE revisions (
    item_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '', order_index INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (item_id, revision)
);
"""


def test_legacy_database_stays_compatible(tmp_path):
    db_path = str(tmp_path / "legacy.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(OLD_ITEMS_SQL)
    conn.execute(
        "INSERT INTO items(id, kind, legacy_id, name, status, draft_rev, "
        "published_revision, draft_data, created_at, updated_at) VALUES "
        "('shared:legacy', 'preset', 'anima_priview_v1', '旧预设', 'published', 1, 1, "
        "'{\"positive\":\"a\",\"negative\":\"b\"}', '2026-01-01T00:00:00Z', "
        "'2026-01-01T00:00:00Z')"
    )
    conn.execute(
        "INSERT INTO revisions(item_id, revision, kind, name, description, category, "
        "order_index, data, created_at) VALUES ('shared:legacy', 1, 'preset', '旧预设', "
        "'', '', 0, '{\"positive\":\"a\",\"negative\":\"b\"}', '2026-01-01T00:00:00Z')"
    )
    conn.commit()
    conn.close()

    init_db(db_path)
    config = Config(
        public_origin=ORIGIN,
        db_path=db_path,
        admin_password_hash=hash_password(PASSWORD),
        cookie_secure=False,
        session_ttl_seconds=3600,
    )
    client = TestClient(create_app(config), base_url=ORIGIN)

    catalog = client.get("/api/catalog").json()
    assert catalog["items"][0]["preview"] is None
    detail = client.get("/api/catalog/shared:legacy")
    assert detail.status_code == 200
    assert detail.json()["preview"] is None
    assert client.get("/api/catalog/shared:legacy/preview?revision=1").status_code == 404

    csrf = login(client)
    item = client.get("/api/admin/items/shared:legacy").json()
    assert item["preview"] is None
    # A legacy item can still receive a new preview, and publishing keeps it.
    assert upload(client, "shared:legacy", 1, csrf, png_bytes()).status_code == 200
    publish(client, "shared:legacy", 2, csrf)
    served = client.get("/api/catalog/shared:legacy/preview?revision=2")
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"
