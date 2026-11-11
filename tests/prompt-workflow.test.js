/**
 * 提示词工作流回归（第二阶段）：片段/预设正文、显式插入目标、撤销、统一库按需摘要。
 * 运行：node tests/prompt-workflow.test.js
 * 捕获实际 Vue 选项，在无网络、无浏览器存储副作用的环境中验证行为。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function loadApp(storage) {
  let options = null;
  const focused = [];
  const selections = new Map();
  const notices = [];
  const document = {
    activeElement: null,
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
    removeEventListener() {},
    contains() { return true; },
    querySelector(selector) {
      const match = /data-prompt-field="([^"]+)"/.exec(String(selector || ''));
      if (!match) return null;
      const field = match[1];
      const values = ctx.placeholderValues || {};
      if (!Object.prototype.hasOwnProperty.call(values, field)) return null;
      return {
        dataset: { promptField: field },
        value: String(values[field] || ''),
        focus() { focused.push(field); },
        setSelectionRange(start, end) { selections.set(field, [start, end]); },
        closest() { return null; }
      };
    },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() {
      return {
        style: {}, dataset: {},
        setAttribute() {}, select() {}, setSelectionRange() {},
        appendChild() {}, removeChild() {}
      };
    }
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document,
    navigator: { userAgent: 'node' },
    localStorage: storage,
    Settings: {},
    CatalogClient,
    fetch() { throw new Error('测试不应发起真实网络请求'); },
    Vue: {
      createApp(captured) {
        options = captured;
        return {
          component() { return this; },
          use() { return this; },
          mount() { return this; }
        };
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8'), sandbox, { filename: 'main.js' });
  assert.ok(options && options.data, '应捕获到 Vue 应用选项');

  const ctx = options.data();
  for (const [key, method] of Object.entries(options.methods || {})) ctx[key] = method.bind(ctx);
  for (const [key, getter] of Object.entries(options.computed || {})) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() { return getter.call(ctx); }
    });
  }
  ctx.$nextTick = fn => { if (typeof fn === 'function') fn(); };
  ctx.$refs = {};
  ctx.showUiToast = (message, type) => { notices.push({ message, type }); };
  ctx.persistPromptPresets = () => {};
  ctx.loadUserTemplates = () => {};
  return { ctx, options, sandbox, document, focused, selections, notices };
}

/** 模拟在某个提示词字段里留下光标记录（记录带文本快照，用于识别旧记录）。 */
function setCaret(ctx, field, start, end) {
  const text = String((ctx.placeholderValues || {})[field] || '');
  const record = { field, start, end, text };
  ctx._lastPromptCaret = record;
  ctx._promptCarets = { ...(ctx._promptCarets || {}), [field]: record };
  ctx.lastPromptField = field;
  return record;
}

function detailFor(item, data) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    description: item.description || '',
    publishedRevision: item.publishedRevision,
    data: data || {}
  };
}

const results = { passed: 0, failed: 0 };
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.passed += 1;
      console.log('ok - ' + name);
    })
    .catch(error => {
      results.failed += 1;
      console.error('not ok - ' + name);
      console.error(error && error.stack ? error.stack : error);
    });
}

