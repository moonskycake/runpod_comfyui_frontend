"""Run the service on loopback only (behind the same-origin Nginx proxy).

    CATALOG_PUBLIC_ORIGIN=https://example.com \
    CATALOG_DB_PATH=/var/lib/catalog/catalog.db \
    CATALOG_ADMIN_PASSWORD_HASH=scrypt$... \
    python -m catalog_service
"""

from __future__ import annotations

import os

import uvicorn

from .app import build_from_env


def main() -> None:
    host = os.environ.get("CATALOG_HOST", "127.0.0.1")
    port = int(os.environ.get("CATALOG_PORT", "8787"))
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("catalog_service must listen on loopback; set CATALOG_HOST=127.0.0.1")
    app = build_from_env()
    uvicorn.run(app, host=host, port=port, proxy_headers=False, server_header=False)


if __name__ == "__main__":
    main()
