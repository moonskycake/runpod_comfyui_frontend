'use strict';

/**
 * 最小假 IndexedDB（仅供 tests/*.test.js 使用，不是浏览器事务实现）
 *
 * 只实现 HistoryStore（js/history-store.js）真正用到的语义：
 *   indexedDB.open / onupgradeneeded / req.result / req.onsuccess / req.onerror
 *   db.objectStoreNames.contains / db.createObjectStore(+createIndex)
 *   db.transaction(storeNames, mode) / tx.objectStore(name)
 *   objectStore.put / getAll / delete / clear（各自返回带 onsuccess 的 request）
 *   tx.oncomplete / tx.onabort / tx.onerror
 *
 * 事件时序：
 *   - request 的 onsuccess/onerror 一律异步派发（setTimeout 0），调用方可以先注册再收到；
 *     绝不在 store.put() / db.transaction() 的同步栈里回调。
 *   - tx.oncomplete 在 request 事件之后的又一个事件循环里派发，因此
 *     `await requestToPromise(store.getAll())` 和 `await txToPromise(tx)` 都能拿到事件。
 *   - 用 hold(predicate) 可以把匹配事务的“提交”挂起，模拟慢写入/慢读出；
 *     release() 之后才派发 oncomplete。
 *
 * 边界（不要当成真实浏览器证据）：
 *   - 写入在 put/delete 调用时就立即反映到内存表，没有“提交后才可见”的隔离，
 *     也没有回滚：它只能证明本项目的 await/事件顺序，不能证明事务原子性或并发调度。
 *   - 不实现版本冲突（VersionError）、key 范围/游标、索引查询、跨 store 事务、
 *     structured clone 语义（只做浅拷贝）、Blocked/versionchange 事件。
 */

