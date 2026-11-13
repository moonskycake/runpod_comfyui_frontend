'use strict';
// 状态查询中断回归：真实 settings.js / runpod-client.js / history-store.js / main.js 在 vm 中运行。
// axios 由本文件替换，不访问网络、不调用真实 RunPod、不落盘。

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const { createFakeIndexedDB } = require('./support/fake-indexeddb');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT_CFG = {
  endpointId: 'ep-fixture',
  apiKey: 'not-real',
  baseUrl: 'https://api.runpod.ai/v2'
};

// harnessOptions:
//   indexedDB：可选，传入 createFakeIndexedDB() 让真实 history-store.js 走 IndexedDB 分支
//   （默认不注入，旧用例仍走“没有 indexedDB”的元数据分支）。
function createHarness(transport, harnessOptions) {
  const extra = harnessOptions || {};
  const storage = new Map();
  const calls = [];
  const setCalls = [];
  let vueOptions = null;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    navigator: { userAgent: 'node' },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { setCalls.push(key); storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    document: { getElementById() { return null; }, querySelector() { return null; } },
    axios: {
      get(url, config) {
        calls.push({ method: 'get', url, config });
        return transport('get', url, config);
      },
      post(url, body, config) {
        calls.push({ method: 'post', url, body, config });
        return transport('post', url, config, body);
      }
    },
    Vue: {
      createApp(captured) {
        vueOptions = captured;
        return { component() { return this; }, mount() {} };
      }
    }
  };
  if (extra.indexedDB) sandbox.indexedDB = extra.indexedDB;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/settings.js'), sandbox, { filename: 'settings.js' });
  vm.runInContext(read('js/runpod-client.js'), sandbox, { filename: 'runpod-client.js' });
  vm.runInContext(read('js/history-store.js'), sandbox, { filename: 'history-store.js' });
  vm.runInContext(read('js/main.js'), sandbox, { filename: 'main.js' });

  const ctx = vueOptions.data();
  for (const [key, value] of Object.entries(vueOptions.methods)) ctx[key] = value.bind(ctx);
  for (const [key, value] of Object.entries(vueOptions.computed)) {
    Object.defineProperty(ctx, key, { configurable: true, get: () => value.call(ctx) });
  }
  ctx.$nextTick = fn => { if (fn) fn(); return Promise.resolve(); };
  ctx.$refs = {};

  return {
    ctx,
    storage,
    calls,
    setCalls,
    sandbox,
    indexedDB: extra.indexedDB || null,
    settings: sandbox.Settings,
    client: sandbox.RunpodClient,
    historyStore: sandbox.HistoryStore
  };
}

function makeRecord(id, status, overrides = {}) {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status,
    runMode: 'run',
    endpointId: 'ep-fixture',
    jobId: '',
    templateId: '',
    templateName: 'fixture',
    workflowJson: '',
    placeholderValues: {},
    payloadSize: 2,
    imageCount: 0,
    delayTime: null,
    executionTime: null,
    errorMessage: '',
    interruptReason: '',
    interruptStage: '',
    interruptedAt: null,
    deletedImages: [],
    images: [],
    ...overrides
  };
}

function makeTask(historyId, overrides = {}) {
  return {
    taskId: `task-${historyId}`,
    historyId,
    runMode: 'run',
    initialPollDelayMs: 0,
    pollIntervalMs: 5,
    clientConfig: { ...CLIENT_CFG, statusTimeoutMs: 20 },
    payload: { input: { tag: historyId } },
    cancelRequested: false,
    jobId: '',
    ...overrides
  };
}

function baseFixture(ctx, records) {
  ctx.requestHistory = records;
  ctx.queuePersistHistory = () => {};
  ctx.persistHistoryNow = async () => {};
  ctx.reanchorImageSelections = () => {};
  const toasts = [];
  ctx.showUiToast = (...args) => toasts.push(args);
  return { toasts };
}

