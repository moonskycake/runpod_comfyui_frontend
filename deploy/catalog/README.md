# Catalog backend: install / upgrade / backup runbook

Status: **可重复执行的运维程序**。它描述的是“要做什么、怎么验证”，不是实时健康报告：生产已于 2026-11-10 按本文件部署并上线（功能提交 `44b657b`），当前状态以服务器为准，服务实例的具体细节（登录、内容、响应头）以现场 `curl` / `systemctl` 观察为准。重跑本文件不会自动修复已偏离的状态。

相关：`catalog_service/README.md`（服务契约、env 表、CLI）——在主机上是 `/opt/runpod-catalog/app/current/catalog_service/README.md`，从不在树根放副本；`docs/catalog-api.md`（冻结 API）、`docs/plans/shared-library-backend-plan.md`。前端发布通道（`deploy/server/runpod-deploy-gateway` + GitHub Actions）**不能**执行下面任何一步：它以非特权用户发布静态文件，无 root、无装包、无重启服务权限。后端的安装与升级一律是独立的人工 root 操作，没有自动发版。

## 0. What runs where

```
/opt/runpod-catalog/
├── venv/                 # one shared virtualenv (root-owned, not per version)
├── app/
│   ├── <version>/        # each backend release (catalog_service/), immutable
│   └── current -> <version>
└── README.md
/etc/runpod-catalog/catalog.env        # root:root 0600, from catalog.env.example
/etc/systemd/system/runpod-catalog.service
/var/lib/runpod-catalog/catalog.db     # persistent SQLite data; survives upgrades
```

- listener: `127.0.0.1:8787` only (`CATALOG_HOST` / `CATALOG_PORT`), matching the
  `location ^~ /api/` upstream in `deploy/server/nginx-deploy-snippet.conf`.
- account: `runpod-catalog`, system account, no shell; owns only
  `/var/lib/runpod-catalog`.
- admin UI: the static `/admin/` shell published with the normal frontend
  release (`_rel/current/admin.html`). No backend file is exposed by the
  gateway, and no bundle content is ever executed by it.
- Nginx forwards `/api/` with caching headers untouched (`expires off`,
  `proxy_cache off`): `/api/catalog` stays `no-cache` + `ETag`, every
  `/api/admin` response — errors included — stays `no-store` as the app sets it.

## 1. Prerequisites (all must hold before starting)

On the server, as root:

1. Linux with systemd, Python 3.10+ (`python3 --version`), `sqlite3` CLI, and
   nginx already serving the site from `/www/wwwroot/runpod.hyxer.top`.
2. The backend tree available **on the host** (checkout, wheel or source
   tarball) plus `catalog_service/requirements.txt`. It is not fetched by this
   repo's deploy channel.
3. Free disk for `/opt/runpod-catalog` and `/var/lib/runpod-catalog`, plus room
   for at least one full DB backup copy (`df -h /var`).
4. `pip` access during install only (or a local wheel dir). The service needs no
   outbound network for catalog reads/writes.
5. The public origin decided in advance, normally `https://runpod.hyxer.top`
   (`CATALOG_PUBLIC_ORIGIN`; exact match, no path).
6. The frontend release containing `admin.html` published first (§4), otherwise
   `/admin/` 404s right after the Nginx change.
7. An admin password kept in a password manager. There is **no default
   account**, no default password and no first-run setup page.

Stop and re-plan if any is false; do not improvise a root install through the
deploy account.

## 2. Provisioning (root, one time)

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin runpod-catalog

install -d -m 755 -o root -g root /opt/runpod-catalog /opt/runpod-catalog/app
install -d -m 750 -o runpod-catalog -g runpod-catalog /var/lib/runpod-catalog
install -d -m 700 -o root -g root /etc/runpod-catalog
```

One shared venv, reused across app versions. **Do not `apt install` on this host**: the site's
Python is the distribution one (`python3.10`), and `apt install python3.10-venv` pulls a
python3.10 point upgrade that the panel and other services share. Bootstrap pip inside the
venv only:

```bash
python3 -m venv --without-pip /opt/runpod-catalog/venv
curl -fsSL -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py \
  && /opt/runpod-catalog/venv/bin/python /tmp/get-pip.py --no-warn-script-location \
  && rm -f /tmp/get-pip.py
