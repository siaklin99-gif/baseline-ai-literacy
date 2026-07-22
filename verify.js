#!/usr/bin/env node
/* ============================================================
   Baseline — verification harness
   Run:  node verify.js
   Exits non-zero if anything is wrong. Hand-controlled, offline,
   no dependencies. Checks CORRECTNESS, not just presence.
   ============================================================ */
const fs = require('fs');
const path = require('path');

let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

function read(f){ return fs.readFileSync(path.join(__dirname, f), 'utf8'); }

console.log('\nBaseline verify\n---------------');

/* ---------- 1. data.js loads as valid JS and has expected shape ---------- */
let DATA;
try {
  const g = {}; global.window = g;
  delete require.cache[require.resolve('./data.js')];
  require('./data.js');
  DATA = g.BASELINE_DATA;
  ok('data.js parses as valid JavaScript');
} catch (e) {
  bad('data.js failed to load: ' + e.message);
}

if (DATA) {
  const today = new Date('2026-07-21');          // fixed reference for reproducibility
  const STALE_DAYS = 120;
  for (const key of ['models', 'pricing', 'books']) {
    const d = DATA[key];
    if (!d) { bad(`data.js missing section "${key}"`); continue; }

    // asOf must be empty OR a valid ISO date
    if (d.asOf === '') {
      ok(`${key}: asOf empty -> will show "Needs live check" (honest placeholder)`);
    } else if (isNaN(Date.parse(d.asOf))) {
      bad(`${key}: asOf "${d.asOf}" is not a parseable date`);
    } else {
      const age = Math.floor((today - Date.parse(d.asOf)) / 86400000);
      if (age < 0)            bad(`${key}: asOf "${d.asOf}" is in the future (${age}d)`);
      else if (age > STALE_DAYS) bad(`${key}: asOf "${d.asOf}" is stale (${age}d > ${STALE_DAYS}) — refresh it`);
      else                    ok(`${key}: verified ${d.asOf} (${age}d old, fresh)`);
    }

    // every list row must have an unambiguous type AND the fields renderList() actually renders
    if (Array.isArray(d.list) && d.list.length) {
      const REQUIRED = { name: ['kind', 'best'], plan: ['cost', 'notes'], title: ['kind', 'author', 'why'] };
      let rowErr = 0;
      const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
      d.list.forEach((r, i) => {
        const disc = ['name', 'plan', 'title'].filter(k => k in r);
        if (disc.length === 0) { rowErr++; bad(`${key}[${i}]: row matches no known type (needs name/plan/title)`); return; }
        if (disc.length > 1)   { rowErr++; bad(`${key}[${i}]: row matches multiple types (${disc.join('+')}) — renderList would mis-detect`); return; }
        const type = disc[0];
        if (!nonEmpty(r[type])) { rowErr++; bad(`${key}[${i}]: "${type}" is empty`); }
        for (const f of REQUIRED[type]) {
          if (!nonEmpty(r[f])) { rowErr++; bad(`${key}[${i}] (${type} row): field "${f}" is missing/empty — would render blank`); }
        }
      });
      if (!rowErr) ok(`${key}: all ${d.list.length} rows have a valid type and non-empty fields`);
    }

    // if asOf is set, html should be non-trivial (not an empty stub)
    if (d.asOf && (!d.html || d.html.trim().length < 20)) {
      bad(`${key}: marked verified but html is empty/too short`);
    }
  }
}

/* ---------- 2. index.html structural invariants ---------- */
const html = read('index.html');

// data.js must be loaded before the inline script that uses it
const iData = html.indexOf('src="data.js"');
const iUse  = html.indexOf('BASELINE_DATA');
if (iData === -1)            bad('index.html does not load data.js');
else if (iUse !== -1 && iData < iUse) ok('data.js is loaded before it is used');
else                        bad('data.js loaded AFTER first use of BASELINE_DATA');

