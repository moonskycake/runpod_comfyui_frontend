/**
 * 后台保存链回归测试（无依赖，node tests/catalog-upload-workflow.test.js）
 *
 * 覆盖第三阶段保存语义：文本先于图片、部分失败可只重试图片、
 * 401 保留本地构图、过期回包隔离、保存锁阻止重复提交。
 * 只测 js/catalog-image-editor.js 导出的纯逻辑，不访问网络。
 */
'use strict';

const assert = require('assert');
const path = require('path');

const Editor = require(path.join(__dirname, '..', 'js', 'catalog-image-editor.js'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function makeState(overrides) {
  return Object.assign({
    kind: 'snippet',
    isNew: true,
    hasItem: false,
    textDirty: true,
    baseRev: null,
    pendingPicture: { action: 'set' }
  }, overrides || {});
}

/** 模拟 Vue 侧的 saveText / uploadPicture 处理器，记录真实调用顺序。 */
function makeHandlers(state, options) {
  const opts = options || {};
  const calls = [];
  const handlers = {
    calls,
    isStale: opts.isStale,
    async saveText() {
      calls.push('saveText:baseRev=' + state.baseRev);
      if (opts.saveTextError) return { ok: false, error: opts.saveTextError };
      if (opts.saveTextUnauthorized) return { unauthorized: true, error: '登录已过期' };
      state.isNew = false;
      state.hasItem = true;
      state.textDirty = false;
      state.baseRev = 1;
      return { ok: true };
    },
    async uploadPicture() {
      calls.push('uploadPicture:baseRev=' + state.baseRev);
      if (opts.uploadConflict) {
        return { ok: false, error: '数据已变化，请刷新后再合并（HTTP 409）', conflict: { current: { id: 'shared:1' } } };
      }
      if (opts.uploadUnauthorized) return { unauthorized: true, error: '登录已过期' };
      if (opts.uploadError) return { ok: false, error: opts.uploadError };
      state.pendingPicture = null;
      state.baseRev = 2;
      return { ok: true };
    },
    async clearPicture() {
      calls.push('clearPicture:baseRev=' + state.baseRev);
      return { ok: true };
    }
  };
  return handlers;
}

test('新建条目先图后文字：保存链为 saveText → uploadPicture，图片使用返回的新 baseRev', async () => {
  const state = makeState();
  const plan = Editor.planSaveChain(state);
  assert.deepStrictEqual(plan.steps, ['saveText', 'uploadPicture']);

  const handlers = makeHandlers(state);
  const result = await Editor.runSaveChain(plan, handlers);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.textSaved, true);
  assert.strictEqual(result.pictureSaved, true);
  assert.deepStrictEqual(handlers.calls, ['saveText:baseRev=null', 'uploadPicture:baseRev=1']);
  assert.strictEqual(state.baseRev, 2);
});

test('已有条目只有待上传图片时不再重复保存文本', async () => {
  const state = makeState({ isNew: false, hasItem: true, textDirty: false, baseRev: 5 });
  const plan = Editor.planSaveChain(state);
  assert.deepStrictEqual(plan.steps, ['uploadPicture']);
  const handlers = makeHandlers(state);
  await Editor.runSaveChain(plan, handlers);
  assert.deepStrictEqual(handlers.calls, ['uploadPicture:baseRev=5']);
});

test('文本保存成功、图片失败：部分成功，可只重试图片并沿用新 baseRev', async () => {
  const state = makeState();
  const plan = Editor.planSaveChain(state);
  const first = await Editor.runSaveChain(plan, makeHandlers(state, { uploadError: '网络中断' }));
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.partial, true);
  assert.strictEqual(first.textSaved, true);
  assert.strictEqual(first.pictureSaved, false);
  assert.strictEqual(first.error, '网络中断');
  assert.strictEqual(state.baseRev, 1, '文本已保存，拿到新 baseRev');
  assert.deepStrictEqual(state.pendingPicture, { action: 'set' }, '本地构图必须保留');

  const retryPlan = Editor.planSaveChain(state);
  assert.deepStrictEqual(retryPlan.steps, ['uploadPicture'], '重试只上传图片');
  const retry = await Editor.runSaveChain(retryPlan, makeHandlers(state));
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(state.baseRev, 2);
});

