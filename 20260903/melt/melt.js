/* melt.js — window.MELT
 *
 * SVG → alpha mask → spatially-varying blur + threshold, a few passes over.
 *
 *   MELT.parseSvg(text)                 -> { text, width, height, minX, minY }
 *   MELT.rasterise(source, longSide)    -> Promise<{ w, h, scale, ox, oy, alpha, ... }>
 *   MELT.field(points, base, w, h)      -> Float32Array   (per-pixel sigma, px)
 *   MELT.render(alpha, w, h, points, o) -> Uint8ClampedArray (binary 0|255)
 *     o = { passes: 1..6, threshold: 0.05..0.95, base: sigma px }
 *
 * NOTE — field() and render() return MODULE-LEVEL CACHES, keyed on w×h, so
 * allocation is paid once and live dragging costs nothing. The buffer you get
 * back is overwritten by the next call at the same size: read it, draw it, or
 * copy it, but don't hold two of them and expect them to differ. (Display and
 * the 2× export pass are different sizes, so those two never collide.)
 *
 * No modules, no imports, no deps. Classic script, one global.
 */
(function () {
  'use strict'

  var MARGIN_FRAC = 0.18 // melt needs room to swell
  var OPAQUE_FRAC = 0.88 // above this, the alpha channel is useless → use darkness
  var MAX_LEVELS = 9 // blur levels per pass (level 0 is the unblurred mask)

  // ── small helpers ──────────────────────────────────────────────────────

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }

  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document.createElement) {
      var c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
    throw new Error('no canvas available')
  }

  function nums(str) {
    if (!str) return null
    var parts = String(str).trim().split(/[\s,]+/)
    var out = []
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue
      var v = parseFloat(parts[i])
      if (!isFinite(v)) return null
      out.push(v)
    }
    return out
  }

  // A length attribute like "800", "800px", "12.5pt". Percentages are unknowable
  // without a viewport, so they read as null.
  function lengthAttr(el, name) {
    var raw = el.getAttribute(name)
    if (!raw) return null
    raw = String(raw).trim()
    if (raw.indexOf('%') >= 0) return null
    var v = parseFloat(raw)
    if (!isFinite(v) || v <= 0) return null
    var unit = raw.replace(/^[-+0-9.eE]+/, '').trim().toLowerCase()
    var per = { '': 1, px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 }
    var k = per[unit]
    return k ? v * k : v
  }

  // ── parseSvg ───────────────────────────────────────────────────────────

  function parseSvg(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Not an SVG')
    var doc
    try {
      doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    } catch (e) {
      throw new Error('Not an SVG')
    }
    if (!doc || !doc.documentElement) throw new Error('Not an SVG')
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Not an SVG')
    var root = doc.documentElement
    var tag = (root.localName || root.nodeName || '').toLowerCase()
    if (tag !== 'svg') throw new Error('Not an SVG')

    var vb = nums(root.getAttribute('viewBox'))
    var width = 0
    var height = 0
    var minx = 0
    var miny = 0

    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      minx = vb[0]
      miny = vb[1]
      width = vb[2]
      height = vb[3]
    } else {
      var aw = lengthAttr(root, 'width')
      var ah = lengthAttr(root, 'height')
      if (aw && ah) {
        width = aw
        height = ah
      } else {
        width = 800
        height = 600
      }
    }

    // Normalise so <img src=blob:> rasterises the same way everywhere.
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    if (root.getElementsByTagNameNS('http://www.w3.org/1999/xlink', '*').length || /xlink:/.test(text)) {
      root.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
    }
    root.setAttribute('viewBox', minx + ' ' + miny + ' ' + width + ' ' + height)
    root.setAttribute('width', String(width))
    root.setAttribute('height', String(height))

    var out
    try {
      out = new XMLSerializer().serializeToString(root)
    } catch (e2) {
      out = text
    }
    // minX/minY travel with the size so callers can map pixels back into the
    // document's own coordinate space, not just its width and height.
    return { text: out, width: width, height: height, minX: minx, minY: miny }
  }

  // ── rasterise ──────────────────────────────────────────────────────────

  function loadSvgImage(svgText) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      var url = URL.createObjectURL(blob)
      var img = new Image()
      img.decoding = 'sync'
      img.onload = function () {
        resolve({ img: img, url: url })
      }
      img.onerror = function () {
        URL.revokeObjectURL(url)
        reject(new Error('Could not rasterise that SVG'))
      }
      img.src = url
    })
  }

  // Port of poc/metal-logo generator.js maskFromCanvas — alpha coverage,
  // plus how much of it is solid and where.
  function maskFromCanvas(ctx) {
    var w = ctx.canvas.width
    var h = ctx.canvas.height
    var data = ctx.getImageData(0, 0, w, h).data
    var n = w * h
    var alpha = new Uint8ClampedArray(n)
    var coverage = 0
    var minX = w
    var minY = h
    var maxX = 0
    var maxY = 0
    for (var i = 0; i < n; i++) {
      var a = data[i * 4 + 3]
      alpha[i] = a
      if (a > 128) {
        coverage++
        var x = i % w
        var y = (i / w) | 0
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    return { alpha: alpha, coverage: coverage, bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } }
  }

  // Port of maskFromDarkness — an SVG with an opaque background rect gives a
  // useless alpha mask, so read ink as (255 − luminance) inside the drawn box.
  function maskFromDarkness(ctx, bx, by, bw, bh) {
    var w = ctx.canvas.width
    var h = ctx.canvas.height
    var data = ctx.getImageData(0, 0, w, h).data
    var alpha = new Uint8ClampedArray(w * h)
    var coverage = 0
    var minX = w
    var minY = h
    var maxX = 0
    var maxY = 0
    var x0 = clamp(bx | 0, 0, w)
    var y0 = clamp(by | 0, 0, h)
    var x1 = clamp(Math.ceil(bx + bw), 0, w)
    var y1 = clamp(Math.ceil(by + bh), 0, h)
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var i = y * w + x
        if (data[i * 4 + 3] < 20) continue
        var lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
        var a = 255 - lum
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
    return { alpha: alpha, coverage: coverage, bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } }
  }

  function rasterise(source, longSide) {
    var side = Math.max(64, Math.round(longSide || 1024))
    var sw = source && source.width > 0 ? source.width : 800
    var sh = source && source.height > 0 ? source.height : 600
    var text = source && source.text ? source.text : null
    if (!text) return Promise.reject(new Error('Not an SVG'))

    var aw, ah
    if (sw >= sh) {
      aw = side
      ah = (side * sh) / sw
    } else {
      ah = side
      aw = (side * sw) / sh
    }
    var margin = Math.round(side * MARGIN_FRAC)
    var w = Math.max(1, Math.round(aw) + margin * 2)
    var h = Math.max(1, Math.round(ah) + margin * 2)
    var scale = aw / sw

    return loadSvgImage(text).then(function (res) {
      try {
        var canvas = makeCanvas(w, h)
        var ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(res.img, margin, margin, aw, ah)

        var mask = maskFromCanvas(ctx)
        var drawn = aw * ah
        var dark = false
        if (mask.coverage > drawn * OPAQUE_FRAC) {
          mask = maskFromDarkness(ctx, margin, margin, aw, ah)
          dark = true
        }
        return {
          w: w,
          h: h,
          scale: scale,
          ox: margin,
          oy: margin,
          aw: aw,
          ah: ah,
          alpha: mask.alpha,
          coverage: mask.coverage,
          bbox: mask.bbox,
          darkness: dark,
        }
      } finally {
        URL.revokeObjectURL(res.url)
      }
    })
  }

  // ── field ──────────────────────────────────────────────────────────────
  //
  // Per-pixel blur sigma, in px. Each point contributes `heat` at its centre
  // falling off with a smoothstep to 0 at `r`; points combine by MAX, and
  // `base` is a uniform floor (also MAX). `stats` records the bounds and peak
  // analytically as we go, so render() never has to scan the field.

  var fieldCache = { w: 0, h: 0, buf: null }
  var stats = { max: 0, x0: 0, y0: 0, x1: -1, y1: -1 }

  function field(points, base, w, h) {
    var n = w * h
    if (fieldCache.w !== w || fieldCache.h !== h || !fieldCache.buf) {
      fieldCache = { w: w, h: h, buf: new Float32Array(n) }
    }
    var f = fieldCache.buf
    var b = base > 0 ? base : 0
    f.fill(b, 0, n)

    var max = b
    var x0 = w
    var y0 = h
    var x1 = -1
    var y1 = -1
    if (b > 0) {
      x0 = 0
      y0 = 0
      x1 = w - 1
      y1 = h - 1
    }

    if (points) {
      for (var p = 0; p < points.length; p++) {
        var pt = points[p]
        if (!pt) continue
        var r = +pt.r
        var heat = +pt.heat
        if (!(r > 0) || !(heat > 0)) continue
        var cx = +pt.x
        var cy = +pt.y
        var px0 = Math.max(0, Math.floor(cx - r))
        var px1 = Math.min(w - 1, Math.ceil(cx + r))
        var py0 = Math.max(0, Math.floor(cy - r))
        var py1 = Math.min(h - 1, Math.ceil(cy + r))
        if (px1 < px0 || py1 < py0) continue
        if (heat > max) max = heat
        if (px0 < x0) x0 = px0
        if (px1 > x1) x1 = px1
        if (py0 < y0) y0 = py0
        if (py1 > y1) y1 = py1

        var r2 = r * r
        var invR = 1 / r
        for (var y = py0; y <= py1; y++) {
          var dy = y - cy
          var dy2 = dy * dy
          if (dy2 > r2) continue
          var row = y * w
          var span = Math.sqrt(r2 - dy2)
          var sx = Math.max(px0, Math.ceil(cx - span))
          var ex = Math.min(px1, Math.floor(cx + span))
          for (var x = sx; x <= ex; x++) {
            var dx = x - cx
            var t = 1 - Math.sqrt(dx * dx + dy2) * invR
            if (t <= 0) continue
            var s = heat * t * t * (3 - 2 * t)
            var i = row + x
            if (s > f[i]) f[i] = s
          }
        }
      }
    }

    stats = { max: max, x0: x0, y0: y0, x1: x1, y1: y1 }
    return f
  }

  // ── render ─────────────────────────────────────────────────────────────
  //
  // Every pass is: spatially-varying gaussian blur of the current mask →
  // threshold → binary → next pass's input.
  //
  // The blur is faked from N levels drawn with `ctx.filter = blur(σ)`, stacked
  // as tiles in ONE canvas so a pass costs exactly one getImageData; per pixel
  // we lerp the two levels bracketing field[i]. getImageData is far and away
  // the most expensive thing here (≈42 ms for a 1024×700×8-tile atlas), so the
  // levels are rendered at 1/q resolution and sampled bilinearly — q is chosen
  // so the smallest level is still ≥ 1 small-space sigma wide, which keeps the
  // upsample error well under the blur's own softness. Level 0 stays full-res
  // and unblurred, so the fringe of a melt point returns to a crisp edge.

  var outCache = { w: 0, h: 0, buf: null }
  var work = { rw: 0, rh: 0, tiles: 0, sw: 0, sh: 0 }
  var tables = { w: 0, h: 0, colI: null, colW: null, rowI: null, rowW: null }

  function ensureOut(w, h) {
    if (outCache.w !== w || outCache.h !== h || !outCache.buf) {
      outCache = { w: w, h: h, buf: new Uint8ClampedArray(w * h) }
    }
    return outCache.buf
  }

  function ensureTables(w, h) {
    if (tables.w !== w || tables.h !== h) {
      tables = {
        w: w,
        h: h,
        colI: new Int32Array(w),
        colW: new Float32Array(w),
        rowI: new Int32Array(h),
        rowW: new Float32Array(h),
      }
    }
    return tables
  }

  function ensureWork(rw, rh, sw, sh, tiles) {
    if (work.rw !== rw || work.rh !== rh) {
      work.src = makeCanvas(rw, rh)
      work.sctx = work.src.getContext('2d', { willReadFrequently: true })
      work.sdata = work.sctx.createImageData(rw, rh)
      var d = work.sdata.data
      for (var i = 0, n = rw * rh; i < n; i++) {
        d[i * 4] = 255
        d[i * 4 + 1] = 255
        d[i * 4 + 2] = 255
      }
      work.rw = rw
      work.rh = rh
      work.sw = 0
      work.tiles = 0
    }
    if (work.sw !== sw || work.sh !== sh) {
      work.small = makeCanvas(sw, sh)
      work.mctx = work.small.getContext('2d')
      work.mctx.imageSmoothingEnabled = true
      work.mctx.imageSmoothingQuality = 'high'
      work.sw = sw
      work.sh = sh
      work.tiles = 0
    }
    if (work.tiles !== tiles) {
      work.atlas = makeCanvas(sw, sh * tiles)
      work.actx = work.atlas.getContext('2d', { willReadFrequently: true })
      work.tiles = tiles
    }
    return work
  }

  function render(alpha, w, h, points, opts) {
    opts = opts || {}
    var passes = clamp(Math.round(opts.passes || 1), 1, 6)
    var thr01 = clamp(opts.threshold == null ? 0.5 : +opts.threshold, 0.02, 0.98)
    var thrByte = thr01 * 255
    var base = opts.base > 0 ? +opts.base : 0
    var n = w * h

    var out = ensureOut(w, h)

    // Threshold the incoming coverage. Outside the melt field that is the whole
    // story: blurring a binary mask with sigma 0 and thresholding it again is a
    // no-op, so those pixels are already final however many passes there are.
    for (var i = 0; i < n; i++) out[i] = alpha[i] >= thrByte ? 255 : 0

    var f = field(points, base, w, h)
    var maxSigma = stats.max
    var bx0 = stats.x0
    var by0 = stats.y0
    var bx1 = stats.x1
    var by1 = stats.y1
    if (maxSigma < 0.35 || bx1 < bx0 || by1 < by0) return out // no field: threshold only

    // Levels. Spacing finer than ~4 sigma units buys nothing you can see once
    // the result is thresholded, and every level is another tile to read back.
    var N = clamp(Math.round(maxSigma / 4) + 2, 3, MAX_LEVELS)
    var tiles = N - 1
    var N1 = N - 1
    var minLevel = maxSigma / N1

    // Region = active box + enough skirt that a blur inside the box only ever
    // reads real pixels.
    var pad = Math.ceil(maxSigma * 3) + 2
    var rx0 = Math.max(0, bx0 - pad)
    var ry0 = Math.max(0, by0 - pad)
    var rx1 = Math.min(w - 1, bx1 + pad)
    var ry1 = Math.min(h - 1, by1 + pad)
    var rw = rx1 - rx0 + 1
    var rh = ry1 - ry0 + 1

    // q: how much to shrink the blur levels before reading them back. The
    // ceiling keeps the smallest level at least ~1 small-space sigma wide, so
    // the bilinear upsample never invents detail the blur hasn't already
    // smoothed away; measured against a full-res reference, q=2 drifts <1% of
    // ink and q=3 <3%, all of it a sub-pixel contour fringe. `_q` is a dev
    // override used by the verification harness.
    var q = clamp(Math.floor(minLevel), 1, 3)
    if (minLevel >= 9) q = 4 // so soft that quarter-res costs nothing you can see
    if (opts._q > 0) q = Math.round(opts._q)
    while (q > 1 && (rw / q < 8 || rh / q < 8)) q--
    var sw = Math.max(2, Math.ceil(rw / q))
    var sh = Math.max(2, Math.ceil(rh / q))

    var W = ensureWork(rw, rh, sw, sh, tiles)
    var sctx = W.sctx
    var mctx = W.mctx
    var actx = W.actx
    var sbuf = W.sdata.data

    var stride = rw * 4
    var srow4 = sw * 4
    var tileBytes = sh * srow4
    var atlasH = sh * tiles

    // Sample position tables: the x part depends only on x, the y part only on
    // y, and neither changes between passes.
    var T = ensureTables(w, h)
    var colI = T.colI
    var colW = T.colW
    var rowI = T.rowI
    var rowW = T.rowW
    var gx, g0, gw
    for (var cx = bx0; cx <= bx1; cx++) {
      gx = (cx - rx0 + 0.5) / q - 0.5
      g0 = Math.floor(gx)
      if (g0 < 0) g0 = 0
      if (g0 > sw - 2) g0 = sw - 2
      gw = gx - g0
      colI[cx] = g0 * 4
      colW[cx] = gw < 0 ? 0 : gw > 1 ? 1 : gw
    }
    for (var cyi = by0; cyi <= by1; cyi++) {
      gx = (cyi - ry0 + 0.5) / q - 0.5
      g0 = Math.floor(gx)
      if (g0 < 0) g0 = 0
      if (g0 > sh - 2) g0 = sh - 2
      gw = gx - g0
      rowI[cyi] = g0 * srow4
      rowW[cyi] = gw < 0 ? 0 : gw > 1 ? 1 : gw
    }

    // Level sigmas, in small-canvas px.
    var sigmas = []
    for (var k = 1; k < N; k++) sigmas.push(Math.max(0.05, (maxSigma * k) / N1 / q))

    // Seed the source canvas over the whole region. The skirt outside the
    // active box never changes again, so only the box is rewritten per pass
    // (fused into the compose loop below).
    for (var sy = 0; sy < rh; sy++) {
      var orow = (ry0 + sy) * w + rx0
      var drow = sy * stride + 3
      for (var sx = 0; sx < rw; sx++) sbuf[drow + sx * 4] = out[orow + sx]
    }

    var invMax = N1 / maxSigma
    var dw = rw / q
    var dh = rh / q

    for (var p = 0; p < passes; p++) {
      // 1. current mask → source canvas (white ink, alpha = mask) → 1/q res
      sctx.putImageData(W.sdata, 0, 0)
      mctx.clearRect(0, 0, sw, sh)
      mctx.drawImage(W.src, 0, 0, rw, rh, 0, 0, dw, dh)

      // 2. blur levels 1..N-1 into tiles of one canvas → one readback
      actx.filter = 'none'
      actx.clearRect(0, 0, sw, atlasH)
      for (var kk = 1; kk < N; kk++) {
        var ty = (kk - 1) * sh
        actx.save()
        actx.beginPath()
        actx.rect(0, ty, sw, sh)
        actx.clip()
        actx.filter = 'blur(' + sigmas[kk - 1].toFixed(3) + 'px)'
        actx.drawImage(W.small, 0, ty)
        actx.restore()
      }
      actx.filter = 'none'
      var data = actx.getImageData(0, 0, sw, atlasH).data

      // 3. per pixel: bilinear-sample the two levels bracketing field[i], lerp,
      //    threshold, and write straight back into next pass's source buffer.
      for (var y = by0; y <= by1; y++) {
        var oBase = y * w
        var sBase = (y - ry0) * stride + 3
        var ri = rowI[y]
        var wy = rowW[y]
        for (var x = bx0; x <= bx1; x++) {
          var oi = oBase + x
          var fs = f[oi]
          var v
          if (fs <= 0) {
            v = out[oi]
          } else {
            var pos = fs * invMax
            if (pos > N1) pos = N1
            var k0 = pos | 0
            var frac = pos - k0
            if (k0 >= N1) {
              k0 = N1 - 1
              frac = 1
            }
            var o = ri + colI[x] + 3
            var wx = colW[x]
            var b1 = k0 * tileBytes + o
            var a1 = data[b1]
            var a2 = data[b1 + 4]
            var a3 = data[b1 + srow4]
            var a4 = data[b1 + srow4 + 4]
            var tA = a1 + (a2 - a1) * wx
            var v1 = tA + (a3 + (a4 - a3) * wx - tA) * wy
            var v0
            if (k0 === 0) {
              v0 = out[oi]
            } else {
              var b0 = b1 - tileBytes
              var c1 = data[b0]
              var c2 = data[b0 + 4]
              var c3 = data[b0 + srow4]
              var c4 = data[b0 + srow4 + 4]
              var tB = c1 + (c2 - c1) * wx
              v0 = tB + (c3 + (c4 - c3) * wx - tB) * wy
            }
            v = v0 + (v1 - v0) * frac
          }
          var bin = v >= thrByte ? 255 : 0
          out[oi] = bin
          sbuf[sBase + (x - rx0) * 4] = bin
        }
      }
    }

    return out
  }

  window.MELT = {
    parseSvg: parseSvg,
    rasterise: rasterise,
    field: field,
    render: render,
    MARGIN_FRAC: MARGIN_FRAC,
    MAX_LEVELS: MAX_LEVELS,
    _stats: function () {
      return stats
    },
  }
})()
