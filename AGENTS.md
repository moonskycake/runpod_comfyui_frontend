# Agent Guide (RunPod Frontend)

静态 HTML/JS 前台 + 同源 `catalog_service/`（FastAPI + SQLite）后端。前端**无打包器、无构建步骤**；两端都有自动化测试。

Key files/dirs
- `index.html`：前台单页（zh-CN）+ 显式脚本顺序
- `admin.html`：`/admin/` 管理端入口
- `js/settings.js` / `js/runpod-client.js`：本机设置与 RunPod 请求（构建、轮询、取消、结果解析）
- `js/catalog-client.js`：统一库 / 本地资源客户端（`source + id` 复合标识、本地副本）
- `js/templates.js`、`js/builtin-templates.js`、`js/placeholders.js`、`js/workflow-editor.js`：模板、内置模板、占位符、workflow 编辑
- `js/tag-index.js`：标签索引与自动补全（UI 由 `js/main.js` 的 `PromptTextareaComponent` 驱动，词表 `tags/danbooru.csv`）
- `js/history-store.js`：收藏元数据（localStorage）+ 图片（IndexedDB）
- `js/catalog-admin.js`：管理端逻辑
- `css/style.css`、`css/catalog-admin.css`、`css/autocomplete.css`
- `catalog_service/`：FastAPI 服务、CLI、SQLite 存储、图片处理、pytest
- `deploy/`：打包、发布网关、Nginx 片段、运维 runbook、本地预览 `catalog/dev_preview.py`
- `docs/`：冻结 API 契约、计划稿、状态附录
- Vendored deps：`bootstrap/`、`vue/`、`js/*.min.js`、`js/vendor/`
- 示例 workflow JSON：`ComfyUI_temp_pabtb_00004_ (2).json`（输入样例，不是配置）

-------------------------------------------------------------------------------

## Run / Build

- 无构建步骤；不要用 `file://`（`tags/danbooru.csv` 会加载失败）。
- 完整本地联调（静态 8766 + API 8787）见根 `README.md`。单起静态站可选：
  - Python：`python3 -m http.server 8000`
  - Node：`npx serve . -l 8000`
  - 但纯静态服务器**不代理 `/api/`**，资源库与 `/admin/` 不可用；同源联调请用
    `python deploy/catalog/dev_preview.py --repo . --port 8766`（反代写死 `127.0.0.1:8787`）。
- 后端从**仓库根**启动：`python -m catalog_service`（环境变量要求见 `catalog_service/README.md`）。
- 脚本顺序在 `index.html` 里显式维护（当前：vue → axios → vendor/dagre|cytoscape|cytoscape-dagre →
  settings → runpod-client → catalog-client → templates → placeholders → workflow-editor →
  builtin-templates → tag-index → history-store → bootstrap.bundle → main）。新增脚本必须显式声明并遵守依赖顺序，不依赖偶然全局。
- 不要编辑 vendored / minified 文件，除非是刻意的依赖升级。

-------------------------------------------------------------------------------

## Lint / Format

- 没有提交 ESLint/Prettier 配置。可选：`npx prettier --check "**/*.{js,css,html,json,md}"`、
  `npx prettier --write ...`
- 排除 vendored：`bootstrap/**`、`vue/**`、`js/*.min.js`、`js/vendor/**`。

-------------------------------------------------------------------------------

## Tests

前端测试是**独立 Node 脚本**（`assert` + 自带 runner，非 `node --test` 套件），逐个运行：

```bash
node tests/catalog.test.js
node tests/catalog-admin.test.js
node tests/autocomplete.test.js
python -m pytest catalog_service/tests -q
python -m pytest deploy/tests/test_deploy.py -q
```

- 前端脚本会 `require()` 前端模块并在 `vm` 里模拟浏览器全局，因此不需要浏览器或 npm 依赖。
- 新增前端测试沿用同样模式：普通脚本 + `assert`，失败时设置非零退出码。
- 后端测试用临时 SQLite，不碰既有数据。