test('图片 409 冲突：不自动覆盖，保留待上传图片与冲突信息', async () => {
  const state = makeState({ isNew: false, hasItem: true, textDirty: true, baseRev: 3 });
  const result = await Editor.runSaveChain(Editor.planSaveChain(state),
    makeHandlers(state, { uploadConflict: true }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.partial, true);
  assert.ok(result.conflict && result.conflict.current);
  assert.deepStrictEqual(state.pendingPicture, { action: 'set' });
});

test('文本保存失败时绝不尝试上传图片', async () => {
  const state = makeState();
  const handlers = makeHandlers(state, { saveTextError: '名称不能为空（HTTP 422）' });
  const result = await Editor.runSaveChain(Editor.planSaveChain(state), handlers);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.partial, false);
  assert.deepStrictEqual(handlers.calls, ['saveText:baseRev=null']);
});

test('上传阶段 401：标记登录过期，保留本地构图，重登后可只重试图片', async () => {
  const state = makeState({ isNew: false, hasItem: true, textDirty: false, baseRev: 4 });
  const result = await Editor.runSaveChain(Editor.planSaveChain(state),
    makeHandlers(state, { uploadUnauthorized: true }));
  assert.strictEqual(result.unauthorized, true);
  assert.deepStrictEqual(state.pendingPicture, { action: 'set' });
  assert.strictEqual(state.baseRev, 4);

  const retry = await Editor.runSaveChain(Editor.planSaveChain(state), makeHandlers(state));
  assert.strictEqual(retry.ok, true);
});

test('过期回包/资源切换后保存链中止，不再发起后续请求', async () => {
  const state = makeState();
  const tracker = Editor.createOperationTracker();
  const token = tracker.begin();
  const handlers = makeHandlers(state);
  let stale = false;
  handlers.isStale = () => stale;
  const originalSaveText = handlers.saveText;
  handlers.saveText = async () => {
    const out = await originalSaveText();
    tracker.invalidate();       // 模拟用户切走了资源
    stale = !tracker.isCurrent(token);
    return out;
  };
  const result = await Editor.runSaveChain(Editor.planSaveChain(state), handlers);
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(handlers.calls, ['saveText:baseRev=null']);
  assert.deepStrictEqual(state.pendingPicture, { action: 'set' });
});

test('图片清除走 clearPicture，并排在文本保存之后', async () => {
  const state = makeState({ isNew: false, hasItem: true, textDirty: true, baseRev: 7, pendingPicture: { action: 'clear' } });
  const plan = Editor.planSaveChain(state);
  assert.deepStrictEqual(plan.steps, ['saveText', 'clearPicture']);
  const handlers = makeHandlers(state);
  await Editor.runSaveChain(plan, handlers);
  assert.deepStrictEqual(handlers.calls, ['saveText:baseRev=7', 'clearPicture:baseRev=1']);
});

test('planSaveChain 阻塞：保存中、无改动、模板不支持预览图', () => {
  assert.strictEqual(Editor.planSaveChain(makeState({ saving: true })).blocked, 'saving');
  assert.strictEqual(Editor.planSaveChain(makeState({
    isNew: false, hasItem: true, textDirty: false, pendingPicture: null
  })).blocked, 'nothing');
  assert.strictEqual(Editor.planSaveChain(makeState({
    kind: 'template', isNew: true, hasItem: false, textDirty: true, pendingPicture: { action: 'set' }
  })).blocked, 'unsupported-kind');
});

test('runExclusive 串行锁：保存进行中重复提交直接被跳过', async () => {
  const lock = { busy: false };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = Editor.runExclusive(lock, async () => {
    await gate;
    return { ok: true, label: 'first' };
  });
  const second = await Editor.runExclusive(lock, async () => ({ ok: true, label: 'second' }));
  assert.strictEqual(second.skipped, true);
  release();
  assert.strictEqual((await first).label, 'first');
  assert.strictEqual(lock.busy, false);

  const third = await Editor.runExclusive(lock, async () => ({ ok: true, label: 'third' }));
  assert.strictEqual(third.label, 'third');
});

