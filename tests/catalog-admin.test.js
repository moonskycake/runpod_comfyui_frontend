/**
 * 管理后台表单、导入和弹窗键盘回归测试（直接 node 运行）
 *
 * 运行：node tests/catalog-admin.test.js
 *
 * 不启动浏览器、不访问网络、不写任何存储。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nodeVm = require('vm');

const CatalogAdmin = require(path.join(__dirname, '..', 'js', 'catalog-admin.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

test('parseJsonField 解析合法/非法/空值', () => {
  assert.deepStrictEqual(CatalogAdmin.parseJsonField('{"a":1}', 'Workflow').value, { a: 1 });
  assert.strictEqual(CatalogAdmin.parseJsonField('', 'Workflow').ok, false);
  const bad = CatalogAdmin.parseJsonField('{a:1}', 'Workflow');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /解析失败/);
});

test('模板表单生成 create payload', () => {
  const form = CatalogAdmin.emptyForm('template');
  form.name = ' 人像基础 ';
  form.description = ' desc ';
  form.category = '人像';
  form.order = '3';
  form.schemaVersion = '2';
  form.workflowText = '{"1":{"class_type":"LoadImage"}}';
  form.defaultsText = '{"seed":"{{seed}}"}';
  form.editorText = '{"profile":"txt2img"}';

  const result = CatalogAdmin.buildPayload('template', form);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(result.payload.kind, 'template');
  assert.strictEqual(result.payload.name, '人像基础');
  assert.strictEqual(result.payload.description, 'desc');
  assert.strictEqual(result.payload.order, 3);
  assert.deepStrictEqual(result.payload.data.workflow, { 1: { class_type: 'LoadImage' } });
  assert.strictEqual(result.payload.data.schemaVersion, 2);
});

test('模板表单拒绝非法 JSON、非对象 workflow、非法 schemaVersion', () => {
  const form = CatalogAdmin.emptyForm('template');
  form.name = 'x';
  const result = CatalogAdmin.buildPayload('template', form);
  assert.strictEqual(result.ok, true, '空对象 JSON 本身合法');

  form.workflowText = 'not json';
  form.schemaVersion = '0';
  const invalid = CatalogAdmin.buildPayload('template', form);
  assert.strictEqual(invalid.ok, false);
  assert.ok(invalid.errors.workflow);
  assert.ok(invalid.errors.schemaVersion);

  form.workflowText = '[1,2,3]';
  form.schemaVersion = '2';
  const wrongShape = CatalogAdmin.buildPayload('template', form);
  assert.strictEqual(wrongShape.ok, false);
  assert.match(wrongShape.errors.workflow, /对象/);
});

test('元数据校验：名称必填、上限、排序整数', () => {
  const form = CatalogAdmin.emptyForm('snippet');
  form.text = 'masterpiece';
  form.target = 'positive';

  const noName = CatalogAdmin.buildPayload('snippet', form);
  assert.strictEqual(noName.ok, false);
  assert.ok(noName.errors.name);

  form.name = 'x'.repeat(121);
  const tooLong = CatalogAdmin.buildPayload('snippet', form);
  assert.ok(tooLong.errors.name);

  form.name = '片段';
  form.order = '1.5';
  const badOrder = CatalogAdmin.buildPayload('snippet', form);
  assert.ok(badOrder.errors.order);

  form.order = '-2';
  const negativeOrder = CatalogAdmin.buildPayload('snippet', form);
  assert.strictEqual(negativeOrder.ok, true);
  assert.strictEqual(negativeOrder.payload.order, -2);
});

test('预设要求正负至少一项，且保留原始换行', () => {
  const form = CatalogAdmin.emptyForm('preset');
  form.name = '画质';
  form.positive = '';
  form.negative = '';
  const empty = CatalogAdmin.buildPayload('preset', form);
  assert.strictEqual(empty.ok, false);
  assert.ok(empty.errors.positive);

  form.positive = 'masterpiece\nbest quality';
  form.negative = 'lowres';
  const result = CatalogAdmin.buildPayload('preset', form);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payload.data.positive, 'masterpiece\nbest quality');
  assert.strictEqual(result.payload.data.negative, 'lowres');
});

test('片段校验插入目标与空文本', () => {
  const form = CatalogAdmin.emptyForm('snippet');
  form.name = '光效';
  form.text = '     ';
  form.target = 'sideways';
  const result = CatalogAdmin.buildPayload('snippet', form);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.target);
  assert.ok(result.errors.text);

  form.target = 'negative';
  form.text = 'glow';
  const ok = CatalogAdmin.buildPayload('snippet', form);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.payload.data, { text: 'glow', target: 'negative' });
});

test('PATCH payload 不携带 kind', () => {
  const form = CatalogAdmin.emptyForm('preset');
  form.name = 'p';
  form.positive = 'a';
  const result = CatalogAdmin.buildPayload('preset', form, { includeKind: false });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.payload, 'kind'), false);
  assert.strictEqual(result.payload.data.positive, 'a');
});

test('formFromItem 往返导出不丢字段', () => {
  const item = {
    id: 'shared:test',
    kind: 'template',
    name: 'T',
    description: 'D',
    category: 'C',
    order: 5,
    status: 'published',
    draftRev: 3,
    publishedRevision: 2,
    hasUnpublishedChanges: true,
    data: { schemaVersion: 2, workflow: { 1: {} }, defaults: { seed: 1 }, editor: { profile: 'p' } }
  };
  const form = CatalogAdmin.formFromItem(item);
  const built = CatalogAdmin.buildPayload('template', form);
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(built.payload.data, item.data);
  assert.strictEqual(built.payload.name, 'T');
  assert.strictEqual(built.payload.order, 5);
});

test('normalizeImportPayload 支持 {items}、数组、单条与字符串', () => {
  const record = {
    kind: 'preset',
    name: '导入预设',
    description: '',
    category: '',
    order: 0,
    data: { positive: 'a', negative: 'b' }
  };
  const wrapped = CatalogAdmin.normalizeImportPayload({ items: [record] });
  assert.strictEqual(wrapped.ok, true, wrapped.error);
  assert.strictEqual(wrapped.items.length, 1);
  assert.strictEqual(wrapped.items[0].kind, 'preset');

  const arrayForm = CatalogAdmin.normalizeImportPayload([record]);
  assert.strictEqual(arrayForm.ok, true);

  const single = CatalogAdmin.normalizeImportPayload(record);
  assert.strictEqual(single.ok, true);

  const stringForm = CatalogAdmin.normalizeImportPayload(JSON.stringify({ items: [record] }));
  assert.strictEqual(stringForm.ok, true);

  const badJson = CatalogAdmin.normalizeImportPayload('{oops');
  assert.strictEqual(badJson.ok, false);
  assert.match(badJson.error, /合法 JSON/);
});

test('normalizeImportPayload 拒绝未知类型、缺字段与超量', () => {
  const unknown = CatalogAdmin.normalizeImportPayload({ items: [{ kind: 'image', name: 'x', data: {} }] });
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error, /类型/);

  const missingName = CatalogAdmin.normalizeImportPayload({
    items: [{ kind: 'snippet', name: '', data: { text: 't', target: 'positive' } }]
  });
  assert.strictEqual(missingName.ok, false);
  assert.match(missingName.error, /名称不能为空/);

  const tooMany = CatalogAdmin.normalizeImportPayload({
    items: new Array(101).fill({ kind: 'snippet', name: 's', data: { text: 't', target: 'positive' } })
  });
  assert.strictEqual(tooMany.ok, false);
  assert.match(tooMany.error, /最多导入 100 项/);

  assert.strictEqual(CatalogAdmin.normalizeImportPayload({ items: [] }).ok, false);
  assert.strictEqual(CatalogAdmin.normalizeImportPayload(null).ok, false);
});

test('导入记录剥离后台字段，不携带会话/修订信息', () => {
  const normalized = CatalogAdmin.normalizeImportPayload({
    items: [{
      id: 'shared:abc',
      kind: 'snippet',
      name: 's',
      status: 'published',
      draftRev: 9,
      publishedRevision: 4,
      createdAt: '2026-01-01T00:00:00Z',
      data: { text: 't', target: 'positive' }
    }]
  });
  assert.strictEqual(normalized.ok, true, normalized.error);
  const item = normalized.items[0];
  assert.deepStrictEqual(Object.keys(item).sort(), ['category', 'data', 'description', 'kind', 'name', 'order']);
  assert.strictEqual(item.id, undefined);
  assert.strictEqual(item.status, undefined);
});

test('exportRecordFromItem 只输出资源内容', () => {
  const item = {
    id: 'shared:x',
    kind: 'preset',
    name: 'n',
    description: 'd',
    category: 'c',
    order: 1,
    status: 'published',
    publishedRevision: 2,
    data: { positive: 'p', negative: 'n', extra: 'drop' }
  };
  const record = CatalogAdmin.exportRecordFromItem(item);
  assert.deepStrictEqual(record, {
    kind: 'preset',
    name: 'n',
    description: 'd',
    category: 'c',
    order: 1,
    data: { positive: 'p', negative: 'n' }
  });
  assert.strictEqual(CatalogAdmin.exportRecordFromItem({ kind: 'bad', data: {} }), null);
});

test('filterItems 按类型外筛选查询/分类/状态', () => {
  const items = [
    { id: 'a', kind: 'template', name: '人像 基础', description: 'portrait', category: '人像', status: 'published', order: 0 },
    { id: 'b', kind: 'template', name: '场景', description: '', category: '场景', status: 'draft', order: 1 },
    { id: 'c', kind: 'preset', name: '画质', description: '', category: '人像', status: 'disabled', order: 2 }
  ];
  assert.strictEqual(CatalogAdmin.filterItems(items, {}).length, 3);
  assert.deepStrictEqual(CatalogAdmin.filterItems(items, { query: '人像' }).map((i) => i.id), ['a', 'c']);
  assert.deepStrictEqual(CatalogAdmin.filterItems(items, { query: 'portrait' }).map((i) => i.id), ['a']);
  assert.deepStrictEqual(CatalogAdmin.filterItems(items, { category: '场景' }).map((i) => i.id), ['b']);
  assert.deepStrictEqual(CatalogAdmin.filterItems(items, { status: 'published' }).map((i) => i.id), ['a']);
  assert.deepStrictEqual(CatalogAdmin.filterItems(items, { query: 'PORTRAIT' }).map((i) => i.id), ['a']);
  assert.strictEqual(CatalogAdmin.filterItems(null, {}).length, 0);
});

test('statusInfo 给出发布版本、未发布修改与删除边界', () => {
  const published = CatalogAdmin.statusInfo({
    status: 'published', publishedRevision: 3, draftRev: 4, hasUnpublishedChanges: true
  });
  assert.strictEqual(published.label, '已发布 v3');
  assert.strictEqual(published.tone, 'ok');
  assert.strictEqual(published.hasUnpublishedChanges, true);
  assert.strictEqual(published.canDelete, false);

  const draft = CatalogAdmin.statusInfo({ status: 'draft', publishedRevision: null, draftRev: 1 });
  assert.strictEqual(draft.canDelete, true);
  assert.strictEqual(draft.label, '草稿');

  const disabled = CatalogAdmin.statusInfo({ status: 'disabled', publishedRevision: 2 });
  assert.strictEqual(disabled.canDelete, false);
  assert.strictEqual(disabled.canDisable, false);
});

test('formatApiError 安全展示 detail 数组与冲突', () => {
  assert.strictEqual(CatalogAdmin.formatApiError({ detail: '名称重复' }, 409), '名称重复（HTTP 409）');
  assert.strictEqual(
    CatalogAdmin.formatApiError({ detail: [{ loc: ['body', 'name'], msg: '不能为空' }] }, 422),
    'name：不能为空（HTTP 422）'
  );
  assert.match(CatalogAdmin.formatApiError({ current: { id: 'x' } }, 409), /数据已变化/);
  assert.strictEqual(CatalogAdmin.formatApiError(null, 0), '请求失败');
});

test('preview 文件预检：仅 PNG/JPEG/WebP，拒绝 SVG/GIF/超大/空', () => {
  assert.strictEqual(CatalogAdmin.validatePreviewFile({ type: 'image/png', size: 1000 }).ok, true);
  assert.strictEqual(CatalogAdmin.validatePreviewFile({ type: 'image/jpeg', size: 1000 }).ok, true);
  assert.strictEqual(CatalogAdmin.validatePreviewFile({ type: 'image/webp', size: 1000 }).ok, true);
  ['image/svg+xml', 'image/gif', 'image/avif', ''].forEach((type) => {
    assert.strictEqual(CatalogAdmin.validatePreviewFile({ type, size: 1000 }).ok, false);
  });
  assert.strictEqual(CatalogAdmin.validatePreviewFile({ type: 'image/png', size: 0 }).ok, false);
  assert.strictEqual(
    CatalogAdmin.validatePreviewFile({ type: 'image/png', size: CatalogAdmin.PREVIEW.maxInputBytes + 1 }).ok,
    false
  );
});

test('preview 元信息与管理端 URL 契约', () => {
  const preview = {
    url: '/api/admin/items/shared%3Aabc/preview?rev=4',
    width: 480, height: 320, bytes: 40960, mime: 'image/webp'
  };
  assert.deepStrictEqual(CatalogAdmin.normalizeAdminPreview(preview), preview);
  assert.strictEqual(CatalogAdmin.previewSrc({ id: 'shared:abc', preview }), preview.url);
  assert.strictEqual(CatalogAdmin.adminPreviewUrl('shared:abc', 4), preview.url);
  assert.strictEqual(CatalogAdmin.previewUploadPath('shared:abc', 4), '/api/admin/items/shared%3Aabc/preview?baseRev=4');
  assert.strictEqual(CatalogAdmin.previewMetaLabel(preview), '480×320 · 40 KB');
  assert.strictEqual(CatalogAdmin.formatPreviewBytes(512), '512 B');
  assert.strictEqual(CatalogAdmin.normalizeAdminPreview({ ...preview, url: 'https://evil.example/x.webp' }), null);
  assert.strictEqual(CatalogAdmin.normalizeAdminPreview({ ...preview, url: 'javascript:alert(1)' }), null);
  assert.strictEqual(CatalogAdmin.normalizeAdminPreview({ ...preview, mime: 'image/svg+xml' }), null);
  assert.strictEqual(CatalogAdmin.normalizeAdminPreview({ ...preview, bytes: 64 * 1024 + 1 }), null);
});

test('previewGuard 要求先保存草稿且无未保存修改', () => {
  assert.strictEqual(CatalogAdmin.previewGuard({ isNew: true, hasItem: false, isDirty: false }).ok, false);
  assert.match(CatalogAdmin.previewGuard({ isNew: false, hasItem: true, isDirty: true }).error, /先保存草稿/);
  assert.strictEqual(CatalogAdmin.previewGuard({ isNew: false, hasItem: true, isDirty: false }).ok, true);
});

test('create/PATCH 与导入记录不携带 preview 字段', () => {
  const form = CatalogAdmin.emptyForm('preset');
  form.name = 'P';
  form.positive = 'a';
  form.preview = {
    url: '/api/admin/items/shared%3Ap/preview?rev=1',
    width: 10, height: 10, bytes: 10, mime: 'image/webp'
  };
  const built = CatalogAdmin.buildPayload('preset', form);
  assert.strictEqual(built.ok, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(built.payload, 'preview'), false);
  const imported = CatalogAdmin.normalizeImportPayload({
    items: [{
      kind: 'preset', name: 'P', data: { positive: 'a', negative: '' },
      preview: { url: '/api/catalog/shared%3Ap/preview?revision=1', width: 10, height: 10, bytes: 10, mime: 'image/webp' }
    }]
  });
  assert.strictEqual(imported.ok, true, imported.error);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(imported.items[0], 'preview'), false);
});

// ---------------- 对话框键盘/焦点回归（fake DOM + 真实 Vue 组件定义） ----------------

function matchesSelector(element, selector) {
  return String(selector).split(',').some(function (part) {
    return matchesCompound(element, part.trim());
  });
}

function matchesCompound(element, compound) {
  if (!compound) return false;
  if (compound === '*') return true;
  var nots = [];
  var classes = [];
  var rest = compound.replace(/:not\(([^)]+)\)/g, function (_, inner) {
    nots.push(inner.trim());
    return '';
  }).replace(/\.([\w-]+)/g, function (_, name) {
    classes.push(name);
    return '';
  });
  var tag = rest.match(/^[a-zA-Z][\w-]*/);
  if (tag && String(element.tagName || '').toLowerCase() !== tag[0].toLowerCase()) return false;
  var classAttr = element.getAttribute('class') || '';
  var classList = classAttr.split(/\s+/).filter(Boolean);
  if (classes.some(function (name) { return classList.indexOf(name) < 0; })) return false;
  var attrRe = /\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  var match;
  while ((match = attrRe.exec(rest))) {
    var name = match[1].trim();
    var expected = match[2] != null ? match[2] : (match[3] != null ? match[3] : match[4]);
    if (!element.hasAttribute(name)) return false;
    if (expected != null && element.getAttribute(name) !== expected) return false;
  }
  return !nots.some(function (inner) { return matchesCompound(element, inner); });
}

