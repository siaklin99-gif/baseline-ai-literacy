#!/usr/bin/env node
/* ============================================================
   Baseline — LAYOUT harness.  Run:  node layout.js  [--update]

   WHY THIS EXISTS
   crosscheck.js already renders the page and checks overflow, tap targets and
   source⇄DOM parity. It measures the CONTAINER's width — and passed 52/52 while
   the footer note rendered its text in a 560px column inside a 1200px shell,
   using under half the width the page already had. A container can be the right
   width while everything inside it is starved.

   So this file measures the TEXT, the ALIGNMENT and the STRUCTURE:

     1. ONE COLUMN        every content container shares one left edge and one
                          width per viewport (the footer was 130px out)
     2. TEXT FILL         no long paragraph renders far narrower than the box it
                          sits in — the "capped max-width wastes width" bug
     3. MOBILE FILL       on a phone every text block uses the full column
     4. NO OVERFLOW       nothing forces sideways scrolling of the page
     5. STRUCTURE LOCK    container widths and grid column counts are compared to
                          a COMMITTED baseline, so any future edit that changes
                          the desktop-vs-mobile structure fails loudly instead of
                          silently. `--update` rewrites the baseline on purpose,
                          which shows up as a reviewable diff.

   Checks 1-4 are absolute rules. Check 5 is the regression lock: it is what makes
   "I didn't break the layout" a fact you can re-run rather than a claim you have
   to take on trust.
   ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9371;
const PAGE_URL = 'file://' + path.join(__dirname, 'index.html');
const BASELINE = path.join(__dirname, 'layout_baseline.json');
const UPDATE = process.argv.includes('--update');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

const VIEWPORTS = [
  { name: 'desktop-1440', w: 1440, h: 900, mobile: false },
  { name: 'desktop-1280', w: 1280, h: 900, mobile: false },
  { name: 'tablet-768',   w: 768,  h: 1024, mobile: true },
  { name: 'mobile-390',   w: 390,  h: 844, mobile: true },
];

// Grids whose column count IS the mobile-vs-desktop structure. If one of these
// silently goes from 3-up to 1-up (or back), the page's shape changed.
const GRIDS = ['#cards .tg-deck', '.foot-cols', '.path-pick', '.trust'];

// Containers that are DELIBERATELY narrower than the main content column, with the
// reason. Anything narrow that isn't declared here is a bug; adding to this list is
// a visible, reviewable decision rather than a silent exception.
const NARROW_BY_DESIGN = {
  layers: 'the 10-layer peel is a sequential reading flow — a deliberate calm focal module (index.html: "#layers .wrap")'
};

/* ---- the in-page measurement (runs in real Chromium) ---- */
const PROBE = `(function(){
  document.querySelectorAll('details.card').forEach(d => d.open = true);
  void document.body.offsetHeight;
  const round = n => Math.round(n);

  // 1. every content container: same left edge, same width
  const wraps = [...document.querySelectorAll('section > .wrap')].map(el => ({
    id: (el.closest('section') || {}).id || '?',
    x: round(el.getBoundingClientRect().x),
    w: round(el.getBoundingClientRect().width)
  }));
  const footNote = document.querySelector('.foot-note');
  if (footNote) wraps.push({ id: 'foot-note', x: round(footNote.getBoundingClientRect().x), w: round(footNote.getBoundingClientRect().width) });

  // 2/3. text fill: every block of real prose vs the box it sits in
  const TEXTY = 'p, li, .ssub, .hero-sub, .lead, .fineprint, .mg-sub, .path-status';
  const starved = [];
  const fills = [];
  [...document.querySelectorAll(TEXTY)].forEach(el => {
    const txt = (el.innerText || '').trim();
    if (txt.length < 90) return;                       // short labels may be centred/narrow
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;                 // hidden
    if (el.closest('.path-off, [hidden]')) return;
    // the box it should be filling: nearest ancestor that is wider than it
    let p = el.parentElement, pw = 0;
    while (p && p !== document.body) {
      const w = p.getBoundingClientRect().width;
      if (w > 0) { pw = w; break; }
      p = p.parentElement;
    }
    if (!pw) return;
    // A cell in a multi-column grid/flex SHOULD be a fraction of its container — measure
    // it against its own column, not the whole row, or every deliberate multi-up layout
    // reads as "starved". (This was the harness's own first false positive.)
    let cols = 1;
    if (p) {
      const pd = getComputedStyle(p).display;
      if (pd === 'grid' || pd === 'flex' || pd === 'inline-grid' || pd === 'inline-flex') {
        const sibs = [...p.children].filter(c => c.getBoundingClientRect().width > 0);
        cols = Math.max(1, new Set(sibs.map(c => Math.round(c.getBoundingClientRect().x))).size);
      }
    }
    const cell = pw / cols;
    const ratio = r.width / cell;
    fills.push(ratio);
    if (ratio < 0.55) starved.push({
      cols,
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 28),
      w: round(r.width), parent: round(pw), pct: Math.round(ratio * 100),
      txt: txt.slice(0, 40)
    });
  });

  // 4. page-level overflow
  const cs = document.scrollingElement;

  // 5. structural fingerprint: grid column counts (distinct child left-edges)
  const grids = {};
  ${JSON.stringify(GRIDS)}.forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) { grids[sel] = null; return; }
    const kids = [...el.children].filter(c => c.getBoundingClientRect().width > 0);
    grids[sel] = kids.length ? new Set(kids.map(c => Math.round(c.getBoundingClientRect().x))).size : 0;
  });

  return {
    viewport: window.innerWidth,
    wraps, starved, grids,
    minFillPct: fills.length ? Math.round(Math.min(...fills) * 100) : 100,
    overflow: cs.scrollWidth - cs.clientWidth
  };
})()`;

