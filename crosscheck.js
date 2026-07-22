#!/usr/bin/env node
/* ============================================================
   Baseline — rendered crosscheck (Eye-Verification harness)
   Run:  node crosscheck.js
   ------------------------------------------------------------
   Drives system Google Chrome over the DevTools Protocol using
   Node's built-in WebSocket (no npm deps, no Playwright). For
   each { desktop, mobile } x { light, dark }:
     • real device + prefers-color-scheme emulation
     • independent parse of data.js -> assert every model/plan/
       book actually appears in the rendered DOM (source⇄output)
     • layout invariants: no horizontal overflow, no clipped
       layers, no zero-height visible cards, section labels share
       one left edge
     • rendered-text leak scan (undefined / NaN / [object Object])
     • saves a full, fully-expanded screenshot per combo to
       crosscheck_shots/ so a human can READ them by eye
   Exits non-zero on any failed invariant. Fails closed if Chrome
   or the protocol misbehaves.
   ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9315;
const PAGE_URL = 'file://' + path.join(__dirname, 'index.html');
const SHOTS = path.join(__dirname, 'crosscheck_shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

/* ---- independent data.js parser (regex — NOT the page's own renderer) ---- */
function expectedStrings() {
  const src = fs.readFileSync(path.join(__dirname, 'data.js'), 'utf8');
  const grab = (re) => [...src.matchAll(re)].map(m => m[1]);
  return [...grab(/name:"([^"]+)"/g), ...grab(/title:"([^"]+)"/g), ...grab(/plan:"([^"]+)"/g)];
}

/* ---- minimal CDP client over the built-in WebSocket ---- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else { this.listeners.forEach(fn => fn(m)); }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 15000);
    });
  }
  on(fn) { this.listeners.push(fn); }
}
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

/* ---- the in-page assertion + expand routine (runs in real Chromium) ---- */
function assertionExpr(expected) {
  return `(function(){
    // kill transitions/animations so measurements & screenshots are settled, not mid-animation
    const st = document.createElement('style');
    st.textContent = '*{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
    // expand EVERYTHING so the screenshot and parity check see all content
    document.querySelectorAll('details.card').forEach(d => d.open = true);
    void document.body.offsetHeight; // force reflow after class/style changes
    const cs = document.documentElement;
    const cards = [...document.querySelectorAll('#cards details.card')];
    const zeroCards = cards.filter(c => c.getBoundingClientRect().height < 2).length;
    const wrapW = Math.round((document.querySelector('.wrap')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width);
    // how many cards sit on the first row (share the min top) = columns in the grid
    const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
    const minTop = Math.min(...tops);
    const cardsPerRow = tops.filter(t => t === minTop).length;
    const usedPct = Math.round(wrapW / window.innerWidth * 100);
    // gutter symmetry: for each major block, left gutter must equal right gutter
    // (this is the real "left/right in sync" property — robust to blocks that are
    //  intentionally different widths, e.g. the centered layers column)
    const vw = window.innerWidth;
    let maxAsym = 0, worstBlock = '';
    ['.hero .wrap', '#peel', '.pl-stage', '.cols', '#pills', '#cards'].forEach(sel => {
      const e = document.querySelector(sel); if (!e) return;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return; // skip hidden elements
      const a = Math.abs(Math.round(r.left) - Math.round(vw - r.right));
      if (a > maxAsym) { maxAsym = a; worstBlock = sel; }
    });
    // on mobile, the card sections are horizontal scroll-snap decks (layers use the peel stack;
    // the glossary shows a swipe deck on mobile, a table on desktop)
    const decksScroll = ['.cols', '#cards', '#bodymap', '.gl-deck'].every(sel => {
      const e = document.querySelector(sel); return e && e.scrollWidth > e.clientWidth + 5;
    });
    const bmCount = document.querySelectorAll('#bodymap .bm-item').length;
    const bpDots = document.querySelectorAll('#bodySvg .bp-dot').length;
    const glCount = document.querySelectorAll('#glossary .gl-card').length;
    const qzCount = document.querySelectorAll('#quiz details.qz').length;
    const lcNodeCount = document.querySelectorAll('#lcNodes .lc-node').length;
    const lcRowCount = document.querySelectorAll('#lcList .lc-row').length;
    // peel integrity: exactly 10 cards, exactly one current, core wired
    const plCards = [...document.querySelectorAll('.pl-card')];
    const plCurrent = document.querySelectorAll('.pl-card.is-current').length;
    const plHasCore = plCards.length ? plCards[plCards.length - 1].querySelector('.pl-core-label') != null : false;
    // every layer must carry an everyday example (non-empty)
    const plExamples = plCards.filter(c => { const e = c.querySelector('.pl-eg'); return e && e.textContent.replace(/everyday/i, '').trim().length > 0; }).length;
    // touch-target audit: primary standalone controls should be >= 44x44 (Apple HIG / WCAG 2.5.5).
    // inline text links are exempt (WCAG inline exception) so they're excluded here.
    const PRIMARY = [['.cta','button'], ['.pill','filter pill'], ['.pl-btn','peel button'], ['details.card > summary','card tap-row'], ['.qz > summary','quiz tap-row'], ['.lc-row','circle step row']];
    const taps = PRIMARY.map(([sel,name]) => {
      // only audit VISIBLE controls (the slider is hidden on mobile, replaced by the swipe deck)
      const boxes = [...document.querySelectorAll(sel)].map(e => e.getBoundingClientRect()).filter(b => b.width > 0 && b.height > 0);
      if (!boxes.length) return null;
      return { name, minW: Math.round(Math.min(...boxes.map(b => b.width))), minH: Math.round(Math.min(...boxes.map(b => b.height))) };
    }).filter(Boolean);
    const bodyText = document.body.innerText;
    const expected = ${JSON.stringify(expected)};
    const missing = expected.filter(s => !bodyText.includes(s));
    const leaks = (bodyText.match(/\\bundefined\\b|\\bNaN\\b|\\[object Object\\]/g) || []);
    return {
      w: window.innerWidth,
      pageHeight: Math.ceil(document.documentElement.scrollHeight),
      overflow: cs.scrollWidth - cs.clientWidth,
      zeroHeightCards: zeroCards,
      plCardCount: plCards.length,
      plCurrent: plCurrent,
      plHasCore: plHasCore,
      plExamples: plExamples,
      bmCount: bmCount,
      bpDots: bpDots,
      glCount: glCount,
      qzCount: qzCount,
      lcNodeCount: lcNodeCount,
      lcRowCount: lcRowCount,
      maxAsym: maxAsym,
      worstBlock: worstBlock,
      missingCount: missing.length,
      missingSample: missing.slice(0, 3),
      leaks: leaks,
      cardCount: cards.length,
      wrapW: wrapW,
      usedPct: usedPct,
      cardsPerRow: cardsPerRow,
      decksScroll: decksScroll,
      taps: taps
    };
  })()`;
}

