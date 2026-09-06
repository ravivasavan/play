import { useEffect, useRef, useState } from 'react'
import { useDialKitController } from 'dialkit'
import { extractLetterform, growTendrils, mirrorBranches, makeRng } from './generator.js'
import {
  loadFont,
  FONT_NAMES,
  textGeometry,
  imageGeometry,
  blit,
  svgString,
  exportSvg,
  rasterizeForAnalysis,
} from './vector.js'

const FONTS = FONT_NAMES
const ENVELOPES = ['free', 'arch', 'bat-wing', 'crown']
const BASE = import.meta.env.BASE_URL || '/'

// The legibility dial has four named stops, each a whole parameter mix —
// the genre's own spectrum, with its exemplars.
const STOPS = {
  'Readable but cold': { // Darkthrone
    growth: { length: 0.45, wings: 0.3, depth: 2, splitChance: 0.25, chaos: 0.3, flare: 0.4, curl: 0.15, taper: 0.9, sprouts: 0.05, counters: 0.05, crownRoot: 0.5, symBreak: 0.2, envelope: 'free' },
    ink: { bleed: 1.2, threshold: 0.45, grit: 0.2 },
    dislocation: 0.05, symmetry: false,
  },
  'Unstable': { // Mayhem
    growth: { length: 0.8, wings: 0.4, depth: 3, splitChance: 0.45, chaos: 0.8, flare: 0.35, curl: 0.5, taper: 0.8, sprouts: 0.2, counters: 0.2, crownRoot: 0.4, symBreak: 0.5, envelope: 'free' },
    ink: { bleed: 2.0, threshold: 0.4, grit: 0.45 },
    dislocation: 0.8, symmetry: false,
  },
  'Breaking point': { // early Immortal
    growth: { length: 1.1, wings: 0.6, depth: 4, splitChance: 0.55, chaos: 0.55, flare: 0.5, curl: 0.35, taper: 0.85, sprouts: 0.15, counters: 0.3, crownRoot: 0.6, symBreak: 0.35, envelope: 'bat-wing' },
    ink: { bleed: 2.4, threshold: 0.42, grit: 0.3 },
    dislocation: 0.25, symmetry: false,
  },
  'Total sigil': { // Xasthur / Leviathan
    growth: { length: 1.7, wings: 0.8, depth: 5, splitChance: 0.7, chaos: 0.7, flare: 0.6, curl: 0.5, taper: 0.8, sprouts: 0.45, counters: 0.7, crownRoot: 0.7, symBreak: 0.25, envelope: 'arch' },
    ink: { bleed: 3.4, threshold: 0.38, grit: 0.35 },
    dislocation: 0.35, symmetry: true,
  },
}

const RANGES = {
  length: [0.1, 3], wings: [0, 1], depth: [0, 6], splitChance: [0, 1],
  chaos: [0, 1], flare: [0, 1], curl: [0, 1], taper: [0, 1],
  sprouts: [0, 1], counters: [0, 1], crownRoot: [0, 1], symBreak: [0, 1], dislocation: [0, 1],
  bleed: [0, 10], threshold: [0.05, 0.95], grit: [0, 1],
}

let seedCounter = (Math.random() * 1e9) | 0
const nextSeed = () => (seedCounter = (seedCounter + 0x9e3779b9) >>> 0)

function genomeFromStop(stop, seed) {
  const s = STOPS[stop] || STOPS['Breaking point']
  return {
    seed,
    dislocation: s.dislocation,
    symmetry: s.symmetry,
    growth: { ...s.growth },
    ink: { ...s.ink },
  }
}

function mutateNum(v, [min, max], strength, rand) {
  const span = max - min
  const nv = v + (rand() * 2 - 1) * strength * span * 0.35
  return Math.min(max, Math.max(min, nv))
}

