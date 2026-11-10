# 统一库 API（冻结契约）

状态：**冻结**。服务实现位于 `catalog_service/`，本文是实现与前端共同遵守的契约。
修改契约必须由协调者批准；实现若发现契约缺口，先在这里记录偏差。

## 1. 基本约定

- 部署形态：同源（same-site）。静态站 `/`，API 反代到本机 `127.0.0.1` 上的 FastAPI 服务，管理页固定 `/admin/`。
- 唯一资源类型 `kind`：`template`（工作流模板） | `preset`（正负提示词预设） | `snippet`（片段）。
- 统一库 ID：`shared:<uuid>`。本地 ID（`local:<uuid>`）只存在于前端 localStorage，服务端不感知。
- 时间戳一律 ISO 8601 UTC，形如 `2026-11-10T04:05:06Z`。
- 错误响应统一 JSON：`{"detail": string, "current"?: admin item}`。错误体不含任何敏感值。
- `order` 为整数；`category` / `description` 可为空字符串。

## 2. 实体

### 2.1 公共元数据（metadata）

```json
{
  "id": "shared:4f8c...",
  "kind": "template",
  "name": "人像基础",
  "description": "",
  "category": "portrait",
  "order": 10,
  "publishedRevision": 3,
  "preview": {"url": "/api/catalog/shared:4f8c.../preview?revision=3", "width": 480, "height": 320, "bytes": 41234, "mime": "image/webp"},
  "updatedAt": "2026-11-10T04:05:06Z",
  "legacyId": "anima_priview_v1"
}
```

`legacyId` 仅在存在旧 ID 映射时出现（种入的内置模板）。`updatedAt` 在公共接口中是**发布快照时间**，在管理接口中是条目最后修改时间。

### 2.2 内容 payload（`data`）

- `template`：`{"schemaVersion": 2, "workflow": {...}, "defaults": {...}, "editor": {...}}`

  外层只允许这四个键（未知外层键拒绝，不静默丢弃）；`workflow` / `defaults` / `editor` 必须是 JSON 对象；`workflow` 内部节点与扩展字段原样保留，服务端**不执行** workflow。占位符定义沿用现有内置模板结构放在 `editor` 内。

- `preset`：`{"positive": string, "negative": string}`（一组正负提示词）。
- `snippet`：`{"text": string, "target": "positive" | "negative"}`。

### 2.3 管理条目（admin item）

```json
{
  "id": "shared:4f8c...",
  "kind": "template",
  "name": "人像基础",
  "description": "",
  "category": "portrait",
  "order": 10,
  "status": "draft",
  "draftRev": 2,
  "publishedRevision": null,
  "hasUnpublishedChanges": true,
  "data": {"schemaVersion": 2, "workflow": {}, "defaults": {}, "editor": {}},
  "legacyId": "anima_priview_v1",
  "createdAt": "2026-11-10T04:05:06Z",
  "updatedAt": "2026-11-10T04:05:06Z"
}
```

- `status`: `draft` | `published` | `disabled`。
- `draftRev`：草稿当前修订号，每次成功的编辑/创建为 1，之后每编辑一次 +1。
- `publishedRevision`: `null` 或已发布快照的修订号。
- `hasUnpublishedChanges` = `publishedRevision is null or draftRev != publishedRevision`。
- `data` 始终是**当前草稿**内容（管理接口专用，绝不出现在公共接口）。

### 2.4 预览图（`preview`）

`preview` 是**响应字段**，`null` 或：

```json
{"url": "/api/catalog/{id}/preview?revision=N", "width": 480, "height": 320, "bytes": 41234, "mime": "image/webp"}
```

