# Agent Guide (RunPod Frontend)

This repo is a static HTML/JS frontend that sends requests to RunPod endpoints.
There is currently no Node/Python build system, no lint config, and no tests.

Key files/dirs
- `index.html`: single-page UI (zh-CN) + script includes (no bundler)
- `js/main_vue.js`: Vue 3 Options API app + UI state/actions
- `js/main.js`: RunPod request building + polling + cancel + result parsing
- `js/data.js`: ControlNet module/model data tables
- `js/autocomplete.js`: jQuery UI autocomplete for prompt tags + `tags/danbooru.csv`
- `css/style.css`, `css/autocomplete.css`: styling
- Vendored deps: `bootstrap/`, `vue/`, `js/axios.min.js`, `js/jquery-*.js`, `js/jquery-ui.js`
- Example workflow JSON (for upcoming ComfyUI refactor): `ComfyUI_temp_pabtb_00004_ (2).json`

Cursor/Copilot rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found in this repo.

-------------------------------------------------------------------------------

## Run / Build

- No build step: open via a local HTTP server (do not use `file://`); `tags/danbooru.csv` may fail to load under `file://`.

Run locally (pick one)
- Python: `python3 -m http.server 8000`
- Node: `npx serve . -l 8000`
- PHP: `php -S 127.0.0.1:8000`

Then open
- `http://127.0.0.1:8000/index.html`

Notes
- Script load order in `index.html` matters (Vue, axios, data, main, bootstrap, app, jQuery, jQuery UI, autocomplete).
- Avoid editing vendored/minified files unless doing a deliberate dependency update.
- If you change script order or add a new script, keep it explicit in `index.html` (do not rely on accidental globals).

-------------------------------------------------------------------------------

## Lint / Format

- No ESLint/Prettier config committed.

Optional formatting (ad-hoc)
- Check formatting: `npx prettier --check "**/*.{js,css,html,json,md}"`
- Apply formatting: `npx prettier --write "**/*.{js,css,html,json,md}"`

Formatting exclusions (recommended)
- Do not format/minify vendored files:
  - `bootstrap/**`, `vue/**`, `js/axios.min.js`, `js/jquery-*.js`, `js/jquery-ui.js`

If you add a toolchain later, prefer `eslint` + `prettier` + `editorconfig`, and do not lint vendored dirs.

-------------------------------------------------------------------------------

## Tests

- No automated tests.

Manual smoke test checklist
- Autocomplete loads `tags/danbooru.csv`; `txt2img` reaches `COMPLETED`; cancel stops polling.
- `img2img` upload validates image type and max 3000x3000.

If you add tests during the refactor (recommended)
- Unit tests: Vitest or Jest.
- Example single-test invocations (choose one framework):
  - Vitest: `npx vitest run js/__tests__/workflow.test.js` / `npx vitest run js/__tests__/workflow.test.js -t "build workflow"`
  - Jest: `npx jest js/__tests__/workflow.test.js` / `npx jest js/__tests__/workflow.test.js -t "build workflow"`
- Prefer pure-function tests (request builder/workflow builder) so they run in Node without DOM.

-------------------------------------------------------------------------------

## RunPod API Notes (Important For Refactor)

This frontend currently calls RunPod async endpoints directly:
- Start: `POST https://api.runpod.ai/v2/{endpointId}/run`
- Poll: `GET  https://api.runpod.ai/v2/{endpointId}/status/{requestId}`
- Cancel: `POST https://api.runpod.ai/v2/{endpointId}/cancel/{requestId}`
- Auth header: `Authorization: Bearer <API_KEY>`

Current implementation notes
- Endpoint selection is coupled to checkpoint mapping in `js/main.js`; polling is a 1s loop; cancel is best-effort.

Docs referenced for the upcoming refactor
- `https://docs.runpod.io/community-solutions/comfyui-to-api/overview`
- `https://docs.runpod.io/serverless/endpoints/send-requests`

Example ComfyUI workflow JSON (treat as input fixture)
- `ComfyUI_temp_pabtb_00004_ (2).json`

Refactor direction: separate UI state (Vue) -> workflow/request builder (pure) -> transport; treat workflow JSON as a graph.

-------------------------------------------------------------------------------

## Code Style Guidelines (JS/Vue, No Bundler)

### General
- Use modern JS (`const` by default, `let` only when reassigned).
- No implicit globals: always declare (`const/let`) and avoid assigning to undeclared names.
- Prefer semicolons in this repo (plain `<script>` execution + mixed libs = avoid ASI edge cases).
- Indentation: 2 spaces; keep lines reasonably short (~100 chars) when touching code.
- Keep UI strings consistent with existing zh-CN tone; add English only when necessary.

### Files, "imports", and globals
- There are no ES module imports today; scripts share globals.
- When adding new code without introducing a bundler:
  - Prefer a single namespace object (example: `window.Runpod = { ... }`) rather than many globals.
  - Or wrap helpers in an IIFE and export only what `main_vue.js` needs.
- Do not rely on load order accidentally; keep dependencies explicit and keep public exports small.
- Avoid naming collisions with vendored globals (`Vue`, `axios`, `$`).

### Naming
- Variables/functions: `camelCase` (`getRunAsyncId`, `cancelGeneration`).
- Components: `PascalCase` (`ImageUploadComponent`).
- Booleans: `isX`, `hasX`, `shouldX`, `canX`.
- Constants: `UPPER_SNAKE_CASE`.
- Avoid unclear names like `tmp`, `Myerror`, `returndata` in new/edited code.

### Types and data shapes (no TypeScript yet)
- Use JSDoc for non-trivial shapes (RunPod request/response, UI state objects).
- Validate external inputs at boundaries:
  - User input (API key, numbers)
  - Network responses (RunPod status payload)
  - Workflow JSON (ComfyUI graph)
- Keep API-payload keys exactly as required by the remote API; use quoting for non-identifier keys.
  - Example: existing state uses keys like `'negative-prompts'` and `'cfg-scale'`.

Suggested JSDoc targets: `buildRunpodRequest`, `pollRunpodStatus`, `buildComfyWorkflow`.

### Networking and error handling
- Always surface actionable errors:
  - Include HTTP status and `response.data` (when available) in the error message.
- Never log secrets:
  - Do not `console.log` the API key or full auth headers.
- Prefer deterministic error shaping (one place formats errors for UI display).
- Prefer timeouts and cancellation where possible:
  - Poll loops should have a max duration or max attempts.
  - When user cancels, stop polling immediately and treat the cancel as a first-class outcome.
- Handle RunPod terminal statuses explicitly:
  - `COMPLETED`, `FAILED`, `TIMED_OUT` (and any others introduced by newer docs).
- Recommended error message shape: `${message} (HTTP ${status}): ${JSON.stringify(responseData)}` when available.

### Vue (current code uses Vue 3 Options API)
- Keep all reactive fields defined up-front in `data()`.
- Derivations belong in `computed`; side effects belong in `watch` or methods.
- Avoid direct DOM manipulation; use template + refs.
- Keep methods small; isolate RunPod API logic into `js/main.js` (or a dedicated module) rather than mixing UI + transport.
- Avoid `alert()` for non-blocking failures; prefer showing an in-page error area/toast.

### Third-party / vendored code
- Do not edit minified or vendored libraries for feature work.
- If upgrading dependencies, do it in a focused change and keep filenames/versioning clear.

### Refactor guidance (practical)
- When moving toward ComfyUI-to-API, keep the workflow builder pure (no DOM/Vue access) so it is testable.
- Keep backward compatibility unless explicitly dropped (existing `txt2img`/`img2img` UX).