test('操作标识：新操作或资源切换使旧回包失效', () => {
  const tracker = Editor.createOperationTracker();
  const first = tracker.begin();
  assert.strictEqual(tracker.isCurrent(first), true);
  const second = tracker.begin();
  assert.strictEqual(tracker.isCurrent(first), false);
  assert.strictEqual(tracker.isCurrent(second), true);
  tracker.invalidate();
  assert.strictEqual(tracker.isCurrent(second), false);
  assert.strictEqual(tracker.isCurrent(null), false);
});

test('回包身份校验：只接受同一资源的响应', () => {
  assert.strictEqual(Editor.responseMatchesItem({ id: 'shared:1' }, 'shared:1'), true);
  assert.strictEqual(Editor.responseMatchesItem({ id: 'shared:2' }, 'shared:1'), false);
  assert.strictEqual(Editor.responseMatchesItem(null, 'shared:1'), false);
  assert.strictEqual(Editor.responseMatchesItem({ id: 'shared:1' }, ''), true);
});

test('未保存检测：文本或待上传图片任一存在都算有未保存内容', () => {
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: true, pendingPicture: null }), true);
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: false, pendingPicture: { action: 'set' } }), true);
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: false, pendingPicture: null }), false);
});

// ---------------------------------------------------------------------------
// Vue 集成：捕获 admin.html 实际使用的 app options，替换 CatalogAdmin.api
// 验证 saveDraft 真实的 baseRev 传递、401 / 409 处理、重复提交与迟到回包。
// ---------------------------------------------------------------------------

const ADMIN_PATH = path.join(__dirname, '..', 'js', 'catalog-admin.js');

function fakeCanvas(width, height) {
  const ctx = {
    fillStyle: '',
    imageSmoothingQuality: '',
    save() {}, restore() {}, setTransform() {}, beginPath() {},
    rect() {}, clip() {}, fillRect() {}, drawImage() {}
  };
  return {
    width,
    height,
    getContext: () => ctx,
    toBlob(callback, type) {
      setTimeout(() => callback({ size: 2048, type: type || 'image/webp' }), 0);
    }
  };
}

function loadAdminOptions() {
  const apps = [];
  const fakeWindow = {
    document: { createElement: (tag) => fakeCanvas(480, 270), addEventListener() {} },
    Vue: { createApp: (options) => ({ mount: () => { apps.push(options); return {}; } }) },
    CatalogImageEditor: Editor,
    addEventListener() {},
    removeEventListener() {}
  };
  const previousWindow = global.window;
  global.window = fakeWindow;
  delete require.cache[require.resolve(ADMIN_PATH)];
  const admin = require(ADMIN_PATH);
  assert.ok(apps.length === 1, '应捕获到 Vue app options（检查 window/document/Vue 模拟）');
  admin.options = apps[0];
  return { admin, options: apps[0], fakeWindow, previousWindow };
}

function createVm(admin, overrides) {
  const options = admin.options;
  const vm = options.data();
  Object.keys(options.computed).forEach((key) => {
    Object.defineProperty(vm, key, {
      get: () => options.computed[key].call(vm),
      enumerable: true,
      configurable: true
    });
  });
  Object.assign(vm, options.methods);
  vm.$refs = {};
  vm.$nextTick = (fn) => Promise.resolve().then(() => (fn ? fn() : undefined));
  vm.auth = { status: 'ready', csrfToken: 'csrf-1', expiresAt: '' };
  vm._saveLock = { busy: false };
  vm._sequence = 0;
  vm._saveToken = 0;
  vm._pictureToken = 0;
  Object.assign(vm, overrides || {});
  vm.snapshot = JSON.stringify(vm.form);
  return vm;
}

function stopToast(vm) {
  if (vm._toastTimer) clearTimeout(vm._toastTimer);
}

function itemPayload(overrides) {
  return Object.assign({
    id: 'shared:new',
    kind: 'snippet',
    name: '片段',
    description: '',
    category: '',
    order: 0,
    status: 'draft',
    draftRev: 1,
    publishedRevision: null,
    hasUnpublishedChanges: true,
    data: { text: 'glow', target: 'positive' }
  }, overrides || {});
}

function newSnippetVm(admin) {
  const vm = createVm(admin, { kind: 'snippet', isNew: true, mobilePane: 'edit' });
  vm.form = Object.assign({}, vm.form, { name: '片段', text: 'glow', target: 'positive' });
  return vm;
}

