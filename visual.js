#!/usr/bin/env node
/* ============================================================
   Baseline — VISUAL harness.  Run:  node visual.js  [--update]

   WHY THIS EXISTS
   layout.js measures geometry and crosscheck.js measures the DOM. Neither can see
   that something LOOKS wrong: text the same colour as its background, a button
   overlapping another, a card rendering blank, or a change nobody intended. Until
   now the answer to "does it still look right?" was "a human opens the PNGs".

   This makes the visual pass automatic and reproducible in two layers:

     A. DEFECT SCANS — no reference needed, so they catch badness on the very first
        run: invisible/low-contrast text, clipped text, overlapping tap targets,
        and visibly blank sections.
     B. PIXEL DIFF — every section is compared to a committed reference image. Any
        unintended visual change fails the run and writes a side-by-side crop to
        visual_diff/ so it can be looked at. `--update` accepts new references on
        purpose, which shows up as a reviewable diff.

   DETERMINISM
   The page renders dates ("9d old"), a visit counter, and SHUFFLED quiz answers.
   Left alone those differ every run and the diff is worthless, so before the page
   loads we pin Date and Math.random. That is done with addScriptToEvaluateOnNewDocument
   so it is in place before any page script runs.

   HONEST LIMIT: a pixel diff catches CHANGE, not ugliness. It cannot tell you the
   design is good — only that it is what you last approved. The defect scans in (A)
   are the part that can fail on a first run.
   ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9375;
const PAGE_URL = 'file://' + path.join(__dirname, 'index.html');
const REF_DIR = path.join(__dirname, 'visual_ref');
const OUT_DIR = path.join(__dirname, 'visual_diff');
const UPDATE = process.argv.includes('--update');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

// Dark mode used to be rendered but never COMPARED — crosscheck.js screenshots it and
// nothing checked those pixels, so a dark-only regression (a colour that vanishes into the
// background, a chip that turns invisible) could ship unnoticed. Both themes now diff, and
// the contrast scan runs against dark surfaces too.
const VIEWS = [
  { name: 'desktop',      w: 1280, h: 900, mobile: false, theme: 'light' },
  { name: 'mobile',       w: 390,  h: 844, mobile: true,  theme: 'light' },
  { name: 'desktop-dark', w: 1280, h: 900, mobile: false, theme: 'dark'  },
  { name: 'mobile-dark',  w: 390,  h: 844, mobile: true,  theme: 'dark'  },
];
// Derived from the DOM, not hand-listed: the hand-list silently omitted #howllm — the
// largest deep-dive section on the page — while the green line "11 sections pixel-identical"
// read as full coverage. A list you maintain by hand is a list that forgets.
const EXTRA_SECTIONS = ['header', 'footer'];   // .share-strip is now section#share, derived
// layer-2 sections: hidden until opened, so the capture opens each one in turn
// An absolute pixel count, NOT a percentage. 0.12% of the 2.97M-pixel #topics reference
// was 3,569 pixels of licence — enough to recolour a whole badge and still pass. Changed
// pixels do not get cheaper because the section is tall.
const DIFF_PX_FAIL = 260;     // at SCALE 0.5 this is ~a word of text
const DIFF_PX_NOISE = 120;    // observed run-to-run render noise; reported, never silent
const SCALE = 0.5;            // halve it: smaller refs in git, and less antialias noise

/* Pinned before ANY page script runs, so dates and shuffles are identical every run. */
const DETERMINISM = `
  (function(){
    const FIXED = 1785000000000;                       // a fixed instant
    const _D = Date;
    function D(...a){ return a.length ? new _D(...a) : new _D(FIXED); }
    D.now = () => FIXED; D.parse = _D.parse; D.UTC = _D.UTC; D.prototype = _D.prototype;
    window.Date = D;
    let s = 42;                                        // deterministic PRNG
    Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  })();
`;

