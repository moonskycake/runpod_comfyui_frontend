#!/usr/bin/env python3
"""Local-only preview of the *packed* frontend, including the nested /admin/.

Purpose: QA the real release artefact (what ``pack_frontend.build_bundle``
produces) instead of a hand-edited copy of the HTML.

What it does
- Builds an in-memory bundle for the current working tree with a local,
  synthetic 40-hex release id (no git state is required). Files are read from
  the tar stream into memory; nothing is extracted to disk.
- Serves exactly the whitelisted files of that bundle, mirroring the Nginx
  mapping:
      /                  -> index.html          (no-cache)
      /index.html        -> index.html          (no-cache)
      /admin, /admin/    -> admin.html          (no-cache)
      /tags/..., /img/..., /favicon.ico ->
                            the same path in the bundle (no-cache for tags/)
      /_rel/<sha>/<rest> -> <rest>              (immutable, long cache)
- Proxies ``/api/*`` verbatim (path, method, body, Set-Cookie, Origin,
  Cache-Control/ETag) to the real FastAPI backend on 127.0.0.1:8787. The proxy destination is hard-coded,
  never configurable, and request/response bodies are never logged.

This is a development tool only. Production uses Nginx
(``deploy/server/nginx-deploy-snippet.conf``); do not deploy this file.

Usage (start the backend separately, then):
    python deploy/catalog/dev_preview.py [--repo .] [--port 8766]

The browser origin becomes http://127.0.0.1:8766, so the backend must accept
that Origin (``CATALOG_PUBLIC_ORIGIN``) for admin writes.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import io
import json
import os
import sys
import tarfile
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY_DIR = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(DEPLOY_DIR)
sys.path.insert(0, DEPLOY_DIR)
import pack_frontend  # noqa: E402

BACKEND_HOST = "127.0.0.1"          # hard-coded loopback upstream
BACKEND_PORT = 8787
MAX_PROXY_BODY = 2 * 1024 * 1024    # 2 MiB, matches client_max_body_size in the snippet
IMMUTABLE_MAX_AGE = 315360000

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
NO_CACHE = "no-cache"


def local_release_id(repo: str) -> str:
    """Deterministic local-only 40-hex id from the packed file inventory.

    Uses sizes + mtimes (cheap) instead of reading the large tag CSVs. The id is
    never published; it only names this preview's asset namespace.
    """
    h = hashlib.sha256()
    for rel in pack_frontend.collect_files(repo):
        st = os.stat(os.path.join(repo, rel.replace("/", os.sep)))
        h.update(("%s\0%d\0%d\n" % (rel, st.st_size, st.st_mtime_ns)).encode())
    return h.hexdigest()[:40]


def load_bundle(repo: str) -> tuple[str, dict[str, bytes]]:
    sha = local_release_id(repo)
    payload, report = pack_frontend.build_bundle(repo, sha)
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            data = tar.extractfile(member)
            if data is None:
                continue
            files[member.name] = data.read()
    if "index.html" not in files:
        raise SystemExit("bundle has no index.html")
    return sha, files


def content_type(path: str) -> str:
    if path.endswith(".html"):
        return "text/html; charset=utf-8"
    if path.endswith(".css"):
        return "text/css; charset=utf-8"
    if path.endswith(".js"):
        return "text/javascript; charset=utf-8"
    if path.endswith(".json"):
        return "application/json; charset=utf-8"
    if path.endswith(".csv"):
        return "text/csv; charset=utf-8"
    if path.endswith(".png"):
        return "image/png"
    if path.endswith(".jpg") or path.endswith(".jpeg"):
        return "image/jpeg"
    if path.endswith(".svg"):
        return "image/svg+xml"
    if path.endswith(".ico"):
        return "image/x-icon"
    if path.endswith(".woff2"):
        return "font/woff2"
    if path.endswith(".woff"):
        return "font/woff"
    return "application/octet-stream"


class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "catalog-dev-preview"
    protocol_version = "HTTP/1.1"

    # -- plumbing -----------------------------------------------------------
    @property
    def bundle(self) -> dict[str, bytes]:
        return self.server.bundle  # type: ignore[attr-defined]

    @property
    def sha(self) -> str:
        return self.server.sha  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        # never log query strings or bodies
        sys.stderr.write("[preview] %s %s\n" % (self.command, self._safe_path()))

    def _safe_path(self) -> str:
        return urllib.parse.urlsplit(self.path).path

    def _send(self, status: int, body: bytes, ctype: str,
              cache: str = NO_CACHE, extra: tuple[tuple[str, str], ...] = ()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _not_found(self) -> None:
        self._send(404, b"404 not found\n", "text/plain; charset=utf-8")

    # -- routing ------------------------------------------------------------
    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = self._safe_path()
        if path.startswith("/api/"):
            self._proxy()
            return
        if path in ("/", "/index.html"):
            self._serve_asset("index.html", NO_CACHE)
            return
        if path in ("/admin", "/admin/"):
            if "admin.html" not in self.bundle:
                self._send(404, b"admin.html is not in this bundle\n",
                           "text/plain; charset=utf-8")
                return
            self._serve_asset("admin.html", NO_CACHE)
            return
        if path.startswith("/_rel/"):
            prefix = "/_rel/%s/" % self.sha
            if not path.startswith(prefix):
                # other release ids do not exist in this preview
                self._not_found()
                return
            self._serve_asset(path[len(prefix):], "public, max-age=%d, immutable"
                              % IMMUTABLE_MAX_AGE)
            return
        rel = path.lstrip("/")
        if rel == "tags/manifest.json" or rel.startswith("tags/"):
            self._serve_asset(rel, NO_CACHE)
            return
        if rel == "favicon.ico" or rel.startswith("img/"):
            self._serve_asset(rel, "public, max-age=2592000")
            return
        self._not_found()

    def do_POST(self) -> None:
        if self._safe_path().startswith("/api/"):
            self._proxy()
            return
        self._send(405, b"405 method not allowed\n", "text/plain; charset=utf-8")

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST

    def _serve_asset(self, rel: str, cache: str) -> None:
        if ".." in rel.split("/") or rel.startswith("/") or not rel:
            self._not_found()
            return
        data = self.bundle.get(rel)
        if data is None:
            self._not_found()
            return
        self._send(200, data, content_type(rel), cache)

    # -- loopback API proxy (verbatim path, no destination override) --------
    def _proxy(self) -> None:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            length = 0
        else:
            try:
                length = int(length_header)
            except ValueError:
                self._send(400, b"bad content-length\n", "text/plain; charset=utf-8")
                return
        if length < 0 or length > MAX_PROXY_BODY:
            self._send(413, b"request body too large\n", "text/plain; charset=utf-8")
            return
        body = self.rfile.read(length) if length else b""

        headers = {}
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP or key.lower() == "content-length":
                continue
            headers[key] = value
        # the only forwarded client address is this loopback peer
        headers["X-Forwarded-For"] = "127.0.0.1"
        headers["X-Forwarded-Proto"] = "http"
        headers["Content-Length"] = str(len(body))

        conn = http.client.HTTPConnection(BACKEND_HOST, BACKEND_PORT, timeout=30)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            payload = response.read()
            # pass the backend's Cache-Control/ETag through untouched:
            # /api/catalog is no-cache, /api/admin is no-store (even on errors)
            resp_headers = [(k, v) for k, v in response.getheaders()
                            if k.lower() not in HOP_BY_HOP
                            and k.lower() != "content-length"]
        except OSError as exc:
            sys.stderr.write("[preview] upstream error: %s\n" % exc.__class__.__name__)
            self._send(502, b"backend unavailable on 127.0.0.1:%d\n" % BACKEND_PORT,
                       "text/plain; charset=utf-8")
            return
        finally:
            conn.close()

        self.send_response(response.status)
        self.send_header("Content-Type",
                         response.getheader("Content-Type") or "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in resp_headers:
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local preview of the packed frontend")
    parser.add_argument("--repo", default=REPO_ROOT, help="frontend repo root")
    parser.add_argument("--port", type=int, default=8766, help="loopback port (default 8766)")
    args = parser.parse_args(argv)

    if args.port < 1 or args.port > 65535:
        raise SystemExit("invalid port")
    sha, files = load_bundle(args.repo)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler)
    httpd.daemon_threads = True
    httpd.sha = sha          # type: ignore[attr-defined]
    httpd.bundle = files     # type: ignore[attr-defined]
    print(json.dumps({
        "listen": "http://127.0.0.1:%d" % args.port,
        "release": sha,
        "files": len(files),
        "admin": "admin.html" in files,
        "api_proxy": "http://%s:%d" % (BACKEND_HOST, BACKEND_PORT),
    }), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
