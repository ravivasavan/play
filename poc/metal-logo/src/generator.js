// Metal logo generator — pure canvas pipeline, v3.
//
//   source (text | svg image)
//     → alpha mask (per-letter dislocation optional — "Unstable" anatomy)
//     → skeleton (Zhang–Suen) + chamfer distance transform
//     → terminals (stroke ends), tips (convex protrusions), stems,
//       and COUNTER seeds (the enclosed holes of a, e, o — grown into)
//     → tendrils continue the letterform strokes, with crown/root
//       asymmetry: up-growth spikier and shorter, down-growth longer
//       and more entangled
//     → auto-fit (growth is unbounded; the composition scales to fit)
//     → ink pass (blur + threshold) + grit speckle
//     → vector export: contour trace of the binary art, optionally on
//       transparent — solid mark on nothing is the deliverable
//
// Everything is deterministic off a single integer seed.

export const LOGICAL_W = 1400
export const LOGICAL_H = 800

// ── seeded PRNG (mulberry32) ────────────────────────────────────────────
export function makeRng(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => Math.min(1, Math.max(0, v))

// ── masks ───────────────────────────────────────────────────────────────

export function buildTextMask(text, fontFamily, fontSize, dislocation = 0, rand = null) {
  const c = document.createElement('canvas')
  c.width = LOGICAL_W
  c.height = LOGICAL_H
  const ctx = c.getContext('2d', { willReadFrequently: true })

  let size = fontSize
  ctx.textBaseline = 'middle'
  ctx.font = `${size}px "${fontFamily}"`
  ctx.fillStyle = '#fff'
  const maxW = LOGICAL_W * 0.8

  if (dislocation < 0.01 || !rand) {
    ctx.textAlign = 'center'
    const measured = ctx.measureText(text).width
    if (measured > maxW) {
      size = Math.floor(size * (maxW / measured))
      ctx.font = `${size}px "${fontFamily}"`
    }
    ctx.fillText(text, LOGICAL_W / 2, LOGICAL_H / 2)
    return maskFromCanvas(ctx)
  }

  // dislocated: each glyph drawn on its own, nudged, tilted, rescaled
  const chars = [...text]
  let widths = chars.map((ch) => ctx.measureText(ch).width)
  let total = widths.reduce((a, b) => a + b, 0)
  if (total > maxW) {
    size = Math.floor(size * (maxW / total))
    ctx.font = `${size}px "${fontFamily}"`
    widths = chars.map((ch) => ctx.measureText(ch).width)
    total = widths.reduce((a, b) => a + b, 0)
  }
  ctx.textAlign = 'center'
  let x = (LOGICAL_W - total) / 2
  for (let i = 0; i < chars.length; i++) {
    const dy = (rand() - 0.5) * 2 * dislocation * size * 0.1
    const rot = (rand() - 0.5) * 2 * dislocation * 0.09
    const sc = 1 + (rand() - 0.5) * 2 * dislocation * 0.07
    ctx.save()
    ctx.translate(x + widths[i] / 2, LOGICAL_H / 2 + dy)
    ctx.rotate(rot)
    ctx.scale(sc, sc)
    ctx.fillText(chars[i], 0, 0)
    ctx.restore()
    x += widths[i]
  }
  return maskFromCanvas(ctx)
}

export function buildImageMask(img) {
  const c = document.createElement('canvas')
  c.width = LOGICAL_W
  c.height = LOGICAL_H
  const ctx = c.getContext('2d', { willReadFrequently: true })

  const iw = img.naturalWidth || img.width || 600
  const ih = img.naturalHeight || img.height || 400
  const boxW = LOGICAL_W * 0.62
  const boxH = LOGICAL_H * 0.5
  const s = Math.min(boxW / iw, boxH / ih)
  const dw = iw * s
  const dh = ih * s
  ctx.drawImage(img, (LOGICAL_W - dw) / 2, (LOGICAL_H - dh) / 2, dw, dh)

  const mask = maskFromCanvas(ctx)

  // An SVG with an opaque background rect gives a useless alpha mask —
  // fall back to darkness (1 - luminance) over the drawn box instead.
  const areaDrawn = dw * dh
  if (mask.coverage > areaDrawn * 0.88) {
    return maskFromDarkness(ctx, (LOGICAL_W - dw) / 2, (LOGICAL_H - dh) / 2, dw, dh)
  }
  return mask
}

function maskFromCanvas(ctx) {
  const { width: w, height: h } = ctx.canvas
  const data = ctx.getImageData(0, 0, w, h).data
  const alpha = new Uint8ClampedArray(w * h)
  let coverage = 0
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3]
    alpha[i] = a
    if (a > 128) {
      coverage++
      const x = i % w
      const y = (i / w) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { alpha, w, h, canvas: ctx.canvas, coverage, bbox: { minX, minY, maxX, maxY } }
}

function maskFromDarkness(ctx, bx, by, bw, bh) {
  const { width: w, height: h } = ctx.canvas
  const data = ctx.getImageData(0, 0, w, h).data
  const alpha = new Uint8ClampedArray(w * h)
  let coverage = 0
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let y = by | 0; y < by + bh; y++) {
    for (let x = bx | 0; x < bx + bw; x++) {
      const i = y * w + x
      if (data[i * 4 + 3] < 20) continue
      const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
      const a = 255 - lum
      alpha[i] = a
      if (a > 128) {
        coverage++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const mc = document.createElement('canvas')
  mc.width = w
  mc.height = h
  const mctx = mc.getContext('2d')
  const img = new ImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = 255
    img.data[i * 4 + 1] = 255
    img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = alpha[i]
  }
  mctx.putImageData(img, 0, 0)
  return { alpha, w, h, canvas: mc, coverage, bbox: { minX, minY, maxX, maxY } }
}

// ── skeleton, terminals, tips, counters ────────────────────────────────

const DS = 2 // downsample factor for grid work

export function extractLetterform(mask) {
  const { alpha, w, bbox } = mask
  const pad = 4
  const gx0 = Math.max(0, (bbox.minX / DS - pad) | 0)
  const gy0 = Math.max(0, (bbox.minY / DS - pad) | 0)
  const gw = Math.min((mask.w / DS) | 0, ((bbox.maxX - bbox.minX) / DS + pad * 2) | 0)
  const gh = Math.min((mask.h / DS) | 0, ((bbox.maxY - bbox.minY) / DS + pad * 2) | 0)
  if (gw < 4 || gh < 4) return { terminals: [], stems: [], tips: [], counterSeeds: [] }

  const bin = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const sx = (gx0 + x) * DS
      const sy = (gy0 + y) * DS
      bin[y * gw + x] = alpha[sy * w + sx] > 128 ? 1 : 0
    }
  }

  const dist = chamfer(bin, gw, gh)

  const skel = bin.slice()
  zhangSuen(skel, gw, gh)

  const nbr = (x, y) => {
    let n = 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        if (skel[(y + dy) * gw + (x + dx)]) n++
      }
    return n
  }

  const terminals = []
  const stems = []
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      if (!skel[y * gw + x]) continue
      const n = nbr(x, y)
      if (n === 1) {
        const dir = walkDirection(skel, gw, gh, x, y)
        if (!dir) continue
        terminals.push({
          x: (gx0 + x) * DS,
          y: (gy0 + y) * DS,
          dx: dir.x,
          dy: dir.y,
          thickness: Math.max(2, (dist[y * gw + x] / 3) * DS * 2),
        })
      } else if (n === 2) {
        const t = stemTangent(skel, gw, x, y)
        if (t)
          stems.push({
            x: (gx0 + x) * DS,
            y: (gy0 + y) * DS,
            tx: t.x,
            ty: t.y,
            thickness: Math.max(2, (dist[y * gw + x] / 3) * DS * 2),
          })
      }
    }
  }

  const tips = findTips(mask, dist, gx0, gy0, gw, gh)
  const counterSeeds = findCounters(bin, dist, gw, gh, gx0, gy0)

  return { terminals, stems, tips, counterSeeds }
}