/* Defect scans + per-section capture geometry, measured in the page. */
const PROBE = `(function(){
  // Layer 2 is display:none until opened. Open all four in place (static, not fixed) so
  // they are measured and diffed exactly like the rest — otherwise the four deep-dives,
  // which hold most of the page's content, would never be visually checked at all.
  document.querySelectorAll('.deep').forEach(d => {
    d.classList.add('open'); d.style.position = 'static'; d.style.overflow = 'visible';
    d.style.padding = '0'; d.style.animation = 'none';
  });
  document.documentElement.removeAttribute('data-deep');
  document.querySelectorAll('details.card').forEach(d => d.open = true);
  const st = document.createElement('style');
  st.textContent = '*{transition:none!important;animation:none!important;caret-color:transparent!important}';
  document.head.appendChild(st);
  void document.body.offsetHeight;

  const vis = el => { const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.path-off,[hidden]'); };

  // Resolve ANY CSS colour through a canvas. Hand-parsing rgb() numbers is what broke the
  // first version of this check: the panels use color(srgb 0.96 0.96 1), whose components
  // are 0-1, so dividing by 255 read a near-white panel as black and produced 48 bogus
  // "low contrast" hits. The canvas normalises rgb/hsl/color()/oklch alike.
  const _c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // Sentinel test. The previous version set '#000' then compared fillStyle to '#000' —
  // Chrome serialises that as '#000000', so the comparison was ALWAYS false and any
  // unparseable colour was silently read as pure black, fabricating a pass or an alarm.
  const rgba = (c) => { try {
      _c.fillStyle = '#ff00ff';                 // magenta sentinel
      _c.fillStyle = c;                         // ignored by the canvas if c is invalid
      if (_c.fillStyle === '#ff00ff' && !/^#ff00ff$|magenta|fuchsia/i.test(String(c).trim())) return null;
      _c.clearRect(0,0,1,1); _c.fillRect(0,0,1,1);
      const d = _c.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3]/255];
    } catch (e) { return null; } };
  const lum = (px) => { if (!px) return null;
    const f = px.slice(0,3).map(x => { x = x/255; return x <= .03928 ? x/12.92 : Math.pow((x+.055)/1.055, 2.4); });
    return .2126*f[0] + .7152*f[1] + .0722*f[2]; };
  // Walk up collecting every background layer, then ACTUALLY composite them. The previous
  // version kept only the first translucent layer and threw it away on reaching an opaque
  // ancestor — #333 text inside rgba(20,20,20,.9) over a white card scored 12.63:1 when the
  // truth is 1.11:1, i.e. a false PASS on invisible text. Latent then (no translucent layer
  // carried text) but one chip away from real.
  // Bails out on a gradient: "contrast against a gradient" is not one number.
  const bgOf = el => {
    const stack = [];                       // nearest-first
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { gradient: true };
      const px = rgba(cs.backgroundColor);
      if (px && px[3] > 0) { stack.push(px); if (px[3] >= 0.99) break; }
    }
    const base = rgba(getComputedStyle(document.body).backgroundColor) || [255,255,255,1];
    if (!stack.length || stack[stack.length - 1][3] < 0.99) stack.push(base);
    // composite far -> near: result = a*over + (1-a)*under
    let out = stack[stack.length - 1].slice(0, 3);
    for (let i = stack.length - 2; i >= 0; i--) {
      const a = stack[i][3];
      out = [0, 1, 2].map(k => stack[i][k] * a + out[k] * (1 - a));
    }
    return { px: [out[0], out[1], out[2], 1] }; };

  // A1 invisible / low-contrast text
  const faint = [];
  document.querySelectorAll('p,li,span,b,em,a,button,div,h1,h2,h3,summary').forEach(el => {
    if (!vis(el)) return;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 3);
    if (!own) return;
    const cs = getComputedStyle(el);
    if (cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || cs.color === 'rgba(0, 0, 0, 0)') return;  // gradient text
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return;   // text on its own gradient (the CTA buttons)
    const bg = bgOf(el);
    if (bg.gradient) return;                                           // sits on a gradient — not one number
    const l1 = lum(rgba(cs.color)), l2 = lum(bg.px);
    if (l1 === null || l2 === null) return;
    const ratio = (Math.max(l1,l2) + .05) / (Math.min(l1,l2) + .05);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight,10) >= 700;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need) faint.push({ t: el.tagName.toLowerCase(), r: +ratio.toFixed(2), need,
      px: Math.round(size), txt: el.textContent.trim().slice(0,34) });
  });

  // A2 clipped text — scan the elements that ACTUALLY clip, both axes.
  // The old version listed p,li,h1..,button,summary,.qz-q — of which 0 of 347 had hidden
  // overflow, while 56 other elements on the page did. It printed green every run and
  // could not fail. It also only tested scrollWidth, so a fixed-height box hiding lines
  // of text was never checked at all.
  const clipped = [];
  document.querySelectorAll('*').forEach(el => {
    if (!vis(el)) return;
    const cs = getComputedStyle(el);
    const hx = cs.overflowX === 'hidden' || cs.overflow === 'hidden';
    const hy = cs.overflowY === 'hidden' || cs.overflow === 'hidden';
    if (!hx && !hy) return;
    const txt = (el.innerText || '').trim();
    if (txt.length < 8) return;                       // decorative boxes carry no words
    // Measure the TEXT, not the box. scrollWidth counts decorative children and ::before
    // glows, so the hero header read as "39px clipped" while every word was fully visible.
    // A Range over the element's own text nodes is what the reader actually sees.
    let tr = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {
        if (!r.width || !r.height) continue;
        tr = tr ? { l: Math.min(tr.l, r.left), r: Math.max(tr.r, r.right),
                    t: Math.min(tr.t, r.top), b: Math.max(tr.b, r.bottom) }
                : { l: r.left, r: r.right, t: r.top, b: r.bottom };
      }
    }
    if (!tr) return;                                  // no direct text of its own
    const box = el.getBoundingClientRect();
    const dx = hx ? Math.round(Math.max(0, tr.r - box.right, box.left - tr.l)) : 0;
    const dy = hy ? Math.round(Math.max(0, tr.b - box.bottom, box.top - tr.t)) : 0;
    if (dx > 2 || dy > 2) clipped.push({ t: el.tagName.toLowerCase(),
      cls: String(el.className || '').split(' ')[0], axis: dx > 2 ? 'x' : 'y',
      over: Math.max(dx, dy), txt: txt.slice(0, 34) });
  });

  // A3 overlapping tap targets (two controls sharing pixels = one is unclickable)
  // Per LINE BOX, not bounding box. An inline link that wraps has a bounding box spanning
  // both lines, which made two links on adjacent lines look like they collided — the first
  // version of this check reported exactly that false positive.
  const ctrls = [...document.querySelectorAll('button,a[href],summary,input')].filter(vis)
    .map(el => ({ el, rects: [...el.getClientRects()].filter(r => r.width > 8 && r.height > 8) }))
    .filter(o => o.rects.length);
  const overlaps = [];
  for (let i = 0; i < ctrls.length && overlaps.length < 4; i++)
    for (let j = i + 1; j < ctrls.length; j++) {
      if (ctrls[i].el.contains(ctrls[j].el) || ctrls[j].el.contains(ctrls[i].el)) continue;
      let hit = null;
      for (const a of ctrls[i].rects) for (const b of ctrls[j].rects) {
        const ox = Math.min(a.right,b.right) - Math.max(a.left,b.left);
        const oy = Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top);
        if (ox > 4 && oy > 4) { hit = { ox: Math.round(ox), oy: Math.round(oy) }; break; }
      }
      if (hit) { overlaps.push({ a: ctrls[i].el.textContent.trim().slice(0,20),
        b: ctrls[j].el.textContent.trim().slice(0,20), ox: hit.ox, oy: hit.oy }); break; }
    }

  // A4 visibly blank section (renders tall but holds almost no text)
  const blank = [];
  document.querySelectorAll('section').forEach(s => {
    if (!vis(s)) return;
    const r = s.getBoundingClientRect();
    if (r.height > 220 && (s.innerText || '').trim().length < 40) blank.push({ id: s.id, h: Math.round(r.height) });
  });

  // capture rects, in page coordinates. Selectors are DERIVED: every <section id> on the
  // page plus the fixed extras, so a new section is covered the day it ships and cannot be
  // forgotten out of a hand-list.
  const sels = [...${JSON.stringify(EXTRA_SECTIONS)}];
  document.querySelectorAll('section[id]').forEach(s => sels.push('#' + s.id));
  const rects = {};
  sels.forEach(sel => {
    const el = document.querySelector(sel);
    if (!el || !vis(el)) { rects[sel] = null; return; }
    const r = el.getBoundingClientRect();
    rects[sel] = { x: Math.max(0, Math.round(r.x + scrollX)), y: Math.max(0, Math.round(r.y + scrollY)),
                   // 4000 silently truncated #topics (6013px on mobile): a THIRD of the
                   // biggest section was never compared, so a regression there would pass.
                   // 16000 is Chrome's practical capture ceiling; beyond it we FLAG rather
                   // than quietly diff a partial image and call it a match.
                   w: Math.round(r.width), h: Math.round(r.height), tooTall: r.height > 16000 };
  });

  return { faint, clipped, overlaps, blank, rects };
})()`;

