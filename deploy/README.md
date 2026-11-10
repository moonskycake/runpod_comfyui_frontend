# deploy/ — immutable release publishing for runpod.hyxer.top

Two pieces, no third-party deploy actions, Python standard library only.

| File | Runs where | Purpose |
|---|---|---|
| `pack_frontend.py` | GitHub Actions runner | packs the whitelisted static site into a deterministic tar.gz, rewrites `index.html` asset attributes and `tags/manifest.json` versions |
| `server/runpod_deploy.py` | server, as `runpod-deploy` | validates the tar stream, stages, publishes an immutable release, swaps `current`, prunes old releases. Pointers are symlinks **only** — no detection, no fallback, no probe files; `inspect` is read-only and takes no lock |
| `server/runpod-deploy-gateway` | server, root-owned, executed by sshd as the logged-in user | forced-command allow-list (`deploy <sha40>` / `rollback <sha40>` / `inspect`), execs the publisher |
| `server/nginx-deploy-snippet.conf` | server, nginx vhost | serves `/` and the runtime `tags/`, `img/`, `favicon.ico` paths from the current release; returns 404 for `/_rel/current*`, and never hard-caches unversioned `tags/` URLs |
| `tests/test_deploy.py` | anywhere | 35 test cases; the symlink state-machine tests are skipped where symlink creation is refused (Windows without Developer Mode) and must run once on the Linux host |

## What this channel does not deploy

The catalog backend service itself (`catalog_service/`, FastAPI + SQLite) and its runtime
data — venv, systemd unit, `catalog.env`, `catalog.db` — are **not** part of this
channel: GitHub Actions publishes static files as `runpod-deploy`, which has no
root, no package install and no service restart. The `admin.html` shell and its
`js/` / `css/` assets **are** static and are packed, validated and published here
like `index.html` (served at `/admin/`, assets rewritten root-absolute).
Installing/upgrading the backend and the DB is a separate manual root procedure —
see `deploy/catalog/README.md`. The Nginx snippet in `server/` covers `/admin`,
`/admin/` and `^~ /api/` (upstream `127.0.0.1:8787`), so the static and service
halves meet in one vhost while deploying independently.

Production reference (snapshot, not live): functional commit
`44b657b99da75f6df79a78e98ed7b78505c360d7`, last static release Actions run
42841396575 (success), site `https://runpod.hyxer.top/`, admin
`https://runpod.hyxer.top/admin/`.

## Release layout

```
/www/wwwroot/runpod.hyxer.top/          # existing docroot, NOT writable by deploy
├── index.html, tags/, img/, .user.ini  # untouched legacy files (never deleted)
└── _rel/                               # new, owner runpod-deploy:www, 0755
    ├── releases/<sha40>/index.html, css/, js/, bootstrap/, vue/, tags/, img/, favicon.ico
    ├── current  -> releases/<sha40>    # atomic rename, this is what nginx serves
    ├── previous -> releases/<sha40>
    └── staging/, .lock                 # transient / flock
```

Only two artefacts are rewritten inside a release; no JS/CSS/HTML business code changes:

1. `index.html`: local `src`/`href` attributes `./x` → `./_rel/<sha40>/x` (query strings dropped later by the immutable path; document order untouched).
2. `tags/manifest.json`: `version` / `zhVersion` → first 12 hex of the SHA-256 of `tags/danbooru.csv` / `tags/zhcn.csv`; every other field preserved. This is the schema `js/tag-index.js` already reads (`resolveVersionedUrl`), so new tag data busts caches without touching JS.

Published URIs are `/_rel/<sha40>/…`; the document is served at `/`, so the app's runtime `./tags/…` fetches keep resolving to `/tags/…`, which nginx maps to the current release.

## Server installation (root, one-off)

```bash
# 1. dedicated account: password locked, but a real shell is required so the
#    forced command can run (nologin would break it)
useradd --create-home --shell /bin/bash runpod-deploy
usermod -L runpod-deploy
passwd -S runpod-deploy            # expect: L (locked)

# 2. root-owned publisher + gateway (never executed content from a bundle)
install -d -m 755 /usr/local/lib/runpod-deploy
install -m 755 deploy/server/runpod_deploy.py       /usr/local/lib/runpod-deploy/runpod_deploy.py
install -m 755 deploy/server/runpod-deploy-gateway  /usr/local/sbin/runpod-deploy-gateway
chown root:root /usr/local/lib/runpod-deploy/runpod_deploy.py /usr/local/sbin/runpod-deploy-gateway

# 3. deploy key: public half only, forced command, no forwarding.
#    HOME, .ssh and authorized_keys are all ROOT-owned and not writable by the
#    deploy account: otherwise it could rename .ssh aside and drop in its own
#    key, bypassing the forced command. They must still be traversable/readable
#    by that account, or sshd cannot use the key: home 755, .ssh 755, keys 644
#    (the contents are public keys, no secrecy needed — never 700/600 root).
install -d -m 755 -o root -g root /home/runpod-deploy
install -d -m 755 -o root -g root /home/runpod-deploy/.ssh
cat > /home/runpod-deploy/.ssh/authorized_keys <<'EOF'
restrict,command="/usr/local/sbin/runpod-deploy-gateway" ssh-ed25519 AAAA...COMMENT gh-actions-deploy
EOF
chown root:root /home/runpod-deploy/.ssh /home/runpod-deploy/.ssh/authorized_keys
chmod 755 /home/runpod-deploy /home/runpod-deploy/.ssh
chmod 644 /home/runpod-deploy/.ssh/authorized_keys

# 4. release data dir under the existing docroot (owner = deploy, group = nginx)
install -d -m 755 -o runpod-deploy -g www /www/wwwroot/runpod.hyxer.top/_rel
```

