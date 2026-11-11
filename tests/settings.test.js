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
console.log('3 settings checks passed');
