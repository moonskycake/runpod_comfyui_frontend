# 项目状态与交接（runpod_comfyui_frontend）

> **状态快照**：2026-11-10 的验收结果，不是实时监控。线上实际状态以服务器为准；本文只描述当时已验证的内容与当时的已知边界。文中数字均为当时实测（测试套件输出、浏览器手工验收），不是估算。

## 1. 项目定位

单仓双部署的 ComfyUI 生图站：

- **前台**：静态单页（Vue 3 Options API + jQuery，**无打包器**，`index.html` 直接引脚本），浏览器直接向 RunPod Serverless 端点发起生图请求。
- **统一资源库**：`catalog_service/`（FastAPI + SQLite WAL 小服务），提供公开只读的模板 / 提示词预设 / 片段，以及 `/admin/` 管理端的草稿、发布、停用。静态站与 API **同源**，`/api/` 反代到本机环回端口。
- **前后端同仓、独立发布**：实际部署在同一台 VPS 上。静态资源由 GitHub Actions 自动发布；后端服务由运维人工受控部署（安装 / 升级 / 回滚）。**后端没有自动发版**，也不应宣称有。

线上入口：`https://runpod.hyxer.top/`（前台）、`https://runpod.hyxer.top/admin/`（管理端，未登录渲染登录页，权限完全由接口判定）。

## 2. 当前版本

| 项 | 值 |
|---|---|
| Git HEAD（本轮文档整理前基线） | `223896609c5a6c353d64113e8637ae05a2443bfe`（`docs(catalog): fix CLI working directory`，`[skip ci]`，不触发静态站发布） |
| 功能提交 | `44b657b99da75f6df79a78e98ed7b78505c360d7`（`Add catalog backend service, admin console and deploy material`） |
| 最后一次静态站发布 | GitHub Actions run `42841396575`，结论 success；线上静态内容对应上面那个功能提交，不是 HEAD |
| 工作区 | 干净（本轮写文档前已确认） |

这三个 SHA / run 号是**快照引用**，不是实时指针：`git rev-parse HEAD` 只能告诉你仓库当前在哪，线上静态目录由 `_rel/current` 软链决定，后端由 `/opt/runpod-catalog/app/current` 软链决定，两者都要在主机上单独核对。

## 3. 已上线（已验证）

**前台生图**：模板选择、占位符、尺寸/种子、正负提示词、片段插入、预设替换、本地收藏（localStorage 元数据 + IndexedDB 图片，图片只在本机）、草稿与结果区；手机 390 px 实测无横向溢出，生成条单层粘底。

**统一资源库（公开只读）**：`template` / `preset` / `snippet` 三类，同源 API `GET /api/catalog`、`GET /api/catalog/{id}`。公开接口只返回 `published` 快照，带 `ETag` + `Cache-Control: no-cache`。

**管理端 `/admin/`**：登录、列表、草稿编辑、显式发布、停用。（「复制到本地」是公共前台的入口，不在管理端。）草稿与发布快照分离：编辑已发布项只推进 `draftRev`，公开端仍取旧快照，显式发布才切换版本；`baseRev` 过期返回 `409` 且服务端内容不被覆盖。停用后公开目录消失、详情 `410`，历史修订保留。所有 `/api/admin/*`（含错误响应）`Cache-Control: no-store`。

**图片（仅预设/片段需要）**：管理员上传走 `/api/admin/items/{id}/preview`，要求会话 + `Origin` + CSRF；输入 ≤ 5 MiB / ≤ 16 MP / 静态 PNG·JPEG·WebP，服务端转正、去元数据后存 WebP（长边 ≤ 480 px、≤ 64 KiB），**不保留原图**。草稿换图不影响已发布的公开旧图，公开图按 `revision` 固定，历史修订可继续读。图片以 BLOB 存 SQLite，随数据库一起备份。细节见 [catalog-api.md](./catalog-api.md)。

**安全**：登录 Cookie `HttpOnly; Secure; SameSite=Strict`；会话 token 只存哈希，CSRF token 绑定会话；登录按 IP + 全局双维度限速；写请求校验会话 → `Origin` → CSRF。前端隐藏按钮不作安全边界。

**片段 / 画师补全三轮修复**：`@` 触发仅限 artist 且带过期候选防护；`no h` / `no_h` 能命中 `no_humans`；画师补全插入时换行前的逗号与 CRLF 均保留。

**生产统一库内容**：初始恰好两个已发布模板 `anima_preview2_lora_v1`、`anima_priview_v1`（由内置模板种子生成，`legacyId` 映射去重）。**没有**把本地 QA 预设/片段或 QA 数据库复制到生产。