// seedOnly: same recipe, different dice — two of the eight children
function mutate(parent, strength, rand, seedOnly = false) {
  const child = {
    seed: nextSeed(),
    dislocation: parent.dislocation,
    symmetry: parent.symmetry,
    growth: { ...parent.growth },
    ink: { ...parent.ink },
  }
  if (seedOnly) return child
  for (const k of Object.keys(child.growth)) {
    if (typeof child.growth[k] !== 'number') continue
    child.growth[k] = mutateNum(child.growth[k], RANGES[k], strength, rand)
  }
  child.growth.depth = Math.round(child.growth.depth)
  if (rand() < strength * 0.3) child.growth.envelope = ENVELOPES[(rand() * ENVELOPES.length) | 0]
  for (const k of Object.keys(child.ink)) {
    child.ink[k] = mutateNum(child.ink[k], RANGES[k], strength, rand)
  }
  child.dislocation = mutateNum(child.dislocation, RANGES.dislocation, strength * 0.7, rand)
  if (rand() < strength * 0.15) child.symmetry = !child.symmetry
  return child
}

function makeBrood(base, strength) {
  const rand = makeRng(nextSeed())
  return Array.from({ length: 9 }, (_, i) => {
    if (i === 4) return { ...base, growth: { ...base.growth }, ink: { ...base.ink } }
    return mutate(base, strength, rand, i === 0 || i === 8)
  })
}

function genomesMatch(g, variant, ink, symmetry) {
  for (const k of Object.keys(g.growth)) {
    if (typeof g.growth[k] === 'string') {
      if (g.growth[k] !== variant[k]) return false
    } else if (Math.abs(g.growth[k] - variant[k]) > 1e-6) return false
  }
  if (Math.abs(g.dislocation - variant.dislocation) > 1e-6) return false
  for (const k of Object.keys(g.ink)) {
    if (Math.abs(g.ink[k] - ink[k]) > 1e-6) return false
  }
  return g.symmetry === symmetry
}

function loadSvgFile(file, done) {
  if (!file) return
  if (!/svg/i.test(file.type) && !/\.svg$/i.test(file.name)) return
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => done({ img, name: file.name.replace(/\.svg$/i, ''), stamp: Date.now() })
  img.src = url
}

function readThemeColors() {
  const cs = getComputedStyle(document.body)
  return { bg: cs.backgroundColor, fg: cs.color }
}

const DEFAULT_STOP = 'Breaking point'
const WORLD_W = 1180
const CELL_H = ((WORLD_W - 20) / 3) * (800 / 1400)
const GRID_H = CELL_H * 3 + 20
const SINGLE_H = WORLD_W * (800 / 1400)

