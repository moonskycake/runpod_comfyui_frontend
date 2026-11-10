/**
 * Catalog Client
 * 统一库（/api/catalog）公开只读客户端 + 本地/统一来源判定 + 离线缓存。
 *
 * 约束：
 * - 统一库内容只读，不自动写入 localStorage 的“本地资源”集合。
 * - 本地副本保存 sourceId/sourceRevision，内容独立，后台更新不跟随。
 * - 不在此模块处理管理员写接口（由 admin 页面负责）。
 */
'use strict';

const CatalogClient = (() => {
  const KINDS = ['template', 'preset', 'snippet'];
  const CACHE_KEY = 'runpod_catalog_cache_v1';
  const ALIAS_KEY = 'runpod_catalog_builtin_alias_v1';
  const DRAFT_KEY = 'runpod_template_drafts_v1';
  const DETAIL_CACHE_KEY = 'runpod_catalog_detail_cache_v1';
  const DETAIL_CACHE_MAX_ITEMS = 20;
  const DETAIL_CACHE_MAX_BYTES = 2 * 1024 * 1024;

  // 预览图契约：站内接口路径、WebP、长边 <= 480px、<= 64KiB。
  const PREVIEW_MIME = 'image/webp';
  const PREVIEW_MAX_SIDE = 480;
  const PREVIEW_MAX_BYTES = 64 * 1024;
  const PREVIEW_PUBLIC_RE = /^\/api\/catalog\/[^/?#]+\/preview(?:\?[^#]*)?$/;
  const PREVIEW_ADMIN_RE = /^\/api\/admin\/items\/[^/?#]+\/preview(?:\?[^#]*)?$/;

  function previewUrlPublic(id, revision) {
    const itemId = String(id || '');
    if (!itemId) return '';
    const rev = Number(revision);
    if (!Number.isInteger(rev) || rev < 0) return '';
    return `/api/catalog/${encodeURIComponent(itemId)}/preview?revision=${rev}`;
  }

  function previewUrlAdmin(id, draftRev) {
    const itemId = String(id || '');
    if (!itemId) return '';
    const rev = Number(draftRev);
    if (!Number.isInteger(rev) || rev < 0) return '';
    return `/api/admin/items/${encodeURIComponent(itemId)}/preview?rev=${rev}`;
  }

  /**
   * 只接受本站（同源相对路径）的预览接口 URL，拒绝外站/协议/javascript/data。
   * 要求带明确 revision/rev 参数，避免“草稿图冒充发布图”。
   * @param {string} url
   * @returns {boolean}
   */
  function isSafePreviewUrl(url) {
    if (typeof url !== 'string') return false;
    const value = url.trim();
    if (!value || value.length > 2048) return false;
    if (value.charAt(0) !== '/') return false;
    if (value.startsWith('//')) return false;
    if (/[\\\u0000-\u001f\s]/.test(value)) return false;
    if (value.indexOf('..') >= 0) return false;
    const isPublic = PREVIEW_PUBLIC_RE.test(value);
    const isAdmin = PREVIEW_ADMIN_RE.test(value);
    if (!isPublic && !isAdmin) return false;
    const query = value.split('?')[1] || '';
    const matcher = isPublic ? /(?:^|&)revision=(\d+)(?:&|$)/ : /(?:^|&)rev=(\d+)(?:&|$)/;
    const match = matcher.exec(query);
    return !!match;
  }

  /**
   * 规范化 preview 响应字段：非法结构/非 WebP/超限/外链一律按无图处理。
   * @param {object|null|undefined} raw
   * @returns {{url:string,width:number,height:number,bytes:number,mime:string}|null}
   */
  function normalizePreview(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!isSafePreviewUrl(url)) return null;
    const mime = String(raw.mime || '').trim().toLowerCase();
    if (mime !== PREVIEW_MIME) return null;
    const width = Number(raw.width);
    const height = Number(raw.height);
    const bytes = Number(raw.bytes);
    if (!Number.isInteger(width) || width <= 0 || width > PREVIEW_MAX_SIDE) return null;
    if (!Number.isInteger(height) || height <= 0 || height > PREVIEW_MAX_SIDE) return null;
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > PREVIEW_MAX_BYTES) return null;
    return { url, width, height, bytes, mime: PREVIEW_MIME };
  }

  /**
   * 复制到本地时把预览图钉在来源版本：使用公开 revision 路径，后台换图不影响本地副本。
   */
  function pinPreview(preview, id, revision) {
    const safe = normalizePreview(preview);
    if (!safe) return null;
    const rev = Number(revision);
    const url = previewUrlPublic(id, rev);
    if (!url) return safe;
    return { url, width: safe.width, height: safe.height, bytes: safe.bytes, mime: safe.mime };
  }

  function isSharedId(id) {
    return typeof id === 'string' && id.startsWith('shared:');
  }

  function isLocalId(id) {
    return typeof id === 'string' && id.startsWith('local:');
  }

  /**
   * 来源判定：优先 source 字段，其次 ID 前缀。旧 user_* 视为本地。
   * @param {{id?:string,source?:string}} item
   * @returns {'shared'|'local'}
   */
  function sourceOf(item) {
    if (!item || typeof item !== 'object') return 'local';
    if (item.source === 'shared') return 'shared';
    if (item.source === 'local') return 'local';
    if (isSharedId(item.id)) return 'shared';
    return 'local';
  }

  /**
   * 只有本地项可编辑/删除：统一库与内置模板一律拒绝。
   * @param {object} item
   */
  function canMutateLocal(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.isBuiltin) return false;
    if (sourceOf(item) === 'shared') return false;
    return true;
  }

  function uuid() {
    const cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function newLocalId(prefix) {
    const p = prefix ? String(prefix) : 'item';
    return `local:${p}-${uuid()}`;
  }

  /**
   * 生成统一的本地副本命名：名称（本地副本），冲突时自动编号。
   * @param {string} name
   * @param {string[]} existingNames
   */
  function uniqueCopyName(name, existingNames) {
    const baseName = String(name || '未命名').trim() || '未命名';
    const used = new Set((existingNames || []).map(n => String(n || '').trim()));
    const first = `${baseName}（本地副本）`;
    if (!used.has(first)) return first;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${baseName}（本地副本 ${i}）`;
      if (!used.has(candidate)) return candidate;
    }
    return `${baseName}（本地副本 ${Date.now()}）`;
  }

  /**
   * 统一库项 -> 本地副本（模板/预设/片段通用）。
   * @param {object} item 元数据（含 id/publishedRevision/...）
   * @param {object} data 详情 payload
   * @param {object} [extra] 附加字段（name 冲突处理后的名称等）
   */
  function buildLocalCopy(item, data, extra) {
    if (!item || typeof item !== 'object') throw new Error('无效的统一库项');
    const source = sourceOf(item);
    if (source !== 'shared') throw new Error('只能从统一库复制到本地');
    const payload = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {};
    const meta = extra && typeof extra === 'object' ? extra : {};
    const sourceRevision = Number.isFinite(Number(item.publishedRevision))
      ? Number(item.publishedRevision)
      : null;
    const previewSource = (data && data.preview) || item.preview;
    return {
      id: newLocalId(item.kind || 'item'),
      kind: item.kind,
      name: String(meta.name || item.name || '未命名'),
      description: String(item.description || ''),
      category: String(item.category || ''),
      data: payload,
      source: 'local',
      sourceId: item.id,
      sourceRevision,
      preview: pinPreview(previewSource, item.id, sourceRevision),
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function normalizeMetadata(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('资源元数据无效');
    const kind = String(raw.kind || '');
    if (!KINDS.includes(kind)) throw new Error('资源类型无效');
    const id = String(raw.id || '');
    if (!id) throw new Error('资源 ID 缺失');
    const orderValue = Number(raw.order);
    const revValue = Number(raw.publishedRevision);
    return {
      id,
      kind,
      name: String(raw.name || '未命名'),
      description: String(raw.description || ''),
      category: String(raw.category || ''),
      order: Number.isFinite(orderValue) ? Math.trunc(orderValue) : 0,
      publishedRevision: raw.publishedRevision === null || raw.publishedRevision === undefined
        ? null
        : (Number.isFinite(revValue) ? Math.trunc(revValue) : null),
      updatedAt: String(raw.updatedAt || ''),
      preview: normalizePreview(raw.preview),
      legacyId: raw.legacyId === undefined || raw.legacyId === null ? undefined : String(raw.legacyId)
    };
  }

  function normalizeCatalogPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('目录响应无效');
    const version = Number(payload.catalogVersion);
    if (!Number.isFinite(version) || version < 0) throw new Error('目录版本无效');
    const items = Array.isArray(payload.items) ? payload.items.map(normalizeMetadata) : [];
    return { catalogVersion: Math.trunc(version), items };
  }

  function normalizeDetailPayload(payload) {
    const meta = normalizeMetadata(payload);
    if (!payload.data || typeof payload.data !== 'object') throw new Error('资源详情无效');
    return { ...meta, data: payload.data };
  }

  function buildCachePayload(catalog, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return {
      savedAt: ts,
      catalogVersion: Number(catalog && catalog.catalogVersion) || 0,
      items: Array.isArray(catalog && catalog.items) ? catalog.items : []
    };
  }

  /**
   * 读取离线缓存；任何损坏/不可用都按无缓存处理，不影响本地资源。
   * @param {Storage|null} storage
   */
  function loadCache(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    let raw = null;
    try {
      raw = storage.getItem(CACHE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items)) return null;
      const version = Number(parsed.catalogVersion);
      const savedAt = Number(parsed.savedAt);
      return {
        catalogVersion: Number.isFinite(version) ? Math.trunc(version) : 0,
        items: parsed.items.map(normalizeMetadata),
        savedAt: Number.isFinite(savedAt) ? savedAt : null
      };
    } catch (e) {
      return null;
    }
  }

  function saveCache(storage, catalog, now) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(CACHE_KEY, JSON.stringify(buildCachePayload(catalog, now)));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 旧 builtin id -> shared id 映射。成功响应才更新，失败/离线不清空映射，
   * 以免已停用的统一库项被内置模板“复活”。
   */
  function loadAliasMap(storage) {
    if (!storage || typeof storage.getItem !== 'function') return {};
    try {
      const raw = storage.getItem(ALIAS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function updateAliasMap(aliasMap, catalogItems) {
    const next = { ...(aliasMap || {}) };
    (catalogItems || []).forEach(item => {
      const legacyId = item && item.legacyId ? String(item.legacyId) : '';
      if (!legacyId) return;
      if (item.kind !== 'template') return;
      next[legacyId] = String(item.id);
    });
    return next;
  }

  function saveAliasMap(storage, aliasMap) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(ALIAS_KEY, JSON.stringify(aliasMap || {}));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 在线成功时：有 legacyId 映射的内置模板被统一库版本替代（即使该 shared 项已停用、
   * 从目录中消失，也不会复活内置模板）。离线时才回退到内置模板。
   */
  function visibleBuiltinTemplates(builtins, aliasMap, isOnline, catalogItems) {
    const list = Array.isArray(builtins) ? builtins : [];
    // 在线成功时完全以服务器目录为准，不补任何内置模板。
    if (isOnline) return [];
    const map = aliasMap && typeof aliasMap === 'object' ? aliasMap : {};
    const cachedSharedIds = new Set();
    (Array.isArray(catalogItems) ? catalogItems : []).forEach(item => {
      if (item && item.kind === 'template' && item.legacyId) cachedSharedIds.add(String(item.legacyId));
    });
    return list.filter(t => {
      if (!t || !t.id) return true;
      if (Object.prototype.hasOwnProperty.call(map, t.id)) return false;
      return !cachedSharedIds.has(String(t.id));
    });
  }

  function formatCacheAge(savedAt, now) {
    const ts = Number(savedAt);
    if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const diff = Math.max(0, current - ts);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  async function requestJson(url, fetchImpl, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const headers = {
      Accept: 'application/json',
      ...(opts.headers || {})
    };
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-cache',
      headers,
      signal: opts.signal
    });
    if (response && response.status === 304) {
      return { notModified: true, etag: response.headers && response.headers.get ? response.headers.get('ETag') : '' };
    }
    if (!response || !response.ok) {
      const status = response && response.status ? response.status : 0;
      throw new Error(`目录请求失败（HTTP ${status}）`);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      throw new Error('目录响应不是有效 JSON');
    }
    const etag = response.headers && response.headers.get ? (response.headers.get('ETag') || '') : '';
    return { notModified: false, payload, etag };
  }

  async function fetchCatalog(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const fetchImpl = typeof opts.fetchImpl === 'function'
      ? opts.fetchImpl
      : (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('当前环境不支持 fetch');
    const baseUrl = String(opts.baseUrl || '');
    const url = `${baseUrl}/api/catalog`;
    const headers = {};
    if (opts.etag) headers['If-None-Match'] = String(opts.etag);
    const result = await requestJson(url, fetchImpl, { headers, signal: opts.signal });
    if (result.notModified) return { notModified: true, catalog: null, etag: result.etag };
    return {
      notModified: false,
      catalog: normalizeCatalogPayload(result.payload),
      etag: result.etag
    };
  }

  async function fetchCatalogDetail(id, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const fetchImpl = typeof opts.fetchImpl === 'function'
      ? opts.fetchImpl
      : (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('当前环境不支持 fetch');
    const itemId = String(id || '');
    if (!itemId) throw new Error('缺少资源 ID');
    const baseUrl = String(opts.baseUrl || '');
    const url = `${baseUrl}/api/catalog/${encodeURIComponent(itemId)}`;
    const result = await requestJson(url, fetchImpl, { signal: opts.signal });
    if (result.notModified) throw new Error('资源详情不应返回 304');
    return normalizeDetailPayload(result.payload);
  }

  /**
   * 模板草稿：按模板 key 独立保存；值为纯 JSON，避免 Vue 代理写入。
   */
  function saveDraftSnapshot(drafts, key, values) {
    const map = drafts && typeof drafts === 'object' ? { ...drafts } : {};
    const k = String(key || '__custom__');
    if (!values || typeof values !== 'object') return map;
    map[k] = JSON.parse(JSON.stringify(values));
    return map;
  }

  function pickDraftSnapshot(drafts, key, allowedKeys) {
    if (!drafts || typeof drafts !== 'object') return null;
    const snapshot = drafts[String(key || '__custom__')];
    if (!snapshot || typeof snapshot !== 'object') return null;
    if (!Array.isArray(allowedKeys)) return { ...snapshot };
    const out = {};
    allowedKeys.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(snapshot, k)) out[k] = snapshot[k];
    });
    return out;
  }

  function loadDraftMap(storage) {
    if (!storage || typeof storage.getItem !== 'function') return {};
    try {
      const raw = storage.getItem(DRAFT_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveDraftMap(storage, drafts) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(DRAFT_KEY, JSON.stringify(drafts || {}));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 已使用公开详情的受限持久化缓存：精确 id + publishedRevision，最多 20 条/2MiB。
   * 任何存储异常都按未缓存处理，不影响本地资源。
   */
  function detailCacheKey(id, revision) {
    return `${String(id || '')}@${revision === null || revision === undefined ? '' : String(revision)}`;
  }

  function loadDetailCache(storage) {
    if (!storage || typeof storage.getItem !== 'function') return { entries: {} };
    try {
      const raw = storage.getItem(DETAIL_CACHE_KEY);
      if (!raw) return { entries: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
        return { entries: {} };
      }
      return { entries: { ...parsed.entries } };
    } catch (e) {
      return { entries: {} };
    }
  }

  function pruneDetailCache(entries) {
    const list = Object.keys(entries || {})
      .map(key => ({ key, savedAt: Number(entries[key] && entries[key].savedAt) || 0 }))
      .sort((a, b) => b.savedAt - a.savedAt);
    const kept = {};
    list.slice(0, DETAIL_CACHE_MAX_ITEMS).forEach(item => {
      kept[item.key] = entries[item.key];
    });
    // 超限时从最旧开始丢弃，直到序列化大小不超过限制
    const keys = Object.keys(kept).sort((a, b) => (Number(kept[a].savedAt) || 0) - (Number(kept[b].savedAt) || 0));
    while (keys.length > 0) {
      try {
        if (JSON.stringify({ entries: kept }).length <= DETAIL_CACHE_MAX_BYTES) break;
      } catch (e) {
        return {};
      }
      const oldest = keys.shift();
      delete kept[oldest];
    }
    return kept;
  }

  function saveDetailCache(storage, detail) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    if (!detail || !detail.id) return false;
    const revision = detail.publishedRevision === null || detail.publishedRevision === undefined
      ? null
      : Number(detail.publishedRevision);
    if (revision !== null && !Number.isFinite(revision)) return false;
    const key = detailCacheKey(detail.id, revision);
    try {
      const cache = loadDetailCache(storage);
      cache.entries[key] = {
        savedAt: Date.now(),
        detail: JSON.parse(JSON.stringify(detail))
      };
      const entries = pruneDetailCache(cache.entries);
      storage.setItem(DETAIL_CACHE_KEY, JSON.stringify({ entries }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function getCachedDetail(storage, id, publishedRevision) {
    const revision = publishedRevision === null || publishedRevision === undefined
      ? null
      : Number(publishedRevision);
    if (revision === null || !Number.isFinite(revision)) return null;
    const cache = loadDetailCache(storage);
    const entry = cache.entries[detailCacheKey(id, revision)];
    if (!entry || !entry.detail || typeof entry.detail !== 'object') return null;
    try {
      return JSON.parse(JSON.stringify(entry.detail));
    } catch (e) {
      return null;
    }
  }

  /**
   * 本地预设/片段导出为 JSON（迁移用），统一包装格式。
   */
  function buildLocalExport(kind, items) {
    return {
      schemaVersion: 1,
      kind: String(kind || ''),
      exportedAt: new Date().toISOString(),
      items: Array.isArray(items) ? items.map(item => ({
        name: String(item && item.name || '未命名'),
        prompt: item && item.prompt !== undefined ? String(item.prompt) : undefined,
        negative_prompt: item && item.negative_prompt !== undefined ? String(item.negative_prompt) : undefined,
        text: item && item.text !== undefined ? String(item.text) : undefined,
        target: item && item.target === 'negative' ? 'negative' : (kind === 'snippet' ? 'positive' : undefined),
        description: item && item.description !== undefined ? String(item.description) : undefined,
        workflow: item && item.workflow ? JSON.parse(JSON.stringify(item.workflow)) : undefined,
        defaults: item && item.defaults ? JSON.parse(JSON.stringify(item.defaults)) : undefined,
        editor: item && item.editor ? JSON.parse(JSON.stringify(item.editor)) : undefined,
        preview: item && item.preview ? (normalizePreview(item.preview) || undefined) : undefined
      })) : []
    };
  }

  /**
   * 解析导入 JSON；支持统一包装或裸数组。返回经过类型过滤的条目。
   */
  function parseLocalImport(kind, jsonText) {
    let parsed = null;
    try {
      parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    } catch (e) {
      throw new Error('导入内容不是有效 JSON');
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
    if (!list) throw new Error('导入内容缺少 items 数组');
    const k = String(kind || '');
    return list
      .filter(item => item && typeof item === 'object')
      .filter(item => {
        if (k === 'preset') return item.prompt !== undefined || item.negative_prompt !== undefined;
        if (k === 'template') return item.workflow !== undefined;
        return item.text !== undefined;
      })
      .map(item => ({
        name: String(item.name || '导入的资源'),
        prompt: item.prompt !== undefined ? String(item.prompt) : '',
        negative_prompt: item.negative_prompt !== undefined ? String(item.negative_prompt) : '',
        text: item.text !== undefined ? String(item.text) : '',
        target: item.target === 'negative' ? 'negative' : 'positive',
        description: item.description !== undefined ? String(item.description) : '',
        workflow: item.workflow && typeof item.workflow === 'object' ? JSON.parse(JSON.stringify(item.workflow)) : null,
        defaults: item.defaults && typeof item.defaults === 'object' ? JSON.parse(JSON.stringify(item.defaults)) : {},
        editor: item.editor && typeof item.editor === 'object' ? JSON.parse(JSON.stringify(item.editor)) : {},
        preview: normalizePreview(item.preview)
      }));
  }

  return {
    KINDS,
    CACHE_KEY,
    ALIAS_KEY,
    DRAFT_KEY,
    DETAIL_CACHE_KEY,
    PREVIEW_MIME,
    PREVIEW_MAX_SIDE,
    PREVIEW_MAX_BYTES,
    previewUrlPublic,
    previewUrlAdmin,
    isSafePreviewUrl,
    normalizePreview,
    pinPreview,
    isSharedId,
    isLocalId,
    sourceOf,
    canMutateLocal,
    newLocalId,
    uniqueCopyName,
    buildLocalCopy,
    normalizeMetadata,
    normalizeCatalogPayload,
    normalizeDetailPayload,
    buildCachePayload,
    loadCache,
    saveCache,
    loadAliasMap,
    updateAliasMap,
    saveAliasMap,
    visibleBuiltinTemplates,
    formatCacheAge,
    fetchCatalog,
    fetchCatalogDetail,
    saveDraftSnapshot,
    pickDraftSnapshot,
    loadDraftMap,
    saveDraftMap,
    saveDetailCache,
    getCachedDetail,
    loadDetailCache,
    buildLocalExport,
    parseLocalImport
  };
})();

if (typeof window !== 'undefined') {
  window.CatalogClient = CatalogClient;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CatalogClient;
}