function FakeElement(tagName, attrs) {
  this.tagName = String(tagName || 'div').toUpperCase();
  this.attrs = Object.assign({}, attrs || {});
  this.children = [];
  this.parentNode = null;
  this.ownerDocument = null;
  this.disabled = false;
  this.hidden = false;
  this.style = {};
}

function assignOwnerDocument(node, doc) {
  node.ownerDocument = doc;
  node.children.forEach(function (child) { assignOwnerDocument(child, doc); });
}

FakeElement.prototype.getAttribute = function (name) {
  return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
};
FakeElement.prototype.hasAttribute = function (name) {
  return Object.prototype.hasOwnProperty.call(this.attrs, name);
};
FakeElement.prototype.setAttribute = function (name, value) {
  this.attrs[name] = String(value);
  if (name === 'disabled') this.disabled = true;
};
FakeElement.prototype.appendChild = function (child) {
  child.parentNode = this;
  assignOwnerDocument(child, this.ownerDocument);
  this.children.push(child);
  return child;
};
FakeElement.prototype.append = FakeElement.prototype.appendChild;
FakeElement.prototype.getClientRects = function () {
  var display = this.style.display;
  // display:contents 的元素本身没有盒子，但子元素仍有盒子。
  var hidden = this.hidden || display === 'none' || display === 'contents' || this.style.visibility === 'hidden';
  return hidden ? [] : [{}];
};
FakeElement.prototype.contains = function (node) {
  var current = node;
  while (current) {
    if (current === this) return true;
    current = current.parentNode;
  }
  return false;
};
FakeElement.prototype.matches = function (selector) {
  return matchesSelector(this, selector);
};
FakeElement.prototype.querySelectorAll = function (selector) {
  var out = [];
  var walk = function (node) {
    node.children.forEach(function (child) {
      if (matchesSelector(child, selector)) out.push(child);
      walk(child);
    });
  };
  walk(this);
  return out;
};
FakeElement.prototype.querySelector = function (selector) {
  return this.querySelectorAll(selector)[0] || null;
};
FakeElement.prototype.focus = function () {
  if (this.disabled) return;
  if (this.ownerDocument) this.ownerDocument.activeElement = this;
};
FakeElement.prototype.remove = function () {
  if (!this.parentNode) return;
  var siblings = this.parentNode.children;
  var index = siblings.indexOf(this);
  if (index >= 0) siblings.splice(index, 1);
  this.parentNode = null;
};

