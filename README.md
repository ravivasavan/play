# play.vasavan.org

Experiments, out in the open.

Static site served by GitHub Pages from `main` (root). Every push deploys.

## Adding an experiment

1. Drop it in `experiments/<slug>/` with its own `index.html` (plain HTML/CSS/JS — no build step).
2. Uncomment/add a row in the `<ol>` in `index.html`:
   ```html
   <li><a href="/experiments/<slug>/">name <time>YYYY-MM</time></a></li>
   ```
3. Commit + push.

Anything that needs a framework or build step (Next, Vue) gets its own repo + Vercel later.

## Plumbing

- DNS: Cloudflare, `CNAME play → ravivasavan.github.io` (DNS-only so GitHub can provision TLS)
- Custom domain + HTTPS: repo Settings → Pages
- `.nojekyll` keeps GitHub from running Jekyll over the files
