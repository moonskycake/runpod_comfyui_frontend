"""End-to-end ASGI tests for the catalog service.

Run from the repository root:

    python -m pytest catalog_service/tests -q

Every test uses a temporary SQLite database; no browser data or deployed
database is touched.
"""

from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from catalog_service.app import create_app
from catalog_service.cli import cmd_backup
from catalog_service.config import Config
from catalog_service.security import hash_password
from catalog_service.store import connect, init_db, seed_items

ORIGIN = "https://catalog.test"
PASSWORD = "correct horse battery staple"


def template_data(*, workflow=None):
    return {
        "schemaVersion": 2,
        "workflow": workflow or {"12": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}"}}},
        "defaults": {"prompt": "hello"},
        "editor": {"fields": [{"id": "prompt", "nodeId": "12", "inputName": "text"}]},
    }


def preset_data():
    return {"positive": "masterpiece", "negative": "low quality"}


def item_body(kind="preset", name="测试预设", **overrides):
    body = {
        "kind": kind,
        "name": name,
        "description": "",
        "category": "test",
        "order": 1,
        "data": preset_data() if kind == "preset" else template_data(),
    }
    body.update(overrides)
    return body


@pytest.fixture()
def make_app(tmp_path):
    def factory(*, cookie_secure: bool = False, password_hash: str | None = None):
        db_path = tmp_path / "catalog.db"
        config = Config(
            public_origin=ORIGIN,
            db_path=str(db_path),
            admin_password_hash=password_hash or hash_password(PASSWORD),
            cookie_secure=cookie_secure,
            session_ttl_seconds=3600,
        )
        return TestClient(create_app(config), base_url=ORIGIN), config

    return factory


@pytest.fixture()
def client(make_app):
    client, _config = make_app()
    return client


def login(client) -> str:
    response = client.post(
        "/api/admin/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}
    )
    assert response.status_code == 200, response.text
    return response.json()["csrfToken"]


def write_headers(csrf: str, *, origin: str = ORIGIN) -> dict:
    return {"Origin": origin, "X-CSRF-Token": csrf}


def create_item(client, body, csrf) -> dict:
    response = client.post(
        "/api/admin/items", json=body, headers=write_headers(csrf)
    )
    assert response.status_code == 201, response.text
    return response.json()


def publish(client, item_id, base_rev, csrf, **extra) -> dict:
    response = client.post(
        f"/api/admin/items/{item_id}/publish",
        json={"baseRev": base_rev, **extra},
        headers=write_headers(csrf),
    )
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------- public/auth


def test_public_catalog_empty_and_admin_requires_session(client):
    catalog = client.get("/api/catalog")
    assert catalog.status_code == 200
    assert catalog.json() == {"catalogVersion": 0, "items": []}
    assert catalog.headers["cache-control"] == "no-cache"
    assert catalog.headers["etag"]

    assert client.get("/api/admin/items").status_code == 401
    forged = client.post(
        "/api/admin/items",
        json=item_body(),
        headers={"Origin": ORIGIN, "X-CSRF-Token": "forged", "Cookie": "rp_catalog_session=forged"},
    )
    assert forged.status_code == 401
    assert forged.headers["cache-control"] == "no-store"