// tip = boundary point whose neighbourhood is mostly outside the shape
function findTips(mask, dist, gx0, gy0, gw, gh) {
  const { alpha, w, h } = mask
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x] > 128
  const cell = 18
  const best = new Map()
  const R = 7
  const win = (2 * R + 1) * (2 * R + 1)
  for (let y = R; y < h - R; y += 2) {
    for (let x = R; x < w - R; x += 2) {
      if (!solid(x, y)) continue
      if (solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1)) continue
      let out = 0, nx = 0, ny = 0
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++)
          if (!solid(x + dx, y + dy)) {
            out++
            nx += dx
            ny += dy
          }
      const outward = out / win
      if (outward < 0.6) continue
      const nlen = Math.hypot(nx, ny)
      if (nlen < 1) continue
      const key = ((x / cell) | 0) * 100000 + ((y / cell) | 0)
      const prev = best.get(key)
      if (!prev || outward > prev.outward) {
        const gxi = Math.min(gw - 1, Math.max(0, ((x / DS) | 0) - gx0))
        const gyi = Math.min(gh - 1, Math.max(0, ((y / DS) | 0) - gy0))
        best.set(key, {
          x, y, outward,
          dx: nx / nlen,
          dy: ny / nlen,
          thickness: Math.max(2, (dist[gyi * gw + gxi] / 3) * DS * 2 + 2),
        })
      }
    }
  }
  return [...best.values()]
}

