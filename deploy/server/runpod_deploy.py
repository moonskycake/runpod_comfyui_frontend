#!/usr/bin/env python3
"""Server-side publisher for runpod.hyxer.top frontend releases.

Runs as the unprivileged deploy user (``runpod-deploy``), typically launched by
the root-owned forced-command gateway. It never executes anything from the
uploaded bundle; the bundle is data only.

Pointer model: ``current`` and ``previous`` are ALWAYS symlinks into
``releases/``. There is no auto-detection and no fallback: if a pointer is
missing it is created, if it is not a symlink the run is refused.

Layout (everything deploy can write lives under --data-root):

    <data-root>/
        releases/<sha40>/index.html, css/, js/, bootstrap/, vue/, tags/, img/, favicon.ico
        current  -> releases/<sha40>     (symlink, atomic rename)
        previous -> releases/<sha40>
        staging/                          (transient, this run only)
        .lock                             (flock)

Commands
    publish <sha40>   read a tar.gz bundle from stdin, validate, publish
    rollback <sha40>  point current at an already-published release
    inspect           print state as JSON (strictly read-only)

Exit codes: 0 ok, 2 bad bundle, 3 immutable conflict, 4 lock busy,
            5 usage / missing release, 6 internal error.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
import time

try:  # POSIX production path
    import fcntl
except ImportError:  # pragma: no cover - Windows can only run validation tests
    fcntl = None
    import msvcrt

RELEASE_PREFIX = "_rel"
WHITELIST_FILES = ("index.html", "favicon.ico")
WHITELIST_DIRS = ("css", "js", "bootstrap", "vue", "tags", "img")

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REF_RE = re.compile(r'\./%s/(?P<sha>[0-9a-f]{40})/(?P<path>[^"\s]+)' % RELEASE_PREFIX)

MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_FILES = 20000
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024

# Keep a few releases and protect superseded ones for a day, so in-flight pages
# that still reference the previous commit's assets keep working.
DEFAULT_KEEP_RELEASES = 5
DEFAULT_GRACE_SECONDS = 86400

OK, BAD_BUNDLE, CONFLICT, LOCK_BUSY, USAGE, INTERNAL = 0, 2, 3, 4, 5, 6


class DeployError(Exception):
    def __init__(self, message: str, code: int = BAD_BUNDLE) -> None:
        super().__init__(message)
        self.code = code


def log(message: str) -> None:
    sys.stderr.write("[deploy] %s\n" % message)
    sys.stderr.flush()


# --------------------------------------------------------------------------
# pointer handling — symlinks only, no auto-detection, no fallback
# --------------------------------------------------------------------------

def read_pointer(data_root: str, name: str) -> str | None:
    path = os.path.join(data_root, name)
    if not os.path.islink(path):
        return None
    base = os.path.basename(os.readlink(path).rstrip("/\\"))
    return base if SHA_RE.match(base or "") else None


def pointer_anomalies(data_root: str) -> list[str]:
    problems = []
    for name in ("current", "previous"):
        path = os.path.join(data_root, name)
        if os.path.lexists(path) and not os.path.islink(path):
            problems.append("%s exists but is not a symlink" % name)
    return problems


def assert_pointer_is_symlink(data_root: str) -> None:
    problems = pointer_anomalies(data_root)
    if problems:
        raise DeployError(
            "refusing to continue: %s (expected symlinks; repair manually)"
            % "; ".join(problems), INTERNAL)


def swap_pointer(data_root: str, name: str, sha: str) -> None:
    """Atomically point <name> at releases/<sha> via symlink + rename."""
    if not os.path.isdir(os.path.join(releases_dir(data_root), sha)):
        raise DeployError("release %s does not exist" % sha, USAGE)
    final = os.path.join(data_root, name)
    if os.path.lexists(final) and not os.path.islink(final):
        raise DeployError("%s is not a symlink, refusing to replace it" % name, INTERNAL)
    tmp = os.path.join(data_root, ".%s.tmp.%d" % (name, os.getpid()))
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(os.path.join("releases", sha), tmp, target_is_directory=True)
    os.replace(tmp, final)


# --------------------------------------------------------------------------
# bundle validation
# --------------------------------------------------------------------------

def _reject(name: str) -> None:
    raise DeployError("rejected entry %r" % name)


def validate_member(info: tarfile.TarInfo) -> str:
    name = info.name
    if not name:
        _reject(name)
    if name.startswith("/") or name.startswith("\\"):
        _reject(name)
    if "\\" in name:
        _reject(name)
    if re.match(r"^[A-Za-z]:", name):
        _reject(name)
    parts = name.rstrip("/").split("/")
    for part in parts:
        if part in ("", ".", ".."):
            _reject(name)
    if info.issym() or info.islnk():
        _reject(name)
    if info.isdev() or info.isfifo():
        _reject(name)
    if not (info.isreg() or info.isdir()):
        _reject(name)
    if info.isreg() and getattr(info, "sparse", None) is not None:
        _reject(name)
    if parts[0] == RELEASE_PREFIX:
        _reject(name)
    if info.isdir():
        if parts[0] in WHITELIST_DIRS:
            return name
        _reject(name)
    if name in WHITELIST_FILES:
        return name
    if parts[0] in WHITELIST_DIRS:
        return name
    _reject(name)


class _CountingReader(io.RawIOBase):
    def __init__(self, raw) -> None:
        self._raw = raw
        self.count = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buf) -> int:
        n = self._raw.readinto(buf)
        if n:
            self.count += n
            if self.count > MAX_INPUT_BYTES:
                raise DeployError("bundle exceeds %d bytes" % MAX_INPUT_BYTES)
        return n


def extract_bundle(sha: str, staging: str) -> dict:
    """Stream the tar.gz on stdin into staging, enforcing every limit."""
    os.makedirs(os.path.dirname(staging), exist_ok=True)
    os.makedirs(staging, exist_ok=False)
    files = 0
    total = 0
    seen: set[str] = set()

    reader = _CountingReader(sys.stdin.buffer)
    try:
        with tarfile.open(fileobj=io.BufferedReader(reader, buffer_size=1 << 16),
                          mode="r|gz") as tar:
            for info in tar:
                name = validate_member(info)
                key = name.rstrip("/")
                if key in seen:
                    raise DeployError("duplicate entry %r" % name)
                seen.add(key)
                if info.isdir():
                    continue
                files += 1
                if files > MAX_FILES:
                    raise DeployError("too many files (>%d)" % MAX_FILES)
                if info.size > MAX_FILE_BYTES:
                    raise DeployError("file too large: %s" % name)
                total += info.size
                if total > MAX_TOTAL_UNCOMPRESSED:
                    raise DeployError(
                        "uncompressed size exceeds %d bytes" % MAX_TOTAL_UNCOMPRESSED)
                src = tar.extractfile(info)
                if src is None:
                    raise DeployError("cannot read %r" % name)
                dest = os.path.join(staging, *key.split("/"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                written = 0
                with open(dest, "wb") as out:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > info.size:
                            raise DeployError("entry %r larger than declared" % name)
                        out.write(chunk)
                if written != info.size:
                    raise DeployError("truncated entry %r" % name)
                os.chmod(dest, 0o644)
    except tarfile.TarError as exc:
        raise DeployError("invalid tar stream: %s" % exc) from exc

    if files == 0:
        raise DeployError("bundle contained no files")
    return {"files": files, "uncompressed_bytes": total, "input_bytes": reader.count}


# --------------------------------------------------------------------------
# content verification / digests
# --------------------------------------------------------------------------

def tree_digest(root: str) -> str:
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for fname in sorted(filenames):
            abs_path = os.path.join(dirpath, fname)
            if os.path.islink(abs_path):
                raise DeployError("symlink found in staged tree: %s" % abs_path)
            rel = os.path.relpath(abs_path, root).replace(os.sep, "/")
            h = hashlib.sha256()
            with open(abs_path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            entries.append("%s %s" % (h.hexdigest(), rel))
    return hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()


def verify_staged(sha: str, staging: str) -> dict:
    index_path = os.path.join(staging, "index.html")
    if not os.path.isfile(index_path):
        raise DeployError("bundle has no index.html")
    with open(index_path, "r", encoding="utf-8", errors="replace") as fh:
        index_text = fh.read()

    refs = REF_RE.findall(index_text)
    if not refs:
        raise DeployError("index.html has no %s/<sha>/ references" % RELEASE_PREFIX)
    for ref_sha, ref_path in refs:
        if ref_sha != sha:
            raise DeployError("index.html references foreign release %s" % ref_sha)
        target = os.path.join(staging, *ref_path.split("/"))
        if not os.path.isfile(target):
            raise DeployError("index.html references missing file %s" % ref_path)

    manifest_path = os.path.join(staging, "tags", "manifest.json")
    if not os.path.isfile(manifest_path):
        raise DeployError("bundle has no tags/manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    for csv_rel, key in (("tags/danbooru.csv", "version"), ("tags/zhcn.csv", "zhVersion")):
        csv_path = os.path.join(staging, *csv_rel.split("/"))
        if not os.path.isfile(csv_path):
            raise DeployError("bundle has no %s" % csv_rel)
        with open(csv_path, "rb") as fh:
            expected = hashlib.sha256(fh.read()).hexdigest()[:12]
        if str(manifest.get(key, "")) != expected:
            raise DeployError(
                "tags/manifest.json %s does not match %s content hash" % (key, csv_rel))

    return {"index_refs": len(refs), "digest": tree_digest(staging)}


# --------------------------------------------------------------------------
# release management
# --------------------------------------------------------------------------

def releases_dir(data_root: str) -> str:
    return os.path.join(data_root, "releases")


def existing_releases(data_root: str) -> list[str]:
    path = releases_dir(data_root)
    if not os.path.isdir(path):
        return []
    out = []
    for name in os.listdir(path):
        if SHA_RE.match(name) and os.path.isdir(os.path.join(path, name)):
            out.append(name)
    return sorted(out)


def prune_releases(data_root: str, keep: int, grace_seconds: int) -> list[str]:
    """Delete only old releases: never current/previous, never inside grace window."""
    current = read_pointer(data_root, "current")
    previous = read_pointer(data_root, "previous")
    protected = {s for s in (current, previous) if s}
    path = releases_dir(data_root)
    now = time.time()
    candidates = []
    for name in existing_releases(data_root):
        if name in protected:
            continue
        mtime = os.path.getmtime(os.path.join(path, name))
        if now - mtime < grace_seconds:
            continue  # recently served: still protected
        candidates.append((mtime, name))
    candidates.sort(reverse=True)
    budget = max(0, keep - len(protected))
    removed = []
    for _mtime, name in candidates[budget:]:
        target = os.path.join(path, name)
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
            removed.append(name)
    return removed


def acquire_lock(data_root: str):
    os.makedirs(data_root, exist_ok=True)
    lock_path = os.path.join(data_root, ".lock")
    handle = open(lock_path, "a+b")
    if fcntl is not None:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError as exc:
            handle.close()
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise DeployError("another deploy is running", LOCK_BUSY) from exc
            raise
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return handle
    except OSError as exc:
        handle.close()
        raise DeployError("another deploy is running", LOCK_BUSY) from exc


def release_lock(handle) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        else:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    finally:
        handle.close()


def cmd_publish(data_root: str, sha: str, keep: int, grace_seconds: int) -> int:
    lock = acquire_lock(data_root)  # lock before touching any pointer or state
    staging = os.path.join(
        data_root, "staging", "%s-%d-%d" % (sha[:12], os.getpid(), int(time.time())))
    try:
        assert_pointer_is_symlink(data_root)
        stats = extract_bundle(sha, staging)
        checked = verify_staged(sha, staging)
        dest = os.path.join(releases_dir(data_root), sha)
        os.makedirs(releases_dir(data_root), exist_ok=True)

        if os.path.isdir(dest):
            if tree_digest(dest) == checked["digest"]:
                shutil.rmtree(staging, ignore_errors=True)
                previous = read_pointer(data_root, "current")
                if previous != sha:
                    swap_pointer(data_root, "current", sha)
                    if previous:
                        swap_pointer(data_root, "previous", previous)
                log("release %s already published with identical content (noop)" % sha)
                return OK
            raise DeployError(
                "release %s already exists with different content" % sha, CONFLICT)

        os.rename(staging, dest)
        previous = read_pointer(data_root, "current")
        swap_pointer(data_root, "current", sha)
        if previous and previous != sha:
            swap_pointer(data_root, "previous", previous)
        removed = prune_releases(data_root, keep, grace_seconds)
        log("published %s (%d files, %d bytes, digest %s, pruned=%s)"
            % (sha, stats["files"], stats["uncompressed_bytes"],
               checked["digest"][:12], removed or "none"))
        return OK
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        release_lock(lock)


def cmd_rollback(data_root: str, sha: str) -> int:
    lock = acquire_lock(data_root)
    try:
        assert_pointer_is_symlink(data_root)
        if not os.path.isdir(os.path.join(releases_dir(data_root), sha)):
            raise DeployError("release %s not found" % sha, USAGE)
        current = read_pointer(data_root, "current")
        if current == sha:
            log("current already points at %s" % sha)
            return OK
        swap_pointer(data_root, "current", sha)
        if current:
            swap_pointer(data_root, "previous", current)
        log("rolled back to %s (was %s)" % (sha, current))
        return OK
    finally:
        release_lock(lock)


def cmd_inspect(data_root: str) -> int:
    """Strictly read-only: no mkdir, no probe file, no lock."""
    releases = []
    for name in existing_releases(data_root):
        path = os.path.join(releases_dir(data_root), name)
        size = 0
        for dirpath, _dirnames, filenames in os.walk(path):
            for fname in filenames:
                try:
                    size += os.path.getsize(os.path.join(dirpath, fname))
                except OSError:
                    pass
        releases.append({"sha": name, "bytes": size, "mtime": int(os.path.getmtime(path))})
    payload = {
        "data_root": data_root,
        "pointer": "symlink",
        "current": read_pointer(data_root, "current"),
        "previous": read_pointer(data_root, "previous"),
        "pointer_anomalies": pointer_anomalies(data_root),
        "releases": releases,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return OK


def main(argv: list[str] | None = None) -> int:
    default_root = "/www/wwwroot/runpod.hyxer.top/%s" % RELEASE_PREFIX
    parser = argparse.ArgumentParser(description="runpod.hyxer.top frontend publisher")
    parser.add_argument("--data-root", default=os.environ.get("RUNPOD_DEPLOY_ROOT", default_root))
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP_RELEASES)
    parser.add_argument("--grace", type=int, default=DEFAULT_GRACE_SECONDS,
                        help="seconds a superseded release stays protected")
    sub = parser.add_subparsers(dest="command", required=True)
    p_pub = sub.add_parser("publish")
    p_pub.add_argument("sha")
    p_rb = sub.add_parser("rollback")
    p_rb.add_argument("sha")
    sub.add_parser("inspect")
    args = parser.parse_args(argv)

    try:
        if args.command == "publish":
            return cmd_publish(args.data_root, args.sha, args.keep, args.grace)
        if args.command == "rollback":
            return cmd_rollback(args.data_root, args.sha)
        return cmd_inspect(args.data_root)
    except DeployError as exc:
        log("error: %s" % exc)
        return exc.code
    except Exception as exc:  # noqa: BLE001 - surface a clean code to ssh
        log("internal error: %s: %s" % (type(exc).__name__, exc))
        return INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