/* ---- minimal CDP ---- */
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

async function main() {
  console.log('\nBaseline layout harness\n-----------------------');
  const prev = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  if (!prev && !UPDATE) bad('no layout_baseline.json — run `node layout.js --update` once to record it');
  const fresh = {};
  const narrowedSomewhere = new Set();

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--user-data-dir=/tmp/baseline-layout-' + PORT], { stdio: 'ignore' });
  let ws;
  try {
    let ver, tries = 0;
    while (tries++ < 50) { try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
    if (!ver) throw new Error('Chrome DevTools endpoint never became ready');
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params, sid) => new Promise((res, rej) => {
      const i = ++id; pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, sessionId: sid }));
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout: ' + method)); } }, 20000);
    });
    const { result: tr } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: ar } = await send('Target.attachToTarget', { targetId: tr.targetId, flatten: true });
    const sid = ar.sessionId;
    await send('Page.enable', {}, sid);
    await send('Runtime.enable', {}, sid);

    for (const v of VIEWPORTS) {
      await send('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile }, sid);
      await send('Page.navigate', { url: PAGE_URL }, sid);
      await sleep(1500);
      const { result } = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sid);
      if (result.exceptionDetails) throw new Error('probe threw: ' + (result.exceptionDetails.exception || {}).description);
      const r = result.result.value;
      const tag = `[${v.name}]`;

      // 1. one content column, except where a narrower one is declared on purpose
      const declared = r.wraps.filter(w => NARROW_BY_DESIGN[w.id]);
      const main = r.wraps.filter(w => !NARROW_BY_DESIGN[w.id]);
      const xs = [...new Set(main.map(w => w.x))];
      const ws_ = [...new Set(main.map(w => w.w))];
      (xs.length === 1 && ws_.length === 1)
        ? ok(`${tag} all ${main.length} content containers share one column (x=${xs[0]}, w=${ws_[0]})` +
             (declared.length ? ` · ${declared.length} narrower by design: ${declared.map(d => d.id).join(', ')}` : ''))
        : bad(`${tag} containers disagree — x: ${xs.join('/')} w: ${ws_.join('/')} · ` +
              main.filter(w => w.x !== xs[0] || w.w !== ws_[0]).map(w => `${w.id}@${w.x}/${w.w}`).join(', ') +
              ' — if intended, declare it in NARROW_BY_DESIGN with the reason');
      // staleness is a cross-viewport question: a 720px cap cannot narrow anything on a
      // 390px phone, so "not narrower here" proves nothing. Tallied and judged after the loop.
      declared.forEach(d => { if (d.w < (ws_[0] || 0)) narrowedSomewhere.add(d.id); });

      // 2/3. text fill
      r.starved.length === 0
        ? ok(`${tag} no starved text block (narrowest prose fills ${r.minFillPct}% of its box)`)
        : bad(`${tag} ${r.starved.length} text block(s) waste their box: ` +
              r.starved.slice(0, 3).map(s => `<${s.tag}${s.cls ? '.' + s.cls.split(' ')[0] : ''}> ${s.w}px in ${s.parent}px (${s.pct}%) "${s.txt}…"`).join(' | '));

      // 4. overflow
      r.overflow <= 0 ? ok(`${tag} no horizontal overflow`) : bad(`${tag} horizontal overflow: ${r.overflow}px`);

      // 5. structure lock
      fresh[v.name] = { wrapX: xs[0], wrapW: ws_[0], grids: r.grids };
      if (prev && prev[v.name] && !UPDATE) {
        const b = prev[v.name];
        const drift = [];
        if (Math.abs(b.wrapW - ws_[0]) > 2) drift.push(`content width ${b.wrapW} → ${ws_[0]}`);
        for (const g of Object.keys(b.grids || {})) {
          if (b.grids[g] !== r.grids[g]) drift.push(`${g} columns ${b.grids[g]} → ${r.grids[g]}`);
        }
        drift.length === 0
          ? ok(`${tag} structure matches the committed baseline`)
          : bad(`${tag} STRUCTURE CHANGED: ${drift.join('; ')} — intended? re-run with --update to accept`);
      } else if (UPDATE) {
        ok(`${tag} baseline recorded (w=${ws_[0]}, grids ${JSON.stringify(r.grids)})`);
      }
    }
  } catch (e) {
    bad('harness error (failing closed): ' + e.message);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
  }

  // every declared exemption must actually be narrower at SOME viewport, or the list is stale
  for (const id of Object.keys(NARROW_BY_DESIGN)) {
    narrowedSomewhere.has(id)
      ? ok(`NARROW_BY_DESIGN "${id}" is real and justified — ${NARROW_BY_DESIGN[id]}`)
      : bad(`NARROW_BY_DESIGN "${id}" is never narrower at any viewport — stale exemption, remove it`);
  }

  if (UPDATE && !fails) {
    fs.writeFileSync(BASELINE, JSON.stringify(fresh, null, 2) + '\n');
    console.log(`\n  wrote ${path.basename(BASELINE)} — commit it; future runs fail if the structure drifts`);
  }
  console.log('-----------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}
main();