export default function App() {
  const cellRefs = useRef([])
  const singleRef = useRef(null)
  const viewportRef = useRef(null)
  const worldRef = useRef(null)
  const view = useRef({ x: 0, y: 0, z: 1 })
  const suppressClick = useRef(false)
  const zoomBlitTimer = useRef(null)
  const squintRef = useRef(null)
  const fileRef = useRef(null)
  const artRefs = useRef({}) // idx -> vector art object
  const maskCache = useRef(new Map())
  const lfCache = useRef(new WeakMap())
  const historyRef = useRef([])
  const renderToken = useRef(0)
  const lastCellKey = useRef({})
  const colorsRef = useRef({ bg: '#0d1b1e', fg: '#fff5f5' })

  const [brood, setBrood] = useState(() => makeBrood(genomeFromStop(DEFAULT_STOP, nextSeed()), 0.45))
  const [sel, setSel] = useState(4)
  const [mode, setMode] = useState('grid') // 'grid' | 'single'
  const [svg, setSvg] = useState(null)
  const [loadedFont, setLoadedFont] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [svgDump, setSvgDump] = useState(null)

  // refs mirror state so DialKit / chrome callbacks never act on stale closures
  const broodRef = useRef(brood)
  broodRef.current = brood
  const selRef = useRef(sel)
  selRef.current = sel
  const modeRef = useRef(mode)
  modeRef.current = mode
  const svgRef = useRef(svg)
  svgRef.current = svg
  const pendingSync = useRef(false)

  const controller = useDialKitController(
    'Metal Logo',
    {
      text: { type: 'text', default: 'RAVENMOOR', placeholder: 'Logo text…' },
      font: { type: 'select', options: FONTS, default: 'Metal Mania' },
      size: [260, 80, 420],
      uploadSvg: { type: 'action', label: svg ? `SVG: ${svg.name} ↺` : 'Upload SVG (or drop it here)' },
      clearSvg: { type: 'action', label: 'Back to text' },
      legibility: { type: 'select', options: Object.keys(STOPS), default: DEFAULT_STOP },
      mutation: [0.35, 0.05, 1],
      variant: {
        length: [1.1, 0.1, 3],
        wings: [0.6, 0, 1],
        depth: [4, 0, 6, 1],
        splitChance: [0.55, 0, 1],
        chaos: [0.55, 0, 1],
        flare: [0.5, 0, 1],
        curl: [0.35, 0, 1],
        taper: [0.85, 0, 1],
        sprouts: [0.15, 0, 1],
        counters: [0.3, 0, 1],
        crownRoot: [0.6, 0, 1],
        symBreak: [0.35, 0, 1],
        envelope: { type: 'select', options: ENVELOPES, default: 'bat-wing' },
        dislocation: [0.25, 0, 1],
      },
      ink: {
        bleed: [2.4, 0, 10],
        threshold: [0.42, 0.05, 0.95],
        grit: [0.3, 0, 1],
      },
      symmetry: false,
      transparentBg: true,
    },
    {
      onAction: (action) => {
        if (action === 'uploadSvg') fileRef.current?.click()
        if (action === 'clearSvg') setSvg(null)
      },
    }
  )
  const p = controller.values
  const pRef = useRef(p)
  pRef.current = p

  const blitRatio = () =>
    Math.min(3, (window.devicePixelRatio || 1) * Math.max(1, view.current.z))

  function applyView() {
    const { x, y, z } = view.current
    if (worldRef.current) worldRef.current.style.transform = `translate(${x}px, ${y}px) scale(${z})`
  }

  function reblitAll() {
    const ratio = blitRatio()
    const colors = colorsRef.current
    for (let i = 0; i < 9; i++) {
      const art = artRefs.current[i]
      const canvas = cellRefs.current[i]
      if (art && canvas) blit(canvas, art, colors, ratio)
    }
    const selArt = artRefs.current[selRef.current]
    if (selArt && singleRef.current) blit(singleRef.current, selArt, colors, ratio)
    if (selArt && squintRef.current) blit(squintRef.current, selArt, colors)
  }

  // The world is full-bleed and pans under the glass — but the middle of the
  // *visible* page is beside the sheet, not behind it.
  function sheetInset() {
    if (window.matchMedia('(max-width: 900px)').matches) return 0
    const v = getComputedStyle(document.documentElement).getPropertyValue('--sheet-inset')
    return parseFloat(v) || 392
  }

  function centerView(forMode) {
    const vp = viewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    const contentH = forMode === 'single' ? SINGLE_H : GRID_H
    view.current = {
      x: (rect.width - sheetInset() - WORLD_W) / 2,
      y: Math.max(200, (rect.height - contentH) / 2 + 60),
      z: 1,
    }
    applyView()
  }

  function pushHistory(b, s) {
    historyRef.current.push({ brood: b, sel: s })
    if (historyRef.current.length > 50) historyRef.current.shift()
  }

  function syncPanel(genome) {
    pendingSync.current = true
    controller.setValues({
      variant: { ...genome.growth, dislocation: genome.dislocation },
      ink: { ...genome.ink },
      symmetry: genome.symmetry,
    })
  }

  function select(idx) {
    setSel(idx)
    syncPanel(broodRef.current[idx])
  }

  function spawnFrom(idx) {
    const prev = broodRef.current
    pushHistory(prev, idx)
    const next = makeBrood(prev[idx], pRef.current.mutation)
    setBrood(next)
    setSel(4)
    setMode('grid') // a fresh brood is a grid moment
    syncPanel(next[4])
  }

  function freshBrood(stop = pRef.current.legibility) {
    pushHistory(broodRef.current, selRef.current)
    const next = makeBrood(genomeFromStop(stop, nextSeed()), 0.45)
    setBrood(next)
    setSel(4)
    setMode('grid')
    syncPanel(next[4])
  }

  function goBack() {
    const last = historyRef.current.pop()
    if (!last) return
    setBrood(last.brood)
    setSel(last.sel)
    syncPanel(last.brood[last.sel])
  }

  async function doExport() {
    const pv = pRef.current
    const art = await buildArt(broodRef.current[selRef.current])
    if (!art) return
    // transparent export is the deliverable: a solid dark mark on nothing.
    // With a background, export what you see — the current theme's colours.
    const colors = pv.transparentBg
      ? { fg: '#0a0a0a', bg: '#f2f0ec' }
      : colorsRef.current
    exportSvg(art, colors, pv.transparentBg, svgRef.current ? svgRef.current.name : pv.text)
  }

  // Only the face on screen is fetched and parsed; picking another gets it
  // then. This is derived rather than a second piece of state on purpose: the
  // moment p.font changes it reads false in the very same render, so the
  // draw loop below can't slip a pass through in the outgoing face and then
  // mark those cells fresh.
  const fontsReady = loadedFont === p.font
  useEffect(() => {
    let alive = true
    const want = p.font
    loadFont(want)
      .then(() => alive && setLoadedFont(want))
      .catch((e) => console.error('fonts', e))
    return () => { alive = false }
  }, [p.font])

  // dev hooks + drag-and-drop + chrome pills + theme observer
  useEffect(() => {
    let alive = true

    colorsRef.current = readThemeColors()

    // dev-only: #singletest switches to the single view once cells exist
    if (location.hash.includes('singletest')) {
      setTimeout(() => setMode('single'), 3500)
    }
    // dev-only: #spawntest selects a corner cell then spawns a brood from it
    if (location.hash.includes('spawntest')) {
      setTimeout(() => {
        select(0)
        setTimeout(() => spawnFrom(0), 600)
      }, 2200)
    }
    if (location.hash.includes('testsvg')) {
      const img = new Image()
      img.onload = () => alive && setSvg({ img, name: 'sample', stamp: 0 })
      img.src = BASE + 'sample.svg'
    }

    const over = (e) => { e.preventDefault(); setDragging(true) }
    const leave = (e) => { if (!e.relatedTarget) setDragging(false) }
    const drop = (e) => {
      e.preventDefault()
      setDragging(false)
      loadSvgFile(e.dataTransfer?.files?.[0], setSvg)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)

    // chrome pills (static site chrome outside the React root)
    const on = (id, fn) => {
      const el = document.getElementById(id)
      if (el) el.addEventListener('click', fn)
      return () => el && el.removeEventListener('click', fn)
    }
    const offs = [
      on('p-view', () => setMode((m) => (m === 'grid' ? 'single' : 'grid'))),
      on('p-spawn', () => spawnFrom(selRef.current)),
      on('p-fresh', () => freshBrood()),
      on('p-back', () => goBack()),
      on('p-export', () => doExport()),
    ]

    // theme changes re-colour every canvas once the CSS transition settles
    const onTheme = () => setTimeout(() => {
      colorsRef.current = readThemeColors()
      reblitAll()
    }, 300)
    const mo = new MutationObserver(onTheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', onTheme)

    return () => {
      alive = false
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      offs.forEach((off) => off())
      mo.disconnect()
      mq.removeEventListener('change', onTheme)
    }
  }, [])

  // pan / zoom: drag anywhere pans (clicks survive via a 5px threshold);
  // pinch or ⌘/ctrl+wheel zooms toward the cursor; plain wheel pans
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return

    centerView('grid')
    // dev-only: #zoomtest starts zoomed into the centre cell
    if (location.hash.includes('zoomtest')) {
      const rect = vp.getBoundingClientRect()
      const z = 2.4
      view.current = {
        x: rect.width / 2 - (WORLD_W / 2) * z,
        y: rect.height / 2 - (GRID_H / 2) * z,
        z,
      }
      setTimeout(reblitAll, 3000)
      applyView()
    }

    const onWheel = (e) => {
      e.preventDefault()
      const v = view.current
      if (e.ctrlKey || e.metaKey) {
        const r = vp.getBoundingClientRect()
        const px = e.clientX - r.left
        const py = e.clientY - r.top
        const nz = Math.min(6, Math.max(0.3, v.z * Math.exp(-e.deltaY * 0.01)))
        v.x = px - ((px - v.x) / v.z) * nz
        v.y = py - ((py - v.y) / v.z) * nz
        v.z = nz
        clearTimeout(zoomBlitTimer.current)
        zoomBlitTimer.current = setTimeout(reblitAll, 180)
      } else {
        v.x -= e.deltaX
        v.y -= e.deltaY
      }
      applyView()
    }

    let down = null
    const onDown = (e) => {
      if (e.button !== 0) return
      down = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false }
    }
    const onMove = (e) => {
      if (!down) return
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (!down.moved && Math.hypot(dx, dy) > 5) {
        down.moved = true
        suppressClick.current = true
      }
      if (down.moved) {
        view.current.x = down.vx + dx
        view.current.y = down.vy + dy
        applyView()
      }
    }
    const onUp = () => {
      down = null
      setTimeout(() => (suppressClick.current = false), 0)
    }

    vp.addEventListener('wheel', onWheel, { passive: false })
    vp.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      vp.removeEventListener('wheel', onWheel)
      vp.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // the sheet's head reads back what the tools row is looking at
  useEffect(() => {
    const summary = document.getElementById('p-summary')
    if (summary) summary.textContent = `${mode === 'grid' ? 'Grid' : 'Single'} · ${sel + 1}/9`
  }, [mode, sel])

  // mode switch: recentre, sync the chrome pill, re-blit once layout settles
  useEffect(() => {
    const pill = document.getElementById('p-view')
    const label = document.getElementById('p-view-label')
    if (pill) {
      pill.classList.toggle('is-on', mode === 'single')
      pill.setAttribute('aria-pressed', mode === 'single' ? 'true' : 'false')
    }
    if (label) label.textContent = mode === 'grid' ? 'Single' : 'Grid'
    centerView(mode)
    const raf = requestAnimationFrame(reblitAll)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  // legibility stop change → new brood at that stop (skip first mount)
  const firstStop = useRef(true)
  useEffect(() => {
    if (firstStop.current) { firstStop.current = false; return }
    freshBrood(p.legibility)
  }, [p.legibility])

  // dial edits write into the selected genome. A syncPanel call echoes back
  // through this effect exactly once — the pendingSync flag swallows it.
  const variantKey = JSON.stringify({ v: p.variant, ink: p.ink, sym: p.symmetry })
  useEffect(() => {
    if (pendingSync.current) {
      pendingSync.current = false
      return
    }
    setBrood((prev) => {
      const g = prev[selRef.current]
      if (!g || genomesMatch(g, p.variant, p.ink, p.symmetry)) return prev
      const { dislocation, ...growth } = p.variant
      const arr = prev.slice()
      arr[selRef.current] = { ...g, dislocation, symmetry: p.symmetry, growth: { ...growth }, ink: { ...p.ink } }
      return arr
    })
  }, [variantKey])

  function getGeometry(genome) {
    const src = svgRef.current
    const pv = pRef.current
    const key = src
      ? `svg|${src.stamp}`
      : `t|${pv.text}|${pv.font}|${pv.size}|${genome.dislocation.toFixed(3)}|${genome.dislocation > 0.01 ? genome.seed : 0}`
    const cached = maskCache.current.get(key)
    if (cached) return cached
    const polys = src
      ? imageGeometry(src.img)
      : textGeometry(pv.text || 'METAL', pv.font, pv.size, genome.dislocation, makeRng(genome.seed ^ 0x51ab))
    if (!polys || !polys.length) return null
    const geom = { polys, mask: rasterizeForAnalysis(polys) }
    maskCache.current.set(key, geom)
    if (maskCache.current.size > 30) {
      maskCache.current.delete(maskCache.current.keys().next().value)
    }
    return geom
  }

  function getLetterform(mask) {
    let lf = lfCache.current.get(mask)
    if (!lf) {
      lf = extractLetterform(mask)
      lfCache.current.set(mask, lf)
    }
    return lf
  }

  // Async because Clipper arrives with it: every cell on screen is built in a
  // worker, so the main thread only ever needs art.js for Export, the
  // no-worker fallback and #svgdump — three things nobody is waiting on at
  // load. import() is cached, so only the first call pays for the fetch.
  async function buildArt(genome) {
    const geom = getGeometry(genome)
    if (!geom || !geom.mask.coverage) return null
    const lf = getLetterform(geom.mask)
    const { branchOutline, inkVector, makeArt } = await import('./art.js')
    const rand = makeRng(genome.seed * 2654435761)
    let branches = growTendrils(lf, geom.mask, { ...genome.growth }, rand)
    if (genome.symmetry) {
      const cx = (geom.mask.bbox.minX + geom.mask.bbox.maxX) / 2
      branches = branches.concat(mirrorBranches(branches, cx, genome.growth.symBreak || 0, rand))
    }
    const outlines = branches.map(branchOutline).filter(Boolean)
    const polys = inkVector(
      [...geom.polys, ...outlines],
      { ...genome.ink, gritSeed: genome.seed * 31 + 7 }
    )
    return makeArt(polys)
  }

  // progressive render — only stale cells, and off the main thread
  //
  // Each cell is ~1.7s of polygon clipping; nine in a row used to hold the
  // main thread for fifteen seconds after load, which is why a tap on the
  // settings sheet could sit there for two of them. A small pool of workers
  // does the clipping now and each cell is blitted as it lands, so the page
  // answers a tap in a frame while the grid fills in behind it. The mask
  // still comes from here — it needs a canvas — and it is the cheap half.
  const poolRef = useRef(null)
  const jobRef = useRef({ token: -1, brood: null, items: [] })
  const onCell = useRef(() => {})

  function paintCell(idx, key, art) {
    const canvas = cellRefs.current[idx]
    if (!art || !canvas) return
    artRefs.current[idx] = art
    blit(canvas, art, colorsRef.current, blitRatio())
    lastCellKey.current[idx] = key
    if (idx === selRef.current) {
      if (singleRef.current) blit(singleRef.current, art, colorsRef.current, blitRatio())
      if (squintRef.current) blit(squintRef.current, art, colorsRef.current)
    }
  }

  // Hand one *idle* worker the next stale cell, mask and all. Cells can carry
  // different geometry (dislocation reseeds the mask per variant), so the
  // mask travels with the job rather than being shared once.
  //
  // The busy flag is load-bearing. A worker can't be interrupted mid-cell, and
  // a dial drag fires a render a frame — post to a busy worker and fourteen
  // superseded cells queue in front of the only one still wanted, which then
  // lands twenty seconds later. Skipping busy workers leaves the newest job
  // sitting in jobRef instead, and whichever worker reports back first takes
  // it: at most one stale cell per worker is ever in flight.
  function dispatchCell(w) {
    if (w.busy) return
    const job = jobRef.current
    while (job.items.length) {
      const [idx, key] = job.items.shift()
      const genome = job.brood[idx]
      const geom = getGeometry(genome)
      if (!geom || !geom.mask.coverage) continue
      w.postMessage({
        token: job.token, idx, key, genome,
        polys: geom.polys,
        lf: getLetterform(geom.mask),
        // the canvas on the mask can't cross a postMessage, and nothing
        // downstream of here reads it
        mask: { alpha: geom.mask.alpha, w: geom.mask.w, h: geom.mask.h, bbox: geom.mask.bbox },
      })
      // after the post, so a structured-clone throw can't wedge the worker
      w.busy = true
      return
    }
  }

  // The original one-cell-per-frame loop, kept for anything that can't run a
  // module worker — and as the landing place if one fails to boot.
  function drawOnMainThread(job) {
    let raf = requestAnimationFrame(async function step() {
      if (renderToken.current !== job.token || !job.items.length) return
      const [idx, key] = job.items.shift()
      const art = await buildArt(job.brood[idx])
      if (renderToken.current !== job.token) return
      paintCell(idx, key, art)
      raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
  }

  // one core left over for the page itself
  const POOL_MAX = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))

  function spawn(n) {
    const made = []
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./render.worker.js', import.meta.url), { type: 'module' })
        w.onmessage = (e) => onCell.current(w, e.data)
        w.onerror = () => onPoolFailure()
        made.push(w)
      }
    } catch (e) {
      // no module workers here — the caller draws on the main thread instead
    }
    return made
  }

  // The pool starts as one worker and grows once that one has answered: three
  // of them started together would each fetch the worker bundle before any
  // copy of it reached the cache.
  function pool() {
    if (!poolRef.current) poolRef.current = spawn(1)
    return poolRef.current
  }

  function growPool() {
    const list = poolRef.current
    if (!list || !list.length || list.length >= POOL_MAX) return
    const extra = spawn(POOL_MAX - list.length)
    list.push(...extra)
    extra.forEach(dispatchCell)
  }

  function onPoolFailure() {
    if (!poolRef.current || !poolRef.current.length) return
    poolRef.current.forEach((w) => w.terminate())
    poolRef.current = []
    drawOnMainThread(jobRef.current)
  }

  onCell.current = (w, msg) => {
    w.busy = false
    if (msg.token === renderToken.current && msg.art) {
      paintCell(msg.idx, msg.key, { ...msg.art, path2d: new Path2D(msg.art.pathString) })
    }
    dispatchCell(w)
    growPool()
  }

  useEffect(() => () => {
    (poolRef.current || []).forEach((w) => w.terminate())
    poolRef.current = null
  }, [])

  const globalKey = JSON.stringify({
    text: p.text, font: p.font, size: p.size,
    svg: svg ? svg.stamp : null, fontsReady,
  })
  useEffect(() => {
    if (!fontsReady) return
    const token = ++renderToken.current
    const items = []
    for (let i = 0; i < 9; i++) {
      const key = globalKey + JSON.stringify(brood[i])
      if (lastCellKey.current[i] !== key) items.push([i, key])
    }
    if (!items.length) return
    // the cell being looked at is the one worth having first
    const s = selRef.current
    items.sort((a, b) => (b[0] === s) - (a[0] === s))

    const job = { token, brood, items }
    jobRef.current = job
    const list = pool()
    if (!list.length) return drawOnMainThread(job)
    list.forEach(dispatchCell)
  }, [brood, globalKey])

  // selection change: refresh the single view + patch test
  useEffect(() => {
    const art = artRefs.current[sel]
    if (!art) return
    if (singleRef.current) blit(singleRef.current, art, colorsRef.current, blitRatio())
    if (squintRef.current) blit(squintRef.current, art, colorsRef.current)
  }, [sel])

  // dev-only: #svgdump overlays the traced vector of the selected variant
  useEffect(() => {
    if (!location.hash.includes('svgdump') || !fontsReady) return
    const raf = requestAnimationFrame(async () => {
      const art = await buildArt(brood[sel])
      if (!art) return
      const s = svgString(art, { fg: '#0a0a0a', bg: '#f2f0ec' }, p.transparentBg)
      document.title = `svgdump ${s.length}B ${(s.match(/M/g) || []).length} loops`
      setSvgDump(s.replace('<svg ', '<svg style="width:min(100%,1100px)" '))
    })
    return () => cancelAnimationFrame(raf)
  }, [brood, sel, globalKey, fontsReady])

  function onFile(e) {
    loadSvgFile(e.target.files?.[0], setSvg)
    e.target.value = ''
  }

  return (
    <div style={styles.page}>
      <input ref={fileRef} type="file" accept=".svg,image/svg+xml" hidden onChange={onFile} />
      <div ref={viewportRef} style={styles.viewport}>
        <div ref={worldRef} style={styles.world}>
          <div style={{ ...styles.grid, display: mode === 'grid' ? 'grid' : 'none' }}>
            {Array.from({ length: 9 }, (_, i) => (
              <div
                key={i}
                style={{ ...styles.cell, ...(i === sel ? styles.cellSelected : null) }}
                onClick={() => { if (!suppressClick.current) select(i) }}
                onDoubleClick={() => { if (!suppressClick.current) spawnFrom(i) }}
                title="click to select · double-click to spawn 9 from this"
              >
                <canvas ref={(el) => (cellRefs.current[i] = el)} style={styles.cellCanvas} />
              </div>
            ))}
          </div>
          <div
            style={{ ...styles.cell, width: WORLD_W, display: mode === 'single' ? 'block' : 'none' }}
            onDoubleClick={() => { if (!suppressClick.current) spawnFrom(selRef.current) }}
            title="double-click to spawn 9 from this"
          >
            <canvas ref={singleRef} style={styles.cellCanvas} />
          </div>
        </div>
      </div>
      <span className="metal-hint">
        drag pans · pinch / ⌘+wheel zooms · click selects · double-click spawns 9
      </span>
      <div className="metal-squint">
        <span className="metal-squint__label">patch test</span>
        <canvas ref={squintRef} className="metal-squint__canvas" />
      </div>
      {dragging && <div style={styles.dropVeil}>drop .svg</div>}
      {svgDump && <div style={styles.svgDump} dangerouslySetInnerHTML={{ __html: svgDump }} />}
    </div>
  )
}