// 状态查询：按 axios 自身超时语义延迟拒绝（模拟真实网络无响应）。
function timingOutStatusTransport() {
  return (method, url, config) => {
    if (url.includes('/status/')) {
      return new Promise((resolve, reject) => {
        setTimeout(() => reject({
          code: 'ECONNABORTED',
          message: `timeout of ${config.timeout}ms exceeded`,
          config
        }), config.timeout);
      });
    }
    return Promise.resolve({ data: { id: 'job-1', status: 'IN_QUEUE' } });
  };
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ---------- 1：查询超时 → QUERY_INTERRUPTED ----------
test('状态查询超时记为查询中断，不冒充远端 FAILED，保留 jobId 与原因', async () => {
  const harness = createHarness(timingOutStatusTransport());
  const { ctx } = harness;
  baseFixture(ctx, [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-7' })]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1', { jobId: 'job-7' });
  await ctx.pollExistingJob(task, 'h1', 'job-7', task.clientConfig);

  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'QUERY_INTERRUPTED', '查询失败不是远端任务失败');
  assert.strictEqual(record.jobId, 'job-7', '原 jobId 必须保留以便恢复');
  assert.strictEqual(record.interruptStage, 'poll');
  assert.strictEqual(record.interruptReason, 'timeout');
  assert.ok(Number.isFinite(record.interruptedAt), '记录中断时间');
  assert.match(record.errorMessage, /查询中断/);
  assert.match(record.errorMessage, /可恢复/);
  assert.match(record.errorMessage, /未判定为生成失败/);
  assert.match(record.errorMessage, /超时/);
  assert.strictEqual(ctx.errorMessage, record.errorMessage, '当前查看的记录在顶部显示原因');
});

// ---------- 2：恢复只轮询原 job ----------
test('恢复查询用最新超时设置继续轮询原 Job，不重新提交', async () => {
  let statusCalls = 0;
  let runCalls = 0;
  const harness = createHarness((method, url) => {
    if (method === 'post' && /\/run$/.test(url)) {
      runCalls++;
      return Promise.resolve({ data: { id: 'job-new', status: 'IN_QUEUE' } });
    }
    if (url.includes('/status/')) {
      statusCalls++;
      return Promise.resolve({
        data: {
          status: 'COMPLETED',
          executionTime: 7,
          output: { images: [{ type: 'base64', data: 'aGk=' }] }
        }
      });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx } = harness;
  baseFixture(ctx, [makeRecord('h1', 'QUERY_INTERRUPTED', {
    jobId: 'job-9',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now() - 1000,
    errorMessage: '查询中断，可恢复：状态查询超时'
  })]);
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;
  ctx.settings = { ...ctx.settings, statusTimeoutMs: 45000 };
  ctx.getEffectivePollIntervalMs = () => 5;

  let started = null;
  let running = null;
  ctx.startTask = task => { started = task; running = ctx.runTask(task); };

  ctx.retryHistoryRecord('h1');

  assert.ok(started, '恢复会启动轮询任务');
  assert.strictEqual(started.pollOnly, true, '恢复必须 pollOnly');
  assert.strictEqual(started.jobId, 'job-9', '沿用原 jobId');
  assert.strictEqual(started.payload, null, '恢复不携带新提交载荷');
  assert.strictEqual(started.clientConfig.statusTimeoutMs, 45000, '恢复查询使用最新设置');

  await running;

  assert.strictEqual(runCalls, 0, '恢复不得调用 /run');
  assert.ok(statusCalls >= 1, '只发起状态查询');
  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'COMPLETED');
  assert.strictEqual(record.interruptReason, '');
  assert.strictEqual(record.interruptStage, '');
  assert.strictEqual(record.interruptedAt, null, '恢复成功后清除中断信息');
  assert.strictEqual(record.images.length, 1);
});

// ---------- 3：远端终态不放开 ----------
test('远端 FAILED / TIMED_OUT 仍是终态，不提供恢复查询', async () => {
  for (const terminal of ['FAILED', 'TIMED_OUT']) {
    const harness = createHarness(() => Promise.resolve({ data: { status: terminal } }));
    const { ctx } = harness;
    baseFixture(ctx, [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-7' })]);
    ctx.selectedHistoryId = 'h1';
    ctx.isConfigValid = true;

    const task = makeTask('h1', { jobId: 'job-7' });
    await ctx.pollExistingJob(task, 'h1', 'job-7', task.clientConfig);

    const record = ctx.requestHistory[0];
    assert.strictEqual(record.status, terminal, `${terminal} 保持不变`);
    assert.strictEqual(record.interruptReason, '');
    const state = ctx.getManualRetryState(record);
    assert.strictEqual(state.ok, false, `${terminal} 不可恢复`);
    assert.match(state.reason, /已结束/);
  }
});

// ---------- 4：无 jobId ----------
test('无 jobId 时给出正文可见原因并提示控制台核对重复提交风险', () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx } = harness;
  ctx.isConfigValid = true;

  const noJob = makeRecord('q', 'QUERY_INTERRUPTED', {
    interruptReason: 'timeout',
    interruptStage: 'poll'
  });
  ctx.requestHistory = [noJob];

  const state = ctx.getManualRetryState(noJob);
  assert.strictEqual(state.ok, false);
  assert.match(state.reason, /Job ID/);
  assert.match(state.reason, /控制台/);
  assert.match(state.reason, /重复提交/);
  assert.strictEqual(ctx.getManualRetryBlockedReason(noJob), state.reason, '禁用原因可在正文展示');
  assert.strictEqual(ctx.canManualRetryRecord(noJob), false);

  const ready = makeRecord('ok', 'QUERY_INTERRUPTED', { jobId: 'job-1' });
  ctx.requestHistory = [ready];
  assert.strictEqual(ctx.canManualRetryRecord(ready), true);
  assert.strictEqual(ctx.getManualRetryBlockedReason(ready), '', '可用时不显示禁用原因');

  const done = makeRecord('done', 'COMPLETED', { jobId: 'job-1' });
  ctx.requestHistory = [done];
  assert.strictEqual(ctx.canManualRetryRecord(done), false);
  assert.strictEqual(ctx.getManualRetryBlockedReason(done), '', '已结束的记录不刷正文噪声');
});

// ---------- 5：HTTP 429/5xx/401 与远端 FAILED 区分 ----------
test('HTTP 429/500/401 属于查询中断，远端 FAILED 才算任务失败', async () => {
  const expectations = [
    { status: 429, text: /429/ },
    { status: 500, text: /500/ },
    { status: 401, text: /401/ },
    { status: 404, text: /404/ }
  ];

  for (const item of expectations) {
    const harness = createHarness(() => Promise.reject({
      response: { status: item.status, data: { error: 'fixture' } }
    }));
    const { ctx } = harness;
    baseFixture(ctx, [makeRecord('h1', 'IN_QUEUE', { jobId: 'job-7' })]);
    ctx.selectedHistoryId = 'h1';
    ctx.isConfigValid = true;

    const task = makeTask('h1', { jobId: 'job-7' });
    await ctx.pollExistingJob(task, 'h1', 'job-7', task.clientConfig);

    const record = ctx.requestHistory[0];
    assert.strictEqual(record.status, 'QUERY_INTERRUPTED', `HTTP ${item.status} 不记为 FAILED`);
    assert.strictEqual(record.interruptReason, `http_${item.status}`);
    assert.match(record.errorMessage, item.text);
    assert.match(record.errorMessage, /查询中断/);
    assert.strictEqual(ctx.canManualRetryRecord(record), true, '有 jobId 即可恢复查询');
  }

  // 404 需指到“端点/Job 不存在”而不是泛指的“查询失败”
  const notFound = createHarness(() => Promise.reject({ response: { status: 404 } }));
  baseFixture(notFound.ctx, [makeRecord('h1', 'IN_QUEUE', { jobId: 'job-7' })]);
  notFound.ctx.selectedHistoryId = 'h1';
  await notFound.ctx.pollExistingJob(makeTask('h1', { jobId: 'job-7' }), 'h1', 'job-7', CLIENT_CFG);
  assert.match(notFound.ctx.requestHistory[0].errorMessage, /端点或 Job 不存在/, '404 提示核对 Endpoint/Job');

  const harness = createHarness(() => Promise.resolve({ data: { status: 'FAILED' } }));
  const { ctx } = harness;
  baseFixture(ctx, [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-7' })]);
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;
  await ctx.pollExistingJob(makeTask('h1', { jobId: 'job-7' }), 'h1', 'job-7', CLIENT_CFG);

  const remoteFailed = ctx.requestHistory[0];
  assert.strictEqual(remoteFailed.status, 'FAILED');
  assert.strictEqual(remoteFailed.interruptReason, '', '远端失败不写中断原因');
});

// ---------- 6：序列化 / 落库保持中断信息 ----------
test('刷新后序列化与 history-store 落库保留中断原因', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  const interruptedAt = Date.now() - 500;
  ctx.requestHistory = [makeRecord('h1', 'QUERY_INTERRUPTED', {
    jobId: 'job-9',
    interruptReason: 'http_500',
    interruptStage: 'poll',
    interruptedAt,
    errorMessage: '查询中断，可恢复：RunPod 服务暂时不可用（HTTP 500）'
  })];

  const serialized = ctx.serializeHistoryForStore();
  assert.strictEqual(serialized[0].status, 'QUERY_INTERRUPTED');
  assert.strictEqual(serialized[0].interruptReason, 'http_500');
  assert.strictEqual(serialized[0].interruptStage, 'poll');
  assert.strictEqual(serialized[0].interruptedAt, interruptedAt);

  await historyStore.save({ records: serialized, favorites: [] });
  const loaded = await historyStore.load();

  assert.strictEqual(loaded.records.length, 1);
  const restored = loaded.records[0];
  assert.strictEqual(restored.status, 'QUERY_INTERRUPTED');
  assert.strictEqual(restored.jobId, 'job-9');
  assert.strictEqual(restored.interruptReason, 'http_500');
  assert.strictEqual(restored.interruptStage, 'poll');
  assert.strictEqual(restored.interruptedAt, interruptedAt);
  assert.strictEqual(restored.errorMessage, '查询中断，可恢复：RunPod 服务暂时不可用（HTTP 500）');
  assert.ok(!String(storage.get('runpod_request_history_v1')).includes('not-real'), '不落库 API Key');
});

// ---------- 7：文案 / badge / 筛选 ----------
test('查询中断有独立文案、badge、筛选分组与空图提示', () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx } = harness;
  ctx.requestHistory = [
    makeRecord('done', 'COMPLETED'),
    makeRecord('run', 'IN_PROGRESS'),
    makeRecord('q', 'QUERY_INTERRUPTED', { jobId: 'job-1' })
  ];

  assert.strictEqual(ctx.historyStatusLabel('QUERY_INTERRUPTED'), '查询中断');
  assert.notStrictEqual(
    ctx.getStatusBadgeClass('QUERY_INTERRUPTED'),
    ctx.getStatusBadgeClass('FAILED'),
    '中断与失败区分颜色'
  );
  assert.strictEqual(ctx.historyStatusGroup('QUERY_INTERRUPTED'), 'interrupted');
  assert.ok(
    ctx.historyFilterOptions.some(o => o.value === 'interrupted'),
    '筛选提供中断分组'
  );

  ctx.historyFilter = 'interrupted';
  assert.deepStrictEqual(Array.from(ctx.filteredHistoryRecords, r => r.id), ['q']);
  ctx.historyFilter = 'running';
  assert.deepStrictEqual(Array.from(ctx.filteredHistoryRecords, r => r.id), ['run']);
  ctx.historyFilter = 'failed';
  assert.deepStrictEqual(Array.from(ctx.filteredHistoryRecords, r => r.id), []);

  assert.match(ctx.historyEmptyImageText({ status: 'QUERY_INTERRUPTED' }), /恢复查询/);
});

// ---------- 8：设置面板 → 持久化 → 客户端 ----------
test('设置面板以秒编辑状态查询超时，钳制后持久化并透传到请求配置', () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, storage, settings } = harness;
  ctx.updateConnectionStatus = () => {};
  ctx.pumpQueue = () => {};

  ctx.openSettings();
  assert.strictEqual(ctx.settingsForm.statusTimeoutSeconds, 20, '默认显示 20 秒');

  ctx.settingsForm.statusTimeoutSeconds = 45;
  ctx.saveSettings();
  assert.strictEqual(settings.get().statusTimeoutMs, 45000);
  assert.strictEqual(storage.get('runpod_status_timeout_ms'), '45000');
  assert.strictEqual(ctx.getClientConfigSnapshot().statusTimeoutMs, 45000);

  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 999;
  ctx.saveSettings();
  assert.strictEqual(ctx.settings.statusTimeoutMs, 120000, '上限 120 秒');

  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 1;
  ctx.saveSettings();
  assert.strictEqual(ctx.settings.statusTimeoutMs, 5000, '下限 5 秒');

  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 'abc';
  ctx.saveSettings();
  assert.strictEqual(ctx.settings.statusTimeoutMs, 20000, '无效值回退默认');

  // v-model.number 清空输入框时得到空字符串（Number('') === 0），必须按默认 20 秒处理
  ctx.openSettings();
  assert.strictEqual(ctx.settingsForm.statusTimeoutSeconds, 20, '清空后重开显示默认 20 秒');
  ctx.settingsForm.statusTimeoutSeconds = '';
  ctx.saveSettings();
  assert.strictEqual(ctx.settings.statusTimeoutMs, 20000, '空输入回退默认 20 秒');

  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = '   ';
  ctx.saveSettings();
  assert.strictEqual(ctx.settings.statusTimeoutMs, 20000, '空白字符串回退默认 20 秒');
});

test('未配置 Endpoint/API Key 时恢复被禁用且正文可见原因', () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx } = harness;
  // 默认 isConfigValid = false
  const interrupted = makeRecord('h1', 'QUERY_INTERRUPTED', { jobId: 'job-9' });
  const running = makeRecord('h2', 'IN_PROGRESS', { jobId: 'job-10' });
  ctx.requestHistory = [interrupted, running];

  for (const record of [interrupted, running]) {
    const state = ctx.getManualRetryState(record);
    assert.strictEqual(state.ok, false, `${record.status} 缺配置不可恢复`);
    assert.match(state.reason, /配置/);
    assert.strictEqual(ctx.canManualRetryRecord(record), false);
  }

  // 正文警告只在“查询中断需用户行动”时出现：正常处理中不刷噪声
  assert.strictEqual(
    ctx.getManualRetryBlockedReason(interrupted),
    ctx.getManualRetryState(interrupted).reason,
    '查询中断缺配置的原因需在正文可见'
  );
  assert.strictEqual(ctx.getManualRetryBlockedReason(running), '', '正常处理中不显示警告横幅');

  ctx.isConfigValid = true;
  assert.strictEqual(ctx.canManualRetryRecord(interrupted), true, '配好配置后即可恢复');
  assert.strictEqual(ctx.getManualRetryBlockedReason(interrupted), '');
});