/opt/runpod-catalog/venv/bin/pip install -r /path/to/frontend/catalog_service/requirements.txt
chown -R root:root /opt/runpod-catalog/venv
python3 -V     # must be unchanged (3.10.6); the venv never touches the system interpreter
```

`sqlite3` CLI is *not* required: the service and its CLI use the stdlib `sqlite3` module,
including `backup` and `PRAGMA integrity_check`.

First app version; the package layout must keep `catalog_service/` importable
from the version directory (copy the repo tree, drop VCS metadata):

```bash
VERSION=2026-11-10-1
install -d -m 755 -o root -g root /opt/runpod-catalog/app/"$VERSION"
cp -a /path/to/frontend/. /opt/runpod-catalog/app/"$VERSION"/
rm -rf /opt/runpod-catalog/app/"$VERSION"/.git
ln -sfn "$VERSION" /opt/runpod-catalog/app/current
ln -sfn /opt/runpod-catalog/app/current/catalog_service/README.md /opt/runpod-catalog/README.md
readlink -f /opt/runpod-catalog/README.md   # must resolve inside app/current/catalog_service/
```

Environment file — copy the template, then replace the hash placeholder on the
host. Names come from `catalog_service/config.py`; there are no aliases and no
session-secret variable (sessions are random opaque tokens stored hashed in the
DB).

```bash
install -m 600 -o root -g root \
        deploy/catalog/catalog.env.example /etc/runpod-catalog/catalog.env
$EDITOR /etc/runpod-catalog/catalog.env     # CATALOG_PUBLIC_ORIGIN, paths, betas
stat -c '%U:%G %a %n' /etc/runpod-catalog/catalog.env   # expect root:root 600
```

Generate the password hash with the interactive CLI. It reads the password with
`getpass` twice and prints only the `scrypt$...` line to stdout; the plaintext is
never written to disk, argv or logs:

```bash
cd /opt/runpod-catalog/app/current
sudo -u runpod-catalog -H /opt/runpod-catalog/venv/bin/python -m catalog_service.cli init-admin
# copy the printed scrypt$16384$8$1$<salt>$<digest> into CATALOG_ADMIN_PASSWORD_HASH
```

Do not paste the hash into tickets/chat; keep it in the 0600 env file. Login
returns 503 while the variable is unset or malformed — that is the intended
"no default credentials" state.

Install and start the unit (template: `deploy/catalog/runpod-catalog.service`,
which runs the `catalog_service.app:build_from_env` factory with
`--proxy-headers --forwarded-allow-ips=127.0.0.1`):

```bash
install -m 644 -o root -g root \
        deploy/catalog/runpod-catalog.service /etc/systemd/system/runpod-catalog.service
