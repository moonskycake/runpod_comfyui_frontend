/**
 * 统一库 / 本地资源边界测试（无依赖，直接 node 运行）
 * 运行：node tests/catalog.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const CatalogClient = require(path.join(ROOT, 'js', 'catalog-client.js'));

function createStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    dump() { return Object.fromEntries(map.entries()); }
  };
}

function loadTemplateManager(storage) {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'templates.js'), 'utf8');
  const sandbox = {
    window: {},
    localStorage: storage,
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Set,
    Error
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'templates.js' });
  return sandbox.window.TemplateManager;
}

const results = [];

// 载入真实应用 methods（捕获 Vue.createApp 选项，不执行 mounted）
function loadAppMethods(storage) {
  const mainSource = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
  const templateSource = fs.readFileSync(path.join(ROOT, 'js', 'templates.js'), 'utf8');
  let captured = null;
  const sandbox = {
    localStorage: storage,
    document: {},
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Error,
    Promise,
    Symbol,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    navigator: { userAgent: 'node' },
    location: { href: 'http://127.0.0.1/' },
    axios: { get() { throw new Error('unexpected axios'); } },
    Settings: {},
    Vue: {
      createApp(options) {
        captured = options;
        return { component() { return this; }, mount() { return this; }, use() { return this; } };
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.fetchCalls = [];
  sandbox.fetch = (...args) => {
    sandbox.fetchCalls.push(args);
    return Promise.reject(new Error('unexpected fetch'));
  };
  sandbox.CatalogClient = CatalogClient;
  vm.createContext(sandbox);
  vm.runInContext(templateSource, sandbox, { filename: 'templates.js' });
  vm.runInContext(mainSource, sandbox, { filename: 'main.js' });
  assert.ok(captured && captured.methods, '应捕获到应用选项');
  const ctx = Object.assign({}, captured.methods);
  ctx.$computed = captured.computed || {};
  ctx.$watch = captured.watch || {};
  ctx.showUiToast = () => {};
  ctx.$nextTick = (fn) => { if (typeof fn === 'function') fn(); };
  ctx.$refs = {};
  ctx.persistPromptPresets = () => {};
  ctx.loadUserTemplates = () => {};
  ctx.catalogItems = [];
  ctx.catalogDetails = {};
  ctx.catalogError = '';
  ctx.templateDetailLoadingId = '';
  ctx._templateLoadToken = 0;
  ctx.selectedTemplateId = '';
  ctx.selectedTemplate = null;
  ctx.placeholderValues = { prompt: '', negative_prompt: '' };
  ctx.userTemplates = [];
  ctx.promptBlockPresets = [];
  ctx.promptSnippetPresets = [];
  ctx.mainView = 'library';
  return { ctx, sandbox };
}
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok - ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.error(`not ok - ${name}`);
    console.error(e && e.stack ? e.stack : e);
  }
}

test('复制项归属本地：source=local 且保留来源版本', () => {
  const detail = { positive: 'a', negative: 'b' };
  const copy = CatalogClient.buildLocalCopy(
    { id: 'shared:demo', kind: 'preset', name: '人像', publishedRevision: 3, description: 'd' },
    detail
  );
  assert.strictEqual(copy.source, 'local');
  assert.strictEqual(copy.id.startsWith('local:'), true);
  assert.strictEqual(copy.sourceId, 'shared:demo');
  assert.strictEqual(copy.sourceRevision, 3);
  assert.strictEqual(CatalogClient.sourceOf(copy), 'local');
  assert.strictEqual(CatalogClient.canMutateLocal(copy), true);
  assert.strictEqual(CatalogClient.sourceOf({ id: 'shared:x', source: 'shared' }), 'shared');
  assert.strictEqual(CatalogClient.canMutateLocal({ id: 'shared:x', source: 'shared' }), false);
});

test('复制项深拷贝 payload，反向修改不污染来源数据', () => {
  const detail = { text: 'x', nested: { v: 1 } };
  const copy = CatalogClient.buildLocalCopy({ id: 'shared:t', kind: 'snippet', name: 's', publishedRevision: 1 }, detail);
  copy.data.nested.v = 99;
  assert.strictEqual(detail.nested.v, 1);
});

test('TemplateManager.add 复制项为本地可编辑，shared 原项拒绝更新删除', () => {
  const storage = createStorage();
  const manager = loadTemplateManager(storage);
  const id = manager.add({
    name: '副本',
    workflow: { a: {} },
    defaults: {},
    editor: {},
    source: 'shared',
    sourceId: 'shared:abc',
    sourceRevision: 2
  });
  const loaded = JSON.parse(storage.getItem('comfyui_templates'))[0];
  assert.strictEqual(loaded.id, id);
  assert.strictEqual(loaded.source, 'local');
  assert.strictEqual(loaded.sourceId, 'shared:abc');
  assert.strictEqual(loaded.sourceRevision, 2);
  assert.strictEqual(manager.update(id, { name: '改名' }), true);
  assert.strictEqual(manager.delete(id), true);

  const sharedRecord = {
    id: 'shared:readonly',
    name: '统一库',
    workflow: {},
    defaults: {},
    editor: {},
    source: 'shared',
    isBuiltin: false
  };
  storage.setItem('comfyui_templates', JSON.stringify([sharedRecord]));
  assert.strictEqual(manager.update('shared:readonly', { name: 'x' }), false);
  assert.strictEqual(manager.delete('shared:readonly'), false);
});

test('内置模板在线完全以目录为准：空 alias/空目录也不回退', () => {
  const builtins = [{ id: 'anima_priview_v1', name: 'builtin' }, { id: 'other_builtin', name: 'other' }];
  assert.deepStrictEqual(CatalogClient.visibleBuiltinTemplates(builtins, {}, true, []), []);
  assert.deepStrictEqual(CatalogClient.visibleBuiltinTemplates(builtins, {}, true, [{ id: 'shared:x', kind: 'template' }]), []);
  // 离线才回退内置；cached shared 项已有 legacyId 时不得与 builtin 双份显示
  const catalog = [{ id: 'shared:live', kind: 'template', legacyId: 'anima_priview_v1' }];
  assert.deepStrictEqual(
    CatalogClient.visibleBuiltinTemplates(builtins, {}, false, catalog).map(t => t.id),
    ['other_builtin']
  );
  assert.deepStrictEqual(
    CatalogClient.visibleBuiltinTemplates(builtins, {}, false, []).map(t => t.id),
    ['anima_priview_v1', 'other_builtin']
  );
});

test('缓存损坏/不可用按无缓存处理，不影响本地资源', () => {
  assert.strictEqual(CatalogClient.loadCache(createStorage({ [CatalogClient.CACHE_KEY]: '{bad json' })), null);
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); }
  };
  assert.strictEqual(CatalogClient.loadCache(throwing), null);
  assert.strictEqual(CatalogClient.saveCache(throwing, { catalogVersion: 1, items: [] }), false);
  const storage = createStorage();
  assert.strictEqual(CatalogClient.saveCache(storage, {
    catalogVersion: 4,
    items: [{ id: 'shared:a', kind: 'preset', name: 'A', publishedRevision: 1 }]
  }, 1000), true);
  const loaded = CatalogClient.loadCache(storage);
  assert.strictEqual(loaded.catalogVersion, 4);
  assert.strictEqual(loaded.items[0].id, 'shared:a');
});

test('公开详情持久缓存：按 id+publishedRevision 精确命中，旧 rev 不冒充', () => {
  const storage = createStorage();
  const detail = { id: 'shared:t', kind: 'template', name: 'T', publishedRevision: 2, data: { workflow: { a: 1 } } };
  assert.strictEqual(CatalogClient.saveDetailCache(storage, detail), true);
  const hit = CatalogClient.getCachedDetail(storage, 'shared:t', 2);
  assert.deepStrictEqual(hit.data, { workflow: { a: 1 } });
  hit.data.workflow.a = 99;
  assert.strictEqual(CatalogClient.getCachedDetail(storage, 'shared:t', 2).data.workflow.a, 1);
  assert.strictEqual(CatalogClient.getCachedDetail(storage, 'shared:t', 3), null);
  assert.strictEqual(CatalogClient.getCachedDetail(storage, 'shared:other', 2), null);
  assert.strictEqual(CatalogClient.saveDetailCache({ setItem() { throw new Error('denied'); } }, detail), false);
});

test('模板草稿按模板 key 隔离，只恢复当前模板存在的字段', () => {
  let drafts = {};
  drafts = CatalogClient.saveDraftSnapshot(drafts, 'template-a', { prompt: 'A', seed: 1, width: 512 });
  drafts = CatalogClient.saveDraftSnapshot(drafts, 'template-b', { prompt: 'B', seed: 2 });
  const restored = CatalogClient.pickDraftSnapshot(drafts, 'template-a', ['prompt', 'seed']);
  assert.deepStrictEqual(restored, { prompt: 'A', seed: 1 });
  assert.strictEqual(CatalogClient.pickDraftSnapshot(drafts, 'missing', ['prompt']), null);
  drafts['template-a'].prompt = 'mutated';
  assert.strictEqual(CatalogClient.pickDraftSnapshot(drafts, 'template-a', ['prompt']).prompt, 'mutated');
});

test('本地副本/导入命名不覆盖同名项', () => {
  assert.strictEqual(CatalogClient.uniqueCopyName('人像', []), '人像（本地副本）');
  assert.strictEqual(CatalogClient.uniqueCopyName('人像', ['人像（本地副本）']), '人像（本地副本 2）');
});

test('本地预设/片段导出导入保留内容，不产生 shared ID', () => {
  const exported = CatalogClient.buildLocalExport('preset', [{ name: 'P', prompt: 'p', negative_prompt: 'n' }]);
  assert.strictEqual(exported.kind, 'preset');
  assert.strictEqual(exported.items[0].prompt, 'p');
  const imported = CatalogClient.parseLocalImport('preset', JSON.stringify(exported));
  assert.strictEqual(imported.length, 1);
  assert.strictEqual(imported[0].negative_prompt, 'n');
  const snippet = CatalogClient.parseLocalImport('snippet', { items: [{ name: 'S', text: 's', target: 'negative' }] });
  assert.strictEqual(snippet[0].target, 'negative');
  assert.throws(() => CatalogClient.parseLocalImport('preset', '{bad json'), /有效 JSON/);
});

test('模板导入导出包含 workflow，复制项 ID 属本地命名空间', () => {
  const exported = CatalogClient.buildLocalExport('template', [{
    name: 'T', description: 'd', workflow: { node: { inputs: {} } }, defaults: { seed: 1 }, editor: {}
  }]);
  assert.ok(exported.items[0].workflow);
  const imported = CatalogClient.parseLocalImport('template', JSON.stringify(exported));
  assert.deepStrictEqual(imported[0].workflow, { node: { inputs: {} } });
  assert.strictEqual(CatalogClient.isLocalId(CatalogClient.newLocalId('template')), true);
  assert.strictEqual(CatalogClient.isSharedId(CatalogClient.newLocalId('template')), false);
});

test('metadata/detail 保留安全预览，外链/非 WebP/超限按无图处理', () => {
  const preview = {
    url: '/api/catalog/shared%3Ap1/preview?revision=3',
    width: 480, height: 320, bytes: 12345, mime: 'image/webp'
  };
  const meta = CatalogClient.normalizeMetadata({
    id: 'shared:p1', kind: 'preset', name: 'P', publishedRevision: 3, preview
  });
  assert.deepStrictEqual(meta.preview, preview);
  const detail = CatalogClient.normalizeDetailPayload({
    id: 'shared:p1', kind: 'preset', name: 'P', publishedRevision: 3, data: { positive: 'a' }, preview
  });
  assert.deepStrictEqual(detail.preview, preview);
  [
    { ...preview, url: 'https://evil.example/x.webp' },
    { ...preview, url: '//evil.example/x.webp' },
    { ...preview, url: 'javascript:alert(1)' },
    { ...preview, url: 'data:image/svg+xml,<svg/>' },
    { ...preview, mime: 'image/svg+xml' },
    { ...preview, width: 481 },
    { ...preview, bytes: 64 * 1024 + 1 }
  ].forEach((bad) => {
    assert.strictEqual(CatalogClient.normalizeMetadata({
      id: 'shared:p1', kind: 'preset', name: 'P', preview: bad
    }).preview, null);
  });
  const copy = CatalogClient.buildLocalCopy(
    { id: 'shared:p1', kind: 'preset', name: 'P', publishedRevision: 3, preview },
    { positive: 'a' }
  );
  assert.strictEqual(copy.source, 'local');
  assert.strictEqual(copy.preview.url, CatalogClient.previewUrlPublic('shared:p1', 3));
  assert.strictEqual(copy.preview.url.includes('revision=3'), true);
});

test('本地导入导出保留安全预览，剥离外链与非 WebP', () => {
  const safe = {
    url: '/api/catalog/shared%3Ap1/preview?revision=2',
    width: 96, height: 64, bytes: 512, mime: 'image/webp'
  };
  const exported = CatalogClient.buildLocalExport('snippet', [{ name: 'S', text: 't', preview: safe }]);
  assert.deepStrictEqual(exported.items[0].preview, safe);
  const imported = CatalogClient.parseLocalImport('snippet', {
    items: [
      { name: 'S', text: 't', preview: safe },
      { name: 'bad', text: 'x', preview: { ...safe, url: 'https://evil.example/x.webp' } },
      { name: 'bad2', text: 'y', preview: { ...safe, url: 'javascript:alert(1)' } }
    ]
  });
  assert.deepStrictEqual(imported[0].preview, safe);
  assert.strictEqual(imported[1].preview, null);
  assert.strictEqual(imported[2].preview, null);
});

(async () => {
  // fetch 测试是异步的，单独执行以保持上面的简单 runner 可读
  const asyncResults = [];
  try {
    let threw = false;
    try {
      await CatalogClient.fetchCatalog({ fetchImpl: async () => ({ ok: false, status: 503 }) });
    } catch (e) {
      threw = /HTTP 503/.test(e.message);
    }
    assert.strictEqual(threw, true);
    const result = await CatalogClient.fetchCatalog({
      fetchImpl: async () => ({ ok: false, status: 304, headers: { get: () => 'etag-1' } })
    });
    assert.strictEqual(result.notModified, true);
    asyncResults.push({ ok: true });
  } catch (e) {
    asyncResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 真实应用 methods 回归：本地三 kind 不发请求 / shared 按需加载 / 竞态 =====
  const appResults = [];
  try {
    const storage = createStorage();
    const manager = loadTemplateManager(storage);
    const localTplId = manager.add({ name: '本地模板', workflow: { '1': { class_type: 'KSampler' } }, defaults: {}, editor: {} });
    const { ctx, sandbox } = loadAppMethods(storage);
    const detailCalls = [];
    ctx.loadCatalogDetail = async (id) => {
      detailCalls.push(id);
      throw new Error('local 资源不应请求详情');
    };
    ctx.userTemplates = manager.loadUserTemplates();
    ctx.selectedTemplateId = '';
    ctx.catalogItems = [];

    await ctx.useLibraryItem({ id: localTplId, kind: 'template', source: 'local' });
    assert.strictEqual(ctx.selectedTemplateId, localTplId, '本地模板应被选中');
    ctx.onTemplateSelect();
    assert.strictEqual(JSON.parse(ctx.workflowJson)['1'].class_type, 'KSampler');

    ctx.promptBlockPresets = [{ id: 'local:p1', name: 'P', prompt: 'pos-local', negative_prompt: 'neg-local' }];
    await ctx.useLibraryItem({ id: 'local:p1', kind: 'preset', source: 'local' });
    assert.strictEqual(ctx.placeholderValues.prompt, 'pos-local');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'neg-local');

    ctx.promptSnippetPresets = [{ id: 'local:s1', name: 'S', text: 'snippet-local', target: 'positive' }];
    ctx.lastPromptField = '';
    ctx._lastPromptCaret = null;
    await ctx.useLibraryItem({ id: 'local:s1', kind: 'snippet', source: 'local' });
    assert.ok(ctx.placeholderValues.prompt.includes('snippet-local'));
    assert.strictEqual(detailCalls.length, 0, '本地资源不应调用 loadCatalogDetail');
    assert.strictEqual(sandbox.fetchCalls.length, 0, '本地资源不应发起 fetch');
    assert.strictEqual(ctx.mainView, 'generate');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  try {
    const storage = createStorage();
    const { ctx } = loadAppMethods(storage);
    const calls = [];
    ctx.catalogItems = [{ id: 'shared:one', kind: 'template', publishedRevision: 3 }];
    ctx.loadCatalogDetail = async (id, expected) => {
      calls.push([id, expected]);
      return {
        id,
        kind: 'template',
        name: '统一库模板',
        description: '',
        publishedRevision: 3,
        data: { workflow: { '7': { class_type: 'KSampler' } } }
      };
    };
    ctx.selectedTemplateId = 'shared:one';
    ctx.onTemplateSelect();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls, [['shared:one', 3]], '应按目录 publishedRevision 拉取详情');
    assert.strictEqual(JSON.parse(ctx.workflowJson)['7'].class_type, 'KSampler', '下拉选中 shared 应载入实际 workflow');
    assert.strictEqual(ctx.templateDetailLoadingId, '');

    // 失败：保留上一份 workflow，不把 undefined 当 workflow
    const before = ctx.workflowJson;
    ctx.catalogItems = [{ id: 'shared:bad', kind: 'template', publishedRevision: 1 }];
    ctx.selectedTemplateId = 'shared:bad';
    ctx.loadCatalogDetail = async () => { throw new Error('HTTP 404'); };
    ctx.onTemplateSelect();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(ctx.workflowJson, before, '加载失败应保留上一份 workflow');
    assert.strictEqual(ctx.templateDetailLoadingId, '');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  try {
    const storage = createStorage();
    const { ctx } = loadAppMethods(storage);
    const pending = {};
    ctx.catalogItems = [
      { id: 'shared:a', kind: 'template', publishedRevision: 1 },
      { id: 'shared:b', kind: 'template', publishedRevision: 2 }
    ];
    ctx.loadCatalogDetail = (id) => new Promise((resolve) => { pending[id] = resolve; });
    const realLoad = ctx.loadSharedTemplateIntoEditor;
    let last = null;
    ctx.loadSharedTemplateIntoEditor = (id) => { last = realLoad.call(ctx, id); return last; };

    ctx.selectedTemplateId = 'shared:a';
    ctx.onTemplateSelect();
    const first = last;
    ctx.selectedTemplateId = 'shared:b';
    ctx.onTemplateSelect();
    const second = last;

    pending['shared:b']({ id: 'shared:b', name: 'B', publishedRevision: 2, data: { workflow: { b: { class_type: 'B' } } } });
    await second;
    const afterB = ctx.workflowJson;
    pending['shared:a']({ id: 'shared:a', name: 'A', publishedRevision: 1, data: { workflow: { a: { class_type: 'A' } } } });
    await first;
    assert.strictEqual(ctx.workflowJson, afterB, '慢响应不得覆盖新选择');
    assert.strictEqual(JSON.parse(ctx.workflowJson).b.class_type, 'B');
    assert.strictEqual(ctx.selectedTemplateId, 'shared:b');
    assert.strictEqual(ctx.templateDetailLoadingId, '');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 竞态：pending shared A → 改选 local B → A 失败不得回滚 B =====
  const raceResults = [];
  try {
    const storage = createStorage();
    const manager = loadTemplateManager(storage);
    const localId = manager.add({ name: '本地B', workflow: { '2': { class_type: 'LocalB' } }, defaults: {}, editor: {} });
    const { ctx } = loadAppMethods(storage);
    let rejectA = null;
    ctx.catalogItems = [{ id: 'shared:a', kind: 'template', publishedRevision: 1 }];
    ctx.loadCatalogDetail = () => new Promise((resolve, reject) => { rejectA = reject; });
    ctx.userTemplates = manager.loadUserTemplates();
    ctx.isConfigured = true;
    ctx.workflowError = '';
    ctx.placeholderErrors = [];
    ctx.workflowEditorErrors = [];

    ctx.selectedTemplateId = 'shared:a';
    ctx.onTemplateSelect();
    assert.strictEqual(ctx.templateDetailLoadingId, 'shared:a', 'shared 加载中应上锁');
    assert.strictEqual(ctx.$computed.canGenerate.call(ctx), false, 'loading 期间不允许提交');

    // 用户改选本地 B（同一 tick 内）
    ctx.selectedTemplateId = localId;
    ctx.onTemplateSelect();
    const afterLocal = ctx.workflowJson;
    assert.strictEqual(JSON.parse(afterLocal)['2'].class_type, 'LocalB');
    assert.strictEqual(ctx.templateDetailLoadingId, '', '切到本地后应清除 loading');
    assert.strictEqual(ctx.$computed.canGenerate.call(ctx), true);

    rejectA(new Error('HTTP 404'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(ctx.selectedTemplateId, localId, 'A 失败不得回滚刚选的本地 B');
    assert.strictEqual(ctx.workflowJson, afterLocal, 'A 失败不得覆盖 B 的 workflow');
    assert.strictEqual(ctx.templateDetailLoadingId, '');
    raceResults.push({ ok: true });
  } catch (e) {
    raceResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 资源库两个入口（shared 详情 / local）走同一选择逻辑 =====
  try {
    const storage = createStorage();
    const manager = loadTemplateManager(storage);
    const localId = manager.add({ name: '本地L', workflow: { '3': { class_type: 'LocalL' } }, defaults: {}, editor: {} });
    const { ctx, sandbox } = loadAppMethods(storage);
    const detailCalls = [];
    ctx.catalogItems = [
      { id: 'shared:r', kind: 'template', publishedRevision: 2 },
      { id: 'shared:r2', kind: 'template', publishedRevision: 5 }
    ];
    ctx.loadCatalogDetail = async (id, expected) => {
      detailCalls.push([id, expected]);
      return { id, kind: 'template', name: 'R', description: '', publishedRevision: expected, data: { workflow: { '9': { class_type: 'SharedR' } } } };
    };
    ctx.userTemplates = manager.loadUserTemplates();
    ctx.selectedTemplateId = '';

    await ctx.useLibraryItem({ id: 'shared:r', kind: 'template', source: 'shared', publishedRevision: 2 });
    // 资源卡只负责选中：不得直接预取详情
    assert.strictEqual(detailCalls.length, 0, '资源卡选中不应直接拉详情');
    assert.strictEqual(ctx.selectedTemplateId, 'shared:r');
    assert.strictEqual(ctx.mainView, 'generate');
    // 手动调 onTemplateSelect 模拟 Vue watch
    await ctx.onTemplateSelect();
    assert.deepStrictEqual(detailCalls, [['shared:r', 2]], 'watch 后按 publishedRevision 精确取详情');
    assert.strictEqual(JSON.parse(ctx.workflowJson)['9'].class_type, 'SharedR');
    assert.strictEqual(detailCalls.length, 1, '已缓存且版本一致的 runtime 不应二次请求');
    await ctx.onTemplateSelect();
    assert.strictEqual(detailCalls.length, 1, 'runtime 命中后不再请求');
    assert.strictEqual(ctx.templateDetailLoadingId, '');

    await ctx.useLibraryItem({ id: localId, kind: 'template', source: 'local' });
    assert.strictEqual(ctx.selectedTemplateId, localId);
    ctx.onTemplateSelect();
    assert.strictEqual(JSON.parse(ctx.workflowJson)['3'].class_type, 'LocalL');
    assert.strictEqual(detailCalls.length, 1, 'local 入口不应请求详情');
    assert.strictEqual(sandbox.fetchCalls.length, 0);
    raceResults.push({ ok: true });
  } catch (e) {
    raceResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 资源卡 A → B：A 慢响应不得改 selectedId/workflow =====
  try {
    const storage = createStorage();
    const { ctx } = loadAppMethods(storage);
    const pending = {};
    ctx.catalogItems = [
      { id: 'shared:a', kind: 'template', publishedRevision: 1 },
      { id: 'shared:b', kind: 'template', publishedRevision: 2 }
    ];
    ctx.loadCatalogDetail = (id) => new Promise((resolve, reject) => { pending[id] = { resolve, reject }; });
    ctx.selectedTemplateId = '';

    await ctx.useLibraryItem({ id: 'shared:a', kind: 'template', source: 'shared', publishedRevision: 1 });
    const first = ctx.onTemplateSelect(); // 模拟 watch
    await ctx.useLibraryItem({ id: 'shared:b', kind: 'template', source: 'shared', publishedRevision: 2 });
    const second = ctx.onTemplateSelect();
    assert.strictEqual(ctx.selectedTemplateId, 'shared:b');

    pending['shared:b'].resolve({ id: 'shared:b', name: 'B', publishedRevision: 2, data: { workflow: { b: { class_type: 'B' } } } });
    await second;
    const afterB = ctx.workflowJson;
    pending['shared:a'].resolve({ id: 'shared:a', name: 'A', publishedRevision: 1, data: { workflow: { a: { class_type: 'A' } } } });
    await first;
    assert.strictEqual(ctx.selectedTemplateId, 'shared:b', '资源卡慢响应不得改 selectedId');
    assert.strictEqual(ctx.workflowJson, afterB, '资源卡慢响应不得覆盖 workflow');
    assert.strictEqual(JSON.parse(afterB).b.class_type, 'B');
    assert.strictEqual(ctx.templateDetailLoadingId, '');
    raceResults.push({ ok: true });
  } catch (e) {
    raceResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 草稿保存：只写实际已应用模板，挂起 oldVal 不覆盖 =====
  try {
    const storage = createStorage();
    const { ctx } = loadAppMethods(storage);
    const persisted = [];
    ctx.persistSelectedTemplateId = () => {};
    ctx.persistTemplateDraftFor = (id, values) => { persisted.push([id, values]); };
    ctx.loadTemplateDraftFor = () => null;
    ctx.onTemplateSelect = () => {}; // 避免真实网络
    ctx.selectedTemplate = { id: 'C' };
    ctx.placeholderValues = { prompt: 'values-of-C' };

    // oldVal=A 只是挂起/未应用，实际已应用是 C：不得把 C 的值写成 A 的草稿
    ctx.$watch.selectedTemplateId.call(ctx, 'B', 'A');
    assert.strictEqual(persisted.length, 0, '未应用的 oldVal 不应持久化草稿');

    // oldVal=C 就是当前已应用模板：正常保存
    ctx.$watch.selectedTemplateId.call(ctx, 'D', 'C');
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0][0], 'C');
    assert.strictEqual(persisted[0][1].prompt, 'values-of-C');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 重载回归：runtime 为空、持久层存 shared ID，restore 不得清 key =====
  try {
    const sharedId = 'shared:35b7c1d2-0000-4aaa-8bbb-0123456789ab';
    const storage = createStorage({ runpod_selected_template_id_v1: sharedId });
    const { ctx } = loadAppMethods(storage);
    assert.strictEqual(ctx.selectedTemplateId, '', '初始无选择');
    ctx.restoreSelectedTemplateId();
    assert.strictEqual(ctx.selectedTemplateId, sharedId, 'runtime 为空也应恢复 shared ID');
    assert.strictEqual(storage.getItem('runpod_selected_template_id_v1'), sharedId, 'shared ID 不得当作失效本地 ID 清理');

    // 失效 local ID 仍按原逻辑清理
    const storageLocal = createStorage({ runpod_selected_template_id_v1: 'local:gone' });
    const local = loadAppMethods(storageLocal);
    local.ctx.restoreSelectedTemplateId();
    assert.strictEqual(local.ctx.selectedTemplateId, '');
    assert.strictEqual(storageLocal.getItem('runpod_selected_template_id_v1'), null, '失效 local ID 仍应清理');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 离线恢复：目录+详情缓存即可还原 workflow 与该模板私有草稿，且不调 fetch =====
  try {
    const sharedId = 'shared:offline-template-1';
    const detail = {
      id: sharedId,
      kind: 'template',
      name: '离线模板',
      description: '',
      publishedRevision: 4,
      data: { workflow: { '10': { class_type: 'OfflineNode' } } }
    };
    const storage = createStorage({ runpod_selected_template_id_v1: sharedId });
    assert.ok(CatalogClient.saveCache(storage, { catalogVersion: 9, items: [
      { id: sharedId, kind: 'template', name: '离线模板', publishedRevision: 4 }
    ] }, 1000), '目录缓存写入成功');
    assert.ok(CatalogClient.saveDetailCache(storage, detail), '详情缓存写入成功');
    assert.ok(CatalogClient.saveDraftMap(storage, {
      [sharedId]: { prompt: 'shared-draft', steps: '33' },
      'local:other': { prompt: 'other-template' }
    }), '草稿写入成功');

    const { ctx, sandbox } = loadAppMethods(storage);
    // mounted 的目录 fetch 尚 pending/失败：内存无 catalogItems
    assert.deepStrictEqual(ctx.catalogItems, []);
    ctx.restoreSelectedTemplateId();
    assert.strictEqual(ctx.selectedTemplateId, sharedId);

    await ctx.onTemplateSelect();
    assert.strictEqual(sandbox.fetchCalls.length, 0, '详情缓存命中时不应发起 fetch');
    assert.strictEqual(JSON.parse(ctx.workflowJson)['10'].class_type, 'OfflineNode', '离线应恢复 workflow');
    assert.strictEqual(ctx.selectedTemplateId, sharedId, '恢复后不得丢弃 shared ID');
    assert.strictEqual(ctx.templateDetailLoadingId, '');

    const draft = ctx.loadTemplateDraftFor(sharedId);
    assert.ok(draft, '应读到该共享模板私有草稿');
    assert.strictEqual(draft.prompt, 'shared-draft');
    assert.strictEqual(draft.steps, '33');
    assert.strictEqual(ctx.loadTemplateDraftFor('local:other').prompt, 'other-template', '各模板草稿互不串用');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  // ===== 预览图：localStorage 归一化 / 导入 / 复制固定版本 =====
  try {
    const safe = {
      url: '/api/catalog/shared%3Apreset/preview?revision=5',
      width: 480, height: 320, bytes: 1234, mime: 'image/webp'
    };
    const storage = createStorage({
      runpod_prompt_block_presets_v1: JSON.stringify([
        { id: 'local:p1', name: '安全', prompt: 'a', preview: safe },
        { id: 'local:p2', name: '外链', prompt: 'b', preview: { ...safe, url: 'https://evil.example/a.webp' } },
        { id: 'local:p3', name: '脚本', prompt: 'c', preview: { ...safe, url: 'javascript:alert(1)' } }
      ])
    });
    const { ctx } = loadAppMethods(storage);
    ctx.loadPromptPresets();
    assert.deepStrictEqual(ctx.promptBlockPresets[0].preview, safe, '安全 preview 应原样保留');
    assert.strictEqual(ctx.promptBlockPresets[1].preview, null, '外链 preview 应丢弃');
    assert.strictEqual(ctx.promptBlockPresets[2].preview, null, 'javascript preview 应丢弃');

    ctx.promptSnippetPresets = [];
    ctx.importLocalItems([{ name: 'S', text: 't', target: 'positive', preview: safe }]);
    assert.deepStrictEqual(ctx.promptSnippetPresets[0].preview, safe, '导入应保留安全 preview');
    ctx.importLocalItems([{
      name: 'bad', text: 'x', target: 'positive',
      preview: { ...safe, url: 'data:image/svg+xml,<svg/>' }
    }]);
    assert.strictEqual(ctx.promptSnippetPresets[0].preview, null, '导入应剥离 data URL preview');

    const sharedPreview = {
      url: '/api/catalog/shared%3Ap9/preview?revision=7',
      width: 480, height: 320, bytes: 2048, mime: 'image/webp'
    };
    ctx.loadCatalogDetail = async () => ({
      id: 'shared:p9', kind: 'preset', name: '共享', publishedRevision: 7,
      data: { positive: 'x', negative: 'y' }, preview: sharedPreview
    });
    await ctx.copyLibraryItemToLocal({
      id: 'shared:p9', kind: 'preset', name: '共享', publishedRevision: 7, preview: sharedPreview
    });
    const copied = ctx.promptBlockPresets.find(p => p.sourceId === 'shared:p9');
    assert.ok(copied, '复制应写入本地预设');
    assert.strictEqual(copied.source, 'local');
    assert.strictEqual(copied.preview.url, CatalogClient.previewUrlPublic('shared:p9', 7));
    assert.strictEqual(copied.preview.url.includes('revision=7'), true, '本地副本预览应固定在来源 revision');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  // 回归：带参预览 helper 必须注册为 methods，否则 Vue 会把 computed 当属性/字符串，调用即 TypeError
  try {
    const { ctx } = loadAppMethods(createStorage({}));
    ['previewDomKey', 'isPreviewBroken', 'markPreviewBroken'].forEach(name => {
      assert.strictEqual(typeof ctx[name], 'function', `${name} 必须注册在 methods`);
      assert.strictEqual(typeof ctx.$computed[name], 'undefined', `${name} 不应出现在 computed`);
    });

    ctx.previewBroken = {};
    const item = {
      id: 'shared:p1', kind: 'preset', sourceRevision: 5,
      preview: { url: '/api/catalog/shared%3Ap1/preview?revision=5' }
    };
    const key = ctx.previewDomKey(item);
    assert.strictEqual(key, 'shared:p1@5@/api/catalog/shared%3Ap1/preview?revision=5', 'previewDomKey 应返回字符串键');
    assert.strictEqual(ctx.previewDomKey(null), '', '空 item 应返回空键');
    assert.strictEqual(ctx.isPreviewBroken(item), false, '初始不应为 broken');
    ctx.markPreviewBroken(item);
    assert.strictEqual(ctx.previewBroken[key], true, 'markPreviewBroken 应记录键');
    assert.strictEqual(ctx.isPreviewBroken(item), true, '标记后应判定 broken');
    assert.strictEqual(ctx.isPreviewBroken({ ...item, sourceRevision: 6 }), false, 'revision 变化不应误判 broken');
    appResults.push({ ok: true });
  } catch (e) {
    appResults.push({ ok: false, error: e });
    console.error(e);
  }

  const failed = results.filter(r => !r.ok).length
    + asyncResults.filter(r => !r.ok).length
    + appResults.filter(r => !r.ok).length
    + raceResults.filter(r => !r.ok).length;
  const total = results.length + asyncResults.length + appResults.length + raceResults.length;
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) process.exit(1);
})();
