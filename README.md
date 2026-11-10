# runpod_comfyui_frontend

ComfyUI 生图站的单仓双部署项目。本文件面向**换一台机器继续开发**：怎么把环境跑起来、哪些数据不会自动跟着走、以及当前实现与边界。

- **前台**：静态单页（Vue 3 Options API + jQuery，无打包器、无构建步骤）。
- **统一资源库**：`catalog_service/`（FastAPI + SQLite WAL），公开只读的模板 / 提示词预设 / 片段，加上 `/admin/` 管理端的草稿 → 显式发布 → 停用。
- **发布通道**：静态资源由 GitHub Actions 自动发布；后端服务由运维人工受控部署，**没有自动发版**。

线上入口 `https://runpod.hyxer.top/`、管理端 `https://runpod.hyxer.top/admin/`。生产运维步骤见文末导航，不在本文件。

## 1. 克隆与环境要求

```bash
git clone https://github.com/moonskycake/runpod_comfyui_frontend.git
cd runpod_comfyui_frontend
```

| 用途 | 要求 |
|---|---|
| 后端服务 / CLI / pytest | Python **3.10+** |
| 前端测试、内置模板种子提取 | Node.js（建议当前 LTS；脚本用 `assert` + `vm`，无需 `npm install`） |

### 虚拟环境放在 checkout 之外

仓库 `.gitignore` 只忽略 `node_modules/`、`.env`、`__pycache__/`、日志和压缩包，**没有忽略 `.venv/`**。为避免误提交，虚拟环境与数据库都放在 checkout 外。下面用 `$CATALOG_HOME`（Linux/macOS）或 `$env:CATALOG_HOME`（Windows）作为自选目录占位，换成自己的路径即可。

```bash
# Linux / macOS
export CATALOG_HOME="$HOME/.local/share/runpod-catalog"
mkdir -p "$CATALOG_HOME"
python3 -m venv "$CATALOG_HOME/venv"
source "$CATALOG_HOME/venv/bin/activate"
python -m pip install -r catalog_service/requirements.txt
```

```powershell
# Windows PowerShell
$env:CATALOG_HOME = "$env:LOCALAPPDATA\runpod-catalog"
New-Item -ItemType Directory -Force $env:CATALOG_HOME | Out-Null
python -m venv "$env:CATALOG_HOME\venv"
& "$env:CATALOG_HOME\venv\Scripts\Activate.ps1"
python -m pip install -r catalog_service/requirements.txt
```

之后所有命令都在**仓库根目录**执行。`catalog_service` 是根目录下的包，`python -m catalog_service...` 必须在根目录运行，`cd catalog_service` 会直接 `ModuleNotFoundError`。

## 2. 本地联调：两个终端，都从仓库根开始

本地需要两个进程：静态预览 `8766` + 后端 API `8787`。`deploy/catalog/dev_preview.py` 把 `/api/*` 原样反代到 `127.0.0.1:8787`，**代理目标是写死的 8787，没有改端口的参数**。

> 不要只用 `python -m http.server` 打开静态站：纯静态服务器不代理 `/api/`，资源库和 `/admin/` 都会失败。用 `dev_preview.py`，或自己配同源反代。

### 2.1 生成新口令哈希（不要复用生产口令）

后端服务**不会自动读取 `.env`**（无 dotenv），只认真实 OS 环境变量。所以直接把 `init-admin` 的 stdout 捕获进环境变量，既不在屏幕回显哈希，也不进 shell 历史。CLI 用 `getpass` 交互输入两次，只打印 `scrypt$...`：

```bash
# Linux / macOS，仓库根目录
export CATALOG_ADMIN_PASSWORD_HASH="$(python -m catalog_service.cli init-admin)"
```

```powershell
# Windows PowerShell，仓库根目录
$env:CATALOG_ADMIN_PASSWORD_HASH = (python -m catalog_service.cli init-admin).Trim()
```