def test_login_origin_csrf_and_logout(client):
    bad_origin = client.post(
        "/api/admin/login", json={"password": PASSWORD}, headers={"Origin": "https://evil.test"}
    )
    assert bad_origin.status_code == 403
    assert client.post("/api/admin/login", json={"password": PASSWORD}).status_code == 403

    wrong = client.post(
        "/api/admin/login", json={"password": "nope"}, headers={"Origin": ORIGIN}
    )
    assert wrong.status_code == 401

    csrf = login(client)
    session = client.get("/api/admin/session")
    assert session.status_code == 200
    assert session.json()["csrfToken"] == csrf

    no_csrf = client.post("/api/admin/items", json=item_body(), headers={"Origin": ORIGIN})
    assert no_csrf.status_code == 403
    bad_csrf = client.post(
        "/api/admin/items",
        json=item_body(),
        headers={"Origin": ORIGIN, "X-CSRF-Token": "forged"},
    )
    assert bad_csrf.status_code == 403
    bad_origin_write = client.post(
        "/api/admin/items",
        json=item_body(),
        headers=write_headers(csrf, origin="https://evil.test"),
    )
    assert bad_origin_write.status_code == 403

    created = create_item(client, item_body(), csrf)
    assert created["status"] == "draft"

    logout = client.post("/api/admin/logout", headers=write_headers(csrf))
    assert logout.status_code == 200
    assert logout.json() == {"authenticated": False}
    assert client.get("/api/admin/session").status_code == 401


def test_login_rate_limit_per_ip(client):
    for _ in range(5):
        assert (
            client.post(
                "/api/admin/login", json={"password": "wrong"}, headers={"Origin": ORIGIN}
            ).status_code
            == 401
        )
    limited = client.post(
        "/api/admin/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}
    )
    assert limited.status_code == 429
    assert limited.headers["retry-after"]


def test_session_cookie_attributes(make_app):
    secure_client, _ = make_app(cookie_secure=True)
    response = secure_client.post(
        "/api/admin/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}
    )
    cookie = response.headers["set-cookie"].lower()
    assert "rp_catalog_session=" in cookie
    assert "httponly" in cookie
    assert "secure" in cookie
    assert "samesite=strict" in cookie
    assert "path=/api/admin" in cookie

    dev_client, _ = make_app(cookie_secure=False)
    response = dev_client.post(
        "/api/admin/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}
    )
    assert "secure" not in response.headers["set-cookie"].lower()


# ------------------------------------------------------- draft/publish privacy


def test_draft_never_leaks_and_publish_works(client):
    csrf = login(client)
    created = create_item(client, item_body(kind="template", name="人像 v1"), csrf)
    item_id = created["id"]

    assert client.get("/api/catalog").json()["items"] == []
    assert client.get(f"/api/catalog/{item_id}").status_code == 404

    published = publish(client, item_id, 1, csrf)
    assert published["status"] == "published"
    assert published["publishedRevision"] == 1
    assert published["hasUnpublishedChanges"] is False

    catalog = client.get("/api/catalog").json()
    assert catalog["catalogVersion"] == 1
    assert [item["id"] for item in catalog["items"]] == [item_id]
    assert "data" not in catalog["items"][0]

    detail = client.get(f"/api/catalog/{item_id}")
    assert detail.status_code == 200
    assert detail.json()["data"] == template_data()
    etag = detail.headers["etag"]
    assert client.get(f"/api/catalog/{item_id}", headers={"If-None-Match": etag}).status_code == 304


def test_edit_after_publish_does_not_change_public_snapshot(client):
    csrf = login(client)
    created = create_item(client, item_body(kind="template", name="v1"), csrf)
    item_id = created["id"]
    publish(client, item_id, 1, csrf)
    before = client.get(f"/api/catalog/{item_id}").json()

    patched = client.patch(
        f"/api/admin/items/{item_id}",
        json={"baseRev": 1, "name": "v2", "data": template_data(workflow={"34": {"class_type": "X"}})},
        headers=write_headers(csrf),
    )
    assert patched.status_code == 200
    assert patched.json()["draftRev"] == 2
    assert patched.json()["hasUnpublishedChanges"] is True
    assert patched.json()["publishedRevision"] == 1

    after = client.get(f"/api/catalog/{item_id}").json()
    assert after == before
    catalog = client.get("/api/catalog").json()
    assert catalog["catalogVersion"] == 1
    assert catalog["items"][0]["publishedRevision"] == 1

    publish(client, item_id, 2, csrf)
    updated = client.get(f"/api/catalog/{item_id}").json()
    assert updated["name"] == "v2"
    assert updated["publishedRevision"] == 2
    assert client.get("/api/catalog").json()["catalogVersion"] == 2


