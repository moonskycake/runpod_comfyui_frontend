/**
 * 统一库管理后台（/admin/）—— 纯静态 Vue 3 入口
 *
 * 约束：
 * - 不写 localStorage / sessionStorage，登录态只依赖后端下发的不透明会话 Cookie。
 * - 所有写操作携带 X-CSRF-Token；权限边界由后端强制，前端隐藏按钮只是便利。
 * - 资源名称/描述/文本一律文本插值，禁止 v-html。
 * - 本文件同时导出纯函数（form/JSON/导入校验），便于 Node 环境做无依赖测试。
 */
(function (global) {
  'use strict';

  var KINDS = [
    { value: 'template', label: '工作流模板', hint: '图结构 + 占位符，决定能否生成' },
    { value: 'preset', label: '提示词预设', hint: '正向 + 负向整块快照' },
    { value: 'snippet', label: '片段', hint: '可插入到提示词输入框的文本' }
  ];
  var KIND_VALUES = KINDS.map(function (k) { return k.value; });
  var KIND_LABELS = { template: '工作流模板', preset: '提示词预设', snippet: '片段' };
  var STATUS_LABELS = { draft: '草稿', published: '已发布', disabled: '已停用' };
  var TARGETS = ['positive', 'negative'];
  var MAX_IMPORT_ITEMS = 100;
  var MAX_NAME = 120;
  var MAX_DESCRIPTION = 2000;
  var MAX_CATEGORY = 80;
  var MAX_TEXT = 50000;
  var PREVIEW = {
    mime: 'image/webp',
    accept: 'image/png,image/jpeg,image/webp',
    inputTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxInputBytes: 5 * 1024 * 1024,
    maxPixels: 16 * 1024 * 1024,
    maxSide: 480,
    maxOutputBytes: 64 * 1024
  };

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || String(kind || '');
  }

  function parseJsonField(text, label) {
    var name = label || 'JSON';
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, value: null, error: name + ' 不能为空' };
    }
    try {
      return { ok: true, value: JSON.parse(text), error: '' };
    } catch (err) {
      return { ok: false, value: null, error: name + ' 解析失败：' + (err && err.message ? err.message : 'JSON 不合法') };
    }
  }

  function serializeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return '';
    }
  }

  function emptyForm(kind) {
    var form = { name: '', description: '', category: '', order: '0' };
    if (kind === 'preset') {
      form.positive = '';
      form.negative = '';
    } else if (kind === 'snippet') {
      form.target = 'positive';
      form.text = '';
    } else {
      form.schemaVersion = '2';
      form.workflowText = '{}';
      form.defaultsText = '{}';
      form.editorText = '{}';
    }
    return form;
  }

  function formFromItem(item) {
    var kind = item && item.kind ? item.kind : 'template';
    var data = (item && isPlainObject(item.data)) ? item.data : {};
    var form = emptyForm(kind);
    form.name = item && typeof item.name === 'string' ? item.name : '';
    form.description = item && typeof item.description === 'string' ? item.description : '';
    form.category = item && typeof item.category === 'string' ? item.category : '';
    form.order = item && item.order != null ? String(item.order) : '0';
    if (kind === 'preset') {
      form.positive = typeof data.positive === 'string' ? data.positive : '';
      form.negative = typeof data.negative === 'string' ? data.negative : '';
    } else if (kind === 'snippet') {
      form.target = TARGETS.indexOf(data.target) >= 0 ? data.target : 'positive';
      form.text = typeof data.text === 'string' ? data.text : '';
    } else {
      form.schemaVersion = data.schemaVersion != null ? String(data.schemaVersion) : '2';
      form.workflowText = serializeJson(isPlainObject(data.workflow) ? data.workflow : {});
      form.defaultsText = serializeJson(isPlainObject(data.defaults) ? data.defaults : {});
      form.editorText = serializeJson(isPlainObject(data.editor) ? data.editor : {});
    }
    return form;
  }

  function validateTextLength(value, field, errors, max) {
    if (typeof value !== 'string') {
      errors[field] = '必须是文本';
      return;
    }
    if (value.length > max) {
      errors[field] = '长度超过 ' + max + ' 个字符';
    }
  }

  function validateData(kind, data, errors) {
    if (kind === 'template') {
      if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
        errors.schemaVersion = 'schemaVersion 必须是正整数';
      }
      if (!isPlainObject(data.workflow)) errors.workflow = 'workflow 必须是 JSON 对象';
      if (!isPlainObject(data.defaults)) errors.defaults = 'defaults 必须是 JSON 对象';
      if (!isPlainObject(data.editor)) errors.editor = 'editor 必须是 JSON 对象';
      return;
    }
    if (kind === 'preset') {
      validateTextLength(data.positive, 'positive', errors, MAX_TEXT);
      validateTextLength(data.negative, 'negative', errors, MAX_TEXT);
      var combined = (typeof data.positive === 'string' ? data.positive : '') +
        (typeof data.negative === 'string' ? data.negative : '');
      if (!combined.trim()) errors.positive = '正向与负向提示词至少填写一项';
      return;
    }
    if (kind === 'snippet') {
      if (TARGETS.indexOf(data.target) < 0) errors.target = '插入目标必须是 positive 或 negative';
      validateTextLength(data.text, 'text', errors, MAX_TEXT);
      if (typeof data.text === 'string' && !data.text.trim()) errors.text = '片段文本不能为空';
    }
  }

  function normalizeData(kind, data) {
    if (kind === 'template') {
      return {
        schemaVersion: data.schemaVersion,
        workflow: data.workflow,
        defaults: data.defaults,
        editor: data.editor
      };
    }
    if (kind === 'preset') {
      return { positive: data.positive, negative: data.negative };
    }
    return { text: data.text, target: data.target };
  }

  function formToData(kind, form) {
    var errors = {};
    var data = {};
    if (kind === 'template') {
      var schemaRaw = form.schemaVersion;
      var schema = typeof schemaRaw === 'number' ? schemaRaw : Number(String(schemaRaw == null ? '' : schemaRaw).trim());
      if (!Number.isInteger(schema) || schema < 1) {
        errors.schemaVersion = 'schemaVersion 必须是正整数';
      }
      var workflow = parseJsonField(form.workflowText, 'Workflow');
      if (!workflow.ok) errors.workflow = workflow.error;
      else if (!isPlainObject(workflow.value)) errors.workflow = 'workflow 必须是 JSON 对象';
      var defaults = parseJsonField(form.defaultsText, 'Defaults');
      if (!defaults.ok) errors.defaults = defaults.error;
      else if (!isPlainObject(defaults.value)) errors.defaults = 'defaults 必须是 JSON 对象';
      var editor = parseJsonField(form.editorText, 'Editor');
      if (!editor.ok) errors.editor = editor.error;
      else if (!isPlainObject(editor.value)) errors.editor = 'editor 必须是 JSON 对象';
      data = {
        schemaVersion: schema,
        workflow: workflow.ok ? workflow.value : null,
        defaults: defaults.ok ? defaults.value : null,
        editor: editor.ok ? editor.value : null
      };
    } else if (kind === 'preset') {
      data = {
        positive: typeof form.positive === 'string' ? form.positive : '',
        negative: typeof form.negative === 'string' ? form.negative : ''
      };
      validateData(kind, data, errors);
    } else if (kind === 'snippet') {
      data = {
        text: typeof form.text === 'string' ? form.text : '',
        target: form.target
      };
      validateData(kind, data, errors);
    } else {
      errors.kind = '未知资源类型';
    }
    return { ok: Object.keys(errors).length === 0, data: data, errors: errors };
  }

  function validateMetadata(source, errors) {
    var name = typeof source.name === 'string' ? source.name.trim() : '';
    var description = typeof source.description === 'string' ? source.description.trim() : '';
    var category = typeof source.category === 'string' ? source.category.trim() : '';
    var order = 0;
    if (source.order !== '' && source.order != null) {
      var n = Number(source.order);
      if (!Number.isInteger(n)) errors.order = '排序必须是整数';
      else order = n;
    }
    if (!name) errors.name = '名称不能为空';
    else if (name.length > MAX_NAME) errors.name = '名称不能超过 ' + MAX_NAME + ' 个字符';
    if (description.length > MAX_DESCRIPTION) errors.description = '描述不能超过 ' + MAX_DESCRIPTION + ' 个字符';
    if (category.length > MAX_CATEGORY) errors.category = '分类不能超过 ' + MAX_CATEGORY + ' 个字符';
    return { name: name, description: description, category: category, order: order };
  }

  function buildPayload(kind, form, options) {
    var opts = options || {};
    var errors = {};
    if (KIND_VALUES.indexOf(kind) < 0) {
      return { ok: false, payload: null, errors: { kind: '未知资源类型' } };
    }
    var meta = validateMetadata(form || {}, errors);
    var dataResult = formToData(kind, form || {});
    Object.keys(dataResult.errors).forEach(function (key) { errors[key] = dataResult.errors[key]; });
    if (Object.keys(errors).length) {
      return { ok: false, payload: null, errors: errors };
    }
    var payload = {
      name: meta.name,
      description: meta.description,
      category: meta.category,
      order: meta.order,
      data: dataResult.data
    };
    if (opts.includeKind !== false) payload.kind = kind;
    return { ok: true, payload: payload, errors: {} };
  }

  function validateCreateRecord(record) {
    if (!isPlainObject(record)) {
      return { ok: false, payload: null, errors: { record: '必须是对象' } };
    }
    var errors = {};
    var kind = record.kind;
    if (KIND_VALUES.indexOf(kind) < 0) {
      return { ok: false, payload: null, errors: { kind: '类型必须是 template / preset / snippet' } };
    }
    var meta = validateMetadata(record, errors);
    if (!isPlainObject(record.data)) {
      errors.data = 'data 必须是对象';
    } else {
      validateData(kind, record.data, errors);
    }
    if (Object.keys(errors).length) {
      return { ok: false, payload: null, errors: errors };
    }
    return {
      ok: true,
      errors: {},
      payload: {
        kind: kind,
        name: meta.name,
        description: meta.description,
        category: meta.category,
        order: meta.order,
        data: normalizeData(kind, record.data)
      }
    };
  }

  function normalizeImportPayload(input) {
    var parsed = input;
    if (typeof input === 'string') {
      var text = input.trim();
      if (!text) return { ok: false, items: [], error: '请粘贴或选择导入 JSON' };
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return { ok: false, items: [], error: '导入内容不是合法 JSON：' + (err && err.message ? err.message : '') };
      }
    }
    var records;
    if (Array.isArray(parsed)) records = parsed;
    else if (isPlainObject(parsed) && Array.isArray(parsed.items)) records = parsed.items;
    else if (isPlainObject(parsed) && typeof parsed.kind === 'string') records = [parsed];
    else return { ok: false, items: [], error: '导入格式应为 {items:[...]} 或单条资源对象' };

    if (!records.length) return { ok: false, items: [], error: '导入内容为空' };
    if (records.length > MAX_IMPORT_ITEMS) {
      return { ok: false, items: [], error: '单次最多导入 ' + MAX_IMPORT_ITEMS + ' 项，当前 ' + records.length + ' 项' };
    }
    var items = [];
    var problems = [];
    records.forEach(function (record, index) {
      var result = validateCreateRecord(record);
      if (!result.ok) {
        var messages = Object.keys(result.errors).map(function (key) { return result.errors[key]; });
        problems.push('第 ' + (index + 1) + ' 项：' + messages.join('；'));
      } else {
        items.push(result.payload);
      }
    });
    if (problems.length) {
      return { ok: false, items: [], error: problems.slice(0, 5).join('\n') + (problems.length > 5 ? '\n…' : '') };
    }
    return { ok: true, items: items, error: '' };
  }

  function exportRecordFromItem(item) {
    if (!item || KIND_VALUES.indexOf(item.kind) < 0 || !isPlainObject(item.data)) return null;
    return {
      kind: item.kind,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      category: typeof item.category === 'string' ? item.category : '',
      order: Number.isInteger(item.order) ? item.order : 0,
      data: normalizeData(item.kind, item.data)
    };
  }

  function filterItems(items, filters) {
    var f = filters || {};
    var query = typeof f.query === 'string' ? f.query.trim().toLowerCase() : '';
    return (Array.isArray(items) ? items : []).filter(function (item) {
      if (!item) return false;
      if (f.category && item.category !== f.category) return false;
      if (f.status && item.status !== f.status) return false;
      if (!query) return true;
      var haystack = [item.name, item.description, item.category, item.legacyId, item.id]
        .filter(function (v) { return typeof v === 'string'; })
        .join('\n')
        .toLowerCase();
      return haystack.indexOf(query) >= 0;
    });
  }

  function statusInfo(item) {
    var status = item && item.status ? item.status : 'draft';
    var publishedRevision = item && item.publishedRevision != null ? item.publishedRevision : null;
    var hasUnpublishedChanges = !!(item && item.hasUnpublishedChanges);
    var tone = status === 'published' ? 'ok' : status === 'disabled' ? 'muted' : 'warn';
    var label = STATUS_LABELS[status] || status;
    if (status === 'published' && publishedRevision != null) label = '已发布 v' + publishedRevision;
    return {
      status: status,
      tone: tone,
      label: label,
      publishedRevision: publishedRevision,
      hasUnpublishedChanges: hasUnpublishedChanges,
      canDelete: status !== 'published' && publishedRevision == null,
      canDisable: status !== 'disabled'
    };
  }

  function formatApiError(payload, status) {
    var detail = payload && payload.detail;
    if (Array.isArray(detail)) {
      var parts = detail.map(function (entry) {
        if (entry && typeof entry === 'object') {
          var loc = Array.isArray(entry.loc) ? entry.loc.filter(function (x) { return x !== 'body'; }).join('.') : '';
          return loc ? loc + '：' + (entry.msg || '不合法') : (entry.msg || '不合法');
        }
        return String(entry);
      });
      detail = parts.join('；');
    }
    if (typeof detail === 'string' && detail.trim()) {
      return status ? detail + '（HTTP ' + status + '）' : detail;
    }
    if (payload && payload.current) {
      return '数据已变化，请刷新后再合并（HTTP ' + status + '）';
    }
    return '请求失败' + (status ? '（HTTP ' + status + '）' : '');
  }

  function adminPreviewUrl(id, draftRev) {
    var itemId = String(id || '');
    var rev = Number(draftRev);
    if (!itemId || !isFinite(rev) || Math.trunc(rev) !== rev || rev < 0) return '';
    return '/api/admin/items/' + encodeURIComponent(itemId) + '/preview?rev=' + rev;
  }

  function previewUploadPath(id, baseRev) {
    var itemId = String(id || '');
    if (!itemId) return '';
    return '/api/admin/items/' + encodeURIComponent(itemId) + '/preview?baseRev=' + encodeURIComponent(String(baseRev));
  }

  function isAdminPreviewUrl(url) {
    if (typeof url !== 'string') return false;
    var value = url.trim();
    if (!value || value.charAt(0) !== '/' || value.startsWith('//') || value.length > 2048) return false;
    if (/[\\\u0000-\u001f\s]/.test(value) || value.indexOf('..') >= 0) return false;
    if (!/^\/api\/admin\/items\/[^/?#]+\/preview(?:\?[^#]*)?$/.test(value)) return false;
    return /(?:^|&)rev=\d+(?:&|$)/.test(value.split('?')[1] || '');
  }

  /**
   * 管理端 preview 响应规范化：只接受后台预览接口路径 + WebP + 上限内尺寸。
   */
  function normalizeAdminPreview(raw) {
    if (!isPlainObject(raw)) return null;
    var url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!isAdminPreviewUrl(url)) return null;
    if (String(raw.mime || '').toLowerCase() !== PREVIEW.mime) return null;
    var width = Number(raw.width);
    var height = Number(raw.height);
    var bytes = Number(raw.bytes);
    if (!Number.isInteger(width) || width <= 0 || width > PREVIEW.maxSide) return null;
    if (!Number.isInteger(height) || height <= 0 || height > PREVIEW.maxSide) return null;
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > PREVIEW.maxOutputBytes) return null;
    return { url: url, width: width, height: height, bytes: bytes, mime: PREVIEW.mime };
  }

  function previewSrc(item) {
    if (!item || !item.preview) return '';
    var normalized = normalizeAdminPreview(item.preview);
    return normalized ? normalized.url : '';
  }

  function formatPreviewBytes(bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value < 0) return '';
    if (value < 1024) return Math.round(value) + ' B';
    return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
  }

  function previewMetaLabel(preview) {
    var safe = normalizeAdminPreview(preview);
    if (!safe) return '';
    return safe.width + '×' + safe.height + ' · ' + formatPreviewBytes(safe.bytes);
  }

  /**
   * 客户端预检：只允许 PNG/JPEG/WebP 静态图，<=5MiB。服务端仍会权威校验。
   */
  function validatePreviewFile(file) {
    if (!file || typeof file !== 'object') return { ok: false, error: '请选择图片文件' };
    var type = String(file.type || '').toLowerCase();
    if (!type) return { ok: false, error: '无法识别图片类型，请选择 PNG / JPEG / WebP 图片' };
    if (PREVIEW.inputTypes.indexOf(type) < 0) {
      return { ok: false, error: '仅支持静态 PNG / JPEG / WebP 图片（不接受 SVG / GIF 等）' };
    }
    var size = Number(file.size);
    if (!isFinite(size) || size <= 0) return { ok: false, error: '图片文件为空或无法读取' };
    if (size > PREVIEW.maxInputBytes) {
      return { ok: false, error: '图片超过 5 MiB，请先压缩或换一张更小的图片' };
    }
    return { ok: true, error: '' };
  }

  /**
   * 上传/移除预览图前的状态检查：必须先保存草稿，且不能覆盖未保存文本。
   */
  function previewGuard(state) {
    var s = state || {};
    if (s.isNew || !s.hasItem) {
      return { ok: false, error: '请先保存草稿，再上传/移除预览图' };
    }
    if (s.isDirty) {
      return { ok: false, error: '当前有未保存修改，请先保存草稿再上传/移除预览图' };
    }
    return { ok: true, error: '' };
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch (err) {
      return d.toISOString();
    }
  }

  async function api(method, path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    else if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.csrf) headers['X-CSRF-Token'] = opts.csrf;
    var body = opts.rawBody !== undefined
      ? opts.rawBody
      : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    var response = await fetch(path, {
      method: method,
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body
    });
    var text = await response.text();
    var payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = { detail: text.slice(0, 500) };
      }
    }
    return { ok: response.ok, status: response.status, payload: payload };
  }

  var CatalogAdmin = {
    KINDS: KINDS,
    KIND_VALUES: KIND_VALUES,
    KIND_LABELS: KIND_LABELS,
    STATUS_LABELS: STATUS_LABELS,
    TARGETS: TARGETS,
    MAX_IMPORT_ITEMS: MAX_IMPORT_ITEMS,
    PREVIEW: PREVIEW,
    isPlainObject: isPlainObject,
    kindLabel: kindLabel,
    parseJsonField: parseJsonField,
    serializeJson: serializeJson,
    emptyForm: emptyForm,
    formFromItem: formFromItem,
    formToData: formToData,
    validateData: validateData,
    buildPayload: buildPayload,
    validateCreateRecord: validateCreateRecord,
    normalizeImportPayload: normalizeImportPayload,
    exportRecordFromItem: exportRecordFromItem,
    filterItems: filterItems,
    statusInfo: statusInfo,
    formatApiError: formatApiError,
    formatDate: formatDate,
    adminPreviewUrl: adminPreviewUrl,
    previewUploadPath: previewUploadPath,
    isAdminPreviewUrl: isAdminPreviewUrl,
    normalizeAdminPreview: normalizeAdminPreview,
    previewSrc: previewSrc,
    formatPreviewBytes: formatPreviewBytes,
    previewMetaLabel: previewMetaLabel,
    validatePreviewFile: validatePreviewFile,
    previewGuard: previewGuard,
    api: api
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CatalogAdmin;
  }
  if (global) global.CatalogAdmin = CatalogAdmin;

  if (!global || !global.document || !global.Vue) return;

  global.Vue.createApp({
    data: function () {
      return {
        kinds: KINDS,
        auth: { status: 'checking', csrfToken: '', expiresAt: '' },
        sessionExpired: false,
        loginForm: { password: '' },
        loginError: '',
        loginBusy: false,
        kind: 'template',
        items: [],
        listState: 'idle',
        listError: '',
        filters: { query: '', category: '', status: '' },
        busyItemId: '',
        mobilePane: 'list',
        isNew: false,
        selectedId: '',
        item: null,
        baseRev: null,
        form: emptyForm('template'),
        snapshot: '',
        formErrors: {},
        saving: false,
        saveError: '',
        saveNotice: '',
        noticeTone: 'ok',
        previewBusy: false,
        previewError: '',
        previewBroken: false,
        conflict: null,
        editorTab: 'form',
        publishDialog: { open: false, acknowledge: false, busy: false, error: '' },
        disableDialog: { open: false, busy: false, error: '' },
        deleteDialog: { open: false, busy: false, error: '' },
        discardDialog: { open: false, pending: null },
        importDialog: { open: false, text: '', fileName: '', busy: false, error: '', result: '' },
        toast: '',
        toastTone: 'ok'
      };
    },
    computed: {
      isReady: function () { return this.auth.status === 'ready'; },
      filteredItems: function () {
        return CatalogAdmin.filterItems(this.kindItems, this.filters);
      },
      kindItems: function () {
        var kind = this.kind;
        return this.items.filter(function (item) { return item.kind === kind; });
      },
      categories: function () {
        var seen = {};
        var out = [];
        this.kindItems.forEach(function (item) {
          var category = item.category || '';
          if (category && !seen[category]) {
            seen[category] = true;
            out.push(category);
          }
        });
        out.sort();
        return out;
      },
      kindCounts: function () {
        var counts = { template: 0, preset: 0, snippet: 0 };
        this.items.forEach(function (item) {
          if (counts[item.kind] != null) counts[item.kind] += 1;
        });
        return counts;
      },
      currentKindLabel: function () { return kindLabel(this.kind); },
      status: function () { return CatalogAdmin.statusInfo(this.item); },
      isDirty: function () {
        return this.snapshot !== '' && JSON.stringify(this.form) !== this.snapshot;
      },
      canDeleteDraft: function () {
        return !this.isNew && this.item && this.item.publishedRevision == null;
      },
      formJsonState: function () {
        if (this.kind !== 'template') return { ok: true, data: null, errors: {} };
        return CatalogAdmin.formToData(this.kind, this.form);
      },
      previewText: function () {
        var result = CatalogAdmin.formToData(this.kind, this.form);
        if (!result.ok) {
          var messages = Object.keys(result.errors).map(function (key) { return result.errors[key]; });
          return '预览不可用：\n' + messages.join('\n');
        }
        return JSON.stringify(result.data, null, 2);
      },
      importPreview: function () {
        if (!this.importDialog.open || !this.importDialog.text.trim()) return null;
        return CatalogAdmin.normalizeImportPayload(this.importDialog.text);
      },
      importKindSummary: function () {
        if (!this.importPreview || !this.importPreview.ok) return '';
        var self = this;
        return this.importPreview.items.map(function (item) { return self.kindLabel(item.kind); }).join('、');
      },
      sessionLabel: function () {
        return this.auth.expiresAt ? '会话至 ' + CatalogAdmin.formatDate(this.auth.expiresAt) : '';
      },
      anyDialogOpen: function () {
        return this.publishDialog.open || this.disableDialog.open || this.deleteDialog.open ||
          this.discardDialog.open || this.importDialog.open || this.sessionExpired;
      },
      adminPreviewSrc: function () {
        return CatalogAdmin.previewSrc(this.item);
      }
    },
    watch: {
      'filters.query': function () { this.mobilePane = 'list'; },
      mobilePane: function (pane) {
        if (pane === 'preview') this.editorTab = 'preview';
        else if (pane === 'edit') this.editorTab = 'form';
      }
    },
    mounted: function () {
      var self = this;
      this.snapshot = JSON.stringify(this.form);
      this.checkSession();
      document.addEventListener('keydown', this.onKeydown);
      this._beforeUnload = function (event) {
        if (!self.isDirty) return undefined;
        event.preventDefault();
        event.returnValue = '';
        return '';
      };
      window.addEventListener('beforeunload', this._beforeUnload);
    },
    beforeUnmount: function () {
      document.removeEventListener('keydown', this.onKeydown);
      window.removeEventListener('beforeunload', this._beforeUnload);
    },
    methods: {
      kindLabel: function (kind) { return kindLabel(kind); },
      statusInfo: function (item) { return CatalogAdmin.statusInfo(item); },
      formatDate: function (iso) { return CatalogAdmin.formatDate(iso); },
      previewMetaLabel: function (preview) { return CatalogAdmin.previewMetaLabel(preview); },
      onKeydown: function (event) {
        if (event.key === 'Escape' && this.anyDialogOpen && !this.sessionExpired) {
          this.closeDialogs();
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
          if (this.isReady && !this.anyDialogOpen) {
            event.preventDefault();
            this.saveDraft();
          }
        }
      },
      closeDialogs: function () {
        this.publishDialog.open = false;
        this.disableDialog.open = false;
        this.deleteDialog.open = false;
        this.discardDialog.open = false;
        this.importDialog.open = false;
      },
      showToast: function (message, tone) {
        var self = this;
        this.toast = message;
        this.toastTone = tone || 'ok';
        if (this._toastTimer) clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(function () { self.toast = ''; }, 5000);
      },
      handleUnauthorized: function () {
        this.auth.csrfToken = '';
        this.sessionExpired = true;
        this.loginError = '';
        this.loginBusy = false;
        var self = this;
        this.$nextTick(function () {
          if (self.$refs.sessionPassword) self.$refs.sessionPassword.focus();
        });
      },
      checkSession: async function () {
        this.auth.status = 'checking';
        var res = await CatalogAdmin.api('GET', '/api/admin/session');
        if (res.ok && res.payload && res.payload.authenticated) {
          this.applySession(res.payload);
          await this.loadItems();
          this.initialSelect();
        } else if (res.status === 401) {
          this.auth.status = 'anonymous';
        } else {
          this.auth.status = 'anonymous';
          this.loginError = CatalogAdmin.formatApiError(res.payload, res.status);
        }
      },
      applySession: function (payload) {
        this.auth.status = 'ready';
        this.auth.csrfToken = payload.csrfToken || '';
        this.auth.expiresAt = payload.expiresAt || '';
        this.sessionExpired = false;
      },
      submitLogin: async function (passwordRef) {
        if (this.loginBusy) return;
        var password = this.loginForm.password;
        if (!password) {
          this.loginError = '请输入管理员密码';
          return;
        }
        this.loginBusy = true;
        this.loginError = '';
        var res = await CatalogAdmin.api('POST', '/api/admin/login', { body: { password: password } });
        this.loginBusy = false;
        this.loginForm.password = '';
        if (!res.ok || !res.payload || !res.payload.authenticated) {
          this.loginError = CatalogAdmin.formatApiError(res.payload, res.status);
          var self = this;
          this.$nextTick(function () {
            if (passwordRef && passwordRef.focus) passwordRef.focus();
          });
          return;
        }
        var wasExpired = this.sessionExpired;
        this.applySession(res.payload);
        await this.loadItems();
        if (wasExpired) {
          this.showToast('已重新登录，编辑器中未保存的内容仍在');
        } else {
          this.initialSelect();
        }
      },
      doLogin: function () {
        this.submitLogin(this.$refs.password);
      },
      relogin: function () {
        this.submitLogin(this.$refs.sessionPassword);
      },
      doLogout: async function () {
        var res = await CatalogAdmin.api('POST', '/api/admin/logout', { csrf: this.auth.csrfToken });
        this.auth.status = 'anonymous';
        this.auth.csrfToken = '';
        this.auth.expiresAt = '';
        this.sessionExpired = false;
        this.items = [];
        this.item = null;
        this.selectedId = '';
        this.isNew = false;
        this.baseRev = null;
        this.form = emptyForm(this.kind);
        this.snapshot = JSON.stringify(this.form);
        this.loginForm.password = '';
        this.loginError = '';
        this.closeDialogs();
        if (!res.ok) this.loginError = CatalogAdmin.formatApiError(res.payload, res.status);
      },
      loadItems: async function () {
        if (!this.isReady) return;
        this.listState = 'loading';
        this.listError = '';
        var res = await CatalogAdmin.api('GET', '/api/admin/items');
        if (res.status === 401) {
          this.listState = 'error';
          this.listError = '登录已过期，请重新登录';
          this.handleUnauthorized();
          return;
        }
        if (!res.ok) {
          this.listState = 'error';
          this.listError = CatalogAdmin.formatApiError(res.payload, res.status);
          return;
        }
        var items = res.payload && Array.isArray(res.payload.items) ? res.payload.items : [];
        this.items = items;
        this.listState = items.length ? 'ready' : 'empty';
      },
      initialSelect: function () {
        if (this.item || this.isNew || this.selectedId) return;
        var first = this.kindItems[0];
        if (first) this.openItem(first.id);
        else this.startNew();
      },
      guardDiscard: function (pending) {
        if (!this.isDirty) {
          this.runPending(pending);
          return;
        }
        this.discardDialog.open = true;
        this.discardDialog.pending = pending;
      },
      confirmDiscard: function () {
        var pending = this.discardDialog.pending;
        this.discardDialog.open = false;
        this.discardDialog.pending = null;
        this.snapshot = JSON.stringify(this.form);
        this.runPending(pending);
      },
      runPending: function (pending) {
        if (!pending) return;
        if (pending.type === 'select') this.openItem(pending.id);
        else if (pending.type === 'new') this.startNewNow();
        else if (pending.type === 'kind') this.applyKind(pending.kind);
      },
      applyKind: function (kind) {
        if (kind === this.kind) return;
        this.kind = kind;
        this.filters.category = '';
        this.filters.status = '';
        this.item = null;
        this.selectedId = '';
        this.baseRev = null;
        this.isNew = false;
        this.startNewNow();
        this.loadItems();
      },
      selectItem: function (item) {
        if (this.selectedId === item.id && this.item) {
          this.mobilePane = 'edit';
          return;
        }
        this.guardDiscard({ type: 'select', id: item.id });
      },
      openItem: async function (id) {
        this.busyItemId = id;
        var res = await CatalogAdmin.api('GET', '/api/admin/items/' + encodeURIComponent(id));
        this.busyItemId = '';
        if (res.status === 401) {
          this.handleUnauthorized();
          return;
        }
        if (!res.ok || !res.payload) {
          this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
          this.listError = this.saveError;
          this.listState = 'error';
          return;
        }
        this.applyItem(res.payload);
        this.mobilePane = 'edit';
      },
      applyItem: function (item) {
        this.item = item;
        this.isNew = false;
        this.selectedId = item.id;
        this.baseRev = item.draftRev;
        if (item.kind && item.kind !== this.kind) this.kind = item.kind;
        this.form = formFromItem(item);
        this.snapshot = JSON.stringify(this.form);
        this.formErrors = {};
        this.saveError = '';
        this.saveNotice = '';
        this.conflict = null;
        this.previewError = '';
        this.previewBroken = false;
        this.editorTab = 'form';
        var self = this;
        this.$nextTick(function () {
          if (self.$refs.nameInput) self.$refs.nameInput.focus();
        });
      },
      requestNew: function () {
        if (this.isNew) {
          this.mobilePane = 'edit';
          return;
        }
        this.guardDiscard({ type: 'new' });
      },
      startNew: function () {
        this.startNewNow();
      },
      startNewNow: function () {
        this.item = null;
        this.isNew = true;
        this.selectedId = '';
        this.baseRev = null;
        this.form = emptyForm(this.kind);
        this.snapshot = JSON.stringify(this.form);
        this.formErrors = {};
        this.saveError = '';
        this.saveNotice = '';
        this.conflict = null;
        this.previewError = '';
        this.previewBroken = false;
        this.editorTab = 'form';
        this.mobilePane = 'edit';
        var self = this;
        this.$nextTick(function () {
          if (self.$refs.nameInput) self.$refs.nameInput.focus();
        });
      },
      refreshList: async function () {
        await this.loadItems();
      },
      focusFirstError: function (errors) {
        this.formErrors = errors;
        var order = ['name', 'description', 'category', 'order', 'schemaVersion', 'workflow', 'defaults', 'editor', 'positive', 'negative', 'target', 'text'];
        var first = order.find(function (key) { return errors[key]; });
        if (!first) return;
        var self = this;
        this.$nextTick(function () {
          var el = first === 'name' ? self.$refs.nameInput : self.$refs['field-' + first];
          if (el && el.focus) el.focus();
        });
      },
      saveDraft: async function () {
        if (this.saving || !this.isReady || this.sessionExpired) return;
        if (this.isNew && !this.item) {
          // 新建时必须先有表单内容；空表单也能保存，但要求名称
        }
        var built = CatalogAdmin.buildPayload(this.kind, this.form);
        if (!built.ok) {
          this.saveError = '请先修正表单中的错误（' + Object.keys(built.errors).length + ' 处）';
          this.saveNotice = '';
          this.focusFirstError(built.errors);
          return;
        }
        this.formErrors = {};
        this.saving = true;
        this.saveError = '';
        this.saveNotice = '';
        this.conflict = null;
        var res;
        if (this.isNew) {
          res = await CatalogAdmin.api('POST', '/api/admin/items', { body: built.payload, csrf: this.auth.csrfToken });
          if (res.status === 401) {
            this.saving = false;
            this.handleUnauthorized();
            return;
          }
          if (res.ok && res.payload) {
            var wasTemplate = this.kind;
            this.applyItem(res.payload);
            this.kind = wasTemplate;
            await this.refreshList();
            this.saveNotice = '已保存为草稿（未公开）';
            this.showToast('草稿已保存');
          } else if (res.status === 409 && res.payload && res.payload.current) {
            this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
            this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
          } else {
            this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
          }
        } else if (this.item) {
          var patchPayload = CatalogAdmin.buildPayload(this.kind, this.form, { includeKind: false }).payload;
          patchPayload.baseRev = this.baseRev;
          res = await CatalogAdmin.api('PATCH', '/api/admin/items/' + encodeURIComponent(this.item.id), {
            body: patchPayload,
            csrf: this.auth.csrfToken
          });
          if (res.status === 401) {
            this.saving = false;
            this.handleUnauthorized();
            return;
          }
          if (res.ok && res.payload) {
            var wasKind = this.kind;
            this.applyItem(res.payload);
            this.kind = wasKind;
            await this.refreshList();
            this.saveNotice = res.payload.publishedRevision != null && res.payload.hasUnpublishedChanges
              ? '草稿已保存；公开版本仍为 v' + res.payload.publishedRevision + '，显式发布后才切换'
              : '草稿已保存（未公开）';
            this.showToast('草稿已保存');
          } else if (res.status === 409 && res.payload && res.payload.current) {
            this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
            this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
          } else {
            this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
          }
        }
        this.saving = false;
      },
      reloadServerVersion: async function () {
        if (!this.selectedId) return;
        this.conflict = null;
        this.snapshot = JSON.stringify(this.form);
        await this.openItem(this.selectedId);
        this.saveError = '';
        this.showToast('已加载服务器最新草稿');
      },
      overwriteWithLocal: function () {
        if (!this.conflict || !this.conflict.current) return;
        this.baseRev = this.conflict.current.draftRev;
        this.conflict = null;
        this.saveDraft();
      },
      openPublish: function () {
        if (this.isNew || !this.item) {
          this.saveNotice = '请先保存草稿，再执行发布';
          return;
        }
        if (this.isDirty) {
          this.saveNotice = '当前有未保存修改，请先保存草稿再发布';
          return;
        }
        this.publishDialog = { open: true, acknowledge: false, busy: false, error: '' };
        var self = this;
        this.$nextTick(function () {
          if (self.$refs.publishAck) self.$refs.publishAck.focus();
        });
      },
      confirmPublish: async function () {
        if (!this.item || this.publishDialog.busy) return;
        if (!this.publishDialog.acknowledge) {
          this.publishDialog.error = '请先勾选确认：workflow 中不含 API Key/Token 等敏感信息';
          return;
        }
        this.publishDialog.busy = true;
        this.publishDialog.error = '';
        var res = await CatalogAdmin.api('POST', '/api/admin/items/' + encodeURIComponent(this.item.id) + '/publish', {
          body: { baseRev: this.baseRev, acknowledgeSecrets: true },
          csrf: this.auth.csrfToken
        });
        this.publishDialog.busy = false;
        if (res.status === 401) {
          this.publishDialog.open = false;
          this.handleUnauthorized();
          return;
        }
        if (res.ok && res.payload) {
          var wasKind = this.kind;
          this.applyItem(res.payload);
          this.kind = wasKind;
          await this.refreshList();
          this.publishDialog.open = false;
          this.showToast('已发布 v' + res.payload.publishedRevision);
        } else if (res.status === 409 && res.payload && res.payload.current) {
          this.publishDialog.open = false;
          this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
          this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
        } else {
          this.publishDialog.error = CatalogAdmin.formatApiError(res.payload, res.status);
        }
      },
      openDisable: function () {
        if (this.isNew || !this.item) return;
        this.disableDialog = { open: true, busy: false, error: '' };
      },
      confirmDisable: async function () {
        if (!this.item || this.disableDialog.busy) return;
        this.disableDialog.busy = true;
        this.disableDialog.error = '';
        var res = await CatalogAdmin.api('POST', '/api/admin/items/' + encodeURIComponent(this.item.id) + '/disable', {
          body: { baseRev: this.baseRev },
          csrf: this.auth.csrfToken
        });
        this.disableDialog.busy = false;
        if (res.status === 401) {
          this.disableDialog.open = false;
          this.handleUnauthorized();
          return;
        }
        if (res.ok && res.payload) {
          var wasKind = this.kind;
          this.applyItem(res.payload);
          this.kind = wasKind;
          await this.refreshList();
          this.disableDialog.open = false;
          this.showToast('资源已停用，公开目录不再展示');
        } else if (res.status === 409 && res.payload && res.payload.current) {
          this.disableDialog.open = false;
          this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
          this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
        } else {
          this.disableDialog.error = CatalogAdmin.formatApiError(res.payload, res.status);
        }
      },
      openDelete: function () {
        if (!this.canDeleteDraft) return;
        this.deleteDialog = { open: true, busy: false, error: '' };
      },
      confirmDelete: async function () {
        if (!this.item || this.deleteDialog.busy) return;
        this.deleteDialog.busy = true;
        this.deleteDialog.error = '';
        var path = '/api/admin/items/' + encodeURIComponent(this.item.id) + '?baseRev=' + encodeURIComponent(String(this.baseRev));
        var res = await CatalogAdmin.api('DELETE', path, { csrf: this.auth.csrfToken });
        this.deleteDialog.busy = false;
        if (res.status === 401) {
          this.deleteDialog.open = false;
          this.handleUnauthorized();
          return;
        }
        if (res.ok) {
          this.deleteDialog.open = false;
          this.item = null;
          this.selectedId = '';
          this.isNew = false;
          this.baseRev = null;
          this.form = emptyForm(this.kind);
          this.snapshot = JSON.stringify(this.form);
          await this.refreshList();
          this.showToast('未发布草稿已删除');
          this.initialSelect();
        } else if (res.status === 409 && res.payload && res.payload.current) {
          this.deleteDialog.open = false;
          this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
          this.saveError = CatalogAdmin.formatApiError(res.payload, res.status);
        } else {
          this.deleteDialog.error = CatalogAdmin.formatApiError(res.payload, res.status);
        }
      },
      exportRecord: function () {
        var built = CatalogAdmin.buildPayload(this.kind, this.form);
        if (!built.ok) {
          this.saveError = '导出前请修正表单错误';
          this.focusFirstError(built.errors);
          return null;
        }
        return built.payload;
      },
      downloadBlob: function (payload, filename) {
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      },
      stamp: function () {
        return new Date().toISOString().replace(/[:.]/g, '-');
      },
      exportSelected: function () {
        var record = this.exportRecord();
        if (!record) return;
        this.downloadBlob({
          version: 1,
          kind: this.kind,
          exportedAt: new Date().toISOString(),
          items: [record]
        }, 'catalog-' + this.kind + '-' + this.stamp() + '.json');
        this.showToast('已导出资源内容 JSON（不含会话与密码）');
      },
      exportAll: function () {
        var kind = this.kind;
        var records = this.kindItems.map(function (item) {
          return CatalogAdmin.exportRecordFromItem(item);
        }).filter(Boolean);
        if (!records.length) {
          this.showToast('当前类型没有可导出的资源', 'warn');
          return;
        }
        this.downloadBlob({
          version: 1,
          kind: kind,
          exportedAt: new Date().toISOString(),
          items: records
        }, 'catalog-' + kind + '-all-' + this.stamp() + '.json');
        this.showToast('已导出 ' + records.length + ' 项资源内容');
      },
      openImport: function () {
        this.importDialog = { open: true, text: '', fileName: '', busy: false, error: '', result: '' };
        var self = this;
        this.$nextTick(function () {
          if (self.$refs.importText) self.$refs.importText.focus();
        });
      },
      readImportFile: function (event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        var self = this;
        var reader = new FileReader();
        reader.onload = function () {
          self.importDialog.text = String(reader.result || '');
          self.importDialog.fileName = file.name;
          self.importDialog.error = '';
          self.importDialog.result = '';
        };
        reader.onerror = function () {
          self.importDialog.error = '读取文件失败';
        };
        reader.readAsText(file);
      },
      submitImport: async function () {
        if (this.importDialog.busy) return;
        var parsed = CatalogAdmin.normalizeImportPayload(this.importDialog.text);
        if (!parsed.ok) {
          this.importDialog.error = parsed.error;
          return;
        }
        this.importDialog.busy = true;
        this.importDialog.error = '';
        var res = await CatalogAdmin.api('POST', '/api/admin/import', {
          body: { items: parsed.items },
          csrf: this.auth.csrfToken
        });
        this.importDialog.busy = false;
        if (res.status === 401) {
          this.importDialog.open = false;
          this.handleUnauthorized();
          return;
        }
        if (res.ok) {
          var created = res.payload && Array.isArray(res.payload.items) ? res.payload.items : [];
          this.importDialog.result = '已导入 ' + created.length + ' 项草稿（未公开）';
          await this.refreshList();
          this.showToast('已导入 ' + created.length + ' 项草稿');
          if (!this.item && !this.isNew && created.length) this.openItem(created[0].id);
        } else {
          this.importDialog.error = CatalogAdmin.formatApiError(res.payload, res.status);
        }
      },
      switchKind: function (kind) {
        if (kind === this.kind) return;
        this.guardDiscard({ type: 'kind', kind: kind });
      },
      showMobilePane: function (pane) {
        this.mobilePane = pane;
      },
      previewGuardError: function () {
        var guard = CatalogAdmin.previewGuard({
          isNew: this.isNew,
          hasItem: !!this.item,
          isDirty: this.isDirty
        });
        return guard.ok ? '' : guard.error;
      },
      triggerPreviewPick: function () {
        if (this.previewBusy) return;
        var error = this.previewGuardError();
        if (error) {
          this.previewError = error;
          this.saveNotice = error;
          return;
        }
        this.previewError = '';
        this.saveNotice = '';
        if (this.$refs.previewFile) this.$refs.previewFile.click();
      },
      decodePreviewImage: async function (file) {
        if (typeof createImageBitmap === 'function') {
          try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
          } catch (err) {
            // 部分浏览器不支持参数，回退到默认解码
          }
          try {
            return await createImageBitmap(file);
          } catch (err) {
            throw new Error('无法解码图片，文件可能已损坏或不是有效图片');
          }
        }
        return await new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(file);
          var image = new Image();
          image.onload = function () {
            URL.revokeObjectURL(url);
            resolve(image);
          };
          image.onerror = function () {
            URL.revokeObjectURL(url);
            reject(new Error('无法解码图片，文件可能已损坏或不是有效图片'));
          };
          image.src = url;
        });
      },
      canvasToBlob: function (canvas, quality) {
        return new Promise(function (resolve, reject) {
          if (!canvas.toBlob) {
            reject(new Error('当前浏览器不支持图片压缩'));
            return;
          }
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('图片压缩失败'));
          }, 'image/webp', quality);
        });
      },
      /**
       * 压缩为 WebP：长边 <= 480px、输出 <= 64KiB，不保留原图/EXIF/ICC。
       * 输入像素超过 16MP 直接拒绝（防解码炸弹）。
       */
      compressPreviewImage: async function (file) {
        var bitmap = await this.decodePreviewImage(file);
        var srcW = Number(bitmap.width || bitmap.naturalWidth || 0);
        var srcH = Number(bitmap.height || bitmap.naturalHeight || 0);
        if (!srcW || !srcH) throw new Error('无法读取图片尺寸');
        if (srcW * srcH > CatalogAdmin.PREVIEW.maxPixels) {
          throw new Error('图片像素超过 16MP，请先缩小后再上传');
        }
        var longSide = Math.max(srcW, srcH);
        var baseScale = Math.min(1, CatalogAdmin.PREVIEW.maxSide / longSide);
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('当前浏览器不支持图片压缩');
        var qualityList = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
        var scale = baseScale;
        try {
          for (var attempt = 0; attempt < 6; attempt += 1) {
            var width = Math.max(1, Math.round(srcW * scale));
            var height = Math.max(1, Math.round(srcH * scale));
            canvas.width = width;
            canvas.height = height;
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(bitmap, 0, 0, width, height);
            for (var i = 0; i < qualityList.length; i += 1) {
              var blob = await this.canvasToBlob(canvas, qualityList[i]);
              if (blob && blob.size <= CatalogAdmin.PREVIEW.maxOutputBytes) {
                return { blob: blob, width: width, height: height, bytes: blob.size };
              }
            }
            scale *= 0.85;
          }
        } finally {
          if (bitmap && typeof bitmap.close === 'function') bitmap.close();
        }
        throw new Error('图片压缩后仍超过 64 KiB，请换一张更简单的图片');
      },
      onPreviewFileChange: async function (event) {
        var input = event && event.target;
        var file = input && input.files && input.files[0];
        if (input) input.value = '';
        if (!file || this.previewBusy) return;
        var guardError = this.previewGuardError();
        if (guardError) {
          this.previewError = guardError;
          this.saveNotice = guardError;
          return;
        }
        var check = CatalogAdmin.validatePreviewFile(file);
        if (!check.ok) {
          this.previewError = check.error;
          return;
        }
        this.previewBusy = true;
        this.previewError = '';
        this.saveNotice = '';
        try {
          var prepared = await this.compressPreviewImage(file);
          var res = await CatalogAdmin.api('POST', CatalogAdmin.previewUploadPath(this.item.id, this.baseRev), {
            rawBody: prepared.blob,
            contentType: 'image/webp',
            csrf: this.auth.csrfToken
          });
          if (res.status === 401) {
            this.previewBusy = false;
            this.handleUnauthorized();
            return;
          }
          if (res.ok && res.payload) {
            var wasKind = this.kind;
            this.applyItem(res.payload);
            this.kind = wasKind;
            await this.refreshList();
            this.previewBroken = false;
            this.saveNotice = '预览图已更新：已压缩为 WebP ' + prepared.width + '×' + prepared.height +
              ' · ' + CatalogAdmin.formatPreviewBytes(prepared.bytes) + '（未自动发布）';
            this.showToast('预览图已更新');
          } else if (res.status === 409 && res.payload && res.payload.current) {
            this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
            this.previewError = CatalogAdmin.formatApiError(res.payload, res.status);
          } else if (res.status === 413) {
            this.previewError = '图片被服务器拒绝（过大或格式不允许）：' + CatalogAdmin.formatApiError(res.payload, res.status);
          } else {
            this.previewError = CatalogAdmin.formatApiError(res.payload, res.status);
          }
        } catch (err) {
          this.previewError = err && err.message ? err.message : '预览图上传失败';
        } finally {
          this.previewBusy = false;
        }
      },
      removePreview: async function () {
        if (this.previewBusy) return;
        var guardError = this.previewGuardError();
        if (guardError) {
          this.previewError = guardError;
          this.saveNotice = guardError;
          return;
        }
        if (!this.item || !this.item.preview) return;
        this.previewBusy = true;
        this.previewError = '';
        this.saveNotice = '';
        try {
          var res = await CatalogAdmin.api('DELETE', CatalogAdmin.previewUploadPath(this.item.id, this.baseRev), {
            csrf: this.auth.csrfToken
          });
          if (res.status === 401) {
            this.previewBusy = false;
            this.handleUnauthorized();
            return;
          }
          if (res.ok && res.payload) {
            var wasKind = this.kind;
            this.applyItem(res.payload);
            this.kind = wasKind;
            await this.refreshList();
            this.previewBroken = false;
            this.saveNotice = '预览图已移除（未自动发布）';
            this.showToast('预览图已移除');
          } else if (res.status === 409 && res.payload && res.payload.current) {
            this.conflict = { current: res.payload.current, detail: CatalogAdmin.formatApiError(res.payload, res.status) };
            this.previewError = CatalogAdmin.formatApiError(res.payload, res.status);
          } else {
            this.previewError = CatalogAdmin.formatApiError(res.payload, res.status);
          }
        } catch (err) {
          this.previewError = err && err.message ? err.message : '预览图移除失败';
        } finally {
          this.previewBusy = false;
        }
      }
    }
  }).mount('#catalog-admin-app');
})(typeof window !== 'undefined' ? window : null);
