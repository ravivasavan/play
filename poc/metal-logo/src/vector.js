// Vector engine — the drawing IS vector, end to end.
//
//   glyphs: real outlines from the font files (opentype.js), flattened to
//     fine polygons; per-glyph dislocation applied as a point transform
//   tendrils: growth polylines are Chaikin-smoothed, then offset into
//     tapered outline polygons with round start caps
//   ink: polygon boolean ops (Clipper) — union of everything, then a
//     round-join dilate/erode (morphological closing) that melts nearby
//     strokes together GEOMETRICALLY; grit is subtracted as tiny polygons
//   output: one path string — drawn to canvas via Path2D on screen and
//     written verbatim into the exported SVG. No raster step anywhere in
//     the drawing; the only raster left is the analysis mask that finds
//     stroke terminals.

import opentype from 'opentype.js'
import ClipperLib from 'clipper-lib'
import { LOGICAL_W, LOGICAL_H, makeRng, traceLoops, rdp } from './generator.js'

// post-boolean simplification: 0.3px tolerance is invisible at any zoom
// but cuts the dense round-join points Clipper emits
const SIMPLIFY_EPS = 0.3

const BASE = import.meta.env.BASE_URL || '/'
const FONT_FILES = {
  'Metal Mania': BASE + 'fonts/MetalMania-Regular.ttf',
  'Pirata One': BASE + 'fonts/PirataOne-Regular.ttf',
  'UnifrakturCook': BASE + 'fonts/UnifrakturCook-Bold.ttf',
}
export const FONT_NAMES = Object.keys(FONT_FILES)

const fonts = {}
let fontsPromise = null
export function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all(
      Object.entries(FONT_FILES).map(async ([name, url]) => {
        const buf = await fetch(url).then((r) => {
          if (!r.ok) throw new Error(`font ${url}: ${r.status}`)
          return r.arrayBuffer()
        })
        fonts[name] = opentype.parse(buf)
      })
    )
  }
  return fontsPromise
}

// ── glyph geometry ─────────────────────────────────────────────────────

function flattenCommands(commands) {
  const polys = []
  let poly = null
  let sx = 0, sy = 0, cx = 0, cy = 0
  for (const c of commands) {
    if (c.type === 'M') {
      if (poly && poly.length > 2) polys.push(poly)
      poly = [[c.x, c.y]]
      sx = cx = c.x
      sy = cy = c.y
    } else if (c.type === 'L') {
      poly.push([c.x, c.y])
      cx = c.x
      cy = c.y
    } else if (c.type === 'Q') {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8
        const u = 1 - t
        poly.push([
          u * u * cx + 2 * u * t * c.x1 + t * t * c.x,
          u * u * cy + 2 * u * t * c.y1 + t * t * c.y,
        ])
      }
      cx = c.x
      cy = c.y
    } else if (c.type === 'C') {
      for (let i = 1; i <= 12; i++) {
        const t = i / 12
        const u = 1 - t
        poly.push([
          u * u * u * cx + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * cy + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        ])
      }
      cx = c.x
      cy = c.y
    } else if (c.type === 'Z') {
      if (poly && poly.length > 2) polys.push(poly)
      poly = null
      cx = sx
      cy = sy
    }
  }
  if (poly && poly.length > 2) polys.push(poly)
  return polys
}