function attachLocalPicture(vm) {
  vm.pictureLocal = { width: 800, height: 450, kind: 'png', bitmap: { width: 800, height: 450 }, objectUrl: '' };
  vm.pictureAction = 'set';
  vm.pictureGeom = { mode: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };
}

test('集成：新建条目 saveDraft 先建草稿，再用返回的 draftRev 上传图片', async () => {
  const { admin } = loadAdminOptions();
  const calls = [];
  admin.api = async (method, apiPath, options) => {
    calls.push({ method, path: apiPath, body: options && options.body, rawBody: options && options.rawBody });
    if (apiPath === '/api/admin/items' && method === 'POST') {
      return { ok: true, status: 201, payload: itemPayload() };
    }
    if (apiPath === '/api/admin/items/shared%3Anew/preview?baseRev=1' && method === 'POST') {
      return {
        ok: true,
        status: 200,
        payload: itemPayload({
          draftRev: 2,
          preview: {
            url: '/api/admin/items/shared%3Anew/preview?rev=2',
            width: 480, height: 270, bytes: 2048, mime: 'image/webp'
          }
        })
      };
    }
    if (apiPath === '/api/admin/items') return { ok: true, status: 200, payload: { items: [] } };
    throw new Error('unexpected ' + method + ' ' + apiPath);
  };

  const vm = newSnippetVm(admin);
  attachLocalPicture(vm);
  await vm.saveDraft();
  stopToast(vm);

  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
    'POST /api/admin/items',
    'POST /api/admin/items/shared%3Anew/preview?baseRev=1',
    'GET /api/admin/items'
  ]);
  assert.ok(calls[1].rawBody && calls[1].rawBody.size > 0, '上传的是压缩后的 WebP blob');
  assert.strictEqual(vm.baseRev, 2);
  assert.strictEqual(vm.pictureLocal, null);
  assert.strictEqual(vm.pendingPicture, null);
  assert.strictEqual(vm.isDirty, false);
  assert.match(vm.saveNotice, /未发布/);
  assert.strictEqual(vm.item.publishedRevision, null);
  assert.strictEqual(vm.saving, false);
});

test('集成：图片上传 409 时保留本地构图与文本结果，不自动覆盖', async () => {
  const { admin } = loadAdminOptions();
  admin.api = async (method, apiPath) => {
    if (method === 'POST' && apiPath === '/api/admin/items') {
      return { ok: true, status: 201, payload: itemPayload() };
    }
    if (apiPath.includes('/preview')) {
      return {
        ok: false,
        status: 409,
        payload: { detail: '修订号已过期', current: itemPayload({ draftRev: 7 }) }
      };
    }
    return { ok: true, status: 200, payload: { items: [] } };
  };

  const vm = newSnippetVm(admin);
  attachLocalPicture(vm);
  await vm.saveDraft();
  stopToast(vm);

  assert.ok(vm.pictureLocal, '本地图片必须保留');
  assert.deepStrictEqual(vm.pendingPicture, { action: 'set' });
  assert.strictEqual(vm.baseRev, 1, 'baseRev 来自文本保存，不回退也不吞掉');
  assert.strictEqual(vm.conflict.current.draftRev, 7);
  assert.match(vm.saveError, /文本已保存/);
  assert.match(vm.saveError, /409/);
  assert.strictEqual(vm.saving, false);
});

test('集成：上传 401 保留编辑与构图，重登后只重试图片', async () => {
  const { admin } = loadAdminOptions();
  const calls = [];
  let uploadStatus = 401;
  admin.api = async (method, apiPath) => {
    calls.push(method + ' ' + apiPath);
    if (method === 'POST' && apiPath === '/api/admin/items') {
      return { ok: true, status: 201, payload: itemPayload() };
    }
    if (apiPath.includes('/preview')) {
      if (uploadStatus === 401) return { ok: false, status: 401, payload: { detail: '登录已过期' } };
      return {
        ok: true,
        status: 200,
        payload: itemPayload({
          draftRev: 2,
          preview: {
            url: '/api/admin/items/shared%3Anew/preview?rev=2',
            width: 480, height: 270, bytes: 2048, mime: 'image/webp'
          }
        })
      };
    }
    return { ok: true, status: 200, payload: { items: [] } };
  };

  const vm = newSnippetVm(admin);
  attachLocalPicture(vm);
  await vm.saveDraft();
  stopToast(vm);

  assert.strictEqual(vm.sessionExpired, true);
  assert.ok(vm.pictureLocal, '登录过期不得丢本地构图');
  assert.strictEqual(vm.baseRev, 1);
  assert.strictEqual(vm.form.text, 'glow');
  assert.match(vm.saveError, /登录已过期/);

  // 重新登录：编辑器状态保留，只重试图片。
  uploadStatus = 200;
  vm.sessionExpired = false;
  vm.auth = { status: 'ready', csrfToken: 'csrf-2', expiresAt: '' };
  calls.length = 0;
  await vm.saveDraft();
  stopToast(vm);

  assert.deepStrictEqual(calls, [
    'POST /api/admin/items/shared%3Anew/preview?baseRev=1',
    'GET /api/admin/items'
  ]);
  assert.strictEqual(vm.baseRev, 2);
  assert.strictEqual(vm.pictureLocal, null);
  assert.strictEqual(vm.isDirty, false);
});

