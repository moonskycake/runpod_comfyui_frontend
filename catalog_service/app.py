"""FastAPI application for the shared catalog service.

Design notes:
* sync endpoints + one SQLite connection per request (thread-safe, Python 3.10+)
* drafts live in ``items.draft_data``; published content is an immutable row in
  ``revisions`` so edits never leak into public reads
* every ``/api/admin`` response (including errors) is ``Cache-Control: no-store``
* request bodies are capped on the streamed byte count, not just Content-Length
"""

from __future__ import annotations

import hashlib
import json
import time
from contextlib import contextmanager

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import images, store
from .config import (
    COOKIE_NAME,
    COOKIE_PATH,
    LOGIN_MAX_GLOBAL,
    LOGIN_MAX_PER_IP,
    LOGIN_WINDOW_SECONDS,
    MAX_BODY_BYTES,
    Config,
    ConfigError,
)
from .security import constant_time_equals, verify_password
from .validation import (
    ValidationError,
    find_workflow_secret_paths,
    validate_create,
    validate_data,
    validate_import,
    validate_patch,
)

PUBLIC_CACHE_CONTROL = "no-cache"
ADMIN_CACHE_CONTROL = "no-store"


def _require_base_rev_query(request: Request) -> int:
    raw = request.query_params.get("baseRev")
    if raw is None:
        raise ApiError(400, "baseRev query parameter is required")
    try:
        return int(raw)
    except ValueError:
        raise ApiError(400, "baseRev must be an integer")


def _image_response(
    request: Request,
    asset,
    *,
    etag_seed: str,
    cache_control: str,
) -> Response:
    headers = {"Cache-Control": cache_control, "X-Content-Type-Options": "nosniff"}
    etag = _etag(f"preview:{etag_seed}")
    headers["ETag"] = etag
    if _not_modified(request, etag, cache_control):
        return Response(status_code=304, headers=headers)
    return Response(content=asset["data"], media_type=asset["mime"], headers=headers)