function FakeDocument() {
  this.children = [];
  this.activeElement = null;
  this.documentElement = new FakeElement('html');
  this.body = new FakeElement('body');
  this.documentElement.appendChild(this.body);
  this.appendChild(this.documentElement);
}
FakeDocument.prototype.appendChild = function (element) {
  element.parentNode = this;
  assignOwnerDocument(element, this);
  this.children.push(element);
  return element;
};
FakeDocument.prototype.contains = function (node) {
  var current = node;
  while (current) {
    if (current === this) return true;
    current = current.parentNode;
  }
  return false;
};
FakeDocument.prototype.querySelectorAll = function (selector) {
  var out = [];
  var walk = function (node) {
    node.children.forEach(function (child) {
      if (matchesSelector(child, selector)) out.push(child);
      walk(child);
    });
  };
  this.children.forEach(function (child) {
    if (matchesSelector(child, selector)) out.push(child);
    walk(child);
  });
  return out;
};
FakeDocument.prototype.querySelector = function (selector) {
  return this.querySelectorAll(selector)[0] || null;
};

function addFakeDialog(doc, labelledBy, options) {
  var opts = options || {};
  var attrs = { class: 'ca-dialog', role: 'dialog', 'aria-modal': 'true' };
  if (labelledBy) attrs['aria-labelledby'] = labelledBy;
  var dialog = new FakeElement('div', attrs);
  var heading = new FakeElement('h2', labelledBy ? { id: labelledBy } : {});
  dialog.appendChild(heading);
  (opts.children || []).forEach(function (child) { dialog.appendChild(child); });
  doc.body.appendChild(dialog);
  return dialog;
}