// counters = enclosed empty regions (the holes of a, e, o); seeds sit on
// the solid rim pointing INTO the hole, with growth bounded by hole size
function findCounters(bin, dist, gw, gh, gx0, gy0) {
  const outside = new Uint8Array(gw * gh)
  const stack = []
  for (let x = 0; x < gw; x++) {
    if (!bin[x]) stack.push(x)
    if (!bin[(gh - 1) * gw + x]) stack.push((gh - 1) * gw + x)
  }
  for (let y = 0; y < gh; y++) {
    if (!bin[y * gw]) stack.push(y * gw)
    if (!bin[y * gw + gw - 1]) stack.push(y * gw + gw - 1)
  }
  while (stack.length) {
    const i = stack.pop()
    if (outside[i] || bin[i]) continue
    outside[i] = 1
    const x = i % gw
    const y = (i / gw) | 0
    if (x > 0) stack.push(i - 1)
    if (x < gw - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - gw)
    if (y < gh - 1) stack.push(i + gw)
  }

  // label enclosed empty regions and measure their areas
  const label = new Int32Array(gw * gh)
  const areas = [0]
  let nId = 0
  for (let i = 0; i < gw * gh; i++) {
    if (bin[i] || outside[i] || label[i]) continue
    nId++
    let area = 0
    const q = [i]
    label[i] = nId
    while (q.length) {
      const j = q.pop()
      area++
      const x = j % gw
      const y = (j / gw) | 0
      for (const k of [j - 1, j + 1, j - gw, j + gw]) {
        if (k < 0 || k >= gw * gh) continue
        const kx = k % gw
        if (Math.abs(kx - x) > 1) continue
        if (!bin[k] && !outside[k] && !label[k]) {
          label[k] = nId
          q.push(k)
        }
      }
    }
    areas.push(area)
  }
  if (!nId) return []

  const seeds = []
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x
      if (!bin[i]) continue
      // solid cell with an enclosed-empty neighbour → rim of a counter
      let id = 0, vx = 0, vy = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = (y + dy) * gw + (x + dx)
          if (label[k]) {
            id = label[k]
            vx += dx
            vy += dy
          }
        }
      if (!id) continue
      const len = Math.hypot(vx, vy)
      if (len < 0.5) continue
      seeds.push({
        x: (gx0 + x) * DS,
        y: (gy0 + y) * DS,
        dx: vx / len,
        dy: vy / len,
        thickness: Math.max(1.5, (dist[i] / 3) * DS),
        maxLen: Math.sqrt(areas[id]) * DS * 1.1,
      })
    }
  }
  return seeds
}

function chamfer(bin, w, h) {
  const INF = 1 << 28
  const d = new Int32Array(w * h)
  for (let i = 0; i < w * h; i++) d[i] = bin[i] ? INF : 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], d[i - w] + 3, d[i - 1] + 3, d[i - w - 1] + 4, d[i - w + 1] + 4)
    }
  for (let y = h - 2; y >= 1; y--)
    for (let x = w - 2; x >= 1; x--) {
      const i = y * w + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], d[i + w] + 3, d[i + 1] + 3, d[i + w + 1] + 4, d[i + w - 1] + 4)
    }
  return d
}

function zhangSuen(g, w, h) {
  let changed = true
  let guard = 100
  while (changed && guard-- > 0) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      const kill = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!g[i]) continue
          const p2 = g[i - w], p3 = g[i - w + 1], p4 = g[i + 1], p5 = g[i + w + 1]
          const p6 = g[i + w], p7 = g[i + w - 1], p8 = g[i - 1], p9 = g[i - w - 1]
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (B < 2 || B > 6) continue
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let A = 0
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++
          if (A !== 1) continue
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0) continue
            if (p4 * p6 * p8 !== 0) continue
          } else {
            if (p2 * p4 * p8 !== 0) continue
            if (p2 * p6 * p8 !== 0) continue
          }
          kill.push(i)
        }
      }
      if (kill.length) changed = true
      for (const i of kill) g[i] = 0
    }
  }
}

