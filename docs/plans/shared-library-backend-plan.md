# 统一库后台实施计划（技术 / 迁移 / 发布）

基线：`frontend` @ `fa60856`。范围：生图页公开、`/admin/` 私有；后台统一管理工作流模板、提示词预设（正负一组）、片段。访客只读已发布的统一库，可复制到本地使用；本地自建资源只存本地、不自动上传。图片收藏本期不变（localStorage 元数据 + IndexedDB 二进制），不上传、不做媒体 API / 私有云同步。

## 0. 实现进度（截至 2026-11-10，非实时）

**结论：核心首期已落地并在生产运行；逐条偏差与验收范围见下表。** 正文其余部分保留为设计与落点依据，不再逐条改写。

| 计划条款 | 状态 |
|---|---|
| §1 部署形态：单域名、`/admin/` 固定入口、`/api/` 反代环回、FastAPI + SQLite WAL + venv + systemd | 已实现。生产为 `app/current` + `/opt/runpod-catalog/venv` + `runpod-catalog.service`（仅 `127.0.0.1:8787`），Nginx 同源反代 |
| §1 后端独立受控发布、无自动发版 | 已实现（且无变化）。静态站走 GitHub Actions，后台靠人工 root 步骤，见 `deploy/catalog/README.md` |
| §2 `shared:` / `local:` 复合键、允许同名、不跨来源覆盖 | 已实现 |
| §2 `draft / published / disabled` + `draftRev` / `publishedRevision` / `hasUnpublishedChanges` | 已实现；编辑已发布项只推进 `draftRev`，公开端仍取旧快照 |
| §2 公开详情：仅草稿 404、已停用 410 | 已实现 |
| §3 最小 API 集（公开 / 会话 / 管理读 / 草稿写 / 发布 / 停用） | 已实现，契约冻结在 `docs/catalog-api.md` |
| §3 catalog `ETag` + `no-cache`；admin 全量 `no-store`（含错误响应） | 已实现并在生产响应头复核 |
| §4 三类内容 schema、未知外层字段拒绝、序列化 ≤1 MB、文本 ≤50 KB | 已实现 |
| §4 `scrypt` 口令哈希、`Secure; HttpOnly; SameSite=Strict`、token 只存哈希、双维度限速、`Origin` + CSRF 校验 | 已实现 |
| §4 敏感键名提示（不承诺自动识别任意文本秘密） | 已实现，口径未放宽 |
| §5 首次建库用两个内置模板作种子、`legacyId` 映射去重 | 已实现。生产恰好两个已发布模板 `anima_preview2_lora_v1`、`anima_priview_v1`（均为 v1）；未把本地 QA 预设/片段或 QA 库搬到生产 |
| §5 备份走 SQLite backup API、备份需异机 | 已实现（手工）。`PRAGMA integrity_check=ok`，服务器与异机各一份。**定时自动备份未配置**，属候选待决 |
| §6 `pack_frontend.py` 白名单加 `admin.html`、多 HTML 重写、Nginx `/admin` 与 `/api/` 段 | 已实现（`WHITELIST_FILES`/`HTML_ENTRIES`/`NESTED_HTML_ENTRIES` 均在，`admin.html` 资源重写为根绝对路径） |
| §6 前端与后端独立发布、数据库在版本目录之外、不动 RunPod 镜像/端点 | 已实现 |
| §7 B1–B4（骨架 / 修订与发布 / 白名单与重写 / 联调备份回滚） | 首期核心闭环已交付；生产备份已做，但**回滚与恢复演练未完成**（见 §8 行 8） |
| §8 关键验收 1–8 | 1–7 已实测通过（不含付费生图）；8 **未完成**：旧版目录与切换指针保留、回滚/恢复程序已写入 runbook，但未执行过完整的生产回滚或备份恢复演练 |

后续未完成 / 未批准，不在本期：原「私有双向同步」被「统一库 + 本地库」取代，不再排期；个人云同步、MOSS 集成、平台迁移均未批准，不列为待办。定时备份见上表。

本文其余部分（§1–§8 正文与代码证据）保持设计原貌；如需修订接口契约请改 `docs/catalog-api.md`（已冻结），运维步骤请改 `deploy/catalog/README.md`。

## 1. 部署形态

单域名：`/` 为现有静态站（GitHub Actions 发布），管理入口**固定 `/admin/`**：Nginx 将 `/admin/` 映射到现有 current 发布指针所指版本内的 `admin.html`；入口不重定向到固定 SHA，后续发布自动跟随 current，无需每次修改 Nginx。`/admin` 永久重定向到 `/admin/`；该 HTML 响应 `Cache-Control: no-cache`，其引用的 js/css 仍走 `_rel/<sha40>/` 不可变缓存。未登录打开 `/admin/` 只显示登录页（前端路由 + 接口 401 双层）。前台设置菜单可放一个"管理员登录"入口指向 `/admin/`，安全只靠接口鉴权，前端显隐不作边界。

`/api/` 反代到同机一个小服务。选型固定：**FastAPI + SQLite（WAL）+ 独立 venv + systemd unit + Nginx 反代**；无 Redis、无 Worker、无多租户、无队列。

