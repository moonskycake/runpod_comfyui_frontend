# 统一库后台服务（catalog_service）

FastAPI + SQLite（WAL）小服务。契约见 [`../docs/catalog-api.md`](../docs/catalog-api.md)（冻结，字段名不得改）。
本目录只有服务实现、CLI 与测试；部署文件（systemd / Nginx / 备份 runbook）在 [`../deploy/catalog/`](../deploy/catalog/README.md)，本服务不涉及 RunPod。
跨机器环境搭建与本地联调整体流程见仓库根 [`../README.md`](../README.md)。

## 1. 依赖与运行

Python 3.10+。依赖见 `requirements.txt`（fastapi / uvicorn / httpx / pytest / Pillow）。

所有命令都在**仓库根目录**执行（`catalog_service` 是根下的包）：`cd catalog_service` 后 `python -m catalog_service...` 必然 `ModuleNotFoundError`。

```bash
python -m pip install -r catalog_service/requirements.txt

# 交互生成口令哈希（getpass 两次，stdout 只有 scrypt$...，明文不落盘/不进 argv/日志）
python -m catalog_service.cli init-admin
```

`python -m catalog_service` 只监听环回地址，供同源反代（`/api/` → `127.0.0.1:8787`）。**服务不读 `.env`**，只认真实 OS 环境变量：

```bash
# Linux / macOS
export CATALOG_ADMIN_PASSWORD_HASH="$(python -m catalog_service.cli init-admin)"   # 新口令 >= 12 位
export CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766
mkdir -p "$HOME/.local/share/runpod-catalog"                                        # 目录须先存在
export CATALOG_DB_PATH="$HOME/.local/share/runpod-catalog/catalog.db"              # 放 checkout 外
export CATALOG_COOKIE_SECURE=false      # 仅本地 http://127.0.0.1 调试
export CATALOG_HOST=127.0.0.1
export CATALOG_PORT=8787
python -m catalog_service
```

```powershell
# Windows PowerShell
$env:CATALOG_ADMIN_PASSWORD_HASH = (python -m catalog_service.cli init-admin).Trim()   # 新口令 >= 12 位
$env:CATALOG_PUBLIC_ORIGIN = "http://127.0.0.1:8766"
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\runpod-catalog" | Out-Null     # 目录须先存在
$env:CATALOG_DB_PATH = "$env:LOCALAPPDATA\runpod-catalog\catalog.db"
$env:CATALOG_COOKIE_SECURE = "false"
$env:CATALOG_HOST = "127.0.0.1"
$env:CATALOG_PORT = "8787"
python -m catalog_service
```

或用 app 工厂：

```bash
python -m uvicorn catalog_service.app:build_from_env --factory --host 127.0.0.1 --port 8787
```

缺少 `CATALOG_PUBLIC_ORIGIN` / `CATALOG_DB_PATH` 时进程报配置错误退出（不半配置启动）。`python -m catalog_service` 拒绝非环回 `CATALOG_HOST`。启动只建表（`init_db`），**不自动种子**。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CATALOG_PUBLIC_ORIGIN` | 是 | 精确同源 Origin（如 `https://example.com`、`http://127.0.0.1:8766`）。只接受 scheme+host[:port]，带路径会配置报错。`Host` / `X-Forwarded-Host` 永不用于校验。 |
| `CATALOG_DB_PATH` | 是 | SQLite 文件路径（建议 checkout 外的绝对路径）。 |
| `CATALOG_ADMIN_PASSWORD_HASH` | 生产必填 | `init-admin` 输出的 scrypt 哈希。未设置时服务可启动但登录返回 `503`；明显格式错误（非 scrypt 或 `$` 段数不对）会在配置校验阶段导致**启动失败**。无默认口令。 |
| `CATALOG_COOKIE_SECURE` | 否，默认 `true` | 生产保持 true；仅本地 HTTP 调试设 `false`（仍 HttpOnly + SameSite=Strict + Path=/api/admin）。 |
| `CATALOG_HOST` | 否，默认 `127.0.0.1` | 只允许环回。 |
| `CATALOG_PORT` | 否，默认 `8787` | 与 Nginx 反代、`deploy/catalog/dev_preview.py` 硬编码目标一致。 |

### 本地 QA 配方

```bash
# 终端 A（仓库根，venv 已激活）：后端
export CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766
mkdir -p "$HOME/.local/share/runpod-catalog"      # 若已在上文创建可跳过
export CATALOG_DB_PATH="$HOME/.local/share/runpod-catalog/catalog.db"
export CATALOG_COOKIE_SECURE=false
export CATALOG_ADMIN_PASSWORD_HASH="$(python -m catalog_service.cli init-admin)"   # 仅本机新口令，>= 12 位
python -m catalog_service

# 终端 B（仓库根）：静态站 + 同源 /api 反代
python deploy/catalog/dev_preview.py --repo . --port 8766
# 然后访问 http://127.0.0.1:8766/ 与 /admin/
```

