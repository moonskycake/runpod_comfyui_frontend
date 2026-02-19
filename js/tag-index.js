/**
 * TagIndex
 * - Loads danbooru tag CSV from ./tags/danbooru.csv (lazy)
 * - Provides fast prefix search for autocomplete
 *
 * CSV format (danbooru.csv):
 *   tag,category,count,aliases
 * Example:
 *   1girl,0,4114588,"1girls,sole_female"
 */

(function () {
  const DANBOORU_URL = './tags/danbooru.csv';
  const PREFIX_LEN = 2;

  /** @type {{ loaded: boolean, loadingPromise: Promise<void>|null, tags: Array<{tag:string, category:number, count:number}>, prefixMap: Record<string, number[]> }} */
  const state = {
    loaded: false,
    loadingPromise: null,
    tags: [],
    prefixMap: Object.create(null)
  };

  function normalizeQuery(q) {
    if (!q) return '';
    return String(q).trim().toLowerCase();
  }

  function getPrefix(tag) {
    const t = (tag || '').toLowerCase();
    if (!t) return '';
    return t.length <= PREFIX_LEN ? t : t.slice(0, PREFIX_LEN);
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
      const prefixMap = Object.create(null);

      for (let i = 0; i < lines.length; i++) {
        const parsed = parseDanbooruLine(lines[i]);
        if (!parsed) continue;

        const idx = tags.length;
        tags.push(parsed);

        const p = getPrefix(parsed.tag);
        if (!p) continue;
        if (!prefixMap[p]) prefixMap[p] = [];
        prefixMap[p].push(idx);
      }

      state.tags = tags;
      state.prefixMap = prefixMap;
      state.loaded = true;
    })();

    try {
      await state.loadingPromise;
    } finally {
      state.loadingPromise = null;
    }
  }

  /**
   * Search tags by prefix.
   * @param {string} query
   * @param {{ limit?: number, artistOnly?: boolean }} [opts]
   * @returns {Array<{tag:string, category:number, count:number}>}
   */
  function search(query, opts) {
    const q = normalizeQuery(query);
    if (!state.loaded) return [];
    if (!q) return [];

    const limit = opts && opts.limit ? Math.max(1, Math.min(opts.limit, 100)) : 20;
    const artistOnly = !!(opts && opts.artistOnly);

    const p = q.length <= PREFIX_LEN ? q : q.slice(0, PREFIX_LEN);
    const bucket = state.prefixMap[p] || [];

    const out = [];
    for (let i = 0; i < bucket.length; i++) {
      const t = state.tags[bucket[i]];
      if (!t) continue;
      if (artistOnly && t.category !== 1) continue;
      if (!t.tag || t.tag.length < q.length) continue;
      if (t.tag.toLowerCase().startsWith(q)) {
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
