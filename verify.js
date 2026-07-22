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
  // REAL current date — the whole point of this check is to catch decay over time.
  // (A pinned date here once made the staleness guard pass forever: cold-audit find.)
  const today = new Date();
  const STALE_DAYS = 120;
  const WARN_DAYS = 90;                          // nag before the public page goes amber at 120
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
      else if (age > STALE_DAYS) bad(`${key}: asOf "${d.asOf}" is stale (${age}d > ${STALE_DAYS}) — the PUBLIC page shows amber; refresh data.js`);
      else if (age > WARN_DAYS)  bad(`${key}: asOf "${d.asOf}" is ${age}d old — refresh before it goes amber at ${STALE_DAYS}d`);
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
        // book/course rows must link somewhere real (a recommendation with no link is a dead end)
        if (type === 'title' && !/^https:\/\/[^\s"]+$/.test(r.url || '')) {
          rowErr++; bad(`${key}[${i}] ("${r.title}"): missing/malformed url — readers can't reach it`);
        }
      });
      if (!rowErr) ok(`${key}: all ${d.list.length} rows have a valid type and non-empty fields`);
    }

    // if asOf is set, html should be non-trivial (not an empty stub)
    if (d.asOf && (!d.html || d.html.trim().length < 20)) {
      bad(`${key}: marked verified but html is empty/too short`);
    }

    // models/pricing stamps must link to a source (books link per-title instead — deliberate)
    if (key === 'models' || key === 'pricing') {
      /^https:\/\/[^\s"]+$/.test(d.sourceUrl || '')
        ? ok(`${key}: stamp has a clickable source (${d.sourceUrl})`)
        : bad(`${key}: sourceUrl missing/malformed — "Verified" stamp has no clickable source`);
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

// shareability: description, social cards, favicon, canonical (cold-audit W1a)
for (const tag of ['meta name="description"', 'property="og:title"', 'property="og:image"',
                   'name="twitter:card"', 'rel="icon"', 'rel="canonical"']) {
  html.includes(tag) ? ok('share/head tag present: ' + tag) : bad('MISSING head tag: ' + tag);
}
fs.existsSync(path.join(__dirname, 'og.png')) ? ok('og.png share image exists')
                                              : bad('og.png missing — social cards will show no image');

// cold-audit batch 2 guards: doing-layer card, feedback channel, heading semantics
html.includes('Your first 15 minutes') ? ok('"Your first 15 minutes" starter card present')
                                       : bad('starter card missing — site teaches about AI but not doing');
html.includes('baseline-ai-literacy/issues') ? ok('footer feedback link present')
                                             : bad('no feedback channel — readers cannot report stale content');
const h2s = (html.match(/<h2 class="stitle">/g) || []).length;
h2s === 5 ? ok('all 5 section titles are real <h2> headings (glossary lives in a topic card now)')
          : bad(`expected 5 <h2 class="stitle">, found ${h2s} — screen readers lose structure`);
fs.existsSync(path.join(__dirname, '.github/workflows/freshness.yml'))
  ? ok('freshness watchdog workflow present')
  : bad('freshness watchdog workflow missing');
// self-quiz: section present with exactly 5 questions defined
const quizBlock = html.match(/const QUIZ = \[([\s\S]*?)\n\];/);
if (!quizBlock) bad('QUIZ array missing');
else {
  const nq = (quizBlock[1].match(/\n\s*\["/g) || []).length;
  nq === 5 ? ok('self-quiz has exactly 5 questions') : bad(`expected 5 quiz questions, found ${nq}`);
}
html.includes('id="quiz"') ? ok('has id="quiz"') : bad('missing id="quiz"');
// reality check: three honest tiers — good / unreliable (check it) / can't (don't ask).
// "can't do" and "weak at" are different claims; never re-merge them.
(html.includes('✓ Good at') && html.includes('⚠ Unreliable at') && html.includes("✗ Can't do"))
  ? ok('reality check keeps good/unreliable/can\'t as three distinct tiers')
  : bad('reality-check tiers missing or re-merged (weak-at is not can\'t-do)');
// body diagram: 8 markers, and every list item's part has a matching dot on the figure
const dotParts = [...html.matchAll(/class="bp-dot" data-part="(\w+)"/g)].map(m => m[1]);
dotParts.length === 8 ? ok('body figure has 8 tappable markers') : bad(`expected 8 bp-dots, found ${dotParts.length}`);
const bmBlock = html.match(/const BODYMAP = \[([\s\S]*?)\n\];/);
if (bmBlock) {
  const itemParts = [...bmBlock[1].matchAll(/, "(\w+)"\]/g)].map(m => m[1]);
  const unmatched = itemParts.filter(p => !dotParts.includes(p)).concat(dotParts.filter(p => !itemParts.includes(p)));
  unmatched.length === 0 ? ok('figure markers and body-map items are 1:1')
                         : bad('figure/list mismatch: ' + unmatched.join(', '));
} else bad('BODYMAP array not found');

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