纯静态 `http.server` 不代理 `/api/`，资源库与 `/admin/` 会失败。`localhost` 与 `127.0.0.1` 不同源，Origin 必须与浏览器地址逐字一致。

## 2. CLI

```bash
python -m catalog_service.cli init-admin                              # 交互生成口令哈希
python -m catalog_service.cli --db <db> seed <seeds.json>             # 导入为草稿（不发布）
python -m catalog_service.cli --db <db> backup <backup.db>            # SQLite backup API 一致性副本
```

`--db` 省略时读 `CATALOG_DB_PATH`。

### 种子文件

由仓库内 helper 从可信内置模板生成（Node `vm` 只读执行 `js/builtin-templates.js`，无网络/文件权限）：

```bash
python deploy/catalog/extract_builtin_seeds.py --repo . --check
python deploy/catalog/extract_builtin_seeds.py --repo . --out <已有目录>/builtin-seeds.json
```

JSON 数组，条目形如：

```json
[{"kind": "template", "legacyId": "anima_priview_v1", "name": "anima_priview_v1",
  "description": "内置模板", "category": "builtin", "order": 10,
  "data": {"schemaVersion": 2, "workflow": {}, "defaults": {}, "editor": {}}}]
```

- `legacyId` 可选；有值时 `shared:<uuid5>` 由 `kind + legacyId` 确定性推导，重复 seed 只增加 `skipped`，不覆盖已有条目或管理员编辑。
- 条目以 `draft` 落库，**不会自动公开**；需在 `/admin/` 显式发布后 `GET /api/catalog` 才可见。
- 两个内置模板（`anima_priview_v1`、`anima_preview2_lora_v1`）的 workflow 体积大，仓库内不复制副本，避免与 `js/builtin-templates.js` 漂移。

## 3. 预览图（preset / snippet）

- 只有 `preset` / `snippet` 需要预览图；`template` 不要求。
- 上传：`POST /api/admin/items/{id}/preview?baseRev=N`，原始二进制请求体，要求会话 + `Origin` + CSRF；`baseRev` 过期 `409` 且不落图片数据（无孤儿 BLOB）。
- 输入限制：≤ 5 MiB、≤ 16 MP，只接受静态 PNG / JPEG / WebP（按内容嗅探，拒绝 SVG / GIF / 动画 / 伪图 / 坏图 / 解压炸弹）。
- 存储：转正 EXIF 方向、丢弃 EXIF/ICC/XMP 后重编码为 WebP，长边 ≤ 480 px、≤ 64 KiB，**不保留原图 / 原文件名 / 路径 / 外链**。
- 草稿图与发布图分离：`preview` 属性按 revision 固定，改草稿图不影响已发布旧图；公共与管理读取各自 `no-cache` / `no-store`，均带 `nosniff`。
- 存储为 `preview_assets` 表里的 BLOB（按压缩后 SHA256 去重），随数据库一起备份；删除无引用资产的清理在 DELETE 预览与删除草稿条目时进行。
- 细节与状态码见 [`../docs/catalog-api.md`](../docs/catalog-api.md)。

## 4. 测试

```bash
python -m pytest catalog_service/tests -q     # 28 个 ASGI 端到端用例
```

覆盖：未登录/伪造头、Origin/CSRF、登录登出与限速、草稿不泄漏（含发布后编辑）、409 冲突、停用/恢复、导入原子性、schema/体积校验、敏感键确认、预览图限制与快照隔离、seed 幂等与备份。全部使用临时 SQLite，不触碰既有浏览器数据或部署数据库。

## 5. 实现要点

- 每请求独立 SQLite 连接（`BEGIN IMMEDIATE`），WAL，兼容 Python 3.10。
- 草稿存 `items.draft_data`；发布快照写 `revisions`（不可变，含当时名称/描述/分类/排序与预览图引用）。公开读只 JOIN `revisions`。
- 发布/停用同一事务内递增 `catalogVersion`；草稿写操作不递增。
- 请求体按实际流式字节计 2 MiB；`workflow` ≤ 1 MiB；文本字段 ≤ 50 KiB。
- 发布前扫描 workflow 中疑似敏感键名（`api_key`/`token`/`secret`/`password` 等），`detail` 只列**键路径**，需 `acknowledgeSecrets: true` 才放行；不承诺识别任意文本中的秘密，不执行 workflow。
- 会话：不透明随机 Cookie（库中只存 SHA256、可吊销、30 天），CSRF token 会话绑定；登录按 IP + 全局限速（15 分钟窗口）。
- 日志与错误不输出敏感值。

## 6. 未包含 / 已知限制

- 不含 systemd / Nginx / 生产备份流程，见 `deploy/catalog/README.md`。
- 未实现 CORS（同源部署）、无多用户账号、无媒体 API（图片只作为资源预览图）。
- 限速状态存于 SQLite，假设单实例部署。
