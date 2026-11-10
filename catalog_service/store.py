"""SQLite storage layer (WAL, one connection per request).

Draft content and published snapshots are stored separately: ``items.draft_data``
always holds the editable draft while ``revisions`` holds immutable published
snapshots.  Public reads only ever join the published revision.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone

from .validation import ValidationError

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    legacy_id TEXT UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    order_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    draft_rev INTEGER NOT NULL,
    published_revision INTEGER,
    draft_data TEXT NOT NULL,
    preview_id TEXT,
    preview_rev INTEGER,
    preview_width INTEGER,
    preview_height INTEGER,
    preview_bytes INTEGER,
    preview_mime TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
    item_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    order_index INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    preview_id TEXT,
    preview_width INTEGER,
    preview_height INTEGER,
    preview_bytes INTEGER,
    preview_mime TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, revision)
);
CREATE TABLE IF NOT EXISTS preview_assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_map (
    legacy_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    new_id TEXT NOT NULL,
    migrated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ts ON login_attempts(ts);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, kind, order_index);
"""


class StoreConflict(Exception):
    """Revision precondition failed; ``item_id`` points at current state."""

    def __init__(self, item_id: str, detail: str = "revision conflict"):
        super().__init__(detail)
        self.item_id = item_id
        self.detail = detail


class NotFound(Exception):
    pass


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def compact_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: str) -> None:
    conn = connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.executescript(SCHEMA)
        _migrate_revision_metadata(conn)
        _migrate_preview_columns(conn)
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('catalog_version', '0')"
        )
    finally:
        conn.close()