口令请 ≥ 12 位且只用于本机。服务**不读 `.env`**，如需持久化请自行把哈希安全加载成真实 OS 环境变量（例如你的 shell 启动脚本里 `export`），并确认该文件未被跟踪、不要提交。（bash 里 `scrypt$...` 用单引号或双引号包住以防 `$` 被展开；PowerShell 用 `$env:` 赋值原样保存。）

### 2.2 终端 A：启动后端

```bash
# Linux / macOS（venv 已激活）
export CATALOG_PUBLIC_ORIGIN=http://127.0.0.1:8766
export CATALOG_DB_PATH="$CATALOG_HOME/catalog.db"
export CATALOG_COOKIE_SECURE=false          # 仅本地 http://127.0.0.1 调试
export CATALOG_HOST=127.0.0.1
export CATALOG_PORT=8787
python -m catalog_service
```

```powershell
# Windows PowerShell（venv 已激活）
$env:CATALOG_PUBLIC_ORIGIN = "http://127.0.0.1:8766"
$env:CATALOG_DB_PATH = "$env:CATALOG_HOME\catalog.db"
$env:CATALOG_COOKIE_SECURE = "false"
$env:CATALOG_HOST = "127.0.0.1"
$env:CATALOG_PORT = "8787"
python -m catalog_service
```

- `CATALOG_PUBLIC_ORIGIN` 必须与浏览器地址**精确同源**；`localhost` 与 `127.0.0.1` 视为不同源，混用会被 `403`。
- `CATALOG_COOKIE_SECURE=false` 只在本地 `http://127.0.0.1` 调试用；生产必须 `true`。
- 表结构在启动时自动创建（`init_db`），没有单独建库步骤；数据库**不会**自动种子。
- 缺少 `CATALOG_PUBLIC_ORIGIN` / `CATALOG_DB_PATH` 时进程报配置错误直接退出（不半配置启动）。完整变量表见 [catalog_service/README.md](./catalog_service/README.md)。

### 2.3 终端 B：启动静态预览

```bash
# 仓库根目录，同样先激活 venv（脚本只用标准库，但统一环境更省事）
python deploy/catalog/dev_preview.py --repo . --port 8766
```

只有两个参数：`--repo`（仓库根，默认按脚本位置推算）、`--port`（默认 8766）。它在内存里构建与线上一致的打包产物，提供 `/`、`/admin/`、`/_rel/<sha40>/...`，并打印 `api_proxy: http://127.0.0.1:8787`。

打开 `http://127.0.0.1:8766/` 与 `http://127.0.0.1:8766/admin/`。

### 2.4 本地统一库要不要 seed

新机器启动后统一库是**空的**，这不是故障。需要样例数据时先提取内置模板，再导入：

```bash
# Linux / macOS，仓库根目录，venv 已激活
python deploy/catalog/extract_builtin_seeds.py --repo . --check          # 校验，打印摘要，需要 Node
mkdir -p "$CATALOG_HOME/seeds"
python deploy/catalog/extract_builtin_seeds.py --repo . --out "$CATALOG_HOME/seeds/builtin-seeds.json"
python -m catalog_service.cli --db "$CATALOG_DB_PATH" seed "$CATALOG_HOME/seeds/builtin-seeds.json"
```

```powershell
# Windows PowerShell，仓库根目录，venv 已激活
python deploy/catalog/extract_builtin_seeds.py --repo . --check
New-Item -ItemType Directory -Force "$env:CATALOG_HOME\seeds" | Out-Null
python deploy/catalog/extract_builtin_seeds.py --repo . --out "$env:CATALOG_HOME\seeds\builtin-seeds.json"
python -m catalog_service.cli --db "$env:CATALOG_DB_PATH" seed "$env:CATALOG_HOME\seeds\builtin-seeds.json"
```