Admin UI 与公开资源列表共用同一实体与同一套字段，只有可见性不同：公共 `GET` 只返回 `published` 内容；任何写操作（含发布/停用）必须管理员会话。前端 `localStorage` 里的"管理员标识"只是本地 UI 状态，不作安全措施。

## 2. 命名空间与本地副本

- 统一库 ID `shared:<uuid>`，本地 `local:<uuid>`。**允许同名**，身份以 `source` + `id` 复合键判定，两库互不覆盖。
- 旧 `builtin_*` / `user_*` ID 建映射表 `{legacyId, source, newId, migratedAt}`，保留可追溯；**不重写已存历史快照**（旧记录里的 templateId 原样保存，读取时经映射解析）。
- 本地副本字段 `sourceId`、`sourceRevision`；**内容独立**，后台更新不自动跟随。
- 状态 `draft / published / disabled`。每项含 `draftRev`（草稿当前修订号）、`publishedRevision`（线上快照指向的修订号）、`hasUnpublishedChanges`（语义：`draftRev != publishedRevision`）。编辑已发布项并保存只推进 `draftRev`，公开详情仍返回旧发布快照；后台列表显示"已发布 vN · 有未发布修改"。
- 发布写不可变修订并令 `publishedRevision = draftRev`；发布/停用递增 `catalogVersion`。
- 公开详情对仅草稿项返回 404、对已停用项返回 410，**不能凭猜中 ID 读到草稿**。
- 移除/停用不远程删除任何人的本地副本、草稿或旧任务历史；明确不承诺召回已下载的公开内容。

## 3. 最小 API 集

| 类别 | 接口 |
|---|---|
| 公开 | `GET /api/catalog`（版本 + 元数据列表）、`GET /api/catalog/{id}`（按需详情，仅 published） |
| 会话 | `POST /api/admin/login`、`POST /api/admin/logout`、`GET /api/admin/session` |
| 管理读 | `GET /api/admin/items?status=`、`GET /api/admin/items/{id}`（编辑页用，含草稿与双修订号） |
| 草稿写 | `POST /api/admin/items`、`PATCH /api/admin/items/{id}`（带 `baseRev`）、`DELETE /api/admin/items/{id}`（仅未发布草稿；已发布项只能停用，不硬删历史修订）、`POST /api/admin/import` |
| 发布 | `POST /api/admin/items/{id}/publish`、`POST /api/admin/items/{id}/disable` |

目录列表只给元数据（id、名称、分类、排序、类型、catalogVersion、publishedRevision），避免把所有完整 workflow 打成巨型 JSON。

缓存：公共 catalog 与公开详情返回 `ETag` + `Cache-Control: no-cache`（可重验证）；admin 全部 `no-store`。前台打开"资源库"时比对 `catalogVersion`，有变化只更新列表，**不覆盖当前正在编辑的副本**，不做后台轮询强制替换。

## 4. 内容 schema 与安全底线

- `template`：`workflow`(对象)、`defaults`、`placeholders`、`editor`、`name/description/category/order`。
- `preset`：`positive`、`negative` 文本（一组）。`snippet`：`target`（positive/negative）、`text`、`order`。
- 校验只做：未知**外层**字段固定拒绝（不静默丢弃）；`workflow` 必须可解析为对象且内部节点/扩展字段**原样保留**；序列化 ≤1MB；占位符与 `defaults`/`placeholders` 一致性；`name` ≤120 字符、文本字段 ≤50KB、`order` 为整数。**不执行 workflow，不声称验证各 Comfy 环境兼容性**。
- 渲染一律文本插值/转义，禁止 `v-html`（含名称、描述、预设文本、片段）。
- 密钥：不把应用的 RunPod API Key 与私密配置写入目录或任何响应；发布前对 workflow 内疑似敏感字段（`api_key/token/secret/password` 等键名）做检查并要求管理员确认；**不承诺自动识别任意文本中的秘密**。
- 会话：口令哈希用 `scrypt`（或 argon2），Cookie `Secure; HttpOnly; SameSite=Strict`，30 天过期 + 服务端可吊销；登录按 IP + 全局双维度限速；写请求校验 `Origin`/`Referer` 同源并要求自定义头（CSRF）。**不使用自制 http.server 认证**。

## 5. 迁移与数据保全

- 旧 `comfyui_templates`（localStorage）与本地预设/片段保持本地，**不自动上行**；管理员可显式"导入 JSON"成 `draft`，导入不立即公开。同一 `shared` ID 冲突二选一：带 `baseRev` 覆盖，或另存为新资源。
- 预设目前无导出入口，需补导出/导入 JSON 作迁移手段。
- 一期本地副本与统一库的交互只有"**重新复制为新本地项**"，不做差异比较、不做自动 merge（手动"重新拉取 + 差异比较"归 P1 之后进阶，另算）。
- 首次建库以现有两个内置模板（`js/builtin-templates.js`）为种子生成 `shared` 资源，并与内置 ID 建映射去重；内置模板仍作离线只读 fallback 保留。
- 备份：一致性备份走 SQLite backup API，另导出资源 JSON，至少一份异机或用户手动下载。**同机另一目录不构成灾备**。资源不含图片，容量预期很小，上线前仍须核对 VPS 可用盘。
- 后端升级前先备份；回滚用上一版代码 + 同一数据库文件，**数据库 schema 保持与上一服务版本兼容**，不保证任意跨版本降级；破坏性迁移不在本期。前端旧版客户端必须继续可用（不删旧响应字段）。

