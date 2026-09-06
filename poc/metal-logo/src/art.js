// Art — the Clipper half of the engine, kept behind one dynamic import.
//
// Nothing on the boot path needs it. Every cell the visitor actually sees is
// clipped in render.worker.js and comes back as a path string, so the 99KB of
// clipper-lib is only reached by Export, the no-worker fallback and the
// #svgdump probe. Importing it from here rather than from vector.js takes it
// off the module graph the page has to evaluate before React mounts.

import { artGeometry } from './ink.js'

export { branchOutline, inkVector, artGeometry } from './ink.js'

export function makeArt(rawPolys) {
  const art = artGeometry(rawPolys)
  return art && { ...art, path2d: new Path2D(art.pathString) }
}
