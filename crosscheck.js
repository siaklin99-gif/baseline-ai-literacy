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
    document.querySelectorAll('.layer').forEach(l => l.classList.add('on'));
    document.querySelectorAll('details.card').forEach(d => d.open = true);
    void document.body.offsetHeight; // force reflow after class/style changes
    const cs = document.documentElement;
    const layers = [...document.querySelectorAll('.layer.on')];
    // true clip test: content taller than the layer's rendered box (transitions now off)
    const clipped = layers.filter(el => el.scrollHeight > el.clientHeight + 1).length;
    const cards = [...document.querySelectorAll('#cards details.card')];
    const zeroCards = cards.filter(c => c.getBoundingClientRect().height < 2).length;
    const wrapW = Math.round((document.querySelector('.wrap')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width);
    // how many cards sit on the first row (share the min top) = columns in the grid
    const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
    const minTop = Math.min(...tops);
    const cardsPerRow = tops.filter(t => t === minTop).length;
    const usedPct = Math.round(wrapW / window.innerWidth * 100);
    const lefts = [...new Set([...document.querySelectorAll('.slabel')].map(e => Math.round(e.getBoundingClientRect().left)))];
    const bodyText = document.body.innerText;
    const expected = ${JSON.stringify(expected)};
    const missing = expected.filter(s => !bodyText.includes(s));
    const leaks = (bodyText.match(/\\bundefined\\b|\\bNaN\\b|\\[object Object\\]/g) || []);
    return {
      w: window.innerWidth,
      pageHeight: Math.ceil(document.documentElement.scrollHeight),
      overflow: cs.scrollWidth - cs.clientWidth,
      clippedLayers: clipped,
      zeroHeightCards: zeroCards,
      labelLefts: lefts,
      missingCount: missing.length,
      missingSample: missing.slice(0, 3),
      leaks: leaks,
      cardCount: cards.length,
      wrapW: wrapW,
      usedPct: usedPct,
      cardsPerRow: cardsPerRow
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
      r.clippedLayers === 0  ? ok(`${tag} no clipped layers`)                 : bad(`${tag} ${r.clippedLayers} layer(s) clipped by max-height`);
      r.zeroHeightCards === 0? ok(`${tag} no zero-height cards`)              : bad(`${tag} ${r.zeroHeightCards} zero-height card(s)`);
      r.labelLefts.length===1? ok(`${tag} section labels share one left edge (${r.labelLefts[0]}px)`) : bad(`${tag} section labels misaligned: ${r.labelLefts.join(',')}`);
      r.missingCount === 0   ? ok(`${tag} all ${expected.length} data strings rendered (parity)`) : bad(`${tag} ${r.missingCount} data string(s) missing from DOM: ${r.missingSample.join(' | ')}`);
      r.leaks.length === 0   ? ok(`${tag} no undefined/NaN/[object Object] leaks`) : bad(`${tag} leaked tokens: ${[...new Set(r.leaks)].join(', ')}`);
      r.cardCount === 8      ? ok(`${tag} 8 topic cards present`)             : bad(`${tag} expected 8 cards, got ${r.cardCount}`);
      // width-efficiency regression guards (lock the fix): desktop uses width + 2-up cards; mobile stays 1-up
      if (c.mobile) {
        r.cardsPerRow === 1  ? ok(`${tag} cards single-column (mobile)`)      : bad(`${tag} expected 1 card/row on mobile, got ${r.cardsPerRow}`);
      } else {
        r.usedPct >= 68      ? ok(`${tag} container uses ${r.usedPct}% of width (efficient)`) : bad(`${tag} only ${r.usedPct}% of width used — too narrow`);
        r.cardsPerRow === 2  ? ok(`${tag} topic cards are 2-up`)              : bad(`${tag} expected 2 cards/row on desktop, got ${r.cardsPerRow}`);
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
