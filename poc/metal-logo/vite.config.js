import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/* DialKit's stylesheet opens with a Google Fonts @import for Geist Mono, used
   for the numbers on its sliders. The skin puts those back in Labil Grotesk,
   so the import is a render-blocking request for a face nothing draws. */
function dropGeistMonoImport() {
  return {
    name: 'drop-geist-mono-import',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('dialkit') || !id.endsWith('.css')) return null
      return code.replace(/@import url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\);?/g, '')
    },
  }
}

export default defineConfig({
  base: '/20260824/metal/',
  plugins: [react(), dropGeistMonoImport()],
  /* render.worker.js is created with {type:'module'}, but Vite's default
     worker format is iife, which inlines everything the worker imports — the
     whole of clipper-lib welded into a 107KB worker entry that has to be
     re-fetched whenever a line of the render loop moves.

     Vite bundles a worker in its own rollup pass, so it cannot literally
     share the main build's clipper chunk (the two passes hash and mangle
     independently); what ES format plus the same split buys is a 7KB worker
     entry beside a clipper chunk of its own, cached across all three pool
     workers and across every edit to the render loop. */
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/clipper-lib')) return 'clipper'
        },
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        /* Four vendors that move at four speeds: React never changes, the
           geometry libraries change when the engine does, and DialKit changes
           when the panel does. Split, an edit to App.jsx re-downloads only
           App.jsx. */
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (id.includes('node_modules/clipper-lib')) return 'clipper'
          if (id.includes('node_modules/opentype.js')) return 'opentype'
          if (/node_modules\/(dialkit|motion|framer-motion|motion-dom|motion-utils)\//.test(id)) return 'dialkit'
        },
      },
    },
  },
})
