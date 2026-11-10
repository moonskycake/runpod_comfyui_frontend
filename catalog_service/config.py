"""Configuration for the catalog service.

Every value is explicit; nothing is auto-seeded and no default admin password
is baked in.  Configuration errors raise :class:`ConfigError` so the process
fails at startup instead of running half-configured.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit

MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_WORKFLOW_BYTES = 1024 * 1024
MAX_TEXT_BYTES = 50 * 1024
MAX_NAME_CHARS = 120
MAX_DESCRIPTION_CHARS = 2000
MAX_CATEGORY_CHARS = 80
MAX_IMPORT_ITEMS = 100

SESSION_TTL_SECONDS = 30 * 24 * 3600
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_PER_IP = 5
LOGIN_MAX_GLOBAL = 50

COOKIE_NAME = "rp_catalog_session"
COOKIE_PATH = "/api/admin"


class ConfigError(RuntimeError):
    pass


def normalize_origin(raw: str) -> str:
    """Return a canonical ``scheme://host[:port]`` origin.

    Only absolute http(s) origins with no path/query/fragment are accepted.
    The configured origin is the sole authority for Origin validation; request
    Host / X-Forwarded-Host headers are never trusted.
    """
    if not raw or not raw.strip():
        raise ConfigError("CATALOG_PUBLIC_ORIGIN must not be empty")
    value = raw.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https"):
        raise ConfigError("CATALOG_PUBLIC_ORIGIN must use http or https")
    if not parts.netloc:
        raise ConfigError("CATALOG_PUBLIC_ORIGIN is missing a host")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ConfigError("CATALOG_PUBLIC_ORIGIN must be an origin without path")
    if parts.username or parts.password:
        raise ConfigError("CATALOG_PUBLIC_ORIGIN must not contain credentials")
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}"


def _parse_bool(raw: str | None, default: bool) -> bool:
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"invalid boolean value: {raw!r}")


@dataclass(frozen=True)
class Config:
    public_origin: str
    db_path: str
    admin_password_hash: str | None
    cookie_secure: bool = True
    session_ttl_seconds: int = SESSION_TTL_SECONDS

    def validate(self) -> "Config":
        normalize_origin(self.public_origin)
        if not self.db_path:
            raise ConfigError("CATALOG_DB_PATH must not be empty")
        if self.admin_password_hash is not None:
            if not self.admin_password_hash.startswith("scrypt$"):
                raise ConfigError("CATALOG_ADMIN_PASSWORD_HASH must be a scrypt$ hash")
            if self.admin_password_hash.count("$") != 5:
                raise ConfigError("CATALOG_ADMIN_PASSWORD_HASH is malformed")
        return self

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Config":
        env = os.environ if env is None else env
        origin = env.get("CATALOG_PUBLIC_ORIGIN")
        if not origin:
            raise ConfigError("CATALOG_PUBLIC_ORIGIN is required")
        db_path = env.get("CATALOG_DB_PATH")
        if not db_path:
            raise ConfigError("CATALOG_DB_PATH is required")
        cfg = cls(
            public_origin=normalize_origin(origin),
            db_path=db_path,
            admin_password_hash=env.get("CATALOG_ADMIN_PASSWORD_HASH") or None,
            cookie_secure=_parse_bool(env.get("CATALOG_COOKIE_SECURE"), True),
            session_ttl_seconds=SESSION_TTL_SECONDS,
        )
        return cfg.validate()