def _migrate_revision_metadata(conn: sqlite3.Connection) -> None:
    """Add immutable metadata columns to databases created before schema v1.

    SQLite cannot add NOT NULL columns without defaults; older rows get empty
    metadata, which is acceptable because the columns were introduced together
    with the first service release.
    """
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(revisions)")}
    for column, ddl in (
        ("name", "TEXT NOT NULL DEFAULT ''"),
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT NOT NULL DEFAULT ''"),
        ("order_index", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if column not in existing:
            conn.execute(f"ALTER TABLE revisions ADD COLUMN {column} {ddl}")


def _migrate_preview_columns(conn: sqlite3.Connection) -> None:
    """Additive migration for preview references (older DBs stay valid).

    Legacy rows get ``NULL`` preview columns, which serialize as
    ``"preview": null``; no data is rewritten and no asset is created.
    """
    ddl = (
        ("preview_id", "TEXT"),
        ("preview_width", "INTEGER"),
        ("preview_height", "INTEGER"),
        ("preview_bytes", "INTEGER"),
        ("preview_mime", "TEXT"),
    )
    for table in ("items", "revisions"):
        columns = ddl + ((("preview_rev", "INTEGER"),) if table == "items" else ())
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for column, column_type in columns:
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def new_shared_id() -> str:
    return f"shared:{uuid.uuid4()}"

# ---------------------------------------------------------------------------
# catalog version
# ---------------------------------------------------------------------------


def get_catalog_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = 'catalog_version'").fetchone()
    return int(row["value"]) if row else 0


def _bump_catalog_version(conn: sqlite3.Connection) -> int:
    current = get_catalog_version(conn)
    version = current + 1
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('catalog_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(version),),
    )
    return version


# ---------------------------------------------------------------------------
# serialization
# ---------------------------------------------------------------------------


def _preview_payload(row, url: str, revision=None) -> dict | None:
    """Build the response ``preview`` object from denormalized row columns."""
    asset_id = row["preview_id"]
    if not asset_id:
        return None
    width = row["preview_width"]
    height = row["preview_height"]
    size = row["preview_bytes"]
    mime = row["preview_mime"]
    if width is None or height is None or size is None or not mime:
        return None
    return {
        "url": url,
        "width": width,
        "height": height,
        "bytes": size,
        "mime": mime,
    }


def admin_item_from_row(row: sqlite3.Row) -> dict:
    published = row["published_revision"]
    draft_rev = row["draft_rev"]
    preview_rev = row["preview_rev"]
    if row["preview_id"] and preview_rev is not None:
        preview_url = f"/api/admin/items/{row['id']}/preview?rev={preview_rev}"
    else:
        preview_url = ""
    item = {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "description": row["description"],
        "category": row["category"],
        "order": row["order_index"],
        "status": row["status"],
        "draftRev": draft_rev,
        "publishedRevision": published,
        "hasUnpublishedChanges": published is None or published != draft_rev,
        "data": json.loads(row["draft_data"]),
        "preview": _preview_payload(row, preview_url),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if row["legacy_id"]:
        item["legacyId"] = row["legacy_id"]
    return item


def public_metadata_from_row(row: sqlite3.Row) -> dict:
    published = row["published_revision"]
    preview_url = (
        f"/api/catalog/{row['id']}/preview?revision={published}"
        if published is not None
        else ""
    )
    item = {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "description": row["description"],
        "category": row["category"],
        "order": row["order_index"],
        "publishedRevision": published,
        "preview": _preview_payload(row, preview_url),
        "updatedAt": row["published_at"],
    }
    if row["legacy_id"]:
        item["legacyId"] = row["legacy_id"]
    return item


# ---------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------


def get_item_row(conn: sqlite3.Connection, item_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()


def list_item_rows(
    conn: sqlite3.Connection, kind: str | None, status: str | None
) -> list[sqlite3.Row]:
    sql = "SELECT * FROM items"
    clauses: list[str] = []
    params: list = []
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    if status:
        clauses.append("status = ?")
        params.append(status)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY kind, order_index, name, id"
    return conn.execute(sql, params).fetchall()


def list_public_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Published metadata only; the left side supplies identity/legacy mapping."""
    return conn.execute(
        "SELECT i.id AS id, i.kind AS kind, i.legacy_id AS legacy_id, "
        "r.name AS name, r.description AS description, r.category AS category, "
        "r.order_index AS order_index, r.revision AS published_revision, "
        "r.preview_id AS preview_id, r.preview_width AS preview_width, "
        "r.preview_height AS preview_height, r.preview_bytes AS preview_bytes, "
        "r.preview_mime AS preview_mime, "
        "r.created_at AS published_at FROM items i "
        "JOIN revisions r ON r.item_id = i.id AND r.revision = i.published_revision "
        "WHERE i.status = 'published' "
        "ORDER BY i.kind, r.order_index, r.name, i.id"
    ).fetchall()


def public_catalog_snapshot(conn: sqlite3.Connection):
    """Read version + published rows inside one read transaction.

    Prevents a concurrent publish/disable from making the advertised
    catalogVersion disagree with the returned row set (and hence the ETag).
    """
    conn.execute("BEGIN")
    try:
        version = get_catalog_version(conn)
        rows = list_public_rows(conn)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return version, rows


def get_public_snapshot(conn: sqlite3.Connection, item_id: str):
    """Return ``(row, data)`` for the published snapshot, or ``(row, None)``.

    ``row`` is the item row (for status checks) and may be ``None`` when the id
    does not exist at all.  Draft content is never returned here.
    """
    row = get_item_row(conn, item_id)
    if row is None:
        return None, None
    if row["status"] != "published" or row["published_revision"] is None:
        return row, None
    revision = conn.execute(
        "SELECT * FROM revisions WHERE item_id = ? AND revision = ?",
        (item_id, row["published_revision"]),
    ).fetchone()
    if revision is None:
        return row, None
    metadata_row = {
        "id": row["id"],
        "kind": revision["kind"],
        "legacy_id": row["legacy_id"],
        "name": revision["name"],
        "description": revision["description"],
        "category": revision["category"],
        "order_index": revision["order_index"],
        "preview_id": revision["preview_id"],
        "preview_width": revision["preview_width"],
        "preview_height": revision["preview_height"],
        "preview_bytes": revision["preview_bytes"],
        "preview_mime": revision["preview_mime"],
        "published_revision": revision["revision"],
        "published_at": revision["created_at"],
    }
    return row, {
        "data": json.loads(revision["data"]),
        "metadata": public_metadata_from_row(metadata_row),
    }


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------


def _insert_item(
    conn: sqlite3.Connection,
    *,
    item_id: str,
    legacy_id: str | None,
    item: dict,
    now: str,
) -> sqlite3.Row:
    conn.execute(
        "INSERT INTO items(id, kind, legacy_id, name, description, category, "
        "order_index, status, draft_rev, published_revision, draft_data, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, NULL, ?, ?, ?)",
        (
            item_id,
            item["kind"],
            legacy_id,
            item["name"],
            item["description"],
            item["category"],
            item["order"],
            compact_json(item["data"]),
            now,
            now,
        ),
    )
    if legacy_id:
        conn.execute(
            "INSERT OR IGNORE INTO legacy_map(legacy_id, source, new_id, migrated_at) "
            "VALUES (?, 'shared', ?, ?)",
            (legacy_id, item_id, now),
        )
    row = get_item_row(conn, item_id)
    assert row is not None
    return row


def create_item(conn: sqlite3.Connection, item: dict, item_id: str | None = None) -> dict:
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = _insert_item(
            conn, item_id=item_id or new_shared_id(), legacy_id=None, item=item, now=now
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return admin_item_from_row(row)


def patch_item(conn: sqlite3.Connection, item_id: str, changes: dict) -> dict:
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = get_item_row(conn, item_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise NotFound(item_id)
        if row["draft_rev"] != changes["baseRev"]:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "baseRev is stale")
        new_data = changes.get("data")
        conn.execute(
            "UPDATE items SET name = ?, description = ?, category = ?, order_index = ?, "
            "draft_data = ?, draft_rev = draft_rev + 1, updated_at = ? WHERE id = ?",
            (
                changes.get("name", row["name"]),
                changes.get("description", row["description"]),
                changes.get("category", row["category"]),
                changes.get("order", row["order_index"]),
                compact_json(new_data) if new_data is not None else row["draft_data"],
                now,
                item_id,
            ),
        )
        row = get_item_row(conn, item_id)
        conn.execute("COMMIT")
    except (NotFound, StoreConflict):
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise
    assert row is not None
    return admin_item_from_row(row)


def publish_item(
    conn: sqlite3.Connection, item_id: str, base_rev: int
) -> dict:
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = get_item_row(conn, item_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise NotFound(item_id)
        if row["draft_rev"] != base_rev:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "baseRev is stale")
        revision = row["draft_rev"]
        conn.execute(
            "INSERT OR IGNORE INTO revisions(item_id, revision, kind, name, description, "
            "category, order_index, data, preview_id, preview_width, preview_height, "
            "preview_bytes, preview_mime, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                item_id,
                revision,
                row["kind"],
                row["name"],
                row["description"],
                row["category"],
                row["order_index"],
                row["draft_data"],
                row["preview_id"],
                row["preview_width"],
                row["preview_height"],
                row["preview_bytes"],
                row["preview_mime"],
                now,
            ),
        )
        conn.execute(
            "UPDATE items SET status = 'published', published_revision = ?, updated_at = ? "
            "WHERE id = ?",
            (revision, now, item_id),
        )
        _bump_catalog_version(conn)
        row = get_item_row(conn, item_id)
        conn.execute("COMMIT")
    except (NotFound, StoreConflict):
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise
    assert row is not None
    return admin_item_from_row(row)


def disable_item(conn: sqlite3.Connection, item_id: str, base_rev: int) -> dict:
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = get_item_row(conn, item_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise NotFound(item_id)
        if row["draft_rev"] != base_rev:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "baseRev is stale")
        if row["status"] != "published":
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "only published items can be disabled")
        conn.execute(
            "UPDATE items SET status = 'disabled', updated_at = ? WHERE id = ?",
            (now, item_id),
        )
        _bump_catalog_version(conn)
        row = get_item_row(conn, item_id)
        conn.execute("COMMIT")
    except (NotFound, StoreConflict):
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise
    assert row is not None
    return admin_item_from_row(row)


def delete_item(conn: sqlite3.Connection, item_id: str, base_rev: int) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = get_item_row(conn, item_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise NotFound(item_id)
        if row["draft_rev"] != base_rev:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "baseRev is stale")
        if row["published_revision"] is not None:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "published items can only be disabled")
        conn.execute("DELETE FROM legacy_map WHERE new_id = ?", (item_id,))
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        _prune_orphan_assets(conn)
        conn.execute("COMMIT")
    except (NotFound, StoreConflict):
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise


def import_items(conn: sqlite3.Connection, items: list[dict]) -> list[dict]:
    """Insert all validated items in one transaction (all-or-nothing)."""
    now = utc_now_iso()
    created: list[dict] = []
    conn.execute("BEGIN IMMEDIATE")
    try:
        for item in items:
            row = _insert_item(conn, item_id=new_shared_id(), legacy_id=None, item=item, now=now)
            created.append(admin_item_from_row(row))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return created


def seed_items(conn: sqlite3.Connection, entries: list[dict]) -> dict:
    """Idempotently insert trusted seed entries; never overwrites existing rows.

    ``entries`` are create-shaped dicts with an optional ``legacyId``.  IDs are
    deterministic UUID5 values so re-running seed against the same input is a
    no-op and keeps IDs stable.
    """
    now = utc_now_iso()
    namespace = uuid.UUID("6f2b6a0e-6a1b-5b3c-9d55-2c0f0f6f9a11")
    inserted = 0
    skipped = 0
    conflicts: list[str] = []
    conn.execute("BEGIN IMMEDIATE")
    try:
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValidationError("seed entry must be an object")
            legacy_id = entry.get("legacyId")
            if legacy_id is not None and not isinstance(legacy_id, str):
                raise ValidationError("legacyId must be a string")
            item = {k: v for k, v in entry.items() if k != "legacyId"}
            # validate_create also rejects unknown fields (e.g. accidental secrets)
            from .validation import validate_create

            shape = validate_create(item)
            if legacy_id:
                existing = conn.execute(
                    "SELECT id FROM items WHERE legacy_id = ?", (legacy_id,)
                ).fetchone()
                mapped = conn.execute(
                    "SELECT new_id FROM legacy_map WHERE legacy_id = ?", (legacy_id,)
                ).fetchone()
                if existing or mapped:
                    skipped += 1
                    continue
                item_id = "shared:" + str(uuid.uuid5(namespace, f"{shape['kind']}:{legacy_id}"))
            else:
                item_id = "shared:" + str(
                    uuid.uuid5(namespace, f"{shape['kind']}:{shape['name']}:{shape['order']}")
                )
            if get_item_row(conn, item_id) is not None:
                conflicts.append(item_id)
                skipped += 1
                continue
            _insert_item(conn, item_id=item_id, legacy_id=legacy_id, item=shape, now=now)
            inserted += 1
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return {"inserted": inserted, "skipped": skipped, "idConflicts": conflicts}


# ---------------------------------------------------------------------------
# preview assets
# ---------------------------------------------------------------------------


def _prune_orphan_assets(conn: sqlite3.Connection) -> None:
    """Drop asset rows no item draft or publish snapshot refers to."""
    conn.execute(
        "DELETE FROM preview_assets WHERE id NOT IN ("
        "SELECT preview_id FROM items WHERE preview_id IS NOT NULL "
        "UNION SELECT preview_id FROM revisions WHERE preview_id IS NOT NULL)"
    )


def get_preview_asset(conn: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM preview_assets WHERE id = ?", (asset_id,)
    ).fetchone()


def set_draft_preview(
    conn: sqlite3.Connection, item_id: str, base_rev: int, asset: dict
) -> dict:
    """Store a processed preview (deduped by SHA256) and point the draft at it.

    Runs in one transaction: a stale ``baseRev`` rolls back before the asset
    row is inserted, so a rejected upload never leaves an orphan blob.
    """
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = get_item_row(conn, item_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise NotFound(item_id)
        if row["draft_rev"] != base_rev:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "baseRev is stale")
        existing = conn.execute(
            "SELECT id FROM preview_assets WHERE sha256 = ?", (asset["sha256"],)
        ).fetchone()
        if existing is None:
            asset_id = asset["sha256"]
            conn.execute(
                "INSERT INTO preview_assets(id, sha256, mime, width, height, bytes, data, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    asset_id,
                    asset["sha256"],
                    asset["mime"],
                    asset["width"],
                    asset["height"],
                    asset["bytes"],
                    asset["data"],
                    now,
                ),
            )
        else:
            asset_id = existing["id"]
        new_rev = row["draft_rev"] + 1
        conn.execute(
            "UPDATE items SET preview_id = ?, preview_rev = ?, preview_width = ?, "
            "preview_height = ?, preview_bytes = ?, preview_mime = ?, draft_rev = ?, "
            "updated_at = ? WHERE id = ?",
            (
                asset_id,
                new_rev,
                asset["width"],
                asset["height"],
                asset["bytes"],
                asset["mime"],
                new_rev,
                now,
                item_id,
            ),
        )
        _prune_orphan_assets(conn)
        updated = get_item_row(conn, item_id)
        conn.execute("COMMIT")
    except (NotFound, StoreConflict):
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise
    assert updated is not None
    return admin_item_from_row(updated)


def clear_draft_preview(conn: sqlite3.Connection, item_id: str, base_rev: int) -> dict:
    """Detach the draft preview. Published snapshots keep their own reference."""
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = get_item_row(conn, item_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise NotFound(item_id)
        if row["draft_rev"] != base_rev:
            conn.execute("ROLLBACK")
            raise StoreConflict(item_id, "baseRev is stale")
        if row["preview_id"] is None:
            conn.execute("ROLLBACK")
            return admin_item_from_row(row)
        conn.execute(
            "UPDATE items SET preview_id = NULL, preview_rev = NULL, preview_width = NULL, "
            "preview_height = NULL, preview_bytes = NULL, preview_mime = NULL, "
            "draft_rev = draft_rev + 1, updated_at = ? WHERE id = ?",
            (now, item_id),
        )
        _prune_orphan_assets(conn)
        updated = get_item_row(conn, item_id)
        conn.execute("COMMIT")
    except (NotFound, StoreConflict):
        raise
    except Exception:
        conn.execute("ROLLBACK")
        raise
    assert updated is not None
    return admin_item_from_row(updated)


def get_admin_preview(
    conn: sqlite3.Connection, item_id: str, revision: int
) -> tuple[sqlite3.Row | None, sqlite3.Row | None]:
    """Return ``(item_row, asset_row)`` for the draft preview at ``revision``.

    A revision mismatch yields ``(row, None)``: the URL is revision-bound, so a
    stale link must not silently serve a newer draft image.
    """
    row = get_item_row(conn, item_id)
    if row is None:
        return None, None
    if not row["preview_id"] or row["preview_rev"] != revision:
        return row, None
    return row, get_preview_asset(conn, row["preview_id"])


def get_public_preview(
    conn: sqlite3.Connection, item_id: str, revision: int | None
) -> tuple[sqlite3.Row | None, sqlite3.Row | None]:
    """Return ``(item_row, asset_row)`` for a published snapshot revision.

    Only immutable published snapshots (current or historical) are served;
    draft previews are never reachable from here.
    """
    row = get_item_row(conn, item_id)
    if row is None:
        return None, None
    if row["status"] != "published" or row["published_revision"] is None:
        return row, None
    target = row["published_revision"] if revision is None else revision
    snapshot = conn.execute(
        "SELECT preview_id FROM revisions WHERE item_id = ? AND revision = ?",
        (item_id, target),
    ).fetchone()
    if snapshot is None or not snapshot["preview_id"]:
        return row, None
    return row, get_preview_asset(conn, snapshot["preview_id"])


# ---------------------------------------------------------------------------
# sessions & login rate limiting
# ---------------------------------------------------------------------------


def create_session(conn: sqlite3.Connection, ttl_seconds: int) -> dict:
    from .security import new_token, sha256_hex

    token = new_token()
    csrf = new_token()
    now = utc_now_iso()
    expires = datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + ttl_seconds, tz=timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute("BEGIN IMMEDIATE")
    try:
        # prune before insert so the table cannot grow without bound
        conn.execute(
            "DELETE FROM sessions WHERE revoked = 1 OR expires_at <= ?", (now,)
        )
        conn.execute(
            "INSERT INTO sessions(token_hash, csrf_token, created_at, expires_at, revoked) "
            "VALUES (?, ?, ?, ?, 0)",
            (sha256_hex(token), csrf, now, expires),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return {"token": token, "csrf": csrf, "expiresAt": expires}


def get_session(conn: sqlite3.Connection, token: str) -> sqlite3.Row | None:
    from .security import sha256_hex

    if not token:
        return None
    row = conn.execute(
        "SELECT * FROM sessions WHERE token_hash = ?", (sha256_hex(token),)
    ).fetchone()
    if row is None or row["revoked"]:
        return None
    if row["expires_at"] <= utc_now_iso():
        return None
    return row


def revoke_session(conn: sqlite3.Connection, token: str) -> None:
    from .security import sha256_hex

    conn.execute("UPDATE sessions SET revoked = 1 WHERE token_hash = ?", (sha256_hex(token),))


def count_recent_failures(conn: sqlite3.Connection, ip: str, since_ts: float) -> tuple[int, int]:
    per_ip = conn.execute(
        "SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts >= ?", (ip, since_ts)
    ).fetchone()["n"]
    total = conn.execute(
        "SELECT COUNT(*) AS n FROM login_attempts WHERE ts >= ?", (since_ts,)
    ).fetchone()["n"]
    return per_ip, total


def record_login_failure(conn: sqlite3.Connection, ip: str, ts: float, before_ts: float) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM login_attempts WHERE ts < ?", (before_ts,))
        conn.execute("INSERT INTO login_attempts(ip, ts) VALUES (?, ?)", (ip, ts))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def clear_login_failures(conn: sqlite3.Connection, ip: str) -> None:
    conn.execute("DELETE FROM login_attempts WHERE ip = ?", (ip,))