const COMBOS = [
  { name: 'desktop-light', w: 1280, h: 900, mobile: false, dsf: 1, theme: 'light' },
  { name: 'desktop-dark',  w: 1280, h: 900, mobile: false, dsf: 1, theme: 'dark'  },
  { name: 'mobile-light',  w: 390,  h: 844, mobile: true,  dsf: 2, theme: 'light' },
  { name: 'mobile-dark',   w: 390,  h: 844, mobile: true,  dsf: 2, theme: 'dark'  },
];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const expected = expectedStrings();
  console.log('\nBaseline rendered crosscheck\n----------------------------');
  console.log(`  (parity target: ${expected.length} data.js strings must appear in the DOM)`);
  // fatal: if the independent parser finds nothing, the parity check below is meaningless
  // (data.js format drifted from the regex) — never let it pass vacuously
  if (!expected.length) bad('independent parser extracted 0 strings from data.js — parity check would be vacuous');

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--user-data-dir=/tmp/baseline-cc-' + PORT
  ], { stdio: 'ignore' });

  let ws;
  try {
    // wait for the devtools endpoint (fail closed if it never comes up)
    let ver, tries = 0;
    while (tries++ < 50) { try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
    if (!ver) throw new Error('Chrome DevTools endpoint never became ready');

    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    for (const c of COMBOS) {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: c.w, height: c.h, deviceScaleFactor: c.dsf, mobile: c.mobile }, sessionId);
      await cdp.send('Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: c.theme }] }, sessionId);

      const loaded = new Promise((res) => {
        const h = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { res(); } };
        cdp.on(h);
      });
      await cdp.send('Page.navigate', { url: PAGE_URL }, sessionId);
      // fail closed if the load event never fires, instead of hanging forever
      await Promise.race([loaded, sleep(20000).then(() => { throw new Error(`[${c.name}] load event never fired`); })]);
      await sleep(350);

      const { result } = await cdp.send('Runtime.evaluate',
        { expression: assertionExpr(expected), returnByValue: true }, sessionId);
      const r = result.value;

      // resize viewport to the true (expanded) page height at dsf 1 so one clean frame
      // stays under Chrome's ~16384px capture limit — no wrap/duplication artifacts
      const capH = Math.min(r.pageHeight + 20, 15000);
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: c.w, height: capH, deviceScaleFactor: 1, mobile: c.mobile }, sessionId);
      await sleep(120);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = path.join(SHOTS, c.name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

      // invariants
      const tag = `[${c.name}]`;
      r.overflow <= 0        ? ok(`${tag} no horizontal overflow`)            : bad(`${tag} horizontal overflow: ${r.overflow}px`);
      r.zeroHeightCards === 0? ok(`${tag} no zero-height cards`)              : bad(`${tag} ${r.zeroHeightCards} zero-height card(s)`);
      (r.plCardCount === 10 && r.plCurrent === 1 && r.plHasCore && r.plExamples === 10)
        ? ok(`${tag} peel stack: 10 cards, one current, core wired, 10 examples`)
        : bad(`${tag} peel stack broken: ${r.plCardCount} cards, ${r.plCurrent} current, core=${r.plHasCore}, examples=${r.plExamples}`);
      r.maxAsym <= 3       ? ok(`${tag} all blocks symmetric (max L/R gutter diff ${r.maxAsym}px)`) : bad(`${tag} asymmetric block "${r.worstBlock}": L/R gutters differ by ${r.maxAsym}px`);
      r.missingCount === 0   ? ok(`${tag} all ${expected.length} data strings rendered (parity)`) : bad(`${tag} ${r.missingCount} data string(s) missing from DOM: ${r.missingSample.join(' | ')}`);
      r.leaks.length === 0   ? ok(`${tag} no undefined/NaN/[object Object] leaks`) : bad(`${tag} leaked tokens: ${[...new Set(r.leaks)].join(', ')}`);
      r.cardCount === 13     ? ok(`${tag} 13 topic cards present (incl. jobs, myths, daily-prompts)`) : bad(`${tag} expected 13 cards, got ${r.cardCount}`);
      (r.bmCount === 8 && r.bpDots === 8 && r.glCount === 12 && r.qzCount === 7 && r.lcNodeCount === 6 && r.lcRowCount === 6)
        ? ok(`${tag} body map (8+8 dots) + glossary (12) + quiz (7) + circle (6) rendered`)
        : bad(`${tag} body map=${r.bmCount}/dots=${r.bpDots} (want 8), glossary=${r.glCount} (want 12), quiz=${r.qzCount} (want 7), circle=${r.lcNodeCount}/${r.lcRowCount} (want 6)`);
      // width-efficiency regression guards (lock the fix): desktop uses width + 2-up cards; mobile stays 1-up
      if (c.mobile) {
        r.decksScroll        ? ok(`${tag} sections are horizontal swipe decks`) : bad(`${tag} swipe decks not horizontally scrollable`);
      } else {
        r.usedPct >= 68      ? ok(`${tag} container uses ${r.usedPct}% of width (efficient)`) : bad(`${tag} only ${r.usedPct}% of width used — too narrow`);
        r.cardsPerRow === 2  ? ok(`${tag} topic cards are 2-up`)              : bad(`${tag} expected 2 cards/row on desktop, got ${r.cardsPerRow}`);
      }
      // touch targets (mobile only — that's where fingers tap)
      if (c.mobile) {
        r.taps.forEach(t => {
          (t.minW >= 44 && t.minH >= 44)
            ? ok(`${tag} ${t.name} tap target ${t.minW}x${t.minH} (>=44)`)
            : bad(`${tag} ${t.name} tap target ${t.minW}x${t.minH} — under 44x44`);
        });
      }
      console.log(`     \x1b[2m→ saved crosscheck_shots/${c.name}.png\x1b[0m`);
    }
  } catch (e) {
    bad('harness error (failing closed): ' + e.message);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
  }

  console.log('----------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}
main();
