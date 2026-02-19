/**
 * TagIndex
 * - Loads danbooru tag CSV from ./tags/danbooru.csv (lazy)
 * - Provides fast word-prefix search for autocomplete
 *
 * CSV format (danbooru.csv):
 *   tag,category,count,aliases
 * Example:
 *   1girl,0,4114588,"1girls,sole_female"
 */

(function () {
  const DANBOORU_URL = './tags/danbooru.csv';
  const PREFIX_LEN = 2;

  /** @type {{ loaded: boolean, loadingPromise: Promise<void>|null, tags: Array<{tag:string, category:number, count:number}>, wordPrefixMap: Record<string, number[]> }} */
  const state = {
    loaded: false,
    loadingPromise: null,
    tags: [],
    wordPrefixMap: Object.create(null)
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

  function parseDanbooruLine(line) {
    if (!line) return null;
    const s = String(line).trim();
    if (!s) return null;

    // tag,category,count,aliases
    const i1 = s.indexOf(',');
    if (i1 === -1) return null;
    const i2 = s.indexOf(',', i1 + 1);
    if (i2 === -1) return null;
    const i3 = s.indexOf(',', i2 + 1);
    if (i3 === -1) return null;

    const tag = s.slice(0, i1);
    const category = parseInt(s.slice(i1 + 1, i2), 10);
    const count = parseInt(s.slice(i2 + 1, i3), 10);
    if (!tag) return null;
    if (Number.isNaN(category) || Number.isNaN(count)) return null;

    return { tag, category, count };
  }

  async function loadDanbooru() {
    if (state.loaded) return;
    if (state.loadingPromise) return state.loadingPromise;

    state.loadingPromise = (async () => {
      const res = await fetch(DANBOORU_URL, { cache: 'force-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load ${DANBOORU_URL} (HTTP ${res.status})`);
      }
      const text = await res.text();
      const lines = text.split(/\r?\n/);

      const tags = [];
      const wordPrefixMap = Object.create(null);

      for (let i = 0; i < lines.length; i++) {
        const parsed = parseDanbooruLine(lines[i]);
        if (!parsed) continue;

        const idx = tags.length;
        tags.push(parsed);

        // Build word-prefix index so "hair" can match "black_hair".
        const key = stripParens(parsed.tag).toLowerCase();
        const parts = key.split('_');
        const seen = Object.create(null);
        for (let j = 0; j < parts.length; j++) {
          const w = parts[j];
          if (!w) continue;
          const p = getPrefix(w);
          if (!p) continue;
          if (seen[p]) continue;
          seen[p] = 1;
          if (!wordPrefixMap[p]) wordPrefixMap[p] = [];
          wordPrefixMap[p].push(idx);
        }
      }

      state.tags = tags;
      state.wordPrefixMap = wordPrefixMap;
      state.loaded = true;
    })();

    try {
      await state.loadingPromise;
    } finally {
      state.loadingPromise = null;
    }
  }

  /**
   * Search tags by word prefix.
   * @param {string} query
   * @param {{ limit?: number, artistOnly?: boolean }} [opts]
   * @returns {Array<{tag:string, category:number, count:number}>}
   */
  function search(query, opts) {
    const qNorm = normalizeForMatch(query);
    if (!state.loaded) return [];
    if (!qNorm) return [];

    const limit = opts && opts.limit ? Math.max(1, Math.min(opts.limit, 100)) : 20;
    const artistOnly = !!(opts && opts.artistOnly);

    const qWords = qNorm
      .split(' ')
      .map(w => stripParens(w))
      .filter(Boolean);
    if (qWords.length === 0) return [];

    // Choose the smallest bucket to reduce scanning.
    let bucket = null;
    for (let i = 0; i < qWords.length; i++) {
      const p = getPrefix(qWords[i]);
      const b = state.wordPrefixMap[p] || [];
      if (!b.length) return [];
      if (!bucket || b.length < bucket.length) bucket = b;
    }

    const out = [];
    for (let i = 0; i < bucket.length; i++) {
      const t = state.tags[bucket[i]];
      if (!t) continue;
      if (artistOnly && t.category !== 1) continue;
      if (!t.tag) continue;

      const tagKey = stripParens(t.tag).toLowerCase();

      let ok = true;
      for (let j = 0; j < qWords.length; j++) {
        const w = qWords[j];
        if (!w) continue;
        if (tagKey.startsWith(w)) continue;
        if (tagKey.includes(`_${w}`)) continue;
        ok = false;
        break;
      }

      if (ok) {
        out.push(t);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  const TagIndex = {
    ensureLoaded: loadDanbooru,
    isLoaded: () => state.loaded,
    search
  };

  window.TagIndex = TagIndex;
})();
