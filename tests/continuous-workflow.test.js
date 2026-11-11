'use strict';
// 连续生成回归：捕获实际 Vue 选项，不访问网络，不生成真实任务。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function load() {
  let options;
  const components = {};
  const sandbox = {
    console, setTimeout, clearTimeout, navigator: { userAgent: 'node' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { getElementById() { return null; }, querySelector() { return null; } },
    Settings: {}, TemplateManager: { get() { return null; } },
    Vue: { createApp(o) { options = o; return {
      component(name, component) { components[name] = component; return this; }, mount() {}
    }; } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8'), sandbox);
  const ctx = options.data();
  for (const [key, method] of Object.entries(options.methods)) ctx[key] = method.bind(ctx);
  for (const [key, getter] of Object.entries(options.computed)) Object.defineProperty(ctx, key, { configurable: true, get: () => getter.call(ctx) });
  ctx.$nextTick = fn => { if (fn) fn(); return Promise.resolve(); };
  ctx.$refs = {};
  ctx._testDocument = sandbox.document;
  ctx._testStorage = sandbox.localStorage;
  ctx._testSettings = sandbox.Settings;
  return { ctx, options, components };
}
function generationFixture(ctx, history = []) {
  Object.defineProperty(ctx, 'canGenerate', { configurable: true, value: true });
  ctx.requestHistory = history;
  ctx.seedRandomEachRun = false;
  ctx.getNewTaskAcceptance = () => ({ mode: 'start' });
  ctx.buildPayloadForCurrentInput = () => ({ success: true, payload: {}, payloadSize: 2, imageCount: 1 });
  ctx.getEffectiveRunMode = () => 'runsync';
  ctx.getEffectivePollIntervalMs = () => 2000;
  ctx.getClientConfigSnapshot = () => ({ endpointId: 'fixture', apiKey: 'not-real' });
  ctx.createHistoryEntry = () => ({ id: 'new', status: 'SUBMITTING', images: [] });
  ctx.queuePersistHistory = () => {};
  ctx.startTask = () => {};
  ctx.pumpQueue = () => {};
  ctx.showUiToast = () => {};
}
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
test('两个行为都开启时生成后选择新任务并跳到结果区', async () => {
  const { ctx } = load();
  generationFixture(ctx, [{ id: 'old', status: 'COMPLETED', images: [{}, {}] }]);
  ctx.selectedHistoryId = 'old';
  ctx.selectedHistoryImageIndex = 1;
  ctx.resultsTab = 'gallery';
  ctx.getEffectiveAutoScrollToResults = () => true;
  ctx.getEffectiveAutoSelectLatestResult = () => true;
  let scrolled = 0;
  ctx.scrollToResults = () => { scrolled++; ctx.mainView = 'generate'; };
  await ctx.generate();
  assert.strictEqual(ctx.requestHistory[0].id, 'new');
  assert.strictEqual(ctx.selectedHistoryId, 'new');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 0);
  assert.strictEqual(ctx.resultsTab, 'history');
  assert.strictEqual(scrolled, 1);
});
test('只跳到结果区时不改变旧图选择', async () => {
  const { ctx } = load();
  generationFixture(ctx, [{ id: 'old', status: 'COMPLETED', images: [{}, {}] }]);
  ctx.selectedHistoryId = 'old';
  ctx.selectedHistoryImageIndex = 1;
  ctx.resultsTab = 'gallery';
  ctx.getEffectiveAutoScrollToResults = () => true;
  ctx.getEffectiveAutoSelectLatestResult = () => false;
  let scrolled = 0;
  ctx.scrollToResults = () => scrolled++;
  await ctx.generate();
  assert.strictEqual(ctx.selectedHistoryId, 'old');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 1);
  assert.strictEqual(ctx.resultsTab, 'gallery');
  assert.strictEqual(scrolled, 1);
});
test('只选择最新任务时不自动跳到结果区', async () => {
  const { ctx } = load();
  generationFixture(ctx, [{ id: 'old', status: 'COMPLETED', images: [{}, {}] }]);
  ctx.selectedHistoryId = 'old';
  ctx.selectedHistoryImageIndex = 1;
  ctx.resultsTab = 'gallery';
  ctx.getEffectiveAutoScrollToResults = () => false;
  ctx.getEffectiveAutoSelectLatestResult = () => true;
  ctx.scrollToResults = () => { throw new Error('不应跳转'); };
  await ctx.generate();
  assert.strictEqual(ctx.selectedHistoryId, 'new');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 0);
  assert.strictEqual(ctx.resultsTab, 'history');
});
test('关闭两个行为时保留旧图上下文且不提示提交Toast', async () => {
  const { ctx } = load();
  generationFixture(ctx, [{ id: 'old', status: 'COMPLETED', images: [{}, {}] }]);
  ctx.selectedHistoryId = 'old';
  ctx.selectedHistoryImageIndex = 1;
  ctx.resultsTab = 'gallery';
  ctx.getEffectiveAutoScrollToResults = () => false;
  ctx.getEffectiveAutoSelectLatestResult = () => false;
  let scrolled = 0;
  ctx.scrollToResults = () => scrolled++;
  const notices = [];
  ctx.showUiToast = (...args) => notices.push(args);
  await ctx.generate();
  assert.strictEqual(ctx.selectedHistoryId, 'old');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 1);
  assert.strictEqual(ctx.resultsTab, 'gallery');
  assert.strictEqual(scrolled, 0);
  assert.deepStrictEqual(notices, []);
});
test('大图预览打开时生成新任务可按设置跳转结果', async () => {
  const { ctx } = load();
  generationFixture(ctx, [{ id: 'old', status: 'COMPLETED', images: [{}] }]);
  ctx.selectedHistoryId = 'old';
  ctx.showImageModal = true;
  ctx.getEffectiveAutoScrollToResults = () => true;
  let scrolled = 0;
  ctx.scrollToResults = () => scrolled++;
  await ctx.generate();
  assert.strictEqual(scrolled, 1);
  assert.strictEqual(ctx.selectedHistoryId, 'new');
});
test('首个任务自动选中，关闭自动滚动时不切工作区', async () => {
  const { ctx } = load();
  generationFixture(ctx);
  ctx.rightPanelTab = 'prompts';
  ctx.getEffectiveAutoScrollToResults = () => false;
  ctx.scrollToResults = () => { throw new Error('不应滚动'); };
  await ctx.generate();
  assert.strictEqual(ctx.selectedHistoryId, 'new');
  assert.strictEqual(ctx.rightPanelTab, 'prompts');
});
test('后台任务完成不会改正在比较的图片索引', async () => {
  const { ctx } = load();
  ctx.requestHistory = [{ id: 'old', status: 'COMPLETED', images: [{}, {}] }, { id: 'new', status: 'IN_PROGRESS', images: [] }];
  ctx.selectedHistoryId = 'old';
  ctx.selectedHistoryImageIndex = 1;
  ctx.selectedGalleryIndex = 1;
  ctx.extractImagesFromRunpodData = () => [{ id: 'new-image' }];
  ctx.queuePersistHistory = () => {};
  ctx.persistHistoryNow = async () => {};
  ctx.showUiToast = () => {};
  await ctx.finalizeHistoryEntry('new', { executionTime: 0 });
  assert.strictEqual(ctx.selectedHistoryId, 'old');
  assert.strictEqual(ctx.selectedHistoryImageIndex, 1);
  assert.strictEqual(ctx.selectedGalleryIndex, 1);
});
test('取消历史参数覆盖确认不修改当前草稿', async () => {
  const { ctx } = load();
  ctx.workflowJson = '{"draft":true}';
  ctx.placeholderValues = { prompt: 'keep draft', seed: 123 };
  const before = JSON.stringify(ctx.placeholderValues);
  ctx.askConfirm = async () => false;
  await ctx.applyParamsFromRecord({ id: 'old', placeholderValues: { prompt: 'overwrite', seed: 42 } });
  assert.strictEqual(JSON.stringify(ctx.placeholderValues), before);
  assert.strictEqual(ctx.workflowJson, '{"draft":true}');
});
test('Esc关闭设置层，不影响底下的图片预览', () => {
  const { ctx } = load();
  ctx.showSettings = true;
  ctx.showImageModal = true;
  let closed = 0;
  ctx.closeSettings = () => { ctx.showSettings = false; closed++; };
  ctx.closeImageModal = () => { throw new Error('不应关闭底层预览'); };
  ctx.onGlobalKeydown({ key: 'Escape', preventDefault() {} });
  assert.strictEqual(closed, 1);
  assert.strictEqual(ctx.showImageModal, true);
});
test('输入框左右方向键不翻动底层预览', () => {
  const { ctx } = load();
  ctx.showImageModal = true;
  ctx.previewNext = () => { throw new Error('表单方向键不应切图'); };
  ctx.onGlobalKeydown({ key: 'ArrowRight', target: { tagName: 'INPUT' }, preventDefault() {} });
});
test('外部替换输入图片时预览跟随最新值而不是停留旧图', () => {
  const { components } = load();
  const component = components['image-upload'];
  const state = Object.assign(component.data(), { PreviewimageSrc: 'data:image/png;base64,b2xk' });
  component.watch.uploderimagesrc.handler.call(state, 'bmV3');
  assert.match(state.PreviewimageSrc, /bmV3$/);
});
test('新图插入图库头部后按图片 id 重定位，不切换到别的图', async () => {
  const { ctx } = load();
  ctx.requestHistory = [
    { id: 'new', status: 'IN_PROGRESS', images: [] },
    { id: 'old', status: 'COMPLETED', images: [{ id: 'b1' }] }
  ];
  ctx.selectedGalleryImageId = 'b1';
  ctx.selectedGalleryIndex = 0;
  ctx.previewMode = 'gallery';
  ctx.previewAnchorImageId = 'b1';
  ctx.previewIndex = 0;
  ctx.showImageModal = true;
  ctx.extractImagesFromRunpodData = () => [{ id: 'n1' }];
  ctx.queuePersistHistory = () => {};
  ctx.persistHistoryNow = async () => {};
  ctx.updateHistoryEntry = (id, patch) => {
    const idx = ctx.requestHistory.findIndex(r => r.id === id);
    if (idx !== -1) ctx.requestHistory[idx] = { ...ctx.requestHistory[idx], ...patch };
  };
  await ctx.finalizeHistoryEntry('new', { executionTime: 1 });
  assert.strictEqual(ctx.galleryImages.map(img => img.id).join(','), 'n1,b1');
  assert.strictEqual(ctx.selectedGalleryImageId, 'b1');
  assert.strictEqual(ctx.selectedGalleryIndex, 1);
  assert.strictEqual(ctx.previewIndex, 1);
});
function galleryFixture(ctx, count = 5) {
  ctx.requestHistory = [{ id: 'old', placeholderValues: { prompt: 'old prompt' }, images:
    Array.from({ length: count }, (_, i) => ({ id: `img-${i}`, imageUrl: `url-${i}` })) }];
  ctx.queuePersistHistory = () => {};
  ctx.persistHistoryNow = async () => {};
}
test('图库更新后即使尚未同步索引，大图和翻页仍按图片ID定位', () => {
  const { ctx } = load();
  galleryFixture(ctx);
  ctx.openPreviewFromGallery(3);
  ctx.requestHistory.unshift({ id: 'new', images: [{ id: 'new-0' }, { id: 'new-1' }] });
  assert.strictEqual(ctx.previewImage.id, 'img-3');
  assert.strictEqual(ctx.previewIndicatorText, '6 / 7');
  ctx.previewNext();
  assert.strictEqual(ctx.previewImage.id, 'img-4');
  assert.strictEqual(ctx.previewCanNext, false);
  ctx.previewNext();
  assert.strictEqual(ctx.previewImage.id, 'img-4');
  ctx.previewPrev();
  assert.strictEqual(ctx.previewImage.id, 'img-3');
});
test('末尾预览图被自动裁剪时保持图片和参数，关闭后释放保留图', () => {
  const { ctx } = load();
  galleryFixture(ctx);
  ctx.openPreviewFromGallery(4);
  ctx.applyPrunedRecordsToMemory([{ id: 'old', images: [{ id: 'img-0' }, { id: 'img-1' }] }]);
  assert.strictEqual(ctx.previewImage.id, 'img-4');
  assert.strictEqual(ctx.previewParamValues.prompt, 'old prompt');
  assert.strictEqual(ctx.previewIndicatorText, '3 / 3');
  assert.strictEqual(ctx.previewCanNext, false);
  ctx.previewPrev();
  assert.strictEqual(ctx.previewImage.id, 'img-1');
  assert.strictEqual(ctx.previewImages.length, 2);
  ctx.closeImageModal();
  assert.strictEqual(ctx.previewRetainedImage, null);
});
test('整条历史被裁剪时仍可查看当前图和参数，重新打开使用当前图库', () => {
  const { ctx } = load();
  galleryFixture(ctx, 1);
  ctx.openPreviewFromGallery(0);
  ctx.applyPrunedRecordsToMemory([]);
  ctx.ensureResultsSelection();
  assert.strictEqual(ctx.previewImage.id, 'img-0');
  assert.strictEqual(ctx.previewParamValues.prompt, 'old prompt');
  assert.strictEqual(ctx.previewIndicatorText, '1 / 1');
  ctx.closeImageModal();
  ctx.openPreviewFromGallery(0);
  assert.strictEqual(ctx.showImageModal, false);
});
test('图库删除当前图选相邻图，删除末图选前一张，删空关闭预览', async () => {
  const { ctx } = load();
  galleryFixture(ctx, 3);
  ctx.askConfirm = async () => true;
  ctx.openPreviewFromGallery(1);
  await ctx.deleteImage(ctx.previewImage);
  assert.strictEqual(ctx.previewImage.id, 'img-2');
  assert.strictEqual(ctx.previewIndicatorText, '2 / 2');
  await ctx.deleteImage(ctx.previewImage);
  assert.strictEqual(ctx.previewImage.id, 'img-0');
  assert.strictEqual(ctx.previewCanNext, false);
  await ctx.deleteImage(ctx.previewImage);
  assert.strictEqual(ctx.showImageModal, false);
  assert.strictEqual(ctx.previewRetainedImage, null);
});
test('删除前面的图保留当前ID，取消删除及生成提交均不切大图', async () => {
  const { ctx } = load();
  galleryFixture(ctx);
  ctx.openPreviewFromGallery(4);
  ctx.askConfirm = async () => true;
  await ctx.deleteImage(ctx.galleryImages[0]);
  assert.strictEqual(ctx.previewImage.id, 'img-4');
  assert.strictEqual(ctx.previewIndicatorText, '4 / 4');
  ctx.askConfirm = async () => false;
  await ctx.deleteImage(ctx.previewImage);
  assert.strictEqual(ctx.previewImage.id, 'img-4');
  generationFixture(ctx, ctx.requestHistory);
  ctx.getEffectiveAutoSelectLatestResult = () => true;
  ctx.getEffectiveAutoScrollToResults = () => false;
  await ctx.generate();
  assert.strictEqual(ctx.previewImage.id, 'img-4');
});
test('自动裁剪后可收藏保留图及其参数，主动删除保留图不会复活', async () => {
  const { ctx } = load();
  galleryFixture(ctx, 2);
  ctx.openPreviewFromGallery(1);
  ctx.applyPrunedRecordsToMemory([{ id: 'old', images: [{ id: 'img-0' }] }]);
  ctx.toggleFavorite(ctx.previewImage);
  assert.strictEqual(ctx.favorites[0].placeholderValues.prompt, 'old prompt');
  ctx.askConfirm = async () => true;
  await ctx.deleteImage(ctx.previewImage);
  assert.strictEqual(ctx.previewImage.id, 'img-0');
  assert.strictEqual(ctx.previewRetainedImage.id, 'img-0');
  assert.strictEqual(ctx.favorites.length, 0);
  ctx.reanchorImageSelections();
  assert.strictEqual(ctx.previewImages.length, 1);
});
test('收藏重排及历史预览不受图库保留图污染', () => {
  const { ctx } = load();
  galleryFixture(ctx, 3);
  ctx.openPreviewFromGallery(2);
  ctx.openPreviewFromHistory('old', 1);
  assert.strictEqual(ctx.previewImage.id, 'img-1');
  assert.strictEqual(ctx.previewRetainedImage, null);
  ctx.previewNext();
  assert.strictEqual(ctx.previewImage.id, 'img-2');
  ctx.favorites = [{ id: 'img-1', addedAt: 2 }, { id: 'img-0', addedAt: 1 }];
  ctx.openPreviewFromFavorites(1);
  ctx.favorites.unshift({ id: 'img-2', addedAt: 3 });
  assert.strictEqual(ctx.previewImage.id, 'img-0');
  assert.strictEqual(ctx.previewIndicatorText, '3 / 3');
  ctx.previewPrev();
  assert.strictEqual(ctx.previewImage.id, 'img-1');
  assert.strictEqual(ctx.previewRetainedImage, null);
});
test('公共资源库标签不显示内部 catalogVersion', () => {
  const { ctx } = load();
  ctx.catalogStatus = 'ready';
  ctx.catalogVersion = 42;
  assert.strictEqual(ctx.catalogSourceLabel, '统一库');
});
test('提示词设置里的自动补空格开关即时保存且刷新后生效', () => {
  const { ctx } = load();
  let saved;
  ctx._testSettings.save = config => { saved = config; };
  ctx._testSettings.get = () => saved;
  ctx.settings = { autoSpaceAfterAutocomplete: false };
  ctx.settingsForm = { autoSpaceAfterAutocomplete: false };
  ctx.settings.autoSpaceAfterAutocomplete = true;
  ctx.saveAutocompleteSpacingSetting();
  assert.strictEqual(saved.autoSpaceAfterAutocomplete, true);
  assert.strictEqual(ctx.settings.autoSpaceAfterAutocomplete, true);
  assert.strictEqual(ctx.settingsForm.autoSpaceAfterAutocomplete, true);
});
test('资源库图片预览不写入资源，点击背景或关闭即可退出', () => {
  const { ctx } = load();
  const item = { id: 'shared:preview', name: '测试片段', preview: { url: '/_rel/rev/catalog/previews/p.webp' } };
  ctx.openLibraryImagePreview(item);
  assert.strictEqual(ctx.showLibraryImagePreview, true);
  assert.strictEqual(ctx.libraryImagePreview.name, '测试片段');
  assert.strictEqual(ctx.libraryImagePreview.url, item.preview.url);
  assert.strictEqual(ctx.topOverlayLayer().key, 'libraryImage');
  ctx.closeLibraryImagePreview();
  assert.strictEqual(ctx.showLibraryImagePreview, false);
  assert.strictEqual(ctx.libraryImagePreview.name, '');
  assert.strictEqual(ctx.libraryImagePreview.url, '');
  ctx.openLibraryImagePreview({ name: '无图' });
  assert.strictEqual(ctx.showLibraryImagePreview, false);
});
test('图库显示方式独立记忆，损坏值及存储不可用时安全回退', () => {
  const { ctx } = load();
  let stored = null;
  ctx._testStorage.getItem = () => stored;
  ctx._testStorage.setItem = (key, value) => { stored = value; };
  ctx.loadGalleryImageFit();
  assert.strictEqual(ctx.galleryImageFit, 'cover');
  ctx.setGalleryImageFit('contain');
  assert.strictEqual(stored, 'contain');
  ctx.galleryImageFit = 'cover';
  ctx.loadGalleryImageFit();
  assert.strictEqual(ctx.galleryImageFit, 'contain');
  stored = 'invalid';
  ctx.loadGalleryImageFit();
  assert.strictEqual(ctx.galleryImageFit, 'cover');
  ctx._testStorage.setItem = () => { throw new Error('quota'); };
  ctx.setGalleryImageFit('contain');
  assert.strictEqual(ctx.galleryImageFit, 'contain');
});
test('生成禁用原因覆盖未配置与队列满，按钮文案区分加入队列', () => {
  const { ctx } = load();
  assert.match(ctx.generateDisabledReason, /未配置 Endpoint 或 API Key/);
  assert.strictEqual(ctx.generateBlocker.action, 'settings');
  ctx.isConfigValid = true;
  ctx.workflowJson = '{"a":1}';
  ctx.settings = { allowQueue: true, allowConcurrent: true, maxConcurrent: 1, maxQueue: 1, lockParamsOnGenerate: false };
  ctx.activeJobs = [{ taskId: 't1' }];
  ctx.jobQueue = [];
  assert.strictEqual(ctx.generateButtonLabel, '加入队列');
  assert.strictEqual(ctx.generateDisabledReason, '');
  ctx.jobQueue = [{ taskId: 't2' }];
  assert.match(ctx.generateDisabledReason, /排队已满/);
  ctx.settings = { allowQueue: false, allowConcurrent: true, maxConcurrent: 1, maxQueue: 0 };
  assert.match(ctx.generateDisabledReason, /并发已满/);
});
test('浮层打开或 IME 组合输入时 Ctrl+Enter 不生成，表单内仍可用', () => {
  const { ctx } = load();
  let generated = 0;
  ctx.generate = () => { generated++; };
  Object.defineProperty(ctx, 'canGenerate', { configurable: true, value: true });
  Object.defineProperty(ctx, 'canAcceptNewJob', { configurable: true, value: true });
  ctx.showSettings = true;
  ctx.onGlobalKeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.strictEqual(generated, 0);
  ctx.showSettings = false;
  ctx.onGlobalKeydown({ key: 'Enter', ctrlKey: true, isComposing: true, preventDefault() {} });
  assert.strictEqual(generated, 0);
  ctx.onGlobalKeydown({ key: 'Enter', ctrlKey: true, target: { tagName: 'TEXTAREA' }, preventDefault() {} });
  assert.strictEqual(generated, 1);
});
test('移除输入图后迟到的解码结果不能恢复旧图', () => {
  const { components } = load();
  const component = components['image-upload'];
  const state = Object.assign(component.data(), { PreviewimageSrc: 'data:image/png;base64,b2xk' });
  Object.keys(component.methods).forEach(key => { state[key] = component.methods[key].bind(state); });
  const emitted = [];
  state.$emit = (name, value) => emitted.push([name, value]);
  const token = 1;
  state._decodeToken = token;
  state.removeImage();
  assert.strictEqual(state.PreviewimageSrc, null);
  assert.ok(emitted.some(([name, value]) => name === 'update:uploderimagesrc' && value === ''));
  assert.ok(emitted.some(([name]) => name === 'remove'));
  // 迟到的 onload 使用旧 token：必须被忽略
  state.applyPreview('data:image/png;base64,b2xk', 'b2xk', 'image/png', token);
  assert.strictEqual(state.PreviewimageSrc, null);
});
test('历史参数回填先给摘要并按打开时的 Seed 快照保留，取消不改草稿', async () => {
  const { ctx } = load();
  ctx.settings = { allowQueue: false, allowConcurrent: false, maxConcurrent: 1, maxQueue: 0, lockParamsOnGenerate: true };
  ctx.activeJobs = [];
  ctx.workflowJson = '{"draft":true}';
  ctx.placeholderValues = { prompt: 'keep draft', seed: 123 };
  ctx.validatePlaceholders = () => {};
  ctx.onSizeChange = () => {};
  const record = { id: 'old', templateId: '', workflowJson: '', placeholderValues: { prompt: 'overwrite', seed: 42 } };
  await ctx.applyParamsFromRecord(record);
  assert.strictEqual(ctx.pendingParamsApply.seedSnapshot, 123);
  assert.match(ctx.pendingParamsApply.summary.lines.join('\n'), /正向提示词/);
  assert.strictEqual(ctx.placeholderValues.prompt, 'keep draft');
  ctx.resolveParamsApply(false);
  assert.strictEqual(ctx.placeholderValues.seed, 123);
  assert.strictEqual(ctx.pendingParamsApply, null);
  // 再次打开并确认：保留快照 Seed
  await ctx.applyParamsFromRecord(record);
  ctx.resolveParamsApply(true);
  assert.strictEqual(ctx.placeholderValues.prompt, 'overwrite');
  assert.strictEqual(ctx.placeholderValues.seed, 123);
});
test('应用参数期间模板被改动则拒绝，不静默覆盖草稿', async () => {
  const { ctx } = load();
  ctx.settings = { allowQueue: false, allowConcurrent: false, maxConcurrent: 1, maxQueue: 0, lockParamsOnGenerate: true };
  ctx.placeholderValues = { prompt: 'keep', seed: 1 };
  ctx.workflowJson = '{"draft":true}';
  ctx.validatePlaceholders = () => {};
  ctx.onSizeChange = () => {};
  await ctx.applyParamsFromRecord({ id: 'old', templateId: '', workflowJson: '', placeholderValues: { prompt: 'incoming', seed: 9 } });
  ctx.selectedTemplateId = 'switched-tpl';
  const applied = ctx.resolveParamsApply(true);
  assert.strictEqual(applied, false);
  assert.strictEqual(ctx.placeholderValues.prompt, 'keep');
  assert.strictEqual(ctx.pendingParamsApply, null);
});
test('参数摘要打开后修改提示词，确认拒绝覆盖新的编辑', async () => {
  const { ctx } = load();
  ctx.placeholderValues = { prompt: 'draft', seed: 3 };
  ctx.workflowJson = '{}';
  ctx.showUiToast = () => {};
  await ctx.applyParamsFromRecord({ placeholderValues: { prompt: 'history', seed: 1 } });
  ctx.placeholderValues.prompt = 'new edit';
  assert.strictEqual(ctx.resolveParamsApply(true), false);
  assert.strictEqual(ctx.placeholderValues.prompt, 'new edit');
});
test('确认层中Enter不绕过取消按钮，Tab仍使用焦点陷阱', () => {
  const { ctx } = load();
  ctx.uiDialog.show = true;
  let confirmed = false;
  let trapped = false;
  ctx.resolveUiDialog = () => { confirmed = true; };
  ctx.trapOverlayTab = () => { trapped = true; };
  ctx.onGlobalKeydown({ key: 'Enter', preventDefault() {} });
  assert.strictEqual(confirmed, false);
  ctx.onGlobalKeydown({ key: 'Tab', preventDefault() {} });
  assert.strictEqual(trapped, true);
});
test('嵌套确认层记住父弹窗中的触发按钮', () => {
  const { ctx } = load();
  const trigger = { closest() { return {}; }, focus() {} };
  const oldDocument = ctx.getOverlayElement;
  ctx.getOverlayElement = () => null;
  // 测试隔离 sandbox 的 document，通过 load 返回的引用设置 activeElement。
  ctx._testDocument.activeElement = trigger;
  ctx.focusOverlayOnOpen('uiDialog');
  assert.strictEqual(ctx._overlayTriggers.uiDialog, trigger);
  ctx.getOverlayElement = oldDocument;
});
(async () => {
  let passed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('ok - ' + name); }
    catch (error) { console.error('not ok - ' + name); console.error(error.stack); process.exitCode = 1; }
  }
  console.log(`${passed}/${cases.length} passed`);
})();