## 4. 明确边界（没做，且不是 bug）

- 无访客账号、无个人云同步、无收藏上传；收藏与本地资源只在本机，不上传、不做媒体 API。
- 统一库与本地库**允许同名**，身份以 `source + id` 区分，绝不跨来源覆盖；复制出的本地项内容独立，不自动跟随统一库更新。
- 不做 workflow 执行或 ComfyUI 环境兼容性校验；服务端只做结构校验（未知外层字段拒绝、序列化 ≤ 1 MiB、文本字段 ≤ 50 KiB）。
- 不做 CORS（同源部署）；不抓取远程 URL（无 SSRF 面）。
- 不承诺自动识别任意文本中的秘密：发布前只扫描 workflow 内疑似敏感**键名**并列出键路径，需管理员二次确认。
- 运维入口只有命令行：没有网页改密，也没有默认账号 / 默认口令 / 首启安装页。
- 不改动 RunPod 现服务、模型镜像与生图端点；静态自动部署账号没有 root，后台安装/升级/改密需独立的受控运维操作。

## 5. 后续 TODO（按优先级，均未完成）

首期范围（统一库、管理后台、离线读本地副本、保存草稿、显式发布、`409` 冲突、停用、三种 kind）**已全部完成**；UI 计划则不是：P0 仍缺右栏「结果 / 快捷提示词库」互斥停靠与布局细化（见 [ui-ux-plan.md](./plans/ui-ux-plan.md) 的实现进度表），P1 整段未做。所以这里有两条不同性质的待办：一条是首期 UI 计划未完成的部分，其余是首期范围之外的候选。

- [ ] **P1 UI/UX 剩余项**：右栏「结果 / 快捷提示词库」互斥停靠与布局细化（桌面双栏、手机单列）——UI 计划 P0 尚未全部落地，详见 [ui-ux-plan.md](./plans/ui-ux-plan.md) 的实现进度表。
- [ ] **P2 清理本地验收临时目录**：本轮 preview 已停止、备份与截图已交付、旧 QA 数据保留；清理动作被权限系统阻塞（`requires approval, but no interactive UI is available`），未重试、未绕过。与线上功能无关，详细清单在会话 todo 内，不入公开文档。

### 候选（待定，不是排期内的待办）

以下均已讨论但未批准，不列 checkbox，不要当成已实现或必做项：

- **定时自动备份**：目前只有手工一致性备份（SQLite backup API，`integrity_check=ok`，服务器 `/var/backups/runpod-catalog/` 有一份，异机副本已保存）；cron/systemd timer **尚未配置**。
- **MOSS 集成**、**数据库迁移方案**、**个人云同步**：仅研究候选，批准前不开发。

已做过、**不要重复列为 TODO** 的：模板本地副本、断网后读本地副本、草稿保存、预设替换撤销、片段光标插入。

## 6. 运行与验收命令

在仓库根目录 `frontend/` 执行。前端测试是独立的 Node `assert` 脚本（无需 `npm install`，不用 `node --test`），后端为 pytest。

```bash
# 前端（catalog 24 / admin 19 / autocomplete 70，合计 113；逐个跑）
node tests/catalog.test.js
node tests/catalog-admin.test.js
node tests/autocomplete.test.js

# 后端 API 契约（28 passed）
python -m pytest catalog_service/tests -q

# 部署脚本与打包（Windows 下 25 passed / 10 skipped；另有 14 subtests 已计入用例内，不要叠加成测试数）
python -m pytest deploy/tests/test_deploy.py -q

# 本地联调（QA 用，不部署）
python deploy/catalog/dev_preview.py --repo . --port 8766
# 后端 Origin 必须与浏览器一致：CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766
```

手工验收口径（当时实测项，可复现）：

1. 未登录能浏览统一库并「使用」，统一库项无编辑/删除入口；直接伪造前端管理员标记后写接口仍 `401/403`。
2. 模板 `readonly` 标识与 `loaded` 状态正确；草稿换图并发布后，公众端加载新图；复制到本地的项固定 `sourceRevision`，统一库更新后内容不变。
3. 手机 390 px 无横向滚动；`/admin/` 首屏为登录页。
4. 响应头：公开 catalog/detail `no-cache` + `ETag`；所有 `/api/admin/*` `no-store`。

## 7. 运维文档导航

