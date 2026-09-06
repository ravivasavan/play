/* Camouflage — layered organic blotches, colourways + blur/layer dials.
   Random = new seed (keeps colourway/pattern/dials). State in the hash. */

(function () {
  'use strict';

  const canvas = document.getElementById('camo');
  const stage = document.getElementById('stage');
  const seedEl = document.getElementById('seed');
  const btn = document.getElementById('p-random');
  const paletteEl = document.getElementById('p-palette');
  const patternEl = document.getElementById('p-pattern');
  const blurEl = document.getElementById('p-blur');
  const layersEl = document.getElementById('p-layers');
  const blurVal = document.getElementById('p-blur-val');
  const layersVal = document.getElementById('p-layers-val');
  const summaryEl = document.getElementById('p-summary');
  if (!canvas || !btn) return;

  const ctx = canvas.getContext('2d', { alpha: false });

  const COLOURWAYS = {
    woodland: {
      label: 'Woodland',
      colors: ['#3d4a28', '#5a6b38', '#6b5430', '#c2b48a', '#1a1c14']
    },
    desert: {
      label: 'Desert',
      colors: ['#c4a574', '#a67c52', '#8b6914', '#d4c4a8', '#5c4033']
    },
    urban: {
      label: 'Urban',
      colors: ['#6b6e70', '#4a4d50', '#9a9b9c', '#2f3133', '#c5c6c7']
    },
    snow: {
      label: 'Snow',
      colors: ['#e8eef2', '#b8c4ce', '#8a9aa8', '#5a6a78', '#2a3440']
    },
    tropic: {
      label: 'Tropic',
      colors: ['#2d5a3d', '#4a7c59', '#1e3d2f', '#8fbc8f', '#3d2914']
    },
    flecktarn: {
      label: 'Flecktarn',
      colors: ['#4a5c28', '#6b5430', '#3d4a28', '#c2b48a', '#1a1c14']
    }
  };

  const PATTERNS = ['blotch', 'fleck'];
  const PATTERN_LABELS = { blotch: 'Blotch', fleck: 'Fleck' };

  const state = {
    seed: 0,
    palette: 'woodland',
    pattern: 'blotch',
    blur: 1,   /* 0–2 multiplier on soft-edge blur */
    layers: 4  /* 2–6 */
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6d2b79f5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function pickSeed() {
    return (Math.random() * 0xffffffff) >>> 0;
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    const params = new URLSearchParams(raw.includes('=') ? raw.replace(/;/g, '&') : '');
    /* Also support legacy #s=hex only */
    if (!raw.includes('=')) return null;
    const s = params.get('s');
    const out = {};
    if (s) {
      const n = parseInt(s, 16);
      if (Number.isFinite(n)) out.seed = n >>> 0;
    }
    const pal = params.get('palette');
    if (pal && COLOURWAYS[pal]) out.palette = pal;
    const pat = params.get('pattern');
    if (pat && PATTERNS.includes(pat)) out.pattern = pat;
    const blur = parseFloat(params.get('blur'));
    if (Number.isFinite(blur)) out.blur = clamp(blur, 0, 2);
    const layers = parseInt(params.get('layers'), 10);
    if (Number.isFinite(layers)) out.layers = clamp(layers, 2, 6);
    return out;
  }

  function parseLegacyHash() {
    const m = location.hash.match(/#?s=([0-9a-fA-F]+)$/);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return Number.isFinite(n) ? { seed: n >>> 0 } : null;
  }

  function setHash() {
    const q = new URLSearchParams();
    q.set('s', state.seed.toString(16).padStart(8, '0'));
    q.set('palette', state.palette);
    q.set('pattern', state.pattern);
    q.set('blur', String(Math.round(state.blur * 100) / 100));
    q.set('layers', String(state.layers));
    history.replaceState(null, '', '#' + q.toString());
  }

  function syncControls() {
    if (paletteEl) paletteEl.value = state.palette;
    if (patternEl) patternEl.value = state.pattern;
    if (blurEl) blurEl.value = String(state.blur);
    if (layersEl) layersEl.value = String(state.layers);
    if (blurVal) blurVal.textContent = state.blur.toFixed(1);
    if (layersVal) layersVal.textContent = String(state.layers);
    /* Folded, the head is all you see of the sheet, so it says what the two
       selects underneath are set to. */
    if (summaryEl) {
      const pal = COLOURWAYS[state.palette] || COLOURWAYS.woodland;
      summaryEl.textContent = pal.label + ' · ' + (PATTERN_LABELS[state.pattern] || state.pattern);
    }
    /* A dial's filled half is painted from --dial-fill, which play.js only
       updates on the user's own input events — a value set in code needs the
       repaint asking for. */
    if (window.play && window.play.dials) window.play.dials();
  }

  function blobPath(c, cx, cy, rx, ry, rand, n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.35;
      const wr = 0.55 + rand() * 0.7;
      const ws = 0.7 + rand() * 0.55;
      pts.push({
        x: cx + Math.cos(a) * rx * wr * ws,
        y: cy + Math.sin(a) * ry * wr * (1.7 - ws)
      });
    }
    c.beginPath();
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let m0 = mid(pts[pts.length - 1], pts[0]);
    c.moveTo(m0.x, m0.y);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const next = pts[(i + 1) % pts.length];
      const m = mid(p, next);
      c.quadraticCurveTo(p.x, p.y, m.x, m.y);
    }
    c.closePath();
  }

  function paintBlotch(layerCtx, w, h, rand, color, count, sizeMin, sizeMax) {
    layerCtx.clearRect(0, 0, w, h);
    layerCtx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const cx = rand() * w;
      const cy = rand() * h;
      const s = sizeMin + rand() * (sizeMax - sizeMin);
      const rx = s * (0.75 + rand() * 0.5);
      const ry = s * (0.75 + rand() * 0.5);
      const verts = 6 + Math.floor(rand() * 5);
      blobPath(layerCtx, cx, cy, rx, ry, rand, verts);
      layerCtx.fill();
    }
  }

  function paintFleck(layerCtx, w, h, rand, color, count, sizeMin, sizeMax) {
    layerCtx.clearRect(0, 0, w, h);
    layerCtx.fillStyle = color;
    const n = count * 8;
    for (let i = 0; i < n; i++) {
      const cx = rand() * w;
      const cy = rand() * h;
      const s = (sizeMin + rand() * (sizeMax - sizeMin)) * 0.28;
      const rx = s * (0.6 + rand() * 0.8);
      const ry = s * (0.5 + rand() * 0.7);
      const verts = 5 + Math.floor(rand() * 3);
      blobPath(layerCtx, cx, cy, rx, ry, rand, verts);
      layerCtx.fill();
    }
  }

  function generate() {
    const rand = mulberry32(state.seed);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* The stage is the full viewport — the sheet floats above it as an
       overlay rather than reserving room — so the pattern is measured off
       that box rather than off the window; in practice the two agree. */
    const box = stage ? stage.getBoundingClientRect() : null;
    const cssW = Math.max(1, Math.round(box ? box.width : window.innerWidth));
    const cssH = Math.max(1, Math.round(box ? box.height : window.innerHeight));
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    /* No inline width/height: the canvas is 100% of the stage in CSS, so it
       keeps following the box even between resize repaints. */

    const W = canvas.width;
    const H = canvas.height;
    const minSide = Math.min(W, H);
    const palette = COLOURWAYS[state.palette] || COLOURWAYS.woodland;
    const colors = palette.colors.slice();
    const paint = state.pattern === 'fleck' ? paintFleck : paintBlotch;
    const blurMul = state.blur;
    const layerCount = state.layers;

    const base = colors[rand() < 0.55 ? colors.length - 1 : 0];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = H;
    const lctx = layer.getContext('2d');

    const hues = colors.slice();
    for (let i = hues.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = hues[i]; hues[i] = hues[j]; hues[j] = t;
    }

    for (let L = 0; L < layerCount; L++) {
      const count = 4 + Math.floor(rand() * 3);
      const color = hues[L % hues.length];
      const t = L / Math.max(1, layerCount - 1);
      const sizeMax = minSide * (0.42 - t * 0.18);
      const sizeMin = minSide * (0.14 - t * 0.05);
      const blur = (10 + L * 6 + rand() * 8) * dpr * blurMul;

      paint(lctx, W, H, rand, color, count, sizeMin, sizeMax);

      ctx.save();
      ctx.filter = blur > 0.05 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
      ctx.globalAlpha = 0.78 + rand() * 0.18;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }

    /* Tighter top weight layer */
    {
      const count = 4 + Math.floor(rand() * 3);
      const color = hues[Math.floor(rand() * hues.length)];
      const sizeMax = minSide * (0.16 + rand() * 0.08);
      const sizeMin = minSide * (0.05 + rand() * 0.04);
      const blur = (4 + rand() * 5) * dpr * Math.max(0.35, blurMul * 0.7);
      paint(lctx, W, H, rand, color, count, sizeMin, sizeMax);
      ctx.save();
      ctx.filter = blur > 0.05 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
      ctx.globalAlpha = 0.85;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }

    if (seedEl) seedEl.textContent = state.seed.toString(16).padStart(8, '0');
    setHash();
  }

  function applyFromHash() {
    const parsed = parseHash() || parseLegacyHash() || {};
    state.seed = parsed.seed ?? pickSeed();
    state.palette = parsed.palette || state.palette;
    state.pattern = parsed.pattern || state.pattern;
    if (parsed.blur != null) state.blur = parsed.blur;
    if (parsed.layers != null) state.layers = parsed.layers;
  }

  function randomise() {
    state.seed = pickSeed();
    generate();
  }

  function onDialChange() {
    if (paletteEl) state.palette = paletteEl.value;
    if (patternEl) state.pattern = patternEl.value;
    if (blurEl) state.blur = clamp(parseFloat(blurEl.value) || 0, 0, 2);
    if (layersEl) state.layers = clamp(parseInt(layersEl.value, 10) || 4, 2, 6);
    syncControls();
    generate();
  }

  btn.addEventListener('click', randomise);
  if (paletteEl) paletteEl.addEventListener('change', onDialChange);
  if (patternEl) patternEl.addEventListener('change', onDialChange);
  if (blurEl) blurEl.addEventListener('input', onDialChange);
  if (layersEl) layersEl.addEventListener('input', onDialChange);

  /* The stage is inset:0 on the viewport, so watching its box amounts to
     watching the window — but a ResizeObserver is what the shared stage
     convention expects, and it costs nothing to stay consistent with it. */
  let resizeTimer = 0;
  let sized = false;
  function onResize() {
    /* A ResizeObserver reports the box once as soon as it is observed; the
       first paint has already used it. */
    if (!sized) { sized = true; return; }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => generate(), 120);
  }
  if (stage && window.ResizeObserver) new ResizeObserver(onResize).observe(stage);
  else { sized = true; window.addEventListener('resize', onResize); }

  applyFromHash();
  syncControls();
  generate();
})();