function fakeButton(text, attrs) {
  var button = new FakeElement('button', attrs || {});
  button.textContent = text;
  return button;
}

function loadAdminApp() {
  var fakeDocument = new FakeDocument();
  var captured = null;
  global.window = global;
  global.document = fakeDocument;
  global.Vue = {
    createApp: function (definition) {
      captured = definition;
      return { mount: function () { return {}; } };
    }
  };
  var modulePath = path.join(__dirname, '..', 'js', 'catalog-admin.js');
  delete require.cache[require.resolve(modulePath)];
  require(modulePath);
  return { options: captured, doc: fakeDocument };
}

function createVm(app, overrides) {
  var vm = Object.assign({}, app.options.data(), overrides || {});
  Object.keys(app.options.methods).forEach(function (name) {
    vm[name] = app.options.methods[name].bind(vm);
  });
  vm.$refs = vm.$refs || {};
  vm._dialogTriggers = {};
  vm.$nextTick = function (callback) { callback(); };
  Object.defineProperty(vm, 'anyDialogOpen', {
    configurable: true,
    get: function () { return app.options.computed.anyDialogOpen.call(vm); }
  });
  Object.defineProperty(vm, 'isReady', {
    configurable: true,
    get: function () { return app.options.computed.isReady.call(vm); }
  });
  return vm;
}