const styles = {
  page: {
    height: '100vh',
    overflow: 'hidden',
  },
  viewport: {
    position: 'fixed',
    inset: 0,
    overflow: 'hidden',
    touchAction: 'none',
    overscrollBehavior: 'none',
    cursor: 'grab',
  },
  world: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: WORLD_W,
    transformOrigin: '0 0',
    willChange: 'transform',
  },
  grid: {
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 10,
    width: WORLD_W,
  },
  cell: {
    background: 'var(--field)',
    cursor: 'pointer',
    borderRadius: 2,
  },
  cellSelected: {
    outline: '2px solid var(--orange)',
    outlineOffset: 2,
  },
  cellCanvas: {
    width: '100%',
    display: 'block',
    aspectRatio: '1400 / 800',
  },
  dropVeil: {
    position: 'fixed',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: 'color-mix(in srgb, var(--bg) 75%, transparent)',
    border: '1px dashed var(--muted)',
    color: 'var(--ink)',
    fontSize: 18,
    letterSpacing: '0.1em',
    pointerEvents: 'none',
    zIndex: 600,
  },
  svgDump: {
    position: 'fixed',
    inset: 0,
    background: 'var(--bg)',
    display: 'grid',
    placeItems: 'center',
    padding: 24,
    zIndex: 600,
  },
}
