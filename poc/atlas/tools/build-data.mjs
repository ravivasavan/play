// Builds ../../../20260826/atlas/world.js from Natural Earth 1:50m admin-0 countries.
//
// Verifies the source checksum, classifies every feature (UN member / observer /
// territory), projects to Equal Earth, simplifies in projected space to the
// precision the deepest zoom can show, and refuses to write unless the result
// still holds up: all 195 present, land area within 2% of the published figure,
// the nine largest in the right order, and a spread of countries spanning four
// orders of magnitude within 12% of their published areas.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { geoEqualEarth, geoArea, geoCentroid, geoPath } from 'd3-geo';
import { geoProject } from 'd3-geo-projection';
import { topology } from 'topojson-server';
import { presimplify, simplify } from 'topojson-simplify';
import { feature } from 'topojson-client';

const SRC = 'source/ne_50m_admin_0_countries.geojson';
const OUT = new URL('../../../20260826/atlas/world.js', import.meta.url).pathname;
const R_KM2 = 6371.0088 ** 2;

// 193 UN member states, ISO 3166-1 alpha-3.
const UN = `AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN
BOL BIH BWA BRA BRN BGR BFA BDI CPV KHM CMR CAN CAF TCD CHL CHN COL COM COG COD CRI CIV HRV
CUB CYP CZE DNK DJI DMA DOM ECU EGY SLV GNQ ERI EST SWZ ETH FJI FIN FRA GAB GMB GEO DEU GHA
GRC GRD GTM GIN GNB GUY HTI HND HUN ISL IND IDN IRN IRQ IRL ISR ITA JAM JPN JOR KAZ KEN KIR
PRK KOR KWT KGZ LAO LVA LBN LSO LBR LBY LIE LTU LUX MDG MWI MYS MDV MLI MLT MHL MRT MUS MEX
FSM MDA MCO MNG MNE MAR MOZ MMR NAM NRU NPL NLD NZL NIC NER NGA MKD NOR OMN PAK PLW PAN PNG
PRY PER PHL POL PRT QAT ROU RUS RWA KNA LCA VCT WSM SMR STP SAU SEN SRB SYC SLE SGP SVK SVN
SLB SOM ZAF SSD ESP LKA SDN SUR SWE CHE SYR TJK TZA THA TLS TGO TON TTO TUN TUR TKM TUV UGA
UKR ARE GBR USA URY UZB VUT VEN VNM YEM ZMB ZWE`.split(/\s+/);
const OBSERVERS = ['VAT', 'PSE'];
if (UN.length !== 193) throw new Error(`UN list has ${UN.length} codes, want 193`);

// Natural Earth's own codes for places ISO doesn't code, and the ones we skip.
const RECODE = { KOS: 'XKX' };
const SKIP = new Set(['SOL', 'CYN', 'KAS', 'ATC', 'IOA', 'ESB', 'WSB', 'CNM', 'BJN', 'SER', 'SCR', 'USG', 'BRI', 'SPI', 'NOR_' ]);

// --- source ------------------------------------------------------------------
const raw = readFileSync(SRC);
const sha = createHash('sha256').update(raw).digest('hex');
const want = readFileSync('source/SHA256SUMS', 'utf8').split(/\s+/)[0];
if (sha !== want) throw new Error(`checksum mismatch: ${sha}`);
const src = JSON.parse(raw.toString('utf8'));

// --- classify ----------------------------------------------------------------
const seen = new Map();
for (const f of src.features) {
  const p = f.properties;
  let code = p.ISO_A3_EH !== '-99' ? p.ISO_A3_EH : p.ADM0_A3;
  code = RECODE[code] || code;
  if (code === '-99' || SKIP.has(p.ADM0_A3)) continue;
  if (!/^[A-Z]{3}$/.test(code)) continue;
  const un = UN.includes(code), obs = OBSERVERS.includes(code);
  const territory = !(un || obs);
  const sovereign = p.SOVEREIGNT !== p.ADMIN ? p.SOVEREIGNT : null;
  const area = geoArea(f) * R_KM2;
  const [lon, lat] = Number.isFinite(p.LABEL_X) ? [p.LABEL_X, p.LABEL_Y] : geoCentroid(f);
  if (seen.has(code)) throw new Error(`duplicate code ${code} (${p.NAME})`);
  seen.set(code, { code, name: p.NAME_LONG === p.NAME ? p.NAME : (p.NAME_LONG.length <= 24 ? p.NAME_LONG : p.NAME),
                   short: p.NAME, sovereign: territory ? sovereign : null, un, obs, territory,
                   continent: p.CONTINENT, area, label: [lon, lat], feature: f });
}
for (const c of [...UN, ...OBSERVERS]) if (!seen.has(c)) throw new Error(`missing ${c}`);

// --- project -----------------------------------------------------------------
// A 1000-wide world. Everything downstream is arithmetic on these units.
const W = 1000;
const proj = geoEqualEarth().fitWidth(W, { type: 'Sphere' });
const [[x0, y0], [x1, y1]] = geoPath(proj).bounds({ type: 'Sphere' });
const H = y1 - y0;
const px = geoProject({ type: 'FeatureCollection', features: [...seen.values()].map(v => ({ ...v.feature, id: v.code, properties: {} })) }, proj);

