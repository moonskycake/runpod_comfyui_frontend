#!/usr/bin/env python3
"""Tests for deploy/pack_frontend.py and deploy/server/runpod_deploy.py.

Reproducible locally (Windows/macOS/Linux):

    python deploy/tests/test_deploy.py -v

Production pointers are symlinks, with no detection or fallback, so the state
machine tests need symlink support: Linux/macOS, or Windows with Developer Mode.
Where symlink creation is refused (WinError 1314) those tests are skipped and
the bundle-validation tests still run. The symlink primitive must be verified on
the Linux host during rollout.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY_DIR = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(DEPLOY_DIR)
PACK = os.path.join(DEPLOY_DIR, "pack_frontend.py")
SERVER = os.path.join(DEPLOY_DIR, "server", "runpod_deploy.py")

sys.path.insert(0, DEPLOY_DIR)
import pack_frontend  # noqa: E402

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40
SHA_D = "d" * 40
SHA_E = "e" * 40
SHA_F = "f" * 40
SHA_G = "9" * 40

SYMLINK_OK = True
try:
    _dir = tempfile.mkdtemp()
    os.symlink(_dir, os.path.join(_dir, "probe"), target_is_directory=True)
    os.unlink(os.path.join(_dir, "probe"))
except (OSError, NotImplementedError):
    SYMLINK_OK = False
finally:
    shutil.rmtree(_dir, ignore_errors=True)

NEEDS_SYMLINK = unittest.skipUnless(
    SYMLINK_OK, "symlink creation refused by this OS/user (WinError 1314)")


def run_publisher(data_root, *args, stdin=b"", timeout=180):
    cmd = [sys.executable, SERVER, "--data-root", data_root, *args]
    return subprocess.run(cmd, input=stdin, capture_output=True, timeout=timeout)


def make_tar(entries) -> bytes:
    """entries: (name, bytes) | ('dir', name) | ('symlink', name, target) | ('hardlink', name, target)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for entry in entries:
            if entry[0] == "dir":
                info = tarfile.TarInfo(entry[1])
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            elif entry[0] in ("symlink", "hardlink"):
                info = tarfile.TarInfo(entry[1])
                info.type = tarfile.SYMTYPE if entry[0] == "symlink" else tarfile.LNKTYPE
                info.linkname = entry[2]
                tar.addfile(info)
            else:
                data = entry[1]
                info = tarfile.TarInfo(entry[0])
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def fixture_site(sha: str, danbooru: bytes = b"tag,0,1,\n",
                 zhcn: bytes = b"tag,x\n") -> list:
    manifest = json.dumps({
        "version": hashlib.sha256(danbooru).hexdigest()[:12],
        "updatedAt": "2026-02-21",
        "source": "fixture",
        "zhVersion": hashlib.sha256(zhcn).hexdigest()[:12],
        "zhUpdatedAt": "2026-11-05",
    }, indent=2) + "\n"
    index = (
        "<!doctype html><html><head>\n"
        '<link rel="stylesheet" href="./_rel/%s/css/style.css">\n'
        "</head><body>\n"
        '<script src="./_rel/%s/js/app.js"></script>\n'
        "</body></html>\n" % (sha, sha)
    )
    return [
        ("index.html", index.encode()),
        ("favicon.ico", b"ico"),
        ("css/style.css", b"body{color:#111}\n"),
        ("js/app.js", b"console.log(1);\n"),
        ("tags/manifest.json", manifest.encode()),
        ("tags/danbooru.csv", danbooru),
        ("tags/zhcn.csv", zhcn),
        ("img/demo.png", b"\x89PNG\r\n\x1a\n"),
    ]


