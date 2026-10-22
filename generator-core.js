/*
  Level generator engine, shared by generator.html (browser, as window.GenCore) and headless scripts (node,
  as module.exports). No DOM in here.

  Conventions match index.html: layers[0] is the top layer, dir 0 = right, 1 = down, 2 = left, 3 = up.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const LOCALES = { en: 'en-US', tr: 'tr-TR' };
  const MIN_TARGET_SCORE = 3; // target words: scored 3 or 4
  const MIN_BONUS_SCORE = 2;  // bonus words: anything in the dictionary scored above 1
  const MIN_BONUS_LEN = 3;
  const EASY_SCORE = 4;       // "easy top layer" picks top-layer words from this score when the pool is big enough
  const EASY_POOL_MIN = 20;
  const ORIENT_SHARE = 0.85;  // share of a branch half's placement weight going to its preferred direction

  // ======================================================================
  // Dictionaries
  // ======================================================================
  // -> { pool: Map(len -> [WORD]), easy: Map(len -> [WORD] scored EASY_SCORE), score: Map(WORD -> score), bonus: Set, targets }
  function parseDict(text, lang) {
    const pool = new Map(), easy = new Map(), score = new Map(), bonus = new Set(), bonusPrefix = new Set();
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 2) continue;
      const word = cols[0].trim().toLocaleUpperCase(LOCALES[lang]);
      const s = parseInt(cols[1], 10);
      if (!/^\p{L}{2,}$/u.test(word) || !Number.isFinite(s)) continue;
      if (s >= MIN_BONUS_SCORE && word.length >= MIN_BONUS_LEN) {
        bonus.add(word);
        for (let k = 1; k < word.length; k++) bonusPrefix.add(word.slice(0, k));
      }
      if (s >= MIN_TARGET_SCORE && !score.has(word)) {
        score.set(word, s);
        if (!pool.has(word.length)) pool.set(word.length, []);
        pool.get(word.length).push(word);
        if (s >= EASY_SCORE) {
          if (!easy.has(word.length)) easy.set(word.length, []);
          easy.get(word.length).push(word);
        }
      }
    }
    return { pool, easy, score, bonus, bonusPrefix, targets: score.size };
  }

  // Every dictionary word that can show up on the board in any state: along each straight line, each cell can
  // show any letter of its stack (words are removed in whatever order the player finds them), so this walks
  // every combination, pruned by the dictionary's prefixes. A superset of what any solve order reveals; the
  // game only accepts a word that is actually spelled on the board at that moment, so extra entries are harmless.
  function allVisibleWords(layers, W, H, dict) {
    const letters = Array.from({ length: W * H }, () => new Set());
    layers.forEach(layer => layer.forEach(w => {
      const [dx, dy] = DIRS[w.dir];
      for (let k = 0; k < w.word.length; k++) letters[(w.y + dy * k) * W + (w.x + dx * k)].add(w.word[k]);
    }));
    const found = new Set(), maxDim = Math.max(W, H);
    const walk = (x, y, dx, dy, k, prefix) => {
      if (k >= maxDim || x < 0 || y < 0 || x >= W || y >= H) return;
      const set = letters[y * W + x];
      if (!set.size) return;
      for (const ch of set) {
        const s = prefix + ch;
        if (s.length >= MIN_BONUS_LEN && dict.bonus.has(s)) found.add(s);
        if (dict.bonusPrefix.has(s)) walk(x + dx, y + dy, dx, dy, k + 1, s);
      }
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let dir = 0; dir < 4; dir++) {
      const [dx, dy] = DIRS[dir];
      walk(x, y, dx, dy, 0, '');
    }
    return [...found].sort();
  }

  // Extras of a level, in three kinds: `root` = stems/extensions of a target (ÇALMA under ÇALMAK, OVA under OVAL;
  // one is a prefix of the other, 3+ letters shared) — these come with the target and are not held against the
  // level; `four` = other extras of 4+ letters (the ones worth capping); `three` = other 3-letter extras.
  function classifyExtras(validWords, targets) {
    const root = [], four = [], three = [];
    for (const e of validWords) {
      const stem = targets.some(t => t !== e && (e.startsWith(t) || t.startsWith(e)) && Math.min(e.length, t.length) >= 3);
      if (stem) root.push(e); else if (e.length >= 4) four.push(e); else three.push(e);
    }
    return { root, four, three };
  }
  // Everything the level ships as validWords plus the three kinds, for one set of layers.
  function extrasOf(layers, W, H, dict) {
    const targets = layers.flat().map(w => w.word), targetSet = new Set(targets);
    const validWords = allVisibleWords(layers, W, H, dict).filter(w => !targetSet.has(w));
    return { validWords, ...classifyExtras(validWords, targets) };
  }

  // ======================================================================
  // Profile: a chain of segments, expanded to one entry per layer
  //   { type: 'single', counts: '1,4,6' }                        one area: the whole board
  //   { type: 'branch', a: { counts, flip }, b: { counts, flip } } the board split in two across its longer side
  // Per-layer flags, written after a count: "2,2,3(R,C,H,D)".
  // ======================================================================
  const FLAG_NAMES = {
    R: 'random direction',
    C: 'next layer crosses at right angles',
    H: 'long words',
    D: 'backwards',
    F: 'forward only (never reversed)',
    L: 'loose cover (may lie under any layer above)',
    K: 'knot layer (first in line for the reversed share)',
  };

  function parseLayers(str, where, errors) {
    const out = [], re = /(\d+)\s*(?:\(([^)]*)\))?/g;
    const text = String(str);
    let m;
    while ((m = re.exec(text))) {
      const count = Number(m[1]), flags = {};
      (m[2] || '').split(/[\s,]+/).filter(Boolean).forEach(f => {
        const k = f.toUpperCase();
        if (FLAG_NAMES[k]) flags[k] = true; else errors.push(`${where}: unknown flag "${f}" (use R, C, H, D, F, L or K)`);
      });
      if (count > 0) out.push({ count, flags });
    }
    if (/[^\s,]/.test(text.replace(re, ''))) errors.push(`${where}: couldn't read "${text}"`);
    return out;
  }
  const flagText = f => { const k = Object.keys(f); return k.length ? `(${k.join(',')})` : ''; };

  // Split across the longer side: a tall (or square) board into top/bottom, a wide one into left/right.
  function splitInfo(W, H) {
    const rows = H >= W;
    const cut = rows ? Math.floor(H / 2) : Math.floor(W / 2);
    const sizeA = rows ? [W, cut] : [cut, H], sizeB = rows ? [W, H - cut] : [W - cut, H];
    return {
      rows, cut,
      names: rows ? ['Top', 'Bottom'] : ['Left', 'Right'],
      orient: [sizeA, sizeB].map(([w, h]) => (w >= h ? 'h' : 'v')),
    };
  }
  const flipOrient = (o, flip) => (flip ? (o === 'h' ? 'v' : 'h') : o);

  // -> { layers: [{ zones: [{ region, count, orient, flags }], loose }], totals, regionOf, split, hasBranch, errors, warnings }
  function expandPlan(segs, W, H) {
    const sp = splitInfo(W, H), layers = [], errors = [];
    segs.forEach((seg, i) => {
      if (seg.type === 'single') {
        const c = parseLayers(seg.counts, `Part ${i + 1}`, errors);
        if (!c.length) errors.push(`Part ${i + 1}: enter words per layer`);
        c.forEach(({ count, flags }) => layers.push({ zones: [{ region: 'all', count, orient: null, flags }] }));
      } else {
        const a = parseLayers(seg.a.counts, `Branch ${i + 1} ${sp.names[0]}`, errors);
        const b = parseLayers(seg.b.counts, `Branch ${i + 1} ${sp.names[1]}`, errors);
        if (!a.length || !b.length) errors.push(`Branch ${i + 1}: enter words per layer for both halves`);
        else if (a.length !== b.length) errors.push(`Branch ${i + 1}: ${sp.names[0]} has ${a.length} layers, ${sp.names[1]} has ${b.length}; they must match`);
        a.forEach((la, k) => {
          const lb = b[k] || { count: 0, flags: {} };
          layers.push({ zones: [
            { region: 'A', count: la.count, orient: la.flags.R ? null : flipOrient(sp.orient[0], seg.a.flip), flags: la.flags },
            { region: 'B', count: lb.count, orient: lb.flags.R ? null : flipOrient(sp.orient[1], seg.b.flip), flags: lb.flags },
          ] });
        });
      }
    });
    layers.forEach(l => { l.loose = l.zones.some(z => z.flags.L); });
    const warnings = [];
    const last = layers[layers.length - 1];
    if (last && last.zones.some(z => z.flags.C)) warnings.push('C on the last layer has no effect (there is no layer below it)');
    if (layers[0] && layers[0].loose) warnings.push('L on the top layer has no effect');
    const regionOf = new Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) regionOf[y * W + x] = (sp.rows ? y : x) < sp.cut ? 'A' : 'B';
    const totals = layers.map(l => l.zones.reduce((n, z) => n + z.count, 0));
    return { layers, totals, regionOf, split: sp, hasBranch: segs.some(s => s.type === 'branch'), errors, warnings };
  }

  // ======================================================================
  // Seeded random
  // ======================================================================
  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // Per-level seed derived from the batch seed, so any level can be regenerated on its own.
  const levelSeed = (base, i) => (Math.imul(base | 0, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0;

  // ======================================================================
  // Placement
  // ======================================================================
  // Profile-driven placement, one layer at a time from the top. A word in layer L > 0 must lie under at least
  // one word of the layer directly above (strict) or of any layer above (loose, or an L layer).
  // Weighting shapes the crossings (fan-out: long words above, right-angle crossings below; narrowing: words
  // crossing several words above). Flags: R even direction split, C next layer crosses at right angles,
  // H long words, D backwards, F never reversed, L loose cover for this layer.
  // o.easyTop: top-layer words come from the easy pool (score 4) when it is big enough and start with distinct letters.
  // forbid: Map(word -> uses) of words that may not be used at all (funnel-wide zero reuse).
  // Returns null when a zone can't get its words.
  function generateLevel(dict, o, seed, forbid = null) {
    const rnd = mulberry32(seed);
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const { W, H, plan, minLen, maxLen, cover } = o;
    const { layers: planLayers, regionOf } = plan;
    const lens = [];
    for (let l = minLen; l <= Math.min(maxLen, Math.max(W, H)); l++) if (dict.pool.has(l)) lens.push(l);
    if (!lens.length) return null;

    const countIn = (L, region) => {
      if (L < 0 || L >= planLayers.length) return 0;
      const zs = planLayers[L].zones;
      if (region === 'all' || zs.length === 1) return zs.reduce((n, z) => n + z.count, 0);
      const z = zs.find(z => z.region === region);
      return z ? z.count : 0;
    };

    const used = new Set(), topFirst = new Set();
    const layers = [];
    const aboveOwner = new Int32Array(W * H).fill(-1);
    let prevOwner = new Int32Array(W * H).fill(-1);
    let stickId = 0;
    const stickInfo = [];
    const deepest = new Int32Array(W * H).fill(-1);

    const pickWord = (len, easyTop) => {
      const easyList = easyTop ? dict.easy.get(len) : null;
      const list = easyList && easyList.length >= EASY_POOL_MIN ? easyList : dict.pool.get(len);
      for (let k = 0; k < 30; k++) {
        const w = pick(list);
        if (used.has(w) || (forbid && forbid.get(w))) continue;
        if (easyTop && topFirst.has(w[0])) continue;
        return w;
      }
      return null;
    };

    // Places one layer. On failure every word it took is given back, so the layer can simply be tried again
    // with fresh random choices (o.layerTries, default 4) instead of throwing the whole level away.
    const placeLayer = L => {
      const owner = cover === 'strict' && !planLayers[L].loose ? prevOwner : aboveOwner;
      const occ = new Uint8Array(W * H);
      const nextOwner = new Int32Array(W * H).fill(-1);
      const splitsNext = planLayers[L].zones.length === 1 && L + 1 < planLayers.length && planLayers[L + 1].zones.length > 1;
      const words = [], added = [];
      const easyTop = !!o.easyTop && L === 0;
      let nextId = stickId;
      const fail = () => { added.forEach(w => { used.delete(w); topFirst.delete(w[0]); }); return null; };

      for (const z of planLayers[L].zones) {
        if (!z.count) continue;
        const fanOutNext = countIn(L + 1, z.region) > z.count;
        const fanningOut = L > 0 && z.count > countIn(L - 1, z.region);

        let cands = [];
        for (const len of lens) for (let dir = 0; dir < 2; dir++) {
          const [dx, dy] = DIRS[dir];
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const ex = x + dx * (len - 1), ey = y + dy * (len - 1);
            if (ex < 0 || ey < 0 || ex >= W || ey >= H) continue;
            const cells = [], crossed = new Set(), areas = new Set();
            let coverCells = 0, sameCells = 0, ok = true;
            const horizontal = dir % 2 === 0;
            for (let k = 0; k < len; k++) {
              const ci = (y + dy * k) * W + (x + dx * k);
              if (occ[ci] || (z.region !== 'all' && regionOf[ci] !== z.region)) { ok = false; break; }
              const above = prevOwner[ci];
              if (above >= 0 && stickInfo[above].cross && stickInfo[above].horizontal === horizontal) { ok = false; break; }
              if (o.noInPlace && deepest[ci] >= 0 && stickInfo[deepest[ci]].horizontal === horizontal) {
                if (z.flags.R) sameCells++; else { ok = false; break; }
              }
              cells.push(ci);
              areas.add(regionOf[ci]);
              if (owner[ci] >= 0) { coverCells++; crossed.add(owner[ci]); }
            }
            if (!ok || (L > 0 && !coverCells) || sameCells === len) continue;
            if (splitsNext && z.count === 1 && areas.size < 2) continue;
            // Short words have far more spots; lenBias (default 1 = ∝ length) keeps them from taking over.
            let w = Math.pow(len, o.lenBias == null ? 1 : o.lenBias);
            if (fanOutNext) w *= len * len;
            if (fanningOut) w /= coverCells * coverCells * coverCells;
            else if (L > 0) w *= crossed.size * crossed.size;
            if (splitsNext && areas.size > 1) w *= 8;
            // Full board: pull words onto cells no layer has touched yet, harder the deeper the layer.
            if (o.fullBoard && L > 0) {
              let fresh = 0;
              for (const ci of cells) if (aboveOwner[ci] < 0) fresh++;
              w *= Math.pow(1 + fresh, 1 + 2 * L / Math.max(1, planLayers.length - 1));
            }
            cands.push({ x, y, dir, len, cells, w, along: z.flags.R ? horizontal : z.orient != null && horizontal === (z.orient === 'h') });
          }
        }
        if (z.flags.H && cands.length) {
          const longest = Math.max(...cands.map(c => c.len));
          cands = cands.filter(c => c.len >= longest - 1);
        }
        if (z.orient || z.flags.R) {
          const share = z.flags.R ? 0.5 : ORIENT_SHARE;
          let sAlong = 0, sAcross = 0;
          for (const c of cands) c.along ? (sAlong += c.w) : (sAcross += c.w);
          if (sAlong && sAcross) for (const c of cands) c.w *= c.along ? share / sAlong : (1 - share) / sAcross;
        }

        let placed = 0;
        while (placed < z.count && cands.length) {
          let total = 0;
          for (const c of cands) total += c.w;
          let r = rnd() * total, c = cands[cands.length - 1];
          for (const cand of cands) { r -= cand.w; if (r <= 0) { c = cand; break; } }
          const word = pickWord(c.len, easyTop);
          if (!word) { cands = cands.filter(x => x !== c); continue; }
          used.add(word); added.push(word);
          if (easyTop) topFirst.add(word[0]);
          const id = nextId++;
          stickInfo[id] = { horizontal: c.dir % 2 === 0, cross: !!z.flags.C };
          c.cells.forEach(ci => { occ[ci] = 1; nextOwner[ci] = id; });
          words.push({ x: c.x, y: c.y, dir: c.dir, word, backwards: !!z.flags.D, forward: !!z.flags.F, knot: !!z.flags.K, layer: L });
          placed++;
          cands = cands.filter(x => !x.cells.some(ci => occ[ci]));
        }
        if (placed < z.count) return fail();
      }
      stickId = nextId;
      layers.push(words);
      nextOwner.forEach((id, ci) => { if (id >= 0 && aboveOwner[ci] < 0) aboveOwner[ci] = id; if (id >= 0) deepest[ci] = id; });
      prevOwner = nextOwner;
      return words;
    };

    const layerTries = o.layerTries == null ? 4 : o.layerTries;
    const last = planLayers.length - 1;
    for (let L = 0; L < planLayers.length; L++) {
      // With fullBoard the last layer must also close every cell still open; it gets more tries, each one
      // rolled back when cells stay empty.
      const mustFill = o.fullBoard && L === last;
      const tries = mustFill ? layerTries * 4 : layerTries;
      let ok = null;
      for (let t = 0; t < tries && !ok; t++) {
        const snap = mustFill ? { above: aboveOwner.slice(), deep: deepest.slice(), prev: prevOwner, stick: stickId } : null;
        ok = placeLayer(L);
        if (ok && mustFill && aboveOwner.includes(-1)) {
          layers.pop();
          ok.forEach(w => { used.delete(w.word); });
          aboveOwner.set(snap.above); deepest.set(snap.deep); prevOwner = snap.prev; stickId = snap.stick;
          ok = null;
        }
      }
      if (!ok) {
        if (o.stats) { const k = mustFill ? 'fill' : `layer${L}`; o.stats[k] = (o.stats[k] || 0) + 1; }
        return null;
      }
    }
    // Reverse a share of the words (right -> left, down -> up). D words are always reversed and count toward the
    // share; F words never are; the rest is drawn from the other words with weight (layer + 1)^reversedBias, so
    // backwards words lean toward the deep layers (found late, when the board has broken up) while still
    // appearing higher up now and then. floor, so the share is never exceeded.
    const all = layers.flat(), forced = all.filter(w => w.backwards), free = all.filter(w => !w.backwards && !w.forward);
    const flips = Math.min(free.length, Math.max(0, Math.floor(o.reversed * all.length + 1e-9) - forced.length));
    const bias = o.reversedBias == null ? 2 : o.reversedBias;
    const chosen = [];
    while (chosen.length < flips && free.length) {
      let total = 0;
      for (const w of free) total += Math.pow(w.layer + 1, bias);
      let r = rnd() * total, pick = free[free.length - 1];
      for (const w of free) { r -= Math.pow(w.layer + 1, bias); if (r <= 0) { pick = w; break; } }
      chosen.push(pick);
      free.splice(free.indexOf(pick), 1);
    }
    chosen.concat(forced).forEach(w => {
      const [dx, dy] = DIRS[w.dir], n = w.word.length - 1;
      w.x += dx * n; w.y += dy * n; w.dir += 2;
    });
    all.forEach(w => { delete w.backwards; delete w.forward; delete w.knot; delete w.layer; });
    return layers;
  }

  // ======================================================================
  // Wave simulation: every linkable word is found at once, wave by wave (the profile view used by the charts).
  // ======================================================================
  function simulate(layers, W, H, bonusDict) {
    const stacks = Array.from({ length: W * H }, () => []);
    const words = [];
    layers.forEach((layer, L) => layer.forEach(w => {
      const [dx, dy] = DIRS[w.dir];
      const id = words.length, cells = [];
      for (let k = 0; k < w.word.length; k++) {
        const ci = (w.y + dy * k) * W + (w.x + dx * k);
        cells.push(ci);
        stacks[ci].push({ letter: w.word[k], layer: L, wordId: id });
      }
      words.push({ id, layer: L, x: w.x, y: w.y, dir: w.dir, word: w.word, cells, found: false, wave: 0 });
    }));
    stacks.forEach(s => s.sort((a, b) => a.layer - b.layer));
    const targetSet = new Set(words.map(w => w.word));
    const atSpot = new Map();
    words.forEach(w => { const k = `${w.x},${w.y},${w.dir}`; atSpot.set(k, (atSpot.get(k) || []).concat(w)); });
    const bonus = new Set();
    const maxRun = Math.max(W, H);
    const isAvailable = w => !w.found && w.cells.every(ci => stacks[ci][0] && stacks[ci][0].wordId === w.id);

    function scan() {
      const visible = new Set();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!stacks[y * W + x].length) continue;
        for (let dir = 0; dir < 4; dir++) {
          const [dx, dy] = DIRS[dir];
          const own = atSpot.get(`${x},${y},${dir}`) || [];
          let s = '';
          for (let k = 0; k < maxRun; k++) {
            const cx = x + dx * k, cy = y + dy * k;
            if (cx < 0 || cy < 0 || cx >= W || cy >= H) break;
            const st = stacks[cy * W + cx];
            if (!st.length) break;
            s += st[0].letter;
            if (s.length < MIN_BONUS_LEN) continue;
            if (targetSet.has(s)) { if (!own.some(w => w.word === s && isAvailable(w))) visible.add(s); }
            else if (bonusDict.has(s)) visible.add(s);
          }
        }
      }
      visible.forEach(v => bonus.add(v));
      return visible;
    }

    const waves = [];
    let remaining = words.length;
    let visibleBonus = scan();
    while (remaining > 0) {
      const avail = words.filter(isAvailable);
      if (!avail.length) break;
      waves.push({ available: avail.length, remaining, bonus: visibleBonus.size });
      for (const w of avail) {
        w.found = true;
        w.wave = waves.length;
        w.cells.forEach(ci => stacks[ci].shift());
        remaining--;
        visibleBonus = scan();
      }
    }
    return { waves, bonus: [...bonus].sort(), stuck: remaining > 0, wordWaves: words.map(w => w.wave) };
  }

  // ======================================================================
  // Sequential play simulation: a player who knows the word list and searches the board for each word.
  // ======================================================================
  // Search-cost model. A word's cost multiplies these; the step cost is the cheapest word's cost over the
  // square root of the number of linkable words, plus a charge for every decoy on the board.
  const DEFAULT_MODEL = {
    dist: 1,          // × (1 + dist × distance in cells from the last find / distScale)
    distScale: 6,
    reversed: 2,      // × for words reading left or up while the board is still crowded...
    revVisHi: 0.6,    // ...i.e. at least this share of cells shows a letter; the × fades to 1 as the board
    revVisLo: 0.2,    // breaks up, and is gone at revVisLo (a few scattered letters spell the word either way)
    crowd: 0.15,      // × (1 + crowd × other visible tiles showing the word's first letter, at most crowdMax)
    crowdMax: 5,
    preVis: 0.6,      // a forward word whose letters were at least this visible before the last find, and that lies
    preVisCells: 2,   // within preVisCells of the player's attention (the last find) or was this visible at the start
    preVisFactor: 0.5, // (the player surveyed the board), costs this much: the player was already waiting for it
    decoy: 0.5,       // + per decoy: a visible run of 3+ letters that starts an unfound word but can't finish it
    nearMiss: 1,      // + extra per decoy that is just one letter short
    knotMul: 2,       // knot: a step costing at least knotMul × the level's median step
    chainMul: 0.85,   // chain: chainMin+ consecutive steps at most chainMul × median, each within chainDist of the previous find
    chainMin: 3,
    chainDist: 2,
  };

  const minCellDist = (a, b, W) => {
    let best = Infinity;
    for (const p of a) for (const q of b) {
      const d = Math.abs(p % W - q % W) + Math.abs(Math.floor(p / W) - Math.floor(q / W));
      if (d < best) best = d;
    }
    return best;
  };

  // -> { steps, bonus, alts, stuck, words }
  //   steps[i]: { wordId, word, layer, cost, wordCost, avail, remaining, bonus, decoys, nearMiss, dist, reversed, crowd, preVis, adjacent, noise }
  //   alts: full spellings of unfound target words somewhere other than their own spot ("WORD@x,y,dir") seen in any state
  function simulatePlay(layers, W, H, dict, model = DEFAULT_MODEL) {
    const stacks = Array.from({ length: W * H }, () => []);
    const words = [];
    layers.forEach((layer, L) => layer.forEach(w => {
      const [dx, dy] = DIRS[w.dir], id = words.length, cells = [];
      for (let k = 0; k < w.word.length; k++) {
        const ci = (w.y + dy * k) * W + (w.x + dx * k);
        cells.push(ci);
        stacks[ci].push({ letter: w.word[k], layer: L, wordId: id });
      }
      const n = w.word.length - 1;
      words.push({ id, layer: L, x: w.x, y: w.y, dir: w.dir, word: w.word, cells, found: false, cx: w.x + dx * n / 2, cy: w.y + dy * n / 2 });
    }));
    stacks.forEach(s => s.sort((a, b) => a.layer - b.layer));
    const byString = new Map(words.map(w => [w.word, w]));
    const byFirst = new Map();
    words.forEach(w => { if (!byFirst.has(w.word[0])) byFirst.set(w.word[0], []); byFirst.get(w.word[0]).push(w); });
    const maxDim = Math.max(W, H);
    const isAvailable = w => !w.found && w.cells.every(ci => stacks[ci][0] && stacks[ci][0].wordId === w.id);
    const bonusAll = new Set(), altAll = new Set();

    // One pass over every straight run of top letters: bonus words visible now, decoys (a run that starts an
    // unfound word but is not that word at its own linkable spot) and full alternative spellings of targets.
    function scan() {
      const bonusNow = new Set(), alts = [];
      let decoys = 0, nearMiss = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!stacks[y * W + x].length) continue;
        for (let dir = 0; dir < 4; dir++) {
          const [dx, dy] = DIRS[dir];
          let s = '';
          for (let k = 0; k < maxDim; k++) {
            const cx = x + dx * k, cy = y + dy * k;
            if (cx < 0 || cy < 0 || cx >= W || cy >= H) break;
            const st = stacks[cy * W + cx];
            if (!st.length) break;
            s += st[0].letter;
          }
          if (s.length < MIN_BONUS_LEN) continue;
          for (let len = MIN_BONUS_LEN; len <= s.length; len++) {
            const sub = s.slice(0, len), t = byString.get(sub);
            if (t) { if (t.found) bonusNow.add(sub); } // a found target spelled again counts as an extra word in the game
            else if (dict.bonus.has(sub)) bonusNow.add(sub);
          }
          let best = 0, bestWord = null;
          for (const t of byFirst.get(s[0]) || []) {
            if (t.found) continue;
            if (t.x === x && t.y === y && t.dir === dir && isAvailable(t)) continue;
            const n = Math.min(s.length, t.word.length);
            let k = 0;
            while (k < n && s[k] === t.word[k]) k++;
            if (k >= MIN_BONUS_LEN && k > best) { best = k; bestWord = t; }
          }
          if (!bestWord) continue;
          if (best === bestWord.word.length) alts.push(`${bestWord.word}@${x},${y},${dir}`);
          else { decoys++; if (best === bestWord.word.length - 1) nearMiss++; }
        }
      }
      return { bonusNow, decoys, nearMiss, alts };
    }

    const visibleShare = t => t.cells.filter(ci => stacks[ci][0] && stacks[ci][0].wordId === t.id).length / t.cells.length;
    const startVis = new Map(words.map(t => [t.id, visibleShare(t)]));
    const steps = [];
    let attention = [(W - 1) / 2, (H - 1) / 2], prevVis = null, prevWord = null, remaining = words.length;
    while (remaining > 0) {
      const avail = words.filter(isAvailable);
      if (!avail.length) break;
      const { bonusNow, decoys, nearMiss, alts } = scan();
      bonusNow.forEach(b => bonusAll.add(b));
      alts.forEach(a => altAll.add(a));
      const availIds = new Set(avail.map(w => w.id));
      const topCount = new Map();
      let visible = 0, noiseCells = 0;
      for (const st of stacks) {
        if (!st.length) continue;
        visible++;
        topCount.set(st[0].letter, (topCount.get(st[0].letter) || 0) + 1);
        if (!availIds.has(st[0].wordId)) noiseCells++;
      }
      // Reading backwards costs extra on a crowded board; once most cells are gone the few letters left spell
      // the word either way.
      const hi = model.revVisHi == null ? 0 : model.revVisHi, lo = model.revVisLo == null ? 0 : model.revVisLo;
      const crowded = hi > lo ? Math.min(1, Math.max(0, (visible / (W * H) - lo) / (hi - lo))) : 1;
      const revMul = 1 + (model.reversed - 1) * crowded;
      let best = null;
      for (const w of avail) {
        const cells = Math.hypot(w.cx - attention[0], w.cy - attention[1]);
        const dist = cells / (model.distScale || maxDim);
        const crowd = Math.min(model.crowdMax == null ? Infinity : model.crowdMax, (topCount.get(w.word[0]) || 1) - 1);
        // Visibility before the last find; at the first step the start survey counts.
        const vis = prevVis ? (prevVis.get(w.id) || 0) : startVis.get(w.id);
        const near = cells <= (model.preVisCells == null ? Infinity : model.preVisCells) || startVis.get(w.id) >= model.preVis;
        let c = (1 + model.dist * dist) * (w.dir >= 2 ? revMul : 1) * (1 + model.crowd * crowd);
        if (vis >= model.preVis && w.dir < 2 && near) c *= model.preVisFactor;
        if (!best || c < best.c) best = { w, c, dist, crowd, vis };
      }
      const w = best.w;
      steps.push({
        wordId: w.id, word: w.word, layer: w.layer,
        cost: best.c / Math.sqrt(avail.length) + model.decoy * decoys + model.nearMiss * nearMiss,
        wordCost: best.c, avail: avail.length, remaining, bonus: bonusNow.size, decoys, nearMiss, alts: alts.length,
        dist: best.dist, reversed: w.dir >= 2, crowd: best.crowd, preVis: best.vis,
        adjacent: prevWord ? minCellDist(prevWord.cells, w.cells, W) <= (model.chainDist == null ? 1 : model.chainDist) : false,
        noise: visible ? noiseCells / visible : 0, visible,
      });
      prevVis = new Map();
      for (const t of words) if (!t.found) prevVis.set(t.id, t.cells.filter(ci => stacks[ci][0] && stacks[ci][0].wordId === t.id).length / t.cells.length);
      w.found = true;
      w.cells.forEach(ci => stacks[ci].shift());
      remaining--;
      attention = [w.cx, w.cy];
      prevWord = w;
    }
    return { steps, bonus: [...bonusAll].sort(), alts: [...altAll], stuck: remaining > 0, words };
  }

  // Highest share of bonus words among linkable words (bonus + available targets) at any step, 0..100.
  const peakBonusOf = play => play.steps.length ? Math.max(...play.steps.map(s => 100 * s.bonus / (s.bonus + s.avail))) : 0;

  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  function corr(a, b) {
    const n = a.length;
    if (n < 3) return 0;
    const ma = mean(a), mb = mean(b);
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }

  // Tempo and pattern metrics of a play simulation.
  function analyzePlay(play, layers, W, H, model = DEFAULT_MODEL) {
    const steps = play.steps, n = steps.length;
    const costs = steps.map(s => s.cost);
    const sorted = costs.slice().sort((a, b) => a - b);
    const median = n ? (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2 : 0;
    const knotThr = model.knotMul * median, chainThr = model.chainMul * median;
    const knots = [];
    steps.forEach((s, i) => { if (median > 0 && s.cost >= knotThr) knots.push(i); });
    // Consecutive knot steps are one knot (the player is stuck once, for a while).
    const knotGroups = [];
    knots.forEach(i => { const g = knotGroups[knotGroups.length - 1]; if (g && i === g.end + 1) g.end = i; else knotGroups.push({ start: i, end: i }); });
    // runs: every stretch of 2+ cheap steps that follow each other on the board; chains: the ones of chainMin+ steps.
    const runs = [];
    for (let i = 0; i < n;) {
      if (steps[i].cost > chainThr) { i++; continue; }
      let j = i + 1;
      while (j < n && steps[j].cost <= chainThr && steps[j].adjacent) j++;
      if (j - i >= 2) runs.push({ start: i, len: j - i });
      i = j;
    }
    const chains = runs.filter(r => r.len >= model.chainMin);
    const all = layers.flat();
    const cx = steps.map(s => play.words[s.wordId].cx), cy = steps.map(s => play.words[s.wordId].cy), idx = steps.map((_, i) => i);
    let minX = W, maxX = -1, minY = H, maxY = -1;
    (layers[0] || []).forEach(w => {
      const [dx, dy] = DIRS[w.dir], n = w.word.length - 1;
      for (const [x, y] of [[w.x, w.y], [w.x + dx * n, w.y + dy * n]]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    });
    const horizontal = all.filter(w => w.dir % 2 === 0).length;
    // Where in the solve the backwards words fall (0 = first step, 1 = last), and how many cells no layer fills.
    const revPos = steps.map((s, i) => (s.reversed ? (n > 1 ? i / (n - 1) : 0) : null)).filter(p => p != null);
    const filled = new Uint8Array(W * H);
    all.forEach(w => { const [dx, dy] = DIRS[w.dir]; for (let k = 0; k < w.word.length; k++) filled[(w.y + dy * k) * W + (w.x + dx * k)] = 1; });
    let emptyCells = 0;
    filled.forEach(f => { if (!f) emptyCells++; });
    const knotSet = new Set(knots);
    const easySteps = steps.filter((_, i) => !knotSet.has(i)), knotSteps = steps.filter((_, i) => knotSet.has(i));
    const maxOf = (arr, k) => arr.length ? Math.max(...arr.map(s => s[k])) : 0;
    return {
      median, knots, knotGroups, knotCount: knotGroups.length,
      knotSingle: knotGroups.filter(g => steps.slice(g.start, g.end + 1).some(s => s.avail === 1)).length,
      knotPos: knotGroups.map(g => (n > 1 ? g.start / (n - 1) : 0)),
      runs, chains, longestChain: chains.length ? Math.max(...chains.map(c => c.len)) : 0,
      opening: median ? mean(costs.slice(0, Math.min(3, n))) / median : 0,
      ending: median ? mean(costs.slice(-Math.min(2, n))) / median : 0,
      maxDecoys: maxOf(steps, 'decoys'), maxNearMiss: maxOf(steps, 'nearMiss'),
      easyMaxDecoys: maxOf(easySteps, 'decoys'), easyMaxNearMiss: maxOf(easySteps, 'nearMiss'),
      knotMaxDecoys: maxOf(knotSteps, 'decoys'), knotMaxNearMiss: maxOf(knotSteps, 'nearMiss'),
      totalDecoys: steps.reduce((s, x) => s + x.decoys, 0), totalNearMiss: steps.reduce((s, x) => s + x.nearMiss, 0),
      startNoise: n ? steps[0].noise : 0,
      sweep: Math.max(Math.abs(corr(idx, cx)), Math.abs(corr(idx, cy))),
      topSpread: maxX >= 0 ? ((maxX - minX + 1) * (maxY - minY + 1)) / (W * H) : 0,
      hvBalance: all.length ? Math.abs(2 * horizontal - all.length) / all.length : 0,
      reversedShare: all.length ? all.filter(w => w.dir >= 2).length / all.length : 0,
      revCount: revPos.length, revCenter: revPos.length ? mean(revPos) : null,
      emptyCells,
      threeLetter: all.filter(w => w.word.length === 3).length,
    };
  }

  // ======================================================================
  // Word-swap optimizer: positions stay (so the geometry and the wave profile are unchanged); only the letters
  // change. Each try swaps one word for an unused word of the same length and keeps it when the cost goes down:
  //   1000 × alternative spellings + bonus words + peak bonus % / 20 + reuse penalty
  //   + decoyWeight × decoys at non-knot steps (near misses twice)
  //   + extra4Weight × independent 4+ letter extras + extra3Weight × 3-letter extras (any solve order) + extra(analysis)
  // usage: Map(word -> uses in the levels kept so far). Every earlier use counts as `penalty` extra bonus words;
  // with opts.forbidReuse any used word is skipped entirely. opts.easyTop keeps the top layer on easy words with
  // distinct first letters. opts.extra(result) adds a penalty from the tempo analysis (used by the funnel to steer
  // the letters toward the stage's knot/chain targets). Returns the final play simulation plus `swapped`, `accepted`.
  // ======================================================================
  function optimizeWords(dict, layers, W, H, swaps, seed, usage = new Map(), penalty = 0, opts = {}) {
    const model = opts.model || DEFAULT_MODEL, decoyW = opts.decoyWeight == null ? 2 : opts.decoyWeight;
    const ex4W = opts.extra4Weight == null ? 1.5 : opts.extra4Weight, ex3W = opts.extra3Weight == null ? 0.3 : opts.extra3Weight;
    const rnd = mulberry32(seed ^ 0x5bd1e995);
    const sticks = layers.flatMap((layer, L) => layer.map(w => ({ w, L })));
    const used = new Set(sticks.map(s => s.w.word));
    const original = new Set(used);
    const usesOf = w => usage.get(w) || 0;
    const costOf = (play, reuse) => {
      const a = analyzePlay(play, layers, W, H, model);
      const knotSet = new Set(a.knots);
      const easyDecoys = play.steps.reduce((s, x, i) => s + (knotSet.has(i) ? 0 : x.decoys + 2 * x.nearMiss), 0);
      const ex = extrasOf(layers, W, H, dict);
      const counts = { extraRoot: ex.root.length, extra4: ex.four.length, extra3: ex.three.length };
      return 1000 * play.alts.length + play.bonus.length + peakBonusOf(play) / 20 + penalty * reuse + decoyW * easyDecoys
        + ex4W * counts.extra4 + ex3W * counts.extra3
        + (opts.extra ? opts.extra({ ...a, ...counts, bonusCount: play.bonus.length, alts: play.alts, steps: play.steps }) : 0);
    };
    const better = (a, b) => a < b - 1e-9;
    let accepted = 0;
    let reuse = sticks.reduce((s, x) => s + usesOf(x.w.word), 0);
    let play = simulatePlay(layers, W, H, dict, model);
    let best = costOf(play, reuse);
    for (let t = 0; t < swaps; t++) {
      const { w: stick, L } = sticks[Math.floor(rnd() * sticks.length)];
      const easyTop = opts.easyTop && L === 0;
      const easyList = easyTop ? dict.easy.get(stick.word.length) : null;
      const list = easyList && easyList.length >= EASY_POOL_MIN ? easyList : dict.pool.get(stick.word.length);
      const word = list[Math.floor(rnd() * list.length)];
      if (used.has(word) || (opts.forbidReuse && usesOf(word))) continue;
      if (easyTop && layers[0].some(x => x !== stick && x.word[0] === word[0])) continue;
      const old = stick.word;
      stick.word = word;
      const next = simulatePlay(layers, W, H, dict, model);
      const nextReuse = reuse - usesOf(old) + usesOf(word);
      const score = costOf(next, nextReuse);
      if (!next.stuck && better(score, best)) {
        used.delete(old); used.add(word);
        play = next; best = score; reuse = nextReuse; accepted++;
      } else stick.word = old;
    }
    return { ...play, swapped: sticks.map(s => s.w.word).filter(w => !original.has(w)), accepted };
  }

  // ======================================================================
  // Structural checks
  // ======================================================================
  // True when some word sits directly under a word running the same way, so solving the upper one reveals the
  // lower one in its place. Partial same-way overlaps are allowed on R layers.
  function hasInPlaceReveal(layers, plan, W, H) {
    const below = new Array(W * H).fill(null);
    return layers.some((layer, L) => {
      const placed = layer.map(w => {
        const [dx, dy] = DIRS[w.dir], horizontal = w.dir % 2 === 0;
        const cells = [];
        let same = 0;
        for (let k = 0; k < w.word.length; k++) {
          const ci = (w.y + dy * k) * W + (w.x + dx * k);
          cells.push(ci);
          if (below[ci] && below[ci].horizontal === horizontal) same++;
        }
        const zs = plan.layers[L].zones;
        const z = zs.find(z => z.region === 'all' || z.region === plan.regionOf[cells[0]]);
        return { cells, horizontal, bad: same > 0 && !(z && z.flags.R && same < cells.length) };
      });
      placed.forEach(p => p.cells.forEach(ci => { below[ci] = p; }));
      return placed.some(p => p.bad);
    });
  }

  // True when some R zone with two or more words has them all horizontal or all vertical.
  function lacksRMix(layers, plan, W) {
    return layers.some((layer, L) => plan.layers[L].zones.some(z => {
      if (!z.flags.R || z.count < 2) return false;
      const dirs = new Set(layer
        .filter(w => z.region === 'all' || plan.regionOf[w.y * W + w.x] === z.region)
        .map(w => w.dir % 2));
      return dirs.size < 2;
    }));
  }

  // True when some cell has no letter on any layer (an empty cell in the top view).
  function hasEmptyCell(layers, W, H) {
    const filled = new Uint8Array(W * H);
    layers.forEach(layer => layer.forEach(w => {
      const [dx, dy] = DIRS[w.dir];
      for (let k = 0; k < w.word.length; k++) filled[(w.y + dy * k) * W + (w.x + dx * k)] = 1;
    }));
    return filled.includes(0);
  }

  // ======================================================================
  // One level, start to finish: place, filter, optimize, simulate, measure.
  // o: { W, H, minLen, maxLen, cover, plan, profile, reversed, swaps, reusePenalty, maxBonus, noInPlace, rMix,
  //      fullBoard, easyTop, forbidReuse, model }
  // -> { reject: 'noRoom' | 'inPlace' | 'noMix' | 'notFull' | 'bonus' } or a result record.
  // ======================================================================
  function runLevel(dict, o, seed, usage = new Map()) {
    const model = o.model || DEFAULT_MODEL;
    const layers = generateLevel(dict, o, seed, o.forbidReuse ? usage : null);
    if (!layers) return { reject: 'noRoom' };
    if (o.noInPlace && hasInPlaceReveal(layers, o.plan, o.W, o.H)) return { reject: 'inPlace' };
    if (o.rMix && lacksRMix(layers, o.plan, o.W)) return { reject: 'noMix' };
    if (o.fullBoard && hasEmptyCell(layers, o.W, o.H)) return { reject: 'notFull' };
    const play = o.swaps
      ? optimizeWords(dict, layers, o.W, o.H, o.swaps, seed, usage, o.reusePenalty, { model, forbidReuse: o.forbidReuse, easyTop: o.easyTop, extra: o.extra })
      : simulatePlay(layers, o.W, o.H, dict, model);
    if (play.stuck) return { reject: 'noRoom' };
    const peakBonus = peakBonusOf(play);
    if (o.maxBonus != null && peakBonus > o.maxBonus) return { reject: 'bonus' };
    const sim = simulate(layers, o.W, o.H, dict.bonus);
    // `bonus` = extras the two simulated solve orders meet (what the tempo metrics count); `validWords` = every
    // extra any solve order can reveal (what the level ships with, since the game only accepts listed extras).
    const bonus = [...new Set([...play.bonus, ...sim.bonus])].sort();
    const ex = extrasOf(layers, o.W, o.H, dict), validWords = ex.validWords;
    const targets = layers.reduce((n, l) => n + l.length, 0);
    const letters = layers.reduce((n, l) => n + l.reduce((m, w) => m + w.word.length, 0), 0);
    return {
      seed, layers, o,
      waves: sim.waves.length, perWave: sim.waves, wordWaves: sim.wordWaves,
      match: sim.waves.length === o.profile.length && sim.waves.every((w, k) => w.available === o.profile[k]),
      steps: play.steps, alts: play.alts, swapped: play.swapped || [], accepted: play.accepted || 0,
      bonus, bonusCount: bonus.length, ratio: bonus.length / targets, peakBonus, targets, letters, validWords,
      extraRootWords: ex.root, extra4Words: ex.four, extra3Words: ex.three,
      extraRoot: ex.root.length, extra4: ex.four.length, extra3: ex.three.length,
      ...analyzePlay(play, layers, o.W, o.H, model),
    };
  }

  // Reuse of target words across the kept levels of a batch.
  function reuseStats(levels, dict, config) {
    const group = words => {
      const counts = new Map();
      words.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
      const c = [...counts.values()].sort((a, b) => a - b), n = words.length, d = c.length;
      const at = p => d ? c[Math.min(d - 1, Math.floor(p * d))] : 0;
      return {
        placements: n, distinct: d, mean: d ? n / d : 0,
        median: d ? (c[(d - 1) >> 1] + c[d >> 1]) / 2 : 0, p90: at(0.9), max: d ? c[d - 1] : 0,
        once: d ? c.filter(x => x === 1).length / d : 0,
        top10Share: n ? c.slice(-10).reduce((s, x) => s + x, 0) / n : 0,
        counts,
      };
    };
    const allWords = levels.flatMap(r => r.layers.flat().map(w => w.word));
    const swappedWords = levels.flatMap(r => r.swapped || []);
    const all = group(allWords), swapped = group(swappedWords);
    const byLen = [...new Set(allWords.map(w => w.length))].sort((a, b) => a - b).map(len => {
      const g = group(allWords.filter(w => w.length === len));
      return { len, pool: (dict.pool.get(len) || []).length, distinct: g.distinct, placements: g.placements, mean: g.mean, max: g.max };
    });
    const top = [...all.counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 25)
      .map(([w, n]) => [w, n, swapped.counts.get(w) || 0]);
    delete all.counts; delete swapped.counts;
    return {
      config, levels: levels.length,
      acceptedPerLevel: levels.length ? levels.reduce((s, r) => s + (r.accepted || 0), 0) / levels.length : 0,
      swappedShare: all.placements ? swapped.placements / all.placements : 0,
      all, swapped, byLen, top,
    };
  }

  // ======================================================================
  // Funnel: level ranges with their own board, word counts, tempo targets and tolerances.
  // ======================================================================
  // Stage fields:
  //   from, to              level numbers covered (inclusive)
  //   W, H, minLen, maxLen  board and word lengths
  //   profile               fixed profile string (optional; otherwise one is drawn per attempt from the fields below)
  //   words [min,max], layers [min,max], top (min words on the top layer)
  //   knots [min,max]       knot steps wanted (per the tempo model); knotSingleMax: knots with a single linkable word
  //   reversed              max share of words reading left/up (never exceeded; each level draws 40..100 % of it)
  //   decoy { easy, easyNearMiss, knot, knotNearMiss }  max decoys / near misses visible at easy steps and knot steps
  //   maxBonus              max extra words met by the simulated solves; maxThreeLetter: max 3-letter target words
  //   maxExtra4, maxExtra3  max extras any solve order can reveal: independent 4+ letter ones (firm) and
  //                         3-letter ones (soft); stems/extensions of a target are never counted
  //   loose                 chance for a layer below the second to get the L flag (lies under any layer above)
  //   looseKnot             chance for a knot layer to get L, so its word can sit far from the last find (default: loose)
  //   opening, ending       max mean step cost of the first 3 / last 2 steps, as a multiple of the median (defaults 1 / 1.2)
  //   maxStartNoise         max share of visible letters at the start that belong to words not linkable yet
  //   hardEnding            chance for a level to end on a slightly hard step instead of an easy one
  //   noInPlace             reject words lying directly under a same-way word
  const DEFAULT_STAGES = [
    { from: 1, to: 1, W: 3, H: 3, minLen: 3, maxLen: 3, profile: '3(F,C),3(F)', reversed: 0, knots: [0, 0], knotSingleMax: 0,
      decoy: { easy: 0, easyNearMiss: 0, knot: 0, knotNearMiss: 0 }, maxExtra4: 1, maxExtra3: 4, maxThreeLetter: 6, opening: 1.3, ending: 1.3 },
    { from: 2, to: 5, W: 4, H: 4, minLen: 3, maxLen: 4, words: [6, 8], layers: [2, 3], top: 3, reversed: 0, knots: [0, 0], knotSingleMax: 0,
      decoy: { easy: 0, easyNearMiss: 0, knot: 0, knotNearMiss: 0 }, maxExtra4: 2, maxExtra3: 8, maxThreeLetter: 5, maxStartNoise: 0.35, opening: 1.2, ending: 1.3, loose: 0, hardEnding: 0 },
    { from: 6, to: 15, W: 5, H: 5, minLen: 3, maxLen: 5, words: [8, 11], layers: [3, 4], top: 3, reversed: 0.15, knots: [1, 1], knotSingleMax: 1,
      decoy: { easy: 1, easyNearMiss: 0, knot: 3, knotNearMiss: 1 }, maxExtra4: 4, maxExtra3: 14, maxThreeLetter: 4, maxStartNoise: 0.5, loose: 0, looseKnot: 0.5, hardEnding: 0.2, noInPlace: true, chainAfterKnot: 2 },
    { from: 16, to: 30, W: 6, H: 6, minLen: 3, maxLen: 6, words: [11, 15], layers: [4, 6], top: 4, reversed: 0.3, knots: [1, 1], knotSingleMax: 1,
      decoy: { easy: 1, easyNearMiss: 0, knot: 3, knotNearMiss: 1 }, maxExtra4: 6, maxExtra3: 20, maxThreeLetter: 3, maxStartNoise: 0.6, loose: 0.25, looseKnot: 0.6, hardEnding: 0.2, noInPlace: true, chainAfterKnot: 2, lenBias: 3 },
    { from: 31, to: 50, W: 7, H: 7, minLen: 3, maxLen: 7, words: [15, 20], layers: [5, 7], top: 4, reversed: 0.3, knots: [1, 2], knotSingleMax: 2,
      decoy: { easy: 2, easyNearMiss: 0, knot: 4, knotNearMiss: 1 }, maxExtra4: 8, maxExtra3: 26, maxThreeLetter: 3, maxStartNoise: 0.6, loose: 0.3, looseKnot: 0.6, hardEnding: 0.2, noInPlace: true, chainAfterKnot: 3, lenBias: 3 },
  ];

  // Variety set: the 3×3 intro, then three level types that always come in this order (few / medium / many
  // words, about 10 / 15 / 20) on full rectangular boards 5×5, 5×7, 6×6 and 6×7. A tier gives `wordsBySize`
  // (word range per board size, clamped to the stage's minWords..maxWords) or `density` (words per cell)
  // instead of a fixed `words` range and `bonusPerWord` instead of `maxBonus`, so one tier fits every board.
  // Extra stage fields: fullBoard (every cell gets a letter), reversedBias (backwards words lean toward deep
  // layers; 0 = anywhere, 2 = quadratic), reversedCenter (min mean position of backwards words in the solve),
  // knotReversed (chance a knot layer is forced backwards), tierBase (level that gets the first tier).
  const VARIETY_TIERS = [
    { name: 'few', wordsBySize: { '5x5': [10, 10], '5x7': [11, 12], '6x6': [11, 12], '6x7': [12, 13] }, layers: [3, 4], top: 3, knots: [0, 1], knotSingleMax: 1,
      decoy: { easy: 2, easyNearMiss: 0, knot: 3, knotNearMiss: 1 }, maxExtra4: 4, maxExtra3: 16, maxThreeLetter: 3, chainAfterKnot: 2, loose: 0, looseKnot: 0.5 },
    { name: 'medium', wordsBySize: { '5x5': [13, 15], '5x7': [14, 16], '6x6': [14, 16], '6x7': [15, 18] }, layers: [4, 6], top: 3, knots: [1, 2], knotSingleMax: 1,
      decoy: { easy: 2, easyNearMiss: 0, knot: 4, knotNearMiss: 1 }, maxExtra4: 6, maxExtra3: 22, maxThreeLetter: 4, chainAfterKnot: 2, loose: 0.2, looseKnot: 0.6 },
    // "many" stays around 20: past ~2.5 letters per cell the reachable extras explode (every 3-cell line has 27 spellings)
    { name: 'many', wordsBySize: { '5x5': [16, 17], '5x7': [17, 19], '6x6': [18, 20], '6x7': [19, 21] }, layers: [6, 8], top: 4, knots: [1, 3], knotSingleMax: 2,
      decoy: { easy: 2, easyNearMiss: 0, knot: 4, knotNearMiss: 1 }, maxExtra4: 10, maxExtra3: 32, maxThreeLetter: 6, chainAfterKnot: 3, loose: 0.3, looseKnot: 0.6, lenBias: 4 },
  ];
  // ending 1.5: the last words are often the backwards ones, read off a broken-up board.
  const VARIETY_COMMON = { minLen: 3, minWords: 10, maxWords: 30, fullBoard: true, reversedBias: 2, reversedCenter: 0.6, knotReversed: 0.15,
    ending: 1.5, hardEnding: 0.2, noInPlace: true, tierBase: 2, tiers: VARIETY_TIERS };
  const VARIETY_STAGES = [
    DEFAULT_STAGES[0], // the 3×3 intro: 3 across + 3 down, all forward, two layers
    { from: 2, to: 7, sizes: [[5, 5]], reversed: 0.15, maxStartNoise: 0.5, lenBias: 2, ...VARIETY_COMMON },
    { from: 8, to: 16, sizes: [[5, 5], [5, 7]], reversed: 0.25, maxStartNoise: 0.55, lenBias: 2, ...VARIETY_COMMON },
    { from: 17, to: 28, sizes: [[5, 7], [6, 6]], reversed: 0.3, maxStartNoise: 0.6, lenBias: 3, ...VARIETY_COMMON },
    // every size stays in play late on (a small "few" board is a breather); 6×7 listed twice so it shows up as often as the rest
    { from: 29, to: 50, sizes: [[5, 5], [5, 7], [6, 6], [6, 7], [6, 7]], reversed: 0.3, maxStartNoise: 0.6, lenBias: 3, ...VARIETY_COMMON },
  ];
  const STAGE_PRESETS = { funnel: DEFAULT_STAGES, variety: VARIETY_STAGES };

  const stageFor = (stages, levelNo) => stages.find(s => levelNo >= s.from && levelNo <= s.to) || null;

  // Resolves a stage for one level: a stage with `sizes` draws one [W, H] per level (seeded), a stage with
  // `tiers` cycles through them in order (level tierBase → tier 0, the next → tier 1, ...), the tier's fields
  // overriding the stage's. `wordsBySize` / `density` become `words` (clamped to minWords..maxWords),
  // `bonusPerWord` becomes `maxBonus`, and `maxLen` defaults to the longer side. Plain stages come back unchanged.
  function concreteStage(stage, levelNo, baseSeed) {
    if (!stage || (!stage.sizes && !stage.tiers)) return stage;
    const rnd = mulberry32(levelSeed(baseSeed, levelNo * 7919 + 17));
    const tiers = Array.isArray(stage.tiers) && stage.tiers.length ? stage.tiers : null;
    const base = stage.tierBase == null ? 1 : stage.tierBase;
    const tier = tiers ? tiers[(((levelNo - base) % tiers.length) + tiers.length) % tiers.length] : {};
    const s = { ...stage, ...tier };
    delete s.sizes; delete s.tiers; delete s.name;
    if (tier.name) s.tier = tier.name;
    if (Array.isArray(stage.sizes) && stage.sizes.length) [s.W, s.H] = stage.sizes[Math.floor(rnd() * stage.sizes.length)];
    const area = s.W * s.H;
    if (!s.words && s.wordsBySize) s.words = s.wordsBySize[`${s.W}x${s.H}`] || s.wordsBySize[`${s.H}x${s.W}`] || null;
    if (!s.words && s.density) s.words = [Math.round(s.density[0] * area), Math.round(s.density[1] * area)];
    if (s.words) {
      const lo = s.minWords == null ? 2 : s.minWords, hi = s.maxWords == null ? Infinity : s.maxWords;
      s.words = [Math.min(hi, Math.max(lo, s.words[0])), Math.min(hi, Math.max(lo, s.words[1]))];
    }
    if (s.maxBonus == null && s.bonusPerWord != null && s.words) s.maxBonus = Math.round(s.bonusPerWord * s.words[1]);
    if (s.maxLen == null) s.maxLen = Math.max(s.W, s.H);
    if (s.minLen == null) s.minLen = 3;
    return s;
  }

  // Draws a profile string for a stage: top layer with F, knot layers of 1-2 words placed in the middle of the
  // solve (some with D when the reversed cap allows), the rest spread over the other layers with a push toward
  // the layer right after a knot (so the knot opens into a chain). Avoids signatures already used in the funnel.
  function randomProfile(stage, rnd, usedSigs = new Set()) {
    if (stage.profile) return stage.profile;
    const randInt = ([lo, hi]) => lo + Math.floor(rnd() * (hi - lo + 1));
    for (let attempt = 0; attempt < 60; attempt++) {
      const N = randInt(stage.words), K = randInt(stage.layers);
      if (K < 2) continue;
      const knotCount = randInt(stage.knots || [0, 0]);
      const spots = [];
      for (let l = 1; l < K - 1; l++) if (l / (K - 1) >= 0.25 && l / (K - 1) <= 0.85) spots.push(l);
      if (knotCount > spots.length) continue;
      const knotLayers = new Set();
      while (knotLayers.size < knotCount) knotLayers.add(spots[Math.floor(rnd() * spots.length)]);
      const counts = new Array(K).fill(2), flags = Array.from({ length: K }, () => []);
      counts[0] = Math.max(stage.top || 2, 2);
      flags[0].push('F');
      let singles = 0;
      for (const l of knotLayers) {
        const single = singles < (stage.knotSingleMax || 0) && rnd() < 0.4;
        counts[l] = single ? 1 : 2;
        if (single) singles++;
      }
      let rest = N - counts.reduce((s, x) => s + x, 0);
      if (rest < 0) continue;
      const open = [];
      for (let l = 0; l < K; l++) if (!knotLayers.has(l)) open.push(l);
      while (rest > 0) {
        const weights = open.map(l => (knotLayers.has(l - 1) ? 3 : 1));
        let r = rnd() * weights.reduce((s, x) => s + x, 0), l = open[open.length - 1];
        for (let i = 0; i < open.length; i++) { r -= weights[i]; if (r <= 0) { l = open[i]; break; } }
        counts[l]++; rest--;
      }
      const knotWords = [...knotLayers].reduce((s, l) => s + counts[l], 0);
      knotLayers.forEach(l => { flags[l].push('K'); if (l + 1 < K && !knotLayers.has(l + 1)) flags[l + 1].push('F'); }); // the layer a knot opens into reads forward
      const knotRev = stage.knotReversed == null ? 0.5 : stage.knotReversed;
      if (knotWords && knotWords <= Math.floor((stage.reversed || 0) * N + 1e-9) && rnd() < knotRev) knotLayers.forEach(l => flags[l].push('D'));
      const looseKnot = stage.looseKnot == null ? (stage.loose || 0) : stage.looseKnot;
      for (let l = 2; l < K; l++) if (rnd() < (knotLayers.has(l) ? looseKnot : (stage.loose || 0))) flags[l].push('L');
      const sig = counts.join(',');
      if (usedSigs.has(sig) && attempt < 45) continue;
      return counts.map((c, l) => c + (flags[l].length ? `(${flags[l].join(',')})` : '')).join(',');
    }
    return null;
  }

  // Every way a result misses the stage's targets: [reason, weight]. Weight 0 = pass on that point; the
  // weights are in "bonus words" so the optimizer can trade them against extras and decoys.
  function stageMisses(r, stage, variant = {}, model = DEFAULT_MODEL) {
    const m = [];
    const want = stage.knots || [0, 0], k = r.knotCount;
    const openThr = stage.opening != null ? stage.opening : (want[0] >= 1 ? 0.9 : 1.0);
    const endThr = stage.ending != null ? stage.ending : 1.2;
    const d = stage.decoy || { easy: Infinity, easyNearMiss: Infinity, knot: Infinity, knotNearMiss: Infinity };
    m.push(['alt spelling', 1000 * r.alts.length]);
    m.push(['reversed share', r.reversedShare > (stage.reversed || 0) + 1e-9 ? 1000 : 0]);
    // Backwards words should pile up late in the solve, when the board has broken into scattered letters.
    m.push(['reversed early', stage.reversedCenter != null && r.revCount >= 2 ? 8 * Math.max(0, stage.reversedCenter - r.revCenter) : 0]);
    m.push(['empty cells', stage.fullBoard ? 5 * r.emptyCells : 0]);
    m.push([`knots ${k}`, 4 * (Math.max(0, want[0] - k) + Math.max(0, k - want[1]))]);
    m.push(['single-open knot', 4 * Math.max(0, r.knotSingle - (stage.knotSingleMax || 0))]);
    m.push(['knot position', 3 * r.knotPos.filter(p => p < 0.25 || p > 0.85).length]);
    m.push(['knot in opening', 3 * r.knotGroups.filter(g => g.start < 3).length]);
    m.push(['opening', 4 * Math.max(0, r.opening - openThr)]);
    if (variant.hardEnding) m.push(['ending (hard)', 4 * (Math.max(0, 1 - r.ending) + Math.max(0, r.ending - model.knotMul + 0.05))]);
    else m.push(['ending', 4 * Math.max(0, r.ending - endThr)]);
    m.push(['decoys', 2 * (Math.max(0, r.easyMaxDecoys - d.easy) + 2 * Math.max(0, r.easyMaxNearMiss - d.easyNearMiss))]);
    m.push(['knot decoys', 2 * (Math.max(0, r.knotMaxDecoys - d.knot) + 2 * Math.max(0, r.knotMaxNearMiss - d.knotNearMiss))]);
    m.push(['bonus', stage.maxBonus != null ? Math.max(0, r.bonusCount - stage.maxBonus) : 0]);
    // Extras any solve order can reveal: independent 4+ letter ones are capped firmly, 3-letter ones softly.
    m.push(['extras 4+', stage.maxExtra4 != null ? 2 * Math.max(0, r.extra4 - stage.maxExtra4) : 0]);
    m.push(['extras 3', stage.maxExtra3 != null ? 0.5 * Math.max(0, r.extra3 - stage.maxExtra3) : 0]);
    m.push(['3-letter words', stage.maxThreeLetter != null ? 3 * Math.max(0, r.threeLetter - stage.maxThreeLetter) : 0]);
    m.push(['start noise', stage.maxStartNoise != null ? 10 * Math.max(0, r.startNoise - stage.maxStartNoise) : 0]);
    // A chain is expected after the first knot when enough steps remain for one; a late knot just needs the easy ending.
    const chainAfter = stage.chainAfterKnot == null ? model.chainMin : stage.chainAfterKnot;
    const room = k ? r.steps.length - 1 - r.knotGroups[0].end : 0;
    m.push(['no chain after knot', want[0] >= 1 && k && chainAfter > 0 && room > chainAfter && !r.runs.some(c => c.start > r.knotGroups[0].end && c.len >= chainAfter) ? 3 : 0]);
    m.push(['sweep', 5 * Math.max(0, r.sweep - 0.6)]);
    m.push(['top spread', r.o && r.o.W * r.o.H >= 25 ? 5 * Math.max(0, 0.5 - r.topSpread) : 0]);
    return m.filter(x => x[1] > 1e-9);
  }
  // Reasons a result misses the stage's targets (empty = pass).
  const checkStage = (r, stage, variant, model) => stageMisses(r, stage, variant, model).map(x => x[0]);
  // Weighted sum of the misses; what the optimizer minimizes on top of extras and decoys.
  const stagePenalty = (r, stage, variant, model) => stageMisses(r, stage, variant, model).reduce((s, x) => s + x[1], 0);
  // Lower is better among passing candidates.
  const stageScore = r => r.extra4 + 0.3 * r.extra3 + 0.5 * r.totalDecoys + 2 * r.totalNearMiss - r.longestChain;

  // One funnel level: tries seeds until `candidates` pass the stage (or `tries` run out), keeps the best, falls
  // back to the attempt with the fewest misses. Updates usage (word -> uses) and usedSigs (profile strings).
  // settings: { lang, model, swaps, reusePenalty, tries, candidates }
  // Generator form: yields { attempts, passed } after every attempt so a UI can breathe; returns the summary.
  function* funnelLevelGen(dict, rawStage, levelNo, baseSeed, usage, usedSigs, settings) {
    const stage = concreteStage(rawStage, levelNo, baseSeed);
    const model = settings.model || DEFAULT_MODEL;
    const tries = settings.tries || 300, want = settings.candidates || 4;
    const passing = [], rejects = {};
    const note = k => { rejects[k] = (rejects[k] || 0) + 1; };
    let fallback = null, attempts = 0;
    for (let a = 0; a < tries && passing.length < want; a++) {
      attempts++;
      if (a) yield { attempts, passed: passing.length };
      const seed = levelSeed(baseSeed, levelNo * 4096 + a);
      const rnd = mulberry32(seed ^ 0x9e3779b9);
      const profile = randomProfile(stage, rnd, usedSigs);
      if (!profile) { note('no profile'); continue; }
      const segments = [{ type: 'single', counts: profile }];
      const plan = expandPlan(segments, stage.W, stage.H);
      if (plan.errors.length) { note('profile error'); continue; }
      const cap = stage.reversed || 0;
      const variant = { hardEnding: rnd() < (stage.hardEnding || 0) };
      const o = {
        lang: settings.lang, W: stage.W, H: stage.H, minLen: stage.minLen, maxLen: stage.maxLen, cover: 'strict',
        plan, segments, profile: plan.totals, reversed: cap ? cap * (0.4 + 0.6 * rnd()) : 0,
        swaps: settings.swaps == null ? 300 : settings.swaps, reusePenalty: settings.reusePenalty == null ? 1 : settings.reusePenalty,
        maxBonus: null, noInPlace: !!stage.noInPlace, rMix: false, fullBoard: !!stage.fullBoard, easyTop: true, forbidReuse: true, model,
        lenBias: stage.lenBias == null ? 2 : stage.lenBias, reversedBias: stage.reversedBias,
        extra: res => stagePenalty(res, stage, variant, model),
      };
      const res = runLevel(dict, o, seed, usage);
      if (res.reject) { note(res.reject); continue; }
      const why = checkStage(res, stage, variant, model);
      Object.assign(res, { why, variant, profileStr: profile, levelNo, stage });
      if (!why.length) passing.push(res);
      else { why.forEach(note); if (!fallback || why.length < fallback.why.length) fallback = res; }
    }
    const chosen = passing.reduce((b, r) => (!b || stageScore(r) < stageScore(b) ? r : b), null) || fallback;
    if (chosen) {
      chosen.layers.flat().forEach(w => usage.set(w.word, (usage.get(w.word) || 0) + 1));
      usedSigs.add(chosen.profileStr.replace(/\([^)]*\)/g, ''));
    }
    return { chosen, passed: passing.length, attempts, rejects };
  }
  function funnelLevel(dict, stage, levelNo, baseSeed, usage, usedSigs, settings) {
    const it = funnelLevelGen(dict, stage, levelNo, baseSeed, usage, usedSigs, settings);
    for (;;) { const r = it.next(); if (r.done) return r.value; }
  }

  // index.html level format.
  function levelJson(r, id, name) {
    const o = r.o;
    return {
      id,
      name: name || `Generated ${r.seed}`,
      difficulty: `${r.waves} waves`,
      width: o.W,
      height: o.H,
      layers: r.layers,
      validWords: r.validWords || r.bonus,
      gen: {
        seed: r.seed, lang: o.lang, profile: o.profile, plan: o.segments, swaps: o.swaps, reusePenalty: o.reusePenalty,
        reversed: +r.reversedShare.toFixed(3), noInPlace: o.noInPlace, rMix: o.rMix, fullBoard: !!o.fullBoard, maxBonus: o.maxBonus, minLen: o.minLen, maxLen: o.maxLen, cover: o.cover,
        waves: r.waves, targets: r.targets, letters: r.letters, bonus: r.bonusCount, validWords: (r.validWords || r.bonus).length,
        extras: r.extra4 != null ? { root: r.extraRoot, four: r.extra4, three: r.extra3 } : undefined,
        ratio: +r.ratio.toFixed(3), peakBonus: Math.round(r.peakBonus),
        perWave: r.perWave.map(w => [w.available, w.remaining, w.bonus]),
        tempo: r.steps.map(s => +s.cost.toFixed(2)), knots: r.knots, chains: r.chains, longestChain: r.longestChain,
        decoys: r.totalDecoys, nearMiss: r.totalNearMiss, startNoise: +r.startNoise.toFixed(2),
        revCenter: r.revCenter == null ? null : +r.revCenter.toFixed(2), emptyCells: r.emptyCells,
        stage: r.stage ? `${r.stage.from}-${r.stage.to}` : undefined, tier: r.stage && r.stage.tier ? r.stage.tier : undefined,
        misses: r.why && r.why.length ? r.why : undefined,
      },
    };
  }

  return {
    DIRS, LOCALES, FLAG_NAMES, DEFAULT_MODEL, DEFAULT_STAGES, VARIETY_STAGES, VARIETY_TIERS, STAGE_PRESETS, concreteStage,
    MIN_TARGET_SCORE, MIN_BONUS_SCORE, MIN_BONUS_LEN,
    parseDict, parseLayers, flagText, splitInfo, flipOrient, expandPlan, mulberry32, levelSeed, allVisibleWords, classifyExtras, extrasOf,
    generateLevel, simulate, simulatePlay, analyzePlay, peakBonusOf, optimizeWords, hasInPlaceReveal, lacksRMix, hasEmptyCell,
    runLevel, reuseStats, stageFor, randomProfile, stageMisses, checkStage, stagePenalty, stageScore, funnelLevelGen, funnelLevel, levelJson,
  };
});
