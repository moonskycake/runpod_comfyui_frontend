/**
 * 管理后台纯逻辑回归测试（无依赖，直接 node 运行）
 *
 * 运行：node tests/catalog-admin.test.js
 *
 * 只测试 js/catalog-admin.js 导出的纯函数（表单 → API payload、JSON 解析、
 * 导入归一化、筛选、状态标签），不启动浏览器、不访问网络、不写任何存储。
 */
'use strict';

const assert = require('assert');
const path = require('path');

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

console.log('\n' + passed + ' tests passed');