// no duplicate element IDs
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
dupIds.length ? bad('duplicate id(s): ' + [...new Set(dupIds)].join(', '))
              : ok('no duplicate element IDs');

// required hooks the JS depends on
for (const need of ['id="peel"', 'class="pl-stage"', 'class="pl-btn"', 'id="cards"', 'id="pills"', 'id="bodymap"', 'id="glossary"']) {
  html.includes(need) ? ok('has ' + need) : bad('missing ' + need);
}
// the peel core "boom" (aha) must be wired
(/is-core/.test(html) && /pl-core-label/.test(html) && /@keyframes plBurst/.test(html))
  ? ok('peel core reveal + burst animation present')
  : bad('peel core "boom" (is-core / core label / burst) missing');
// each layer carries an everyday example
(/class="pl-eg"/.test(html) && /pl-eg-tag/.test(html))
  ? ok('per-layer everyday example callout present')
  : bad('everyday example callout (pl-eg) missing');

// theming: both light and dark variable blocks present
html.includes('prefers-color-scheme: dark') ? ok('dark-mode styles present')
                                            : bad('no dark-mode block');

// AI gradient identity: defined and actually used
(/--grad\s*:/.test(html) && /var\(--grad\)/.test(html)) ? ok('AI gradient identity defined and used')
                                                        : bad('AI gradient (--grad) missing or unused');
// cluster colour-coding present for all four groups
['choose','cost','safety','learn'].every(c => html.includes(`data-cluster="${c}"`))
  ? ok('all four topic clusters colour-coded')
  : bad('a topic cluster is missing its colour rule');

// LAYERS array should have exactly 10 entries (the "10 layers" promise)
const layerBlock = html.match(/const LAYERS = \[([\s\S]*?)\];/);
if (layerBlock) {
  // count top-level entries by leading '["' occurrences
  const n = (layerBlock[1].match(/\n\s*\["/g) || []).length;
  n === 10 ? ok('exactly 10 layers defined') : bad(`expected 10 layers, found ${n}`);
} else bad('could not find LAYERS array');

/* ---------- 3. cross-file: every {data:"..."} card has a data.js section ---------- */
/* scope to the CARDS array so the {data:"key"} example in the doc comment is ignored */
if (DATA) {
  const cardsBlock = html.match(/const CARDS = \[([\s\S]*?)\n\];/);
  const scope = cardsBlock ? cardsBlock[1] : '';
  const keys = [...new Set([...scope.matchAll(/\{data:"(\w+)"\}/g)].map(m => m[1]))];
  if (!keys.length) bad('no {data:"..."} cards found inside CARDS array');
  keys.forEach(k => DATA[k] ? ok(`card {data:"${k}"} has a data.js section`)
                            : bad(`card {data:"${k}"} has NO matching data.js section`));
}

/* ---------- 4. regression guards for the cold-audit fixes ---------- */
const g = (cond, m) => cond ? ok(m) : bad(m);
g(/function esc\(/.test(html), 'esc() escaping helper present (fix #4)');
g(html.includes("'name'  in x") || html.includes("'name' in x"), 'renderList uses `in` type-detection (fix #3)');
g(/Malformed row/.test(html), 'renderList renders a visible fallback for mistyped rows (fix #3)');
g(/aria-pressed/.test(html), 'filter pills expose aria-pressed state (fix #2)');
g(/prefers-reduced-motion/.test(html), 'peel animations respect prefers-reduced-motion');
g(/Invalid date/.test(html), 'invalid asOf is distinguished from empty (fix #5)');
// escaping means no field should ship pre-escaped &amp; entities in data.js text
if (DATA) {
  const leaked = ['models','pricing','books'].some(k =>
    (DATA[k].list||[]).some(r => Object.entries(r).some(([f,v]) => f!=='html' && /&amp;|&lt;|&gt;/.test(String(v)))));
  g(!leaked, 'no double-escaped entities left in data.js text fields (fix #4)');
}

/* ---------- result ---------- */
console.log('---------------');
console.log(`${checks} checks, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