function walkDirection(skel, w, h, x0, y0) {
  let cx = x0, cy = y0
  const seen = new Set([y0 * w + x0])
  for (let step = 0; step < 8; step++) {
    let found = false
    for (let dy = -1; dy <= 1 && !found; dy++)
      for (let dx = -1; dx <= 1 && !found; dx++) {
        if (!dx && !dy) continue
        const nx = cx + dx, ny = cy + dy
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
        const ni = ny * w + nx
        if (skel[ni] && !seen.has(ni)) {
          seen.add(ni)
          cx = nx
          cy = ny
          found = true
        }
      }
    if (!found) break
  }
  const vx = x0 - cx
  const vy = y0 - cy
  const len = Math.hypot(vx, vy)
  if (len < 0.5) return null
  return { x: vx / len, y: vy / len }
}

function stemTangent(skel, w, x, y) {
  const pts = []
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      if (skel[(y + dy) * w + (x + dx)]) pts.push({ dx, dy })
    }
  if (pts.length !== 2) return null
  const vx = pts[1].dx - pts[0].dx
  const vy = pts[1].dy - pts[0].dy
  const len = Math.hypot(vx, vy)
  if (len < 0.5) return null
  return { x: vx / len, y: vy / len }
}

// ── tendril growth ─────────────────────────────────────────────────────
// params: { length, wings, depth, splitChance, chaos, flare, curl, taper,
//           sprouts, counters, crownRoot, envelope }
// Growth is collision-aware: a tendril stops when it re-enters the
// letterforms, runs into another tendril's space, or leaves the
// silhouette envelope. Ink also can't turn sharper than its own width —
// per-step turn is clamped by current thickness, which kills the
// self-intersecting outline pockets at thick curls.

function vertMuls(params, dy) {
  const a = params.crownRoot || 0
  const t = Math.max(-1, Math.min(1, dy)) // negative = up
  return {
    len: 1 + a * (t > 0 ? 0.45 * t : 0.35 * t),
    curl: clamp01Mul(1 + a * 0.5 * t),
    split: clamp01Mul(1 + a * 0.3 * t),
  }
}
const clamp01Mul = (m) => Math.max(0.2, m)

// silhouette envelope: the macro-shape all growth must terminate inside
export function makeEnvelope(kind, bbox, glyphH, lengthParam) {
  if (!kind || kind === 'free') return () => true
  const cx = (bbox.minX + bbox.maxX) / 2
  const top = bbox.minY
  const bot = bbox.maxY
  const halfW = Math.max(1, (bbox.maxX - bbox.minX) / 2)
  const R = glyphH * (0.5 + lengthParam * 0.9)
  return (x, y) => {
    const ex = Math.min(1.6, Math.abs(x - cx) / halfW)
    let T, B, X
    if (kind === 'arch') {
      T = R * (1.15 - 0.85 * ex * ex)
      B = R * 0.4 * (1 - 0.3 * ex * ex)
      X = halfW + R * 0.45
    } else if (kind === 'bat-wing') {
      T = R * (0.2 + 0.85 * ex * ex)
      B = R * (0.35 + 0.55 * ex * ex)
      X = halfW + R * 0.9
    } else { // crown
      T = R * (0.3 + 0.7 * Math.abs(Math.sin(((x - cx) / halfW) * Math.PI * 2.2)))
      B = R * 0.35
      X = halfW + R * 0.35
    }
    return Math.abs(x - cx) <= X && y >= top - T && y <= bot + B
  }
}

const OCC = 4 // occupancy cell size in px