Rollout checks (all must hold, otherwise stop):

```bash
# 1. ownership/modes: expect root:root 755, root:root 755, root:root 644
stat -c '%U:%G %a %n' /home/runpod-deploy /home/runpod-deploy/.ssh \
                        /home/runpod-deploy/.ssh/authorized_keys
# 2. the deploy account cannot modify its own auth material (no output = good)
sudo -u runpod-deploy test -w /home/runpod-deploy/.ssh/authorized_keys && echo BAD_KEYS_WRITABLE
sudo -u runpod-deploy test -w /home/runpod-deploy/.ssh && echo BAD_SSH_WRITABLE
sudo -u runpod-deploy test -w /home/runpod-deploy && echo BAD_HOME_WRITABLE
sudo -u runpod-deploy test -w /usr/local/sbin/runpod-deploy-gateway && echo BAD_GATEWAY_WRITABLE
# 3. but sshd (running as that user) can still traverse and read the key (no output = bad)
sudo -u runpod-deploy test -x /home/runpod-deploy && echo HOME_TRAVERSABLE
sudo -u runpod-deploy test -r /home/runpod-deploy/.ssh/authorized_keys && echo KEY_READABLE
# 4. the account keeps a real shell (nologin would block the forced command) and a locked password
getent passwd runpod-deploy | cut -d: -f7      # expect /bin/bash (or another real shell)
passwd -S runpod-deploy                        # expect status L
# 5. only the release data dir is writable by the deploy account (owned runpod-deploy:www)
sudo -u runpod-deploy test -w /www/wwwroot/runpod.hyxer.top/_rel && echo REL_WRITABLE_OK
sudo -u runpod-deploy test -w /www/wwwroot/runpod.hyxer.top && echo BAD_SITE_ROOT_WRITABLE
```

## GitHub configuration

Repository → Settings → Secrets and variables → Actions:

- secret `DEPLOY_SSH_KEY`: private key matching the `authorized_keys` entry above
- variables `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER` (`runpod-deploy`)

The workflow pins the host key by fingerprint (`SITE_HOST_KEY_SHA256` in `.github/workflows/deploy.yml`,
`SHA256:mlUDGAbjplvcWtF9w0Kj1JCt+RRlNKRrXKBlWDlSFes`, recorded from earlier read-only probes — TOFU pin, not
independently attested) and only copies the matching `ssh-keyscan` line into `known_hosts`, so
`StrictHostKeyChecking=yes` is satisfied without trusting unrelated keys.

## First rollout order (avoids a 404 window)

1. Install everything above except the nginx snippet.
2. Publish one release before touching nginx:
   `python3 deploy/pack_frontend.py --repo . --sha "$(git rev-parse HEAD)" | ssh -T -p <port> runpod-deploy@<host> "deploy $(git rev-parse HEAD)"`
3. `ssh ... "inspect"` → confirm `current` = that sha, `pointer_mode: symlink`.
4. Backup and append the nginx snippet: `cp <vhost>.conf <vhost>.conf.bak-$(date +%Y%m%d-%H%M%S)`,
   insert `deploy/server/nginx-deploy-snippet.conf`, then `nginx -t && systemctl reload nginx`.
5. Verify: `curl -sSI https://runpod.hyxer.top/ | grep -i cache-control` → `no-cache`;
   `curl -sS https://runpod.hyxer.top/ | grep -o '/_rel/[0-9a-f]\{40\}'` → current sha;
   a `/_rel/<sha>/js/main.js` response shows `Cache-Control: max-age=315360000`.

Rollback: `ssh ... "rollback <previous-sha40>"` (or Actions → Run workflow → `rollback`), or restore the `.bak` vhost
and reload to abandon the snippet entirely. Old `index.html`/`tags/`/`img/` in the docroot are never deleted, so
reverting the snippet returns to the previous behaviour immediately.

## Local tests

```bash
python deploy/tests/test_deploy.py -v      # 35 cases; Windows measured 25 passed / 10 skipped (WinError 1314); the 14 subtests are inside those cases, do not add them to the count
```

Covered: real-repo packing (whitelist, order, reference completeness), CSS relative layout, CSV change → manifest
version change, malicious tar paths/links/duplicates/limits, missing referenced file, manifest hash mismatch,
failure leaves `current` unchanged, same-sha-different-payload rejection, identical re-publish no-op, exclusive lock,
rollback, prune keeps `current`+`previous`, end-to-end publish of the real bundle.

Not covered locally: the symlink pointer primitive (needs Linux). `RUNPOD_DEPLOY_POINTER=file` is a test-only
fallback for that one primitive; production always uses symlinks and must be verified on the host during rollout.
