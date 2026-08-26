# atlas — data tooling

The deployed experiment is `/20260826/atlas/` (plain HTML + canvas, no build). This
folder only makes its `world.js`.

```sh
cd tools && npm install && npm run build
```

`tools/source/ne_50m_admin_0_countries.geojson` is Natural Earth 1:50m admin-0
countries, public domain, taken verbatim from nvkelso/natural-earth-vector at tag
v5.1.2; `SHA256SUMS` pins it. `build-data.mjs` verifies the checksum, classifies each
feature (193 UN members + 2 observers are counted; everything else with an ISO code
is a territory, credited to its sovereign), projects to Equal Earth, simplifies in the
topology's quantized units to about a pixel at the deepest zoom, and refuses to write
unless: all 195 are present, land area is within 2% of 134M km², the nine largest are
the nine largest, and a spread of countries land within 12% of their published areas.
Places that simplification swallows whole (the Vatican) keep their unsimplified outline.

Output is ~130 KB (45 KB gzipped). Coordinates are in a 1000-unit-wide world; the
page does the rest with a 2D transform.