export function textGeometry(text, fontName, fontSize, dislocation = 0, rand = null) {
  const font = fonts[fontName] || fonts[FONT_NAMES[0]]
  if (!font) return null
  let size = fontSize
  const maxW = LOGICAL_W * 0.8
  const total0 = font.getAdvanceWidth(text, size)
  if (total0 > maxW) size = (size * maxW) / total0

  const chars = [...text]
  const items = []
  let x = 0
  for (const ch of chars) {
    const w = font.getAdvanceWidth(ch, size)
    items.push({ ch, x, w })
    x += w
  }

  let polys = []
  for (const it of items) {
    const path = font.getPath(it.ch, it.x, 0, size)
    let ps = flattenCommands(path.commands)
    if (dislocation > 0.01 && rand) {
      const dy = (rand() - 0.5) * 2 * dislocation * size * 0.1
      const rot = (rand() - 0.5) * 2 * dislocation * 0.09
      const sc = 1 + (rand() - 0.5) * 2 * dislocation * 0.07
      const gx = it.x + it.w / 2
      const gy = -size * 0.32
      const cos = Math.cos(rot)
      const sin = Math.sin(rot)
      ps = ps.map((poly) =>
        poly.map(([px, py]) => {
          const dx0 = (px - gx) * sc
          const dy0 = (py - gy) * sc
          return [gx + dx0 * cos - dy0 * sin, gy + dy + dx0 * sin + dy0 * cos]
        })
      )
    }
    polys = polys.concat(ps)
  }
  if (!polys.length) return null

  // centre the whole wordmark on the logical canvas
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
  for (const poly of polys)
    for (const [px, py] of poly) {
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  const tx = LOGICAL_W / 2 - (minX + maxX) / 2
  const ty = LOGICAL_H / 2 - (minY + maxY) / 2
  return polys.map((poly) => poly.map(([px, py]) => [px + tx, py + ty]))
}

// ── uploaded SVG geometry ──────────────────────────────────────────────
// Vectorised once at 2× supersample: trace, simplify, Chaikin-smooth.

export function imageGeometry(img) {
  const SS = 2
  const w = LOGICAL_W * SS
  const h = LOGICAL_H * SS
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const iw = img.naturalWidth || img.width || 600
  const ih = img.naturalHeight || img.height || 400
  const boxW = w * 0.62
  const boxH = h * 0.5
  const s = Math.min(boxW / iw, boxH / ih)
  const dw = iw * s
  const dh = ih * s
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
  let data = ctx.getImageData(0, 0, w, h).data

  // opaque-background SVGs: rebuild alpha from darkness
  let coverage = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 128) coverage++
  if (coverage > dw * dh * 0.88) {
    const img2 = ctx.getImageData(0, 0, w, h)
    for (let i = 0; i < w * h; i++) {
      const a = img2.data[i * 4 + 3]
      if (a < 20) {
        img2.data[i * 4 + 3] = 0
        continue
      }
      const lum =
        0.299 * img2.data[i * 4] + 0.587 * img2.data[i * 4 + 1] + 0.114 * img2.data[i * 4 + 2]
      img2.data[i * 4 + 3] = 255 - lum
    }
    data = img2.data
  }

  const loops = traceLoops(data, w, h)
  const polys = []
  for (const loop of loops) {
    let pts = loop.length > 6 ? rdp(loop, 1.5) : loop
    if (pts.length < 3) continue
    pts = chaikinClosed(pts, 2)
    polys.push(pts.map(([px, py]) => [px / SS, py / SS]))
  }
  return polys
}

function chaikinClosed(pts, iters) {
  let cur = pts
  for (let k = 0; k < iters; k++) {
    const out = []
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i]
      const b = cur[(i + 1) % cur.length]
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]])
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]])
    }
    cur = out
  }
  return cur
}

// ── tendril outlines ───────────────────────────────────────────────────
// growth polyline {x,y,w} → Chaikin-smoothed → offset both sides by w/2
// → closed polygon with a round start cap and a pointed tip

function chaikinOpen(pts, iters) {
  let cur = pts
  for (let k = 0; k < iters; k++) {
    if (cur.length < 3) return cur
    const out = [cur[0]]
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i]
      const b = cur[i + 1]
      out.push({
        x: 0.75 * a.x + 0.25 * b.x,
        y: 0.75 * a.y + 0.25 * b.y,
        w: 0.75 * a.w + 0.25 * b.w,
      })
      out.push({
        x: 0.25 * a.x + 0.75 * b.x,
        y: 0.25 * a.y + 0.75 * b.y,
        w: 0.25 * a.w + 0.75 * b.w,
      })
    }
    out.push(cur[cur.length - 1])
    cur = out
  }
  return cur
}

