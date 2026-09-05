/* Camouflage — seeded organic blotch generator.
   Each Random click draws a new seed; the same seed always paints the same pattern. */

(function () {
  'use strict';

  const canvas = document.getElementById('camo');
  const seedEl = document.getElementById('seed');
  const familyEl = document.getElementById('family');
  const btn = document.getElementById('p-random');
  if (!canvas || !btn) return;

  const ctx = canvas.getContext('2d', { alpha: false });

  /* Curated families — classic field kits, not rainbow noise. */
  const FAMILIES = [
    {
      name: 'Woodland',
      colors: ['#2d3a1f', '#4a5c2a', '#6b7340', '#3e2f1c', '#8a7a4a']
    },
    {
      name: 'Desert',
      colors: ['#c4a574', '#a8895c', '#8b6f47', '#d4bc8e', '#6b5340']
    },
    {
      name: 'Urban',
      colors: ['#4a4a4c', '#6e6e70', '#2e2e30', '#9a9a9c', '#5c5a56']
    },
    {
      name: 'Snow',
      colors: ['#e8eef2', '#c5d0d8', '#9aabba', '#6f7f8c', '#dfe6eb']
    },
    {
      name: 'Tropic',
      colors: ['#1e3a28', '#2f5a38', '#4a7a42', '#1a2e1c', '#6b8f4a']
    },
    {
      name: 'Flecktarn',
      colors: ['#3d4a2a', '#5c6b3a', '#2a3220', '#7a6b48', '#4a3a28']
    }
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
    const hex = seed.toString(16).padStart(8, '0');
    history.replaceState(null, '', '#s=' + hex);
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
  }

  /* Irregular organic blob via polar vertices with radial noise. */
  function drawBlob(c, cx, cy, r, rand, verts) {
    const n = verts || (7 + Math.floor(rand() * 7));
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wobble = 0.55 + rand() * 0.7;
      const stretch = 0.75 + rand() * 0.55;
      const x = cx + Math.cos(a) * r * wobble * stretch;
      const y = cy + Math.sin(a) * r * wobble * (2 - stretch);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    c.fill();
  }

  /* Soft Voronoi-ish field. Squircle metric → organic cell edges. */
  function paintVoronoi(img, w, h, sites) {
    const data = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < sites.length; i++) {
          const s = sites[i];
          const dx = x - s.x;
          const dy = y - s.y;
          const d = Math.pow(Math.abs(dx), 1.7) + Math.pow(Math.abs(dy), 1.7);
          if (d < bestD) { bestD = d; best = i; }
        }
        const rgb = sites[best].rgb;
        const i4 = (y * w + x) * 4;
        data[i4] = rgb[0];
        data[i4 + 1] = rgb[1];
        data[i4 + 2] = rgb[2];
        data[i4 + 3] = 255;
      }
    }
  }

  function generate(seed) {
    const rand = mulberry32(seed);
    const family = FAMILIES[Math.floor(rand() * FAMILIES.length)];
    const colors = family.colors.slice();
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = colors[i]; colors[i] = colors[j]; colors[j] = t;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    /* Working resolution — coarse enough for large blotches. */
    const scale = 0.16 + rand() * 0.1;
    const w = Math.max(48, Math.floor(canvas.width * scale));
    const h = Math.max(48, Math.floor(canvas.height * scale));

    const density = 0.01 + rand() * 0.018;
    const count = Math.max(24, Math.min(100, Math.floor(w * h * density)));

    const sites = [];
    for (let i = 0; i < count; i++) {
      sites.push({
        x: rand() * w,
        y: rand() * h,
        rgb: hexToRgb(colors[Math.floor(rand() * colors.length)])
      });
    }
    /* Clustered sites → large intentional blotches. */
    const clusters = 3 + Math.floor(rand() * 4);
    for (let c = 0; c < clusters; c++) {
      const cx = rand() * w;
      const cy = rand() * h;
      const rgb = hexToRgb(colors[Math.floor(rand() * colors.length)]);
      const n = 4 + Math.floor(rand() * 6);
      const spread = Math.min(w, h) * (0.08 + rand() * 0.12);
      for (let k = 0; k < n; k++) {
        sites.push({
          x: cx + (rand() - 0.5) * spread * 2,
          y: cy + (rand() - 0.5) * spread * 2,
          rgb: rgb
        });
      }
    }

    const img = ctx.createImageData(w, h);
    paintVoronoi(img, w, h, sites);

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    off.getContext('2d').putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    /* Overlay organic blobs for printed-camo weight. */
    ctx.imageSmoothingEnabled = true;
    const blobCount = 8 + Math.floor(rand() * 14);
    for (let i = 0; i < blobCount; i++) {
      ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
      ctx.globalAlpha = 0.5 + rand() * 0.4;
      const r = Math.min(canvas.width, canvas.height) * (0.04 + rand() * 0.14);
      drawBlob(ctx, rand() * canvas.width, rand() * canvas.height, r, rand, 8 + Math.floor(rand() * 6));
    }
    ctx.globalAlpha = 1;

    /* Micro flecks — flecktarn detail without noise soup. */
    const flecks = Math.floor(36 + rand() * 70);
    for (let i = 0; i < flecks; i++) {
      ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
      const r = (2 + rand() * 6) * dpr;
      drawBlob(ctx, rand() * canvas.width, rand() * canvas.height, r, rand, 5 + Math.floor(rand() * 3));
    }

    if (seedEl) seedEl.textContent = seed.toString(16).padStart(8, '0');
    if (familyEl) familyEl.textContent = family.name;
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

  (function (tools) {
    if (!tools) return;
    let dragging = false, moved = false, sx = 0, sl = 0;
    tools.addEventListener('pointerdown', e => {
      if (matchMedia('(min-width: 901px)').matches) return;
      dragging = true; moved = false; sx = e.clientX; sl = tools.scrollLeft;
    });
    addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 6) { moved = true; tools.classList.add('dragging'); }
      if (moved) tools.scrollLeft = sl - dx;
    });
    addEventListener('pointerup', () => {
      dragging = false; tools.classList.remove('dragging');
    });
    tools.addEventListener('click', e => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
  })(document.querySelector('.tools'));

  generate(current);
})();
