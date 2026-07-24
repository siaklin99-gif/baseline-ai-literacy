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

/* ---------- 1b. honesty: downloadable models are "open weight", not OSI "open source" ---------- */
{
  const dsrc = read('data.js');
  !/Open source/.test(dsrc)
    ? ok('models labelled "open weight" (not overclaimed as OSI "open source")')
    : bad('data.js still says "Open source" — Llama et al. are open-WEIGHT; fix the label');
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
for (const need of ['id="peel"', 'class="pl-stage"', 'class="pl-btn"', 'id="cards"', 'id="bodymap"', 'id="glossary"']) {
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
h2s === 8 ? ok('all 8 section titles are real <h2> headings')
          : bad(`expected 8 <h2 class="stitle">, found ${h2s} — screen readers lose structure`);
fs.existsSync(path.join(__dirname, '.github/workflows/freshness.yml'))
  ? ok('freshness watchdog workflow present')
  : bad('freshness watchdog workflow missing');
// self-quiz: section present with exactly 5 questions defined
const quizBlock = html.match(/const QUIZ = \[([\s\S]*?)\n\];/);
if (!quizBlock) bad('QUIZ array missing');
else {
  const nq = (quizBlock[1].match(/\n\s*\["/g) || []).length;
  nq === 9 ? ok('self-quiz has exactly 9 questions') : bad(`expected 9 quiz questions, found ${nq}`);
}
html.includes('id="quiz"') ? ok('has id="quiz"') : bad('missing id="quiz"');
// quiz is actually scored (answer buttons + tally), not just reveal
(html.includes('class="qz-opt"') && html.includes('You got ${qzCorrect}') && html.includes('qzCorrect++')) ? ok('quiz is scored (answer buttons + running score)') : bad('quiz not scored');
// action-first block: try panel with a copy-a-prompt button + tool links
(html.includes('id="try"') && html.includes('try-copy') && html.includes('chatgpt.com')) ? ok('above-fold action panel (copy prompt + tool links) present') : bad('action panel missing');
// multiple starter prompts (not one generic line) so a beginner sees a use that fits them
((html.match(/class="try-tab/g) || []).length >= 3 && html.includes('data-prompt=')) ? ok('action panel offers 3+ swappable starter prompts') : bad('only one starter prompt (add variety)');
// trust signal grounded in real properties (no invented authority) + honest maker attribution
(html.includes('class="trust"') && html.includes('trust-pill') && html.includes('>hlur.ai<')) ? ok('trust strip present (real properties + hlur.ai attribution)') : bad('trust strip missing');
// core thesis surfaced in the hero (was buried in a collapsed card)
(html.includes('class="hero-thesis"') && /someone who uses it/.test(html)) ? ok('replacement thesis surfaced in the hero') : bad('thesis not in hero');
// AI-deception safety card (biggest content gap in the cold audit)
(html.includes('Spotting AI fakes') && html.includes('family code word')) ? ok('AI-fakes/scams safety card present') : bad('safety card missing');
// IP: MCP analogy must be our own expression, not Anthropic's "USB-C for AI" line
(!html.includes('USB-C')) ? ok('MCP analogy is original (no lifted "USB-C" line)') : bad('MCP still uses the "USB-C" marketing phrasing');
// dedicated "Under the hood" section with the LLM explainer + its interactive demo
(html.includes('id="howllm"') && html.includes('id="card-llm-predict"') && html.includes('id="llmDemo"') && html.includes('id="llmStep"'))
  ? ok('"Under the hood" section + interactive next-word demo present') : bad('LLM section / interactive demo missing');
// the deep-dive ladder: predict → tokens/embeddings → attention → training → assistant
(['card-tokens','card-attention','card-training','card-assistant'].every(id => html.includes(`id="${id}"`)) && /king − man \+ woman ≈ queen/.test(html))
  ? ok('full mechanism ladder present (tokens · attention · training · fine-tuning)') : bad('a mechanism deep-dive card is missing');
// external hands-on links must resolve to a real place (verified https)
(!/karpathy\/(nanoGPT|makemore)/.test(html) || /href="https:\/\/github\.com\/karpathy\/(nanoGPT|makemore)"/.test(html))
  ? ok('Karpathy hands-on links are well-formed https URLs') : bad('malformed Karpathy link');
// its toy code must stay copy-paste runnable (uses random.choices → needs the import)
(!/random\.choices/.test(html) || /import random/.test(html))
  ? ok('LLM toy code is runnable (import matches usage)') : bad('LLM toy code uses random.choices without "import random"');
// core layer frames AI as an alien intelligence WE grew — and keeps the honest caveat (no "nothing to worry about")
(/alien kind of intelligence/.test(html) && /we grew from our own writing/.test(html) && /trusted blindly/.test(html))
  ? ok('core layer: alien-intelligence framing kept with its honest caveat') : bad('core layer alien framing / caveat missing');
// small MEANINGFUL gradient text uses the AA-safe (no-teal) gradient, not the display gradient
(html.includes('--grad-text') && /\.gl-cterm \.gt \{ background: var\(--grad-text\)/.test(html) && /\.qz-src[^}]*var\(--grad-text\)/.test(html))
  ? ok('glossary terms + quiz source use AA-safe text gradient (WCAG contrast)') : bad('small meaningful text still on the low-contrast display gradient');
// keyboard a11y: the custom (non-native) controls must be operable without a mouse
(html.includes("el.setAttribute('role', 'button')") && html.includes("el.setAttribute('tabindex', '0')") && /item\.addEventListener\('keydown'/.test(html))
  ? ok('body-map items are keyboard-operable (role=button + tabindex + Enter/Space handler)') : bad('body-map items not keyboard-operable');
(/<a class="lc-t" href="\$\{s\[2\]\}">/.test(html))
  ? ok('learning-circle steps navigate via a real in-page link (keyboard-reachable)') : bad('circle nav is not a keyboard-reachable link');
(html.includes("qzScore.setAttribute('aria-live', 'polite')"))
  ? ok('quiz score is announced to screen readers (aria-live)') : bad('quiz score missing aria-live');
// quiz must mix yes and no answers (not an 'always say no' reflex)
(/"Yes.",/.test(html) && /"No.",/.test(html)) ? ok('quiz has both yes- and no-answer questions') : bad('quiz missing a yes-answer question (lopsided)');
// learning circle has a reset control
html.includes('id="lcReset"') ? ok('learning circle reset button present') : bad('no reset for the learning circle');
// learning circle: 6 steps, and every step's jump target must exist
const circleBlock = html.match(/const CIRCLE = \[([\s\S]*?)\n\];/);
if (!circleBlock) bad('CIRCLE array missing');
else {
  const steps = (circleBlock[1].match(/\n\s*\["/g) || []).length;
  steps === 6 ? ok('learning circle has exactly 6 steps') : bad(`expected 6 circle steps, found ${steps}`);
  const anchors = [...circleBlock[1].matchAll(/"#([\w-]+)"/g)].map(m => m[1]);
  const missing = anchors.filter(a => !html.includes(`id="${a}"`) && !html.includes(`"${a}"`));
  missing.length === 0 ? ok('every circle step jumps to an existing anchor')
                       : bad('circle anchors with no target: ' + missing.join(', '));
}
html.includes('id="circle"') ? ok('has id="circle"') : bad('missing id="circle"');

// GOAL LOCKS (2026-07-23 cold audit): the six stated goals' key content must stay on the page
html.includes('people who use AI replace people who don') && html.includes('Will AI take my job?')
  ? ok('goal 6: replacement thesis + jobs card present')
  : bad('goal 6 MISSING: "people who use AI replace..." thesis / jobs card gone');
html.includes('Common myths, busted') && html.includes('is only a few years old')
  ? ok('goal 5: myths card present (jobs, objectivity, too-late, always-right)')
  : bad('goal 5 MISSING: myths card gone or gutted');
const nPrompts = (html.match(/class="prompt"/g) || []).length;
nPrompts >= 13 ? ok(`goal 3: ${nPrompts} copy-paste prompts on the page (3 starter + 10 daily)`)
               : bad(`goal 3: only ${nPrompts} prompts — daily-life card gone or gutted (want >= 13)`);
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
// topics grouped by level: 3 groups defined, every card assigned, split adds to 13
const levelBlock = html.match(/const LEVELS = \[([\s\S]*?)\n\];/);
const cardLevelsBlock = html.match(/const CARD_LEVELS = \[([\s\S]*?)\];/);
if (levelBlock && cardLevelsBlock) {
  const nGroups = (levelBlock[1].match(/\['/g) || []).length;
  const assigned = (cardLevelsBlock[1].match(/'(beginner|intermediate|advanced)'/g) || []).length;
  (nGroups === 3 && assigned === 17)
    ? ok(`topics grouped into 3 levels; all ${assigned} cards assigned (7/5/5)`)
    : bad(`level grouping off: ${nGroups} groups (want 3), ${assigned} cards assigned (want 17)`);
} else bad('LEVELS / CARD_LEVELS grouping arrays missing');
// peel supports both directions
html.includes('class="pl-btn pl-up"') && /Peel back up/.test(html)
  ? ok('peel has both deeper and back-up controls')
  : bad('peel "back up" control missing');

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
g(/aria-pressed/.test(html), 'interactive toggles expose aria-pressed state');
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