systemctl daemon-reload
systemctl enable --now runpod-catalog.service
systemctl status --no-pager runpod-catalog.service
```

The schema is created on startup (`init_db`); there is no separate `init-db`
step. Verify before touching Nginx:

```bash
curl -fsS -D- http://127.0.0.1:8787/api/catalog -o /dev/null | sed -n '1,12p'
# expect 200, Cache-Control: no-cache, ETag
curl -sS -D- -o /dev/null http://127.0.0.1:8787/api/admin/session | grep -i cache-control
# expect no-store (also for 401 bodies)
ss -ltnp | grep 8787        # must be 127.0.0.1:8787, never 0.0.0.0:8787
```

## 3. Seeding the shared library

Seeding is explicit and never publishes. Production seeding has already run once with exactly the two builtins (both at `publish v1`); this section stays here so a rebuild from scratch is repeatable, and re-running it only reports `skipped`.

1. Extract the trusted builtins to seed JSON on a dev machine. The helper runs
   `js/builtin-templates.js` in a Node VM with no fs/network access and emits the
   array format `catalog_service.cli seed` expects (`kind`, `legacyId`, `name`,
   `description`, `category`, `order`, `data`):

   ```bash
   python deploy/catalog/extract_builtin_seeds.py --repo . --check
   python deploy/catalog/extract_builtin_seeds.py --repo . \
       --out D:/tmp/run-20261110-catalog/builtin-seeds.json
   ```

2. Import as drafts. **Run the CLI as the service account, never as root**: the DB is
   `runpod-catalog:runpod-catalog 0600`, and a root-run CLI leaves `-wal`/`-shm`
   files owned by root inside `/var/lib/runpod-catalog`, which the service can no
   longer open. The seed file must not sit in `/root` either — the service account
   cannot traverse it. Put it in the data directory instead, owned by the service
   account, mode 0600, and pass `--db` explicitly (the CLI does not read the
   systemd `EnvironmentFile`):

   ```bash
   install -m 600 -o runpod-catalog -g runpod-catalog \
           <builtin-seeds.json> /var/lib/runpod-catalog/seeds.json
   cd /opt/runpod-catalog/app/current
   sudo -u runpod-catalog -H /opt/runpod-catalog/venv/bin/python -m catalog_service.cli \
     --db /var/lib/runpod-catalog/catalog.db \
     seed /var/lib/runpod-catalog/seeds.json
   # expect {"inserted": 2, "skipped": 0, "idConflicts": []} on the first run
   ```

   The CLI needs the current app directory on `sys.path` to import the module.
   `sudo -H` changes `HOME`, **not** cwd — running it from `/root` or anywhere
   else fails with `ModuleNotFoundError: No module named 'catalog_service'`.

   Idempotent: `legacyId` gives deterministic `shared:<uuid5>` ids, so re-running
   only reports `skipped`. Delete `/var/lib/runpod-catalog/seeds.json` (or leave it
   `0600 runpod-catalog`) once the import is confirmed; it is input data, not part
   of any release.

3. Only the two existing builtins are seeded. Any optional generic quality
   preset is created by the admin in `/admin/` as a normal draft — do not ship a
   reviewed-looking preset nobody read.
4. Review each item in `/admin/`, then publish explicitly. `GET /api/catalog`
   shows only published revisions.

## 4. Nginx (after the admin shell is published)

The snippet already contains `/admin`, `/admin/` and `^~ /api/`. Add it to the
site's `server{}` block only after a release containing `admin.html` is
`current`. The `^~ /api/` block sets `client_max_body_size 6m`: the UI accepts
input images up to 5 MiB and the JSON/base64 envelope plus headers have to fit
as well — do not lower it below 6m without re-measuring the largest realistic
payload, and keep the service-side limit (`catalog_service/validation.py`) as
the authority:

```bash
cp <vhost>.conf <vhost>.conf.bak-$(date +%Y%m%d-%H%M%S)
$EDITOR <vhost>.conf               # insert deploy/server/nginx-deploy-snippet.conf
nginx -t && systemctl reload nginx
```

Checks:

```bash
curl -sSI https://runpod.hyxer.top/admin | head -3                 # 301 -> /admin/
curl -sSI https://runpod.hyxer.top/admin/ | grep -i cache-control  # no-cache
curl -sS https://runpod.hyxer.top/admin/ | grep -o '/_rel/[0-9a-f]\{40\}'
curl -sS -D- -o /dev/null https://runpod.hyxer.top/api/catalog | grep -iE 'cache-control|etag'
# expect no-cache + ETag; admin endpoints stay no-store through the proxy
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://runpod.hyxer.top/api/admin/items  # 401/403
```

The login page being publicly reachable is intended; `/api/admin/*` enforces
authentication. Never add an Nginx allow/deny or hidden URL in place of real
auth, and never rely on the frontend hiding the menu entry.

## 5. Upgrade

```bash
# 1. BACKUP FIRST (§6); an upgrade without a fresh backup is out of policy.
# 2. install the new version next to the old one
VERSION=2026-11-20-1
install -d -m 755 -o root -g root /opt/runpod-catalog/app/"$VERSION"
cp -a /path/to/frontend-v2/. /opt/runpod-catalog/app/"$VERSION"/
rm -rf /opt/runpod-catalog/app/"$VERSION"/.git
# 3. dependencies only if requirements.txt changed
/opt/runpod-catalog/venv/bin/pip install -r /opt/runpod-catalog/app/"$VERSION"/catalog_service/requirements.txt
# 4. migrations must be backward compatible with the previous service version
#    (store.init_db is additive; no destructive migration in this phase)
# 5. atomic switch + restart
ln -sfn "$VERSION" /opt/runpod-catalog/app/current
systemctl restart runpod-catalog.service
systemctl is-active --quiet runpod-catalog.service
curl -fsS http://127.0.0.1:8787/api/catalog > /dev/null && echo API_OK
```

Rules:

- The DB lives outside the version directory. Never copy a DB into a release
  dir; keep at least the previous `app/<version>/` for the rollback window.
- Additive schema only: the previous service version must keep working on the
  same DB. No cross-version downgrade guarantee.
- Frontend and backend deploy independently; keep old response fields readable.
- RunPod images/endpoints are never part of this procedure.

## 6. Backup / restore

Run the backup **as root** — `/var/backups/runpod-catalog` is `root:root 0700`, so the
service account cannot and must not write there. Root can read the `0600` DB, so no
account switch is needed (and never `sudo -u runpod-catalog` into a root-owned directory):

```bash
install -d -m 700 -o root -g root /var/backups/runpod-catalog
umask 077
cd /opt/runpod-catalog/app/current     # CLI must import catalog_service from here
/opt/runpod-catalog/venv/bin/python -m catalog_service.cli \
  --db /var/lib/runpod-catalog/catalog.db \
  backup /var/backups/runpod-catalog/catalog-$(date +%Y%m%d-%H%M%S).db
chown root:root /var/backups/runpod-catalog/catalog-*.db
chmod 600 /var/backups/runpod-catalog/catalog-*.db
```

Verify integrity with the stdlib module (no `sqlite3` CLI is installed on this
host and none is needed):

```bash
printf 'import sqlite3,sys\nprint(sqlite3.connect(sys.argv[1]).execute("PRAGMA integrity_check").fetchone()[0])\n' \
  | /opt/runpod-catalog/venv/bin/python - /var/backups/runpod-catalog/catalog-<STAMP>.db
# expect: ok
```

- The CLI uses the SQLite backup API (WAL contents included); a plain `cp` of a
  live DB is not an acceptable backup.
- The CLI writes the destination with the caller's umask: always set `umask 077`
  first and verify `0600 root:root` afterwards. An existing destination is
  refused unless `--force` is passed.
- Backups contain catalog data and, indirectly, operational metadata: never copy
  one back into a release directory or into the web root.
- Copy the newest backup **off the host**; another directory on the same VPS is
  not disaster recovery.
- **No scheduled backup exists yet.** Backups are hand-run; a timer/cron job is an
  open candidate, not an implemented feature. Treat the newest file in
  `/var/backups/runpod-catalog/` as the freshness measure and check the date
  before any upgrade.
- Restore: stop the service, install the backup as
  `/var/lib/runpod-catalog/catalog.db` owned `runpod-catalog:runpod-catalog`
  mode 0600, remove stale `-wal`/`-shm` siblings, start the service, then
  re-check `/api/catalog` and one admin login. This is a documented procedure,
  **not** an exercised drill: only backup + `integrity_check` have actually been
  run, restore-from-backup has not been performed end to end.
- Service rollback: `ln -sfn <previous-version> /opt/runpod-catalog/app/current
  && systemctl restart runpod-catalog.service`. Restore the DB only if a
  migration was not backward compatible — the documented exception.

## 7. Frontend release interaction

- `admin.html`, when present, is packed and validated by
  `deploy/pack_frontend.py`; its asset URLs are rewritten root-absolute
  (`/_rel/<sha>/...`) because it is served at `/admin/`.
- The publisher (`deploy/server/runpod_deploy.py`) rejects service artefacts
  (`.env`, `*.db`, `*.py`, `*.service`, dotfiles), nested HTML, and any foreign
  or missing release reference. Backend code is never bundled.
- The GitHub Actions workflow needs no change for the catalog; it keeps
  publishing static files only. Installing the backend, its venv, unit, admin
  hash or the Nginx blocks remains a manual root action.

## 8. Local preview (QA only, never deployed)

`deploy/catalog/dev_preview.py` builds the real packed bundle in memory and
serves `/`, `/admin/` and `/_rel/<sha>/...` from it, proxying `/api/*` verbatim
to `127.0.0.1:8787` (bodies ≤ 2 MiB, upstream Cache-Control passed through):

```bash
python deploy/catalog/dev_preview.py --repo . --port 8766
# backend Origin must match the browser: CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766
```

Production always uses Nginx; this file is not part of any release.

## 9. Admin password rotation

The admin hash lives only in `/etc/runpod-catalog/catalog.env`
(`CATALOG_ADMIN_PASSWORD_HASH`, `root:root 0600`). The plaintext is entered at a
prompt and never reaches argv, a file, a log or git. Rotate whenever the
password was exposed or on a schedule:

1. Generate a fresh hash with the deployed version's own code — run from
   `app/current` so the salt/scrypt parameters are the ones that version
   verifies (interactive `getpass`, prints only the `scrypt$...` line):

   ```bash
   cd /opt/runpod-catalog/app/current
   /opt/runpod-catalog/venv/bin/python -m catalog_service.cli init-admin
   ```

2. Edit the env file as root and replace **only** the hash line (keep
   `CATALOG_ADMIN_PASSWORD_HASH=` as the key, do not re-quote it):

   ```bash
   cp -a /etc/runpod-catalog/catalog.env /etc/runpod-catalog/catalog.env.bak-$(date +%Y%m%d-%H%M%S)
   vi /etc/runpod-catalog/catalog.env
   stat -c '%U:%G %a %n' /etc/runpod-catalog/catalog.env   # expect root:root 600
   ```

3. Restart so the new `EnvironmentFile` is read, then verify:

   ```bash
   systemctl restart runpod-catalog.service
   systemctl is-active --quiet runpod-catalog.service && echo ACTIVE
   curl -sS -D- -o /dev/null http://127.0.0.1:8787/api/admin/session | grep -i cache-control  # no-store
   ```

   Log in at `/admin/` with the new password; existing sessions are **not**
   revoked by the restart (tokens are stored hashed in the DB), so revoke them
   explicitly if the password leaked.

4. Remove the backup copy of the old env file once the new password works:
   `rm -f /etc/runpod-catalog/catalog.env.bak-*`.

Notes:

- Login returns `503` while the variable is unset or malformed — that is the
  intended "no credentials" state, not an outage of `/api/catalog`.
- A malformed hash breaks login only; the service keeps serving published
  items. Never paste a hash into a ticket, chat or commit.
- There is no session-secret variable: sessions are random opaque tokens stored
  hashed, so rotating the password does not invalidate other state.
