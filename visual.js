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

const VIEWS = [
  { name: 'desktop', w: 1280, h: 900, mobile: false },
  { name: 'mobile',  w: 390,  h: 844, mobile: true },
];
const SECTIONS = ['header', '#try', '#circle', '#layers', '#reality', '#bodysec',
                  '#topics', '#labs', '#quizsec', '.share-strip', 'footer'];
const DIFF_PCT_FAIL = 0.12;   // measured: an unchanged run diffs 0.00%, so this is pure signal
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
  const rgba = (c) => { try { _c.clearRect(0,0,1,1); _c.fillStyle = '#000';
      _c.fillStyle = c; if (_c.fillStyle === '#000' && !/^#0{3,6}$|black|rgb\\(0, 0, 0\\)/i.test(c)) return null;
      _c.clearRect(0,0,1,1); _c.fillRect(0,0,1,1);
      const d = _c.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3]/255];
    } catch (e) { return null; } };
  const lum = (px) => { if (!px) return null;
    const f = px.slice(0,3).map(x => { x = x/255; return x <= .03928 ? x/12.92 : Math.pow((x+.055)/1.055, 2.4); });
    return .2126*f[0] + .7152*f[1] + .0722*f[2]; };
  // walk up compositing translucent layers; bail out if any layer is a gradient/image,
  // because "the contrast against a gradient" is not one number
  const bgOf = el => { let p = el, acc = null;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { gradient: true };
      const px = rgba(cs.backgroundColor);
      if (px && px[3] > 0) {
        acc = acc ? acc : px;
        if (px[3] >= 0.99) return { px: acc[3] >= 0.99 ? acc : px };
      }
      p = p.parentElement;
    }
    return { px: acc || rgba(getComputedStyle(document.body).backgroundColor) }; };

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

  // A2 clipped text (a box hiding its own content sideways)
  const clipped = [];
  document.querySelectorAll('p,li,h1,h2,h3,.t,.s,button,summary,.qz-q').forEach(el => {
    if (!vis(el)) return;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'hidden' && cs.overflow !== 'hidden') return;
    if (el.scrollWidth - el.clientWidth > 2) clipped.push({ t: el.tagName.toLowerCase(),
      over: el.scrollWidth - el.clientWidth, txt: el.textContent.trim().slice(0,34) });
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

  // capture rects, in page coordinates
  const rects = {};
  ${JSON.stringify(SECTIONS)}.forEach(sel => {
    const el = document.querySelector(sel);
    if (!el || !vis(el)) { rects[sel] = null; return; }
    const r = el.getBoundingClientRect();
    rects[sel] = { x: Math.max(0, Math.round(r.x + scrollX)), y: Math.max(0, Math.round(r.y + scrollY)),
                   w: Math.round(r.width), h: Math.min(Math.round(r.height), 4000) };
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

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=/tmp/baseline-visual-' + PORT], { stdio: 'ignore' });
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
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);
      await send('Page.navigate', { url: PAGE_URL }, sid);
      await sleep(1600);
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
      let same = 0, missing = 0;
      for (const sel of SECTIONS) {
        const rect = r.rects[sel];
        if (!rect || rect.w < 10 || rect.h < 10) continue;
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: SCALE } }, sid);
        const b64 = shot.result.data;
        const safe = sel.replace(/[^a-z0-9]/gi, '_');
        const refPath = path.join(REF_DIR, `${v.name}_${safe}.png`);
        if (UPDATE || !fs.existsSync(refPath)) {
          fs.writeFileSync(refPath, Buffer.from(b64, 'base64'));
          missing++;
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
        } else if (d.pct > DIFF_PCT_FAIL) {
          bad(`${tag} ${sel} LOOKS DIFFERENT: ${d.pct}% of pixels changed` +
              (d.box ? `, region ${d.box.w}×${d.box.h} at (${d.box.x},${d.box.y})` : ''));
          fs.writeFileSync(path.join(OUT_DIR, `${v.name}_${safe}_now.png`), Buffer.from(b64, 'base64'));
          fs.copyFileSync(refPath, path.join(OUT_DIR, `${v.name}_${safe}_ref.png`));
          changed.push(`${v.name} ${sel} (${d.pct}%)`);
        } else same++;
      }
      if (missing) ok(`${tag} recorded ${missing} new reference image(s)`);
      if (same) ok(`${tag} ${same} section(s) pixel-identical to the approved reference`);
    }
  } catch (e) {
    bad('harness error (failing closed): ' + e.message);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
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