export function growTendrils(letterform, mask, params, rand) {
  const branches = []
  let { terminals } = letterform
  const { stems, tips, counterSeeds } = letterform
  if (terminals.length < 8 && tips && tips.length) {
    terminals = terminals.concat(tips.map((t) => ({ ...t, thickness: Math.min(t.thickness, 14) })))
  }
  if (!terminals.length && !stems.length && !counterSeeds.length) return branches

  const glyphH = Math.max(40, mask.bbox.maxY - mask.bbox.minY)
  const cx = (mask.bbox.minX + mask.bbox.maxX) / 2
  const halfW = Math.max(1, (mask.bbox.maxX - mask.bbox.minX) / 2)
  const wing = (x) => lerp(1, lerp(0.55, 2.3, Math.min(1, Math.abs(x - cx) / halfW)), params.wings)

  const field = {
    alpha: mask.alpha,
    mw: mask.w,
    mh: mask.h,
    env: makeEnvelope(params.envelope, mask.bbox, glyphH, params.length),
    occ: new Int32Array(Math.ceil((mask.w / OCC) * (mask.h / OCC)) + mask.w),
    occW: Math.ceil(mask.w / OCC),
    nextId: 1,
  }

  for (const t of terminals) {
    const m = vertMuls(params, t.dy)
    const dp = { ...params, curl: clamp01(params.curl * m.curl), splitChance: clamp01(params.splitChance * m.split) }
    const len = params.length * glyphH * (0.5 + rand() * 0.8) * wing(t.x) * m.len
    const jitter = (rand() - 0.5) * params.chaos * 0.6
    const dir = rotate(t.dx, t.dy, jitter)
    grow(branches, t.x, t.y, dir.x, dir.y, len, t.thickness, params.depth, dp, rand, field)
  }

  if (stems.length && params.sprouts > 0.01) {
    const count = Math.round(lerp(0, Math.min(90, stems.length), params.sprouts * 0.35))
    for (let i = 0; i < count; i++) {
      const s = stems[(rand() * stems.length) | 0]
      const side = rand() < 0.5 ? -1 : 1
      const dir = { x: -s.ty * side, y: s.tx * side }
      const m = vertMuls(params, dir.y)
      const dp = { ...params, curl: clamp01(params.curl * m.curl), splitChance: clamp01(params.splitChance * m.split) }
      const len = params.length * glyphH * (0.15 + rand() * 0.4) * wing(s.x) * m.len
      grow(branches, s.x, s.y, dir.x, dir.y, len, s.thickness * 0.8, Math.max(0, params.depth - 1), dp, rand, field)
    }
  }

  if (counterSeeds.length && params.counters > 0.01) {
    const count = Math.round(params.counters * counterSeeds.length * 0.4)
    const dp = {
      ...params,
      flare: params.flare * 0.2,
      curl: clamp01(params.curl * 1.6 + 0.15),
      splitChance: params.splitChance * 0.4,
      chaos: params.chaos * 0.8,
    }
    for (let i = 0; i < count; i++) {
      const s = counterSeeds[(rand() * counterSeeds.length) | 0]
      const len = Math.min(s.maxLen, params.length * glyphH * 0.22 * (0.4 + rand() * 0.7))
      const jitter = (rand() - 0.5) * 0.5
      const dir = rotate(s.dx, s.dy, jitter)
      grow(branches, s.x, s.y, dir.x, dir.y, len, s.thickness, 1, dp, rand, field)
    }
  }

  return branches
}

function grow(out, x, y, dx, dy, len, w0, depth, params, rand, field) {
  const segLen = 5
  const steps = Math.max(3, Math.round(len / segLen))
  const taperExp = lerp(0.7, 2.4, params.taper)
  const vs = dy < 0 ? -1 : 1
  const bend = (rand() - 0.5) * params.curl * 0.16
  const myId = field.nextId++
  const pts = [{ x, y, w: w0 }]
  let cx = x, cy = y, cdx = dx, cdy = dy
  let escaped = false
  let outside = 0

  const solid = (px, py) => {
    const xi = px | 0
    const yi = py | 0
    if (xi < 1 || yi < 1 || xi >= field.mw - 1 || yi >= field.mh - 1) return false
    return field.alpha[yi * field.mw + xi] > 128
  }

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const w = Math.max(0.4, w0 * Math.pow(1 - t, taperExp))
    // ink can't turn sharper than its width allows: clamp curvature
    const maxTurn = segLen / Math.max(1.4, w * 0.9)
    let turn = (rand() - 0.5) * params.chaos * 0.55 + bend
    turn = Math.max(-maxTurn, Math.min(maxTurn, turn))
    ;({ x: cdx, y: cdy } = rotate(cdx, cdy, turn))
    cdy = cdy + vs * params.flare * 0.1
    const n = Math.hypot(cdx, cdy)
    cdx /= n
    cdy /= n
    const nx = cx + cdx * segLen
    const ny = cy + cdy * segLen

    // silhouette envelope: growth terminates inside the macro-shape
    if (!field.env(nx, ny)) break

    // letterform collision: once out, never wander back across a letter
    const s = solid(nx, ny)
    if (escaped && s) break
    if (!s) {
      outside++
      if (outside >= 2) escaped = true
    }

    // occupancy: stop instead of crossing another tendril
    const ci = ((ny | 0) >> 2) * field.occW + ((nx | 0) >> 2)
    if (ci >= 0 && ci < field.occ.length) {
      const v = field.occ[ci]
      if (i > 3 && v && v !== myId) break
      field.occ[ci] = myId
    }

    cx = nx
    cy = ny
    pts.push({ x: cx, y: cy, w })

    if (depth > 0 && i > 1 && i < steps - 1 && rand() < (params.splitChance * 2.4) / steps) {
      const side = rand() < 0.5 ? -1 : 1
      const branchAngle = side * lerp(0.4, 1.15, rand())
      const bd = rotate(cdx, cdy, branchAngle)
      grow(out, cx, cy, bd.x, bd.y, len * (0.45 + rand() * 0.3), w * 0.7, depth - 1, params, rand, field)
    }
  }
  if (pts.length > 2) out.push({ pts })
}