class PackTests(unittest.TestCase):
    def test_pack_real_repo_rewrites_assets_and_keeps_order(self):
        bundle, report = pack_frontend.build_bundle(REPO_ROOT, SHA_A)
        with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as tar:
            names = tar.getnames()
            index = tar.extractfile("index.html").read().decode()
            manifest = json.loads(tar.extractfile("tags/manifest.json").read())
        for required in ("index.html", "favicon.ico", "tags/danbooru.csv",
                         "bootstrap/bootstrap.min.css", "bootstrap/bootstrap.bundle.min.js",
                         "vue/vue.global.prod.js", "js/vendor/cytoscape.min.js"):
            self.assertIn(required, names)
        self.assertTrue(any(n.startswith("img/") for n in names))
        for forbidden in ("deploy/", ".github/", "tools/", "AGENTS.md", ".user.ini"):
            self.assertFalse(any(n.startswith(forbidden) for n in names), forbidden)
        self.assertIn('./_rel/%s/css/style.css' % SHA_A, index)
        self.assertIn('./_rel/%s/js/main.js' % SHA_A, index)
        self.assertNotIn("?v=20261105.1", index)
        self.assertIn("https://cdn.jsdelivr.net/npm/bootstrap-icons", index)
        with open(os.path.join(REPO_ROOT, "index.html"), encoding="utf-8") as fh:
            source = fh.read()
        src_order = [m.group("url")[2:].split("?")[0]
                     for m in pack_frontend.ATTR_RE.finditer(source)]
        out_order = [m.group("url").split("/")[-1]
                     for m in pack_frontend.ATTR_RE.finditer(index)]
        self.assertEqual([p.split("/")[-1] for p in src_order], out_order)
        self.assertEqual(report["index_rewrites"], len(src_order))
        with open(os.path.join(REPO_ROOT, "tags", "manifest.json"), encoding="utf-8") as fh:
            source_manifest = json.load(fh)
        self.assertEqual(list(manifest.keys()), list(source_manifest.keys()))
        self.assertEqual(manifest["source"], source_manifest["source"])
        with open(os.path.join(REPO_ROOT, "tags", "danbooru.csv"), "rb") as fh:
            csv_digest = hashlib.sha256(fh.read()).hexdigest()[:12]
        self.assertEqual(report["tag_versions"]["version"], csv_digest)

    def test_css_relative_layout_preserved(self):
        bundle, _ = pack_frontend.build_bundle(REPO_ROOT, SHA_A)
        with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as tar:
            data = tar.extractfile("bootstrap/bootstrap-icons.css").read()
        with open(os.path.join(REPO_ROOT, "bootstrap", "bootstrap-icons.css"), "rb") as fh:
            original = fh.read()
        self.assertEqual(data, original)  # byte-identical, never renamed
        self.assertIn(b'url("./fonts/bootstrap-icons.woff2', data)
        self.assertFalse(os.path.isdir(os.path.join(REPO_ROOT, "bootstrap", "fonts")))

    def test_csv_change_bumps_manifest_version(self):
        with tempfile.TemporaryDirectory() as repo:
            for rel in ("css", "js", "tags"):
                os.makedirs(os.path.join(repo, rel))

            def w(rel, data):
                with open(os.path.join(repo, rel), "wb") as fh:
                    fh.write(data)

            w("tags/manifest.json", json.dumps(
                {"version": "2026-02-21", "source": "s", "zhVersion": "2026-11-05"},
                indent=2).encode())
            w("tags/danbooru.csv", b"a,0,1,\n")
            w("tags/zhcn.csv", b"a,x\n")
            w("css/style.css", b"body{}")
            w("js/app.js", b"1;")
            w("index.html", b'<link rel="stylesheet" href="./css/style.css?v=1">\n'
                            b'<script src="./js/app.js?v=1"></script>\n')
            _, first = pack_frontend.build_bundle(repo, SHA_A)
            v1 = first["tag_versions"]["version"]
            w("tags/danbooru.csv", b"a,0,2,\n")
            _, second = pack_frontend.build_bundle(repo, SHA_B)
            v2 = second["tag_versions"]["version"]
        self.assertNotEqual(v1, v2)
        self.assertEqual(v1, hashlib.sha256(b"a,0,1,\n").hexdigest()[:12])
        self.assertEqual(v2, hashlib.sha256(b"a,0,2,\n").hexdigest()[:12])

    def test_pack_rejects_missing_reference(self):
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "tags"))
            for rel, data in (("tags/manifest.json", b"{}"), ("tags/danbooru.csv", b"a"),
                              ("tags/zhcn.csv", b"a"),
                              ("index.html", b'<script src="./js/nope.js"></script>')):
                with open(os.path.join(repo, rel), "wb") as fh:
                    fh.write(data)
            with self.assertRaises(pack_frontend.PackError):
                pack_frontend.build_bundle(repo, SHA_A)

    def test_pack_rejects_bad_sha(self):
        with self.assertRaises(pack_frontend.PackError):
            pack_frontend.build_bundle(REPO_ROOT, "abc123")

    def test_nginx_snippet_invariants(self):
        """Static guards on the vhost snippet (no nginx binary needed)."""
        path = os.path.join(DEPLOY_DIR, "server", "nginx-deploy-snippet.conf")
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        code_lines = [ln.strip() for ln in text.splitlines()
                      if ln.strip() and not ln.strip().startswith("#")]
        # the mutable pointer must never be served
        self.assertIn("location ~ ^/_rel/(?:current|previous)(?:/|$) {", code_lines)
        self.assertIn("return 404;", code_lines)
        # no hard cache for the unversioned tags/ URLs
        self.assertFalse(any("danbooru|zhcn" in ln for ln in code_lines), code_lines)
        tags_block = text.split("location /tags/ {", 1)[1].split("}", 1)[0]
        self.assertIn("expires -1;", tags_block)
        self.assertNotIn("expires max", tags_block)
        # only expires-based caching: add_header would drop inherited security headers
        # (comments are excluded: the snippet documents this rule in a comment)
        self.assertFalse(any("add_header" in ln for ln in code_lines), code_lines)
        # immutable caching stays limited to content-addressed release dirs
        self.assertEqual(text.count("expires max;"), 1, code_lines)
        self.assertIn("^/_rel/[0-9a-f]{40}/", text)