async function drain(ctx, maxTicks) {
  const limit = Number.isFinite(maxTicks) ? maxTicks : 50;
  for (let i = 0; i < limit; i += 1) {
    if (!ctx._libraryDetailInflight && !(ctx._libraryDetailQueue && ctx._libraryDetailQueue.length)) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function run() {
  // ===== 1. 复现并锁定字段优先级 bug =====
  await test('明确“插入正向”只改正向，不受最后焦点在负向影响', () => {
    const { ctx } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'AAA, BBB', negative_prompt: 'NEG' };
    setCaret(ctx, 'prompt', 5, 5);
    setCaret(ctx, 'negative_prompt', 3, 3);
    assert.strictEqual(ctx.lastPromptField, 'negative_prompt', '前置：最后焦点在负向');

    const ok = ctx.insertSnippetToPrompt({ id: 's1', name: 'S', text: 'snippet' }, 'prompt');
    assert.strictEqual(ok, true);
    assert.strictEqual(ctx.placeholderValues.prompt, 'AAA, snippet, BBB', '应使用正向自己的光标位置');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'NEG', '负向不得被改动');
  });

  await test('明确“插入负向”使用负向自己的光标，而不是最近的正向光标', () => {
    const { ctx } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'AAA, BBB', negative_prompt: 'NEG' };
    setCaret(ctx, 'negative_prompt', 3, 3);
    setCaret(ctx, 'prompt', 5, 5);
    assert.strictEqual(ctx.lastPromptField, 'prompt', '前置：最后焦点在正向');

    ctx.insertSnippetToPrompt({ id: 's2', name: 'S', text: 'snippet' }, 'negative_prompt');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'NEG, snippet', '应使用负向光标（末尾）');
    assert.strictEqual(ctx.placeholderValues.prompt, 'AAA, BBB', '正向不得被改动');
  });

  await test('默认插入（当前编辑框）才跟最后焦点，并在界面文案里显示目标', () => {
    const { ctx } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'P', negative_prompt: 'NEG' };
    setCaret(ctx, 'prompt', 1, 1);
    setCaret(ctx, 'negative_prompt', 3, 3);
    ctx.insertSnippetToPrompt({ id: 's3', name: 'S', text: 'x' });
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'NEG, x', '默认目标应为最后焦点字段');
    assert.strictEqual(ctx.placeholderValues.prompt, 'P');
    assert.strictEqual(ctx.promptInsertTargetLabel, '负向提示词（最近焦点）');
  });

  await test('目标字段没有光标记录时追加末尾，不借用其他字段光标', () => {
    const { ctx } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'ABCDE', negative_prompt: 'NEG' };
    setCaret(ctx, 'prompt', 2, 2);
    ctx._promptCarets = { prompt: ctx._promptCarets.prompt };
    ctx.insertSnippetToPrompt({ id: 's4', name: 'S', text: 'x' }, 'negative_prompt');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'NEG, x');
    assert.strictEqual(ctx.placeholderValues.prompt, 'ABCDE', '正向光标不得被用于负向');
  });

  await test('模板缺目标字段时明确失败，不改其他字段', () => {
    const { ctx, notices } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'P' };
    const ok = ctx.insertSnippetToPrompt({ id: 's5', name: 'S', text: 'x' }, 'negative_prompt');
    assert.strictEqual(ok, false);
    assert.strictEqual(ctx.placeholderValues.prompt, 'P');
    assert.ok(notices.some(n => /负向/.test(n.message) && /没有/.test(n.message)), '应提示缺少目标字段');
  });

  await test('跨模板/文本已变的旧光标记录不得复用（追加末尾）', () => {
    const { ctx } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'OLD TEXT', negative_prompt: '' };
    setCaret(ctx, 'prompt', 2, 2);
    ctx.resetPromptCaretTracking();
    assert.strictEqual(ctx.resolveSnippetField('prompt'), null, '重置后无记录');
    ctx.insertSnippetToPrompt({ id: 's6', name: 'S', text: 'x' }, 'prompt');
    assert.strictEqual(ctx.placeholderValues.prompt, 'OLD TEXT, x', '无记录时应追加末尾');

    // 记录存在但文本快照不一致（模板内容被替换）：旧位置不可复用
    ctx.placeholderValues = { prompt: 'COMPLETELY DIFFERENT', negative_prompt: '' };
    setCaret(ctx, 'prompt', 1, 1);
    ctx.placeholderValues.prompt = 'CHANGED BY PRESET';
    assert.strictEqual(ctx.resolveSnippetField('prompt'), null, '文本快照不符时视为旧记录');
    ctx.insertSnippetToPrompt({ id: 's7', name: 'S', text: 'y' }, 'prompt');
    assert.strictEqual(ctx.placeholderValues.prompt, 'CHANGED BY PRESET, y');
  });

  await test('插入后恢复目标字段焦点并保留就近撤销', () => {
    const { ctx, focused } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'P', negative_prompt: 'NEG' };
    setCaret(ctx, 'negative_prompt', 3, 3);
    ctx.insertSnippetToPrompt({ id: 's8', name: 'S', text: 'x' }, 'negative_prompt');
    assert.strictEqual(focused[focused.length - 1], 'negative_prompt', '插入后焦点应回到负向');
    assert.ok(ctx.promptUndo, '应记录撤销');
    assert.strictEqual(ctx.promptUndo.field, 'negative_prompt');
    assert.strictEqual(ctx.promptUndo.label, '片段「S」');

    ctx.undoPromptApply();
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'NEG', '撤销应还原负向');
    assert.strictEqual(focused[focused.length - 1], 'negative_prompt', '撤销后焦点仍在负向');
    assert.strictEqual(ctx.promptUndo, null);
  });

  await test('参数锁定/模板加载中，所有提示词应用入口都拒绝改词', () => {
    const { ctx, notices } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'P', negative_prompt: 'NEG' };
    Object.defineProperty(ctx, 'isParamsLocked', { configurable: true, value: true });

    assert.strictEqual(ctx.insertSnippetToPrompt({ id: 's9', name: 'S', text: 'x' }, 'prompt'), false);
    assert.strictEqual(ctx.applyPromptPresetContent({ positive: 'a', negative: 'b', label: 'p' }), false);
    ctx.promptUndo = { prompt: 'old', negative_prompt: 'old-neg', label: 'p' };
    ctx.undoPromptApply();
    assert.strictEqual(ctx.placeholderValues.prompt, 'P');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'NEG');
    assert.ok(ctx.promptUndo, '锁定期间撤销也不得生效');
    assert.ok(notices.filter(n => /锁定|加载中/.test(n.message)).length >= 2);
  });

  // ===== 2. 预设正负摘要与覆盖范围 =====
  await test('预设覆盖范围随模板字段不同而变化，不改未提供的字段', () => {
    const { ctx } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'P' };
    assert.strictEqual(ctx.presetScopeLabel({ prompt: 'a', negative_prompt: 'b' }),
      '覆盖正向 · 负向（模板无此字段，保持不变）');

    ctx.placeholderValues = { prompt: 'P', negative_prompt: 'N' };
    assert.strictEqual(ctx.presetScopeLabel({ prompt: 'a', negative_prompt: 'b' }), '覆盖正向、负向');
    assert.strictEqual(ctx.presetScopeLabel({ prompt: 'a', negative_prompt: '' }), '覆盖正向、负向');
    assert.strictEqual(ctx.presetScopeLabel({}), '覆盖正向、负向 · 正负为空');

    ctx.applyPromptPresetContent({ positive: 'a', negative: '', label: '预设「x」' });
    assert.strictEqual(ctx.placeholderValues.prompt, 'a');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, '', '负向应被替换为空（覆盖范围包含负向）');
    assert.strictEqual(ctx.promptUndo.label, '预设「x」');
    ctx.undoPromptApply();
    assert.strictEqual(ctx.placeholderValues.prompt, 'P');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'N');
  });

  await test('预设/片段搜索匹配名称与真实正文', () => {
    const { ctx } = loadApp(createStorage());
    ctx.promptBlockPresets = [
      { id: 'local:p1', name: '人像', prompt: 'soft light', negative_prompt: 'blurry' },
      { id: 'local:p2', name: '风景', prompt: 'mountains', negative_prompt: 'fog' }
    ];
    ctx.promptPresetSearch = 'blurry';
    assert.deepStrictEqual(ctx.filteredPromptBlockPresets.map(p => p.name), ['人像']);
    ctx.promptPresetSearch = '风景';
    assert.deepStrictEqual(ctx.filteredPromptBlockPresets.map(p => p.name), ['风景']);

    ctx.promptSnippetPresets = [
      { id: 'local:s1', name: '画师串', text: 'artist:(x)' },
      { id: 'local:s2', name: '风格', text: 'watercolor' }
    ];
    ctx.promptPresetSearch = 'watercolor';
    assert.deepStrictEqual(ctx.filteredPromptSnippetPresets.map(s => s.name), ['风格']);
  });

  // ===== 3. 本地正文直接可用，不拿描述当正文 =====
  await test('本地资源库卡片直接给出真实正文，不发详情请求', () => {
    const { ctx, sandbox } = loadApp(createStorage());
    const fetchCalls = [];
    sandbox.fetch = () => { fetchCalls.push(1); return Promise.reject(new Error('no network')); };
    ctx.librarySource = 'local';
    ctx.libraryKind = 'snippet';
    ctx.promptSnippetPresets = [{ id: 'local:s1', name: '片段A', text: '真实正文A', target: 'negative' }];
    const items = ctx.libraryLocalItems;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, '真实正文A');
    assert.strictEqual(items[0].target, 'negative');
    const summary = ctx.buildLibrarySummary(items[0]);
    assert.strictEqual(summary.loaded, true);
    assert.strictEqual(summary.text, '真实正文A');
    assert.strictEqual(summary.target, 'negative');
    assert.strictEqual(fetchCalls.length, 0);

    ctx.libraryKind = 'preset';
    ctx.promptBlockPresets = [{ id: 'local:p1', name: '预设A', prompt: '正A', negative_prompt: '负A' }];
    const presetItem = ctx.libraryLocalItems[0];
    const presetSummary = ctx.buildLibrarySummary(presetItem);
    assert.strictEqual(presetSummary.positive, '正A');
    assert.strictEqual(presetSummary.negative, '负A');
  });

  await test('统一库卡片在详情加载前不把描述当正文，加载后用详情正文', async () => {
    const { ctx } = loadApp(createStorage());
    const item = {
      id: 'shared:s1', kind: 'snippet', name: '共享片段',
      description: '这里只是描述', publishedRevision: 2
    };
    ctx.catalogItems = [item];
    const before = ctx.buildLibrarySummary(item);
    assert.strictEqual(before.loaded, false);
    assert.strictEqual(before.text, '', '未加载时不能用描述冒充正文');

    const calls = [];
    ctx.fetchLibraryDetail = async target => {
      calls.push(target.id);
      return detailFor(target, { text: '真实共享正文', target: 'positive' });
    };
    const detail = await ctx.loadLibrarySummary(item);
    assert.strictEqual(detail.data.text, '真实共享正文');
    const after = ctx.buildLibrarySummary(item);
    assert.strictEqual(after.loaded, true);
    assert.strictEqual(after.text, '真实共享正文');
    assert.deepStrictEqual(calls, ['shared:s1']);
  });

  // ===== 4. 统一库按需加载：去重 / 限并发 / 按版本缓存 / 旧回包隔离 =====
  await test('统一库详情按需加载：去重、限并发、按 source/id/revision 缓存', async () => {
    const { ctx } = loadApp(createStorage());
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: 'shared:p' + i, kind: 'snippet', name: 'S' + i, publishedRevision: 1
    }));
    ctx.librarySource = 'shared';
    ctx.libraryKind = 'snippet';
    ctx.catalogItems = items;
    const calls = [];
    const inflight = { max: 0, current: 0 };
    ctx.fetchLibraryDetail = item => new Promise(resolve => {
      calls.push(item.id);
      inflight.current += 1;
      inflight.max = Math.max(inflight.max, inflight.current);
      setTimeout(() => {
        inflight.current -= 1;
        resolve(detailFor(item, { text: '正文-' + item.id }));
      }, 0);
    });

    ctx.ensureLibrarySummaries(items);
    ctx.ensureLibrarySummaries(items);
    assert.strictEqual(inflight.max, 2, '同时最多 2 个详情请求');
    await drain(ctx);
    assert.strictEqual(calls.length, 6, '每个条目只请求一次');
    assert.deepStrictEqual(calls.slice().sort(), items.map(i => i.id).sort(), '不重复请求');
    items.forEach(item => {
      const summary = ctx.buildLibrarySummary(item);
      assert.strictEqual(summary.loaded, true, item.id + ' 应已加载');
      assert.strictEqual(summary.text, '正文-' + item.id);
    });
    assert.strictEqual(Object.keys(ctx.libraryDetailCache).length, 6);
    assert.ok(Object.keys(ctx.libraryDetailCache).every(key => /@1$/.test(key)), '缓存键包含发布版本');
  });

  await test('旧版本回包不污染新版本展示', async () => {
    const { ctx } = loadApp(createStorage());
    const v1 = { id: 'shared:x', kind: 'snippet', name: 'X', publishedRevision: 1 };
    ctx.catalogItems = [v1];
    const resolvers = {};
    ctx.fetchLibraryDetail = item => new Promise(resolve => { resolvers[ctx.libraryDetailKey(item)] = resolve; });

    const first = ctx.loadLibrarySummary(v1);
    const v2 = { ...v1, publishedRevision: 2 };
    ctx.catalogItems = [v2];
    const second = ctx.loadLibrarySummary(v2);

    resolvers[ctx.libraryDetailKey(v2)](detailFor(v2, { text: 'new-body' }));
    await second;
    resolvers[ctx.libraryDetailKey(v1)](detailFor(v1, { text: 'old-body' }));
    await first;

    assert.strictEqual(ctx.buildLibrarySummary(v2).text, 'new-body', '新版本展示必须保持新正文');
    assert.strictEqual(ctx.buildLibrarySummary(v1).text, 'old-body', '旧版本详情只挂在旧版本键上');
    assert.notStrictEqual(ctx.libraryDetailKey(v1), ctx.libraryDetailKey(v2));
  });

  await test('详情返回版本不一致时拒绝写入并可重试', async () => {
    const { ctx } = loadApp(createStorage());
    const item = { id: 'shared:v', kind: 'preset', name: 'V', publishedRevision: 3 };
    ctx.catalogItems = [item];
    ctx.fetchLibraryDetail = async target => ({
      id: target.id, kind: target.kind, name: target.name,
      publishedRevision: 2,
      data: { positive: 'wrong', negative: '' }
    });
    await assert.rejects(() => ctx.loadLibrarySummary(item), /版本不一致/);
    const summary = ctx.buildLibrarySummary(item);
    assert.strictEqual(summary.loaded, false, '版本不符的正文不得显示');
    assert.ok(/版本不一致/.test(summary.error));

    ctx.fetchLibraryDetail = async target => detailFor(target, { positive: 'right', negative: 'n' });
    const detail = await ctx.retryLibrarySummary(item);
    assert.strictEqual(detail.data.positive, 'right');
    assert.strictEqual(ctx.buildLibrarySummary(item).positive, 'right');
    assert.strictEqual(ctx.buildLibrarySummary(item).error, '');
  });

  await test('详情加载失败记录错误并可在重试后恢复', async () => {
    const { ctx } = loadApp(createStorage());
    const item = { id: 'shared:fail', kind: 'snippet', name: 'F', publishedRevision: 1 };
    ctx.catalogItems = [item];
    ctx.fetchLibraryDetail = async () => { throw new Error('HTTP 503'); };
    await assert.rejects(() => ctx.loadLibrarySummary(item), /503/);
    assert.strictEqual(ctx.buildLibrarySummary(item).loaded, false);
    assert.ok(/503/.test(ctx.buildLibrarySummary(item).error));

    let attempts = 0;
    ctx.fetchLibraryDetail = async target => {
      attempts += 1;
      return detailFor(target, { text: '恢复正文' });
    };
    await ctx.retryLibrarySummary(item);
    assert.strictEqual(attempts, 1);
    assert.strictEqual(ctx.buildLibrarySummary(item).text, '恢复正文');
    await ctx.loadLibrarySummary(item);
    assert.strictEqual(attempts, 1, '已加载项不重复请求');
  });

  await test('可见分页有上限，显示更多才继续加载，不整库拉取', async () => {
    const { ctx } = loadApp(createStorage());
    const items = Array.from({ length: 60 }, (_, i) => ({
      id: 'shared:n' + i, kind: 'snippet', name: 'N' + i, publishedRevision: 1
    }));
    ctx.librarySource = 'shared';
    ctx.libraryKind = 'snippet';
    ctx.catalogItems = items;
    assert.strictEqual(ctx.libraryItems.length, 60);
    assert.strictEqual(ctx.libraryVisibleItems.length, 24, '默认只渲染有限页');
    assert.strictEqual(ctx.libraryRemainingCount, 36);

    const calls = [];
    ctx.fetchLibraryDetail = async item => {
      calls.push(item.id);
      return detailFor(item, { text: 'b-' + item.id });
    };
    ctx.ensureLibrarySummaries(ctx.libraryVisibleItems);
    await drain(ctx);
    assert.strictEqual(calls.length, 24, '只加载当前可见页');
    assert.strictEqual(Object.keys(ctx.libraryDetailCache).length, 24);

    ctx.showMoreLibraryItems();
    assert.strictEqual(ctx.libraryVisibleItems.length, 48);
    ctx.ensureLibrarySummaries(ctx.libraryVisibleItems);
    await drain(ctx);
    assert.strictEqual(calls.length, 48, '追加页只再加载新增可见项');
  });

  await test('搜索只覆盖名称与已加载正文，并给出范围说明', async () => {
    const { ctx } = loadApp(createStorage());
    const loaded = { id: 'shared:a', kind: 'snippet', name: 'A', description: '描述A', publishedRevision: 1 };
    const unloaded = { id: 'shared:b', kind: 'snippet', name: 'B', description: '油画描述', publishedRevision: 1 };
    ctx.librarySource = 'shared';
    ctx.libraryKind = 'snippet';
    ctx.catalogItems = [loaded, unloaded];
    ctx.libraryDetailCache = {
      [ctx.libraryDetailKey(loaded)]: detailFor(loaded, { text: '水彩 正文' })
    };

    ctx.librarySearch = '水彩';
    assert.deepStrictEqual(ctx.libraryItems.map(i => i.id), ['shared:a'], '已加载正文可被搜索');
    ctx.librarySearch = '油画';
    assert.deepStrictEqual(ctx.libraryItems.map(i => i.id), [], '未加载正文与描述不应被当正文搜索');
    ctx.librarySearch = '描述A';
    assert.deepStrictEqual(ctx.libraryItems.map(i => i.id), [], '描述不作为正文参与搜索');

    const note = ctx.librarySearchNote;
    assert.ok(/已加载/.test(note), '说明应提到只搜已加载正文');
    assert.ok(/不是全库/.test(note), '说明不得声称全库搜索');
  });

  // ===== 5. 预览弹窗：全文、复制、显式插入、键盘关闭与焦点恢复 =====
  await test('预览弹窗展示全文、可复制、可按指定字段插入并恢复焦点', async () => {
    const { ctx, focused, notices } = loadApp(createStorage());
    ctx.placeholderValues = { prompt: 'P', negative_prompt: 'N' };
    let copied = [];
    ctx.copyToClipboard = async text => { copied.push(text); return true; };

    ctx.openPromptPreview({
      kind: 'snippet', name: '片段A', sourceLabel: '本地片段', text: '完整正文', target: 'negative'
    });
    assert.strictEqual(ctx.showPromptPreview, true);
    assert.strictEqual(ctx.promptPreview.text, '完整正文');
    assert.strictEqual(ctx.promptPreview.target, 'negative');

    await ctx.copyPromptPreviewPart('text');
    assert.deepStrictEqual(copied, ['完整正文']);

    ctx.insertPromptPreviewPart('prompt');
    assert.strictEqual(ctx.placeholderValues.prompt, 'P, 完整正文', '显式插入正向');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'N', '负向不被默认目标污染');
    assert.strictEqual(ctx.showPromptPreview, false, '插入后关闭预览');
    assert.strictEqual(focused[focused.length - 1], 'prompt', '焦点回到目标字段');
    assert.ok(notices.some(n => /已应用/.test(n.message)));
  });

  await test('预览弹窗可取消、Esc 关闭并回到触发点', () => {
    const { ctx, document } = loadApp(createStorage());
    const trigger = { focusCalls: 0, focus() { this.focusCalls += 1; } };
    document.activeElement = trigger;
    ctx.openPromptPreview({ kind: 'preset', name: 'P', positive: '正', negative: '负' });
    ctx.onGlobalKeydown({ key: 'Escape', preventDefault() {} });
    assert.strictEqual(ctx.showPromptPreview, false);
    assert.strictEqual(trigger.focusCalls, 1, '关闭后焦点回到触发点');
    assert.strictEqual(ctx.promptPreview.name, '');
  });

  await test('统一库预览按需加载正文，失败可就地重试', async () => {
    const { ctx } = loadApp(createStorage());
    const item = { id: 'shared:pv', kind: 'preset', name: '共享预设', publishedRevision: 4 };
    ctx.catalogItems = [item];
    let attempt = 0;
    ctx.fetchLibraryDetail = async target => {
      attempt += 1;
      if (attempt === 1) throw new Error('HTTP 500');
      return detailFor(target, { positive: '正正文', negative: '负正文' });
    };

    await ctx.openLibraryPromptPreview(item);
    assert.strictEqual(ctx.showPromptPreview, true);
    assert.strictEqual(ctx.promptPreview.loading, false);
    assert.ok(/500/.test(ctx.promptPreview.error), '失败应显示错误');

    await ctx.retryPromptPreviewLoad();
    assert.strictEqual(ctx.promptPreview.error, '');
    assert.strictEqual(ctx.promptPreview.positive, '正正文');
    assert.strictEqual(ctx.promptPreview.negative, '负正文');
    assert.strictEqual(ctx.promptPreview.loading, false);
  });

  await test('应用入口同样拒绝版本/条目不一致的详情，不写缓存', async () => {
    const { ctx } = loadApp(createStorage());
    ctx.catalogItems = [{ id: 'shared:use', kind: 'snippet', name: 'U', publishedRevision: 5 }];
    const requests = [];
    ctx.requestCatalogDetail = async id => {
      requests.push(id);
      return { id: 'shared:other', kind: 'snippet', name: 'O', publishedRevision: 5, data: { text: 'wrong-id' } };
    };
    await assert.rejects(() => ctx.loadCatalogDetail('shared:use', 5), /其他条目/);
    assert.strictEqual(ctx.catalogDetails['shared:use'], undefined, '错条目不得写运行时缓存');

    ctx.requestCatalogDetail = async id => ({ id, kind: 'snippet', name: 'U', publishedRevision: 4, data: { text: 'stale' } });
    await assert.rejects(() => ctx.loadCatalogDetail('shared:use', 5), /版本不一致/);
    assert.strictEqual(ctx.catalogDetails['shared:use'], undefined, '旧版本不得写运行时缓存');
    assert.deepStrictEqual(requests, ['shared:use']);
  });

  await test('统一库片段加载期间切换模板则终止应用，不写新模板提示词', async () => {
    const { ctx, notices } = loadApp(createStorage());
    ctx.catalogItems = [{ id: 'shared:sw', kind: 'snippet', name: 'S', publishedRevision: 2 }];
    ctx.placeholderValues = { prompt: 'OLD', negative_prompt: '' };
    let resolveDetail;
    ctx.loadCatalogDetail = () => new Promise(resolve => { resolveDetail = resolve; });
    const pending = ctx.useCatalogSnippet({ id: 'shared:sw', kind: 'snippet', publishedRevision: 2 });

    // 加载期间切到另一个模板（字段集合变化）
    ctx.selectedTemplateId = 'local:other';
    ctx.placeholderValues = { prompt: 'NEW-TEMPLATE', negative_prompt: 'NEG' };
    resolveDetail({ id: 'shared:sw', kind: 'snippet', publishedRevision: 2, name: 'S', data: { text: 'old-snippet', target: 'positive' } });
    const ok = await pending;
    assert.strictEqual(ok, false);
    assert.strictEqual(ctx.placeholderValues.prompt, 'NEW-TEMPLATE', '新模板提示词不得被旧片段污染');
    assert.ok(notices.some(n => /模板已切换/.test(n.message)));
  });

  await test('统一库预设加载期间参数锁定则终止应用，不覆盖提示词', async () => {
    const { ctx, notices } = loadApp(createStorage());
    ctx.catalogItems = [{ id: 'shared:lp', kind: 'preset', name: 'P', publishedRevision: 3 }];
    ctx.placeholderValues = { prompt: 'KEEP', negative_prompt: 'KEEP-NEG' };
    let resolveDetail;
    ctx.loadCatalogDetail = () => new Promise(resolve => { resolveDetail = resolve; });
    const pending = ctx.useCatalogPreset({ id: 'shared:lp', kind: 'preset', publishedRevision: 3 });
    Object.defineProperty(ctx, 'isParamsLocked', { configurable: true, value: true });
    resolveDetail({ id: 'shared:lp', kind: 'preset', publishedRevision: 3, name: 'P', data: { positive: 'x', negative: 'y' } });
    const ok = await pending;
    assert.strictEqual(ok, false);
    assert.strictEqual(ctx.placeholderValues.prompt, 'KEEP');
    assert.strictEqual(ctx.placeholderValues.negative_prompt, 'KEEP-NEG');
    assert.ok(notices.some(n => /锁定|加载中/.test(n.message)));
  });

  await test('预览旧请求（含同条目关闭重开）不得覆盖新预览内容', async () => {
    const { ctx } = loadApp(createStorage());
    const itemA = { id: 'shared:a', kind: 'snippet', name: 'A', publishedRevision: 1 };
    const itemB = { id: 'shared:b', kind: 'snippet', name: 'B', publishedRevision: 1 };
    ctx.catalogItems = [itemA, itemB];
    const resolvers = {};
    ctx.fetchLibraryDetail = item => new Promise(resolve => {
      (resolvers[item.id] || (resolvers[item.id] = [])).push(resolve);
    });

    const pendingA = ctx.openLibraryPromptPreview(itemA);
    ctx.closePromptPreview({ restoreFocus: false });
    const pendingB = ctx.openLibraryPromptPreview(itemB);
    resolvers['shared:b'][0](detailFor(itemB, { text: 'B-body' }));
    await pendingB;
    assert.strictEqual(ctx.showPromptPreview, true);
    assert.strictEqual(ctx.promptPreview.text, 'B-body');

    resolvers['shared:a'][0](detailFor(itemA, { text: 'A-body' }));
    await pendingA;
    assert.strictEqual(ctx.promptPreview.name, 'B');
    assert.strictEqual(ctx.promptPreview.text, 'B-body', 'A 的旧回包不得写入 B 预览');

    // 同一条目关闭重开：token 变化后旧请求回包也不再写入
    ctx.closePromptPreview({ restoreFocus: false });
    const itemC = { id: 'shared:c', kind: 'snippet', name: 'C', publishedRevision: 1 };
    ctx.catalogItems = [itemC];
    const pendingC1 = ctx.openLibraryPromptPreview(itemC);
    ctx.closePromptPreview({ restoreFocus: false });
    ctx._libraryDetailPromises = {}; // 模拟重开后重新发起请求
    const pendingC2 = ctx.openLibraryPromptPreview(itemC);
    resolvers['shared:c'].forEach(resolve => resolve(detailFor(itemC, { text: 'C-fresh' })));
    await pendingC2;
    assert.strictEqual(ctx.promptPreview.text, 'C-fresh');
    ctx.closePromptPreview({ restoreFocus: false });
    await pendingC1;
    assert.strictEqual(ctx.showPromptPreview, false, '关闭后旧回包不得重新打开预览');
  });

  await test('模板加载路径（只传 expectedRevision，不传 kind）可正常取详情', async () => {
    const { ctx } = loadApp(createStorage());
    ctx.requestCatalogDetail = async id => ({
      id,
      kind: 'template',
      name: '模板',
      publishedRevision: 7,
      data: { workflow: { '1': { class_type: 'KSampler' } } }
    });
    const detail = await ctx.loadCatalogDetail('shared:tpl', 7);
    assert.strictEqual(detail.publishedRevision, 7);
    assert.ok(detail.data.workflow);

    // 传了 kind 时校验类型
    await assert.rejects(() => ctx.loadCatalogDetail('shared:tpl2', null, 'preset'), /不同类型的条目/);
  });

  await test('详情缺失 ID / 类型不符 / 版本缺失均拒绝写入', async () => {
    const { ctx } = loadApp(createStorage());
    const item = { id: 'shared:strict', kind: 'preset', name: 'S', publishedRevision: 2 };
    ctx.catalogItems = [item];

    const badDetails = [
      { kind: 'preset', name: 'S', publishedRevision: 2, data: { positive: 'x' } },
      { id: item.id, kind: 'snippet', name: 'S', publishedRevision: 2, data: { text: 'x' } },
      { id: item.id, kind: 'preset', name: 'S', data: { positive: 'x' } }
    ];
    for (const detail of badDetails) {
      const applied = ctx.applyLibraryDetail(item, ctx.libraryDetailKey(item), detail);
      assert.strictEqual(applied, null, '不合规详情不得写入');
      assert.strictEqual(ctx.buildLibrarySummary(item).loaded, false);
    }
    assert.strictEqual(Object.keys(ctx.libraryDetailCache).length, 0);
  });

  await test('内联重试再失败时只更新错误，不抛出未处理 Promise', async () => {
    const { ctx } = loadApp(createStorage());
    const item = { id: 'shared:retry', kind: 'snippet', name: 'R', publishedRevision: 1 };
    ctx.catalogItems = [item];
    ctx.fetchLibraryDetail = async () => { throw new Error('HTTP 502'); };
    await ctx.retryLibrarySummary(item);
    assert.strictEqual(ctx.buildLibrarySummary(item).loaded, false);
    assert.ok(/502/.test(ctx.buildLibrarySummary(item).error));
    const second = await ctx.retryLibrarySummary(item);
    assert.strictEqual(second, null, '重试失败应返回 null 而非拒绝');
    assert.ok(/502/.test(ctx.buildLibrarySummary(item).error));
  });

  // ===== 6. 安全与结构约束 =====
  await test('前台模板与脚本均不使用 v-html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
    assert.strictEqual(/v-html/.test(html), false, 'index.html 不得出现 v-html');
    assert.strictEqual(/v-html/.test(main), false, 'main.js 不得写入 v-html');
    assert.ok(/rp-preview-text/.test(html), '预览全文应使用纯文本容器');
  });

  const total = results.passed + results.failed;
  console.log(`\n${results.passed}/${total} passed`);
  if (results.failed > 0) process.exit(1);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
