# 统一库后台服务（catalog_service）

FastAPI + SQLite（WAL）小服务。契约见 [`../docs/catalog-api.md`](../docs/catalog-api.md)（冻结，字段名不得改）。
本目录只包含服务实现、CLI 与测试；不含部署文件（systemd / Nginx 由部署侧负责），不涉及 RunPod。

## 1. 依赖与运行

Python 3.10+（本机 3.12 已验证）。依赖见 `requirements.txt`（fastapi / uvicorn / httpx / pytest）。

```bash
# 在仓库根目录 frontend/
python -m pip install -r catalog_service/requirements.txt   # 若环境中已有则跳过

# 生成管理员口令哈希（交互输入，密码不落盘、不进日志）
python -m catalog_service.cli init-admin
# 输出形如：scrypt$16384$8$1$<salt>$<digest>
```

服务只监听环回地址，供同源 Nginx 反代（`/api/` → `127.0.0.1:8787`）：

```bash
set CATALOG_PUBLIC_ORIGIN=https://example.com     # 必填，精确 Origin，唯一可信来源
set CATALOG_DB_PATH=D:/tmp/run-20261110-catalog/catalog.db
set CATALOG_ADMIN_PASSWORD_HASH=scrypt$16384$8$1$...   # init-admin 输出，不要把明文写进环境文件
set CATALOG_PORT=8787
python -m catalog_service
```

或用 app 工厂（便于 uvicorn 直接托管）：

```bash
python -m uvicorn catalog_service.app:build_from_env --factory --host 127.0.0.1 --port 8787
```

`CATALOG_PUBLIC_ORIGIN` / `CATALOG_DB_PATH` 缺失时进程直接报配置错误退出（不半配置启动）。
`python -m catalog_service` 会拒绝非环回 `CATALOG_HOST`；默认端口 8787，本项目 Nginx 反代与本服务统一使用 **8787**（与 `__main__` 默认一致）。本地静态站 origin 为 `http://127.0.0.1:8766`。

本地 QA 用的口令哈希请用 `init-admin` 现生成（交互输入），不要把任何生产口令或哈希写进仓库文件。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CATALOG_PUBLIC_ORIGIN` | 是 | 精确同源 Origin（如 `https://example.com` 或 `http://127.0.0.1:8766`）。只接受 scheme+host[:port]，带路径会配置报错。请求 `Host` / `X-Forwarded-Host` 永不用于校验。 |
| `CATALOG_DB_PATH` | 是 | SQLite 文件路径。启动只建表，**不会自动种子**。 |
| `CATALOG_ADMIN_PASSWORD_HASH` | 生产必填 | `init-admin` 生成的 scrypt 哈希。缺失时 `/api/admin/login` 返回 503。无默认口令。 |
| `CATALOG_COOKIE_SECURE` | 否，默认 `true` | 生产保持 true。仅本地 HTTP 调试可显式设 `false`（此时仍 HttpOnly + SameSite=Strict + Path=/api/admin）。 |
| `CATALOG_HOST` | 否，默认 `127.0.0.1` | `python -m catalog_service` 的监听地址，只允许环回。 |
| `CATALOG_PORT` | 否，默认 `8787` | 监听端口。本地服务统一使用 **8787**（Nginx/deploy 已固定 8787，与 `__main__` 默认一致）。 |

### 本地 QA 启动配方（HTTP 本地，不碰生产）

```bash
mkdir D:/tmp/run-20261110-catalog
set CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766
set CATALOG_DB_PATH=D:/tmp/run-20261110-catalog/catalog.db
set CATALOG_COOKIE_SECURE=false
set CATALOG_ADMIN_PASSWORD_HASH=<init-admin 输出>
set CATALOG_PORT=8787
python -m catalog_service
# 另一个终端（静态站与 API 同源时用 Nginx；纯接口验收直接请求 8787）
curl -s http://127.0.0.1:8787/api/catalog
```

