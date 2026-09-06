(() => {
  'use strict';
  const W = window.WORLD;
  const $ = id => document.getElementById(id);
  const stage = $('stage'), canvas = $('map'), tip = $('tip');
  const ctx = canvas.getContext('2d');
  const hit = document.createElement('canvas');
  const hctx = hit.getContext('2d', { willReadFrequently: true });

  // ---------- data ----------
  const byCode = new Map(W.countries.map(c => [c.c, c]));
  // Rings arrive as delta-encoded hundredths of a unit; unpack straight into Path2Ds.
  W.countries.forEach((c, i) => { c.i = i; c.paths = c.g.map(d => { const p = new Path2D(); let x = d[0], y = d[1]; p.moveTo(x / 100, y / 100); for (let k = 2; k < d.length; k += 2) { x += d[k]; y += d[k + 1]; p.lineTo(x / 100, y / 100); } p.closePath(); return p; }); });
  const counted = W.countries.filter(c => c.k !== 't');
  const sphere = new Path2D(); W.sphere.forEach(([x, y], i) => i ? sphere.lineTo(x, y) : sphere.moveTo(x, y)); sphere.closePath();
  const grat = new Path2D(); W.grat.forEach(line => line.forEach(([x, y], i) => i ? grat.lineTo(x, y) : grat.moveTo(x, y)));

  // ---------- state ----------
  const KEY = 'atlas.state';
  const visited = new Set();
  (function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.visited)) for (const c of s.visited) if (byCode.has(c)) visited.add(c);
    } catch (e) {}
  })();
  let save = function () {
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, visited: [...visited].sort() })); } catch (e) {}
  };
  function toggle(code) {
    if (visited.has(code)) visited.delete(code); else visited.add(code);
    save(); renderPanel(); draw();
  }

  // ---------- view ----------
  // Screen = world · k · s0 + t. s0 fits the whole world in the stage; k is the zoom.
  const view = { k: 1, tx: 0, ty: 0 };
  let cw = 0, ch = 0, dpr = 1, s0 = 1, hover = null;
  const PAD = 24;
  const KMIN = 1, KMAX = 12;

  function fit() {
    const r = stage.getBoundingClientRect();
    cw = r.width; ch = r.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = hit.width = Math.round(cw * dpr); canvas.height = hit.height = Math.round(ch * dpr);
    // Leave headroom for the chrome rows on desktop: the world sits below them.
    const top = matchMedia('(max-width: 900px)').matches ? 180 : 200;
    s0 = Math.min((cw - PAD * 2) / W.w, (ch - top - PAD) / W.h);
    const s = s0 * view.k;
    if (view.k === 1) { view.tx = (cw - W.w * s) / 2; view.ty = top + (ch - top - W.h * s) / 2; }
    clamp(); draw();
  }
  const scale = () => s0 * view.k;
  function clamp() {
    view.k = Math.min(KMAX, Math.max(KMIN, view.k));
    const s = scale(), ww = W.w * s, hh = W.h * s;
    // Never let the world leave the stage entirely.
    view.tx = Math.min(cw - 80, Math.max(80 - ww, view.tx));
    view.ty = Math.min(ch - 80, Math.max(80 - hh, view.ty));
  }
  function zoomAt(factor, px, py) {
    const k0 = view.k, k1 = Math.min(KMAX, Math.max(KMIN, k0 * factor));
    if (k1 === k0) return;
    const r = k1 / k0;
    view.tx = px - (px - view.tx) * r; view.ty = py - (py - view.ty) * r; view.k = k1;
    clamp(); draw();
  }
  function world() { view.k = 1; fit(); }
  function zoomTo(c) {
    const [x0, y0, x1, y1] = c.b;
    const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
    const k = Math.min(KMAX, Math.max(KMIN, Math.min((cw * 0.5) / (bw * s0), (ch * 0.5) / (bh * s0))));
    animate(k, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  let anim = 0;
  function animate(k1, wx, wy) {
    cancelAnimationFrame(anim);
    const k0 = view.k, tx0 = view.tx, ty0 = view.ty, t0 = performance.now(), D = 520;
    const tx1 = cw / 2 - wx * s0 * k1, ty1 = ch / 2 - wy * s0 * k1;
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const t = ease(Math.min(1, (now - t0) / D));
      view.k = k0 + (k1 - k0) * t; view.tx = tx0 + (tx1 - tx0) * t; view.ty = ty0 + (ty1 - ty0) * t;
      draw();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  // ---------- drawing ----------
  const css = () => getComputedStyle(document.documentElement);
  const DOT = 3.5;
  function tiny(c, s) { return c.c !== 'ATA' && Math.max(c.b[2] - c.b[0], c.b[3] - c.b[1]) * s < 7; }

  function draw() {
    const s = scale(), v = css();
    const land = v.getPropertyValue('--land').trim(), line = v.getPropertyValue('--land-line').trim();
    const vis = v.getPropertyValue('--visited').trim(), hov = v.getPropertyValue('--land-hover').trim(), vhov = v.getPropertyValue('--visited-hover').trim();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(view.tx, view.ty); ctx.scale(s, s);
    ctx.lineJoin = 'round';
    // Graticule and horizon.
    ctx.strokeStyle = v.getPropertyValue('--grat').trim(); ctx.lineWidth = 1 / s; ctx.stroke(grat);
    ctx.strokeStyle = v.getPropertyValue('--sea-line').trim(); ctx.lineWidth = 1 / s; ctx.stroke(sphere);
    // Land.
    const dots = [];
    for (const c of W.countries) {
      if (tiny(c, s)) { dots.push(c); continue; }
      const on = visited.has(c.c), h = hover === c;
      ctx.fillStyle = on ? (h ? vhov : vis) : (h ? hov : land);
      for (const p of c.paths) ctx.fill(p);
    }
    ctx.strokeStyle = line; ctx.lineWidth = 0.7 / s;
    for (const c of W.countries) if (!tiny(c, s)) for (const p of c.paths) ctx.stroke(p);
    ctx.restore();
    // Dots draw in screen space so they stay the same size at every zoom.
    for (const c of dots) {
      const [x, y] = c.l, sx = x * s + view.tx, sy = y * s + view.ty;
      const on = visited.has(c.c), h = hover === c;
      ctx.beginPath(); ctx.arc(sx, sy, DOT + (h ? 1 : 0), 0, Math.PI * 2);
      if (on) { ctx.fillStyle = h ? vhov : vis; ctx.fill(); }
      else { ctx.fillStyle = h ? hov : v.getPropertyValue('--bg').trim(); ctx.fill(); ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.stroke(); }
    }
    drawHit(s, dots);
  }

  // Hit-testing: every place in its own colour on an offscreen canvas, then read the pixel.
  function drawHit(s, dots) {
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, cw, ch);
    hctx.save(); hctx.translate(view.tx, view.ty); hctx.scale(s, s);
    for (const c of W.countries) { if (tiny(c, s)) continue; hctx.fillStyle = idColor(c.i); for (const p of c.paths) hctx.fill(p); }
    hctx.restore();
    for (const c of dots) { const [x, y] = c.l; hctx.fillStyle = idColor(c.i); hctx.beginPath(); hctx.arc(x * s + view.tx, y * s + view.ty, DOT + 3, 0, Math.PI * 2); hctx.fill(); }
  }
  const idColor = i => `rgb(${(i + 1) & 255},${((i + 1) >> 8) & 255},0)`;
  function pick(px, py) {
    const d = hctx.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
    if (!d[3]) return null;
    const i = d[0] + (d[1] << 8) - 1;
    return W.countries[i] || null;
  }

  // ---------- pointer ----------
  const ptrs = new Map();
  let dragging = false, moved = false, pinch0 = null;
  stage.addEventListener('pointerdown', e => {
    if (e.target !== canvas) return;
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { dragging = true; moved = false; }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx: view.tx, ty: view.ty }; }
  });
  stage.addEventListener('pointermove', e => {
    const r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (ptrs.has(e.pointerId)) {
      const prev = ptrs.get(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && pinch0) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        const k1 = Math.min(KMAX, Math.max(KMIN, pinch0.k * d / pinch0.d)), rr = k1 / pinch0.k;
        view.tx = cx - (pinch0.cx - r.left - pinch0.tx) * rr; view.ty = cy - (pinch0.cy - r.top - pinch0.ty) * rr; view.k = k1;
        moved = true; clamp(); draw(); return;
      }
      if (dragging) {
        const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        if (Math.abs(e.clientX - (pinchStart(e))) > 0) {}
        if (!moved && Math.hypot(dx, dy) < 1) return;
        moved = true; stage.classList.add('dragging'); hideTip();
        view.tx += dx; view.ty += dy; clamp(); draw(); return;
      }
    }
    if (e.pointerType !== 'touch') setHover(pick(px, py), px, py);
  });
  function pinchStart() { return 0; }
  function up(e) {
    const wasPinch = ptrs.size === 2;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch0 = null;
    if (ptrs.size === 0) {
      dragging = false; stage.classList.remove('dragging');
      if (!moved && !wasPinch && e.type === 'pointerup') {
        const r = stage.getBoundingClientRect(), c = pick(e.clientX - r.left, e.clientY - r.top);
        if (c) { toggle(c.c); if (e.pointerType === 'touch') flashTip(c, e.clientX - r.left, e.clientY - r.top); }
      }
    }
  }
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', () => { if (!dragging) setHover(null); });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel is coarse.
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
    zoomAt(f, e.clientX - r.left, e.clientY - r.top);
    const px = e.clientX - r.left, py = e.clientY - r.top; setHover(pick(px, py), px, py);
  }, { passive: false });

  function setHover(c, px, py) {
    if (c !== hover) { hover = c; draw(); stage.classList.toggle('over', !!c); }
    if (c) { tip.innerHTML = label(c); tip.style.left = px + 'px'; tip.style.top = py + 'px'; tip.classList.add('on'); }
    else hideTip();
  }
  function hideTip() { tip.classList.remove('on'); }
  let flashT = 0;
  function flashTip(c, px, py) { tip.innerHTML = label(c); tip.style.left = px + 'px'; tip.style.top = py + 'px'; tip.classList.add('on'); clearTimeout(flashT); flashT = setTimeout(hideTip, 1200); }
  const label = c => `${visited.has(c.c) ? '<span class="tick">●</span> ' : ''}${esc(c.n)}${c.s ? ` <small>· ${esc(c.s)}</small>` : ''}`;
  const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // ---------- panel ----------
  const REGIONS = ['Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania', 'Antarctica', 'Seven seas (open ocean)'];
  function renderPanel() {
    const n = counted.filter(c => visited.has(c.c)).length;
    const t = W.countries.filter(c => c.k === 't' && visited.has(c.c)).length;
    $('n').textContent = n;
    $('rail').style.width = (n / 195 * 100) + '%';
    $('togo').textContent = n === 195 ? 'All of them' : `${195 - n} to go`;
    $('terr').textContent = t ? `+ ${t} territor${t === 1 ? 'y' : 'ies'}` : '';
    const box = $('visited');
    if (!visited.size) { box.innerHTML = '<p class="empty">Nothing yet. Click the map, or start typing.</p>'; return; }
    const groups = new Map();
    for (const c of W.countries) if (visited.has(c.c)) { const r = c.r === 'Seven seas (open ocean)' ? 'Islands' : c.r; if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); }
    const order = [...groups.keys()].sort((a, b) => REGIONS.indexOf(a) - REGIONS.indexOf(b));
    box.innerHTML = order.map(r => `<div class="visited__group"><h2>${esc(r)} · ${groups.get(r).length}</h2><ul>${groups.get(r).sort((a, b) => a.n.localeCompare(b.n)).map(c =>
      `<li><button type="button" class="${c.k === 't' ? 't' : ''}" data-code="${c.c}" aria-label="Remove ${esc(c.n)}">${esc(c.n)}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></li>`).join('')}</ul></div>`).join('');
  }
  $('visited').addEventListener('click', e => {
    const b = e.target.closest('button[data-code]'); if (b) toggle(b.dataset.code);
  });
  $('visited').addEventListener('pointerover', e => {
    const b = e.target.closest('button[data-code]'); if (b) { const c = byCode.get(b.dataset.code); if (c !== hover) { hover = c; draw(); } }
  });
  $('visited').addEventListener('pointerleave', () => { if (hover) { hover = null; draw(); } });

  // ---------- search ----------
  const q = $('q'), list = $('list');
  let results = [], sel = 0;
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const ALIASES = { USA: ['united states', 'america', 'us'], GBR: ['uk', 'britain', 'england', 'scotland', 'wales'], KOR: ['south korea'], PRK: ['north korea'], CZE: ['czech republic'], NLD: ['holland'], ARE: ['uae', 'emirates'], MMR: ['burma'], CIV: ['ivory coast'], SWZ: ['swaziland'], TLS: ['east timor'], VAT: ['holy see', 'vatican city'], MKD: ['macedonia'], COD: ['drc', 'congo kinshasa'], COG: ['congo brazzaville'], CPV: ['cape verde'], TUR: ['turkey'], HKG: ['hong kong'], MAC: ['macau'] };
  function search(text) {
    const t = fold(text.trim());
    if (!t) return [];
    const hits = [];
    for (const c of W.countries) {
      const names = [c.n, ...(ALIASES[c.c] || [])].map(fold);
      let score = 0;
      for (const nm of names) { if (nm === t) score = Math.max(score, 3); else if (nm.startsWith(t)) score = Math.max(score, 2); else if (nm.split(/\s+/).some(w => w.startsWith(t))) score = Math.max(score, 1.5); else if (nm.includes(t)) score = Math.max(score, 1); }
      if (c.c.toLowerCase() === t) score = 3;
      if (score) hits.push({ c, score });
    }
    return hits.sort((a, b) => b.score - a.score || (a.c.k === 't') - (b.c.k === 't') || a.c.n.localeCompare(b.c.n)).slice(0, 8).map(h => h.c);
  }
  function renderList() {
    if (!q.value.trim()) { list.classList.remove('on'); list.innerHTML = ''; return; }
    if (!results.length) { list.innerHTML = '<li class="search__empty">Nothing by that name</li>'; list.classList.add('on'); return; }
    list.innerHTML = results.map((c, i) => `<li role="option" data-i="${i}" class="${i === sel ? 'sel' : ''} ${visited.has(c.c) ? 'is-visited' : ''}"><span>${esc(c.n)}</span><small>${c.s ? esc(c.s) : c.k === 't' ? 'territory' : esc(c.r)}</small></li>`).join('');
    list.classList.add('on');
  }
  q.addEventListener('input', () => { results = search(q.value); sel = 0; renderList(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderList(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (results[sel]) choose(results[sel]); e.preventDefault(); }
    else if (e.key === 'Escape') { q.value = ''; results = []; renderList(); q.blur(); }
  });
  q.addEventListener('blur', () => setTimeout(() => list.classList.remove('on'), 120));
  q.addEventListener('focus', () => { if (results.length) renderList(); });
  list.addEventListener('pointerdown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(results[+li.dataset.i]); } });
  function choose(c) {
    if (!visited.has(c.c)) toggle(c.c);
    zoomTo(c);
    q.value = ''; results = []; renderList(); q.focus();
  }

  // ---------- tools ----------
  $('t-in').addEventListener('click', () => zoomAt(1.6, cw / 2, ch / 2));
  $('t-out').addEventListener('click', () => zoomAt(1 / 1.6, cw / 2, ch / 2));
  $('t-world').addEventListener('click', world);
  $('t-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, visited: [...visited].sort() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'atlas.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('t-import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      const codes = (Array.isArray(s) ? s : s.visited || []).filter(c => byCode.has(c));
      if (!codes.length) { alert('No country codes in that file.'); return; }
      codes.forEach(c => visited.add(c)); save(); renderPanel(); draw();
    } catch (err) { alert('That file isn\'t JSON.'); }
    e.target.value = '';
  });
  $('t-clear').addEventListener('click', () => {
    if (!visited.size) return;
    if (confirm(`Clear all ${visited.size} places from the map?`)) { visited.clear(); save(); renderPanel(); draw(); }
  });

  addEventListener('keydown', e => {
    if (e.target === q || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { q.focus(); e.preventDefault(); return; }
    const step = 60;
    if (e.key === '+' || e.key === '=') zoomAt(1.6, cw / 2, ch / 2);
    else if (e.key === '-') zoomAt(1 / 1.6, cw / 2, ch / 2);
    else if (e.key === '0') world();
    else if (e.key === 'ArrowLeft') { view.tx += step; clamp(); draw(); }
    else if (e.key === 'ArrowRight') { view.tx -= step; clamp(); draw(); }
    else if (e.key === 'ArrowUp') { view.ty += step; clamp(); draw(); }
    else if (e.key === 'ArrowDown') { view.ty -= step; clamp(); draw(); }
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  });

  // ---------- theme ----------
  // Cycling the theme and writing localStorage is play.js's job now; this page
  // only needs to know when the theme (or circadian's live tokens) change, so
  // the map's colours can be repainted.
  new MutationObserver(() => setTimeout(draw, 260)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(draw, 260));

  // Dev hooks, for screenshots: #seed=FRA,JPN,… fills those in without touching
  // what's saved; &theme=day forces a theme; &focus=FRA opens on that country.
  const H = new URLSearchParams(location.hash.slice(1));
  if (H.has('seed')) { H.get('seed').split(',').forEach(c => { if (byCode.has(c)) visited.add(c); }); save = () => {}; }
  if (H.has('theme')) document.documentElement.dataset.theme = H.get('theme');

  new ResizeObserver(fit).observe(stage);
  renderPanel();
  fit();
  if (H.has('focus') && byCode.has(H.get('focus'))) { const c = byCode.get(H.get('focus')); const [x0, y0, x1, y1] = c.b; view.k = Math.min(KMAX, Math.max(KMIN, Math.min((cw * 0.5) / ((x1 - x0) * s0), (ch * 0.5) / ((y1 - y0) * s0)))); view.tx = cw / 2 - (x0 + x1) / 2 * s0 * view.k; view.ty = ch / 2 - (y0 + y1) / 2 * s0 * view.k; clamp(); draw(); }
})();
