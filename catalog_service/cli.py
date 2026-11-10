"""CLI for the shared catalog service (trusted, local-only operations).

Commands
    init-admin   interactively hash an admin password (scrypt) and print the
                 CATALOG_ADMIN_PASSWORD_HASH value; the password itself is never
                 written to disk or logs
    seed FILE    import a trusted JSON list of items as drafts (idempotent)
    backup DEST  consistent online backup using the SQLite backup API
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sqlite3
import sys

from .config import ConfigError
from .security import hash_password
from .store import connect, init_db, seed_items
from .validation import ValidationError


def _resolve_db(args) -> str:
    db_path = args.db or os.environ.get("CATALOG_DB_PATH")
    if not db_path:
        raise SystemExit("--db or CATALOG_DB_PATH is required")
    return db_path


def cmd_init_admin(args) -> int:
    if args.salt_hex:
        salt = bytes.fromhex(args.salt_hex)
    else:
        salt = None
    password = getpass.getpass("Admin password: ")
    confirm = getpass.getpass("Repeat admin password: ")
    if password != confirm:
        print("passwords do not match", file=sys.stderr)
        return 1
    if len(password) < 12:
        print("password must be at least 12 characters", file=sys.stderr)
        return 1
    encoded = hash_password(password, salt=salt)
    print(encoded)
    print(
        "\nStore the line above as CATALOG_ADMIN_PASSWORD_HASH in the service "
        "environment (never the plaintext password).",
        file=sys.stderr,
    )
    return 0


def cmd_seed(args) -> int:
    db_path = _resolve_db(args)
    try:
        with open(args.file, "r", encoding="utf-8") as handle:
            entries = json.load(handle)
    except OSError as exc:
        print(f"cannot read seed file: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"seed file is not valid JSON: {exc}", file=sys.stderr)
        return 1
    if not isinstance(entries, list):
        print("seed file must contain a JSON list", file=sys.stderr)
        return 1
    init_db(db_path)
    conn = connect(db_path)
    try:
        result = seed_items(conn, entries)
    except ValidationError as exc:
        print(f"seed rejected: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_backup(args) -> int:
    db_path = _resolve_db(args)
    if not os.path.exists(db_path):
        print(f"database not found: {db_path}", file=sys.stderr)
        return 1
    if os.path.exists(args.dest) and not args.force:
        print(f"destination exists: {args.dest} (use --force)", file=sys.stderr)
        return 1
    source = connect(db_path)
    target = sqlite3.connect(args.dest)
    try:
        source.backup(target)
        target.execute("PRAGMA journal_mode = DELETE")
        target.commit()
    finally:
        target.close()
        source.close()
    print(f"backup written to {args.dest}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="catalog_service.cli")
    parser.add_argument("--db", help="database path (default: CATALOG_DB_PATH)")
    sub = parser.add_subparsers(dest="command", required=True)

    init_admin = sub.add_parser("init-admin", help="hash an admin password interactively")
    init_admin.add_argument("--salt-hex", help="deterministic salt (tests only)")
    init_admin.set_defaults(func=cmd_init_admin)

    seed = sub.add_parser("seed", help="import trusted JSON list as drafts")
    seed.add_argument("file")
    seed.set_defaults(func=cmd_seed)

    backup = sub.add_parser("backup", help="consistent backup via SQLite backup API")
    backup.add_argument("dest")
    backup.add_argument("--force", action="store_true", help="overwrite existing destination")
    backup.set_defaults(func=cmd_backup)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