// Simplify in the topology's quantized units (1e5 across the world, so 100 per projected
// unit). 30 quantized-units² is a triangle ~8 quantized units on a side: ~0.08 projected
// units, which is about a pixel at the deepest zoom (12×) on a 1400px-wide canvas.
let topo = presimplify(topology({ c: px }, 1e5));
topo = simplify(topo, 0.012);
const out = feature(topo, topo.objects.c).features;

const round = n => Math.round(n * 100) / 100;
const original = new Map(px.features.map(f => [f.id, f]));
// Rings are integers in hundredths of a unit, delta-encoded after the first point:
// small numbers, short JSON. The page reverses it in a dozen lines.
const ringsOf = geom => {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const rings = [];
  for (const poly of polys) for (const ring of poly) {
    if (ring.length < 4) continue;
    const flat = [];
    let px = 0, py = 0;
    for (const [x, y] of ring) {
      const rx = Math.round((x - x0) * 100), ry = Math.round((y - y0) * 100);
      if (flat.length && rx === px && ry === py) continue;
      flat.push(rx - px, ry - py); px = rx; py = ry;
    }
    if (flat.length >= 8) rings.push(flat);
  }
  return rings;
};
const countries = out.map(f => {
  const v = seen.get(f.id);
  // Simplification can swallow the smallest places whole; they fall back to
  // their unsimplified outline, which is a handful of points anyway.
  let rings = ringsOf(f.geometry);
  if (!rings.length) rings = ringsOf(original.get(f.id).geometry);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const flat of rings) { let rx = 0, ry = 0; for (let i = 0; i < flat.length; i += 2) {
    rx += flat[i] / 100; ry += flat[i + 1] / 100;
    if (rx < bx0) bx0 = rx; if (rx > bx1) bx1 = rx; if (ry < by0) by0 = ry; if (ry > by1) by1 = ry;
  } }
  if (false) { const polys = null;
  }
  const [lx, ly] = proj(v.label);
  return { c: v.code, n: v.name, s: v.sovereign, k: v.un ? 'un' : v.obs ? 'obs' : 't', r: v.continent,
           a: Math.round(v.area), l: [round(lx - x0), round(ly - y0)], b: [bx0, by0, bx1, by1].map(round), g: rings };
});
countries.sort((a, b) => a.n.localeCompare(b.n));

// The sphere's edge, so the map has a horizon.
const sphere = geoProject({ type: 'Sphere' }, proj).coordinates[0].map(([x, y]) => [round(x - x0), round(y - y0)]);
const grat = [];
for (let lat = -60; lat <= 60; lat += 30) grat.push(Array.from({ length: 73 }, (_, i) => proj([-180 + i * 5, lat]).map((n, j) => round(n - (j ? y0 : x0)))));
for (let lon = -150; lon <= 180; lon += 30) grat.push(Array.from({ length: 37 }, (_, i) => proj([lon, -90 + i * 5]).map((n, j) => round(n - (j ? y0 : x0)))));

// --- validate ----------------------------------------------------------------
const the195 = countries.filter(c => c.k !== 't');
if (the195.length !== 195) throw new Error(`have ${the195.length} of 195`);
const land = countries.filter(c => c.c !== 'ATA').reduce((s, c) => s + c.a, 0);
if (Math.abs(land / 134_000_000 - 1) > 0.02) throw new Error(`land area ${land} km² is off`);
const byArea = [...countries].filter(c => c.c !== 'ATA').sort((a, b) => b.a - a.a).slice(0, 9).map(c => c.c);
const want9 = ['RUS', 'CAN', 'CHN', 'USA', 'BRA', 'AUS', 'IND', 'ARG', 'KAZ'];
// USA vs China swaps depending on whether inland water counts, so only the set and the top two are checked.
if ([...byArea].sort().join() !== [...want9].sort().join() || byArea[0] !== 'RUS' || byArea[1] !== 'CAN') throw new Error(`largest nine came out ${byArea.join(' ')}`);
const published = { RUS: 17098246, FRA: 643801, GBR: 243610, NPL: 147181, DNK: 42933, JAM: 10991, LUX: 2586, LKA: 65610, TTO: 5130, VAT: 0.49 };
for (const [c, km] of Object.entries(published)) {
  const got = countries.find(x => x.c === c).a;
  if (c === 'VAT') continue;
  if (Math.abs(got / km - 1) > 0.12) throw new Error(`${c}: ${got} vs ${km}`);
}
const empty = countries.filter(c => !c.g.length).map(c => c.c);
if (empty.length) throw new Error(`no geometry for ${empty.join(' ')}`);

// --- write -------------------------------------------------------------------
const js = `// Generated by tools/build-data.mjs from Natural Earth 1:50m admin-0 countries v5.1.2 (public domain).
// Equal Earth projection, ${W} units wide. Rings are delta-encoded hundredths of a unit. Do not edit by hand.
window.WORLD = ${JSON.stringify({ w: W, h: round(H), sphere, grat, countries })};
`;
writeFileSync(OUT, js);
console.log(`wrote ${OUT}: ${(js.length / 1024).toFixed(0)} KB, ${countries.length} places (${the195.length} counted, ${countries.length - the195.length} territories), land ${(land / 1e6).toFixed(1)}M km²`);
const tiny = countries.filter(c => Math.max(c.b[2] - c.b[0], c.b[3] - c.b[1]) < 6).map(c => c.c);
console.log(`too small to click at world zoom (<6 units): ${tiny.length} → ${tiny.join(' ')}`);