手工冒烟：自动补全能加载词表；txt2img 到 `COMPLETED`、取消立即停止轮询；img2img 类型与
3000x3000 上限校验；未登录可读统一库、写接口 `401/403`。

-------------------------------------------------------------------------------

## RunPod API Notes

当前前台直接调用 RunPod async 端点：
- Start: `POST https://api.runpod.ai/v2/{endpointId}/run`
- Poll: `GET  https://api.runpod.ai/v2/{endpointId}/status/{requestId}`
- Cancel: `POST https://api.runpod.ai/v2/{endpointId}/cancel/{requestId}`
- Auth: `Authorization: Bearer <API_KEY>`

实现要点：`js/settings.js` 保存本机设置（含 `endpointId` / API Key），`js/runpod-client.js` 据此向 RunPod 发请求并处理取消（best-effort）。

参考文档：`https://docs.runpod.io/community-solutions/comfyui-to-api/overview`、`https://docs.runpod.io/serverless/endpoints/send-requests`。

重构方向：UI 状态（Vue）→ 请求/workflow 构建（纯函数）→ 传输层分离；workflow JSON 当作图处理。

-------------------------------------------------------------------------------

## Code Style Guidelines (JS/Vue, No Bundler)

### General
- 默认 `const`，需要重赋值才用 `let`；不制造隐式全局。
- 用分号（纯 `<script>` + 混合库，避免 ASI 边界问题）。
- 2 空格缩进，行宽约 100 字符以内。
- UI 文案沿用现有 zh-CN 语气，必要时才加英文。

### Files, "imports", and globals
- 没有 ES module；脚本共享全局。新增代码优先收敛到一个命名空间对象（如 `window.Runpod = {...}`），
  或用 IIFE 只导出 `main` 需要的东西。
- 导出面保持小，避免与 vendored 全局（`Vue`、`axios`、`$`）撞名。

### Naming
- 变量/函数 `camelCase`；组件 `PascalCase`；布尔 `isX/hasX/shouldX/canX`；常量 `UPPER_SNAKE_CASE`。
- 避免 `tmp`、`Myerror`、`returndata` 这类含混命名。

### Types and data shapes（无 TypeScript）
- 非平凡结构用 JSDoc（RunPod 请求/响应、UI 状态、统一库条目）。
- 在边界校验外部输入：用户输入、网络响应、workflow JSON。
- API 载荷键名保持远端要求（如 `'negative-prompts'`、`'cfg-scale'`）。

### Networking and error handling
- 错误要可操作：带 HTTP 状态与 `response.data`（若存在）。
- 不 `console.log` 密钥或完整认证头。
- 错误格式统一在一处生成。
- 轮询设最大时长/次数；用户取消时立刻停止轮询并把取消当成一等结果。
- 显式处理终态：`COMPLETED`、`FAILED`、`TIMED_OUT`。

### Vue（Vue 3 Options API）
- `data()` 里预先声明所有响应式字段；派生用 `computed`，副作用放 `watch`/方法。
- 不直接操作 DOM，用模板 + ref。
- UI 与传输分离：RunPod 逻辑留在 `js/runpod-client.js`。
- 不要用 `alert()` 处理非阻塞失败，用页面内错误区/toast。

### 统一库相关约束（必须遵守）
- 文本字段一律纯文本插值，**禁止 `v-html`**（名称、描述、提示词、片段）。
- 统一库只读：不得给公开项加编辑/删除入口；本地与统一库允许同名，以 `source + id` 区分，绝不跨来源覆盖。
- 发布是显式动作：保存 ≠ 公开；`baseRev` 冲突（`409`）不要静默重试覆盖。
- 后台鉴权只在接口；前端显隐按钮不是安全边界。

### Third-party / vendored code
- 不为功能编辑 minified/vendored 文件；升级依赖要单独聚焦提交。