test('状态查询超时只作用于 /status，提交与 runsync 超时不变', async () => {
  const harness = createHarness(() => Promise.resolve({ data: { id: 'job-1', status: 'IN_QUEUE' } }));
  const cfg = { endpointId: 'ep-fixture', apiKey: 'not-real', statusTimeoutMs: 5000 };

  await harness.client.run({ input: {} }, cfg);
  await harness.client.status('job-1', cfg);
  await harness.client.runSync({ input: {} }, 90000, cfg);

  const [runCall, statusCall, syncCall] = harness.calls;
  assert.strictEqual(runCall.config.timeout, 60000, '提交超时不受影响');
  assert.strictEqual(statusCall.config.timeout, 5000, '状态查询使用设置值');
  assert.strictEqual(syncCall.config.timeout, 120000, 'runsync 仍按 wait + 缓冲');
});

// ---------- 9：提交超时文案 ----------
test('提交超时不承诺恢复，提示控制台核对重复提交风险', async () => {
  const harness = createHarness((method, url, config) => {
    if (method === 'post' && /\/run$/.test(url)) {
      return new Promise((resolve, reject) => {
        setTimeout(() => reject({
          code: 'ECONNABORTED',
          message: `timeout of ${config.timeout}ms exceeded`,
          config
        }), config.timeout);
      });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx } = harness;
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;

  const task = makeTask('h1', { clientConfig: { ...CLIENT_CFG, runTimeoutMs: 20 } });
  await ctx.runTask(task);

  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'FAILED');
  assert.strictEqual(record.jobId, '');
  assert.match(record.errorMessage, /提交请求超时/);
  assert.match(record.errorMessage, /控制台/);
  assert.match(record.errorMessage, /重复提交/);
  assert.doesNotMatch(record.errorMessage, /恢复查询|可恢复/, '提交超时不承诺可恢复');
  assert.strictEqual(ctx.getManualRetryState(record).ok, false);
});

// ---------- 11：远端 CANCELLED ≠ 用户取消 ----------
test('远端 CANCELLED 不误记为“用户取消”，提示可能在其他端取消', async () => {
  const harness = createHarness((method, url) => {
    if (url.includes('/status/')) return Promise.resolve({ data: { status: 'CANCELLED' } });
    return Promise.resolve({ data: {} });
  });
  const { ctx } = harness;
  baseFixture(ctx, [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-7' })]);
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;

  const task = makeTask('h1', { jobId: 'job-7' });
  await ctx.pollExistingJob(task, 'h1', 'job-7', task.clientConfig);

  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'CANCELLED');
  assert.doesNotMatch(record.errorMessage, /用户取消/, '远端取消不得冒充本地用户取消');
  assert.match(record.errorMessage, /远端任务已取消/);
  assert.match(record.errorMessage, /控制台/);
  assert.strictEqual(record.interruptReason, '', '远端终态不写查询中断原因');
  assert.strictEqual(task.cancelRequested, false);
});

// ---------- 12：/status HTTP 200 但响应无效 → protocol 错误 ----------
test('HTTP 200 但缺少/未知 status 返回 protocol 错误：不写状态、不无限轮询、释放 activeJobs', async () => {
  const badPayloads = [
    { label: '空 data', data: null },
    { label: '空对象', data: {} },
    { label: '未知 status', data: { status: 'SUPER_RUNNING' } },
    { label: '带空格的已知 status', data: { status: ' IN_PROGRESS ' } },
    { label: 'HTML 响应', data: '<html><body>502 Bad Gateway</body></html>' }
  ];

  // 校验器：已知状态必须原样（不 trim），否则 onStatus 会写入未知分组
  const { client: probe } = createHarness(() => Promise.resolve({ data: {} }));
  assert.strictEqual(probe.readPollStatus({ status: 'IN_PROGRESS' }), 'IN_PROGRESS');
  assert.strictEqual(probe.readPollStatus({ status: ' IN_PROGRESS ' }), '', '不做 trim：带空格不得通过校验');
  assert.strictEqual(probe.readPollStatus({ status: 'in_progress' }), '', '不做大小写归一');

  for (const item of badPayloads) {
    let statusCalls = 0;
    let runCalls = 0;
    const harness = createHarness((method, url) => {
      if (url.includes('/status/')) {
        statusCalls++;
        return Promise.resolve({ data: item.data });
      }
      if (/\/run$/.test(url)) {
        runCalls++;
        return Promise.resolve({ data: { id: 'job-new', status: 'IN_QUEUE' } });
      }
      return Promise.resolve({ data: {} });
    });
    const { ctx, client } = harness;
    baseFixture(ctx, [makeRecord('h1', 'IN_QUEUE', { jobId: 'job-7' })]);
    ctx.selectedHistoryId = 'h1';
    ctx.isConfigValid = true;
    ctx.getEffectivePollIntervalMs = () => 5;

    // 客户端层：明确 protocol 错误，且不把无效 data 当成功返回
    const clientResult = await client.poll('job-7', { intervalMs: 5 }, CLIENT_CFG);
    assert.strictEqual(clientResult.success, false, `${item.label}:poll 不得返回 success`);
    assert.strictEqual(clientResult.errorKind, 'protocol', `${item.label}:标记 protocol`);
    assert.strictEqual(statusCalls, 1, `${item.label}:GET 次数有限，不继续轮询`);

    // main 层：记为 QUERY_INTERRUPTED 且可恢复，activeJobs 释放，不自动重新 run
    statusCalls = 0;
    const task = makeTask('h1', { jobId: 'job-7', pollOnly: true, payload: null });
    ctx.startTask(task);
    for (let i = 0; i < 100 && ctx.activeJobs.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const record = ctx.requestHistory[0];
    assert.strictEqual(ctx.activeJobs.length, 0, `${item.label}:activeJobs 必须在 finally 释放`);
    assert.strictEqual(record.status, 'QUERY_INTERRUPTED', `${item.label}:无效响应不是交易失败也不是运行中`);
    assert.strictEqual(record.interruptReason, 'protocol', `${item.label}:原因码 protocol`);
    assert.strictEqual(record.interruptStage, 'poll');
    assert.strictEqual(record.jobId, 'job-7', `${item.label}:保留 jobId 以便恢复`);
    assert.match(record.errorMessage, /查询中断/);
    assert.match(record.errorMessage, /可恢复/);
    assert.match(record.errorMessage, /status|响应/);
    assert.strictEqual(runCalls, 0, `${item.label}:不得为异常响应自动重新提交`);
    assert.strictEqual(statusCalls, 1, `${item.label}:main 层同样只发一次 GET`);
    assert.strictEqual(ctx.canManualRetryRecord(record), true, `${item.label}:可恢复查询`);
  }
});

// ---------- 13：正常处理中不显示恢复警告 ----------
test('正常运行/提交中不显示恢复警告横幅，active 原因用中性文案', () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx } = harness;
  ctx.isConfigValid = true;

  const running = makeRecord('run', 'IN_PROGRESS', { jobId: 'job-1' });
  const submitting = makeRecord('sub', 'SUBMITTING');
  ctx.requestHistory = [running, submitting];
  ctx.activeJobs = [
    { taskId: 't-run', historyId: 'run' },
    { taskId: 't-sub', historyId: 'sub' }
  ];

  assert.match(
    ctx.getManualRetryState(running).reason,
    /正在查询|处理中/,
    'active 原因描述当前状态，而不是“恢复查询中”'
  );
  assert.doesNotMatch(ctx.getManualRetryState(running).reason, /恢复查询中/);
  assert.strictEqual(ctx.getManualRetryBlockedReason(running), '', '正常处理中不刷警告正文');
  assert.strictEqual(ctx.getManualRetryBlockedReason(submitting), '', '正常提交中不刷警告正文');

  // 中断后缺配置 / 缺 jobId 的正文原因必须保留
  const interruptedNoConfig = makeRecord('i1', 'QUERY_INTERRUPTED', { jobId: 'job-9' });
  ctx.requestHistory = [interruptedNoConfig];
  ctx.isConfigValid = false;
  assert.match(ctx.getManualRetryBlockedReason(interruptedNoConfig), /配置/);

  ctx.isConfigValid = true;
  const interruptedNoId = makeRecord('i2', 'QUERY_INTERRUPTED');
  ctx.requestHistory = [interruptedNoId];
  assert.match(ctx.getManualRetryBlockedReason(interruptedNoId), /Job ID/);
  assert.match(ctx.getManualRetryBlockedReason(interruptedNoId), /重复提交/);
});

// ---------- 14：提交失败按 errorKind 分类 ----------
test('提交失败按 errorKind 分类：HTTP 业务错误原样保留，无 HTTP 响应提示控制台核对', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, client } = harness;

  // HTTP 业务错误：原样保留，不追加控制台/重复提交提示
  for (const httpError of [
    { status: 429, message: '请求过于频繁，请稍后重试' },
    { status: 500, message: '服务器内部错误' },
    { status: 404, message: '端点不存在' }
  ]) {
    const formatted = client.formatError({ response: { status: httpError.status, data: {} } });
    assert.strictEqual(formatted.errorKind, 'http', `HTTP ${httpError.status} 标记为 http`);
    const text = ctx.buildSubmitFailureMessage(formatted);
    assert.strictEqual(text, httpError.message, `HTTP ${httpError.status} 原样保留业务文案`);
    assert.doesNotMatch(text, /控制台|未拿到 Job ID/);
  }

  // 无 HTTP 响应（含 axios“Request aborted”这类不含 network/socket 字样的错误）都要提示核对
  const abortedError = client.formatError({
    code: 'ECONNABORTED',
    message: 'Request aborted',
    config: { timeout: 0 }
  });
  assert.strictEqual(abortedError.errorKind, 'network', 'ECONNABORTED 但非超时：网络类');
  const abortedText = ctx.buildSubmitFailureMessage(abortedError);
  assert.match(abortedText, /未拿到 Job ID/);
  assert.match(abortedText, /控制台/);
  assert.match(abortedText, /重复提交/);
  assert.doesNotMatch(abortedText, /可恢复/);

  // 真实网络失败
  const networkError = client.formatError({ message: 'Network Error' });
  assert.strictEqual(networkError.errorKind, 'network');
  assert.match(ctx.buildSubmitFailureMessage(networkError), /控制台/);

  // HTTP 200 但提交响应缺 id：等同“未拿到 Job ID”，提示核对控制台
  const protocolText = ctx.buildSubmitFailureMessage({
    success: false,
    errorKind: 'protocol',
    status: null,
    message: '提交响应缺少 job id'
  });
  assert.match(protocolText, /未拿到 Job ID/);
  assert.match(protocolText, /控制台/);
  assert.doesNotMatch(protocolText, /网络中断|超时/);

  // 超时：保留超时原因，同样提示核对
  const timeoutError = client.formatError({
    code: 'ECONNABORTED',
    message: 'timeout of 20000ms exceeded',
    config: { timeout: 20000 }
  });
  assert.strictEqual(timeoutError.errorKind, 'timeout');
  const timeoutText = ctx.buildSubmitFailureMessage(timeoutError);
  assert.match(timeoutText, /提交请求超时/);
  assert.match(timeoutText, /20/);
  assert.match(timeoutText, /控制台/);
});

