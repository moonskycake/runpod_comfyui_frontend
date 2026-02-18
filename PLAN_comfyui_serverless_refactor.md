# RunPod ComfyUI Serverless 端点适配：推倒重构计划

## 目标
- 删除/弃用现有“基于 Stable Diffusion WebUI 参数”的整套实现（txt2img/img2img、checkpoint->endpoint 映射、controlnet/hr 等 WebUI 参数拼装）。
- 前端改为面向 RunPod Serverless + `worker-comfyui`：以 ComfyUI workflow JSON 为核心输入，通过 RunPod queue-based endpoint 的 `/run` + `/status`（可选 `/runsync`）完成任务。
- 新增“配置页/设置面板”：配置 `Endpoint ID` 与 `RunPod API Key`，并提供连通性测试（`/health`）。

## 联网研究要点（接口与数据结构）
- RunPod Serverless（queue-based）标准操作：
  - `POST https://api.runpod.ai/v2/{endpointId}/run` -> 返回 `{ id, status }`（异步）
  - `GET  https://api.runpod.ai/v2/{endpointId}/status/{jobId}` -> 轮询直到 `COMPLETED/FAILED/TIMED_OUT/...`
  - `POST https://api.runpod.ai/v2/{endpointId}/cancel/{jobId}` -> 取消
  - `GET  https://api.runpod.ai/v2/{endpointId}/health` -> 健康检查
  - Header：`Authorization: Bearer <API_KEY>`，`Content-Type: application/json`
  - 请求体大小限制：`/run` 10MB、`/runsync` 20MB（base64 图片可能超限）
  - 参考：https://docs.runpod.io/serverless/endpoints/send-requests
- `runpod-workers/worker-comfyui`（ComfyUI serverless worker）输入/输出：
  - 输入：`{ "input": { "workflow": <ComfyUI Export(API) 的 JSON>, "images": [{name,image}]? } }`
  - 输出（v5.0.0+）：`output.images[] = { filename, type: "base64"|"s3_url", data }`
  - 需要兼容旧格式（历史上可能出现 `output.message`）
  - 参考：https://github.com/runpod-workers/worker-comfyui

## 新架构（拆分职责，避免“UI=网络=拼包”耦合）
- Settings（配置与持久化）
  - 数据：`endpointId`、`apiKey`、`rememberApiKey`、可选 `runMode`(run/runsync)、可选 `pollIntervalMs`
  - 持久化策略：
    - `endpointId` 默认存 `localStorage`
    - `apiKey` 仅在用户明确勾选“记住”时存 `localStorage`；否则只保存在内存（刷新即失）
    - 严禁 `console.log` apiKey 或包含 apiKey 的 headers
- Transport（RunPod 客户端）
  - 单一入口：`run(payload)`、`runSync(payload, {waitMs})`、`status(jobId)`、`cancel(jobId)`、`health()`
  - 统一错误格式化：包含 HTTP status + response.data（脱敏），用于 UI 展示
- Workflow（工作流输入与可选模板）
  - MVP：支持“粘贴/上传 workflow JSON（API Export）”直接执行
  - 可选增强（后续）：提供内置模板 + 参数映射（prompt/negative/seed/steps/width/height），通过“节点定位+字段 patch”生成最终 workflow
  - 图片输入：支持添加多张输入图，生成 `input.images = [{ name, image }]`（image 可接受带/不带 data URI 前缀）

## UI/交互（推倒重做页面结构）
- 顶部导航（单页内切换）
  - `生成`：工作流执行与结果展示
  - `设置`：Endpoint/API Key/测试连接/保存策略
- 设置页（必须）
  - Endpoint ID 输入（支持粘贴完整 URL 时自动提取 ID）
  - API Key（password 输入 + 显示/隐藏）
  - “记住 API Key”（默认关闭）
  - “测试连接”按钮：调用 `/health`，将结果/错误渲染在页面上（不弹 alert）
- 生成页（MVP）
  - Workflow JSON：
    - 上传 `.json`（读取并校验 JSON）
    - 文本框粘贴（校验 JSON）
    - 兼容两种输入：纯 workflow object 或外层包了 `{input:{workflow:...}}`（内部统一成 worker 需要的结构）
  - 输入图片（可选）：
    - 复用现有上传组件逻辑，扩展为可管理列表：添加/移除、设置 `name`
    - 客户端校验尺寸与体积（避免超过 10MB），超限给出明确提示
  - 执行控制：
    - `运行（/run）` 默认；可选 `runsync`
    - 状态区：jobId、status、delayTime/executionTime（如果返回）
    - 取消：停止轮询 + 调用 `/cancel/{id}`（best-effort）
  - 结果展示：
    - 渲染 `output.images[]`
      - `type=base64` -> `data:image/png;base64,${data}`（必要时检测是否已带前缀）
      - `type=s3_url` -> 以图片/链接形式展示
    - 若返回旧格式则兼容解析并提示“旧输出格式”

## 实施步骤（按可交付里程碑切）
1) 清理旧实现（推倒）
- 移除/弃用 WebUI 参数拼装与 checkpoint->endpoint 映射（`js/main.js` 中 `checkpointstoendpoints`、`proseccedata`、`pushimage` 等整段逻辑）
- 页面删掉 WebUI 专用表单（模型选择、采样器、ControlNet、高清修复、WebUI img2img 参数等）
- 保留可复用组件：图片上传组件（可改成通用），以及 autocomplete（如果还有 prompt 字段）

2) 增加 Settings + RunPodClient（先跑通 /health）
- 新增设置面板 UI（建议 Bootstrap Offcanvas/Modal）
- 实现 `health()` 测试连接；错误信息可读（HTTP code + response body）

3) MVP：Workflow Runner（/run + /status + /cancel）
- workflow JSON 输入、校验、组装 payload：`{input:{workflow, images?}}`
- 统一轮询器：
  - 处理状态：`IN_QUEUE/IN_PROGRESS/COMPLETED/FAILED/TIMED_OUT/CANCELLED/...`
  - 支持可配置轮询间隔；遇到 429 做简单退避（或提示用户降低频率）
- 结果解析与展示（优先 v5.0.0+ 的 `output.images[]`）

4) 体验增强（可选）
- 工作流保存/加载：localStorage 保存最近 3-5 个 workflow（不包含 apiKey）
- 内置示例 workflow（用仓库里的 `ComfyUI_temp_pabtb_00004_ (2).json` 作为 demo）
- 模板化：为常用 workflow 提供“参数面板”，通过 mapping 自动 patch 指定节点字段

## 关键验收标准（完成即算适配成功）
- 未配置 endpoint/apiKey 时，“生成”按钮不可用，并提示去设置页
- 设置页 `测试连接` 能正确显示 `/health` 返回或错误原因（401/404/429/5xx）
- 使用任意有效 workflow（API export）：
  - `/run` 成功返回 id；轮询到 `COMPLETED` 后展示图片
  - `取消` 能立即停止轮询，并尽力调用 `/cancel`
- 不在控制台/页面任何地方泄露 apiKey

## 手工测试清单
- 正常：配置 -> health ok -> run -> status -> completed -> 展示 base64 图片
- 错误：apiKey 错（401）、endpointId 错（404）、频率过高（429）
- 取消：运行中点击取消，轮询停止且 UI 状态明确
- 大输入：上传图片导致 payload 超 10MB 时，客户端阻止提交并提示原因

## 参考链接
- RunPod Send Requests: https://docs.runpod.io/serverless/endpoints/send-requests
- worker-comfyui: https://github.com/runpod-workers/worker-comfyui