function keyEvent(key, options) {
  var opts = options || {};
  var event = {
    key: key,
    ctrlKey: !!opts.ctrlKey,
    metaKey: !!opts.metaKey,
    shiftKey: !!opts.shiftKey,
    prevented: 0,
    preventDefault: function () { this.prevented += 1; }
  };
  return event;
}

function runWatcher(app, vm, name, value) {
  app.options.watch[name].call(vm, value);
}

var AdminApp = loadAdminApp();
global.document = AdminApp.doc;

function freshDocument() {
  AdminApp.doc = new FakeDocument();
  global.document = AdminApp.doc;
  return AdminApp.doc;
}

test('onKeydown：Escape 只关闭最上层可关闭弹窗', () => {
  const doc = freshDocument();
  const publish = addFakeDialog(doc, 'ca-publish-title', { children: [fakeButton('取消')] });
  const discard = addFakeDialog(doc, 'ca-discard-title', { children: [fakeButton('继续编辑')] });
  const vm = createVm(AdminApp, {
    publishDialog: { open: true, acknowledge: false, busy: false, error: '' },
    discardDialog: { open: true, pending: null, message: '' }
  });

  const first = keyEvent('Escape');
  vm.onKeydown(first);
  assert.strictEqual(first.prevented, 1);
  assert.strictEqual(vm.discardDialog.open, false, '只关闭最上层 discard');
  assert.strictEqual(vm.publishDialog.open, true, '下层 publish 不得被连带关闭');

  discard.remove();
  const second = keyEvent('Escape');
  vm.onKeydown(second);
  assert.strictEqual(vm.publishDialog.open, false, '下一次 Escape 才关闭 publish');
  assert.strictEqual(publish.parentNode, doc.body);
});

