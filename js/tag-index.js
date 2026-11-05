/**
 * TagIndex
 * - Loads danbooru tag CSV from ./tags/danbooru.csv (lazy)
 * - Uses ./tags/manifest.json version to bust stale browser cache
 * - Provides fast word-prefix search for autocomplete
 *
 * CSV format (danbooru.csv):
 *   tag,category,count,"alias1,alias2"
 * Example:
 *   1girl,0,4114588,"1girls,sole_female"
 *
 * Indexes:
 * - wordPrefixMap: 词前缀 -> tag 下标（普通标签联想）
 * - aliasPrefixMap: 别名词前缀 -> tag 下标（别名也能搜到正式标签）
 * - artistByInitial: 首字母 -> 画师 tag 下标（画师只需 1 个字母就能出结果）
 * - topArtists: 按热度排序的前若干画师（输入 @ 后直接给热门画师）
 */

(function () {
  const DANBOORU_URL = './tags/danbooru.csv';
  const ZH_URL = './tags/zhcn.csv';
  const DANBOORU_MANIFEST_URL = './tags/manifest.json';
  const PREFIX_LEN = 2;
  const TOP_ARTIST_COUNT = 60;

  /**
   * @type {{
   *   loaded: boolean,
   *   loadingPromise: Promise<void>|null,
   *   tags: Array<{tag:string, category:number, count:number, key:string, aliasKeys:string[]|null}>,
   *   wordPrefixMap: Record<string, number[]>,
   *   aliasPrefixMap: Record<string, number[]>,
   *   artistByInitial: Record<string, number[]>,
   *   topArtists: number[],
   *   zhLoaded: boolean,
   *   zhLoadingPromise: Promise<void>|null,
   *   zhByTag: Map<string, string>,
   *   zhIndex: Map<string, number[]>
   * }}
   */
  const state = {
    loaded: false,
    loadingPromise: null,
    tags: [],
    wordPrefixMap: Object.create(null),
    aliasPrefixMap: Object.create(null),
    artistByInitial: Object.create(null),
    topArtists: [],
    zhLoaded: false,
    zhLoadingPromise: null,
    zhByTag: new Map(),
    zhIndex: new Map()
  };

  function normalizeQuery(q) {
    if (!q) return '';
    return String(q).trim().toLowerCase();
  }

  function normalizeForMatch(q) {
    const s = normalizeQuery(q);
    if (!s) return '';
    return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function getPrefix(text) {
    const t = (text || '').toLowerCase();
    if (!t) return '';
    return t.length <= PREFIX_LEN ? t : t.slice(0, PREFIX_LEN);
  }

  function stripParens(text) {
    return String(text || '').replace(/[()]/g, '');
  }

  // 标签名规范化：小写、去括号，用于建索引与匹配
  function normalizeKey(text) {
    return stripParens(String(text || '')).toLowerCase();
  }

  function addToBucket(map, key, idx) {
    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(idx);
  }

  function indexWords(map, key, idx) {
    const parts = key.split('_');
    const seen = Object.create(null);
    for (let i = 0; i < parts.length; i++) {
      const w = parts[i];
      if (!w) continue;
      const p = getPrefix(w);
      if (!p) continue;
      if (seen[p]) continue;
      seen[p] = 1;
      addToBucket(map, p, idx);
    }
  }

  function parseAliases(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    return s
      .split(',')
      .map(a => normalizeKey(a.trim()))
      .filter(Boolean);
  }

  function parseDanbooruLine(line) {
    if (!line) return null;
    const s = String(line).trim();
    if (!s) return null;

    // tag,category,count,"alias1,alias2"
    const i1 = s.indexOf(',');
    if (i1 === -1) return null;
    const i2 = s.indexOf(',', i1 + 1);
    if (i2 === -1) return null;
    const i3 = s.indexOf(',', i2 + 1);

    const tag = s.slice(0, i1);
    const category = parseInt(s.slice(i1 + 1, i2), 10);
    const count = parseInt(s.slice(i2 + 1, i3 === -1 ? s.length : i3), 10);
    if (!tag) return null;
    if (Number.isNaN(category) || Number.isNaN(count)) return null;

    let aliases = [];
    if (i3 !== -1) {
      let rest = s.slice(i3 + 1).trim();
      if (rest.charAt(0) === '"') {
        rest = rest.slice(1);
        const close = rest.lastIndexOf('"');
        if (close !== -1) rest = rest.slice(0, close);
        rest = rest.replace(/""/g, '"');
      }
      aliases = parseAliases(rest);
    }

    return { tag, category, count, aliases };
  }

  function parseManifestVersion(manifest) {
    if (!manifest || typeof manifest !== 'object') return '';
    const version = String(manifest.version || '').trim();
    if (!version) return '';
    return version;
  }

  async function resolveDanbooruUrl() {
    return resolveVersionedUrl(DANBOORU_URL);
  }

  async function resolveVersionedUrl(url) {
    try {
      const manifestRes = await fetch(DANBOORU_MANIFEST_URL, { cache: 'no-store' });
      if (!manifestRes.ok) return url;

      const manifest = await manifestRes.json();
      const version = parseManifestVersion(manifest);
      if (!version) return url;

      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}v=${encodeURIComponent(version)}`;
    } catch (err) {
      return url;
    }
  }

  async function loadDanbooru() {
    if (state.loaded) return;
    if (state.loadingPromise) return state.loadingPromise;

    state.loadingPromise = (async () => {
      const csvUrl = await resolveDanbooruUrl();
      const res = await fetch(csvUrl, { cache: 'force-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load ${csvUrl} (HTTP ${res.status})`);
      }
      const text = await res.text();
      const lines = text.split(/\r?\n/);

      const tags = [];
      const wordPrefixMap = Object.create(null);
      const aliasPrefixMap = Object.create(null);
      const artistByInitial = Object.create(null);
      const topArtists = [];

      for (let i = 0; i < lines.length; i++) {
        const parsed = parseDanbooruLine(lines[i]);
        if (!parsed) continue;

        const idx = tags.length;
        const key = normalizeKey(parsed.tag);
        const aliasKeys = parsed.aliases.length ? parsed.aliases : null;
        tags.push({
          tag: parsed.tag,
          category: parsed.category,
          count: parsed.count,
          key,
          aliasKeys
        });

        // "hair" 也能匹配 "black_hair"
        indexWords(wordPrefixMap, key, idx);
        if (aliasKeys) {
          for (let a = 0; a < aliasKeys.length; a++) {
            indexWords(aliasPrefixMap, aliasKeys[a], idx);
          }
        }

        if (parsed.category === 1) {
          addToBucket(artistByInitial, key.charAt(0), idx);
          if (topArtists.length < TOP_ARTIST_COUNT) topArtists.push(idx);
        }
      }

      state.tags = tags;
      state.wordPrefixMap = wordPrefixMap;
      state.aliasPrefixMap = aliasPrefixMap;
      state.artistByInitial = artistByInitial;
      state.topArtists = topArtists;
      state.loaded = true;
    })();

    try {
      await state.loadingPromise;
    } finally {
      state.loadingPromise = null;
    }
  }

  function keyMatchesQuery(key, qWords) {
    if (!key) return false;
    for (let i = 0; i < qWords.length; i++) {
      const w = qWords[i];
      if (key.startsWith(w)) continue;
      if (key.includes(`_${w}`)) continue;
      return false;
    }
    return true;
  }

  function tagMatchesQuery(t, qWords) {
    if (keyMatchesQuery(t.key, qWords)) return true;
    const aliases = t.aliasKeys;
    if (!aliases) return false;
    for (let i = 0; i < aliases.length; i++) {
      if (keyMatchesQuery(aliases[i], qWords)) return true;
    }
    return false;
  }

  // 扫描候选桶，收集满足条件的 tag；返回 true 表示已达上限可提前结束
  function scanBucket(bucket, qWords, artistOnly, out, seen, limit) {
    if (!bucket) return false;
    for (let i = 0; i < bucket.length; i++) {
      const idx = bucket[i];
      if (seen[idx]) continue;
      const t = state.tags[idx];
      if (!t) continue;
      if (artistOnly && t.category !== 1) continue;
      if (!tagMatchesQuery(t, qWords)) continue;
      seen[idx] = 1;
      out.push(t);
      if (out.length >= limit) return true;
    }
    return false;
  }

  function smallestBucket(map, words) {
    let bucket = null;
    for (let i = 0; i < words.length; i++) {
      const b = map[getPrefix(words[i])];
      if (!b || !b.length) return null;
      if (!bucket || b.length < bucket.length) bucket = b;
    }
    return bucket;
  }

  /**
   * Search tags by word prefix.
   *
   * 特殊约定：
   * - query 为空且 artistOnly=true 时返回热门画师（输入 @ 后即可展示）
   * - artistOnly 且只有 1 个字母时按画师首字母出结果（@s -> s 开头画师）
   *
   * @param {string} query
   * @param {{ limit?: number, artistOnly?: boolean }} [opts]
   * @returns {Array<{tag:string, category:number, count:number}>}
   */
  function search(query, opts) {
    if (!state.loaded) return [];

    const limit = opts && opts.limit ? Math.max(1, Math.min(opts.limit, 100)) : 20;
    const artistOnly = !!(opts && opts.artistOnly);

    const qNorm = normalizeForMatch(query);
    const qWords = qNorm
      ? qNorm
          .split(' ')
          .map(w => stripParens(w))
          .filter(Boolean)
      : [];

    if (qWords.length === 0) {
      if (!artistOnly) return [];
      const hot = [];
      for (let i = 0; i < state.topArtists.length && hot.length < limit; i++) {
        const t = state.tags[state.topArtists[i]];
        if (t) hot.push(t);
      }
      return hot;
    }

    const out = [];
    const seen = Object.create(null);

    // 画师 + 单字母：走首字母索引（词前缀索引对单字母没有意义）
    if (artistOnly && qWords.length === 1 && qWords[0].length === 1) {
      const initial = qWords[0];
      scanBucket(state.artistByInitial[initial], qWords, true, out, seen, limit);
      return out;
    }

    // 普通路径：词前缀桶；别名命中在第二遍补充
    const wordBucket = smallestBucket(state.wordPrefixMap, qWords);
    if (wordBucket) {
      const done = scanBucket(wordBucket, qWords, artistOnly, out, seen, limit);
      if (done) return out;
    }

    const aliasBucket = smallestBucket(state.aliasPrefixMap, qWords);
    if (aliasBucket) {
      scanBucket(aliasBucket, qWords, artistOnly, out, seen, limit);
    }

    return out;
  }

  // ---------- 中文词库（tags/zhcn.csv：英文标签 -> 中文，懒加载） ----------

  // 中文匹配前去掉空白与标点，避免 “白 发”“（白发）” 这类差异
  function normalizeZh(text) {
    return String(text || '')
      .replace(/[\s\u3000]/g, '')
      .replace(/[()（）\[\]【】,，、。.!！?？;；:：'"“”‘’<>《》~～_\-/\\|]/g, '');
  }

  function addZhGram(map, gram, idx) {
    if (!gram) return;
    const bucket = map.get(gram);
    if (!bucket) {
      map.set(gram, [idx]);
      return;
    }
    if (bucket[bucket.length - 1] !== idx) bucket.push(idx);
  }

  function parseZhLine(line) {
    const s = String(line || '').trim();
    if (!s) return null;

    let key = '';
    let rest = '';
    if (s.charAt(0) === '"') {
      const end = s.indexOf('"', 1);
      if (end === -1) return null;
      key = s.slice(1, end);
      rest = s.slice(end + 1);
    } else {
      const comma = s.indexOf(',');
      if (comma === -1) return null;
      key = s.slice(0, comma);
      rest = s.slice(comma);
    }

    if (rest.charAt(0) === ',') rest = rest.slice(1);
    rest = rest.trim();
    if (rest.charAt(0) === '"') {
      rest = rest.slice(1);
      const close = rest.lastIndexOf('"');
      if (close !== -1) rest = rest.slice(0, close);
      rest = rest.replace(/""/g, '"');
    }

    const en = key.trim().toLowerCase().replace(/\s+/g, '_');
    const zh = rest.trim();
    if (!en || !zh) return null;
    return { en, zh };
  }

  async function loadZh() {
    if (state.zhLoaded) return;
    if (state.zhLoadingPromise) return state.zhLoadingPromise;

    state.zhLoadingPromise = (async () => {
      await loadDanbooru();

      const csvUrl = await resolveVersionedUrl(ZH_URL);
      const res = await fetch(csvUrl, { cache: 'force-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load ${csvUrl} (HTTP ${res.status})`);
      }
      const text = await res.text();
      const lines = text.split(/\r?\n/);

      const zhByTag = new Map();
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseZhLine(lines[i]);
        if (!parsed) continue;
        if (!zhByTag.has(parsed.en)) zhByTag.set(parsed.en, parsed.zh);
      }

      // 只保留当前标签库里的词条；按标签下标顺序写桶，保证结果 ≈ 热度降序
      const zhIndex = new Map();
      const tags = state.tags;
      for (let idx = 0; idx < tags.length; idx++) {
        const zh = zhByTag.get(tags[idx].key);
        if (!zh) continue;
        const compact = normalizeZh(zh);
        if (!compact) continue;
        for (let i = 0; i < compact.length; i++) {
          addZhGram(zhIndex, compact.charAt(i), idx);
          if (i + 1 < compact.length) addZhGram(zhIndex, compact.slice(i, i + 2), idx);
        }
      }

      state.zhByTag = zhByTag;
      state.zhIndex = zhIndex;
      state.zhLoaded = true;
    })();

    try {
      await state.zhLoadingPromise;
    } finally {
      state.zhLoadingPromise = null;
    }
  }

  /**
   * 取标签对应的中文说明（未加载中文库或未收录时返回空串）
   * @param {string} tag
   * @returns {string}
   */
  function getZh(tag) {
    if (!state.zhLoaded) return '';
    return state.zhByTag.get(normalizeKey(tag)) || '';
  }

  /**
   * 中文 -> 英文标签
   * @param {string} query 中文关键词
   * @param {{ limit?: number, artistOnly?: boolean }} [opts]
   * @returns {Array<{tag:string, category:number, count:number, zh:string}>}
   */
  function searchZh(query, opts) {
    if (!state.zhLoaded) return [];

    const limit = opts && opts.limit ? Math.max(1, Math.min(opts.limit, 100)) : 20;
    const artistOnly = !!(opts && opts.artistOnly);
    const qNorm = normalizeZh(query);
    if (!qNorm) return [];

    const gram = qNorm.length === 1 ? qNorm : qNorm.slice(0, 2);
    const candidates = state.zhIndex.get(gram) || [];
    const out = [];

    for (let i = 0; i < candidates.length; i++) {
      const idx = candidates[i];
      const t = state.tags[idx];
      if (!t) continue;
      if (artistOnly && t.category !== 1) continue;

      const zh = state.zhByTag.get(t.key) || '';
      if (!zh) continue;
      if (!normalizeZh(zh).includes(qNorm)) continue;

      out.push({ tag: t.tag, category: t.category, count: t.count, zh });
      if (out.length >= limit) break;
    }

    return out;
  }

  const TagIndex = {
    ensureLoaded: loadDanbooru,
    isLoaded: () => state.loaded,
    ensureZhLoaded: loadZh,
    isZhLoaded: () => state.zhLoaded,
    getZh,
    search,
    searchZh
  };

  window.TagIndex = TagIndex;
})();
