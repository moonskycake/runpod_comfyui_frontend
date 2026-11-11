'use strict';
// Batch A 回归：请求超时分类、并发任务错误归属、取消竞态。
// 全部使用 vm + 假 axios / 假 RunpodClient，不访问网络、不调用真实 RunPod。

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ========== runpod-client：超时配置与错误分类 ==========
function loadClient(transport) {
  const calls = [];
  const sandbox = {
    axios: {
      get(url, config) {
        calls.push({ method: 'get', url, config });
        return transport('get', url, config, null);
      },
      post(url, body, config) {
        calls.push({ method: 'post', url, body, config });
        return transport('post', url, config, body);
      }
    },
    window: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../js/runpod-client.js'), 'utf8'),
    sandbox
  );
  return { client: sandbox.window.RunpodClient, calls };
}

function okTransport() {
  return Promise.resolve({ data: { id: 'job-1', status: 'IN_QUEUE' } });
}

// ========== main.js：任务状态 / 取消 / 错误归属 ==========
function loadMain(RunpodClientMock) {
  let options;
  const components = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    navigator: { userAgent: 'node' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { getElementById() { return null; }, querySelector() { return null; } },
    Settings: { get() { return {}; } },
    TemplateManager: { get() { return null; } },
    RunpodClient: RunpodClientMock,
    Vue: {
      createApp(o) {
        options = o;
        return {
          component(name, component) { components[name] = component; return this; },
          mount() {}
        };
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8'), sandbox);
  const ctx = options.data();
  for (const [key, method] of Object.entries(options.methods)) ctx[key] = method.bind(ctx);
  for (const [key, getter] of Object.entries(options.computed)) {
    Object.defineProperty(ctx, key, { configurable: true, get: () => getter.call(ctx) });
  }
  ctx.$nextTick = fn => { if (fn) fn(); return Promise.resolve(); };
  ctx.$refs = {};
  ctx._testDocument = sandbox.document;
  return { ctx, options, components };
}

function makeTask(historyId, overrides = {}) {
  return {
    taskId: `task-${historyId}`,
    historyId,
    runMode: 'run',
    initialPollDelayMs: 0,
    pollIntervalMs: 2000,
    clientConfig: { endpointId: 'fixture', apiKey: 'not-real' },
    payload: { input: { tag: historyId } },
    cancelRequested: false,
    jobId: '',
    ...overrides
  };
}

function makeRecord(id, status, overrides = {}) {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status,
    runMode: 'run',
    endpointId: 'fixture',
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
    deletedImages: [],
    images: [],
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

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ---------- A1：超时 ----------
test('run/status 使用短超时，runSync 保留长任务语义且 URL/payload 不变', async () => {
  const { client, calls } = loadClient(okTransport);
  client.setConfig({ endpointId: 'ep', apiKey: 'key' });

  const payload = { input: { workflow: { '1': { class_type: 'Test' } } } };
  await client.run(payload);
  await client.status('job-1');
  await client.runSync(payload, 300000);

  const [runCall, statusCall, syncCall] = calls;
  assert.strictEqual(runCall.method, 'post');
  assert.strictEqual(runCall.url, 'https://api.runpod.ai/v2/ep/run');
  assert.deepStrictEqual(runCall.body, payload, 'payload 原样发送');
  assert.strictEqual(runCall.config.timeout, 60000, '提交使用短超时');

  assert.strictEqual(statusCall.method, 'get');
  assert.strictEqual(statusCall.url, 'https://api.runpod.ai/v2/ep/status/job-1');
  assert.strictEqual(statusCall.config.timeout, 20000, '状态查询使用更短超时');

  assert.strictEqual(syncCall.url, 'https://api.runpod.ai/v2/ep/runsync?wait=300000');
  assert.deepStrictEqual(syncCall.body, payload);
  assert.strictEqual(syncCall.config.timeout, 330000, 'runSync 超时 = wait + 缓冲');
});

test('runSync 默认等待 90s 时超时为 120s', async () => {
  const { client, calls } = loadClient(okTransport);
  client.setConfig({ endpointId: 'ep', apiKey: 'key' });
  await client.runSync({ input: {} });
  assert.strictEqual(calls[0].url, 'https://api.runpod.ai/v2/ep/runsync?wait=90000');
  assert.strictEqual(calls[0].config.timeout, 120000);
});

test('超时配置可按单请求实例覆盖', async () => {
  const { client, calls } = loadClient(okTransport);
  client.setConfig({ endpointId: 'ep', apiKey: 'key' });
  await client.status('job-1', {
    endpointId: 'ep',
    apiKey: 'key',
    statusTimeoutMs: 5000
  });
  assert.strictEqual(calls[0].config.timeout, 5000);
});

test('formatError 区分 ECONNABORTED / ETIMEDOUT 超时并给出中文可行动提示', () => {
  const { client } = loadClient(okTransport);

  const aborted = client.formatError({
    code: 'ECONNABORTED',
    message: 'timeout of 20000ms exceeded',
    config: { timeout: 20000 }
  });
  assert.strictEqual(aborted.success, false);
  assert.strictEqual(aborted.timeout, true);
  assert.strictEqual(aborted.status, null);
  assert.match(aborted.message, /超时/);
  assert.match(aborted.message, /检查网络/);
  assert.match(aborted.message, /历史记录/, '提示长任务恢复入口');

  const timedOut = client.formatError({
    code: 'ETIMEDOUT',
    message: 'connect ETIMEDOUT 1.2.3.4:443',
    config: { timeout: 15000 }
  });
  assert.strictEqual(timedOut.timeout, true);
  assert.match(timedOut.message, /超时/);
});

test('formatError 不把普通网络错误或 HTTP 错误误判为超时', () => {
  const { client } = loadClient(okTransport);

  const network = client.formatError({ message: 'Network Error' });
  assert.strictEqual(network.timeout, false);
  assert.strictEqual(network.message, 'Network Error');

  const unauthorized = client.formatError({ response: { status: 401, data: { error: 'x' } } });
  assert.strictEqual(unauthorized.timeout, false);
  assert.strictEqual(unauthorized.message, 'API Key 无效或已过期');
  assert.strictEqual(unauthorized.status, 401);
  assert.deepStrictEqual(unauthorized.data, { error: 'x' });

  const server = client.formatError({ response: { status: 500, data: {} } });
  assert.strictEqual(server.timeout, false);
  assert.strictEqual(server.message, '服务器内部错误');
});

test('run 请求超时返回 timeout 分类而不是笼统网络失败', async () => {
  const { client } = loadClient(() => Promise.reject({
    code: 'ECONNABORTED',
    message: 'timeout of 60000ms exceeded',
    config: { timeout: 60000 }
  }));
  client.setConfig({ endpointId: 'ep', apiKey: 'key' });
  const result = await client.run({ input: {} });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.timeout, true);
  assert.match(result.message, /请求超时/);
});

// ---------- A2：并发错误归属 ----------
test('并发任务失败时错误各归各的历史记录，不互相覆盖', async () => {
  const pending = {};
  const RunpodClient = {
    run(payload) {
      const tag = payload.input.tag;
      const d = deferred();
      pending[tag] = d;
      return d.promise;
    },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  const { toasts } = baseFixture(ctx, [
    makeRecord('h1', 'SUBMITTING'),
    makeRecord('h2', 'SUBMITTING')
  ]);
  ctx.selectedHistoryId = 'h1';
  ctx.latestHistoryId = 'h2';

  const taskA = makeTask('h1');
  const taskB = makeTask('h2');
  const runA = ctx.runTask(taskA);
  const runB = ctx.runTask(taskB);
  await tick();

  pending.h2.resolve({ success: false, message: '任务B失败：模型加载失败' });
  await runB;

  const recordB = ctx.requestHistory.find(r => r.id === 'h2');
  assert.strictEqual(recordB.status, 'FAILED');
  assert.strictEqual(recordB.errorMessage, '任务B失败：模型加载失败');
  assert.strictEqual(ctx.errorMessage, '', '后台任务错误不占用顶部错误区');
  assert.ok(toasts.some(t => String(t[0]).includes('任务B失败')), '后台失败仍有临时通知');

  pending.h1.resolve({ success: false, message: '任务A失败：提示词非法' });
  await runA;

  const recordA = ctx.requestHistory.find(r => r.id === 'h1');
  assert.strictEqual(recordA.status, 'FAILED');
  assert.strictEqual(recordA.errorMessage, '任务A失败：提示词非法');
  assert.strictEqual(recordB.errorMessage, '任务B失败：模型加载失败', '先完成的错误未被覆盖');
  assert.strictEqual(ctx.errorMessage, '任务A失败：提示词非法', '当前查看任务的错误显示在顶部');
});

test('后台任务失败不影响另一个任务正在写入的状态', async () => {
  const pending = {};
  const RunpodClient = {
    run(payload) {
      const d = deferred();
      pending[payload.input.tag] = d;
      return d.promise;
    },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING'), makeRecord('h2', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  const runA = ctx.runTask(makeTask('h1'));
  const runB = ctx.runTask(makeTask('h2'));
  await tick();

  pending.h2.resolve({ success: false, message: '任务B失败' });
  await runB;
  assert.strictEqual(ctx.requestHistory.find(r => r.id === 'h1').status, 'SUBMITTING');
  assert.strictEqual(ctx.requestHistory.find(r => r.id === 'h1').errorMessage, '');

  pending.h1.resolve({ success: true, data: { id: 'job-A', status: 'IN_QUEUE' } });
  await tick();
  assert.strictEqual(ctx.requestHistory.find(r => r.id === 'h1').jobId, 'job-A');

  // 让 h1 的轮询立即结束，避免测试悬挂。
  ctx.cancelTaskByHistoryId('h1');
  await runA;
  assert.strictEqual(ctx.requestHistory.find(r => r.id === 'h1').status, 'CANCELLED');
});

// ---------- A3：取消竞态 ----------
test('取消后迟到的 run 成功回包不把任务恢复为 IN_QUEUE/IN_PROGRESS', async () => {
  const pending = deferred();
  const cancels = [];
  const RunpodClient = {
    run() { return pending.promise; },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel(jobId) { cancels.push(jobId); return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1');
  ctx.activeJobs = [task];
  const running = ctx.runTask(task);
  await tick();

  assert.strictEqual(ctx.cancelTaskByHistoryId('h1'), true);
  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');

  pending.resolve({ success: true, data: { id: 'job-late', status: 'IN_QUEUE' } });
  await running;

  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'CANCELLED', '迟到提交回包不得恢复状态');
  assert.strictEqual(record.errorMessage, '用户取消');
  assert.strictEqual(record.jobId, 'job-late', '仍记录 jobId 便于排查');
  assert.deepStrictEqual(cancels, ['job-late'], '拿到 jobId 后 best-effort 远程取消');
});

test('取消后迟到的 run 失败回包不记录为 FAILED', async () => {
  const pending = deferred();
  const RunpodClient = {
    run() { return pending.promise; },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1');
  ctx.activeJobs = [task];
  const running = ctx.runTask(task);
  await tick();
  ctx.cancelTaskByHistoryId('h1');

  pending.resolve({ success: false, timeout: true, message: '请求超时：请检查网络' });
  await running;

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '用户取消');
});

test('取消后迟到的 status 回包（IN_PROGRESS）不覆盖取消状态', async () => {
  const RunpodClient = {
    run() { return Promise.resolve({ success: true, data: { id: 'job-1', status: 'IN_QUEUE' } }); },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_PROGRESS' } }); },
    cancel() { return Promise.resolve({ success: true }); },
    poll(jobId, opts) {
      // 模拟：取消发生在 status 请求飞行中，回包仍是 IN_PROGRESS。
      ctx.cancelTaskByHistoryId('h1');
      if (opts.onStatus) opts.onStatus({ status: 'IN_PROGRESS' });
      return Promise.resolve({ success: false, cancelled: true, message: '用户取消' });
    }
  };
  let ctx;
  const loaded = loadMain(RunpodClient);
  ctx = loaded.ctx;
  baseFixture(ctx, [makeRecord('h1', 'IN_QUEUE', { jobId: 'job-1' })]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1', { jobId: 'job-1' });
  ctx.activeJobs = [task];
  await ctx.pollExistingJob(task, 'h1', 'job-1', task.clientConfig);

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '用户取消');
});

test('取消后迟到的 status 失败回包不记录为 FAILED', async () => {
  let ctx;
  const RunpodClient = {
    run() { return Promise.resolve({ success: true, data: { id: 'job-1', status: 'IN_QUEUE' } }); },
    status() { return Promise.resolve({ success: false, message: '服务器内部错误' }); },
    cancel() { return Promise.resolve({ success: true }); },
    poll() {
      ctx.cancelTaskByHistoryId('h1');
      return Promise.resolve({ success: false, status: 'FAILED', message: '服务器内部错误' });
    }
  };
  ctx = loadMain(RunpodClient).ctx;
  baseFixture(ctx, [makeRecord('h1', 'IN_QUEUE', { jobId: 'job-1' })]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1', { jobId: 'job-1' });
  ctx.activeJobs = [task];
  await ctx.pollExistingJob(task, 'h1', 'job-1', task.clientConfig);

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '用户取消');
});

test('取消后迟到的 COMPLETED 不复活已取消任务', async () => {
  let ctx;
  const RunpodClient = {
    run() { return Promise.resolve({ success: true, data: { id: 'job-1', status: 'IN_QUEUE' } }); },
    status() { return Promise.resolve({ success: true, data: { status: 'COMPLETED' } }); },
    cancel() { return Promise.resolve({ success: true }); },
    poll() {
      ctx.cancelTaskByHistoryId('h1');
      return Promise.resolve({
        success: true,
        data: { status: 'COMPLETED', output: { images: [{ type: 'base64', data: 'aGk=' }] } }
      });
    }
  };
  ctx = loadMain(RunpodClient).ctx;
  baseFixture(ctx, [makeRecord('h1', 'IN_QUEUE', { jobId: 'job-1' })]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1', { jobId: 'job-1' });
  ctx.activeJobs = [task];
  await ctx.pollExistingJob(task, 'h1', 'job-1', task.clientConfig);

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');
  assert.deepStrictEqual(ctx.requestHistory[0].images, []);
});

test('取消后迟到的 runSync 成功回包不复活任务', async () => {
  const pending = deferred();
  const RunpodClient = {
    runSync() { return pending.promise; },
    run() { return Promise.resolve({ success: true, data: { id: 'job-1', status: 'IN_QUEUE' } }); },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1', { runMode: 'runsync' });
  ctx.activeJobs = [task];
  const running = ctx.runTask(task);
  await tick();
  ctx.cancelTaskByHistoryId('h1');

  pending.resolve({
    success: true,
    data: { status: 'COMPLETED', output: { images: [{ type: 'base64', data: 'aGk=' }] } }
  });
  await running;

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '用户取消');
  assert.deepStrictEqual(ctx.requestHistory[0].images, []);
});

test('取消后 runSync 失败回包不记录为 FAILED', async () => {
  const pending = deferred();
  const RunpodClient = {
    runSync() { return pending.promise; },
    run() { return Promise.resolve({ success: true, data: { id: 'job-1', status: 'IN_QUEUE' } }); },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  const task = makeTask('h1', { runMode: 'runsync' });
  ctx.activeJobs = [task];
  const running = ctx.runTask(task);
  await tick();
  ctx.cancelTaskByHistoryId('h1');

  pending.resolve({ success: false, timeout: true, message: '请求超时：请检查网络' });
  await running;

  assert.strictEqual(ctx.requestHistory[0].status, 'CANCELLED');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '用户取消');
});

// ---------- 回归：完成 / 排队 / 重试 ----------
test('回归：正常完成仍记录 COMPLETED 与图片', async () => {
  const RunpodClient = {
    run() { return Promise.resolve({ success: true, data: { id: 'job-1', status: 'IN_QUEUE' } }); },
    status() { return Promise.resolve({ success: true, data: { status: 'COMPLETED' } }); },
    poll() {
      return Promise.resolve({
        success: true,
        data: {
          status: 'COMPLETED',
          executionTime: 1234,
          output: { images: [{ type: 'base64', data: 'aGk=' }] }
        }
      });
    },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  await ctx.runTask(makeTask('h1'));

  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'COMPLETED');
  assert.strictEqual(record.images.length, 1);
  assert.strictEqual(record.executionTime, 1234);
  assert.strictEqual(record.errorMessage, '');
  assert.strictEqual(ctx.errorMessage, '');
});

test('回归：普通失败仍记录 FAILED 且归属对应历史', async () => {
  const RunpodClient = {
    run() { return Promise.resolve({ success: false, message: '请求过于频繁，请稍后重试' }); },
    status() { return Promise.resolve({ success: true, data: { status: 'IN_QUEUE' } }); },
    poll() { return Promise.resolve({ success: false, cancelled: true, message: '用户取消' }); },
    cancel() { return Promise.resolve({ success: true }); }
  };
  const { ctx } = loadMain(RunpodClient);
  baseFixture(ctx, [makeRecord('h1', 'SUBMITTING')]);
  ctx.selectedHistoryId = 'h1';

  await ctx.runTask(makeTask('h1'));

  const record = ctx.requestHistory[0];
  assert.strictEqual(record.status, 'FAILED');
  assert.strictEqual(record.errorMessage, '请求过于频繁，请稍后重试');
  assert.strictEqual(ctx.errorMessage, '请求过于频繁，请稍后重试');
});

test('回归：排队模式生成仍进入队列并标记 IN_QUEUE', async () => {
  const { ctx } = loadMain({});
  baseFixture(ctx, []);
  Object.defineProperty(ctx, 'canGenerate', { configurable: true, value: true });
  ctx.seedRandomEachRun = false;
  ctx.getNewTaskAcceptance = () => ({ mode: 'queue' });
  ctx.getEffectiveGenerationSettings = () => ({
    allowQueue: true,
    allowConcurrent: false,
    maxConcurrent: 1,
    maxQueue: 1,
    storeMax: 30,
    lockParamsOnGenerate: false
  });
  ctx.getEffectiveRunMode = () => 'run';
  ctx.getEffectivePollIntervalMs = () => 2000;
  ctx.getEffectiveInitialPollDelayMs = () => 0;
  ctx.getEffectiveAutoScrollToResults = () => false;
  ctx.getEffectiveAutoSelectLatestResult = () => false;
  ctx.getClientConfigSnapshot = () => ({ endpointId: 'fixture', apiKey: 'not-real' });
  ctx.buildPayloadForCurrentInput = () => ({
    success: true,
    payload: { input: {} },
    payloadSize: 2,
    imageCount: 0
  });
  ctx.activeJobs = [{ taskId: 'busy', historyId: 'busy' }];
  ctx.jobQueue = [];

  await ctx.generate();

  assert.strictEqual(ctx.requestHistory.length, 1);
  assert.strictEqual(ctx.requestHistory[0].status, 'IN_QUEUE');
  assert.strictEqual(ctx.jobQueue.length, 1, '并发已满时进入队列');
  assert.strictEqual(ctx.jobQueue[0].historyId, ctx.requestHistory[0].id);
});

test('回归：排队任务取消后移除且标记 CANCELLED', async () => {
  const { ctx } = loadMain({});
  baseFixture(ctx, []);
  const queued = makeTask('h1');
  ctx.jobQueue = [queued];

  assert.strictEqual(ctx.cancelTaskByHistoryId('h1'), true);
  assert.strictEqual(ctx.jobQueue.length, 0);
  assert.strictEqual(queued.cancelRequested, true);
});

test('回归：手动重试轮询保持 pollOnly 且不重新提交', async () => {
  const { ctx } = loadMain({});
  baseFixture(ctx, [makeRecord('h1', 'IN_PROGRESS', { jobId: 'job-9' })]);
  Object.defineProperty(ctx, 'isConfigured', { configurable: true, value: true });
  ctx.getEffectivePollIntervalMs = () => 2000;
  ctx.buildClientConfigForHistoryRecord = () => ({ endpointId: 'fixture', apiKey: 'not-real' });
  let started = null;
  ctx.startTask = task => { started = task; };

  ctx.retryHistoryRecord('h1');

  assert.ok(started, '重试会启动任务');
  assert.strictEqual(started.pollOnly, true);
  assert.strictEqual(started.jobId, 'job-9');
  assert.strictEqual(ctx.requestHistory[0].status, 'IN_PROGRESS');
  assert.strictEqual(ctx.requestHistory[0].errorMessage, '');
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
  console.log(`${passed}/${cases.length} passed`);
})();