test('onKeydown：会话过期拦截 Escape/Ctrl+S，不下穿到下层弹窗或保存', () => {
  const doc = freshDocument();
  addFakeDialog(doc, 'ca-publish-title', { children: [fakeButton('取消')] });
  const session = addFakeDialog(doc, 'ca-session-title', { children: [new FakeElement('input', { type: 'password' })] });
  const vm = createVm(AdminApp, {
    publishDialog: { open: true, acknowledge: false, busy: false, error: '' },
    sessionExpired: true,
    auth: { status: 'ready', csrfToken: 'x', expiresAt: '' }
  });
  let saves = 0;
  vm.saveDraft = function () { saves += 1; };

  const escape = keyEvent('Escape');
  vm.onKeydown(escape);
  assert.strictEqual(escape.prevented, 1);
  assert.strictEqual(vm.sessionExpired, true);
  assert.strictEqual(vm.publishDialog.open, true, '不得关闭下层 publish');

  const save = keyEvent('s', { ctrlKey: true });
  vm.onKeydown(save);
  assert.strictEqual(save.prevented, 1);
  assert.strictEqual(saves, 0, '会话过期时 Ctrl+S 不得保存');

  session.remove();
  const stackedEscape = keyEvent('Escape');
  vm.onKeydown(stackedEscape);
  assert.strictEqual(vm.publishDialog.open, true, 'DOM 尚未渲染 session 时也必须拦截');
});

test('onKeydown：Ctrl+S 在普通弹窗内被拦截，无弹窗且就绪时保存', () => {
  const doc = freshDocument();
  addFakeDialog(doc, 'ca-import-title', { children: [fakeButton('关闭')] });
  const vm = createVm(AdminApp, {
    importDialog: { open: true, text: '', fileName: '', busy: false, error: '', result: '' },
    auth: { status: 'ready', csrfToken: 'x', expiresAt: '' }
  });
  let saves = 0;
  vm.saveDraft = function () { saves += 1; };

  const blocked = keyEvent('s', { metaKey: true });
  vm.onKeydown(blocked);
  assert.strictEqual(blocked.prevented, 1);
  assert.strictEqual(saves, 0);

  doc.querySelectorAll('.ca-dialog').forEach(function (dialog) { dialog.remove(); });
  vm.importDialog.open = false;
  const active = keyEvent('s', { ctrlKey: true });
  vm.onKeydown(active);
  assert.strictEqual(active.prevented, 1);
  assert.strictEqual(saves, 1);
});