def test_stale_base_rev_conflict_preserves_server_state(client):
    csrf = login(client)
    created = create_item(client, item_body(name="original"), csrf)
    item_id = created["id"]

    first = client.patch(
        f"/api/admin/items/{item_id}",
        json={"baseRev": 1, "name": "updated"},
        headers=write_headers(csrf),
    )
    assert first.status_code == 200

    stale = client.patch(
        f"/api/admin/items/{item_id}",
        json={"baseRev": 1, "name": "stale write"},
        headers=write_headers(csrf),
    )
    assert stale.status_code == 409
    assert stale.json()["current"]["name"] == "updated"
    assert stale.json()["current"]["draftRev"] == 2

    current = client.get(f"/api/admin/items/{item_id}").json()
    assert current["name"] == "updated"
    assert current["draftRev"] == 2


def test_disable_and_republish(client):
    csrf = login(client)
    item_id = create_item(client, item_body(name="停用测试"), csrf)["id"]
    publish(client, item_id, 1, csrf)

    disabled = client.post(
        f"/api/admin/items/{item_id}/disable",
        json={"baseRev": 1},
        headers=write_headers(csrf),
    )
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "disabled"
    assert client.get("/api/catalog").json()["items"] == []
    assert client.get(f"/api/catalog/{item_id}").status_code == 410
    assert client.get("/api/catalog").json()["catalogVersion"] == 2

    restored = publish(client, item_id, 1, csrf)
    assert restored["status"] == "published"
    assert client.get(f"/api/catalog/{item_id}").status_code == 200
    assert client.get("/api/catalog").json()["catalogVersion"] == 3


def test_delete_only_never_published_draft(client):
    csrf = login(client)
    draft_id = create_item(client, item_body(), csrf)["id"]
    deleted = client.delete(
        f"/api/admin/items/{draft_id}?baseRev=1", headers=write_headers(csrf)
    )
    assert deleted.status_code == 204
    assert client.get(f"/api/admin/items/{draft_id}").status_code == 404

    published_id = create_item(client, item_body(name="published"), csrf)["id"]
    publish(client, published_id, 1, csrf)
    denied = client.delete(
        f"/api/admin/items/{published_id}?baseRev=1", headers=write_headers(csrf)
    )
    assert denied.status_code == 409
    assert client.get(f"/api/admin/items/{published_id}").status_code == 200


# ------------------------------------------------------------------- import


def test_import_is_atomic_and_limited(client):
    csrf = login(client)
    bad = {
        "items": [
            item_body(name="ok"),
            {"kind": "preset", "name": "broken", "data": {"positive": "x"}},
        ]
    }
    response = client.post("/api/admin/import", json=bad, headers=write_headers(csrf))
    assert response.status_code == 400
    assert client.get("/api/admin/items").json()["items"] == []

    good = {
        "items": [
            item_body(name="a"),
            item_body(kind="snippet", name="b", data={"text": "hi", "target": "negative"}),
        ]
    }
    ok = client.post("/api/admin/import", json=good, headers=write_headers(csrf))
    assert ok.status_code == 201
    assert [item["status"] for item in ok.json()["items"]] == ["draft", "draft"]
    assert len(client.get("/api/admin/items").json()["items"]) == 2

    too_many = {"items": [item_body(name=f"n{i}") for i in range(101)]}
    assert (
        client.post("/api/admin/import", json=too_many, headers=write_headers(csrf)).status_code
        == 400
    )


# ------------------------------------------------------------------ validation