function rotate(x, y, a) {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: x * c - y * s, y: x * s + y * c }
}

// breakAmt > 0 perturbs the mirrored half — each mirrored branch gets its
// own rotation, length, and weight jitter, and some vanish entirely, so
// the logo reads symmetric at a glance but is never pixel-identical
export function mirrorBranches(branches, cx, breakAmt = 0, rand = null) {
  const out = []
  for (const { pts } of branches) {
    if (breakAmt > 0 && rand && rand() < breakAmt * 0.15) continue
    const m = pts.map((p) => ({ x: 2 * cx - p.x, y: p.y, w: p.w }))
    if (breakAmt > 0 && rand) {
      const o = m[0]
      const rot = (rand() - 0.5) * breakAmt * 0.35
      const sc = 1 + (rand() - 0.5) * breakAmt * 0.5
      const wj = 1 + (rand() - 0.5) * breakAmt * 0.3
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      for (let i = 1; i < m.length; i++) {
        const dx = (m[i].x - o.x) * sc
        const dy = (m[i].y - o.y) * sc
        m[i].x = o.x + dx * c - dy * s
        m[i].y = o.y + dx * s + dy * c
        m[i].w *= wj
      }
    }
    out.push({ pts: m })
  }
  return out
}

// dir: 0 = +x, 1 = −x, 2 = +y (down), 3 = −y (up)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const RIGHT_TURN = [2, 3, 1, 0]
const LEFT_TURN = [3, 2, 0, 1]

export function traceLoops(data, w, h) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 128
  const K = (x, y) => y * (w + 1) + x
  const out = new Map()
  const all = []
  const addEdge = (sx, sy, ex, ey, dir) => {
    const e = { sx, sy, ex, ey, dir, used: false }
    const k = K(sx, sy)
    const arr = out.get(k)
    if (arr) arr.push(e)
    else out.set(k, [e])
    all.push(e)
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue
      if (!solid(x, y - 1)) addEdge(x, y, x + 1, y, 0)
      if (!solid(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1, 1)
      if (!solid(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1, 2)
      if (!solid(x - 1, y)) addEdge(x, y + 1, x, y, 3)
    }
  }

  const loops = []
  for (const first of all) {
    if (first.used) continue
    first.used = true
    const pts = [[first.sx, first.sy]]
    let cur = first
    for (;;) {
      const last = pts[pts.length - 1]
      if (pts.length > 1 && sameDir(pts[pts.length - 2], last, cur)) {
        last[0] = cur.ex
        last[1] = cur.ey
      } else {
        pts.push([cur.ex, cur.ey])
      }
      const candidates = out.get(K(cur.ex, cur.ey))
      let next = null
      if (candidates) {
        const pref = [RIGHT_TURN[cur.dir], cur.dir, LEFT_TURN[cur.dir]]
        for (const want of pref) {
          next = candidates.find((e) => !e.used && e.dir === want)
          if (next) break
        }
      }
      if (!next) break
      next.used = true
      cur = next
    }
    const lastPt = pts[pts.length - 1]
    if (lastPt[0] === pts[0][0] && lastPt[1] === pts[0][1]) pts.pop()
    if (pts.length >= 3) loops.push(pts)
  }
  return loops
}

function sameDir(a, b, edge) {
  const [dx, dy] = DIRS[edge.dir]
  return Math.sign(b[0] - a[0]) === dx && Math.sign(b[1] - a[1]) === dy
}

export function rdp(pts, eps) {
  const n = pts.length
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    let maxD = -1
    let maxI = -1
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > eps) {
      keep[maxI] = 1
      stack.push([a, maxI], [maxI, b])
    }
  }
  const res = []
  for (let i = 0; i < n; i++) if (keep[i]) res.push(pts[i])
  return res
}
