"""Password hashing, opaque tokens and constant-time helpers.

Only salted scrypt hashes are used for the admin password.  Session tokens are
random and stored hashed (SHA256); the CSRF token is random per session and is
compared in constant time.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SCRYPT_PREFIX = "scrypt"


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + padding)


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    if not password:
        raise ValueError("password must not be empty")
    if salt is None:
        salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )
    return "$".join(
        (_SCRYPT_PREFIX, str(_SCRYPT_N), str(_SCRYPT_R), str(_SCRYPT_P), _b64e(salt), _b64e(digest))
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        prefix, n, r, p, salt_b64, digest_b64 = encoded.split("$")
        if prefix != _SCRYPT_PREFIX:
            return False
        salt = _b64d(salt_b64)
        expected = _b64d(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def constant_time_equals(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))