- 只有 `preset` / `snippet` 需要预览图；`template` 不要求。预览图由管理员上传，**匿名不可写**。
- 公共 metadata / 公共详情里的 `preview` 来自**发布快照**，`url` 固定为 `/api/catalog/{id}/preview?revision={publishedRevision}`；管理条目的 `preview` 来自**草稿**，`url` 固定为 `/api/admin/items/{id}/preview?rev={previewRev}`。
- `preview` 绝不出现在 create / PATCH / import 请求体里（出现即 `400`，未知字段规则）。上传/清除只经专用接口，不改 `data`。
- 存储统一为 WebP（`mime` 恒为 `image/webp`），长边 ≤ 480 px、输出 ≤ 64 KiB；不保留上传原图、原文件名、路径或外链。
- `bytes` 是压缩后字节数；`width`/`height` 是压缩后像素尺寸。

## 3. 公共接口（无需认证，只读）

### GET /api/catalog

`200`：

```json
{"catalogVersion": 7, "items": [metadata, ...]}
```

只含 `status = published` 的条目，按 `kind`、`order`、`name` 排序。响应带 `ETag` 与 `Cache-Control: no-cache`；`If-None-Match` 命中返回 `304`。

### GET /api/catalog/{id}

- `200`：`{...metadata, "data": payload}`（仅发布快照）。
- 仅草稿 / 不存在：`404`。已停用：`410`。
- 响应带基于发布快照内容哈希的 `ETag` 与 `Cache-Control: no-cache`。

### GET /api/catalog/{id}/preview?revision=N

- 只服务**发布快照及其历史修订**；`revision` 必须精确命中该条目已发布的某个修订号，否则 `404`（草稿图永不返回，也不冒充新版）。省略 `revision` 时取当前 `publishedRevision`。
- `200`：`Content-Type: image/webp`、`X-Content-Type-Options: nosniff`、基于资源哈希的 `ETag`、`Cache-Control: no-cache`（可重验证，命中 `304`）。
- 条目不存在 `404`；条目已停用 `410`；该修订无预览图 `404`；`revision` 非正整数 `400`。

`catalogVersion` 为整数，仅在发布/停用成功时事务性递增（草稿写操作不递增）。

## 4. 会话接口

### POST /api/admin/login

请求 `{"password": string}`。必须带正确的 `Origin`（精确匹配 `CATALOG_PUBLIC_ORIGIN`），**不需要** CSRF 头。

`200`：`{"authenticated": true, "csrfToken": "...", "expiresAt": "..."}`，同时下发不透明会话 Cookie：
`rp_catalog_session=<random>; HttpOnly; Secure; SameSite=Strict; Path=/api/admin`（`CATALOG_COOKIE_SECURE=false` 时省略 `Secure`，仅本地调试）。服务端只存会话 token 的 SHA256。

失败：密码错 `401`；`Origin` 缺失或错误 `403`；超出限速（按 IP + 全局双维度）`429`；未配置管理员口令哈希 `503`。

### GET /api/admin/session

已登录 `200` 返回与登录相同的 `{"authenticated": true, "csrfToken", "expiresAt"}`；否则 `401 {"detail": "..."}`。

### POST /api/admin/logout

需要会话 + CSRF + Origin。`200 {"authenticated": false}`，服务端吊销会话并清除 Cookie。

### 写请求要求

除 `login` 外的所有 `/api/admin` 写请求（`POST` / `PATCH` / `DELETE`）必须同时满足：

1. 有效会话（否则 `401`）；
2. `Origin` 与 `CATALOG_PUBLIC_ORIGIN` 精确相等（否则 `403`）；
3. `X-CSRF-Token` 与该会话的 CSRF token 相等（否则 `403`）。

校验顺序：会话 → Origin → CSRF。伪造 Cookie 或伪造 `X-CSRF-Token` 均为 `401` / `403`，无法只靠前端隐藏按钮取得权限。

## 5. 管理接口（全部 `Cache-Control: no-store`，含错误响应）

### GET /api/admin/items?kind=&status=

`200 {"items": [admin item, ...]}`。`kind`、`status` 可选过滤。

### GET /api/admin/items/{id}

`200` admin item；不存在 `404`。

### POST /api/admin/items

请求 `{kind, name, description?, category?, order?, data}`（未知顶层字段拒绝）。
`201` admin item（`status=draft`，`draftRev=1`）。ID 由服务端生成。