test('集成：保存中重复点击不会发第二次请求', async () => {
  const { admin } = loadAdminOptions();
  const calls = [];
  let releaseText;
  const textGate = new Promise((resolve) => { releaseText = resolve; });
  admin.api = async (method, apiPath) => {
    calls.push(method + ' ' + apiPath);
    if (method === 'POST' && apiPath === '/api/admin/items') {
      await textGate;
      return { ok: true, status: 201, payload: itemPayload() };
    }
    if (apiPath === '/api/admin/items') return { ok: true, status: 200, payload: { items: [] } };
    return { ok: false, status: 500, payload: { detail: 'unexpected' } };
  };

  const vm = newSnippetVm(admin);
  const first = vm.saveDraft();
  const second = await vm.saveDraft();
  assert.strictEqual(second, undefined);
  assert.strictEqual(calls.length, 1, '第二次点击被锁挡住');
  releaseText();
  await first;
  stopToast(vm);
  assert.strictEqual(calls.filter((c) => c === 'POST /api/admin/items').length, 1);
});

test('集成：本地选图不再被旧 guard 阻止，且不发任何写请求', async () => {
  const { admin, fakeWindow } = loadAdminOptions();
  const calls = [];
  admin.api = async (method, apiPath) => {
    calls.push(method + ' ' + apiPath);
    return { ok: true, status: 200, payload: { items: [] } };
  };
  fakeWindow.createImageBitmap = async () => ({ width: 640, height: 360, close() { this.closed = true; } });
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = {
    type: 'image/png',
    name: 'local.png',
    size: 8,
    async arrayBuffer() { return pngBytes.buffer; }
  };

  const vm = newSnippetVm(admin);
  vm.$refs.stageCanvas = fakeCanvas(480, 270);
  vm.$refs.thumbCanvas = fakeCanvas(160, 160);
  await vm.handlePictureFiles([file]);

  // 旧 guard 仍会拒绝“新建/有改动时选图”，新流程不得再依赖它。
  assert.strictEqual(admin.previewGuard({ isNew: true, hasItem: false, isDirty: true }).ok, false);
  assert.strictEqual(vm.pictureAction, 'set');
  assert.strictEqual(vm.pictureLocal.width, 640);
  assert.strictEqual(vm.hasPendingPicture, true);
  assert.strictEqual(vm.isDirty, true);
  assert.deepStrictEqual(calls, [], '选图阶段不能触网');

  // 多图提示
  await vm.handlePictureFiles([file, file]);
  assert.match(vm.pictureError, /一次只能处理一张/);
});

test('集成：解码期间资源被重置，迟到结果被丢弃并释放位图', async () => {
  const { admin, fakeWindow } = loadAdminOptions();
  admin.api = async () => ({ ok: true, status: 200, payload: { items: [] } });
  let resolveDecode;
  let closed = 0;
  fakeWindow.createImageBitmap = () => new Promise((resolve) => {
    resolveDecode = () => resolve({ width: 800, height: 450, close() { closed += 1; } });
  });
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = {
    type: 'image/png', name: 'late.png', size: 8,
    async arrayBuffer() { return pngBytes.buffer; }
  };

  const vm = newSnippetVm(admin);
  vm.$refs.stageCanvas = fakeCanvas(480, 270);
  const pending = vm.handlePictureFiles([file]);
  await new Promise((resolve) => setTimeout(resolve, 0));   // 等 arrayBuffer → decode 阶段
  assert.strictEqual(vm.pictureLoading, true);
  assert.strictEqual(typeof resolveDecode, 'function');
  vm.resetPictureState();          // 资源切换/离开时的失效路径
  resolveDecode();
  await pending;

  assert.strictEqual(vm.pictureLocal, null, '迟到解码结果不得写入新资源');
  assert.strictEqual(vm.pictureAction, '');
  assert.strictEqual(closed, 1, '迟到位图必须释放');
  assert.strictEqual(vm.pictureLoading, false);
});

