#!/usr/bin/env python3
"""Build the deployable frontend bundle (tar.gz stream) for one commit.

Design notes
- Whitelist based: only the static site paths below are packed. Repo extras
  (deploy/, tools/, docs, archives, dotfiles) can never leak into a release.
- Immutable release id: the 40-hex commit SHA. Published URLs are
  ``./_rel/<sha40>/<original path>``; nothing is renamed, so relative CSS
  references (e.g. bootstrap-icons' ``url("./fonts/...")``) keep working.
- Only two artefacts are rewritten inside the bundle:
  1. ``index.html`` asset attributes (order preserved, attributes only).
  2. ``tags/manifest.json`` ``version`` / ``zhVersion`` -> content hashes of
     the CSVs, so the existing runtime cache-busting in ``js/tag-index.js``
     picks up new tag data without touching business JS.
- Output is deterministic (sorted entries, zero mtimes, zero owners).

Usage
    python deploy/pack_frontend.py --sha <40-hex> --repo . --out site.tar.gz
    python deploy/pack_frontend.py --sha <40-hex> --repo . > site.tar.gz
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile

RELEASE_PREFIX = "_rel"

# Files published as-is (site root level).
WHITELIST_FILES = ("index.html", "favicon.ico")
# Directories published recursively and layout-preserving.
WHITELIST_DIRS = ("css", "js", "bootstrap", "vue", "tags", "img")

# Never packed even if inside a whitelisted directory.
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "__pycache__"}
EXCLUDE_SUFFIXES = (".log", ".pyc", ".tar", ".tar.gz", ".tgz", ".zip", ".7z", ".rar")

# CSV -> manifest version key (schema owned by js/tag-index.js)
MANIFEST_PATH = "tags/manifest.json"
CSV_VERSION_KEYS = (
    ("tags/danbooru.csv", "version"),
    ("tags/zhcn.csv", "zhVersion"),
)

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ATTR_RE = re.compile(r'(?P<attr>\b(?:src|href))="(?P<url>\./[^"]+)"')

MAX_BUNDLE_BYTES = 64 * 1024 * 1024


class PackError(Exception):
    """Fatal packing problem (nothing is emitted)."""


def sha256_prefix(data: bytes, n: int = 12) -> str:
    return hashlib.sha256(data).hexdigest()[:n]


def _is_excluded(rel_posix: str) -> bool:
    name = rel_posix.rsplit("/", 1)[-1]
    if name in EXCLUDE_NAMES:
        return True
    return name.lower().endswith(EXCLUDE_SUFFIXES)


def collect_files(repo_root: str) -> list[str]:
    """Return sorted posix-relative paths of every whitelisted file."""
    out: list[str] = []
    for name in WHITELIST_FILES:
        if os.path.isfile(os.path.join(repo_root, name)):
            out.append(name)
    for top in WHITELIST_DIRS:
        top_abs = os.path.join(repo_root, top)
        if not os.path.isdir(top_abs):
            continue
        for dirpath, dirnames, filenames in os.walk(top_abs):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_NAMES)
            for fname in sorted(filenames):
                abs_path = os.path.join(dirpath, fname)
                rel = os.path.relpath(abs_path, repo_root).replace(os.sep, "/")
                if _is_excluded(rel):
                    continue
                if not os.path.isfile(abs_path):
                    raise PackError("refusing non-regular file: %s" % rel)
                out.append(rel)
    return sorted(set(out))


def rewrite_index_html(text: str, sha: str, packed: set[str]) -> tuple[str, list[str]]:
    """Point local asset attributes at the immutable release directory."""
    rewritten: list[str] = []
    missing: list[str] = []

    def _sub(match: re.Match[str]) -> str:
        attr = match.group("attr")
        url = match.group("url")
        path = url[2:]
        if path.startswith("%s/" % RELEASE_PREFIX) or "://" in path:
            return match.group(0)
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path in packed:
            rewritten.append(path)
            return '%s="./%s/%s/%s"' % (attr, RELEASE_PREFIX, sha, path)
        missing.append(path)
        return match.group(0)

    out = ATTR_RE.sub(_sub, text)
    if missing:
        raise PackError(
            "index.html references files that are not packable: %s"
            % ", ".join(sorted(set(missing)))
        )
    return out, rewritten


def rewrite_tag_manifest(raw: bytes, sha: str, files: dict[str, bytes]) -> bytes:
    """Bump manifest versions to CSV content hashes; keep every other field."""
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackError("%s is not valid JSON: %s" % (MANIFEST_PATH, exc)) from exc
    if not isinstance(manifest, dict):
        raise PackError("%s must be a JSON object" % MANIFEST_PATH)

    for csv_path, key in CSV_VERSION_KEYS:
        data = files.get(csv_path)
        if data is None:
            raise PackError("missing %s (required for %s)" % (csv_path, key))
        manifest[key] = sha256_prefix(data)

    return (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build_bundle(repo_root: str, sha: str) -> tuple[bytes, dict]:
    """Return (tar.gz bytes, report)."""
    if not SHA_RE.match(sha):
        raise PackError("sha must be 40 lowercase hex chars, got %r" % (sha,))

    rel_paths = collect_files(repo_root)
    if "index.html" not in rel_paths:
        raise PackError("index.html missing from %s" % repo_root)

    files: dict[str, bytes] = {}
    for rel in rel_paths:
        with open(os.path.join(repo_root, rel.replace("/", os.sep)), "rb") as fh:
            files[rel] = fh.read()

    index_raw = files["index.html"].decode("utf-8")
    index_out, rewritten = rewrite_index_html(index_raw, sha, set(files))
    files["index.html"] = index_out.encode("utf-8")

    if MANIFEST_PATH in files:
        files[MANIFEST_PATH] = rewrite_tag_manifest(files[MANIFEST_PATH], sha, files)
    else:
        raise PackError("missing %s" % MANIFEST_PATH)

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for rel in sorted(files):
                data = files[rel]
                info = tarfile.TarInfo(name=rel)
                info.size = len(data)
                info.mtime = 0
                info.mode = 0o644
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                info.type = tarfile.REGTYPE
                tar.addfile(info, io.BytesIO(data))
    payload = buf.getvalue()
    if len(payload) > MAX_BUNDLE_BYTES:
        raise PackError("bundle too large: %d bytes" % len(payload))

    report = {
        "sha": sha,
        "files": len(files),
        "uncompressed_bytes": sum(len(v) for v in files.values()),
        "bundle_bytes": len(payload),
        "index_rewrites": len(rewritten),
        "tag_versions": {k: json.loads(files[MANIFEST_PATH])[k] for _, k in CSV_VERSION_KEYS},
        "missing_bootstrap_fonts": not any(p.startswith("bootstrap/fonts/") for p in files),
    }
    return payload, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pack the frontend for deployment")
    parser.add_argument("--repo", default=".", help="repo root (default: .)")
    parser.add_argument("--sha", required=True, help="40-hex commit SHA (release id)")
    parser.add_argument("--out", help="output file (default: stdout)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    try:
        payload, report = build_bundle(args.repo, args.sha)
    except PackError as exc:
        print("pack failed: %s" % exc, file=sys.stderr)
        return 2

    if args.out:
        with open(args.out, "wb") as fh:
            fh.write(payload)
    else:
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()

    if not args.quiet:
        print(json.dumps(report, ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