- `--out` 的父目录必须先存在，否则写入失败；种子文件放 checkout 外，避免被当成源码提交。
- helper 在 Node 的 `vm` 里只读执行 `js/builtin-templates.js`，不联网、不写文件。
- `seed` 只落**草稿**，不会自动发布（两个内置模板 `anima_priview_v1`、`anima_preview2_lora_v1` 同样如此）。要前台可见，登录 `/admin/` 逐条审阅后显式发布；公开 `GET /api/catalog` 只给发布快照。
- 幂等：`legacyId` 由 `kind + legacyId` 推导确定性 ID，重复 seed 只报 `skipped`。

### 2.5 换机器不会自动带过来的东西

- 后端用**新数据库文件**，不会自动获得旧机器的 QA 库或任何生产库内容。
- 浏览器 `localStorage` 里的本地模板 / 预设 / 片段随浏览器配置走。迁移方式：旧机器导出资源 JSON → 新机器导入为**本地项**；该 JSON **只含模板 / 预设 / 片段**。
- `IndexedDB` 里的**图片收藏不包含在资源 JSON 里**，不支持自动跨机同步；要保留只能自行手动搬运浏览器数据，不要指望导出导入资源能带上图片。
- 本地副本的 `sourceRevision` 元数据固定，但**预览图仍从公共接口 URL 加载**：没有本地缓存或原图兜底，断网时图片会缺失，不保证离线可见原图。
- 不要把生产 `catalog.env`、生产数据库或口令哈希拷到开发机。

## 3. 测试

前端测试是**独立 Node 脚本**（`assert` + 自带 runner，末尾打印结果并按失败数设置退出码），逐个运行：

```bash
node tests/catalog.test.js          # 24
node tests/catalog-admin.test.js    # 19
node tests/autocomplete.test.js     # 70
python -m pytest catalog_service/tests -q            # 28 个 ASGI 端到端用例
python -m pytest deploy/tests/test_deploy.py -q      # Windows 下 25 passed / 10 skipped（另有 14 subtests，勿叠加计数）
```

手工冒烟：

1. 未登录即可浏览统一库并「使用」，统一库项无编辑 / 删除入口；伪造前端管理员标记后调写接口仍 `401/403`。
2. `/admin/` 未登录渲染登录页；登录后可新建草稿、上传预览图、显式发布；前台刷新后拿到发布内容，已发布项再编辑不影响公众端。
3. 复制到本地的项固定 `sourceRevision`，统一库更新后其内容不变。
4. 响应头：公开 catalog/detail `no-cache` + `ETag`；所有 `/api/admin/*`（含错误）`no-store`。
5. 手机 390 px 宽无横向滚动。

## 4. 目录与前端加载顺序

```
index.html        # 前台单页 + 显式脚本顺序（无打包器）
admin.html        # /admin/ 管理端入口
js/               # settings / runpod-client / catalog-client / templates / placeholders /
                  # workflow-editor / builtin-templates / tag-index / history-store / main
css/              # 样式（含移动端断点与粘底操作条）
vue/ bootstrap/ js/*.min.js js/vendor/   # 内置第三方库，勿改
tags/danbooru.csv # 自动补全词表
tests/            # 独立 Node 测试脚本
catalog_service/  # FastAPI 服务、CLI、SQLite 存储、图片处理、pytest
deploy/           # 打包、发布网关、Nginx 片段、运维 runbook、本地预览
docs/             # 冻结 API 契约、计划稿、状态附录
```

`index.html` 实际加载顺序：`vue` → `axios` → `vendor/dagre|cytoscape|cytoscape-dagre` → `settings` → `runpod-client` → `catalog-client` → `templates` → `placeholders` → `workflow-editor` → `builtin-templates` → `tag-index` → `history-store` → `bootstrap.bundle` → `main`。新增脚本要在 `index.html` 里显式声明并保持这个依赖顺序，不要依赖偶然的全局变量。代码风格与安全约定见 [AGENTS.md](./AGENTS.md)。