export function branchOutline(branch) {
  const pts = chaikinOpen(branch.pts, 2)
  if (pts.length < 2) return null
  const left = []
  const right = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    let tx = b.x - a.x
    let ty = b.y - a.y
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    const hw = Math.max(0.35, pts[i].w / 2)
    left.push([pts[i].x - ty * hw, pts[i].y + tx * hw])
    right.push([pts[i].x + ty * hw, pts[i].y - tx * hw])
  }
  // round start cap: arc from right[0] to left[0] behind the first point
  const p0 = pts[0]
  const hw0 = Math.max(0.15, p0.w / 2)
  let bx = pts[0].x - (pts[1].x - pts[0].x)
  let by = pts[0].y - (pts[1].y - pts[0].y)
  const bl = Math.hypot(bx - p0.x, by - p0.y) || 1
  const ux = (bx - p0.x) / bl
  const uy = (by - p0.y) / bl
  const cap = []
  for (let k = 1; k <= 5; k++) {
    const a = (k / 6 - 0.5) * Math.PI
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    // rotate the backward unit vector to sweep the semicircle
    cap.push([p0.x + (ux * ca - uy * sa) * hw0, p0.y + (ux * sa + uy * ca) * hw0])
  }
  const tip = pts[pts.length - 1]
  return [...right.slice().reverse(), ...cap, ...left, [tip.x, tip.y]]
}

// ── vector ink (Clipper) ───────────────────────────────────────────────

const SCALE = 100

const toClip = (polys) =>
  polys.map((p) => p.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })))
const fromClip = (paths) => paths.map((p) => p.map((pt) => [pt.X / SCALE, pt.Y / SCALE]))

function union(paths) {
  const c = new ClipperLib.Clipper()
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const out = new ClipperLib.Paths()
  c.Execute(
    ClipperLib.ClipType.ctUnion, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero
  )
  return out
}

function offset(paths, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE)
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const out = new ClipperLib.Paths()
  co.Execute(out, delta)
  return out
}

function difference(subj, clip) {
  const c = new ClipperLib.Clipper()
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true)
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  const out = new ClipperLib.Paths()
  c.Execute(
    ClipperLib.ClipType.ctDifference, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero
  )
  return out
}

export function inkVector(polys, ink) {
  let paths = union(toClip(polys))
  if (ink.bleed > 0.05) {
    // The raster blur+threshold did three things at once; reproduce each
    // geometrically. OPEN kills hairs thinner than the ink could hold
    // (what a high threshold used to eat); CLOSE melts nearby strokes
    // together; a net offset fattens or thins overall (what a low or
    // high threshold used to do).
    const openR = ink.bleed * ink.threshold * 0.8
    const closeR = ink.bleed
    const net = ink.bleed * (1 - 2 * ink.threshold) * 1.5
    // erode(open) → dilate(open+close) → erode(close−net): three passes
    // give open, then close, then the net thicken/thin
    if (openR > 0.01) paths = offset(paths, -openR * SCALE)
    paths = offset(paths, (openR + closeR) * SCALE)
    paths = offset(paths, -(closeR - net) * SCALE)
  }
  if (ink.grit > 0.01) {
    paths = difference(paths, gritPolys(ink.grit, ink.gritSeed))
  }
  return fromClip(dropDust(paths))
}

// floating dust: tiny disconnected outer islands read as artifacts —
// drop them, but keep small holes (that's the grit speckle)
function dropDust(paths) {
  if (!paths.length) return paths
  let maxA = 0
  for (const p of paths) {
    const a = ClipperLib.Clipper.Area(p)
    if (Math.abs(a) > Math.abs(maxA)) maxA = a
  }
  const outerSign = Math.sign(maxA)
  const minArea = 14 * SCALE * SCALE
  return paths.filter((p) => {
    const a = ClipperLib.Clipper.Area(p)
    return Math.sign(a) !== outerSign || Math.abs(a) >= minArea
  })
}