test('onKeydown：Tab 只在上层弹窗内循环，并跳过 disabled/tabindex=-1', () => {
  const doc = freshDocument();
  const publishCancel = fakeButton('取消');
  const publishInput = new FakeElement('input', { type: 'text' });
  const publishConfirm = fakeButton('确认');
  const disabled = fakeButton('禁用', { disabled: '' });
  const skipped = fakeButton('跳过', { tabindex: '-1' });
  const publish = addFakeDialog(doc, 'ca-publish-title', {
    children: [publishCancel, publishInput, publishConfirm, disabled, skipped]
  });
  const discardCancel = fakeButton('继续编辑');
  const discardConfirm = fakeButton('放弃');
  const discard = addFakeDialog(doc, 'ca-discard-title', { children: [discardCancel, discardConfirm] });
  const vm = createVm(AdminApp, {
    publishDialog: { open: true, acknowledge: false, busy: false, error: '' },
    discardDialog: { open: true, pending: null, message: '' }
  });

  doc.activeElement = publishConfirm;
  const topTab = keyEvent('Tab');
  vm.onKeydown(topTab);
  assert.strictEqual(doc.activeElement, discardCancel, '最上层是 discard，焦点应拉入 discard');

  discard.remove();
  doc.activeElement = publishConfirm;
  const wrap = keyEvent('Tab');
  vm.onKeydown(wrap);
  assert.strictEqual(wrap.prevented, 1);
  assert.strictEqual(doc.activeElement, publishCancel, '最后一个可聚焦元素回到第一个');

  doc.activeElement = publishCancel;
  vm.onKeydown(keyEvent('Tab', { shiftKey: true }));
  assert.strictEqual(doc.activeElement, publishConfirm, 'Shift+Tab 在第一个元素回到最后一个');

  const outside = fakeButton('外部');
  doc.body.appendChild(outside);
  doc.activeElement = outside;
  vm.onKeydown(keyEvent('Tab'));
  assert.strictEqual(doc.activeElement, publishCancel, '焦点逃出弹窗时拉回');
});

test('onKeydown：display:contents 祖先不应让可聚焦子元素被误判为隐藏', () => {
  const doc = freshDocument();
  const wrapper = new FakeElement('div');
  wrapper.style.display = 'contents';
  const cancel = fakeButton('取消');
  const confirm = fakeButton('确认');
  wrapper.appendChild(cancel);
  const dialog = addFakeDialog(doc, 'ca-delete-title', { children: [wrapper, confirm] });
  const vm = createVm(AdminApp, {
    deleteDialog: { open: true, busy: false, error: '' }
  });

  doc.activeElement = confirm;
  const event = keyEvent('Tab');
  vm.onKeydown(event);
  assert.strictEqual(event.prevented, 1);
  assert.strictEqual(doc.activeElement, cancel, 'display:contents 内的按钮仍应参与焦点循环');
  assert.strictEqual(dialog.contains(wrapper), true);
});

test('watch：打开记录触发器，关闭恢复；失效触发器回退到名称输入框', () => {
  const doc = freshDocument();
  const nameInput = new FakeElement('input', { id: 'ca-name' });
  const publishButton = fakeButton('发布…');
  doc.body.appendChild(nameInput);
  doc.body.appendChild(publishButton);
  doc.activeElement = publishButton;
  const vm = createVm(AdminApp, {
    publishDialog: { open: false, acknowledge: false, busy: false, error: '' },
    $refs: { nameInput: nameInput }
  });

  runWatcher(AdminApp, vm, 'publishDialogOpen', true);
  assert.strictEqual(vm._dialogTriggers.publish, publishButton, '打开时应记录触发器');

  runWatcher(AdminApp, vm, 'publishDialogOpen', false);
  assert.strictEqual(doc.activeElement, publishButton, '关闭后应恢复触发器');

  runWatcher(AdminApp, vm, 'publishDialogOpen', true);
  publishButton.remove();
  runWatcher(AdminApp, vm, 'publishDialogOpen', false);
  assert.strictEqual(doc.activeElement, nameInput, '触发器已失效时回退到名称输入框');
});

test('watch：会话过期关闭后恢复打开前的触发器', () => {
  const doc = freshDocument();
  const nameInput = new FakeElement('input', { id: 'ca-name' });
  const saveButton = fakeButton('保存草稿');
  doc.body.appendChild(nameInput);
  doc.body.appendChild(saveButton);
  doc.activeElement = saveButton;
  const vm = createVm(AdminApp, { sessionExpired: false, $refs: { nameInput: nameInput } });

  runWatcher(AdminApp, vm, 'sessionExpired', true);
  assert.strictEqual(vm._dialogTriggers.session, saveButton);
  runWatcher(AdminApp, vm, 'sessionExpired', false);
  assert.strictEqual(doc.activeElement, saveButton, '重新登录关闭会话弹窗后回到保存按钮');
});

