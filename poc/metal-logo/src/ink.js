// Ink — the polygon half of the vector engine, with no font and no canvas
// in it. It lives apart from vector.js so render.worker.js can import it
// without dragging opentype.js (173KB, all of it useless in a worker) along.
//
// Tendril polylines become tapered outlines here; the outlines and the glyph
// polygons are unioned, morphologically closed and speckled with grit by
// Clipper; what comes out is one path string.

import ClipperLib from 'clipper-lib'
import { LOGICAL_W, LOGICAL_H, makeRng, rdp } from './generator.js'

// post-boolean simplification: 0.3px tolerance is invisible at any zoom
// but cuts the dense round-join points Clipper emits
const SIMPLIFY_EPS = 0.3

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
// The half of makeArt with no Path2D in it. A worker builds this and posts it
// back; only the page, which is the only one that draws, pays for the Path2D.
export function artGeometry(rawPolys) {
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
  return { pathString: d, w: LOGICAL_W, h: LOGICAL_H }
}