def test_schema_validation_rejects_bad_payloads(client):
    csrf = login(client)
    headers = write_headers(csrf)

    unknown_outer = item_body(name="x", sneaky="1")
    assert client.post("/api/admin/items", json=unknown_outer, headers=headers).status_code == 400

    template_unknown = item_body(kind="template", name="x")
    template_unknown["data"]["placeholders"] = {}
    assert client.post("/api/admin/items", json=template_unknown, headers=headers).status_code == 400

    bad_schema = item_body(kind="template", name="x")
    bad_schema["data"]["schemaVersion"] = 3
    assert client.post("/api/admin/items", json=bad_schema, headers=headers).status_code == 400

    bad_workflow = item_body(kind="template", name="x")
    bad_workflow["data"]["workflow"] = ["not", "an", "object"]
    assert client.post("/api/admin/items", json=bad_workflow, headers=headers).status_code == 400

    bad_snippet = item_body(kind="snippet", name="x", data={"text": "t", "target": "both"})
    assert client.post("/api/admin/items", json=bad_snippet, headers=headers).status_code == 400

    blank_name = item_body(name="   ")
    assert client.post("/api/admin/items", json=blank_name, headers=headers).status_code == 400

    tiny_order = item_body(name="x", order=True)
    assert client.post("/api/admin/items", json=tiny_order, headers=headers).status_code == 400

    long_text = item_body(name="x", data={"positive": "a" * (50 * 1024 + 1), "negative": ""})
    assert client.post("/api/admin/items", json=long_text, headers=headers).status_code == 400

    big_workflow = template_data(workflow={"1": {"inputs": {"blob": "a" * (1024 * 1024 + 10)}}})
    assert (
        client.post(
            "/api/admin/items",
            json=item_body(kind="template", name="x", data=big_workflow),
            headers=headers,
        ).status_code
        == 400
    )

    created = create_item(client, item_body(name="keep"), csrf)
    kind_change = client.patch(
        f"/api/admin/items/{created['id']}",
        json={"baseRev": 1, "kind": "template"},
        headers=headers,
    )
    assert kind_change.status_code == 400
    missing_rev = client.patch(
        f"/api/admin/items/{created['id']}", json={"name": "no rev"}, headers=headers
    )
    assert missing_rev.status_code == 400