## 5. 现状与边界

**已实现**

- 前台生图：模板与占位符、尺寸/种子、正负提示词、预设替换、片段光标插入、草稿、结果区。
- 本地能力：图片收藏（localStorage 元数据 + IndexedDB 二进制，只在本机）、模板/预设/片段的本地副本。
- 统一资源库：三类资源公开只读、管理员写；草稿与发布快照分离（改草稿不动公开内容，显式发布才切换版本）；`baseRev` 过期 `409` 且不覆盖服务端；停用后公开详情 `410`，历史修订保留。
- 预览图（仅预设 / 片段）：管理员上传，要求会话 + `Origin` + CSRF；输入 ≤ 5 MiB / ≤ 16 MP / 静态 PNG·JPEG·WebP，服务端转正、去元数据后存 WebP（长边 ≤ 480 px、≤ 64 KiB），**不保留原图**；草稿换图不影响已发布旧图，公开图按 `revision` 固定，历史修订可读。
- 安全：Cookie `HttpOnly; Secure; SameSite=Strict`；会话 token 只存哈希；写请求校验顺序 会话 → `Origin` → CSRF；登录 IP + 全局双维度限速。前端隐藏按钮不作安全边界。
- 生产统一库初始恰好两个已发布模板：`anima_preview2_lora_v1`、`anima_priview_v1`。

**有意不做**

- 无访客账号、无个人云同步、无收藏上传。
- 统一库与本地库允许同名，身份以 `source + id` 区分，绝不跨来源覆盖；本地副本不自动跟随统一库。
- 目录后端**不执行 workflow**、不校验 ComfyUI 环境兼容性；实际生图由浏览器直接调用 RunPod 端点完成（网站本身可正常出图）。后端也不抓远程 URL；无 CORS（同源部署）。
- 发布前只扫描 workflow 内疑似敏感**键名**并列键路径，不承诺识别任意文本中的秘密。
- 运维只有命令行：没有网页改密、默认账号或首启安装页。
- 不改动 RunPod 现服务、模型镜像与生图端点。

## 6. 后续工作

已确认、排期中的界面任务：

- [ ] 右栏「结果 / 快捷提示词库」互斥停靠与布局细化（桌面双栏、手机单列）；见 [docs/plans/ui-ux-plan.md](./docs/plans/ui-ux-plan.md)，其 P0 尚未全部落地。

候选方向（**未批准，勿自动排期**）：自动定时备份（现只有手工一致性备份）、数据库迁移方案、MOSS 集成、个人云同步。

## 7. 文档导航

- 安装 / 升级 / 备份恢复 / 口令轮换 runbook：[deploy/catalog/README.md](./deploy/catalog/README.md)（静态发布通道无 root 权限，替代不了这些步骤）。
- 服务环境变量、CLI、种子格式、本地 QA 配方：[catalog_service/README.md](./catalog_service/README.md)。
- 冻结 API 契约（含图片上传 / 读取）：[docs/catalog-api.md](./docs/catalog-api.md)。
- 静态站发布与网关规则：[deploy/README.md](./deploy/README.md)。
- 计划稿：[docs/plans/ui-ux-plan.md](./docs/plans/ui-ux-plan.md)、[docs/plans/shared-library-backend-plan.md](./docs/plans/shared-library-backend-plan.md)。
- 状态附录（历史快照，以 [docs/project-status.md](./docs/project-status.md) 开头日期为准，可能滞后于当前代码）。

生产路径（只列角色）：`/opt/runpod-catalog/app/current`、venv `/opt/runpod-catalog/venv`、数据库 `/var/lib/runpod-catalog/catalog.db`、服务 `runpod-catalog.service` 监听 `127.0.0.1:8787`、env `/etc/runpod-catalog/catalog.env`（`root:root 0600`）、备份 `/var/backups/runpod-catalog/`。具体步骤以 runbook 为准。
