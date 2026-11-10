/**
 * 提示词自动补全回归测试（无依赖，直接 node 运行）
 *
 * 运行：node tests/autocomplete.test.js
 *
 * 说明：
 * - 直接加载线上源码 js/tag-index.js 与 js/main.js 中的 PromptTextareaComponent
 *   （切片后放入 vm，不复制/重写业务逻辑）
 * - 只桩化浏览器边界：fetch、document.execCommand、textarea DOM 与 Vue 的 $refs/$emit/$nextTick
 * - 词库用小 fixture（内容取自 tags/danbooru.csv 的真实行格式），不读大词库
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MAIN_JS_PATH = path.join(ROOT, 'js', 'main.js');
const TAG_INDEX_PATH = path.join(ROOT, 'js', 'tag-index.js');

const mainJs = fs.readFileSync(MAIN_JS_PATH, 'utf8');
const tagIndexJs = fs.readFileSync(TAG_INDEX_PATH, 'utf8');

// 抽出原始 PromptTextareaComponent 源码（含其依赖的 isCjkText）
const sliceStart = mainJs.indexOf('function isCjkText');
const appStart = mainJs.indexOf('\nconst app = Vue.createApp');
if (sliceStart < 0 || appStart < 0) {
  console.error('无法从 js/main.js 抽取 PromptTextareaComponent 源码');
  process.exit(1);
}
const componentSource = mainJs.slice(sliceStart, appStart);

// 真实 danbooru.csv 行（category=1 为画师）
const CSV_FIXTURE = [
  '1girl,0,7482757,"sole_female,1girls"',
  'long_hair,0,5000000,"longhair"',
  'sakura,0,100000,',
  '8k,0,7000,',
  'highres,5,7039746,"high_resolution,highres"',
  'sakimichan,1,1018,sakimenz',
  'wlop,1,393,wang_ling',
  'dairi,1,18643,',
  'hammer_(sunset_beach),1,5567,aenobas',
  'no_humans,0,900000,nohumans',
  'no_man,1,700,',
].join('\n');

// 中文词库 fixture（格式 tag,中文）
const ZH_FIXTURE = [
  'long_hair,长发',
  'sakura,樱花',
  'wlop,韩国画师',
  'sakimichan,坂道美香',
].join('\n');

function buildEnv(options) {
  const opts = options || {};
  const execMode = opts.execCommand || 'fallback';
  const sandbox = {
    console,
    Map,
    Set,
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    RegExp,
    parseInt,
    setTimeout,
    __el: null
  };

  sandbox.fetch = async (url) => {
    const target = String(url);
    if (target.indexOf('manifest.json') !== -1) {
      return { ok: true, json: async () => ({ version: 'test', zhVersion: 'test' }) };
    }
    if (target.indexOf('zhcn.csv') !== -1) {
      return { ok: true, text: async () => ZH_FIXTURE };
    }
    return { ok: true, text: async () => CSV_FIXTURE };
  };

  sandbox.document = {
    // 模拟浏览器 execCommand('insertText')：成功分支真正改值并前移光标
    execCommand: (cmd, ui, text) => {
      if (execMode !== 'success') return false;
      const el = sandbox.__el;
      if (!el) return false;
      el.value = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd);
      el.selectionStart = el.selectionEnd = el.selectionStart + text.length;
      return true;
    }
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(componentSource + '\n;globalThis.__COMP = PromptTextareaComponent;', sandbox, {
    filename: 'main.component.slice.js'
  });
  vm.runInContext(tagIndexJs, sandbox, { filename: 'tag-index.js' });
  return sandbox;
}

// 模拟 Vue 组件实例：data + methods（this 指向实例）+ props/refs 桩
function makeInstance(env, insertOptions) {
  const comp = env.__COMP;
  const el = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus() {},
    setSelectionRange(s, e) {
      this.selectionStart = s;
      this.selectionEnd = e;
    }
  };
  env.__el = el;

  const inst = Object.assign({}, comp.data());
  Object.keys(comp.methods).forEach((name) => {
    inst[name] = comp.methods[name].bind(inst);
  });
  inst.insertOptions = Object.assign(
    { keepUnderscore: true, escapeParentheses: true, keepAtPrefix: false },
    insertOptions || {}
  );
  inst.$refs = { ta: el };
  inst.emitted = [];
  inst.$emit = (name, payload) => {
    inst.emitted.push([name, payload]);
  };
  inst.$nextTick = (fn) => {
    if (typeof fn === 'function') fn();
  };
  inst.modelValue = '';
  inst.el = el;
  return inst;
}

async function typeValue(inst, value, caret) {
  inst.el.value = value;
  const pos = typeof caret === 'number' ? caret : value.length;
  inst.el.selectionStart = pos;
  inst.el.selectionEnd = pos;
  inst.modelValue = value;
  await inst.updateMenu();
  return inst.lastToken;
}

// ---------- 断言 ----------
let pass = 0;
let fail = 0;
const failures = [];

function checkEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    return;
  }
  fail++;
  failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
}

function checkTrue(cond, label, detail) {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  failures.push(detail ? `${label}\n    ${detail}` : label);
}

function tagsOf(list) {
  return (list || []).map((r) => r.tag);
}

function catsOf(list) {
  return (list || []).map((r) => r.category);
}

// ---------- 用例 ----------
async function runTagIndexCases(env) {
  const TI = env.window.TagIndex;
  await TI.ensureLoaded();
  await TI.ensureZhLoaded();

  // 1. 普通标签仍可搜（英文词前缀 / 别名）
  checkEq(tagsOf(TI.search('long', { artistOnly: false })), ['long_hair'], '非@英文词前缀可搜到普通标签');
  checkEq(tagsOf(TI.search('longhair', { artistOnly: false })), ['long_hair'], '非@英文别名可搜到普通标签');

  // 2. 非@排除画师（含别名、单字母）
  checkEq(tagsOf(TI.search('wl', { artistOnly: false })), [], '非@ "wl" 不返回画师 wlop');
  checkEq(tagsOf(TI.search('saki', { artistOnly: false })), [], '非@ "saki" 不返回画师 sakimichan');
  checkEq(tagsOf(TI.search('sakimenz', { artistOnly: false })), [], '非@ 画师别名不泄露');
  checkEq(tagsOf(TI.search('da', { artistOnly: false })), [], '非@ "da" 不返回画师 dairi');
  checkEq(tagsOf(TI.search('w', { artistOnly: false })), [], '非@ 单字母不返回画师');
  checkTrue(
    catsOf(TI.search('sak', { artistOnly: false })).indexOf(1) === -1,
    '非@ "sak" 结果不含 category=1',
    `actual=${JSON.stringify(TI.search('sak', { artistOnly: false }))}`
  );
  checkEq(tagsOf(TI.search('sak', { artistOnly: false })), ['sakura'], '非@ "sak" 只返回普通标签 sakura');

  // 3. @ 只出画师
  checkEq(tagsOf(TI.search('wl', { artistOnly: true })), ['wlop'], '@ "wl" 只出画师');
  checkEq(tagsOf(TI.search('sak', { artistOnly: true })), ['sakimichan'], '@ "sak" 只出画师');
  checkTrue(
    catsOf(TI.search('sak', { artistOnly: true })).every((c) => c === 1),
    '@ 结果全为 category=1'
  );

  // 4. 空 @ -> 热门画师；非 @ 空查询 -> 空
  const hot = TI.search('', { artistOnly: true });
  checkTrue(hot.length > 0 && catsOf(hot).every((c) => c === 1), '空 @ 返回热门画师且全为画师');
  checkEq(TI.search('', { artistOnly: false }), [], '非@ 空查询返回空');

  // 5. @ 单字母走画师首字母桶
  checkEq(tagsOf(TI.search('w', { artistOnly: true })), ['wlop'], '@ 单字母 "w" 命中画师首字母桶');
  checkEq(tagsOf(TI.search('d', { artistOnly: true })), ['dairi'], '@ 单字母 "d" 命中画师首字母桶');

  // 6. 多词查询：空格与下划线同义，末词只输 1 个字母也要命中
  checkEq(tagsOf(TI.search('no h', { artistOnly: false })), ['no_humans'], '多词 "no h" 命中 no_humans');
  checkEq(
    tagsOf(TI.search('no_h', { artistOnly: false })),
    tagsOf(TI.search('no h', { artistOnly: false })),
    '"no h" 与 "no_h" 结果一致'
  );
  checkEq(tagsOf(TI.search('no hu', { artistOnly: false })), ['no_humans'], '多词 "no hu" 命中 no_humans');
  // 多词画师：非@ 排除，@ 只出画师
  checkEq(tagsOf(TI.search('no m', { artistOnly: false })), [], '非@ 多词 "no m" 不返回画师 no_man');
  checkEq(tagsOf(TI.search('no m', { artistOnly: true })), ['no_man'], '@ 多词 "no m" 命中画师 no_man');

  // 7. 中文模式：非@排除画师、@只画师
  checkEq(tagsOf(TI.searchZh('樱花', { artistOnly: false })), ['sakura'], '中文非@可搜普通标签');
  checkEq(tagsOf(TI.searchZh('韩国画师', { artistOnly: false })), [], '中文非@不返回画师');
  checkEq(tagsOf(TI.searchZh('坂道', { artistOnly: false })), [], '中文非@不返回画师（别名/中文名）');
  checkEq(tagsOf(TI.searchZh('韩国画师', { artistOnly: true })), ['wlop'], '中文@只出画师');
  checkEq(tagsOf(TI.searchZh('坂道', { artistOnly: true })), ['sakimichan'], '中文@按画师中文名命中');
}

async function runComponentCases() {
  // ---- 末位补逗号：鼠标 / Tab ----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    const picked = inst.menuItems[0].tag;
    inst.onItemMouseDown(0);
    checkEq(picked, 'wlop', '鼠标：菜单首项为画师 wlop');
    checkEq(inst.el.value, '1girl, wlop, ', '鼠标选中末位画师后补 ", "');
    checkEq(inst.el.selectionStart, inst.el.value.length, '鼠标选中后光标在末尾');
    const lastEmit = inst.emitted[inst.emitted.length - 1];
    checkEq(lastEmit && lastEmit[0], 'update:modelValue', '选中后触发 v-model 事件');
    checkEq(lastEmit && lastEmit[1], inst.el.value, 'v-model 值与 textarea 值一致');
    checkEq(inst.menuOpen, false, '选中后菜单关闭');
  }
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    let prevented = false;
    inst.onKeydown({ key: 'Tab', preventDefault() { prevented = true; } });
    checkTrue(prevented, 'Tab 仍拦截默认行为并选中候选');
    checkEq(inst.el.value, '1girl, wlop, ', 'Tab 选中末位画师后补 ", "');
    checkEq(inst.el.selectionStart, inst.el.value.length, 'Tab 选中后光标在末尾');
  }

  // ---- 已有逗号不重复 ----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    // 光标在 "@wl" 末尾（逗号之前），该 token 后面已有 ", 8k"
    await typeValue(inst, '1girl, @wl, 8k', 10);
    checkEq(inst.menuItems[0].tag, 'wlop', '光标在 @wl 末尾时首项为画师 wlop');
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop, 8k', 'token 后已有逗号时原地替换、不重复补逗号');
  }

  // ---- 换行前补全：补逗号，且保留原换行与后续行 ----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '@wl\n8k', 3);
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, 'wlop,\n8k', 'token 后是换行时补逗号，保留换行与后续行');
  }
  {
    // 复现：光标停在行末 token 末（换行符之前）
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl\n', 10);
    checkEq(inst.menuItems[0] && inst.menuItems[0].tag, 'wlop', '换行前 token 末光标仍能选到 wlop');
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop,\n', '换行前选画师补逗号（不在换行前加空格）');
    checkEq(inst.el.selectionStart, 12, '换行前选中后光标停在插入内容之后');
  }
  {
    // 后续多行内容全部保留
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl\n8k, long_hair\n', 10);
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop,\n8k, long_hair\n', '换行前补逗号并保留后续行内容');
  }
  {
    // 已有逗号不重复加
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl,\n8k', 10);
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop,\n8k', '换行前已有逗号时不重复补逗号');
  }
  {
    // CRLF 不被破坏
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl\r\n8k', 10);
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop,\r\n8k', 'CRLF 行尾补逗号且不破坏 \\r\\n');
  }

  // ---- keepAtPrefix / keepUnderscore / escapeParentheses ----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const instAt = makeInstance(env, { keepAtPrefix: true });
    await typeValue(instAt, '1girl, @wl');
    instAt.applySelection(instAt.menuItems[0]);
    checkEq(instAt.el.value, '1girl, @wlop, ', 'keepAtPrefix=true 保留 @ 且补逗号');

    const instNoAt = makeInstance(env, { keepAtPrefix: false });
    await typeValue(instNoAt, '1girl, @wl');
    instNoAt.applySelection(instNoAt.menuItems[0]);
    checkEq(instNoAt.el.value, '1girl, wlop, ', 'keepAtPrefix=false 去掉 @ 且补逗号');

    const instUnderscore = makeInstance(env, { keepUnderscore: false });
    await typeValue(instUnderscore, '1girl, long');
    instUnderscore.applySelection(instUnderscore.menuItems[0]);
    checkEq(instUnderscore.el.value, '1girl, long hair, ', 'keepUnderscore=false 下划线转空格');

    const instParen = makeInstance(env);
    await typeValue(instParen, '@hammer');
    instParen.applySelection(instParen.menuItems[0]);
    checkEq(
      instParen.el.value,
      'hammer_\\(sunset_beach\\), ',
      'escapeParentheses=true 转义括号画师名'
    );
  }

  // ---- 过期候选：外部改写 / 光标移位 -> 不改文本、关菜单 ----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    const staleItem = inst.menuItems[0];
    // 外部改写值（模拟预设/片段/父组件回填），未触发本组件 updateMenu
    inst.el.value = '1girl, @wlop2';
    inst.el.selectionStart = inst.el.selectionEnd = inst.el.value.length;
    inst.applySelection(staleItem);
    checkEq(inst.el.value, '1girl, @wlop2', '值被外部改写后，旧候选不覆盖文本');
    checkEq(inst.menuOpen, false, '过期候选时不改文本并关闭菜单');
    checkEq(inst.menuItems.length, 0, '过期候选后清空旧候选');
  }
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    const staleItem = inst.menuItems[0];
    // 光标移到另一个词内部
    inst.el.selectionStart = inst.el.selectionEnd = 3;
    inst.applySelection(staleItem);
    checkEq(inst.el.value, '1girl, @wl', '光标移到别的词后，旧候选不覆盖文本');
    checkEq(inst.menuOpen, false, '光标移位后关闭菜单');
  }
  {
    // 光标移回同一个 token：仍应正常插入（不能误杀）
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    const item = inst.menuItems[0];
    inst.el.selectionStart = inst.el.selectionEnd = inst.el.value.length;
    inst.applySelection(item);
    checkEq(inst.el.value, '1girl, wlop, ', '光标仍在同一 token 内时正常插入');
  }

  // ---- execCommand 成功 / 兜底分支结果一致 ----
  {
    const env = buildEnv({ execCommand: 'success' });
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop, ', 'execCommand 成功分支：插入并补逗号');
    checkEq(inst.el.selectionStart, 13, 'execCommand 成功分支：光标位置正确');
  }
  {
    const env = buildEnv({ execCommand: 'fallback' });
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    inst.applySelection(inst.menuItems[0]);
    checkEq(inst.el.value, '1girl, wlop, ', 'execCommand 兜底分支：插入并补逗号');
    checkEq(inst.el.selectionStart, 13, 'execCommand 兜底分支：光标位置正确');
  }

  // ---- Enter 仍是换行（回归）：不改文本、不选中 ----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    const inst = makeInstance(env);
    await typeValue(inst, '1girl, @wl');
    let prevented = false;
    inst.onKeydown({ key: 'Enter', preventDefault() { prevented = true; } });
    checkEq(prevented, false, 'Enter 不被拦截（保持浏览器换行）');
    checkEq(inst.el.value, '1girl, @wl', 'Enter 不选中候选、不改文本');
    checkEq(inst.menuOpen, true, 'Enter 不关闭菜单（行为与修复前一致）');
  }

  // ---- 组件级：非@菜单不含画师，@菜单只含画师（英文 + 中文）----
  {
    const env = buildEnv();
    await env.window.TagIndex.ensureLoaded();
    await env.window.TagIndex.ensureZhLoaded();

    const instEn = makeInstance(env);
    const tokenEn = await typeValue(instEn, '1girl, wl');
    checkEq(tokenEn.artistOnly, false, '英文非@ token.artistOnly=false');
    checkEq(instEn.menuItems.length, 0, '英文非@ 不联想画师（wl 无普通标签匹配）');

    const instSak = makeInstance(env);
    await typeValue(instSak, 'sak');
    checkEq(
      instSak.menuItems.map((m) => `${m.tag}/${m.catLabel}`),
      ['sakura/'],
      '英文非@ 结果只含普通标签'
    );

    const instAt = makeInstance(env);
    const tokenAt = await typeValue(instAt, '@wl');
    checkEq(tokenAt.artistOnly, true, '@ token.artistOnly=true');
    checkEq(
      instAt.menuItems.map((m) => `${m.tag}/${m.catLabel}`),
      ['wlop/画师'],
      '@ 结果只含画师'
    );

    const instZh = makeInstance(env);
    await typeValue(instZh, '韩国画师');
    checkEq(instZh.menuItems.length, 0, '中文非@ 不联想画师');

    const instZhAt = makeInstance(env);
    await typeValue(instZhAt, '@韩国画师');
    checkEq(
      instZhAt.menuItems.map((m) => `${m.tag}/${m.catLabel}`),
      ['wlop/画师'],
      '中文@ 只联想画师'
    );

    const instMulti = makeInstance(env);
    await typeValue(instMulti, 'no h');
    checkEq(
      instMulti.menuItems.map((m) => m.tag),
      ['no_humans'],
      '组件级：输入 "no h" 即联想 no_humans'
    );

    const instZhPlain = makeInstance(env);
    await typeValue(instZhPlain, '樱花');
    checkEq(
      instZhPlain.menuItems.map((m) => `${m.tag}/${m.catLabel}`),
      ['sakura/'],
      '中文非@ 普通标签仍可联想'
    );
  }
}

(async () => {
  const env = buildEnv();
  await runTagIndexCases(env);
  await runComponentCases();

  if (fail > 0) {
    console.error(`FAIL: ${fail} 项失败，${pass} 项通过\n`);
    failures.forEach((f, i) => console.error(`${i + 1}) ${f}`));
    process.exit(1);
  }
  console.log(`PASS: ${pass} 项通过，0 失败`);
})().catch((err) => {
  console.error('测试运行异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