class ValidationTests(unittest.TestCase):
    """Bundle rejection paths: these must work on every OS (no symlinks needed)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = os.path.join(self.tmp, "_rel")
        os.makedirs(self.data)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def publish(self, sha, entries, extra=()):
        return run_publisher(self.data, *extra, "publish", sha, stdin=make_tar(entries))

    def assert_no_pointer(self):
        self.assertFalse(os.path.lexists(os.path.join(self.data, "current")))

    def test_rejects_malicious_paths(self):
        cases = {
            "absolute": [("/etc/passwd", b"x")],
            "traversal": [("../evil.js", b"x")],
            "nested_traversal": [("js/../../evil.js", b"x")],
            "backslash": [("js\\evil.js", b"x")],
            "symlink": [("symlink", "js/link", "/etc/passwd")],
            "hardlink": [("hardlink", "js/hard", "js/app.js")],
            "outside_whitelist": [("deploy/evil.py", b"x")],
            "repo_meta": [(".github/workflows/x.yml", b"x")],
            "release_prefix": [("_rel/abc/index.html", b"x")],
        }
        for label, extra in cases.items():
            with self.subTest(label):
                proc = self.publish(SHA_A, fixture_site(SHA_A) + extra)
                self.assertEqual(proc.returncode, 2, "%s -> %s" % (label, proc.stderr))
                self.assert_no_pointer()

    def test_rejects_duplicates(self):
        proc = self.publish(SHA_A, fixture_site(SHA_A) + [("js/app.js", b"other")])
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assert_no_pointer()

    def test_rejects_missing_referenced_file(self):
        entries = [e for e in fixture_site(SHA_A) if e[0] != "js/app.js"]
        proc = self.publish(SHA_A, entries)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assert_no_pointer()

    def test_rejects_manifest_hash_mismatch(self):
        entries = [(n, b"tampered,0,9,\n" if n == "tags/danbooru.csv" else v)
                   for n, v in fixture_site(SHA_A)]
        proc = self.publish(SHA_A, entries)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assert_no_pointer()

    def test_rejects_file_count_limit(self):
        script = (
            "import sys; sys.path.insert(0, %r); import runpod_deploy as d;"
            " d.MAX_FILES = 3; raise SystemExit(d.main(['--data-root', %r, 'publish', %r]))"
            % (os.path.dirname(SERVER), self.data, SHA_B))
        entries = fixture_site(SHA_B) + [("img/x%d.png" % i, b"x") for i in range(4)]
        proc = subprocess.run([sys.executable, "-c", script],
                              input=make_tar(entries), capture_output=True, timeout=120)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assert_no_pointer()

    def test_inspect_is_read_only(self):
        missing = os.path.join(self.tmp, "does-not-exist")
        proc = run_publisher(missing, "inspect")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(missing))
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["pointer"], "symlink")
        self.assertIsNone(payload["current"])
        self.assertEqual(payload["pointer_anomalies"], [])

    @NEEDS_SYMLINK
    def test_lock_is_exclusive(self):
        holder = subprocess.Popen(
            [sys.executable, "-c",
             "import sys,time; sys.path.insert(0, %r); import runpod_deploy as d;"
             " h = d.acquire_lock(%r); print('locked', flush=True); time.sleep(20)"
             % (os.path.dirname(SERVER), self.data)],
            stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            proc = self.publish(SHA_A, fixture_site(SHA_A))
            self.assertEqual(proc.returncode, 4, proc.stderr)
        finally:
            holder.kill()
            holder.wait(timeout=30)
            holder.stdout.close()


@NEEDS_SYMLINK
class StateTests(unittest.TestCase):
    """Publish/rollback/prune state machine (requires real symlink support)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = os.path.join(self.tmp, "_rel")
        os.makedirs(self.data)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def publish(self, sha, entries=None, extra=()):
        return run_publisher(self.data, *extra, "publish", sha,
                             stdin=make_tar(entries or fixture_site(sha)))

    def current(self):
        return os.path.basename(os.readlink(os.path.join(self.data, "current"))) \
            if os.path.islink(os.path.join(self.data, "current")) else None

    def test_publish_and_pointer(self):
        proc = self.publish(SHA_A)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.current(), SHA_A)
        self.assertEqual(os.readlink(os.path.join(self.data, "current")),
                         os.path.join("releases", SHA_A))
        self.assertTrue(os.path.isfile(
            os.path.join(self.data, "releases", SHA_A, "js", "app.js")))

    def test_refuses_non_symlink_pointer(self):
        with open(os.path.join(self.data, "current"), "w", encoding="utf-8") as fh:
            fh.write(SHA_A + "\n")
        proc = self.publish(SHA_A)
        self.assertEqual(proc.returncode, 6, proc.stderr)
        self.assertIn(b"not a symlink", proc.stderr)

    def test_failed_publish_keeps_current(self):
        self.assertEqual(self.publish(SHA_A).returncode, 0)
        broken = [e for e in fixture_site(SHA_B) if e[0] != "css/style.css"]
        proc = self.publish(SHA_B, broken)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(self.current(), SHA_A)
        self.assertFalse(os.path.isdir(os.path.join(self.data, "releases", SHA_B)))
        staging = os.path.join(self.data, "staging")
        leftovers = os.listdir(staging) if os.path.isdir(staging) else []
        self.assertEqual([d for d in leftovers if d.startswith(SHA_B[:12])], [])

    def test_same_sha_different_content_rejected(self):
        self.assertEqual(self.publish(SHA_A).returncode, 0)
        changed = [(n, b"console.log(2);\n" if n == "js/app.js" else v)
                   for n, v in fixture_site(SHA_A)]
        proc = self.publish(SHA_A, changed)
        self.assertEqual(proc.returncode, 3, proc.stderr)
        with open(os.path.join(self.data, "releases", SHA_A, "js", "app.js"), "rb") as fh:
            self.assertEqual(fh.read(), b"console.log(1);\n")
        self.assertEqual(self.current(), SHA_A)

    def test_same_sha_identical_content_is_noop(self):
        self.assertEqual(self.publish(SHA_A).returncode, 0)
        proc = self.publish(SHA_A)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(b"identical content", proc.stderr)
        self.assertEqual(self.current(), SHA_A)

    def test_rollback(self):
        self.assertEqual(self.publish(SHA_A).returncode, 0)
        self.assertEqual(self.publish(SHA_B).returncode, 0)
        self.assertEqual(self.current(), SHA_B)
        proc = run_publisher(self.data, "rollback", SHA_A)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.current(), SHA_A)
        proc = run_publisher(self.data, "rollback", SHA_C)
        self.assertEqual(proc.returncode, 5)
        self.assertEqual(self.current(), SHA_A)

    def test_prune_respects_keep_and_protects_current_previous(self):
        for sha in (SHA_A, SHA_B, SHA_C, SHA_D, SHA_E, SHA_F):
            self.assertEqual(self.publish(sha).returncode, 0)
        # default grace (1 day) protects every fresh release
        self.assertEqual(len(os.listdir(os.path.join(self.data, "releases"))), 6)
        # a real publish with grace 0 prunes down to --keep 5
        proc = self.publish(SHA_G, extra=("--keep", "5", "--grace", "0"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        releases = sorted(os.listdir(os.path.join(self.data, "releases")))
        self.assertLessEqual(len(releases), 5, releases)
        self.assertNotIn(SHA_A, releases)          # oldest dropped first
        self.assertIn(SHA_G, releases)
        self.assertIn(SHA_F, releases)
        inspected = json.loads(run_publisher(self.data, "inspect").stdout)
        self.assertEqual(inspected["current"], SHA_G)
        self.assertEqual(inspected["previous"], SHA_F)

    def test_prune_never_deletes_current_previous(self):
        for sha in (SHA_A, SHA_B, SHA_C):
            self.assertEqual(self.publish(sha, extra=("--keep", "2", "--grace", "0")).returncode, 0)
        inspected = json.loads(run_publisher(self.data, "inspect").stdout)
        self.assertEqual(inspected["current"], SHA_C)
        self.assertEqual(inspected["previous"], SHA_B)
        releases = [r["sha"] for r in inspected["releases"]]
        self.assertIn(SHA_C, releases)
        self.assertIn(SHA_B, releases)

    def test_publish_real_bundle(self):
        bundle, report = pack_frontend.build_bundle(REPO_ROOT, SHA_A)
        proc = run_publisher(self.data, "publish", SHA_A, stdin=bundle)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(self.current(), SHA_A)
        release = os.path.join(self.data, "releases", SHA_A)
        with open(os.path.join(release, "index.html"), encoding="utf-8") as fh:
            index = fh.read()
        self.assertIn("./_rel/%s/js/tag-index.js" % SHA_A, index)
        with open(os.path.join(release, "tags", "manifest.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
        self.assertEqual(manifest["version"], report["tag_versions"]["version"])
        self.assertTrue(os.path.isfile(os.path.join(release, "favicon.ico")))
        self.assertTrue(os.path.isdir(os.path.join(release, "img")))
        self.assertTrue(os.path.isfile(os.path.join(release, "vue", "vue.global.prod.js")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