// ---------- 15：持久化竞态（真实 persistHistoryNow + 真实 HistoryStore.save） ----------
// 只把 HistoryStore.save 包一层：先执行真实 save（localStorage 同步落盘），
// 再用可控 Promise 挂住回包，模拟“IndexedDB 裁剪较慢，旧快照回包迟到”。
function gateHistoryStoreSaves(historyStore, gateCount) {
  const original = historyStore.save;
  const entries = [];
  historyStore.save = async function (state) {
    const pruned = await original.call(historyStore, state);
    const entry = { snapshot: state, pruned, released: false, release: null };
    entry.gate = new Promise(resolve => {
      entry.release = () => { entry.released = true; resolve(); };
    });
    entries.push(entry);
    if (entries.length <= gateCount) await entry.gate;
    return entry.pruned;
  };
  return entries;
}

function diskRecordsOf(historyStore, storage) {
  const raw = storage.get(historyStore.HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function waitForCondition(condition, label, tries = 600) {
  for (let i = 0; i < tries; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}`);
}

// 等持久化链（含 finally 里的自我清理与后续入链）彻底收敛，不 stub 被测方法。
async function settlePersist(ctx, tries = 400) {
  let lastPending = null;
  let samePending = 0;
  for (let i = 0; i < tries; i++) {
    const pending = ctx._historyPersistPromise;
    if (!pending) return;
    if (pending === lastPending) {
      samePending++;
      if (samePending > 100) return;
    } else {
      lastPending = pending;
      samePending = 0;
    }
    await pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('持久化链未收敛');
}

function persistFixture(ctx) {
  // 保留真实 persistHistoryNow / applyPruned* / ensureResultsSelection，仅关掉 400ms 自动 timer
  ctx.queuePersistHistory = () => {};
  ctx.showUiToast = () => {};
  ctx.reanchorImageSelections = () => {};
}

test('回归：恢复查询成功后，旧的中断快照回包不得把 COMPLETED 覆盖回查询中断', async () => {
  const harness = createHarness((method, url) => {
    if (url.includes('/status/')) {
      return Promise.resolve({
        data: {
          status: 'COMPLETED',
          executionTime: 7,
          output: { images: [{ type: 'base64', data: 'aGk=' }] }
        }
      });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.requestHistory = [makeRecord('h1', 'QUERY_INTERRUPTED', {
    jobId: 'job-9',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now() - 1000,
    errorMessage: '查询中断，可恢复：状态查询超时'
  })];
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;
  ctx.getEffectivePollIntervalMs = () => 5;

  const entries = gateHistoryStoreSaves(historyStore, 1);

  // 旧快照（QUERY_INTERRUPTED）已落盘，回包被挂住
  const stalePersist = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照 save 已发起');
  assert.strictEqual(diskRecordsOf(historyStore, storage)[0].status, 'QUERY_INTERRUPTED', '旧快照先落盘');

  // 用户点“恢复查询”，/status 返回 COMPLETED（带图）
  ctx.retryHistoryRecord('h1');
  await waitForCondition(
    () => ctx.requestHistory[0].status === 'COMPLETED' && ctx.requestHistory[0].images.length === 1,
    '恢复查询拿到 COMPLETED'
  );

  // 旧回包这时才到
  entries[0].release();
  await stalePersist;
  await waitForCondition(() => ctx.activeJobs.length === 0, 'activeJobs 释放');
  await settlePersist(ctx);

  assert.strictEqual(ctx.requestHistory[0].status, 'COMPLETED', '内存不得回退到旧快照的查询中断');
  assert.strictEqual(ctx.requestHistory[0].images.length, 1, '内存图片不得被旧快照清空');
  assert.strictEqual(ctx.requestHistory[0].interruptReason, '', '中断原因已清除');
  assert.strictEqual(ctx.requestHistory[0].interruptedAt, null);

  const disk = diskRecordsOf(historyStore, storage);
  assert.strictEqual(disk[0].status, 'COMPLETED', '落盘必须是 COMPLETED');
  assert.strictEqual(disk[0].images.length, 1, '落盘图片引用不得为空');
  assert.strictEqual(ctx.canManualRetryRecord(ctx.requestHistory[0]), false, '完成记录不再提示恢复');
});

test('回归：旧快照回包不得撤销保存期间发生的取消', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.requestHistory = [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-9' })];
  ctx.selectedHistoryId = 'h1';

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const stalePersist = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照 save 已发起');

  // 保存进行中用户取消（等价 cancelTaskByHistoryId 落库的写法）
  ctx.updateHistoryEntry('h1', { status: 'CANCELLED', errorMessage: '用户取消' });

  entries[0].release();
  await stalePersist;
  await settlePersist(ctx);

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED', '取消不得被旧快照的 IN_PROGRESS 覆盖');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '用户取消');
  assert.strictEqual(diskRecordsOf(historyStore, storage)[0].status, 'CANCELLED', '落盘保持取消');
});

test('回归：保存期间插入的新历史不得被旧快照裁剪结果丢弃', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.requestHistory = [makeRecord('old', 'IN_PROGRESS', { jobId: 'job-1' })];
  ctx.selectedHistoryId = 'old';

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const stalePersist = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照 save 已发起');

  ctx.requestHistory.unshift(makeRecord('fresh', 'IN_QUEUE'));

  entries[0].release();
  await stalePersist;
  await settlePersist(ctx);

  assert.deepStrictEqual(Array.from(ctx.requestHistory, r => r.id), ['fresh', 'old'], '新记录不得丢失');
  assert.deepStrictEqual(
    diskRecordsOf(historyStore, storage).map(r => r.id),
    ['fresh', 'old'],
    '新记录必须最终落盘'
  );
});

test('回归：多次插入/取消后，最终落盘与最新内存完全一致', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.requestHistory = [makeRecord('a', 'IN_PROGRESS', { jobId: 'job-a' })];
  ctx.selectedHistoryId = 'a';

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const stalePersist = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照 save 已发起');

  ctx.requestHistory.unshift(makeRecord('b', 'IN_QUEUE'));
  ctx.updateHistoryEntry('a', { status: 'CANCELLED', errorMessage: '用户取消' });
  ctx.updateHistoryEntry('b', { status: 'IN_PROGRESS', delayTime: 12 });

  entries[0].release();
  await stalePersist;
  await settlePersist(ctx);

  const memory = ctx.serializeHistoryForStore();
  const disk = diskRecordsOf(historyStore, storage);
  assert.deepStrictEqual(disk, JSON.parse(JSON.stringify(memory)), '落盘快照必须等于最新内存快照');
  assert.strictEqual(memory[0].id, 'b');
  assert.strictEqual(memory[0].status, 'IN_PROGRESS');
  assert.strictEqual(memory[0].delayTime, 12);
  assert.strictEqual(memory[1].status, 'CANCELLED');
});

test('持久化仍按上限裁剪，且裁剪结果应用到内存并重定位预览', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.ensureResultsSelection = () => {};
  const records = [];
  for (let i = 0; i < 35; i++) records.push(makeRecord('r' + i, 'COMPLETED'));
  ctx.requestHistory = records;

  let reanchorCalls = 0;
  ctx.reanchorImageSelections = () => { reanchorCalls++; };

  await ctx.persistHistoryNow();
  await settlePersist(ctx);

  const max = historyStore.LIMITS.maxRequests;
  assert.strictEqual(ctx.requestHistory.length, max, `内存裁剪到 ${max}`);
  assert.strictEqual(diskRecordsOf(historyStore, storage).length, max, '落盘同样裁剪');
  assert.strictEqual(ctx.requestHistory[0].id, 'r0', '保留最近记录、顺序不变');
  assert.ok(reanchorCalls >= 1, '应用裁剪后仍重定位预览锚点');
});

test('回归：签名/序列化异常时绝不应用旧快照的裁剪结果（fail-closed）', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.requestHistory = [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-9' })];
  ctx.selectedHistoryId = 'h1';

  const realSerialize = ctx.serializeHistoryForStore;
  let calls = 0;
  // 第 2 次序列化（保存后的“是否仍是同一快照”比对）故意抛错
  ctx.serializeHistoryForStore = function () {
    calls++;
    if (calls === 2) throw new Error('boom: 元数据不可序列化');
    return realSerialize.call(ctx);
  };

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const stalePersist = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照 save 已发起');

  // 保存期间拿到新结果
  ctx.updateHistoryEntry('h1', { status: 'COMPLETED' });

  entries[0].release();
  await stalePersist;
  await settlePersist(ctx);

  assert.strictEqual(ctx.requestHistory[0].status, 'COMPLETED', '比较失败时不得应用旧回包');
  assert.ok(calls >= 2, '保存后确实尝试了比对（未静默跳过）');

  // 恢复正常序列化后，下一轮持久化能把落盘收敛到最新内存
  ctx.serializeHistoryForStore = realSerialize;
  await ctx.persistHistoryNow();
  await settlePersist(ctx);
  assert.strictEqual(ctx.requestHistory[0].status, 'COMPLETED');
  assert.strictEqual(diskRecordsOf(historyStore, storage)[0].status, 'COMPLETED', '恢复正常后落盘收敛');
});

test('回归：保存期间的收藏新增/删除不被旧快照的裁剪结果覆盖', async () => {
  const makeFav = (id, addedAt) => ({
    id,
    addedAt,
    filename: id + '.png',
    type: 'base64',
    requestId: '',
    requestCreatedAt: null,
    requestTemplateId: '',
    requestTemplateName: '',
    requestJobId: '',
    placeholderValues: {}
  });

  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  persistFixture(ctx);
  ctx.requestHistory = [makeRecord('h1', 'COMPLETED')];
  ctx.favorites = [makeFav('fav-a', 1000), makeFav('fav-b', 2000)];
  ctx.favoriteImageCache = {};
  ctx.selectedFavoriteIndex = 0;

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const stalePersist = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照 save 已发起');

  // 保存进行中：删掉 fav-a，新增 fav-c
  ctx.favorites = ctx.favorites.filter(f => f.id !== 'fav-a');
  ctx.favorites.unshift(makeFav('fav-c', 3000));

  entries[0].release();
  await stalePersist;
  await settlePersist(ctx);

  const memoryIds = Array.from(ctx.favorites, f => f.id);
  assert.deepStrictEqual(memoryIds, ['fav-c', 'fav-b'], '内存收藏不得被旧快照覆盖');

  const diskFavorites = JSON.parse(storage.get(historyStore.FAVORITES_KEY) || '[]');
  assert.deepStrictEqual(diskFavorites.map(f => f.id), ['fav-c', 'fav-b'], '落盘收藏与内存一致');
});

// ---------- 16：状态查询超时可动态生效（真实 client + main 链路） ----------
test('回归：运行中保存新的状态超时，下一次 /status 生效，已发出的请求保持旧值', async () => {
  let pendingFirst = null;
  let statusGets = 0;
  const harness = createHarness((method, url) => {
    if (url.includes('/status/')) {
      statusGets++;
      if (statusGets === 1) {
        return new Promise(resolve => {
          pendingFirst = { release: () => resolve({ data: { status: 'IN_PROGRESS' } }) };
        });
      }
      return Promise.resolve({
        data: { status: 'COMPLETED', output: { images: [{ type: 'base64', data: 'aGk=' }] } }
      });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx, calls } = harness;
  persistFixture(ctx);
  // 用真实配置（endpoint/key 来自 CLIENT_CFG）建立已配置状态，走真实 persistHistoryNow
  ctx.settings = { ...ctx.settings, endpointId: CLIENT_CFG.endpointId, apiKey: CLIENT_CFG.apiKey };
  ctx.updateConnectionStatus = () => {};
  ctx.pumpQueue = () => {};
  ctx.requestHistory = [makeRecord('h1', 'QUERY_INTERRUPTED', {
    jobId: 'job-9',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now() - 1000,
    errorMessage: '查询中断，可恢复：状态查询超时'
  })];
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;
  ctx.getEffectivePollIntervalMs = () => 5;

  ctx.retryHistoryRecord('h1');
  await waitForCondition(() => statusGets === 1 && pendingFirst, 'GET1 已发出并挂起');

  const statusCalls = () => calls.filter(c => c.url.includes('/status/'));
  assert.strictEqual(statusCalls()[0].config.timeout, 20000, '首帧沿用默认 20 秒');
  const firstAxiosConfig = statusCalls()[0].config;

  const task = ctx.activeJobs[0];
  assert.ok(task, '恢复查询任务在运行中');
  const taskCfgEndpoint = task.clientConfig.endpointId;
  const taskCfgKey = task.clientConfig.apiKey;

  // 用户改成 40 秒（并顺手改了端点/密钥），保存
  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 40;
  ctx.settingsForm.endpointId = 'ep-switched';
  ctx.settingsForm.apiKey = 'switched-key';
  ctx.saveSettings();

  assert.strictEqual(ctx.settings.statusTimeoutMs, 40000, '已生效 40 秒');
  assert.strictEqual(ctx.getClientConfigSnapshot().statusTimeoutMs, 40000, '新快照是 40 秒');
  assert.strictEqual(firstAxiosConfig.timeout, 20000, '已发出的 GET 保持旧时限');
  assert.strictEqual(task.clientConfig.statusTimeoutMs, 20000, '任务快照不被就地改写');

  pendingFirst.release();
  await waitForCondition(() => statusCalls().length >= 2, 'GET2 已发出');

  const second = statusCalls()[1];
  assert.strictEqual(second.config.timeout, 40000, '下一次尚未发出的 /status 用新值');
  assert.ok(second.url.includes(`/${taskCfgEndpoint}/status/`), '端点仍用任务快照');
  assert.strictEqual(second.config.headers.Authorization, `Bearer ${taskCfgKey}`, '密钥仍用任务快照');

  await waitForCondition(() => ctx.requestHistory[0].status === 'COMPLETED', 'GET2 完成');
  assert.strictEqual(ctx.requestHistory[0].images.length, 1);
});

test('回归：未保存的表单值不改变运行中的状态查询超时', async () => {
  let pendingFirst = null;
  let statusGets = 0;
  const harness = createHarness((method, url) => {
    if (url.includes('/status/')) {
      statusGets++;
      if (statusGets === 1) {
        return new Promise(resolve => {
          pendingFirst = { release: () => resolve({ data: { status: 'IN_PROGRESS' } }) };
        });
      }
      return Promise.resolve({ data: { status: 'IN_PROGRESS' } });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx, calls } = harness;
  persistFixture(ctx);
  // 用真实配置（endpoint/key 来自 CLIENT_CFG）建立已配置状态，走真实 persistHistoryNow
  ctx.settings = { ...ctx.settings, endpointId: CLIENT_CFG.endpointId, apiKey: CLIENT_CFG.apiKey };
  ctx.updateConnectionStatus = () => {};
  ctx.pumpQueue = () => {};
  ctx.requestHistory = [makeRecord('h1', 'QUERY_INTERRUPTED', {
    jobId: 'job-9',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now() - 1000,
    errorMessage: '查询中断，可恢复：状态查询超时'
  })];
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;
  ctx.getEffectivePollIntervalMs = () => 5;

  ctx.retryHistoryRecord('h1');
  await waitForCondition(() => statusGets === 1 && pendingFirst, 'GET1 已发出并挂起');

  // 只改表单，不保存
  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 90;

  pendingFirst.release();
  await waitForCondition(() => statusGets >= 2, 'GET2 已发出');
  const statusCalls = calls.filter(c => c.url.includes('/status/'));
  assert.strictEqual(statusCalls[1].config.timeout, 20000, '未保存的表单值不生效');

  // 取消该轮询，避免测试挂着
  ctx.cancelTaskByHistoryId('h1');
  await waitForCondition(() => ctx.requestHistory[0].status === 'CANCELLED', '取消生效');
  await waitForCondition(() => ctx.activeJobs.length === 0, 'activeJobs 释放');
});

test('回归：保存后新的恢复查询直接使用最新状态超时', async () => {
  const harness = createHarness((method, url) => {
    if (url.includes('/status/')) {
      return Promise.resolve({
        data: { status: 'COMPLETED', output: { images: [{ type: 'base64', data: 'aGk=' }] } }
      });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx, calls } = harness;
  persistFixture(ctx);
  // 用真实配置（endpoint/key 来自 CLIENT_CFG）建立已配置状态，走真实 persistHistoryNow
  ctx.settings = { ...ctx.settings, endpointId: CLIENT_CFG.endpointId, apiKey: CLIENT_CFG.apiKey };
  ctx.updateConnectionStatus = () => {};
  ctx.pumpQueue = () => {};
  ctx.requestHistory = [makeRecord('h2', 'QUERY_INTERRUPTED', {
    jobId: 'job-2',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now() - 1000
  })];
  ctx.selectedHistoryId = 'h2';
  ctx.isConfigValid = true;
  ctx.getEffectivePollIntervalMs = () => 5;

  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 40;
  ctx.saveSettings();

  ctx.retryHistoryRecord('h2');
  await waitForCondition(() => ctx.requestHistory[0].status === 'COMPLETED', '恢复查询完成');

  const statusCalls = calls.filter(c => c.url.includes('/status/'));
  assert.strictEqual(statusCalls.length, 1);
  assert.strictEqual(statusCalls[0].config.timeout, 40000, '新恢复查询直接用最新值');
});

test('回归：改超时后 HTTP 5xx 仍记为查询中断（不是失败）', async () => {
  let pendingFirst = null;
  let statusGets = 0;
  const harness = createHarness((method, url) => {
    if (url.includes('/status/')) {
      statusGets++;
      if (statusGets === 1) {
        return new Promise(resolve => {
          pendingFirst = { release: () => resolve({ data: { status: 'IN_PROGRESS' } }) };
        });
      }
      return Promise.reject({ response: { status: 503, data: { error: 'fixture' } } });
    }
    return Promise.resolve({ data: {} });
  });
  const { ctx, calls } = harness;
  persistFixture(ctx);
  // 用真实配置（endpoint/key 来自 CLIENT_CFG）建立已配置状态，走真实 persistHistoryNow
  ctx.settings = { ...ctx.settings, endpointId: CLIENT_CFG.endpointId, apiKey: CLIENT_CFG.apiKey };
  ctx.updateConnectionStatus = () => {};
  ctx.pumpQueue = () => {};
  ctx.requestHistory = [makeRecord('h1', 'QUERY_INTERRUPTED', {
    jobId: 'job-9',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now() - 1000
  })];
  ctx.selectedHistoryId = 'h1';
  ctx.isConfigValid = true;
  ctx.getEffectivePollIntervalMs = () => 5;

  ctx.retryHistoryRecord('h1');
  await waitForCondition(() => statusGets === 1 && pendingFirst, 'GET1 已发出并挂起');

  ctx.openSettings();
  ctx.settingsForm.statusTimeoutSeconds = 40;
  ctx.saveSettings();

  pendingFirst.release();
  await waitForCondition(() => ctx.requestHistory[0].status === 'QUERY_INTERRUPTED' && ctx.requestHistory[0].interruptReason === 'http_503', '记录查询中断');

  const statusCalls = calls.filter(c => c.url.includes('/status/'));
  assert.strictEqual(statusCalls[1].config.timeout, 40000, '新一次请求用新超时');
  assert.match(ctx.requestHistory[0].errorMessage, /查询中断/);
  assert.match(ctx.requestHistory[0].errorMessage, /503/);
  await waitForCondition(() => ctx.activeJobs.length === 0, 'activeJobs 释放');
  assert.strictEqual(ctx.canManualRetryRecord(ctx.requestHistory[0]), true);

  ctx.cancelTaskByHistoryId('h1');
  await waitForCondition(() => ctx.activeJobs.length === 0, 'activeJobs 释放');
});

// ---------- 17：R1 真实 IndexedDB 分支 —— 写图期间取消 / 记录被移除 ----------
// 本段用 tests/support/fake-indexeddb.js 让真实 history-store.js 走 IndexedDB 分支；
// 只控制网络回包与 IDB 事务提交时机，不替换 startTask / runTask / cancelTaskByHistoryId /
// finalizeHistoryEntry / queuePersistHistory / persistHistoryNow。
function recordOf(ctx, id) {
  return (ctx.requestHistory || []).find(r => r && r.id === id) || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopPersistTimer(ctx) {
  if (ctx._persistTimer) {
    clearTimeout(ctx._persistTimer);
    ctx._persistTimer = null;
  }
}

function referencedImageIds(ctx) {
  const ids = new Set();
  (ctx.requestHistory || []).forEach(r => {
    (r.images || []).forEach(img => { if (img && img.id) ids.add(img.id); });
  });
  (ctx.favorites || []).forEach(f => { if (f && f.id) ids.add(f.id); });
  return ids;
}

function makeFavorite(id, requestId) {
  return {
    id,
    addedAt: 1000,
    filename: `${id}.png`,
    type: 'base64',
    requestId: requestId || '',
    requestCreatedAt: null,
    requestTemplateId: '',
    requestTemplateName: '',
    requestJobId: '',
    placeholderValues: {}
  };
}

function completedImage(id, data) {
  return {
    id,
    filename: `${id}.png`,
    type: 'base64',
    data,
    imageUrl: `data:image/png;base64,${data}`,
    createdAt: Date.now()
  };
}

test('回归（R1）：写图期间取消 → 记录保持 CANCELLED、新图不挂入、槽位释放且后续队列启动', async () => {
  const fake = createFakeIndexedDB();
  const harness = createHarness((method, url) => {
    if (url.includes('/status/job-a')) {
      return Promise.resolve({
        data: {
          status: 'COMPLETED',
          executionTime: 11,
          output: { images: [{ type: 'base64', data: 'YQ==' }, { type: 'base64', data: 'Yg==' }] }
        }
      });
    }
    if (url.includes('/status/job-b')) {
      return Promise.resolve({
        data: { status: 'COMPLETED', executionTime: 5, output: { images: [{ type: 'base64', data: 'Yw==' }] } }
      });
    }
    return Promise.resolve({ data: {} });
  }, { indexedDB: fake });
  const { ctx, historyStore, calls } = harness;
  assert.strictEqual(historyStore.isIndexedDbAvailable(), true, '历史存储必须真的走 IndexedDB 分支');
  const toasts = [];
  ctx.showUiToast = (...args) => toasts.push(args);
  ctx.updateConnectionStatus = () => {};

  ctx.requestHistory = [
    makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-a' }),
    makeRecord('h2', 'IN_QUEUE', { jobId: 'job-b' })
  ];
  ctx.selectedHistoryId = 'h1';
  ctx.latestHistoryId = 'h1';
  ctx.isConfigValid = true;
  // 后续队列任务：并发默认为 1，h1 释放槽位后才应启动
  ctx.jobQueue = [makeTask('h2', { jobId: 'job-b', pollOnly: true, payload: null })];

  const hold = fake.hold(info => info.mode === 'readwrite' && info.ops.some(op => op.type === 'put'));
  ctx.startTask(makeTask('h1', { jobId: 'job-a', pollOnly: true, payload: null }));
  await waitForCondition(() => hold.matched === 1, '图片写入事务被挂起');

  const writtenIds = fake.ids('images');
  assert.strictEqual(writtenIds.length, 2, '两张图已进入 IDB（提交被挂起）');
  assert.strictEqual(recordOf(ctx, 'h1').images.length, 0, '写图期间图片尚未挂入记录');

  // 真实取消入口：置标记 + 落 CANCELLED + 尽力调用 /cancel
  assert.strictEqual(ctx.cancelTaskByHistoryId('h1'), true, '取消命中运行中的任务');
  assert.strictEqual(recordOf(ctx, 'h1').status, 'CANCELLED');

  hold.release();
  await waitForCondition(() => ctx.activeJobs.length === 0 && ctx.jobQueue.length === 0, '槽位释放且队列清空');
  await waitForCondition(
    () => recordOf(ctx, 'h2') && recordOf(ctx, 'h2').status === 'COMPLETED',
    '取消后后续队列任务被启动并完成'
  );
  await ctx.persistHistoryNow();
  await settlePersist(ctx);

  const cancelled = recordOf(ctx, 'h1');
  assert.ok(cancelled, '记录不得被删除');
  assert.strictEqual(cancelled.status, 'CANCELLED', '取消是终态，迟到的结果不得复活记录');
  assert.strictEqual(cancelled.images.length, 0, '写图期间取消：新图片不得挂入记录');
  assert.strictEqual(cancelled.executionTime, null, '不写迟到的结果元数据');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 0, '不跳到新图片');
  assert.ok(
    !toasts.some(t => String(t[0] || '').includes('已完成')),
    '取消后不得弹“已完成”成功提示'
  );
  assert.ok(
    calls.some(c => c.method === 'post' && c.url.includes('/cancel/job-a')),
    '取消仍尽力通知远端'
  );

  const second = recordOf(ctx, 'h2');
  assert.strictEqual(second.status, 'COMPLETED');
  assert.strictEqual(second.images.length, 1, '后续任务正常落图');

  // 新写入的 blob 不因守卫失败被无条件删除（可能被收藏引用），孤儿留给既有 load 清理
  writtenIds.forEach(id => assert.ok(fake.has('images', id), '守卫返回时不得删除刚写入的 blob'));
  const disk = diskRecordsOf(historyStore, harness.storage);
  assert.strictEqual(disk.find(r => r.id === 'h1').status, 'CANCELLED', '落盘保持 CANCELLED');
  assert.strictEqual(disk.find(r => r.id === 'h1').images.length, 0);

  const loaded = await historyStore.load();
  writtenIds.forEach(id => assert.strictEqual(fake.has('images', id), false, '孤儿 blob 由既有 load 清理'));
  const secondIds = second.images.map(img => img.id);
  secondIds.forEach(id => assert.ok(fake.has('images', id), '被引用的图片必须保留'));
  assert.ok(loaded.records.some(r => r.id === 'h2'), 'load 能读回完成记录');
  stopPersistTimer(ctx);
});

test('回归（R1）：写图期间记录被裁剪 → 不复活、不动已选记录、不报成功、不误删收藏', async () => {
  const fake = createFakeIndexedDB();
  const harness = createHarness((method, url) => {
    if (url.includes('/status/job-old')) {
      return Promise.resolve({
        data: { status: 'COMPLETED', executionTime: 3, output: { images: [{ type: 'base64', data: 'b3JwaGFu' }] } }
      });
    }
    return Promise.resolve({ data: {} });
  }, { indexedDB: fake });
  const { ctx, historyStore, storage } = harness;
  const toasts = [];
  ctx.showUiToast = (...args) => toasts.push(args);
  ctx.updateConnectionStatus = () => {};

  // 已有收藏（图片同时被 keep0 引用）
  ctx.favorites = [makeFavorite('img-keep', 'keep0')];
  ctx.favoriteImageCache = { 'img-keep': completedImage('img-keep', 'a2VlcA==') };
  ctx.selectedFavoriteIndex = 0;
  await historyStore.putImages([{ id: 'img-keep', filename: 'img-keep.png', type: 'base64', data: 'a2VlcA==' }]);

  const records = [];
  for (let i = 0; i < 30; i++) {
    const rec = makeRecord(`keep${i}`, 'COMPLETED', { imageCount: i === 0 ? 1 : 0 });
    if (i === 0) rec.images = [completedImage('img-keep', 'a2VlcA==')];
    records.push(rec);
  }
  const victim = makeRecord('old', 'IN_PROGRESS', { jobId: 'job-old' });
  ctx.requestHistory = [...records, victim];  // 第 31 条，会被上限 30 裁掉
  ctx.selectedHistoryId = 'keep0';
  ctx.latestHistoryId = 'keep0';
  const selectedBefore = recordOf(ctx, 'keep0');

  const hold = fake.hold(info => info.mode === 'readwrite' && info.ops.some(op => op.type === 'put'));
  ctx.startTask(makeTask('old', { jobId: 'job-old', pollOnly: true, payload: null }));
  await waitForCondition(() => hold.matched === 1, '写图事务被挂起');
  const orphanIds = fake.ids('images').filter(id => id !== 'img-keep');
  assert.strictEqual(orphanIds.length, 1, '新图片已写入 IDB（提交被挂起）');

  // 写图挂起期间，另一轮真实保存按上限裁剪掉 victim（applyPrunedRecordsToMemory 直接移除该记录）
  await ctx.persistHistoryNow();
  await settlePersist(ctx);
  assert.strictEqual(recordOf(ctx, 'old'), null, 'victim 已被裁剪出内存');

  hold.release();
  await waitForCondition(() => ctx.activeJobs.length === 0, 'activeJobs 释放');
  await ctx.persistHistoryNow();
  await settlePersist(ctx);

  assert.strictEqual(recordOf(ctx, 'old'), null, '记录已移除：不得复活、不得插回');
  assert.ok(!ctx.requestHistory.some(r => (r.images || []).some(img => orphanIds.includes(img.id))),
    '新图片不得挂到任何记录上');
  const selectedAfter = recordOf(ctx, 'keep0');
  assert.ok(selectedAfter, '已选记录仍在');
  assert.notStrictEqual(selectedAfter, selectedBefore, '裁剪会重建记录对象（所以守卫不能做身份比较）');
  assert.deepStrictEqual(Array.from(selectedAfter.images, img => img.id), ['img-keep'], '已选记录的被收藏图片保持不变');
  assert.strictEqual(selectedAfter.status, 'COMPLETED', '已选记录状态不被其它记录的结果影响');
  assert.strictEqual(ctx.selectedHistoryId, 'keep0', '不改变当前查看对象');
  assert.strictEqual(ctx.latestHistoryId, 'keep0', '不改“最新任务”指向');
  assert.ok(!toasts.some(t => String(t[0] || '').includes('已完成')), '不得报成功');

  assert.deepStrictEqual(Array.from(ctx.favorites, f => f.id), ['img-keep'], '收藏不被裁剪结果覆盖');
  assert.ok(fake.has('images', 'img-keep'), '收藏图片不得被误删');
  assert.deepStrictEqual(
    JSON.parse(storage.get(historyStore.FAVORITES_KEY) || '[]').map(f => f.id),
    ['img-keep'],
    '收藏元数据仍在盘上'
  );
  orphanIds.forEach(id => assert.ok(fake.has('images', id), '孤儿 blob 不被无条件删除'));

  await historyStore.load();
  orphanIds.forEach(id => assert.strictEqual(fake.has('images', id), false, '孤儿 blob 交给既有 load 清理'));
  assert.ok(fake.has('images', 'img-keep'), 'load 必须保留收藏图片');
  stopPersistTimer(ctx);
});

// ---------- 18：正常完成落盘 / 收藏 / 裁剪不退化（真实 IDB 分支） ----------
test('回归（R1）：正常完成落盘、收藏与上限裁剪在真实 IDB 分支下仍正确', async () => {
  const fake = createFakeIndexedDB();
  const harness = createHarness((method, url) => {
    if (url.includes('/status/job-ok')) {
      return Promise.resolve({
        data: {
          status: 'COMPLETED',
          executionTime: 8,
          output: { images: [{ type: 'base64', data: 'aW1nLTE=' }, { type: 'base64', data: 'aW1nLTI=' }] }
        }
      });
    }
    return Promise.resolve({ data: {} });
  }, { indexedDB: fake });
  const { ctx, historyStore, storage } = harness;
  const toasts = [];
  ctx.showUiToast = (...args) => toasts.push(args);
  ctx.updateConnectionStatus = () => {};

  ctx.favorites = [makeFavorite('fav-1', '')];
  ctx.favoriteImageCache = { 'fav-1': { ...completedImage('fav-1', 'ZmF2'), imageUrl: 'data:image/png;base64,ZmF2' } };
  ctx.selectedFavoriteIndex = 0;

  // 已有 12 条记录 × 5 张图：非收藏图片合计 60，超过 maxImages=50，落盘时会真实裁剪
  const records = [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-ok' }) ];
  const oldImageIds = [];
  for (let i = 0; i < 12; i++) {
    const imgs = [];
    for (let j = 0; j < 5; j++) {
      const id = `r${i}-${j}`;
      oldImageIds.push(id);
      imgs.push({ id, filename: `${id}.png`, type: 'base64', data: 'b2xk', imageUrl: 'data:image/png;base64,b2xk', createdAt: 1 });
    }
    records.push(makeRecord(`rec${i}`, 'COMPLETED', { images: imgs, imageCount: 5 }));
  }
  ctx.requestHistory = records;
  ctx.selectedHistoryId = 'h1';
  ctx.latestHistoryId = 'h1';
  await historyStore.putImages([
    ...oldImageIds.map(id => ({ id, filename: `${id}.png`, type: 'base64', data: 'b2xk' })),
    { id: 'fav-1', filename: 'fav-1.png', type: 'base64', data: 'ZmF2' }
  ]);
  assert.strictEqual(fake.ids('images').length, 61, '旧图片与收藏已落 IDB');

  ctx.startTask(makeTask('h1', { jobId: 'job-ok', pollOnly: true, payload: null }));
  await waitForCondition(() => ctx.activeJobs.length === 0, '任务收敛');
  const completed = recordOf(ctx, 'h1');
  assert.ok(completed, '记录仍在');
  assert.strictEqual(completed.status, 'COMPLETED');
  assert.strictEqual(completed.images.length, 2, '正常完成必须挂入新图片');
  assert.strictEqual(completed.images[0].data, 'aW1nLTE=', '图片数据保留在内存中以供展示');
  const newIds = Array.from(completed.images, img => img.id);
  newIds.forEach(id => assert.ok(fake.has('images', id), '新图片真实写入 IDB'));
  assert.ok(!toasts.some(t => String(t[0] || '').includes('失败')), '正常完成不报失败');

  await ctx.persistHistoryNow();
  await settlePersist(ctx);

  const disk = diskRecordsOf(historyStore, storage);
  const diskMain = disk.find(r => r.id === 'h1');
  assert.ok(diskMain, '完成记录落盘');
  assert.strictEqual(diskMain.status, 'COMPLETED');
  assert.deepStrictEqual(Array.from(diskMain.images, img => img.id), newIds, '落盘引用最新图片');
  assert.strictEqual(diskMain.executionTime, 8);

  // 裁剪：非收藏图片上限 50，收藏独立保留
  const totalRefs = (ctx.requestHistory || [])
    .reduce((sum, r) => sum + (Array.isArray(r.images) ? r.images.length : 0), 0);
  assert.strictEqual(totalRefs, historyStore.LIMITS.maxImages, `非收藏图片裁剪到 ${historyStore.LIMITS.maxImages}`);
  assert.deepStrictEqual(Array.from(recordOf(ctx, 'h1').images, img => img.id), newIds, '新图片不被裁剪');
  assert.strictEqual(recordOf(ctx, 'rec9').images.length, 3, '跨记录边界处按数量裁剪');
  assert.strictEqual(recordOf(ctx, 'rec10').images.length, 0, '超限的尾部记录图片被裁剪');
  assert.strictEqual(recordOf(ctx, 'rec11').images.length, 0);

  // 裁剪精确到图片：r0–r8 全留（45）+ r9 前 3 张 + 新完成 2 张 = 50；其余 12 张从 IDB 删除
  const expectedRemoved = ['r9-3', 'r9-4']
    .concat(Array.from({ length: 5 }, (_, j) => `r10-${j}`))
    .concat(Array.from({ length: 5 }, (_, j) => `r11-${j}`));
  expectedRemoved.forEach(id => {
    assert.strictEqual(fake.has('images', id), false, `超限图片必须从 IDB 删除：${id}`);
  });
  assert.strictEqual(oldImageIds.length - expectedRemoved.length, 48, '裁剪前 60 张、保留 48 张旧图');
  const storeIds = fake.ids('images');
  assert.strictEqual(storeIds.length, historyStore.LIMITS.maxImages + 1, 'IDB 只留上限内图片 + 收藏');
  assert.ok(fake.has('images', 'fav-1'), '收藏图片独立于本地上限');
  assert.deepStrictEqual(
    JSON.parse(storage.get(historyStore.FAVORITES_KEY) || '[]').map(f => f.id),
    ['fav-1'],
    '收藏元数据落盘'
  );
  stopPersistTimer(ctx);
});

// ---------- 19：R3 显式保存接管防抖 timer ----------
test('回归（R3）：静止状态的显式保存只落盘一轮，400ms 防抖 timer 被同步入口接管', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, setCalls } = harness;
  const saves = [];
  const originalSave = historyStore.save;
  historyStore.save = async function (state) {
    saves.push(state);
    return originalSave.call(historyStore, state);
  };

  ctx.requestHistory = [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-1' })];
  ctx.selectedHistoryId = 'h1';
  const setCallsBefore = setCalls.length;

  ctx.updateHistoryEntry('h1', { status: 'COMPLETED' });  // 真实入口先排 400ms timer
  assert.ok(ctx._persistTimer, '防抖 timer 已排');

  await ctx.persistHistoryNow();  // 真实显式保存
  await settlePersist(ctx);
  assert.strictEqual(saves.length, 1, '显式保存本身只保存一轮');
  assert.strictEqual(diskRecordsOf(historyStore, harness.storage)[0].status, 'COMPLETED');

  // 等过 400ms：被接管的 timer 不得再补存一轮
  await sleep(450);
  assert.strictEqual(saves.length, 1, '显式保存已接管防抖 timer，不得再保存一轮');
  const metaSetCalls = setCalls.slice(setCallsBefore)
    .filter(key => key === historyStore.HISTORY_KEY || key === historyStore.FAVORITES_KEY);
  assert.strictEqual(metaSetCalls.length, 2, '元数据落盘只有 2 次 setItem（记录 + 收藏）');
  assert.strictEqual(ctx._persistTimer, null, '同步入口清空 timer 句柄，触发后也不残留');
});

test('回归（R3）：显式保存进行中产生的新更新不被吞掉，最终落盘最新状态', async () => {
  const harness = createHarness(() => Promise.resolve({ data: {} }));
  const { ctx, historyStore, storage } = harness;
  ctx.showUiToast = () => {};
  ctx.reanchorImageSelections = () => {};
  ctx.requestHistory = [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-9' })];
  ctx.selectedHistoryId = 'h1';

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const saving = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '显式保存已发起并挂起');

  // 保存进行中的新变化：真实 updateHistoryEntry → 真实 queuePersistHistory 重排 timer
  ctx.updateHistoryEntry('h1', { status: 'COMPLETED', executionTime: 42 });
  assert.ok(ctx._persistTimer, '保存期间的新变化重排了 400ms timer');

  entries[0].release();
  await saving;
  await settlePersist(ctx);
  const savesAfterChain = entries.length;
  assert.ok(savesAfterChain >= 2, '旧快照被丢弃并重存最新状态');
  assert.strictEqual(diskRecordsOf(historyStore, storage)[0].status, 'COMPLETED');

  await sleep(450);
  assert.ok(entries.length > savesAfterChain, '保存期间重排的 timer 真的又保存了一轮（未被吞掉）');
  assert.strictEqual(ctx._persistTimer, null, 'timer 触发后句柄置空');
  const disk = diskRecordsOf(historyStore, storage);
  assert.strictEqual(disk[0].status, 'COMPLETED');
  assert.strictEqual(disk[0].executionTime, 42, '最终落盘是最新状态');
  const memory = JSON.parse(JSON.stringify(ctx.serializeHistoryForStore()));
  assert.deepStrictEqual(disk, memory, '落盘与最新内存一致');
});

// ---------- 20：既有竞态/fail-closed/收藏在真实 IDB 分支下不退化 ----------
test('回归：真实 IDB 分支下旧快照回包不覆盖内存，收藏图不被裁剪误删', async () => {
  const fake = createFakeIndexedDB();
  const harness = createHarness(() => Promise.resolve({ data: {} }), { indexedDB: fake });
  const { ctx, historyStore, storage } = harness;
  ctx.showUiToast = () => {};
  ctx.reanchorImageSelections = () => {};
  ctx.favorites = [makeFavorite('img-1', 'h1')];
  ctx.favoriteImageCache = { 'img-1': completedImage('img-1', 'aW1nMQ==') };
  ctx.selectedFavoriteIndex = 0;
  ctx.requestHistory = [makeRecord('h1', 'COMPLETED', { images: [completedImage('img-1', 'aW1nMQ==')], imageCount: 1 })];
  ctx.selectedHistoryId = 'h1';
  ctx.latestHistoryId = 'h1';
  await historyStore.putImages([{ id: 'img-1', filename: 'img-1.png', type: 'base64', data: 'aW1nMQ==' }]);

  const entries = gateHistoryStoreSaves(historyStore, 1);
  const stale = ctx.persistHistoryNow();
  await waitForCondition(() => entries.length === 1, '旧快照已落盘且回包被挂住');

  ctx.updateHistoryEntry('h1', {
    status: 'QUERY_INTERRUPTED',
    interruptReason: 'timeout',
    interruptStage: 'poll',
    interruptedAt: Date.now()
  });

  entries[0].release();
  await stale;
  await settlePersist(ctx);

  const rec = recordOf(ctx, 'h1');
  assert.strictEqual(rec.status, 'QUERY_INTERRUPTED', '旧快照（COMPLETED）不得覆盖更新的状态');
  assert.strictEqual(rec.images.length, 1, '内存图片不得被旧快照清空');
  assert.strictEqual(diskRecordsOf(historyStore, storage)[0].status, 'QUERY_INTERRUPTED', '落盘收敛到最新状态');
  assert.deepStrictEqual(Array.from(ctx.favorites, f => f.id), ['img-1'], '收藏不被旧快照覆盖');
  assert.ok(fake.has('images', 'img-1'), '被收藏引用的图片不得被裁剪删除');
  stopPersistTimer(ctx);
});

// 只验证“保留当前语义”：COMPLETED 已经展示后用户再点取消，既不会把记录改回 COMPLETED，
// 也不会顺手清空已经挂上的图片。GLM 已把“完成后取消”的产品语义列为后续非阻塞问题，
// 本用例不改变它、也不替它做决定。
test('回归：终态落盘中取消 → 旧回包不回退成 COMPLETED、已有图片不被清空、槽位收敛', async () => {
  const fake = createFakeIndexedDB();
  const harness = createHarness((method, url) => {
    if (url.includes('/status/job-done')) {
      return Promise.resolve({
        data: {
          status: 'COMPLETED',
          executionTime: 6,
          output: { images: [{ type: 'base64', data: 'ZG9uZTE=' }, { type: 'base64', data: 'ZG9uZTI=' }] }
        }
      });
    }
    return Promise.resolve({ data: {} });
  }, { indexedDB: fake });
  const { ctx, historyStore } = harness;
  ctx.showUiToast = () => {};
  ctx.updateConnectionStatus = () => {};
  ctx.requestHistory = [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-done' })];
  ctx.selectedHistoryId = 'h1';
  ctx.latestHistoryId = 'h1';

  // 真实 startTask → runTask → pollExistingJob → finalizeHistoryEntry（先写图，再保存元数据）
  const entries = gateHistoryStoreSaves(historyStore, 1);
  ctx.startTask(makeTask('h1', { jobId: 'job-done', pollOnly: true, payload: null }));

  // 等 finalize 里的真实 persistHistoryNow 发起保存并挂住回包：此时图片已挂、任务仍占着槽位
  await waitForCondition(() => entries.length === 1, '终态元数据保存已发起并挂起');
  const completed = recordOf(ctx, 'h1');
  assert.strictEqual(completed.status, 'COMPLETED', '图片与终态已写入内存');
  assert.strictEqual(completed.images.length, 2, '图片已挂入记录');
  assert.strictEqual(ctx.activeJobs.length, 1, '保存未收敛前任务仍占槽位');

  // 保存 await 窗口内用户点取消：真实入口会置标记 + 落 CANCELLED + 尽力 /cancel
  assert.strictEqual(ctx.cancelTaskByHistoryId('h1'), true, '保存窗口内取消命中运行中的任务');
  assert.strictEqual(recordOf(ctx, 'h1').status, 'CANCELLED');
  assert.strictEqual(recordOf(ctx, 'h1').images.length, 2, '取消不清空已经展示的图片');

  entries[0].release();
  await waitForCondition(() => ctx.activeJobs.length === 0, '槽位收敛');
  await settlePersist(ctx);

  const rec = recordOf(ctx, 'h1');
  assert.strictEqual(rec.status, 'CANCELLED', '旧快照（COMPLETED）回包不得把 CANCELLED 改回');
  assert.strictEqual(rec.images.length, 2, '已有图片不得被旧回包清空');
  assert.deepStrictEqual(Array.from(rec.images, img => img.id), Array.from(completed.images, img => img.id));
  const disk = diskRecordsOf(historyStore, harness.storage);
  assert.strictEqual(disk[0].status, 'CANCELLED', '最终落盘是 CANCELLED');
  assert.strictEqual(disk[0].images.length, 2, '落盘保留已展示图片引用');
  Array.from(rec.images, img => img.id).forEach(id => assert.ok(fake.has('images', id), '图片 blob 不被删除'));
  stopPersistTimer(ctx);
});

(async () => {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (error) {
      console.error('not ok - ' + name);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${cases.length} passed`);
})();