/* Pixel diff, computed inside Chrome so there is no PNG-decoding dependency. */
const diffExpr = (aB64, bB64) => `(async function(){
  const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const [A, B] = await Promise.all([load('data:image/png;base64,${aB64}'), load('data:image/png;base64,${bB64}')]);
  if (A.width !== B.width || A.height !== B.height)
    return { sizeMismatch: true, a: A.width + 'x' + A.height, b: B.width + 'x' + B.height };
  const c1 = document.createElement('canvas'), c2 = document.createElement('canvas');
  c1.width = c2.width = A.width; c1.height = c2.height = A.height;
  const x1 = c1.getContext('2d', { willReadFrequently: true }), x2 = c2.getContext('2d', { willReadFrequently: true });
  x1.drawImage(A, 0, 0); x2.drawImage(B, 0, 0);
  const d1 = x1.getImageData(0,0,A.width,A.height).data, d2 = x2.getImageData(0,0,A.width,A.height).data;
  let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let p = 0; p < d1.length; p += 4) {
    const dr = Math.abs(d1[p]-d2[p]), dg = Math.abs(d1[p+1]-d2[p+1]), db = Math.abs(d1[p+2]-d2[p+2]);
    if (dr + dg + db > 24) {                 // tolerate antialiasing, catch real change
      n++; const i = p/4, x = i % A.width, y = (i / A.width) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const total = A.width * A.height;
  return { pct: +(100 * n / total).toFixed(3), n, w: A.width, h: A.height,
           box: maxX < 0 ? null : { x: minX, y: minY, w: maxX-minX+1, h: maxY-minY+1 } };
})()`;