class ApiError(Exception):
    def __init__(self, status_code: int, detail: str, current=None, headers=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.current = current
        self.headers = headers or {}


class BodyLimitMiddleware:
    """Reject requests whose actual streamed body exceeds the path limit.

    Limits: image uploads may be up to 5 MiB, every other request 2 MiB.  The
    byte count is streamed, so a missing/lying ``Content-Length`` cannot bypass
    it.
    """

    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    def _limit_for(self, path: str) -> int:
        if path.rstrip("/").endswith("/preview"):
            return images.MAX_INPUT_BYTES
        return self.max_bytes

    async def _too_large(self, send, limit: int) -> None:
        body = json.dumps({"detail": f"request body exceeds {limit} bytes"}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers") or []}
        limit = self._limit_for(scope.get("path", ""))
        declared = headers.get(b"content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            await self._too_large(send, limit)
            return
        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > limit:
                await self._too_large(send, limit)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        delivered = False

        async def replay():
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)


class _NoStoreMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/admin"):
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", ADMIN_CACHE_CONTROL.encode("ascii")))
                message = dict(message, headers=headers)
            await send(message)

        await self.app(scope, receive, send_wrapper)


@contextmanager
def _db(config: Config):
    conn = store.connect(config.db_path)
    try:
        yield conn
    finally:
        conn.close()


def _json(payload, status_code: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers=headers or {})


def _error(status_code: int, detail: str, current=None) -> JSONResponse:
    payload: dict = {"detail": detail}
    if current is not None:
        payload["current"] = current
    return _json(payload, status_code)


def _etag(value: str) -> str:
    return '"' + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32] + '"'


def _not_modified(request: Request, etag: str, cache_control: str) -> bool:
    header = request.headers.get("if-none-match")
    if not header:
        return False
    candidates = [part.strip() for part in header.split(",")]
    for candidate in candidates:
        if candidate == "*":
            return True
        if candidate == etag or candidate == f"W/{etag}":
            return True
    return False


def _origin_allowed(config: Config, request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return False
    return origin.strip().rstrip("/") == config.public_origin


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def _read_json(request: Request):
    raw = await request.body()
    if not raw:
        raise ApiError(400, "request body is required")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
        raise ApiError(400, "request body is not valid JSON or is nested too deeply")


def _require_base_rev(payload, *, allow_ack: bool = False) -> dict:
    if not isinstance(payload, dict):
        raise ApiError(400, "body must be an object")
    allowed = {"baseRev", "acknowledgeSecrets"} if allow_ack else {"baseRev"}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ApiError(400, "body contains unsupported fields: " + ", ".join(unknown))
    base_rev = payload.get("baseRev")
    if not isinstance(base_rev, int) or isinstance(base_rev, bool):
        raise ApiError(400, "baseRev must be an integer")
    result = {"baseRev": base_rev}
    if allow_ack:
        ack = payload.get("acknowledgeSecrets", False)
        if not isinstance(ack, bool):
            raise ApiError(400, "acknowledgeSecrets must be a boolean")
        result["acknowledgeSecrets"] = ack
    return result


def _current_item(config: Config, item_id: str):
    with _db(config) as conn:
        row = store.get_item_row(conn, item_id)
        return store.admin_item_from_row(row) if row else None


def _handle_store_error(config: Config, exc: Exception) -> ApiError:
    if isinstance(exc, store.NotFound):
        return ApiError(404, "item not found")
    if isinstance(exc, store.StoreConflict):
        return ApiError(409, exc.detail, current=_current_item(config, exc.item_id))
    raise exc


def create_app(config: Config) -> FastAPI:
    config.validate()
    store.init_db(config.db_path)

    app = FastAPI(
        title="Shared Catalog Service",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.config = config
    app.add_middleware(_NoStoreMiddleware)
    app.add_middleware(BodyLimitMiddleware, max_bytes=MAX_BODY_BYTES)

    @app.exception_handler(ApiError)
    async def _api_error_handler(_request: Request, exc: ApiError):
        response = _error(exc.status_code, exc.detail, exc.current)
        for key, value in exc.headers.items():
            response.headers[key] = value
        return response

    @app.exception_handler(ValidationError)
    async def _validation_error_handler(_request: Request, exc: ValidationError):
        return _error(400, str(exc))

    @app.exception_handler(RequestValidationError)
    async def _request_validation_handler(_request: Request, exc: RequestValidationError):
        return _error(400, "invalid request")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error_handler(_request: Request, exc: StarletteHTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "request failed"
        response = _error(exc.status_code, detail)
        if exc.headers:
            for key, value in exc.headers.items():
                response.headers[key] = value
        return response

    def require_session(request: Request) -> dict:
        token = request.cookies.get(COOKIE_NAME, "")
        with _db(config) as conn:
            row = store.get_session(conn, token)
        if row is None:
            raise ApiError(401, "authentication required")
        return {"csrfToken": row["csrf_token"], "expiresAt": row["expires_at"]}

    def require_write(request: Request, session: dict = Depends(require_session)) -> dict:
        if not _origin_allowed(config, request):
            raise ApiError(403, "origin not allowed")
        provided = request.headers.get("x-csrf-token", "")
        if not provided or not constant_time_equals(provided, session["csrfToken"]):
            raise ApiError(403, "invalid CSRF token")
        return session

    # ---------------------------------------------------------------- public

    @app.get("/api/catalog")
    def public_catalog(request: Request):
        with _db(config) as conn:
            version, rows = store.public_catalog_snapshot(conn)
        etag = _etag(f"catalog:{version}")
        headers = {"ETag": etag, "Cache-Control": PUBLIC_CACHE_CONTROL}
        if _not_modified(request, etag, PUBLIC_CACHE_CONTROL):
            return Response(status_code=304, headers=headers)
        return _json(
            {
                "catalogVersion": version,
                "items": [store.public_metadata_from_row(row) for row in rows],
            },
            headers=headers,
        )

    @app.get("/api/catalog/{item_id:path}/preview")
    def public_preview(item_id: str, request: Request, revision: str | None = None):
        target: int | None = None
        if revision is not None:
            try:
                target = int(revision)
            except ValueError:
                return _json(
                    {"detail": "revision must be an integer"},
                    400,
                    {"Cache-Control": PUBLIC_CACHE_CONTROL},
                )
            if target < 1:
                return _json(
                    {"detail": "revision must be a positive integer"},
                    400,
                    {"Cache-Control": PUBLIC_CACHE_CONTROL},
                )
        with _db(config) as conn:
            row, asset = store.get_public_preview(conn, item_id, target)
        if row is None:
            return _json(
                {"detail": "item not found"}, 404, {"Cache-Control": PUBLIC_CACHE_CONTROL}
            )
        if row["status"] == "disabled":
            return _json(
                {"detail": "item is disabled"}, 410, {"Cache-Control": PUBLIC_CACHE_CONTROL}
            )
        if asset is None:
            return _json(
                {"detail": "preview not found"}, 404, {"Cache-Control": PUBLIC_CACHE_CONTROL}
            )
        resolved = target if target is not None else row["published_revision"]
        return _image_response(
            request,
            asset,
            etag_seed=f"{item_id}:{resolved}:{asset['id']}",
            cache_control=PUBLIC_CACHE_CONTROL,
        )

    @app.get("/api/catalog/{item_id:path}")
    def public_detail(item_id: str, request: Request):
        with _db(config) as conn:
            row, snapshot = store.get_public_snapshot(conn, item_id)
        if row is None:
            return _json({"detail": "item not found"}, 404, {"Cache-Control": PUBLIC_CACHE_CONTROL})
        if snapshot is None:
            if row["status"] == "disabled":
                return _json(
                    {"detail": "item is disabled"}, 410, {"Cache-Control": PUBLIC_CACHE_CONTROL}
                )
            return _json(
                {"detail": "item not found"}, 404, {"Cache-Control": PUBLIC_CACHE_CONTROL}
            )
        metadata = snapshot["metadata"]
        payload = dict(metadata)
        payload["data"] = snapshot["data"]
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        etag = _etag(f"{item_id}:{row['published_revision']}:{body}")
        headers = {"ETag": etag, "Cache-Control": PUBLIC_CACHE_CONTROL}
        if _not_modified(request, etag, PUBLIC_CACHE_CONTROL):
            return Response(status_code=304, headers=headers)
        return Response(content=body, media_type="application/json", headers=headers)

    # --------------------------------------------------------------- session

    @app.post("/api/admin/login")
    async def login(request: Request):
        if not _origin_allowed(config, request):
            raise ApiError(403, "origin not allowed")
        ip = _client_ip(request)
        now_ts = time.time()
        since = now_ts - LOGIN_WINDOW_SECONDS
        with _db(config) as conn:
            per_ip, total = store.count_recent_failures(conn, ip, since)
        if per_ip >= LOGIN_MAX_PER_IP or total >= LOGIN_MAX_GLOBAL:
            raise ApiError(
                429,
                "too many login attempts; try again later",
                headers={"Retry-After": str(LOGIN_WINDOW_SECONDS)},
            )
        payload = await _read_json(request)
        password = payload.get("password") if isinstance(payload, dict) else None
        if not isinstance(password, str) or not password:
            raise ApiError(400, "password is required")
        if not config.admin_password_hash:
            raise ApiError(503, "admin password is not configured")
        if not verify_password(password, config.admin_password_hash):
            with _db(config) as conn:
                store.record_login_failure(conn, ip, now_ts, since)
            raise ApiError(401, "invalid credentials")
        with _db(config) as conn:
            store.clear_login_failures(conn, ip)
            session = store.create_session(conn, config.session_ttl_seconds)
        response = _json(
            {
                "authenticated": True,
                "csrfToken": session["csrf"],
                "expiresAt": session["expiresAt"],
            }
        )
        response.set_cookie(
            key=COOKIE_NAME,
            value=session["token"],
            max_age=config.session_ttl_seconds,
            path=COOKIE_PATH,
            httponly=True,
            secure=config.cookie_secure,
            samesite="strict",
        )
        return response

    @app.get("/api/admin/session")
    def session_info(session: dict = Depends(require_session)):
        return _json(
            {
                "authenticated": True,
                "csrfToken": session["csrfToken"],
                "expiresAt": session["expiresAt"],
            }
        )

    @app.post("/api/admin/logout")
    def logout(request: Request, _session: dict = Depends(require_write)):
        token = request.cookies.get(COOKIE_NAME, "")
        with _db(config) as conn:
            store.revoke_session(conn, token)
        response = _json({"authenticated": False})
        response.delete_cookie(
            key=COOKIE_NAME,
            path=COOKIE_PATH,
            secure=config.cookie_secure,
            httponly=True,
            samesite="strict",
        )
        return response

    # ----------------------------------------------------------- admin reads

    @app.get("/api/admin/items")
    def admin_list(
        kind: str | None = None,
        status: str | None = None,
        _session: dict = Depends(require_session),
    ):
        if kind is not None and kind not in ("template", "preset", "snippet"):
            raise ApiError(400, "invalid kind filter")
        if status is not None and status not in ("draft", "published", "disabled"):
            raise ApiError(400, "invalid status filter")
        with _db(config) as conn:
            rows = store.list_item_rows(conn, kind, status)
            items = [store.admin_item_from_row(row) for row in rows]
        return _json({"items": items})

    @app.get("/api/admin/items/{item_id:path}/preview")
    def admin_preview(
        item_id: str,
        request: Request,
        rev: str | None = None,
        _session: dict = Depends(require_session),
    ):
        if rev is None:
            raise ApiError(400, "rev query parameter is required")
        try:
            revision = int(rev)
        except ValueError:
            raise ApiError(400, "rev must be an integer")
        with _db(config) as conn:
            row, asset = store.get_admin_preview(conn, item_id, revision)
        if row is None:
            raise ApiError(404, "item not found")
        if asset is None:
            raise ApiError(404, "preview not found for this revision")
        return _image_response(
            request,
            asset,
            etag_seed=f"{item_id}:draft:{revision}:{asset['id']}",
            cache_control=ADMIN_CACHE_CONTROL,
        )

    @app.get("/api/admin/items/{item_id:path}")
    def admin_detail(item_id: str, _session: dict = Depends(require_session)):
        with _db(config) as conn:
            row = store.get_item_row(conn, item_id)
        if row is None:
            raise ApiError(404, "item not found")
        return _json(store.admin_item_from_row(row))

    # ---------------------------------------------------------- admin writes

    @app.post("/api/admin/items/{item_id:path}/preview")
    async def admin_upload_preview(
        item_id: str, request: Request, _session: dict = Depends(require_write)
    ):
        """Attach a preview to the draft: raw binary body, never auto-published."""
        base_rev = _require_base_rev_query(request)
        declared = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if declared and declared not in images.ALLOWED_INPUT_MIME:
            raise ApiError(400, "content type must be image/png, image/jpeg or image/webp")
        # Cheap authorization/existence check before touching the payload.
        with _db(config) as conn:
            row = store.get_item_row(conn, item_id)
            if row is None:
                raise ApiError(404, "item not found")
            if row["draft_rev"] != base_rev:
                raise ApiError(
                    409, "baseRev is stale", current=store.admin_item_from_row(row)
                )
        raw = await request.body()
        if not raw:
            raise ApiError(400, "image body is required")
        if len(raw) > images.MAX_INPUT_BYTES:
            raise ApiError(413, f"image exceeds {images.MAX_INPUT_BYTES} bytes")
        try:
            processed = images.process_image(raw)
        except images.ImageError as exc:
            raise ApiError(400, str(exc))
        with _db(config) as conn:
            try:
                updated = store.set_draft_preview(
                    conn, item_id, base_rev, processed.as_asset()
                )
            except (store.NotFound, store.StoreConflict) as exc:
                raise _handle_store_error(config, exc)
        return _json(updated)

    @app.delete("/api/admin/items/{item_id:path}/preview")
    def admin_delete_preview(
        item_id: str, request: Request, _session: dict = Depends(require_write)
    ):
        base_rev = _require_base_rev_query(request)
        with _db(config) as conn:
            try:
                updated = store.clear_draft_preview(conn, item_id, base_rev)
            except (store.NotFound, store.StoreConflict) as exc:
                raise _handle_store_error(config, exc)
        return _json(updated)

    @app.post("/api/admin/items", status_code=201)
    async def admin_create(request: Request, _session: dict = Depends(require_write)):
        payload = await _read_json(request)
        item = validate_create(payload)
        with _db(config) as conn:
            created = store.create_item(conn, item)
        return _json(created, 201)

    @app.patch("/api/admin/items/{item_id:path}")
    async def admin_patch(
        item_id: str, request: Request, _session: dict = Depends(require_write)
    ):
        payload = await _read_json(request)
        with _db(config) as conn:
            row = store.get_item_row(conn, item_id)
            if row is None:
                raise ApiError(404, "item not found")
            changes = validate_patch(payload, row["kind"])
            try:
                updated = store.patch_item(conn, item_id, changes)
            except (store.NotFound, store.StoreConflict) as exc:
                raise _handle_store_error(config, exc)
        return _json(updated)

    @app.post("/api/admin/items/{item_id:path}/publish")
    async def admin_publish(
        item_id: str, request: Request, _session: dict = Depends(require_write)
    ):
        payload = _require_base_rev(await _read_json(request), allow_ack=True)
        with _db(config) as conn:
            row = store.get_item_row(conn, item_id)
            if row is None:
                raise ApiError(404, "item not found")
            if row["draft_rev"] != payload["baseRev"]:
                raise ApiError(
                    409,
                    "baseRev is stale",
                    current=store.admin_item_from_row(row),
                )
            data = json.loads(row["draft_data"])
            if row["kind"] == "template":
                secret_paths = find_workflow_secret_paths(data.get("workflow", {}))
                if secret_paths and not payload["acknowledgeSecrets"]:
                    raise ApiError(
                        400,
                        "workflow contains possible secrets at: "
                        + ", ".join(secret_paths)
                        + " — set acknowledgeSecrets=true to publish",
                    )
            try:
                updated = store.publish_item(conn, item_id, payload["baseRev"])
            except (store.NotFound, store.StoreConflict) as exc:
                raise _handle_store_error(config, exc)
        return _json(updated)

    @app.post("/api/admin/items/{item_id:path}/disable")
    async def admin_disable(
        item_id: str, request: Request, _session: dict = Depends(require_write)
    ):
        payload = _require_base_rev(await _read_json(request))
        with _db(config) as conn:
            try:
                updated = store.disable_item(conn, item_id, payload["baseRev"])
            except (store.NotFound, store.StoreConflict) as exc:
                raise _handle_store_error(config, exc)
        return _json(updated)

    @app.delete("/api/admin/items/{item_id:path}", status_code=204)
    def admin_delete(
        item_id: str,
        request: Request,
        _session: dict = Depends(require_write),
    ):
        raw = request.query_params.get("baseRev")
        try:
            base_rev = int(raw) if raw is not None else None
        except ValueError:
            raise ApiError(400, "baseRev must be an integer")
        if base_rev is None:
            raise ApiError(400, "baseRev query parameter is required")
        with _db(config) as conn:
            try:
                store.delete_item(conn, item_id, base_rev)
            except (store.NotFound, store.StoreConflict) as exc:
                raise _handle_store_error(config, exc)
        return Response(status_code=204)

    @app.post("/api/admin/import", status_code=201)
    async def admin_import(request: Request, _session: dict = Depends(require_write)):
        payload = await _read_json(request)
        items = validate_import(payload)
        with _db(config) as conn:
            created = store.import_items(conn, items)
        return _json({"items": created}, 201)

    @app.get("/api/healthz")
    def healthz():
        return _json({"status": "ok"})

    return app


def build_from_env() -> FastAPI:
    config = Config.from_env()
    return create_app(config)


__all__ = ["create_app", "build_from_env", "ApiError", "ConfigError", "validate_data"]
