// trace.js — window.TRACE: contour tracing + simplification + SVG export.
// Pure JS, no DOM. Works as a classic browser script (window.TRACE) and
// under node (module.exports) so it can be unit-tested.
//
// Ported from poc/metal-logo/src/generator.js (traceLoops / sameDir / rdp,
// lines ~680-800), adapted to read a 1-channel coverage array instead of
// RGBA (data[(y*w+x)*4+3] -> data[y*w+x]).

;(function (root) {
  'use strict'

  // dir: 0 = +x, 1 = -x, 2 = +y (down), 3 = -y (up)
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  var RIGHT_TURN = [2, 3, 1, 0]
  var LEFT_TURN = [3, 2, 0, 1]

  // TRACE.loops(binary, w, h) -> Array<Array<[x, y]>>
  function loops(binary, w, h) {
    var solid = function (x, y) {
      return x >= 0 && y >= 0 && x < w && y < h && binary[y * w + x] > 127
    }
    var K = function (x, y) { return y * (w + 1) + x }
    var out = new Map()
    var all = []
    var addEdge = function (sx, sy, ex, ey, dir) {
      var e = { sx: sx, sy: sy, ex: ex, ey: ey, dir: dir, used: false }
      var k = K(sx, sy)
      var arr = out.get(k)
      if (arr) arr.push(e)
      else out.set(k, [e])
      all.push(e)
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!solid(x, y)) continue
        if (!solid(x, y - 1)) addEdge(x, y, x + 1, y, 0)
        if (!solid(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1, 1)
        if (!solid(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1, 2)
        if (!solid(x - 1, y)) addEdge(x, y + 1, x, y, 3)
      }
    }

    var result = []
    for (var i = 0; i < all.length; i++) {
      var first = all[i]
      if (first.used) continue
      first.used = true
      var pts = [[first.sx, first.sy]]
      var cur = first
      for (;;) {
        var last = pts[pts.length - 1]
        if (pts.length > 1 && sameDir(pts[pts.length - 2], last, cur)) {
          last[0] = cur.ex
          last[1] = cur.ey
        } else {
          pts.push([cur.ex, cur.ey])
        }
        var candidates = out.get(K(cur.ex, cur.ey))
        var next = null
        if (candidates) {
          var pref = [RIGHT_TURN[cur.dir], cur.dir, LEFT_TURN[cur.dir]]
          for (var p = 0; p < pref.length; p++) {
            var want = pref[p]
            next = null
            for (var c = 0; c < candidates.length; c++) {
              if (!candidates[c].used && candidates[c].dir === want) { next = candidates[c]; break }
            }
            if (next) break
          }
        }
        if (!next) break
        next.used = true
        cur = next
      }
      var lastPt = pts[pts.length - 1]
      if (lastPt[0] === pts[0][0] && lastPt[1] === pts[0][1]) pts.pop()
      if (pts.length >= 3) result.push(pts)
    }
    return result
  }

  function sameDir(a, b, edge) {
    var d = DIRS[edge.dir]
    return Math.sign(b[0] - a[0]) === d[0] && Math.sign(b[1] - a[1]) === d[1]
  }

  // Douglas-Peucker on an OPEN chain (endpoints always kept).
  function rdp(pts, eps) {
    var n = pts.length
    var keep = new Uint8Array(n)
    keep[0] = keep[n - 1] = 1
    var stack = [[0, n - 1]]
    while (stack.length) {
      var pair = stack.pop()
      var a = pair[0], b = pair[1]
      if (b - a < 2) continue
      var ax = pts[a][0], ay = pts[a][1]
      var bx = pts[b][0], by = pts[b][1]
      var dx = bx - ax
      var dy = by - ay
      var len = Math.hypot(dx, dy) || 1
      var maxD = -1
      var maxI = -1
      for (var i = a + 1; i < b; i++) {
        var d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len
        if (d > maxD) { maxD = d; maxI = i }
      }
      if (maxD > eps) {
        keep[maxI] = 1
        stack.push([a, maxI], [maxI, b])
      }
    }
    var res = []
    for (var k = 0; k < n; k++) if (keep[k]) res.push(pts[k])
    return res
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]) }

  function perpDist(a, b, p) {
    var dx = b[0] - a[0]
    var dy = b[1] - a[1]
    var len = Math.hypot(dx, dy) || 1
    return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len
  }

  // The raw trace can start a loop mid-edge (wherever the first unused
  // edge happened to fall), so the two forced Douglas-Peucker anchors
  // below aren't guaranteed to be real corners. This final pass walks the
  // closed ring and drops any vertex that's collinear (within eps) with
  // its two neighbours, wraparound included.
  function pruneCollinearClosed(pts, eps) {
    var cur = pts.slice()
    var changed = true
    while (changed && cur.length > 3) {
      changed = false
      for (var i = 0; i < cur.length; i++) {
        var n = cur.length
        var prev = cur[(i - 1 + n) % n]
        var next = cur[(i + 1) % n]
        if (perpDist(prev, next, cur[i]) <= eps) {
          cur.splice(i, 1)
          changed = true
          break
        }
      }
    }
    return cur
  }

  // Closed-loop-aware Douglas-Peucker: split the loop at the point
  // farthest from pts[0], run open rdp on each half (each anchored at
  // both ends), splice the two simplified chains back together, then
  // prune any remaining collinear seam vertices (see above).
  function rdpClosed(pts, eps) {
    var n = pts.length
    if (n < 3) return pts.slice()
    var maxD = -1
    var maxI = 0
    for (var i = 1; i < n; i++) {
      var d = dist(pts[0], pts[i])
      if (d > maxD) { maxD = d; maxI = i }
    }
    var merged
    if (maxI === 0) {
      merged = pts.slice()
    } else {
      var chain1 = pts.slice(0, maxI + 1)
      var chain2 = pts.slice(maxI).concat([pts[0]])
      var r1 = chain1.length > 2 ? rdp(chain1, eps) : chain1
      var r2 = chain2.length > 2 ? rdp(chain2, eps) : chain2
      merged = r1.slice(0, -1).concat(r2.slice(0, -1))
    }
    return pruneCollinearClosed(merged, eps)
  }

  // TRACE.simplify(loops, eps) -> loops
  function simplify(inputLoops, eps) {
    var out = []
    for (var i = 0; i < inputLoops.length; i++) {
      var loop = inputLoops[i]
      var simplified = loop.length > 2 ? rdpClosed(loop, eps) : loop.slice()
      if (simplified.length >= 3) out.push(simplified)
    }
    return out
  }

  function fmtNum(n) {
    var r = Math.round(n * 100) / 100
    if (Object.is(r, -0)) r = 0
    var s = r.toFixed(2)
    // trim trailing zeros, then a trailing dot
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    return s
  }

  // TRACE.pathData(loops, transform) -> string
  // transform = { scale, dx, dy }: out = (p + [dx,dy]) * scale
  function pathData(inputLoops, transform) {
    var scale = (transform && transform.scale != null) ? transform.scale : 1
    var dx = (transform && transform.dx != null) ? transform.dx : 0
    var dy = (transform && transform.dy != null) ? transform.dy : 0
    var parts = []
    for (var i = 0; i < inputLoops.length; i++) {
      var loop = inputLoops[i]
      if (!loop.length) continue
      var seg = []
      for (var j = 0; j < loop.length; j++) {
        var x = (loop[j][0] + dx) * scale
        var y = (loop[j][1] + dy) * scale
        seg.push(fmtNum(x) + ' ' + fmtNum(y))
      }
      parts.push('M ' + seg[0] + ' L ' + seg.slice(1).join(' L ') + ' Z')
    }
    return parts.join(' ')
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // TRACE.svg({ loops, transform, viewBox: [x, y, w, h], fill, background }) -> string
  function svg(opts) {
    opts = opts || {}
    var vb = opts.viewBox || [0, 0, 0, 0]
    var vx = vb[0], vy = vb[1], vw = vb[2], vh = vb[3]
    var d = pathData(opts.loops || [], opts.transform || {})
    var fill = opts.fill || '#000'
    var out = []
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + fmtNum(vx) + ' ' + fmtNum(vy) + ' ' + fmtNum(vw) + ' ' + fmtNum(vh) + '" width="' + fmtNum(vw) + '" height="' + fmtNum(vh) + '">')
    if (opts.background) {
      out.push('<rect x="' + fmtNum(vx) + '" y="' + fmtNum(vy) + '" width="' + fmtNum(vw) + '" height="' + fmtNum(vh) + '" fill="' + escAttr(opts.background) + '"/>')
    }
    out.push('<path fill-rule="evenodd" fill="' + escAttr(fill) + '" d="' + d + '"/>')
    out.push('</svg>')
    return out.join('')
  }

  var TRACE = {
    loops: loops,
    simplify: simplify,
    pathData: pathData,
    svg: svg,
    // exposed for tests / internal reuse
    rdp: rdp,
    sameDir: sameDir,
    pruneCollinearClosed: pruneCollinearClosed
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TRACE
  }
  if (root) {
    root.TRACE = TRACE
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this))