test('watch：关闭下层弹窗时不得把焦点还给顶层弹窗之外', () => {
  const doc = freshDocument();
  const nameInput = new FakeElement('input', { id: 'ca-name' });
  const publishButton = fakeButton('发布…');
  const password = new FakeElement('input', { type: 'password' });
  doc.body.appendChild(nameInput);
  doc.body.appendChild(publishButton);
  addFakeDialog(doc, 'ca-session-title', { children: [password, fakeButton('重新登录')] });
  const vm = createVm(AdminApp, {
    publishDialog: { open: false, acknowledge: false, busy: false, error: '' },
    sessionExpired: false,
    $refs: { nameInput: nameInput }
  });

  doc.activeElement = publishButton;
  runWatcher(AdminApp, vm, 'publishDialogOpen', true);
  runWatcher(AdminApp, vm, 'sessionExpired', true);
  doc.activeElement = publishButton;
  runWatcher(AdminApp, vm, 'publishDialogOpen', false);
  assert.strictEqual(doc.activeElement, password, '顶层 session 打开时焦点只能进入 session');
  assert.notStrictEqual(doc.activeElement, publishButton);
});

test('watch：无显式 autofocus 的弹窗打开后焦点进入弹窗，且不跨层抢焦点', () => {
  const doc = freshDocument();
  const trigger = fakeButton('停用…');
  doc.body.appendChild(trigger);
  const cancel = fakeButton('取消');
  const confirm = fakeButton('确认停用');
  addFakeDialog(doc, 'ca-disable-title', { children: [cancel, confirm] });
  doc.activeElement = trigger;
  const vm = createVm(AdminApp, {
    disableDialog: { open: false, busy: false, error: '' }
  });

  runWatcher(AdminApp, vm, 'disableDialogOpen', true);
  assert.strictEqual(doc.activeElement, cancel, '无显式 autofocus 时焦点应进入弹窗首个安全操作');

  const session = addFakeDialog(doc, 'ca-session-title', { children: [new FakeElement('input', { type: 'password' })] });
  const deleteCancel = fakeButton('取消删除');
  addFakeDialog(doc, 'ca-delete-title', { children: [deleteCancel] });
  const stackedVm = createVm(AdminApp, {
    deleteDialog: { open: false, busy: false, error: '' }
  });
  doc.activeElement = trigger;
  runWatcher(AdminApp, stackedVm, 'deleteDialogOpen', true);
  assert.strictEqual(doc.activeElement, trigger, '非最上层弹窗打开时不得抢焦点');
  assert.strictEqual(session.parentNode, doc.body);
});

test('watch：打开弹窗不抢走现有显式 autofocus / 内部焦点', () => {
  const doc = freshDocument();
  const ack = new FakeElement('input', { type: 'checkbox', autofocus: '' });
  addFakeDialog(doc, 'ca-publish-title', { children: [ack, fakeButton('取消')] });
  doc.activeElement = ack;
  const vm = createVm(AdminApp, {
    publishDialog: { open: false, acknowledge: false, busy: false, error: '' }
  });

  runWatcher(AdminApp, vm, 'publishDialogOpen', true);
  assert.strictEqual(doc.activeElement, ack, '已有显式 autofocus 时不得被 watch 改写');
  assert.strictEqual(vm._dialogTriggers.publish, ack);
});

async function testProductionWatchers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'vue', 'vue.global.prod.js'), 'utf8');
  const context = nodeVm.createContext({});
  nodeVm.runInContext(source, context);
  const vue = context.Vue;
  const renderer = vue.createRenderer({ insert() {}, remove() {}, createComment() { return {}; } });
  const options = AdminApp.options;
  const changes = [];
  const component = renderer.createApp({
    data: options.data,
    computed: options.computed,
    watch: options.watch,
    methods: {
      handleDialogVisibilityChange(name, open) { changes.push([name, open]); }
    },
    render() { return null; }
  }).mount({});

  const names = ['publish', 'disable', 'delete', 'discard', 'import'];
  for (const name of names) {
    // Both replacing a dialog on open and mutating it on close are used in the app.
    const dialog = name + 'Dialog';
    component[dialog] = { ...component[dialog], open: true };
    await vue.nextTick();
    assert.deepStrictEqual(changes.pop(), [name, true], '生产包实际触发打开监听');
    component[dialog].open = false;
    await vue.nextTick();
    assert.deepStrictEqual(changes.pop(), [name, false], '生产包实际触发关闭监听');
  }
  component.sessionExpired = true;
  await vue.nextTick();
  assert.deepStrictEqual(changes, [['session', true]]);
}

testProductionWatchers().then(() => {
  passed += 1;
  console.log('ok - 生产 Vue 包实际触发弹窗开关监听');
  console.log('\n' + passed + ' tests passed');
}).catch(error => {
  console.error('not ok - 生产 Vue 包实际触发弹窗开关监听', error);
  process.exitCode = 1;
});
