'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function createSettings(storage) {
  const sandbox = {
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    window: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8'), sandbox);
  return sandbox.window.Settings;
}

const storage = new Map();
const settings = createSettings(storage);
assert.strictEqual(settings.get().autoSpaceAfterAutocomplete, true, '默认开启候选空格');
settings.save({ ...settings.get(), autoSpaceAfterAutocomplete: false });
assert.strictEqual(storage.get('runpod_auto_space_after_autocomplete'), 'false');
assert.strictEqual(settings.load().autoSpaceAfterAutocomplete, false, '关闭设置能持久化');
storage.delete('runpod_auto_space_after_autocomplete');
assert.strictEqual(createSettings(storage).get().autoSpaceAfterAutocomplete, true, '旧配置默认开启');

// ===== 单次状态查询超时（毫秒存储，面板以秒编辑）=====
const statusStorage = new Map();
const statusSettings = createSettings(statusStorage);
assert.strictEqual(statusSettings.get().statusTimeoutMs, 20000, '默认 20 秒');
assert.strictEqual(statusSettings.createDefaultConfig().statusTimeoutMs, 20000, '默认值同源');

statusSettings.save({ ...statusSettings.get(), statusTimeoutMs: 45000 });
assert.strictEqual(statusStorage.get('runpod_status_timeout_ms'), '45000');
assert.strictEqual(createSettings(statusStorage).get().statusTimeoutMs, 45000, '保存后重新加载仍是新值');

statusSettings.save({ ...statusSettings.get(), statusTimeoutMs: 1 });
assert.strictEqual(statusSettings.get().statusTimeoutMs, 5000, '保存时下限钳制到 5 秒');
statusSettings.save({ ...statusSettings.get(), statusTimeoutMs: 999999 });
assert.strictEqual(statusSettings.get().statusTimeoutMs, 120000, '保存时上限钳制到 120 秒');

statusStorage.set('runpod_status_timeout_ms', '1000');
assert.strictEqual(createSettings(statusStorage).get().statusTimeoutMs, 5000, '加载时低于 5 秒钳制');
statusStorage.set('runpod_status_timeout_ms', '999999');
assert.strictEqual(createSettings(statusStorage).get().statusTimeoutMs, 120000, '加载时高于 120 秒钳制');
for (const invalid of ['abc', '', '   ', 'NaN']) {
  statusStorage.set('runpod_status_timeout_ms', invalid);
  assert.strictEqual(createSettings(statusStorage).get().statusTimeoutMs, 20000, `无效值 ${JSON.stringify(invalid)} 回退默认`);
}
statusStorage.delete('runpod_status_timeout_ms');
assert.strictEqual(createSettings(statusStorage).get().statusTimeoutMs, 20000, '未设置时回退默认');

console.log('17 settings checks passed');