- 安装 / 升级 / 备份 / 改密 runbook：[deploy/catalog/README.md](../deploy/catalog/README.md)——可重复执行的运维程序，生产已按它部署过一次；它是步骤与验证口令，不是实时健康报告，也不保证重跑就能修复已偏离的状态。
- 服务契约、环境变量表、CLI 用法：[catalog_service/README.md](../catalog_service/README.md)。
- 冻结 API 契约（含图片上传/读取契约）：[docs/catalog-api.md](./catalog-api.md)。
- 静态站发布、网关规则与后端发布通道的边界：[deploy/README.md](../deploy/README.md)。
- 计划稿（界面）：[docs/plans/ui-ux-plan.md](./plans/ui-ux-plan.md)；后台与迁移：[docs/plans/shared-library-backend-plan.md](./plans/shared-library-backend-plan.md)。
- 前端开发约定（无打包器、脚本顺序、代码风格）：[AGENTS.md](../AGENTS.md)。

### 关键运维路径（只列目录与文件角色，不含任何凭据）

| 角色 | 路径 |
|---|---|
| 应用版本目录 | `/opt/runpod-catalog/app/current`（软链到 `app/<version>`） |
| 虚拟环境 | `/opt/runpod-catalog/venv`（跨版本复用，root 拥有） |
| 数据库 | `/var/lib/runpod-catalog/catalog.db`（`runpod-catalog:runpod-catalog 0600`，WAL） |
| 服务单元 | `runpod-catalog.service`，仅监听 `127.0.0.1:8787` |
| 环境文件 | `/etc/runpod-catalog/catalog.env`（`root:root 0600`） |
| 备份目录 | `/var/backups/runpod-catalog/`（`root:root 0700`） |

### 改管理员口令（CLI，无网页改密）

口令哈希只存在于 `/etc/runpod-catalog/catalog.env` 的 `CATALOG_ADMIN_PASSWORD_HASH`，明文只经交互输入，不落盘、不进 argv/日志。新口令**要求至少 12 位**（CLI 不接受更短的值）。

1. 生成新哈希（必须在 `current` 目录下运行，参数与该版本校验逻辑一致）：
   ```bash
   cd /opt/runpod-catalog/app/current
   /opt/runpod-catalog/venv/bin/python -m catalog_service.cli init-admin
   ```
2. 以 root 编辑 env 文件，**只**替换哈希那一行的值（保留 `CATALOG_ADMIN_PASSWORD_HASH=` 键名）。
3. 重启使 `EnvironmentFile` 生效并验证：
   ```bash
   systemctl restart runpod-catalog.service
   systemctl is-active --quiet runpod-catalog.service && echo ACTIVE
   ```
4. 用新口令登录 `/admin/`，确认旧口令已失效。注意：重启**不会**吊销已存在的会话（token 以哈希存库），口令泄露时需另行处理。

未配置 `CATALOG_ADMIN_PASSWORD_HASH` 时登录返回 `503`（这是「无凭据」的预期状态）；哈希**明显格式错误**则在启动时抛 `ConfigError` 直接退出，服务根本没起来。两种情形都不影响已发布内容的读取链路表述——前者仍正常对外服务，后者属配置故障，先修 env 再启动。

### 备份与恢复要点

- 一致性备份走 CLI `backup`（SQLite backup API，包含 WAL 内容与图片 BLOB）；活动数据库直接 `cp` 不算备份。已验证 `PRAGMA integrity_check` 返回 `ok`。
- 备份文件含目录数据与运维元信息，**不要**复制回发布目录或站点根目录；复制一份**离开主机**才算灾备，同机另一目录不算。
- 恢复：停服务 → 用备份替换 `catalog.db`（属主 `runpod-catalog`、`0600`）→ 清理残留 `-wal`/`-shm` → 启服务 → 复查 `/api/catalog` 与一次管理登录。
- 代码回滚：`ln -sfn <上一版本> /opt/runpod-catalog/app/current` 后重启服务；仅当迁移不向后兼容时才回滚数据库（schema 只做加列，本期无破坏性迁移，不保证跨版本任意降级）。
- 升级前必须先备份；升级是独立人工步骤，与静态站 GitHub Actions 发布互不影响。

## 8. 写文档时的口径约定

- 本文声称的事实均有对应验证：测试套件输出、浏览器手工验收、或服务器侧 `curl` / `integrity_check` 观测。未重新跑全量测试或扫站。
- 「已上线」只表示 2026-11-10 当时在生产可见并通过验收；不表示持续监控，也不承诺当前时刻仍如此。
- 后续若要更新本文，请同步修订开头日期与第 2 节版本号，避免出现两份互相矛盾的状态描述。