function createFakeIndexedDB(options) {
  const opts = options || {};
  const log = { opens: 0, transactions: [], puts: 0, gets: 0, deletes: 0, clears: 0 };
  const holds = [];
  const databases = new Map();

  const later = fn => setTimeout(fn, 0);
  const shallowCopy = value => (value && typeof value === 'object' ? { ...value } : value);

  function findStore(storeName) {
    for (const db of databases.values()) {
      if (db.stores.has(storeName)) return db.stores.get(storeName);
    }
    return null;
  }

  function getStore(db, storeName) {
    const store = db.stores.get(storeName);
    if (!store) throw new Error(`fake-indexeddb: 未创建的对象仓库 ${storeName}`);
    return store;
  }

  function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }

  function succeed(request, result) {
    request.result = result;
    later(() => {
      if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
    });
  }

  function fail(request, error) {
    request.error = error;
    later(() => {
      if (typeof request.onerror === 'function') request.onerror({ target: request });
    });
  }

  function completeTransaction(info, tx) {
    later(() => {
      if (info.aborted) return;
      info.completed = true;
      if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
    });
  }

  function scheduleCompletion(info, tx) {
    // 先等一个事件循环，让事务里已经发出的 request 事件派发完（真实 IDB 也是如此），
    // 再判断是否被 hold 住；被 hold 时等 release() 后才派发 oncomplete。
    later(() => {
      const hold = holds.find(h => !h.controller.released
        && h.controller.matched < h.controller.limit
        && h.predicate(info));
      if (!hold) {
        completeTransaction(info, tx);
        return;
      }
      hold.controller.matched++;
      hold.gate.then(() => completeTransaction(info, tx));
    });
  }

  function createTransaction(db, storeNames, mode) {
    const names = Array.isArray(storeNames) ? storeNames.slice() : [storeNames];
    names.forEach(name => getStore(db, name));

    const info = { mode, storeNames: names, ops: [], completed: false, aborted: false };
    log.transactions.push(info);

    const tx = {
      mode,
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStoreNames: { contains: name => names.includes(name) },
      objectStore(name) {
        const store = getStore(db, name);
        return {
          put(value) {
            const request = makeRequest();
            const key = value ? value[store.keyPath] : undefined;
            info.ops.push({ type: 'put', key });
            log.puts++;
            if (key === undefined) {
              fail(request, new Error(`fake-indexeddb: put 缺少 keyPath ${store.keyPath}`));
              return request;
            }
            store.data.set(key, shallowCopy(value));
            succeed(request, key);
            return request;
          },
          getAll() {
            const request = makeRequest();
            info.ops.push({ type: 'getAll' });
            log.gets++;
            succeed(request, Array.from(store.data.values(), shallowCopy));
            return request;
          },
          delete(key) {
            const request = makeRequest();
            info.ops.push({ type: 'delete', key });
            log.deletes++;
            store.data.delete(key);
            succeed(request, undefined);
            return request;
          },
          clear() {
            const request = makeRequest();
            info.ops.push({ type: 'clear' });
            log.clears++;
            store.data.clear();
            succeed(request, undefined);
            return request;
          }
        };
      }
    };

    scheduleCompletion(info, tx);
    return tx;
  }

  function createDbHandle(db) {
    return {
      name: db.name,
      version: db.version,
      objectStoreNames: { contains: name => db.stores.has(name) },
      createObjectStore(name, storeOptions) {
        const storeOpts = storeOptions || {};
        const store = { keyPath: storeOpts.keyPath || 'id', indexes: new Map(), data: new Map() };
        db.stores.set(name, store);
        return {
          keyPath: store.keyPath,
          createIndex(indexName, keyPath, indexOptions) {
            store.indexes.set(indexName, { keyPath, ...(indexOptions || {}) });
            return { indexName, keyPath };
          }
        };
      },
      transaction(storeNames, mode) {
        return createTransaction(db, storeNames, mode || 'readonly');
      }
    };
  }

  const api = {
    open(name, version) {
      const request = makeRequest();
      log.opens++;
      later(() => {
        let db = databases.get(name);
        if (!db) {
          db = { name, version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const targetVersion = Number(version) || 1;
        const needsUpgrade = db.version < targetVersion;
        const handle = createDbHandle(db);
        request.result = handle;

        if (needsUpgrade) {
          db.version = targetVersion;
          handle.version = targetVersion;
          if (typeof request.onupgradeneeded === 'function') {
            request.onupgradeneeded({ target: request, oldVersion: 0, newVersion: targetVersion });
          }
        }

        later(() => {
          if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
        });
      });
      return request;
    }
  };

  /**
   * 挂起匹配事务的提交。predicate 收到 { mode, storeNames, ops }。
   * @param {Function} predicate
   * @param {{limit?: number}} [holdOptions] limit 默认 1：只挂起第一个匹配事务
   */
  api.hold = function hold(predicate, holdOptions) {
    const holdOpts = holdOptions || {};
    let resolveGate = null;
    const gate = new Promise(resolve => { resolveGate = resolve; });
    const controller = {
      matched: 0,
      released: false,
      limit: holdOpts.limit === undefined ? 1 : holdOpts.limit,
      release() {
        if (controller.released) return;
        controller.released = true;
        resolveGate();
      }
    };
    holds.push({ predicate: predicate || (() => true), controller, gate });
    return controller;
  };

  /** 某个对象仓库里的全部 key（排序后），用于断言真实写入/清理结果 */
  api.ids = function ids(storeName) {
    const store = findStore(storeName);
    if (!store) return [];
    return Array.from(store.data.keys()).sort();
  };

  api.dump = function dump(storeName) {
    const store = findStore(storeName);
    if (!store) return [];
    return Array.from(store.data.entries()).map(([key, value]) => ({ key, value: shallowCopy(value) }));
  };

  api.has = function has(storeName, id) {
    const store = findStore(storeName);
    return !!(store && store.data.has(id));
  };

  api.log = log;
  api.imageStoreName = opts.imageStoreName || 'images';

  return api;
}

module.exports = { createFakeIndexedDB };