## 6. 前端接入与发布

入口固定为独立 `admin.html` 文件、线上路径 `/admin/`。要做的显式改动：

1. `deploy/pack_frontend.py` 的 `WHITELIST_FILES` 增加 `admin.html`；其引用的资源必须落在 `WHITELIST_DIRS`（`js/`、`css/`）内。
2. `rewrite_index_html` 只处理单一 HTML，需扩展为对白名单内每个 HTML 重写 `./` 资源属性；未打包路径仍 `PackError`。
3. Nginx 增加 `/admin` → `/admin/` 重定向、`/admin/` 映射到 `current` release 的 `admin.html`，并对该 HTML 给 `no-cache`；静态资源继续走 `_rel/<sha40>/` 不可变缓存。

不能假设"把文件放进 `js/` 就自动支持新 HTML 入口"：入口文件必须进白名单并配套重写。

前端仍由 GitHub Actions 自动发布；后端独立受控发布与回滚；数据库在版本发布目录之外。绝不改 RunPod 镜像或端点。

## 7. 阶段与工作量

| 阶段 | 内容（不含界面搭建） | 人日 |
|---|---|---|
| B1 | 服务骨架、SQLite schema、会话/限速、systemd + Nginx 入口 | 1–2 |
| B2 | 草稿 CRUD、`draftRev`/`publishedRevision`、发布快照/停用、catalog ETag | 1–2 |
| B3 | 数据适配、旧 ID 映射、打包白名单与 HTML 重写 | 0.5–1 |
| B4 | 联调、备份、回滚演练 | 0.5–1 |

核心后台 2–4 人日 + 接入迁移 1–2 人日 ≈ 3–6 人日；B1–B4 **不含** admin 页与资源库界面（由 `ui-ux-plan.md` 的 5–8 人日覆盖，不重复相加）。首期合计估算 **8–14 人日**；P1 进阶（重新拉取 + 差异比较、导入导出增强）另算。

## 8. 关键验收（只列步骤）

1. 未登录：`GET /api/catalog` 200；`POST /api/admin/items` 401/403。
2. 前端伪造管理员 localStorage 标识后，写操作与 `GET /api/admin/*` 仍 401。
3. 两种情形都不外泄：新建草稿、以及已发布项保存后的未发布修改，在公共 catalog 与公开详情中均不可见（返回旧快照或 404/410）。
4. 同一资源用旧 `baseRev` 提交返回 409，且服务端内容未被覆盖。
5. 停用已发布资源后公开目录消失，但本地副本与旧任务历史仍可用；本地对 `shared` 内容的改动无法提交。
6. 断网后前台可读本地副本；联网刷新不覆盖正在编辑的副本，仅提示版本变化。
7. 用 mock 响应 + 请求构建回归验证旧客户端链路（出图请求体、轮询、结果解析），不要求本轮实际付费生图。
8. 后端回滚到上一服务版本后同一数据库可用、数据与资源不丢（schema 兼容上一版本，不保证任意降级）；备份文件可在异机恢复。

相关计划：`ui-ux-plan.md`（UI/UX，界面与交互）。当前两份计划均为纯文档，不运行测试、不访问服务器、不改代码与配置。

---

代码证据（基线 `fa60856`）：

- `js/history-store.js:11-19`：`runpod_favorites_v1` 元数据在 localStorage，`LIMITS.maxFavorites=50`；`DB.imageStore` 为 IndexedDB 图片库（本期不动）。
- `js/history-store.js:112-131`：收藏仅存 `requestId/requestTemplateId/placeholderValues` 等引用字段，图片本体在 IndexedDB。
- `js/main.js:4267-4340`：`toggleFavorite` 写收藏并把整图 `putImages`，图片只有本地一份。
- `js/templates.js:14,44-58,96-120`：`comfyui_templates` 存用户模板；`add/update/delete` 无 revision 概念，需新增 rev 与 `sourceId`。
- `js/builtin-templates.js:12,16,29`：内置模板 `schemaVersion:2` + `defaults` + `editor`，与统一库模板 schema 对齐。
- `deploy/pack_frontend.py:36-41`：`WHITELIST_FILES=("index.html","favicon.ico")`、`WHITELIST_DIRS`，新 HTML 入口必须显式加入。
- `deploy/pack_frontend.py:104-127`：资源属性重写仅作用于传入的单一 HTML 文本，多入口需扩展调用点。
- `deploy/README.md:9-10,30`：gateway 白名单与 `_rel/<sha40>/` 不可变发布、`/tags/` 不硬缓存，管理入口沿用同规则。
