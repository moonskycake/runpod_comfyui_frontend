/**
  * HistoryStore
  * 持久化保存请求历史（localStorage）与图片数据（IndexedDB）
  *
  * 约束：仅保存最近 30 个请求、最多 50 张“本地图片”（不含收藏）、最多 50 张收藏。
  * 注意：不会保存 API Key。
  */

(function () {
  const HISTORY_KEY = 'runpod_request_history_v1';
  const FAVORITES_KEY = 'runpod_favorites_v1';

  const LIMITS = {
    maxRequests: 30,
    // 本地历史最多保留的“非收藏图片”数量
    maxImages: 50,
    // 收藏上限（独立于本地 maxImages）
    maxFavorites: 50
  };

  const DB = {
    name: 'runpod_history_db_v1',
    version: 1,
    imageStore: 'images'
  };

  let dbPromise = null;

  function isIndexedDbAvailable() {
    return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txToPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }

  function openDb() {
    if (!isIndexedDbAvailable()) {
      return Promise.reject(new Error('IndexedDB not available'));
    }

    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB.name, DB.version);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB.imageStore)) {
          const store = db.createObjectStore(DB.imageStore, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });

    return dbPromise;
  }

  function safeJsonParse(text, fallback) {
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch (e) {
      return fallback;
    }
  }

  function normalizeRecordForStorage(record) {
    const images = Array.isArray(record.images)
      ? record.images.map(img => ({
          id: img.id,
          filename: img.filename || 'image.png',
          type: img.type || 'base64'
        }))
      : [];

    return {
      id: record.id,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || Date.now(),
      status: record.status || '',
      runMode: record.runMode || '',
      endpointId: record.endpointId || '',
      jobId: record.jobId || '',
      templateId: record.templateId || '',
      templateName: record.templateName || '',
      workflowJson: record.workflowJson || '',
      placeholderValues: record.placeholderValues || {},
      payloadSize: record.payloadSize || 0,
      delayTime: record.delayTime !== undefined ? record.delayTime : null,
      executionTime: record.executionTime !== undefined ? record.executionTime : null,
      errorMessage: record.errorMessage || '',
      deletedImages: Array.isArray(record.deletedImages) ? record.deletedImages : [],
      images
    };
  }

  function normalizeFavoriteForStorage(fav) {
    if (!fav || !fav.id) return null;
    const addedAt = Number(fav.addedAt || 0) || Date.now();

    return {
      id: String(fav.id),
      addedAt,
      filename: fav.filename || 'image.png',
      type: fav.type || 'base64',
      requestId: fav.requestId || '',
      requestCreatedAt: fav.requestCreatedAt !== undefined ? fav.requestCreatedAt : null,
      requestTemplateId: fav.requestTemplateId || '',
      requestTemplateName: fav.requestTemplateName || '',
      requestJobId: fav.requestJobId || ''
    };
  }

  function pruneFavorites(favorites) {
    const normalized = (Array.isArray(favorites) ? favorites : [])
      .map(normalizeFavoriteForStorage)
      .filter(Boolean);

    // 去重（保留 addedAt 更大的）
    const byId = new Map();
    normalized.forEach(f => {
      const prev = byId.get(f.id);
      if (!prev || (f.addedAt || 0) > (prev.addedAt || 0)) {
        byId.set(f.id, f);
      }
    });

    const unique = Array.from(byId.values());
    unique.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    const kept = unique.slice(0, LIMITS.maxFavorites);
    const keptSet = new Set(kept.map(f => f.id));
    const removedIds = unique.filter(f => !keptSet.has(f.id)).map(f => f.id);

    return {
      favorites: kept,
      removedFavoriteIds: removedIds
    };
  }

  function pruneState(records, favorites) {
    const normalizedRecords = (Array.isArray(records) ? records : []).map(normalizeRecordForStorage);
    const favPruned = pruneFavorites(favorites);
    const prunedFavorites = favPruned.favorites;

    // 保留最近 N 个请求
    const keptRequests = normalizedRecords.slice(0, LIMITS.maxRequests);

    const favoriteIdSet = new Set(prunedFavorites.map(f => f.id));

    // keepSet 代表最终应该保留在 IndexedDB 的所有图片 id（历史 + 收藏）
    const keepSet = new Set();
    prunedFavorites.forEach(f => {
      if (f && f.id) keepSet.add(f.id);
    });

    // 本地历史仅保留最多 M 张“非收藏图片”（按请求顺序 + 图片顺序）
    let keptLocalNonFav = 0;
    for (const r of keptRequests) {
      const imgs = Array.isArray(r.images) ? r.images : [];
      for (const img of imgs) {
        if (keptLocalNonFav >= LIMITS.maxImages) break;
        if (!img || !img.id) continue;
        if (favoriteIdSet.has(img.id)) {
          // 收藏图片不计入本地上限，但需要保留
          keepSet.add(img.id);
          continue;
        }
        if (keepSet.has(img.id)) continue;
        keepSet.add(img.id);
        keptLocalNonFav += 1;
      }
      if (keptLocalNonFav >= LIMITS.maxImages) break;
    }

    const prunedRequests = keptRequests.map(r => ({
      ...r,
      images: (r.images || []).filter(img => img && img.id && keepSet.has(img.id))
    }));

    // 需要从 IndexedDB 删除的 id（历史裁剪掉的 + 超出收藏上限被挤出的）
    const removed = new Set();
    for (const r of normalizedRecords) {
      for (const img of (r.images || [])) {
        if (img && img.id && !keepSet.has(img.id)) removed.add(img.id);
      }
    }
    (favPruned.removedFavoriteIds || []).forEach(id => {
      if (id && !keepSet.has(id)) removed.add(id);
    });

    return {
      records: prunedRequests,
      favorites: prunedFavorites,
      keepImageIds: Array.from(keepSet),
      removedImageIds: Array.from(removed)
    };
  }

  async function getAllImages() {
    const db = await openDb();
    const tx = db.transaction(DB.imageStore, 'readonly');
    const store = tx.objectStore(DB.imageStore);

    const result = await requestToPromise(store.getAll());
    await txToPromise(tx);
    return Array.isArray(result) ? result : [];
  }

  async function putImages(images) {
    if (!isIndexedDbAvailable()) return;
    if (!Array.isArray(images) || images.length === 0) return;

    const db = await openDb();
    const tx = db.transaction(DB.imageStore, 'readwrite');
    const store = tx.objectStore(DB.imageStore);

    const now = Date.now();
    images.forEach(img => {
      if (!img || !img.id) return;
      store.put({
        id: img.id,
        filename: img.filename || 'image.png',
        type: img.type || 'base64',
        data: img.data || '',
        createdAt: img.createdAt || now
      });
    });

    await txToPromise(tx);
  }

  async function deleteImages(ids) {
    if (!isIndexedDbAvailable()) return;
    if (!Array.isArray(ids) || ids.length === 0) return;

    const db = await openDb();
    const tx = db.transaction(DB.imageStore, 'readwrite');
    const store = tx.objectStore(DB.imageStore);

    ids.forEach(id => {
      if (!id) return;
      store.delete(id);
    });

    await txToPromise(tx);
  }

  function loadRecordsFromLocalStorage() {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  function loadFavoritesFromLocalStorage() {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  function saveRecordsToLocalStorage(records) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(records));
  }

  function saveFavoritesToLocalStorage(favorites) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }

  async function load() {
    const rawRecords = loadRecordsFromLocalStorage();
    const rawFavorites = loadFavoritesFromLocalStorage();
    const pruned = pruneState(rawRecords, rawFavorites);

    // 持久化写回
    saveRecordsToLocalStorage(pruned.records);
    saveFavoritesToLocalStorage(pruned.favorites);

    // 清除超过限制的图片
    if (pruned.removedImageIds.length > 0) {
      await deleteImages(pruned.removedImageIds);
    }

    // 读取所有图片并删除未引用的
    let imageMap = {};
    if (isIndexedDbAvailable()) {
      const allImages = await getAllImages();
      const referenced = new Set(pruned.keepImageIds);
      const unref = [];

      allImages.forEach(img => {
        if (!img || !img.id) return;
        if (!referenced.has(img.id)) {
          unref.push(img.id);
          return;
        }
        imageMap[img.id] = img;
      });

      if (unref.length > 0) {
        await deleteImages(unref);
      }
    }

    return {
      records: pruned.records,
      favorites: pruned.favorites,
      imageMap
    };
  }

  async function save(stateOrRecords, maybeFavorites) {
    let records = stateOrRecords;
    let favorites = maybeFavorites;
    if (stateOrRecords && typeof stateOrRecords === 'object' && !Array.isArray(stateOrRecords)) {
      records = stateOrRecords.records;
      favorites = stateOrRecords.favorites;
    }

    const pruned = pruneState(records, favorites);
    saveRecordsToLocalStorage(pruned.records);
    saveFavoritesToLocalStorage(pruned.favorites);

    if (pruned.removedImageIds.length > 0) {
      await deleteImages(pruned.removedImageIds);
    }

    return pruned;
  }

  async function clearAll() {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(FAVORITES_KEY);
    if (!isIndexedDbAvailable()) return;

    const db = await openDb();
    const tx = db.transaction(DB.imageStore, 'readwrite');
    tx.objectStore(DB.imageStore).clear();
    await txToPromise(tx);
  }

  const HistoryStore = {
    HISTORY_KEY,
    FAVORITES_KEY,
    LIMITS,
    init: openDb,
    load,
    save,
    putImages,
    deleteImages,
    clearAll,
    isIndexedDbAvailable
  };

  window.HistoryStore = HistoryStore;
})();