def test_body_size_cap_is_enforced_on_stream(client):
    csrf = login(client)
    oversized = b'{"kind":"preset","name":"big","data":{"positive":"' + b"a" * (2 * 1024 * 1024) + b'"}}'
    response = client.post(
        "/api/admin/items",
        content=oversized,
        headers={**write_headers(csrf), "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"


def test_publish_requires_secret_acknowledgement(client):
    csrf = login(client)
    workflow = {
        "12": {
            "class_type": "HttpRequest",
            "inputs": {"api_key": "super-secret-value", "url": "https://example.test"},
        }
    }
    created = create_item(
        client, item_body(kind="template", name="secret", data=template_data(workflow=workflow)), csrf
    )
    item_id = created["id"]

    blocked = client.post(
        f"/api/admin/items/{item_id}/publish",
        json={"baseRev": 1},
        headers=write_headers(csrf),
    )
    assert blocked.status_code == 400
    detail = blocked.json()["detail"]
    assert "workflow.12.inputs.api_key" in detail
    assert "super-secret-value" not in detail
    assert client.get(f"/api/catalog/{item_id}").status_code == 404

    publish(client, item_id, 1, csrf, acknowledgeSecrets=True)
    detail_response = client.get(f"/api/catalog/{item_id}")
    assert detail_response.status_code == 200


# ------------------------------------------------------- seed/backup/error hdr


def test_seed_is_idempotent_and_keeps_admin_edits(tmp_path):
    db_path = str(tmp_path / "seed.db")
    init_db(db_path)
    entries = [
        {
            "kind": "template",
            "legacyId": "anima_priview_v1",
            "name": "anima_priview_v1",
            "data": template_data(),
        },
        {
            "kind": "template",
            "legacyId": "anima_preview2_lora_v1",
            "name": "anima_preview2_lora_v1",
            "data": template_data(),
        },
    ]
    conn = connect(db_path)
    try:
        first = seed_items(conn, entries)
        second = seed_items(conn, entries)
        rows = conn.execute("SELECT id, legacy_id, draft_rev FROM items ORDER BY legacy_id").fetchall()
        assert first["inserted"] == 2
        assert second["inserted"] == 0
        assert second["skipped"] == 2
        assert [row["legacy_id"] for row in rows] == ["anima_preview2_lora_v1", "anima_priview_v1"]
        ids = {row["id"] for row in rows}
        assert all(item_id.startswith("shared:") for item_id in ids)

        # an admin edit must survive a re-seed (seed never overwrites)
        conn.execute("UPDATE items SET name = 'admin edit', draft_rev = 5 WHERE legacy_id = ?", ("anima_priview_v1",))
        seed_items(conn, entries)
        name, rev = conn.execute(
            "SELECT name, draft_rev FROM items WHERE legacy_id = 'anima_priview_v1'"
        ).fetchone()
        assert name == "admin edit"
        assert rev == 5
    finally:
        conn.close()

    dest = str(tmp_path / "backup.db")
    assert cmd_backup(SimpleNamespace(db=db_path, dest=dest, force=False)) == 0
    backup_conn = sqlite3.connect(dest)
    try:
        count = backup_conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        version = backup_conn.execute("SELECT value FROM meta WHERE key='catalog_version'").fetchone()[0]
    finally:
        backup_conn.close()
    assert count == 2
    assert version == "0"


def test_admin_responses_are_no_store_and_public_detail_has_etag(client):
    csrf = login(client)
    item_id = create_item(client, item_body(), csrf)["id"]
    publish(client, item_id, 1, csrf)

    for path in ("/api/admin/items", f"/api/admin/items/{item_id}"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"

    missing = client.get("/api/admin/items/shared:does-not-exist")
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"

    detail = client.get(f"/api/catalog/{item_id}")
    assert detail.headers["cache-control"] == "no-cache"
    assert detail.headers["etag"]
    assert client.get(f"/api/catalog/{item_id}", headers={"If-None-Match": detail.headers["etag"]}).status_code == 304


def test_deeply_nested_json_is_400_not_500(client):
    csrf = login(client)
    nested = b'{"a":' * 3000 + b'1' + b'}' * 3000
    response = client.post(
        "/api/admin/items",
        content=nested,
        headers={**write_headers(csrf), "Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert "detail" in response.json()


def test_secret_scan_handles_deep_workflow_without_500(client):
    csrf = login(client)
    workflow = {"inputs": {"api_key": "deep-secret-value"}}
    for _ in range(200):
        workflow = {"nested": workflow}
    created = create_item(
        client,
        item_body(kind="template", name="deep", data=template_data(workflow=workflow)),
        csrf,
    )
    # depth cap: scan cannot drift into a 500, publish still works
    published = publish(client, created["id"], 1, csrf)
    assert published["status"] == "published"
    detail = client.get(f"/api/catalog/{created['id']}")
    assert detail.status_code == 200


def test_create_session_prunes_expired_and_revoked(make_app, tmp_path):
    from catalog_service.store import connect, create_session, init_db

    db_path = str(tmp_path / "sessions.db")
    init_db(db_path)
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO sessions(token_hash, csrf_token, created_at, expires_at, revoked) "
            "VALUES ('expired', 'x', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', 0)"
        )
        conn.execute(
            "INSERT INTO sessions(token_hash, csrf_token, created_at, expires_at, revoked) "
            "VALUES ('revoked', 'y', '2020-01-01T00:00:00Z', '2099-01-02T00:00:00Z', 1)"
        )
        create_session(conn, 3600)
        rows = conn.execute("SELECT token_hash FROM sessions").fetchall()
        assert len(rows) == 1
        assert rows[0]["token_hash"] not in ("expired", "revoked")
    finally:
        conn.close()