const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

async function main() {
  console.log('\nBaseline visual harness\n-----------------------');
  fs.mkdirSync(REF_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const changed = [];
  const pending = [];   // staged reference writes, committed only on a clean run

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=/tmp/baseline-visual-' + PORT], { stdio: 'ignore' });
  chrome.on('error', (e) => bad('chrome failed to start: ' + e.message));
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
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout: ' + method)); } }, 30000);
    });
    const { result: tr } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: ar } = await send('Target.attachToTarget', { targetId: tr.targetId, flatten: true });
    const sid = ar.sessionId;
    await send('Page.enable', {}, sid);
    await send('Runtime.enable', {}, sid);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: DETERMINISM }, sid);

    for (const v of VIEWS) {
      await send('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile }, sid);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v.theme }] }, sid);
      await send('Page.navigate', { url: PAGE_URL }, sid);
      await sleep(1200);
      // WAIT FOR MEDIA. The clip posters are absolute hlur.ai URLs (they must be, so the
      // GitHub Pages mirror resolves them too), so rendering the local file fetches them
      // over the network with variable timing. A reference recorded mid-load froze three
      // posters blank and then failed every later run — the harness was diffing its own
      // race, not the page. Fonts too: text reflows when they land.
      await send('Runtime.evaluate', { expression: `(async function(){
        const urls = new Set();
        document.querySelectorAll('img[src]').forEach(i => urls.add(i.src));
        document.querySelectorAll('video[poster]').forEach(v => urls.add(v.poster));
        await Promise.all([...urls].map(u => new Promise(res => {
          const i = new Image(); i.onload = i.onerror = res; i.src = u;
          setTimeout(res, 8000);                       // never hang the run on a dead asset
        })));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        // FREEZE THE MEDIA CHROME. HEADLESS Chrome draws a spinner over a <video> whose
        // data has not arrived (preload="none", so it never does), and it ROTATES — two
        // captures a second apart differ by ~850 pixels forever and #share can never hold
        // a reference. Verified 2026-07-31 against the live site: headless and headful
        // report identical element state (networkState 1, readyState 0) but only headless
        // PAINTS the spinner, so this is a harness artifact and the page is correct as
        // shipped. Do not "fix" the page for it. Same class as the mid-load posters above:
        // the harness diffing its own timing rather than the page.
        // Only the UA-drawn overlay is hidden; the poster is the actual content and still
        // renders, and verify.js separately asserts controls= is present in the markup, so
        // this cannot mask a control bar that went missing.
        const st = document.createElement('style');
        st.textContent = 'video::-webkit-media-controls,video::-webkit-media-controls-enclosure' +
                         '{display:none!important}';
        document.head.appendChild(st);
        document.querySelectorAll('video').forEach(v => { try { v.pause(); v.currentTime = 0; } catch {} });
      })()`, awaitPromise: true, returnByValue: true }, sid);
      await sleep(500);
      const { result } = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sid);
      if (result.exceptionDetails) throw new Error('probe threw: ' + JSON.stringify(result.exceptionDetails).slice(0, 200));
      const r = result.result.value;
      const tag = `[${v.name}]`;

      // ---- A. defect scans (work with no reference at all) ----
      r.faint.length === 0 ? ok(`${tag} all text meets its contrast minimum`)
        : bad(`${tag} ${r.faint.length} low-contrast text run(s): ` +
              r.faint.slice(0,3).map(f => `<${f.t}> ${f.r}:1 (needs ${f.need}) "${f.txt}…"`).join(' | '));
      r.clipped.length === 0 ? ok(`${tag} no text clipped by its own box`)
        : bad(`${tag} ${r.clipped.length} clipped: ` + r.clipped.slice(0,3).map(c => `<${c.t}> +${c.over}px "${c.txt}…"`).join(' | '));
      r.overlaps.length === 0 ? ok(`${tag} no overlapping controls`)
        : bad(`${tag} controls overlap: ` + r.overlaps.map(o => `"${o.a}" × "${o.b}" (${o.ox}×${o.oy}px)`).join(' | '));
      r.blank.length === 0 ? ok(`${tag} no section renders visibly blank`)
        : bad(`${tag} blank section(s): ` + r.blank.map(b => `#${b.id} ${b.h}px tall, no text`).join(', '));

      // ---- B. pixel diff per section ----
      let same = 0, recorded = 0;
      for (const sel of Object.keys(r.rects)) {
        const rect = r.rects[sel];
        // A section that VANISHES used to be skipped in silence — no message, no count, no
        // failure — so `#quizsec{display:none}` produced an all-green run. Absence is the
        // failure mode these harnesses were worst at; make it loud.
        if (!rect) { bad(`${tag} ${sel} is missing or invisible — NOT diffed`); continue; }
        if (rect.w < 10 || rect.h < 10) { bad(`${tag} ${sel} collapsed to ${rect.w}x${rect.h} — NOT diffed`); continue; }
        if (rect.tooTall) { bad(`${tag} ${sel} is ${rect.h}px — beyond capture range, NOT diffed`); continue; }
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: SCALE } }, sid);
        const b64 = shot.result.data;
        const safe = sel.replace(/[^a-z0-9]/gi, '_');
        const refPath = path.join(REF_DIR, `${v.name}_${safe}.png`);
        // Writes are BUFFERED and only committed at the end, and only when nothing failed —
        // otherwise `--update` on a broken page blesses the breakage as the new truth (it
        // did: an injected invisible-text bug got recorded into all 44 references).
        if (UPDATE) { pending.push([refPath, b64]); recorded++; continue; }
        if (!fs.existsSync(refPath)) {
          // A missing reference is NOT a pass. Silently recording it meant a fresh clone,
          // or a lost visual_ref/, made the whole pixel layer self-approve and exit 0.
          bad(`${tag} ${sel} has no approved reference — run 'node visual.js --update' deliberately`);
          continue;
        }
        const refB64 = fs.readFileSync(refPath).toString('base64');
        const { result: dr } = await send('Runtime.evaluate',
          { expression: diffExpr(refB64, b64), returnByValue: true, awaitPromise: true }, sid);
        const d = dr.result.value;
        if (!d) { bad(`${tag} ${sel}: diff failed to run`); continue; }
        if (d.sizeMismatch) {
          bad(`${tag} ${sel} SIZE CHANGED ${d.a} → ${d.b} — the section resized`);
          fs.writeFileSync(path.join(OUT_DIR, `${v.name}_${safe}_now.png`), Buffer.from(b64, 'base64'));
          changed.push(`${v.name} ${sel} (resized ${d.a}→${d.b})`);
        } else if (d.n > DIFF_PX_FAIL) {
          bad(`${tag} ${sel} LOOKS DIFFERENT: ${d.n} pixels changed (${d.pct}%)` +
              (d.box ? `, region ${d.box.w}×${d.box.h} at (${d.box.x},${d.box.y})` : ''));
          fs.writeFileSync(path.join(OUT_DIR, `${v.name}_${safe}_now.png`), Buffer.from(b64, 'base64'));
          fs.copyFileSync(refPath, path.join(OUT_DIR, `${v.name}_${safe}_ref.png`));
          changed.push(`${v.name} ${sel} (${d.n}px)`);
        } else {
          // Under the fail line but above pure noise: surfaced, never silent, so the
          // render instability that would otherwise block tightening the gate stays visible.
          if (d.n > DIFF_PX_NOISE) console.log(`     \x1b[2m· ${tag} ${sel}: ${d.n}px differ (under the ${DIFF_PX_FAIL}px gate)\x1b[0m`);
          same++;
        }
      }
      if (recorded) ok(`${tag} ${recorded} reference(s) staged for --update`);
      if (same) ok(`${tag} ${same} section(s) match the approved reference`);
    }
  } catch (e) {
    bad('harness error (failing closed): ' + e.message);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
  }

  // Commit staged references ONLY if the whole run was clean. Writing them per-section
  // inside the loop meant `--update` on a page with failing contrast rewrote every
  // reference and made the broken render the approved baseline.
  if (UPDATE) {
    if (fails === 0) {
      pending.forEach(([p, b]) => fs.writeFileSync(p, Buffer.from(b, 'base64')));
      console.log(`\n  wrote ${pending.length} reference image(s) — commit them`);
    } else {
      console.log(`\n  REFUSING to update ${pending.length} reference(s): ${fails} check(s) failed.`);
      console.log('  Fix the page first — otherwise the broken render becomes the approved baseline.');
    }
  }

  if (changed.length) {
    console.log(`\n  ${changed.length} section(s) changed — before/after written to visual_diff/:`);
    changed.forEach(c => console.log(`    · ${c}`));
    console.log('  LOOK AT THEM. If the change was intended: node visual.js --update');
  }
  console.log('-----------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}
main();
