# play.ravivasavan.com

Experiments, out in the open.

Static site served by GitHub Pages from `main` (root). Every push deploys.

The home page is a horizontal timeline built from `assets/timeline/experiments.json` — there is no hand-maintained list.

## Adding an experiment

1. **The thing itself.** Either host it here at `<YYYYMMDD>/<slug>/index.html` (plain HTML/CSS/JS, no build step), or host it elsewhere and give the entry a `url`.
2. **Three shots** at `assets/timeline/<slug>/*.png`, 1280×800. They render as a scattered stack ~210px wide, so favour whole-screen views over detail crops. Mixing light and dark reads well.
3. **An entry** in `assets/timeline/experiments.json`:
   ```json
   {
     "slug": "arena-stats",
     "name": "Arena Stats",
     "date": "20260803",
     "description": "Every block you've made on Are.na, counted",
     "status": "live",
     "tech": "React, Are.na v3 API, no backend",
     "glyph": "chart",
     "url": "https://ravivasavan.github.io/arena-stats/",
     "shots": ["overview.png", "calendar.png", "rhythm.png"]
   }
   ```
   - `date` is the filing date, `YYYYMMDD`. It places the entry on the rail. Several experiments can share a date — the rail stretches that day to fit them.
   - `url` is optional; without it the entry links to `/<date>/<slug>/`.
   - `status` is `live`, `tinkering`, or `retired` — it colours the dot.
   - `glyph` names a key in the `GLYPHS` map in `index.html`. Add the Lucide path data there first, or the entry falls back to its initial.
4. Commit + push.

Anything that needs a framework or build step (Next, Vue) gets its own repo and links in by `url`.

## Plumbing

- DNS: Cloudflare, `CNAME play.ravivasavan.com → ravivasavan.github.io` (DNS-only so GitHub can provision TLS)
- Custom domain + HTTPS: repo Settings → Pages
- `.nojekyll` keeps GitHub from running Jekyll over the files
