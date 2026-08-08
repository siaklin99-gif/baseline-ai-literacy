#!/usr/bin/env node
/* ============================================================
   Baseline — capture the mobile UI states, for looking at.

     node tools/mobile-shots.js                 every state
     node tools/mobile-shots.js dial clips      only these
     node tools/mobile-shots.js --list          what can be captured
     node tools/mobile-shots.js --out /tmp/x    somewhere other than mobile_shots/

   Runs in ./selfcheck --full as a SMOKE CHECK: each state's setup throws if its
   section, deck, or door has vanished, so a renamed id or a deleted door fails the
   run (exit 1, no PNG for that state). What it can NOT judge is whether a shot LOOKS
   right — visual.js owns the pixel diff, test/mobiledeck.runtime.js owns the
   behaviour, and the aesthetic verdict stays a human job. Run it, open the PNGs,
   look.

   Why a script and not a handful of ad-hoc screenshots: the states worth looking at are
   NOT the ones you land on by loading the page. Several need a scroll to a section, a
   deck scrolled to the middle, or a layer-2 door opened first — and reproducing that by
   hand each time is how you end up comparing two different things and calling it a
   regression. Each state below is one line, so adding one is cheap.

   Chrome only, over CDP, no dependencies — same approach as every other harness here.
   Device pixel ratio 2, so the PNGs are retina and text is judgeable.

   KNOWN, AND NOT A BUG: headless Chrome paints a rotating spinner over a <video> whose
   data has not arrived. Real browsers do not — verified against the live site, identical
   element state, only headless paints it. Ignore it in the clip shots.
   ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');
const W = 390, H = 844;                    // iPhone-ish; the mobile breakpoint is 759px

/* Each state: [name, theme, setup]. `setup` runs in the page after load and before the
   shot — scroll somewhere, open a door, push a deck to the middle. */
const STATES = [
  ['doorway',      'light', `scrollToSection('deeper')`],
  ['doorway-dark', 'dark',  `scrollToSection('deeper')`],
  ['quiz',         'light', `scrollToSection('quizsec')`],
  ['dial-step1',   'light', `scrollToSection('circle')`],
  ['dial-step4',   'light', `scrollToSection('circle'); deckTo('lcList', 0.42)`],
  ['dial-dark',    'dark',  `scrollToSection('circle'); deckTo('lcList', 0.85)`],
  ['clips',        'light', `document.querySelector('[data-deep-open="share"]').click()`],
  ['reality',      'light', `scrollToSection('reality')`],
  ['top',          'light', `scrollTo(0, 0)`],
];

/* Helpers injected into the page so a state stays one readable line above. */
const HELPERS = `
  window.scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error('no section #' + id);
    scrollTo(0, el.offsetTop - 14);
  };
  window.deckTo = (id, frac) => {
    const d = document.getElementById(id);
    if (!d) throw new Error('no deck #' + id);
    d.scrollLeft = d.scrollWidth * frac;
  };
  // Scroll-reveal elements only fade in when they cross the viewport. A screenshot taken
  // right after a programmatic scroll can catch them mid-fade, or never faded at all, and
  // the result looks like missing content rather than a timing artifact.
  document.querySelectorAll('.reveal').forEach(r => r.classList.add('in'));
`;

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log('states: ' + STATES.map(s => s[0]).join(', '));
  process.exit(0);
}
const outIdx = args.indexOf('--out');
const OUT = outIdx > -1 ? args[outIdx + 1] : path.join(__dirname, '..', 'mobile_shots');
// `i !== outIdx + 1` skips the VALUE that follows --out. Guard the outIdx > -1 case:
// with no --out, outIdx is -1, so outIdx + 1 is 0 and this silently dropped the first
// argument — asking for one state captured all nine, which looks like it worked.
const picked = args.filter((a, i) => !a.startsWith('--') && !(outIdx > -1 && i === outIdx + 1));
const wanted = picked.length ? STATES.filter(s => picked.some(p => s[0].includes(p))) : STATES;
if (!wanted.length) {
  console.error(`no state matches ${picked.join(', ')} — try --list`);
  process.exit(1);
}
if (!fs.existsSync(CHROME)) { console.error('Chrome not found at ' + CHROME); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) =>
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = 9300 + Math.floor(Math.random() * 90);
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--no-first-run', '--hide-scrollbars', '--user-data-dir=/tmp/mshots-' + PORT], { stdio: 'ignore' });

  let ver, t = 0;
  while (t++ < 60) { try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
  if (!ver) { chrome.kill('SIGKILL'); console.error('Chrome never came up on port ' + PORT); process.exit(2); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const send = (m, p, s) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  let failed = 0;
  for (const [name, theme, setup] of wanted) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true }, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
    await send('Page.navigate', { url: PAGE }, sessionId);
    await sleep(2200);                                    // data.js + fonts + first paint
    await send('Runtime.evaluate', { expression: HELPERS }, sessionId);
    // A setup step that throws would otherwise produce a screenshot of the WRONG state
    // that still looks plausible — the top of the page instead of the section you asked
    // for. Say so loudly and keep going with the rest.
    const r = await send('Runtime.evaluate', { expression: setup, returnByValue: true }, sessionId);
    if (r && r.exceptionDetails) {
      console.log(`  \x1b[31m✗ ${name}: setup failed — ${(r.exceptionDetails.exception || {}).description || 'threw'}\x1b[0m`);
      failed++;
      continue;
    }
    await sleep(1100);                                    // smooth-scroll + snap settle
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  \x1b[32m✓\x1b[0m ${file}  (${theme}, ${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  }

  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
  console.log(`\n${wanted.length - failed}/${wanted.length} captured in ${OUT} — open them and look.`);
  process.exit(failed ? 1 : 0);
})();
