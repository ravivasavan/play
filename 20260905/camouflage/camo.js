/* Camouflage — layered organic blobs, one woodland palette.
   Random draws a new seed; the same seed always paints the same pattern. */

(function () {
  'use strict';

  const canvas = document.getElementById('camo');
  const seedEl = document.getElementById('seed');
  const btn = document.getElementById('p-random');
  if (!canvas || !btn) return;

  const ctx = canvas.getContext('2d', { alpha: false });

  /* Muted woodland — olive, drab green, warm brown, sand, near-black. */
  const PALETTE = [
    '#3d4a28', /* olive */
    '#5a6b38', /* drab green */
    '#6b5430', /* warm brown */
    '#c2b48a', /* sand */
    '#1a1c14'  /* near-black */
  ];

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

  function parseHash() {
    const m = location.hash.match(/#?s=([0-9a-fA-F]+)/);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return Number.isFinite(n) ? (n >>> 0) : null;
  }

  function setHash(seed) {
    history.replaceState(null, '', '#s=' + seed.toString(16).padStart(8, '0'));
  }

  /* Smooth irregular closed shape — polar vertices, quadratic midpoints. */
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

  function paintLayer(layerCtx, w, h, rand, color, count, sizeMin, sizeMax) {
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

  function generate(seed) {
    const rand = mulberry32(seed);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const W = canvas.width;
    const H = canvas.height;
    const minSide = Math.min(W, H);

    /* Base fill — darkest olive/near-black, seeded pick among the two darkest. */
    const base = PALETTE[rand() < 0.55 ? 4 : 0];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    /* 3–4 layers of soft-edge organic shapes. */
    const layerCount = 3 + Math.floor(rand() * 2);
    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = H;
    const lctx = layer.getContext('2d');

    /* Shuffle a working order so layers don't always stack the same hues. */
    const hues = PALETTE.slice();
    for (let i = hues.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = hues[i]; hues[i] = hues[j]; hues[j] = t;
    }

    for (let L = 0; L < layerCount; L++) {
      const count = 4 + Math.floor(rand() * 3); /* 4–6 shapes */
      const color = hues[L % hues.length];
      /* Larger shapes on lower layers, finer on top. */
      const t = L / Math.max(1, layerCount - 1);
      const sizeMax = minSide * (0.42 - t * 0.18);
      const sizeMin = minSide * (0.14 - t * 0.05);
      /* Soft edge — slightly different blur per layer, not decorative gradients. */
      const blur = (10 + L * 6 + rand() * 8) * dpr;

      paintLayer(lctx, W, H, rand, color, count, sizeMin, sizeMax);

      ctx.save();
      ctx.filter = 'blur(' + blur.toFixed(1) + 'px)';
      ctx.globalAlpha = 0.78 + rand() * 0.18;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }

    /* One tighter top layer of smaller shapes for printed-camo weight. */
    {
      const count = 4 + Math.floor(rand() * 3);
      const color = hues[Math.floor(rand() * hues.length)];
      const sizeMax = minSide * (0.16 + rand() * 0.08);
      const sizeMin = minSide * (0.05 + rand() * 0.04);
      const blur = (4 + rand() * 5) * dpr;
      paintLayer(lctx, W, H, rand, color, count, sizeMin, sizeMax);
      ctx.save();
      ctx.filter = 'blur(' + blur.toFixed(1) + 'px)';
      ctx.globalAlpha = 0.85;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }

    if (seedEl) seedEl.textContent = seed.toString(16).padStart(8, '0');
    setHash(seed);
  }

  let current = parseHash() ?? pickSeed();
  let resizeTimer = 0;

  function randomise() {
    current = pickSeed();
    generate(current);
  }

  btn.addEventListener('click', randomise);

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => generate(current), 120);
  });

  const CYCLE = ['day', 'night', 'system', 'circadian'];
  const themeBtn = document.querySelector('[data-theme-toggle]');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const html = document.documentElement;
      const next = CYCLE[(CYCLE.indexOf(html.dataset.theme || 'system') + 1) % CYCLE.length];
      html.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  generate(current);
})();
