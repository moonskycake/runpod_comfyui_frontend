/**
 * 工作区交互回归：运行 node tests/ui-workspace.test.js。
 * 捕获实际 Vue 选项，在无网络、无浏览器存储副作用的环境中验证状态行为。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorkspace({ desktop = true } = {}) {
  let options;
  const listeners = new Map();
  const scrolled = [];
  const classes = new Set();
  const document = {
    body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    getElementById(id) { return { scrollIntoView() { scrolled.push(id); } }; }
  };
  const sandbox = {
    console, document, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { userAgent: 'node' },
    Settings: {},
    matchMedia() { return { matches: desktop }; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    Vue: {
      createApp(captured) {
        options = captured;
        return { component() { return this; }, mount() { return this; } };
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'main.js' });
  const ctx = options.data();
  for (const [key, value] of Object.entries(options.methods)) ctx[key] = value.bind(ctx);
  for (const [key, value] of Object.entries(options.computed)) {
    Object.defineProperty(ctx, key, { configurable: true, get: () => value.call(ctx) });
  }
  ctx.$nextTick = fn => { if (fn) fn(); };
  ctx.$refs = {
    promptSidePanel: { scrollIntoView() { scrolled.push('prompts'); } },
    genLayout: { getBoundingClientRect() { return { left: 20, width: 1200 }; } }
  };
  return { ctx, listeners, scrolled, classes };
}

const records = () => [
  { id: 'done', status: 'COMPLETED', templateName: '人像', placeholderValues: { prompt: 'Soft LIGHT' }, images: [{ imageUrl: 'sample.png' }] },
  { id: 'submit', status: 'SUBMITTING', templateName: '人像', placeholderValues: {} },
  { id: 'queue', status: 'IN_QUEUE', templateName: '风景', placeholderValues: { prompt: 'mountains' } },
  { id: 'run', status: 'IN_PROGRESS', templateName: '风景', placeholderValues: { negative_prompt: 'BLUR' } },
  { id: 'fail', status: 'FAILED', templateName: '失败示例' },
  { id: 'timeout', status: 'TIMED_OUT', templateName: '超时示例' },
  { id: 'cancel', status: 'CANCELLED', templateName: '取消示例' }
];
const ids = ctx => Array.from(ctx.filteredHistoryRecords, r => r.id);
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (error) { failed++; console.error('not ok - ' + name); console.error(error.stack); }
}

test('提交、排队、运行均可从进行中筛选找到，取消不算失败', () => {
  const { ctx } = loadWorkspace();
  ctx.requestHistory = records();
  ctx.selectedHistoryId = 'done';
  ctx.historyFilter = 'running';
  assert.deepStrictEqual(ids(ctx), ['submit', 'queue', 'run']);
  ctx.historyFilter = 'failed';
  assert.deepStrictEqual(ids(ctx), ['fail', 'timeout']);
  ctx.historyFilter = 'cancelled';
  assert.deepStrictEqual(ids(ctx), ['cancel']);
  assert.strictEqual(ctx.selectedHistoryId, 'done');
  assert.strictEqual(ctx.requestHistory.length, 7);
});

test('历史搜索匹配名称、正负提示词，支持去空格与忽略大小写', () => {
  const { ctx } = loadWorkspace();
  ctx.requestHistory = records();
  ctx.historySearch = ' soft light ';
  assert.deepStrictEqual(ids(ctx), ['done']);
  ctx.historySearch = 'blur';
  assert.deepStrictEqual(ids(ctx), ['run']);
  ctx.historySearch = '风景';
  assert.deepStrictEqual(ids(ctx), ['queue', 'run']);
  ctx.historyFilter = 'running';
  ctx.historySearch = 'not present';
  assert.deepStrictEqual(ids(ctx), []);
});

test('清除历史筛选恢复列表，不改变当前请求或图片', () => {
  const { ctx } = loadWorkspace();
  ctx.requestHistory = records();
  ctx.selectedHistoryId = 'done';
  ctx.selectedHistoryImageIndex = 2;
  ctx.historyFilter = 'failed';
  ctx.historySearch = 'missing';
  ctx.clearHistoryFilters();
  assert.strictEqual(ids(ctx).length, 7);
  assert.strictEqual(ctx.hasActiveHistoryFilters, false);
  assert.strictEqual(ctx.selectedHistoryId, 'done');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 2);
});

test('工作区切换保留图库选择、片段搜索和历史筛选', () => {
  const { ctx } = loadWorkspace();
  ctx.resultsTab = 'gallery';
  ctx.selectedHistoryId = 'done';
  ctx.selectedGalleryIndex = 3;
  ctx.quickPromptSearch = 'lighting';
  ctx.historyFilter = 'completed';
  ctx.setRightPanelTab('prompts');
  ctx.setRightPanelTab('results');
  ctx.setRightPanelTab('invalid');
  assert.strictEqual(ctx.rightPanelTab, 'results');
  assert.strictEqual(ctx.resultsTab, 'gallery');
  assert.strictEqual(ctx.selectedGalleryIndex, 3);
  assert.strictEqual(ctx.selectedHistoryId, 'done');
  assert.strictEqual(ctx.quickPromptSearch, 'lighting');
  assert.strictEqual(ctx.historyFilter, 'completed');
});

test('手机结果入口从片段面板回到结果并展开', () => {
  const { ctx, scrolled } = loadWorkspace({ desktop: false });
  ctx.rightPanelTab = 'prompts';
  ctx.mobileResultsOpen = false;
  ctx.openResultsPanel();
  assert.strictEqual(ctx.rightPanelTab, 'results');
  assert.strictEqual(ctx.mobileResultsOpen, true);
  assert.deepStrictEqual(scrolled, ['results-section']);
});

test('提示词入口在窄屏定位片段，桌面保留页面位置', () => {
  for (const desktop of [true, false]) {
    const { ctx, scrolled } = loadWorkspace({ desktop });
    ctx.quickPromptSearch = 'light';
    ctx.openPromptSidePanel();
    assert.strictEqual(ctx.rightPanelTab, 'prompts');
    assert.strictEqual(ctx.quickPromptSearch, 'light');
    assert.deepStrictEqual(scrolled, desktop ? [] : ['prompts']);
  }
});

test('选择另一请求只复位图片索引，不重置历史搜索', () => {
  const { ctx } = loadWorkspace();
  ctx.historySearch = 'portrait';
  ctx.historyPanelOpen = true;
  ctx.selectedHistoryImageIndex = 2;
  ctx.selectHistoryRecord('run');
  assert.strictEqual(ctx.selectedHistoryId, 'run');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 0);
  assert.strictEqual(ctx.resultsTab, 'history');
  assert.strictEqual(ctx.historySearch, 'portrait');
});

test('任务显示覆盖提交中，无耗时不显示为零', () => {
  const { ctx } = loadWorkspace();
  assert.strictEqual(ctx.historyStatusLabel('SUBMITTING'), '提交中');
  assert.match(ctx.historyEmptyImageText({ status: 'SUBMITTING' }), /提交/);
  assert.strictEqual(ctx.formatDurationMs(null), '-');
  assert.strictEqual(ctx.formatDurationMs(undefined), '-');
  assert.strictEqual(ctx.formatDurationMs(0), '0ms');
  assert.strictEqual(ctx.formatDurationMs(1500), '1.5s');
});

test('隐藏生图页时调整窗口不重写用户分栏比例', () => {
  const { ctx } = loadWorkspace();
  ctx.mainView = 'library';
  ctx.genSplitRatio = 0.7;
  ctx.$refs.genLayout.getBoundingClientRect = () => ({ left: 0, width: 0 });
  ctx.onSplitViewportResize();
  assert.strictEqual(ctx.genSplitRatio, 0.7);
});

test('分栏拖到边缘仍保留编辑与结果最小宽度', () => {
  const { ctx } = loadWorkspace();
  ctx.setSplitRatio(-1);
  assert(ctx.genSplitRatio * 1200 >= 340);
  ctx.setSplitRatio(2);
  assert((1 - ctx.genSplitRatio) * 1200 >= 420);
  ctx.setSplitRatio(NaN);
  assert(Number.isFinite(ctx.genSplitRatio));
  ctx.resetSplitRatio();
  assert.strictEqual(ctx.genSplitRatio, 0.44);
});

test('分栏键盘可调整并复位，无关按键不拦截', () => {
  const { ctx } = loadWorkspace();
  let prevented = 0;
  const key = name => ctx.onSplitKeydown({ key: name, preventDefault() { prevented++; } });
  key('ArrowRight');
  assert(ctx.genSplitRatio > 0.44);
  key('ArrowLeft');
  assert(Math.abs(ctx.genSplitRatio - 0.44) < 0.0001);
  key('Home');
  assert.strictEqual(ctx.genSplitRatio, 0.44);
  key('Tab');
  assert.strictEqual(prevented, 3);
});

test('拖动期间窗口失焦会取消拖动并清理监听', () => {
  const { ctx, listeners, classes } = loadWorkspace();
  let focused = false;
  ctx.startSplitDrag({ button: 0, currentTarget: { focus() { focused = true; } }, preventDefault() {} });
  assert.strictEqual(focused, true);
  assert(listeners.has('blur'));
  listeners.get('blur')();
  assert.strictEqual(ctx.isSplitDragging, false);
  assert.strictEqual(listeners.size, 0);
  assert.strictEqual(classes.size, 0);
});

test('结束分栏拖动清理全局监听与拖动样式', () => {
  const { ctx, listeners, classes } = loadWorkspace();
  ctx.startSplitDrag({ button: 0, preventDefault() {} });
  assert.strictEqual(ctx.isSplitDragging, true);
  assert(listeners.has('pointermove'));
  ctx.endSplitDrag();
  assert.strictEqual(ctx.isSplitDragging, false);
  assert.strictEqual(listeners.size, 0);
  assert.strictEqual(classes.size, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