function gritPolys(grit, seed) {
  const rand = makeRng(seed)
  const n = Math.round(grit * 1200)
  const out = []
  for (let i = 0; i < n; i++) {
    const cx = rand() * LOGICAL_W * SCALE
    const cy = rand() * LOGICAL_H * SCALE
    const r = (0.6 + rand() * grit * 2.4) * SCALE
    const sides = 3 + ((rand() * 3) | 0)
    const rot = rand() * Math.PI
    const poly = []
    for (let k = 0; k < sides; k++) {
      const a = rot + (k / sides) * Math.PI * 2
      poly.push({
        X: Math.round(cx + Math.cos(a) * r * (0.7 + rand() * 0.6)),
        Y: Math.round(cy + Math.sin(a) * r * (0.7 + rand() * 0.6)),
      })
    }
    out.push(poly)
  }
  return out
}

// ── art object, blit, export ───────────────────────────────────────────

export function makeArt(rawPolys) {
  const polys = rawPolys.map((p) => (p.length > 8 ? rdp(p, SIMPLIFY_EPS) : p)).filter((p) => p.length >= 3)
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
  for (const poly of polys)
    for (const [px, py] of poly) {
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  if (minX > maxX) return null
  const margin = 30
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const fit = Math.min((LOGICAL_W - margin * 2) / bw, (LOGICAL_H - margin * 2) / bh, 1.6)
  const ox = (LOGICAL_W - bw * fit) / 2 - minX * fit
  const oy = (LOGICAL_H - bh * fit) / 2 - minY * fit

  let d = ''
  for (const poly of polys) {
    d += `M${(poly[0][0] * fit + ox).toFixed(2)} ${(poly[0][1] * fit + oy).toFixed(2)}`
    for (let i = 1; i < poly.length; i++) {
      d += `L${(poly[i][0] * fit + ox).toFixed(2)} ${(poly[i][1] * fit + oy).toFixed(2)}`
    }
    d += 'Z'
  }
  return { pathString: d, path2d: new Path2D(d), w: LOGICAL_W, h: LOGICAL_H }
}

// colors: { bg, fg } — resolved from the page theme so the canvas follows
// day / night / system / circadian like the rest of the family
export function blit(targetCanvas, art, colors, pixelRatio) {
  const cssW = targetCanvas.clientWidth
  if (!cssW) return // hidden (other view mode) — skip, re-blit on show
  const ctx = targetCanvas.getContext('2d')
  const dpr = pixelRatio || Math.min(2, window.devicePixelRatio || 1)
  const cssH = targetCanvas.clientHeight || (cssW * LOGICAL_H) / LOGICAL_W
  targetCanvas.width = Math.round(cssW * dpr)
  targetCanvas.height = Math.round(cssH * dpr)
  const s = Math.min(cssW / art.w, cssH / art.h)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, cssW, cssH)
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cssW - art.w * s) / 2, dpr * (cssH - art.h * s) / 2)
  ctx.fillStyle = colors.fg
  ctx.fill(art.path2d, 'nonzero')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

export function svgString(art, colors, transparent = true) {
  const fg = colors.fg
  const bg = colors.bg
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.w} ${art.h}">` +
    (transparent ? '' : `<rect width="${art.w}" height="${art.h}" fill="${bg}"/>`) +
    `<path d="${art.pathString}" fill="${fg}" fill-rule="nonzero"/>` +
    `</svg>`
  )
}

export function exportSvg(art, colors, transparent, name) {
  const svg = svgString(art, colors, transparent)
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name || 'metal-logo'}.svg`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// analysis mask: rasterise the glyph polys once — raster exists ONLY to
// find terminals/tips/counters, never to draw
export function rasterizeForAnalysis(polys) {
  const c = document.createElement('canvas')
  c.width = LOGICAL_W
  c.height = LOGICAL_H
  const ctx = c.getContext('2d', { willReadFrequently: true })
  let d = ''
  for (const poly of polys) {
    d += `M${poly[0][0]} ${poly[0][1]}`
    for (let i = 1; i < poly.length; i++) d += `L${poly[i][0]} ${poly[i][1]}`
    d += 'Z'
  }
  ctx.fillStyle = '#fff'
  ctx.fill(new Path2D(d), 'nonzero')
  return maskFromCtx(ctx)
}

function maskFromCtx(ctx) {
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
