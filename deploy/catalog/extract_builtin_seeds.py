#!/usr/bin/env python3
"""Extract the trusted built-in templates into a catalog_service seed file.

Dev-time helper only (never installed on the server, never executed by any
deploy path). It evaluates ``js/builtin-templates.js`` in a throw-away Node VM
context with no filesystem, network, process or module access, then emits the
**JSON array** format consumed by:

    python -m catalog_service.cli --db <db> seed <seeds.json>

(see ``catalog_service/README.md`` §2 and ``catalog_service/store.py::seed_items``).
Items land as ``draft``; publishing stays an explicit admin action in /admin/.

Usage
    python deploy/catalog/extract_builtin_seeds.py --repo . --check
    python deploy/catalog/extract_builtin_seeds.py --repo . \
        --out D:/tmp/run-20261110-catalog/builtin-seeds.json

Each entry mirrors what validate_create accepts (kind, name, description,
category, order, data) plus the optional ``legacyId`` used for deterministic
``shared:<uuid5>`` ids and idempotent re-seeding. ``data`` is exactly
{schemaVersion, workflow, defaults, editor} — no other fields.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

BUILTIN_JS = os.path.join("js", "builtin-templates.js")

# Runs inside Node. No require/fs/process inside the sandbox: only a bare VM
# context plus `window` (the script ends with `window.BuiltinTemplates = ...`).
NODE_RUNNER = r"""
const fs = require('fs');
const vm = require('vm');
const file = process.argv[2] || process.argv[1];
const code = fs.readFileSync(file, 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(code, sandbox, { filename: file, timeout: 5000 });
const value = sandbox.window.BuiltinTemplates;
if (!Array.isArray(value) || value.length === 0) {
  throw new Error('BuiltinTemplates is not a non-empty array');
}
process.stdout.write(JSON.stringify(value));
"""


def extract(repo: str) -> list:
    node = shutil.which("node")
    if node is None:
        raise SystemExit("node not found; Node.js 18+ is required for this helper")
    js_path = os.path.join(repo, BUILTIN_JS.replace("/", os.sep))
    if not os.path.isfile(js_path):
        raise SystemExit("missing %s under %s" % (BUILTIN_JS, repo))
    proc = subprocess.run([node, "-e", NODE_RUNNER, js_path],
                          capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise SystemExit("node failed: %s" % proc.stderr.decode("utf-8", "replace")[:2000])
    templates = json.loads(proc.stdout.decode("utf-8"))
    seeds = []
    seen = set()
    for tpl in templates:
        if not isinstance(tpl, dict) or not tpl.get("id"):
            raise SystemExit("unexpected template shape: no id")
        if tpl["id"] in seen:
            raise SystemExit("duplicate builtin template id: %s" % tpl["id"])
        seen.add(tpl["id"])
        if tpl.get("schemaVersion") != 2:
            raise SystemExit("template %s is not schemaVersion 2" % tpl["id"])
        for field in ("workflow", "defaults", "editor"):
            if not isinstance(tpl.get(field), dict):
                raise SystemExit("template %s has no %s object" % (tpl["id"], field))
        seeds.append({
            "kind": "template",
            "legacyId": tpl["id"],
            "name": tpl.get("name") or tpl["id"],
            "description": tpl.get("description") or "",
            "category": "builtin",
            "order": 10,
            "data": {
                "schemaVersion": 2,
                "workflow": tpl["workflow"],
                "defaults": tpl["defaults"],
                "editor": tpl["editor"],
            },
        })
    return seeds


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".", help="frontend repo root (default: .)")
    parser.add_argument("--out", help="write seed JSON array here (default: stdout)")
    parser.add_argument("--check", action="store_true",
                        help="validate and print a summary instead of the JSON")
    args = parser.parse_args(argv)

    seeds = extract(args.repo)
    payload = json.dumps(seeds, ensure_ascii=False, indent=2) + "\n"
    if len(seeds) > 100:  # catalog_service.config.MAX_IMPORT_ITEMS
        raise SystemExit("more than 100 seed items; split the file")

    if args.check:
        print(json.dumps({
            "count": len(seeds),
            "legacyIds": [seed["legacyId"] for seed in seeds],
            "kinds": sorted({seed["kind"] for seed in seeds}),
            "sha256_prefix": hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12],
            "bytes": len(payload.encode("utf-8")),
        }, ensure_ascii=False))
        return 0
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(payload)
        print("wrote %d seed items to %s" % (len(seeds), args.out), file=sys.stderr)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
