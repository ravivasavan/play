// One variant of the logo, built off the main thread.
//
// A cell is ~1.7s of polygon clipping (union, three round-join offsets, then
// the grit subtraction). Nine of them in a row on the main thread pegged it
// for fifteen seconds after load, so anything the visitor touched in that
// window — the settings sheet included — waited for whichever cell was
// mid-flight. The letterform mask still comes from the page, because it needs
// a canvas; everything after it happens here.
//
// The output is byte-identical to the main-thread path: the same code, driven
// by the same seeded RNG.
import { growTendrils, mirrorBranches, makeRng } from './generator.js'
import { branchOutline, inkVector, artGeometry } from './ink.js'

self.onmessage = (e) => {
  const { token, idx, key, genome, polys, mask, lf } = e.data
  const rand = makeRng(genome.seed * 2654435761)
  let branches = growTendrils(lf, mask, { ...genome.growth }, rand)
  if (genome.symmetry) {
    const cx = (mask.bbox.minX + mask.bbox.maxX) / 2
    branches = branches.concat(mirrorBranches(branches, cx, genome.growth.symBreak || 0, rand))
  }
  const outlines = branches.map(branchOutline).filter(Boolean)
  const inked = inkVector([...polys, ...outlines], { ...genome.ink, gritSeed: genome.seed * 31 + 7 })
  self.postMessage({ token, idx, key, art: artGeometry(inked) })
}