test('集成：保存/导出期间图片构图控件全部拒绝修改', async () => {
  const { admin } = loadAdminOptions();
  admin.api = async () => ({ ok: true, status: 200, payload: { items: [] } });
  const vm = newSnippetVm(admin);
  attachLocalPicture(vm);
  const geomBefore = JSON.stringify(vm.pictureGeom);
  let pickerClicks = 0;
  vm.$refs.pictureFile = { click() { pickerClicks += 1; } };
  vm.saving = true;
  assert.strictEqual(vm.saveBusy, true);

  vm.setPictureMode('contain');
  vm.onPictureZoomInput({ target: { value: '3' } });
  vm.resetPictureGeometry();
  vm.cancelPictureEdit();
  vm.markPictureRemoval();
  vm.openPicturePicker();
  vm.onStagePointerDown({ pointerId: 1, clientX: 10, clientY: 10, currentTarget: {} });
  vm.onStagePointerMove({ pointerId: 1, clientX: 80, clientY: 80 });
  vm.onStageKeydown({ key: 'ArrowLeft', preventDefault() {} });
  vm.onStageWheel({ deltaY: -100 });

  assert.strictEqual(JSON.stringify(vm.pictureGeom), geomBefore);
  assert.strictEqual(vm.pictureAction, 'set');
  assert.ok(vm.pictureLocal, '本地图片不能被保存中的操作清掉');
  assert.strictEqual(pickerClicks, 0);
});

test('集成：openItem 迟到回包不覆盖后选的资源', async () => {
  const { admin } = loadAdminOptions();
  const pending = {};
  admin.api = (method, apiPath) => new Promise((resolve) => {
    const id = decodeURIComponent(apiPath.split('/').pop());
    pending[id] = () => resolve({
      ok: true,
      status: 200,
      payload: itemPayload({ id, name: '资源 ' + id, draftRev: 1 })
    });
  });
  const vm = createVm(admin);
  const first = vm.openItem('shared:a');
  const second = vm.openItem('shared:b');
  pending['shared:b']();
  await second;
  assert.strictEqual(vm.item.id, 'shared:b');
  assert.strictEqual(vm.busyItemId, '');
  pending['shared:a']();           // A 的回包迟到
  await first;
  assert.strictEqual(vm.item.id, 'shared:b', '迟到回包不得覆盖当前选择');
});

test('集成：加载服务器版本前确认丢弃本地构图，确认后才重置', async () => {
  const { admin } = loadAdminOptions();
  const calls = [];
  admin.api = async (method, apiPath) => {
    calls.push(method + ' ' + apiPath);
    return { ok: true, status: 200, payload: itemPayload({ id: 'shared:1', name: '服务器版本' }) };
  };
  const vm = createVm(admin, { isNew: false, selectedId: 'shared:1' });
  vm.item = itemPayload({ id: 'shared:1' });
  vm.baseRev = 1;
  attachLocalPicture(vm);

  await vm.reloadServerVersion();
  assert.strictEqual(vm.discardDialog.open, true);
  assert.match(vm.discardDialog.message, /丢弃/);
  assert.ok(vm.pictureLocal, '确认前不得丢本地构图');
  assert.deepStrictEqual(calls, []);

  vm.confirmDiscard();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(vm.discardDialog.open, false);
  assert.strictEqual(vm.pictureLocal, null);
  assert.match(vm.saveNotice, /已加载服务器最新草稿/);
  assert.deepStrictEqual(calls, ['GET /api/admin/items/shared%3A1']);
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log('ok - ' + name);
    } catch (err) {
      console.error('not ok - ' + name);
      throw err;
    }
  }
  console.log('\n' + passed + ' tests passed');
})();