### PATCH /api/admin/items/{id}

请求可含 `name`、`description`、`category`、`order`、`data`，以及**必填** `baseRev`；`kind` 不可改（出现 `kind` 视为未知字段 → `400`）。
`200` 更新后的 admin item（`draftRev + 1`，`updatedAt` 刷新）。`baseRev != draftRev` 或 `kind` 变更尝试：`409`，带 `current` 当前条目，**服务端内容不被覆盖**。

编辑已发布条目只推进 `draftRev`，旧发布快照与公共接口内容保持不变。

### POST /api/admin/items/{id}/publish

请求 `{baseRev, acknowledgeSecrets?: boolean}`。
`200` admin item：写入不可变发布快照，`status=published`，`publishedRevision=draftRev`，`catalogVersion + 1`（同一事务）。
`409`：`baseRev` 过期（带 `current`）。
发布前扫描 workflow 中疑似敏感键名（`api_key` / `token` / `secret` / `password` / `credential` / `authorization` 等，大小写不敏感）。命中且未带 `acknowledgeSecrets: true` 时返回 `400`，`detail` 中列出**键路径**（如 `workflow.12.inputs.api_key`），绝不回显键值。
不承诺自动识别任意文本中的秘密；不执行 workflow。已发布条目再次发布时若 `publishedRevision == draftRev` 且快照存在，只恢复发布状态。

### POST /api/admin/items/{id}/disable

请求 `{baseRev}`。`200` admin item（`status=disabled`），`catalogVersion + 1`。`409` 处理同 publish。
停用后公共目录不含该条，公共详情 `410`；旧发布快照保留以便重新发布。

### DELETE /api/admin/items/{id}?baseRev=N

仅允许**从未发布**（`publishedRevision is null`）的草稿。`204`。其他情况 `409`（已发布/停用条目只能停用，不删历史修订）；`baseRev` 不匹配 `409`。

### POST /api/admin/import

请求 `{"items": [create 形状对象, ...]}`，1–100 条，**全有或全无**。
`201 {"items": [admin item, ...]}`，全部为 `draft`。任一校验失败则整批不落库（`400`）。

### 预览图上传 / 清除 / 读取

`POST /api/admin/items/{id}/preview?baseRev=N`

- 请求体是**原始二进制图片**（不是 JSON、不是 multipart）；`Content-Type` 只接受 `image/png` / `image/jpeg` / `image/webp`（也接受 `application/octet-stream`，一律按内容嗅探最终判定）。
- 服务端解码校验后压缩为 WebP 保存，**不保留原图**。
- `200` 更新后的 admin item：`preview` 已指向新图，`draftRev + 1`，`publishedRevision` 不变（**不自动发布**）。
- `baseRev != draftRev`：`409` 带 `current`，且不落任何图片数据（无孤儿 BLOB）。
- 图片不合格（非静态 PNG/JPEG/WebP、动画、伪图/坏图、>16 MP、解压炸弹）：`400`，`detail` 只描述原因、不回显内容。
- 超过 5 MiB：`413`。
- 新建条目必须先保存草稿再上传（创建响应里拿 `draftRev` 作为 `baseRev`）；上传不影响当前已发布图片。

`DELETE /api/admin/items/{id}/preview?baseRev=N`

- `200` 更新后的 admin item：草稿 `preview` 变为 `null`，`draftRev + 1`；已发布快照的图保持不变。
- 草稿本来就无图时幂等返回当前条目（不推进 `draftRev`）；`baseRev` 过期 `409`。

`GET /api/admin/items/{id}/preview?rev=N`

- 需要会话（`401`）；响应 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`ETag`；可 `304`。
- `rev` 必须等于该草稿图绑定的 `previewRev`（即 admin item 里 `preview.url` 的 `rev`），否则 `404`（旧链接不会返回新图）。

## 6. 校验与限制