本地站点若跑在 `http://127.0.0.1:8000`，则 `CATALOG_PUBLIC_ORIGIN` 必须写完全一致的 `http://127.0.0.1:8000`（Origin 精确匹配，`localhost` 与 `127.0.0.1` 视为不同源）。

## 2. CLI

```bash
# 交互式生成口令哈希（两次输入，明文不保存）
python -m catalog_service.cli init-admin

# 种子：可信 JSON 列表，幂等，不覆盖管理员编辑
python -m catalog_service.cli --db <db路径> seed seeds.json

# 备份：SQLite backup API（一致性副本，含 WAL 内容）
python -m catalog_service.cli --db <db路径> backup D:/tmp/run-20261110-catalog/backup.db
```

`--db` 省略时读 `CATALOG_DB_PATH`。

### seed 文件格式（JSON 数组）

```json
[
  {
    "kind": "template",
    "legacyId": "anima_priview_v1",
    "name": "anima_priview_v1",
    "description": "内置模板",
    "category": "builtin",
    "order": 10,
    "data": {"schemaVersion": 2, "workflow": {}, "defaults": {}, "editor": {}}
  }
]
```

- `legacyId` 可选；有值时 `shared:<uuid5>` ID 由 `kind + legacyId` 确定性推导，重复种子只会增加 `skipped`，不会覆盖已有条目或管理员编辑。
- 条目以 `draft` 落库，**不会自动公开**。
- 生成内置模板种子（浏览器控制台，打开静态站后执行）：

```js
copy(JSON.stringify(BuiltinTemplates.map(t => ({
  kind: 'template', legacyId: t.id, name: t.name, description: t.description,
  category: 'builtin', order: 10,
  data: { schemaVersion: t.schemaVersion, workflow: t.workflow, defaults: t.defaults, editor: t.editor }
})), null, 2))
```

两个内置模板（`anima_priview_v1`、`anima_preview2_lora_v1`）的 workflow 体积大，仓库内不复制一份，避免与 `js/builtin-templates.js` 漂移。种子后仍需管理员在 `/admin/` 显式发布才会公开。

## 3. 测试

```bash
python -m pytest catalog_service/tests -q
```

15 个 ASGI 端到端用例，覆盖：未登录/伪造头、Origin/CSRF、登录登出与限速、草稿不泄漏（含发布后编辑）、409 冲突、停用/恢复、导入原子性、schema/体积校验、敏感键确认、seed 幂等与备份。
全部使用临时 SQLite 数据库，不触碰任何既有浏览器数据或部署数据库。

## 4. 实现要点

- 每请求独立 SQLite 连接（`BEGIN IMMEDIATE` 事务），WAL 模式，兼容 Python 3.10（未使用 3.12 新 API）。
- 草稿存 `items.draft_data`；发布快照写 `revisions`（不可变，含当时的名称/描述/分类/排序）。公开读只 JOIN `revisions`，编辑已发布项不进公共接口。
- 发布/停用同一事务内递增 `catalogVersion`；草稿写操作不递增。
- 请求体按实际流式字节计 2 MiB；`workflow` ≤ 1 MiB；文本字段 ≤ 50 KiB。
- 发布前扫描 workflow 中疑似敏感键名（`api_key`/`token`/`secret`/`password` 等），在错误 `detail` 里列出**键路径**，不回显值；需 `acknowledgeSecrets: true` 才能发布。不承诺识别任意文本中的秘密，不执行 workflow。
- 会话：不透明随机 Cookie（SHA256 存库、可吊销、30 天），CSRF token 会话绑定；登录按 IP + 全局限速，登录失败记录 15 分钟窗口。
- 日志与错误不输出敏感值；服务端无硬编码 token。

## 5. 未包含 / 已知限制

- 部署文件（systemd、Nginx、发布脚本）由其他 agent 负责，本目录不含。
- 未实现 CORS（同源部署）、无图片/媒体接口、无多用户账号。
- 进程内限速存储于 SQLite；单实例部署假设，多实例需外部共享存储。
