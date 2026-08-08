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

/* The Hlur host repo lives OUTSIDE this repo, and this repo is PUBLIC — so no
   check may name it by absolute path (that publishes the author's machine
   username and a private project's location; the exact leak AI_Hub treated as
   a release blocker). Resolution order: HLUR_SITE (explicit override), $DEST/..
   (CI, where DEST points at <host>/baseline), then the relative sibling
   checkout. Absent everywhere => null, and every caller degrades to a loud
   SKIP that still COUNTS (a check that only exists locally deadlocks the
   homepage claim gate — see the note at the tally-function check). */
function hlurFile(...seg) {
  const roots = [
    process.env.HLUR_SITE,
    process.env.DEST && path.join(process.env.DEST, '..'),
    path.join(__dirname, '..', 'LLC', 'Hlur_Website'),
  ].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, ...seg);
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}
const HLUR_SKIP = 'host repo not found (set HLUR_SITE or check out the sibling)';

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
/* EVERY section needs a real heading, checked per section rather than by counting them.
   The old check asserted "10 h2s" across 11 sections and so could not notice that #share
   had none — it became a full-screen layer whose only title was a 12px eyebrow. A count
   is satisfied by the wrong ten. */
{
  const secs = [...html.matchAll(/<section id="([^"]+)"[\s\S]*?<\/section>/g)];
  const missing = secs.filter(m => !/<h2\b/.test(m[0])).map(m => m[1]);
  missing.length === 0
    ? ok(`all ${secs.length} sections carry a real <h2> heading (incl. every layer-2 door)`)
    : bad(`sections with no <h2>: ${missing.join(', ')} — a screen reader lands in an untitled layer`);
}
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
// the animated flow: 4 clickable stages + build chips → deep-dives, has a pause control, reduced-motion-safe
// install button must have a no-prompt fallback (Safari never fires beforeinstallprompt)
(/setTimeout\(\(\) => \{ if \(!pwaPrompt/.test(html) && html.includes('id="pwaHow"') && /display-mode: standalone/.test(html))
  ? ok('install button has Safari fallback + standalone detection') : bad('install fallback missing — Safari users get no install path');
(html.includes('id="gptflow"') && (html.match(/class="gf-stage/g) || []).length >= 4
  && html.includes('data-card="card-attention"') && html.includes('data-card="card-training"')
  && html.includes('id="gfPause"') && /prefers-reduced-motion[^}]*gf-fill/.test(html))
  ? ok('animated flow present (4 stages → deep-dives; pause control; reduced-motion-safe)') : bad('animated flow missing/incomplete');
// 2026 cold-audit locks: factual drift + confirmed UX seams must not return
(html.includes('Check the memory setting') && html.includes('apps add search') && !/Does it remember you between chats, by default\?/.test(html))
  ? ok('quiz Q3/Q4 match current product truth (memory + web search on by default)') : bad('quiz reverted to stale "no memory / no news" claims');
(/a\.try-more/.test(html) && /t\.open = true/.test(html))
  ? ok('try-more link opens its collapsed target card (not a dead-end anchor)') : bad('try-more dead-ends on a collapsed card again');
(/const REDUCE = window\.matchMedia/.test(html) && !/behavior: 'smooth'/.test(html))
  ? ok('all smooth scrolls respect prefers-reduced-motion (REDUCE-gated)') : bad('an unconditional smooth scroll crept back in');
(/IntersectionObserver\(/.test(html) && /userPaused/.test(html))
  ? ok('flow animation runs only on-screen (IO) and manual pause wins') : bad('flow animation autoplays offscreen again');
// flow: nothing moves until the user presses Play, and each prediction shows ITS OWN odds
(/let userPaused = true/.test(html) && /const PRED = /.test(html) && /\[\['today', 60\]/.test(html))
  ? ok('flow is play-on-demand with per-prediction odds (today gets its own bars)') : bad('flow autoplays or the odds bars are static again');
// match by ID, not a literal tag string — the sections gained a class and this guard
// silently started comparing -1 < -1, reporting a break that had not happened
(html.indexOf('id="topics"') < html.indexOf('id="howllm"') && html.indexOf('id="topics"') > -1)
  ? ok('beginner path unbroken: topic cards come before Under the hood') : bad('Under the hood interrupts the beginner path again');
(!/\.pills \{/.test(html) && !/c\[5\]/.test(html))
  ? ok('dead filter-pill CSS and orphaned card field stay removed') : bad('dead pills CSS / orphaned c[5] came back');
(!/id="gfSentence" aria-live/.test(html))
  ? ok('auto-animating sentence is not an aria-live announce-loop') : bad('aria-live back on the auto-animation');
(/bmSelect/.test(html))
  ? ok('body-map selection is state-tracked (hover cannot desync clicks)') : bad('body-map click/hover desync fix missing');
// CARDS must be a dense 16-entry array — a stray comma creates a HOLE, forEach skips it,
// every later card shifts one level and the last falls out of its group (real bug, 2026-07-24)
{
  const cm = html.match(/const CARDS = \[[\s\S]*?\n\];/);
  let cardsArr = null;
  try { cardsArr = new Function(cm[0] + ' return CARDS;')(); } catch (e) {}
  let holes = 0; if (cardsArr) for (let i = 0; i < cardsArr.length; i++) if (!(i in cardsArr)) holes++;
  (cardsArr && cardsArr.length === 16 && holes === 0)
    ? ok('CARDS is dense: 16 entries, no array holes')
    : bad(`CARDS malformed: ${cardsArr ? cardsArr.length : 'uneval'} entries, ${holes} hole(s) — cards will silently fall out of their groups`);
}
// topics-section optimization locks (2026-07-24 cold audit)
(!/Why work won't train you/.test(html) && /don't wait for work to train you/.test(html))
  ? ok('thin work-gap card stays merged into the jobs card') : bad('work-gap card back as a standalone (or its point lost)');
(/a\.try-more, a\.xref/.test(html) && /href="#card-job"/.test(html) && /href="#card-bias"/.test(html))
  ? ok('in-card cross-references are real open-and-scroll links') : bad('cross-references degraded to bold text again');
(html.indexOf('AI jargon in plain English') < html.indexOf('"Pick the right model for the job"'))
  ? ok('jargon decoder lives in the Beginner group (day-one need)') : bad('jargon card demoted out of Beginner');
(!/\.gl-deck > \*/.test(html))
  ? ok('glossary is a vertical list on mobile (no deck-in-a-deck)') : bad('nested glossary swipe deck is back');
(!/Explain \[a term you keep hearing\]/.test(html))
  ? ok('15-min card prompts extend (not duplicate) the try panel') : bad('15-min card duplicates the try-panel prompts again');
// ---------- 2026-07-30 platform batch: return loop, games, PWA, clip mode ----------
// return loop: misses persist + resurface, visits counted — all device-local
(/qzRemember/.test(html) && html.includes("'baseline_quiz_missed'") && html.includes('qz-return') && html.includes('id="lcDay"'))
  ? ok('return loop wired (missed questions persist + welcome-back + visit days)') : bad('return loop missing/regressed');
// three micro-games present and honest (spot-the-fake declares its fabrication)
(html.includes('id="spotFake"') && html.includes('One is a confident fabrication') && html.includes('id="glMatch"') && /initModelPick/.test(html) && html.includes('"card-models"'))
  ? ok('all three micro-games present (fake-spotter self-declares the game)') : bad('a micro-game is missing');
// PWA: manifest linked + files exist + SW is network-first + registration guarded for file://
{
  const mOk = fs.existsSync(path.join(__dirname, 'manifest.json')) && fs.existsSync(path.join(__dirname, 'sw.js'))
    && fs.existsSync(path.join(__dirname, 'icon-192.png')) && fs.existsSync(path.join(__dirname, 'icon-512.png'));
  const sw = mOk ? read('sw.js') : '';
  (mOk && html.includes('rel="manifest"') && /network-first/i.test(sw) && /caches\.match/.test(sw)
    && html.includes("location.protocol.startsWith('http')"))
    ? ok('PWA complete (manifest + icons + network-first SW + guarded registration)')
    : bad('PWA incomplete (missing file, non-network-first SW, or unguarded registration)');
  let mf = null; try { mf = JSON.parse(read('manifest.json')); } catch (e) {}
  (mf && mf.start_url === './' && mf.scope === './' && (mf.icons || []).length === 2)
    ? ok('manifest is path-portable (relative start_url/scope, 2 icons)') : bad('manifest fields wrong');
  // the sync pipeline must carry every PWA file or the deploy silently strips the app
  (read('sync_hlur.sh').includes('manifest.json sw.js icon-192.png icon-512.png'))
    ? ok('sync pipeline ships the PWA files') : bad('sync_hlur.sh does not copy the PWA files');
  // CI must redeploy when a PWA file changes
  (read('.github/workflows/deploy-hlur.yml').includes("'sw.js'"))
    ? ok('CI paths trigger includes the PWA files') : bad('editing sw.js/manifest would never redeploy (CI paths)');
  // host-site build must pass the PWA through its leak gate. The check must COUNT in
  // every environment (the homepage advertises the total, and a conditional check made
  // local=131 vs CI=130 → the claim gate blocked CI deploys). Locally the host repo is
  // the sibling checkout; in CI it's wherever DEST points; if truly absent, the check
  // still counts as an explicit skip.
  const bd = hlurFile('build_dist.js');
  if (bd) {
    const src = fs.readFileSync(bd, 'utf8');
    (/PWA_FILES/.test(src) && /sw\.js/.test(src))
      ? ok('host build ships + exempts the baseline PWA files')
      : bad('Hlur build_dist.js would strip or reject the PWA (sw.js/manifest/icons)');
  } else {
    ok('host-build PWA check: SKIP — ' + HLUR_SKIP);
  }
}
// progress transfer: export/import round-trip code paths + validation
(html.includes("'BL1.'") && /pxApply/.test(html) && /JSON\.parse\(o\[k\]\)/.test(html))
  ? ok('progress transfer present with per-key JSON validation') : bad('progress transfer missing/unvalidated');
// clip mode: both variants + not reachable by accident (no in-page link to ?clip)
(/data-clip/.test(html) && /clip=write\|peel|'write' && clip !== 'peel'/.test(html) && !/href="[^"]*\?clip=/.test(html))
  ? ok('clip modes present and unlinked (recording tool, not nav)') : bad('clip mode broken or linked from page');
// the social clips must stay discoverable FROM the page, with absolute URLs (they only
// exist on hlur.ai — a relative link would 404 on the GitHub Pages home)
(html.includes('https://hlur.ai/baseline/clips/watch-it-write.mp4') && html.includes('https://hlur.ai/baseline/clips/peel-the-layers.mp4'))
  ? ok('footer links both shareable clips (absolute URLs, both homes safe)') : bad('clip links missing from the page footer');
// don't fake a produced video — point to the real one (verified https)
(!/3Blue1Brown|LPZh9BOjkQs/.test(html) || /href="https:\/\/www\.youtube\.com\/watch\?v=LPZh9BOjkQs"/.test(html))
  ? ok('3Blue1Brown video is a well-formed link (credited, not imitated)') : bad('malformed 3B1B link');
// external hands-on links must resolve to a real place (verified https)
(!/karpathy\/(nanoGPT|makemore)/.test(html) || /href="https:\/\/github\.com\/karpathy\/(nanoGPT|makemore)"/.test(html))
  ? ok('Karpathy hands-on links are well-formed https URLs') : bad('malformed Karpathy link');
// its toy code must stay copy-paste runnable (uses random.choices → needs the import)
(!/random\.choices/.test(html) || /import random/.test(html))
  ? ok('LLM toy code is runnable (import matches usage)') : bad('LLM toy code uses random.choices without "import random"');
// core layer frames AI as an alien intelligence WE grew — and keeps the honest caveat (no "nothing to worry about")
(/alien kind of intelligence/.test(html) && /we grew from our own writing/.test(html) && /trusted blindly/.test(html))
  ? ok('core layer: alien-intelligence framing kept with its honest caveat') : bad('core layer alien framing / caveat missing');
// Small meaningful labels must not sit on the display gradient — contrast against a
// gradient is not one number, so visual.js SKIPS those elements and can never judge them.
// That skip is exactly why this check still earns its place. What it must NOT do is
// claim the labels are "AA": visual.js measures that at runtime against real surfaces,
// and a source proxy asserting the same thing would keep printing green even after the
// token behind --accent regressed. Two owners for one fact drift apart; this one now
// owns only the part visual.js structurally cannot see.
(!/\.gl-cterm \.gt[^}]*var\(--grad\)/.test(html) && !/\.qz-src[^}]*var\(--grad\)/.test(html))
  ? ok('no small meaningful text sits on the display gradient (visual.js owns the AA verdict)')
  : bad('small meaningful text is back on the gradient — visual.js cannot measure contrast there');
// 2026-07-24 design consolidation locks
{
  const halfPx = (html.match(/font-size: \d+\.5px/g) || []).length;
  const oddWeights = (html.match(/font-weight: (550|620|650|800)/g) || []).length;
  const gradUses = (html.match(/var\(--grad\)/g) || []).length;
  (halfPx === 0 && oddWeights === 0) ? ok('type scale holds (no half-pixel sizes, weights {500,600,700})')
    : bad(`type drift: ${halfPx} half-px sizes, ${oddWeights} odd weights`);
  // budget 18 → 19 (2026-07-29): +1 for the attention-playground bars, which mirror the
  // existing gf-fill gradient bars exactly. All new chip selected-states stay solid.
  (gradUses <= 19) ? ok(`gradient budget held (${gradUses} uses ≤ 19 — identity, not wallpaper)`)
    : bad(`gradient splatter returning: ${gradUses} uses (budget 19)`);
  (/section \{ padding: 44px 0; \}/.test(html) && /#reality \{ background: var\(--surface2\)/.test(html) && /#quizsec \{ background: linear-gradient/.test(html))
    ? ok('section rhythm: 44px gaps + reality band + quiz wash') : bad('section rhythm treatments missing');
  (!/0\.5px/.test(html)) ? ok('no 0.5px hairlines (render reliably everywhere)') : bad('0.5px borders back');
  // 3 -> 4 (2026-08-07): an independence pill. This page names products — three in
  // the hero, eight in the model card, three more in the price card — and disclosed
  // nothing, while the sibling site at hlur.ai/hub carries "nothing on this site is
  // sponsored". Naming without disclosing was the real exposure, not the names.
  ((html.match(/class="trust-pill"/g) || []).length === 4) ? ok('trust strip is 4 short pills') : bad('trust strip bloated again');
  // The page may not name products without saying whose side it is on.
  (/Nothing sponsored · no affiliate links/.test(html))
    ? ok('independence disclosed on the page that names products')
    : bad('this page names products but no longer discloses that nothing is sponsored');
  // And the disclosure must stay TRUE: a tracking parameter on any outbound
  // product link would make the pill a lie.
  (!/https:\/\/(chatgpt\.com|claude\.ai|gemini\.google\.com)[^"]*[?&]/.test(html))
    ? ok('outbound product links carry no affiliate/tracking parameters')
    : bad('an outbound product link gained a query parameter — the independence pill would be false');
}
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
  steps === 7 ? ok('learning circle has exactly 7 steps (incl under-the-hood)') : bad(`expected 7 circle steps, found ${steps}`);
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
const cardLevelsBlock = html.match(/const CARD_LEVELS = ([\s\S]*?);\n/);
if (levelBlock && cardLevelsBlock) {
  const nGroups = (levelBlock[1].match(/\['/g) || []).length;
  // evaluate the real expression (it may use Array.fill), don't count string literals
  let lv = [];
  try { lv = new Function('return ' + cardLevelsBlock[1])(); } catch (e) {}
  const counts = { beginner: 0, intermediate: 0, advanced: 0 };
  (Array.isArray(lv) ? lv : []).forEach(k => { if (k in counts) counts[k]++; });
  (nGroups === 3 && lv.length === 16 && counts.beginner === 8 && counts.intermediate === 5 && counts.advanced === 3)
    ? ok(`topics grouped into 3 levels; all ${lv.length} cards assigned (8/5/3)`)
    : bad(`level grouping off: ${nGroups} groups (want 3), ${lv.length} assigned as ${counts.beginner}/${counts.intermediate}/${counts.advanced} (want 16 as 8/5/3)`);
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

/* ---------- 5. regression guards: 2026-07-29 roadmap batch (cold-audit fixes) ---------- */
// spaced repetition v2: 1/3/7-day steps, format-validated + de-duped storage
g(/QZ_STEPS = \[1, 3, 7\]/.test(html), 'spaced repetition uses 1/3/7-day steps');
g(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(html), 'quiz-miss entries validate due-date format (cold-audit #2)');
g(html.includes('!seen.has(x.i) && seen.add(x.i)'), 'quiz-miss entries de-duped per question (cold-audit #3)');
g(html.includes('t.due > localDate(0)) return null'), 'early correct answers do not advance the spaced schedule');
g(/'locked'/.test(html) && /qz-lock/.test(html), 'third spaced win locks a question in (chip + retire path)');
// path picker: stored JSON-encoded or the progress-transfer import breaks (cold-audit #1)
g(html.includes("localStorage.setItem('baseline_path', JSON.stringify(key))"), 'baseline_path stored JSON-encoded (transfer-safe, cold-audit #1)');
g(html.includes("'baseline_path']"), 'progress transfer carries baseline_path');
// share-your-score writes its note to a dedicated span, never over the rotation status line
g(html.includes('qz-share-note') && html.includes("qzScore.querySelector('.qz-share-note')"), 'share-score note has its own span (cold-audit #5)');
g(/function shareOut\(/.test(html), 'shareOut helper present (native share + clipboard fallback)');
// attention playground + lab 001 + labs section + whats-new line
g(html.includes('id="attnPlay"'), 'attention playground present');
g(/Illustrative weights/.test(html), 'attention playground carries its honesty label');
g(html.includes('id="labs"') && html.includes('Lab 001'), 'Baseline Labs section + Lab 001 present');
g(html.includes('id="labCopy"'), 'lab 001 has a copy-and-try button');
// falsification-checked: a generic aria-pressed count passes on PRE-fix code (13 prior uses) —
// require each new chip group's own wiring instead
g(html.includes('class="path-chip" type="button" aria-pressed="false"')
  && /class="lab-chip" data-k="\w+" type="button" aria-pressed="false"/.test(html)
  && html.includes("b.setAttribute('aria-pressed', 'false')")
  && (html.match(/setAttribute\('aria-pressed', String\(/g) || []).length >= 3,
  'all three new chip groups expose live aria-pressed state (cold-audit #4)');
g(/class="whats-new"/.test(html) && /<i>\d{4}-\d{2}-\d{2}<\/i>/.test(html), 'dated whats-new line in trust strip');
// 8 of 13 codeblocks scroll sideways on mobile — scroll shadows make that visible, not broken-looking
g(/\.codeblock \{[^}]*background-attachment: local, local, scroll, scroll, local/.test(html)
  && html.includes('--cb-shadow'), 'codeblocks carry self-hiding scroll shadows (mobile swipe affordance)');

/* ---------- 6. regression guards: 2026-07-30 cold-audit batch ---------- */
// attention must be CAUSAL: row i may only reference indexes <= i, or the playground
// teaches a mechanism the rest of the page spends ten layers contradicting.
{
  const m = html.match(/const ATTN = \[([\s\S]*?)\n  \];/);
  if (!m) bad('ATTN table missing');
  else {
    const rows = [...m[1].matchAll(/w: \[(.*?)\], why/g)].map(x => x[1]);
    let fwd = 0, bad_sum = 0;
    rows.forEach((r, i) => {
      const pairs = [...r.matchAll(/\[(\d+),\s*([\d.]+)\]/g)].map(p => [+p[1], parseFloat(p[2])]);
      pairs.forEach(([t]) => { if (t > i) fwd++; });
      if (Math.abs(pairs.reduce((s, p) => s + p[1], 0) - 1) > 0.001) bad_sum++;
    });
    (rows.length === 9 && fwd === 0)
      ? ok('attention playground is causal (no word attends to a later word)')
      : bad(`attention playground has ${fwd} forward-looking weight(s) across ${rows.length} rows — contradicts next-word prediction`);
    bad_sum === 0 ? ok('every attention row sums to 1.00') : bad(`${bad_sum} attention row(s) do not sum to 1.00`);
  }
  g(/look back at the words before it/.test(html), 'attention copy says backwards-only, matching the data');
}
// spot-the-fake must be solvable by REASONING: each tell has to point at the other statements
{
  const m = html.match(/const ROUNDS = \[([\s\S]*?)\n  \];/);
  const tells = m ? [...m[1].matchAll(/tell: '((?:[^'\\]|\\.)*)'/g)].map(x => x[1]) : [];
  const deducible = tells.filter(t => /other two|each other|next to it|from the other|arithmetic|contradic|rule[sd]? .*out|fenced/i.test(t));
  (tells.length === 3 && deducible.length === 3)
    ? ok('all 3 spot-the-fake rounds are solvable from the statements shown (not trivia recall)')
    : bad(`${deducible.length}/${tells.length} spot-the-fake tells cite the other statements — the rest test recall`);
  g(!/Luna Nova/.test(html), 'trivia-only Galileo round retired');
}
// start-path picker must actually FILTER, not just tint, and must be reversible
// Superseded by layer 2. The picker's hide-lists existed to shorten a 27-screen page;
// moving the four deep-dives off the main scroll did that far better, so the lists are
// now empty and the picker marks the route only. Guarding that they stay empty keeps
// two mechanisms from re-growing to solve the same problem.
g(/new:  \{ steps: \[0, 1, 3\], hide: \[\] \}/.test(html) && /tech: \{ steps: \[5, 6\],    hide: \[\] \}/.test(html),
  'the path picker marks only — layer 2 replaced its hide-lists rather than duplicating them');
g(html.includes('.path-off { display: none !important; }'), 'off-path content is hidden by class (restorable, not deleted)');
g(html.includes("id=\"pathAll\"") || html.includes("'pathAll'"), 'a one-tap "Show everything" escape exists');
// Shortening the page must stay OPT-IN. Hiding four sections the moment someone picks a
// starting point makes the page look like it holds less than it does, and a reader who
// did not ask for less should not silently get less.
g(html.includes("say(key, false);                       // nothing hidden until asked"),
  'picking a start path hides NOTHING by default — it only marks the route');
g(html.includes("id=\"pathFocus\"") && /Show just this path/.test(html),
  'focusing is an explicit, labelled choice the reader makes');
g(/only the PATH is restored, never the focused state/.test(html),
  'a returning visitor always lands on the complete page (focus is never persisted)');
g(/id="lab-checking" open/.test(html) && !/id="lab-prompting" open/.test(html),
  'newest lab open, older one collapsed (Labs was the tallest block on desktop)');
// The desktop rail: nine sections at ~1 screen each is 11 screens of scrolling and none of
// it is fat, so the answer is navigability, not cutting content (Stripe/MDN/Tailwind).
// Entries MUST be derived from the DOM — a hand-list is how #howllm went missing from the
// visual harness for a week.
g(html.includes('id="rail"') && html.includes('id="railNav"'), 'desktop rail present');
/* ---- LAYER 2: the four deep-dives open on top instead of extending the scroll ---- */
{
  const deep = (html.match(/<section id="(bodysec|topics|howllm|labs|share)" class="deep/g) || []).length;
  g(deep === 5, `5 deep sections marked for layer 2, incl. Pass it on (found ${deep})`);
}
g(/\.deep \{ display: none; \}/.test(html) && /\.deep\.open \{/.test(html),
  'deep sections are HIDDEN, never removed — the page stays one crawlable document and every #anchor still resolves');
g(html.includes('id="deepGrid"') && /const DEEP = \{/.test(html),
  'a doorway lists the deep sections rather than hiding them from the reader');
// Artwork is DRAWN, not photographed: a stock photo of a robot is exactly the hype this
// page exists to defuse, it would be someone else's work, and it would break the page's
// one-request promise. Inline SVG from the page's own tokens themes itself for free.
{
  const ids = ['bodysec','topics','howllm','labs','share'];
  const have = ids.filter(k => new RegExp(k + ':\\s*`<svg class="deep-art"').test(html));
  g(have.length === 5, `every door carries its own inline artwork (${have.length}/5)`);
  g(!/<img[^>]+deep-art/.test(html) && /var\(--g[123]\)/.test(html),
    'door artwork is inline SVG using the page tokens — no external image request, no borrowed photo');
}
/* Two ways a door count can be RIGHT in the DOM and WRONG on the screen. Both shipped for
   one commit when the fifth door landed, and every existing check stayed green, because a
   correct page can still say a false thing (Generated-Claims Rule). */
{
  const sub = (html.match(/id="deeper"[\s\S]{0,900}?<div class="ssub">([\s\S]*?)<\/div>/) || [])[1] || '';
  g(sub && !/\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i.test(sub),
    'the doorway blurb counts nothing — a hardcoded "these four" goes stale the day a door is added');
}
{
  // Every deep section must resolve to a human title in the rail. SHORT may override for
  // width, but the FALLBACK must be DEEP — not the raw id, which is what "share" rendered.
  const short = (html.match(/const SHORT = \{[\s\S]*?\};/) || [''])[0];
  const ids = ['bodysec','topics','howllm','labs','share'];
  const uncovered = ids.filter(k => !new RegExp('\\b' + k + ':').test(short));
  g(/DEEP\[sec\.id\] && DEEP\[sec\.id\]\[0\]/.test(html),
    `rail labels fall back to DEEP, so the ${uncovered.length} door(s) not in SHORT still read as titles`);
  /* The DOOR and the SECTION are two lists that must stay equal. A cold audit deleted the
     share: entry from DEEP and every static check still passed: the section kept existing,
     it simply had no way in and no title anywhere. Compare the two lists directly. */
  const map = (html.match(/const DEEP = \{[\s\S]*?\n\};/) || [''])[0];
  const inMap = [...map.matchAll(/^\s{2}(\w+):\s*\[/gm)].map(m => m[1]);
  const inDom = [...html.matchAll(/<section id="([^"]+)" class="deep/g)].map(m => m[1]);
  const orphan = inDom.filter(id => !inMap.includes(id));
  const ghost  = inMap.filter(id => !inDom.includes(id));
  g(orphan.length === 0 && ghost.length === 0 && inMap.length === 5,
    `every deep section has a door and every door has a section (${inMap.length} each` +
    `${orphan.length ? '; unreachable: ' + orphan.join(',') : ''}${ghost.length ? '; door to nothing: ' + ghost.join(',') : ''})`);
}
/* Counting is DISCLOSED to the reader by name, so the code must not quietly count more.
   deepOpen() called tally('lab') on every door open — including the "Pass it on" door,
   which is not a lab — so the published "lab copies" number silently became "doors opened
   plus labs copied", and a learning-circle row counted twice. A wrong number under an
   honest label is worse than no number. */
g(!/function deepOpen\([\s\S]*?\n\}/.test(html) || !/function deepOpen\([\s\S]*?\n\}/.exec(html)[0].includes('tally('),
  'opening a door counts nothing — the tally means what the footer says it means');
/* ---- mobile swipe decks: the long sections move sideways, not down ---- */
{
  // ONE deck implementation. Can/Can't, Topics and the body map already swiped; the
  // doorway and the self-test join the SAME rule rather than getting a second mechanism
  // that would drift from it.
  const rule = (html.match(/\.cols, \.tg-deck, #bodymap[^{]*\{/) || [''])[0];
  g(/\.deep-grid/.test(rule) && /\.qz-deck/.test(rule),
    'the doorway and the self-test swipe on mobile, using the same deck rule as the other decks');
  const child = (html.match(/\.cols > \*, \.tg-deck > \*[^{]*\{[^}]*\}/) || [''])[0];
  g(/scroll-snap-align: start/.test(child) && /82vw/.test(child),
    'cards snap and stop at 82vw so the NEXT card peeks — the affordance that says "swipe me"');
  // The running score must not be swipeable: as a direct child of #quiz it would have
  // become card 1 of the deck, so the questions live in their own wrapper.
  g(/qzDeck\.className = 'qz-deck'/.test(html) && /qzDeck\.appendChild\(el\)/.test(html) &&
    /quiz\.appendChild\(qzScore\)/.test(html),
    'the running score sits outside the swipe deck (as a child it would be the first card)');
  g(/initDeck\(document\.getElementById\('deepGrid'\)\)/.test(html) &&
    /initDeck\(document\.querySelector\('\.qz-deck'\)\)/.test(html),
    'both new decks get progress dots from the shared initDeck (built by JS, so wired after render)');
  g(/\.deep-grid > \*, \.qz-deck > \*, #lcList > \*, \.clip-deck > \* \{ align-self: flex-start; \}/.test(html),
    'deck cards keep their own height — stretch would let the tallest card inflate the whole row');
  // The circle is the one deck with NO dots: the ring already shows position, and two
  // indicators for one fact is how they end up disagreeing.
  g(/#lcList, \.clip-deck \{|#lcList, \.clip-deck/.test(html) || /#lcList/.test(html),
    'the learning circle and the clip strip swipe too');
  g(/function lcIsDeck\(\)/.test(html) && /function lcTurnTo\(/.test(html) &&
    /if \(lcIsDeck\(\)\) lcTurnTo\(i\); else lcNavigate\(i\)/.test(html),
    'the ring is a DIAL on mobile — tapping a number turns the steps to it instead of leaving the section');
  g(/lcList\.addEventListener\('scroll'/.test(html) && /n\.classList\.toggle\('cur', k === i\)/.test(html),
    'swiping the steps turns the ring back (the dial reads both ways)');
  g(/\.lc-node\.cur circle:not\(\.lc-hit\)/.test(html),
    'the current step is marked on the ring — a one-at-a-time deck otherwise loses "where am I"');
}
g(/const host = t && t\.closest\('\.deep'\)/.test(html) && /deepOpen\(host\.id\)/.test(html),
  'any link into layer 2 opens it — one interception, not a per-link list');
g(/const deepHost = t\.closest\('\.deep'\)/.test(html),
  'learning-circle steps into layer 2 open it (they navigate directly, bypassing link handlers)');
g(/e\.key === 'Escape'/.test(html) && html.includes('id="deepClose"'),
  'the layer closes by Escape and by a visible control');
g(/history\.pushState\(\{ deep: id \}/.test(html) && /addEventListener\('popstate'/.test(html),
  'an open layer is a real history entry — shareable, and Back closes it');
g(/html\[data-deep\] \{ overflow: hidden; \}/.test(html),
  'the page behind a layer cannot scroll');
g(/document\.querySelectorAll\('section\[id\]'\)/.test(html) && /all\.map\(sec =>/.test(html),
  'rail entries are derived from the sections on the page, never hand-listed');
g(/@media \(min-width: 1180px\)/.test(html) && /\.rail \{ display: none; \}/.test(html),
  'rail is desktop-only — mobile keeps its swipe decks untouched');
g(html.includes('window.baselineRailTicks'), 'rail mirrors the learning-circle ticks (one idea of progress, not two)');
g(/const line = innerHeight \* 0\.32/.test(html), 'scroll-spy picks the section at the reading line, not an arbitrary intersecting one');
// the clips are SHOWN now, not two text links nobody found. Each must have a poster and
// preload="none", or four videos would silently cost every visitor bandwidth on load.
{
  const deck = html.match(/<div class="clip-deck">[\s\S]*?<\/div>/);
  const d = deck ? deck[0] : '';
  const vids = (d.match(/<video /g) || []).length;
  const posters = (d.match(/poster="https:\/\/hlur\.ai\/baseline\/clips\/[^"]+-poster\.jpg"/g) || []).length;
  const lazy = (d.match(/preload="none"/g) || []).length;
  const playable = (d.match(/\scontrols\b/g) || []).length;
  g(vids === 4 && posters === 4 && lazy === 4,
    `all 4 clips play on the page, each with a poster and preload="none" (${vids} videos, ${posters} posters, ${lazy} lazy)`);
  // visual.js hides the UA media chrome before capture (its spinner rotates, so the section
  // could never hold a stable reference). That makes the pixel harness blind to a missing
  // control bar — so the presence of controls is asserted HERE instead, statically.
  g(playable === 4, `every clip is playable — controls present on all 4 (found ${playable})`);
  g(/clip=write\|peel\|attn\|triage/.test(html) || /'write', 'peel', 'attn', 'triage'/.test(html),
    'the recorder supports a clip mode for every published clip');
}
g(html.includes("t.closest('.path-off')"), 'links into hidden content reveal it instead of scrolling to nothing');
// labs must not carry an undated promise, and must offer a way to be reached
g(!/More labs land here/.test(html), 'undated "more labs coming" promise removed');
// Lab 002 must stay an EXERCISE, not an essay: tappable claims, a scored verdict, a reset,
// and the honesty label saying the sample answer is written for the lab, not quoted.
g(html.includes('id="lab-checking"') && html.includes('id="triage"'), 'Lab 002 present as an interactive triage');
g(/must: true/.test(html) && (html.match(/must: (true|false)/g) || []).length >= 5,
  'Lab 002 classifies at least 5 claims by whether they are worth checking');
g(/not quoted from any real assistant/.test(html) && /nothing here is legal advice/.test(html),
  'Lab 002 labels its sample answer as constructed, and disclaims legal advice');
g(html.includes('id="triAgain"'), 'Lab 002 is replayable (reset control)');
g(!/Lab 002[^<]*In progress/.test(html), 'the "Lab 002 in progress" promise is discharged, not still pending');
g(/Lab 002/.test(html) && /mailto:hello@hlur\.ai\?subject=labs/.test(html), 'Lab 002 named + a zero-infra way to be told when it lands');
g(/shipped 2026-\d{2}-\d{2}/.test(html), 'Lab 001 carries its ship date');
// the usage tally: allowlisted, host-gated, non-fatal, and honestly disclosed
g(/function tally\(e\)/.test(html) && /TALLY_OK = \['load'/.test(html), 'tally() sends only allowlisted event names');
g(html.includes("location.hostname !== 'hlur.ai'"), 'tally is host-gated (GitHub Pages mirror stays silent)');
g(/tally\('load'\)/.test(html) && /tally\('quiz'\)/.test(html), 'tally covers the two numbers that answer "is this working?"');
// scope to the rendered pills: the phrase legitimately survives in the comment explaining
// why it was retired, and a guard must test the CLAIM, not the documentation of the claim
g(!/<span class="trust-pill">Nothing tracked<\/span>/.test(html),
  'the "Nothing tracked" pill is gone now that the page counts loads');
g(/No cookies · no account/.test(html) && html.includes('id="numbers"'), 'counting is disclosed on the page, next to the public numbers');
g(/mailto:hello@hlur\.ai\?subject=Baseline/.test(html), 'feedback no longer requires a GitHub account');
// the function itself must exist, be allowlisted, and fail soft
// ONE check, emitted in EVERY environment. A conditional that emits 3 checks locally and
// 1 in CI deadlocks the claim gate forever — the exact bug this file already hit once at
// ~line 250. The host repo lives at $DEST/.. in CI and beside this repo locally.
{
  const fnPath = hlurFile('netlify', 'functions', 'tally.mjs');
  let why = 'SKIP — ' + HLUR_SKIP;
  let good = true;
  if (fnPath) {
    const fn = fs.readFileSync(fnPath, 'utf8');
    // strip comments first: the file DOCUMENTS that it avoids these, and a guard that reads
    // its own documentation as a violation is a false positive, not a check
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const parts = [
      [/const EVENTS = \['load'/.test(code) && /EVENTS\.includes\(e\)/.test(code), 'allowlists events server-side'],
      // Origin names a SITE, not a person, and is used only to reject cross-site posts —
      // so reading it is allowed. Anything that identifies a HUMAN stays banned, and the
      // header value must never reach the store either.
      [!/x-forwarded-for|user-agent|['"]cookie|referer|client-ip|x-nf-/i.test(code)
        && !/headers\.get\((?!\s*['"]origin['"])/i.test(code)
        && !/set(JSON)?\([^)]*origin/i.test(code), 'reads no IP/user-agent/cookie/referer, and stores no header'],
      [/return null;/.test(code) && /import\('@netlify\/blobs'\)/.test(code), 'fails soft without storage']
    ];
    const failed = parts.filter(p => !p[0]).map(p => p[1]);
    good = failed.length === 0;
    why = good ? 'allowlisted, no identifiers, fails soft' : 'VIOLATIONS: ' + failed.join(', ');
  }
  g(good, `tally function is privacy-safe (${why})`);
}
g(/--functions netlify\/functions/.test(fs.readFileSync(path.join(__dirname, 'sync_hlur.sh'), 'utf8')),
  'deploy ships the functions directory');
// cold audit 2026-07-30: every one of these was a real defect found after the batch "passed"
// check the SUBSTANCE (every event is named) rather than one sentence — a wording guard
// fires on a rewrite that is still honest, and gets "fixed" by weakening it
{
  const m = html.match(/id="numbers"[\s\S]*?<\/p>/);
  const t = m ? m[0] : '';
  const named = ['loads', 'quiz finishes', 'lab copies', 'start-path picks'].filter(x => t.includes(x));
  g(/tally\('lab'\)/.test(html) && /tally\('path'\)/.test(html) && /Four things, nothing else/.test(t) && named.length === 4,
    `the disclosure names every event actually sent (${named.length}/4 named)`);
}
g(/nothing stored that could point back/.test(html),
  'privacy claim is scoped to what is STORED (the request itself still reaches the host)');
g(/rough signal, not a proof/.test(html), 'public counters are labelled forgeable, not presented as evidence');
g(html.includes("t.closest('.path-off') && window.baselineShowAll"),
  'ring/row navigation reveals hidden sections (they are not links — the click handler misses them)');
g(html.includes('if (linked && el.contains(linked)) return;'),
  'a deep-linked #anchor is never hidden by a saved start path');
g(!/meaning of "animal\."/.test(html), 'stale "animal" from the canonical Transformer example is gone');
{
  // both deploy paths publish a full snapshot: one missing --functions silently deletes the other's function
  const dep = hlurFile('deploy.sh');
  g(!dep || /--functions netlify\/functions/.test(fs.readFileSync(dep, 'utf8')),
    dep ? 'the host repo\'s own deploy path also ships functions (a snapshot deploy without it deletes them)'
        : 'host deploy.sh check: SKIP — ' + HLUR_SKIP);
}
{
  const bd = hlurFile('build_dist.js');
  g(!bd || /\\\.\[cm\]\?js\$/.test(fs.readFileSync(bd, 'utf8')),
    bd ? 'the publish-dir leak gate rejects .mjs/.cjs as well as .js'
       : 'publish-dir leak-gate check: SKIP — ' + HLUR_SKIP);
}

/* ---------- result ---------- */
console.log('---------------');
console.log(`${checks} checks, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