- 请求体实际流式读取上限 **2 MiB**（不只看 `Content-Length`），超出 `413`。
- `workflow` 序列化 ≤ **1 MiB**；文本类字段（正/负提示词、片段文本）各 ≤ **50 KiB**（UTF-8 字节）。
- `name` 1–120 字符且非空白；`description` ≤ 2000 字符；`category` ≤ 80 字符；`order` 整数。
- 未知顶层字段（create / patch / import / payload）一律 `400`，不静默丢弃。
- 文本字段原样存储，但一律按纯文本渲染（前端禁 `v-html`）。服务端不接受 `apiKey` / `endpoint` 等本地设置字段进入目录。
- 预览图（独立于 2 MiB 上限，仅 `*/preview` 路径）：输入 ≤ **5 MiB**、≤ **16 MP**，只接受静态 PNG / JPEG / WebP；拒绝 SVG / GIF / 动画 / 伪图 / 坏图 / 解压炸弹；上限按实际流式字节数计数（404/413 均为受控 JSON 错误）。
- 输出：WebP、长边 ≤ 480 px、≤ **64 KiB**；上传的 EXIF/ICC/XMP 在重编码时丢弃，EXIF 方向会被转正。服务端不做远程 URL 抓取（无 SSRF 面），不执行 workflow。

## 7. 缓存与安全头

| 接口 | 头 |
|---|---|
| `GET /api/catalog`、`GET /api/catalog/{id}`、`GET /api/catalog/{id}/preview` | `ETag` + `Cache-Control: no-cache`（可重验证，命中 `304`） |
| 所有 `/api/admin/*`（含 401/403/409/400、含 `GET .../preview`） | `Cache-Control: no-store` |
| 图片响应（公共与管理） | 另加 `X-Content-Type-Options: nosniff` |

## 8. 实现备注 / 已知偏差

- 实现：`catalog_service/`（FastAPI + SQLite WAL，每请求独立连接，兼容 Python 3.10+）。
- 会话 CSRF token 以明文存于会话表（会话绑定、非登录凭据）；会话 token 只存 SHA256。
- 登录失败尝试记录在 `login_attempts`：同一 IP 15 分钟内 ≥5 次或全局 ≥50 次返回 `429`。
- `GET /api/admin/session` 未登录返回 `401 {"detail": "..."}`（契约仅规定状态码）。
- 发布敏感键命中时，键路径放在 `detail` 字符串中（契约错误体固定为 `{detail, current?}`），前端直接展示即可。
- 未实现 CORS（同源部署）；自动种子仍不启用，种子只经 CLI `seed`。
- 预览图存储：`preview_assets(id = sha256, mime, width, height, bytes, data BLOB)`，**按压缩后 SHA256 去重**（相同图多条目共用一个 BLOB）；`items` 存草稿工况（`preview_id` / `preview_rev` / 尺寸/字节/mime），`revisions` 存不可变发布快照的 `preview_id` 与尺寸/字节/mime。发布时把草稿工况复制进快照，因此改草稿图不影响已发布图；历史修订按 `revision` 独立可读。
- 无图路径、原文件名、外链与本地孤儿文件：图片只存 BLOB；`DELETE` 预览与删除草稿条目会清理无引用资产。SQLite 备份（CLI `backup`，SQLite backup API）完整包含图片数据。
- 迁移为纯追加列（`items` / `revisions` 的 `preview_*` + 新表 `preview_assets`）：旧库、旧无图资源、`seed` / `import` 完全兼容，缺省 `preview` 为 `null`。
- 依赖：`Pillow>=11.1,<13`（`catalog_service/requirements.txt`）。
- 数据结构里没有 `placeholders` 独立字段：沿用现有内置模板的 `editor` 内占位符定义，与冻结契约一致。
- 发布快照除 `data` 外同时固化当时的 `name/description/category/order`，因此发布后改名/改分类也不会出现在公共接口，只有发布才切换。
- 本地 QA：`CATALOG_COOKIE_SECURE=false` + `CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766` + 端口 8787（Origin 精确匹配，注意 `localhost` 与 `127.0.0.1` 不同源）。启动方式与 CLI 用法见 `catalog_service/README.md`。
