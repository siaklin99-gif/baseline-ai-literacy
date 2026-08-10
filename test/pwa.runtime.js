#!/usr/bin/env node
/* ============================================================
   Baseline — the service worker, actually exercised.
   Run:  node test/pwa.runtime.js

   WHY THIS EXISTS
   sw.js is the one component that can hand every returning visitor a STALE page after a
   deploy — the largest blast radius on the site — and until now it had zero coverage.
   Every other rendered harness loads the page over file://, where registration is gated
   off (index.html: `location.protocol.startsWith('http')`), so the worker never ran
   during a single check. ./selfcheck --live fetches the deployed site but never opens a
   browser, so it cannot see the worker either. A cold audit found the hole.

   So this serves the repo over real HTTP from a throwaway Node server — no dependency,
   no network — and asserts the three things that actually matter:
     1. the worker registers and reaches "activated" at all
     2. offline, a reload still renders the page (that is the whole promise of caching)
     3. NETWORK-FIRST IS REAL: change a file on the server, reload, and the NEW bytes
        arrive. A cache that quietly wins over the network is exactly the failure this
        strategy was chosen to avoid, and nothing tested it.

   Every wait has a hard timeout: a harness that hangs is a harness nobody runs.
   ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

/* The page is served from MEMORY, so the staleness test can change a byte without ever
   touching a tracked file on disk. */
let overrides = new Map();
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      if (overrides.has(rel)) {
        // Content-Type by EXTENSION, not hardcoded text/html. Serving an overridden
        // sw.js as text/html made Chrome reject the script outright, so the worker-update
        // check failed against a perfectly good sw.js — the harness's bug, not the code's.
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'text/html',
                             'Cache-Control': 'no-store' });
        return res.end(overrides.get(rel));
      }
      const abs = path.join(ROOT, rel);
      if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404); return res.end('nope');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream',
                           'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(abs));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const getJSON = (u) => new Promise((res, rej) =>
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

(async () => {
  console.log('\nBaseline PWA / service worker\n----------------------------');
  const srv = await serve();
  const PORT_HTTP = srv.address().port;
  const URL = `http://127.0.0.1:${PORT_HTTP}/index.html`;
  const CDP = 9500 + Math.floor(Math.random() * 400);

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP,
    '--no-first-run', '--hide-scrollbars', '--user-data-dir=/tmp/pwa-' + CDP], { stdio: 'ignore' });

  let ver, t = 0;
  while (t++ < 50) { try { ver = await getJSON(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await sleep(200); } }
  if (!ver) { srv.close(); chrome.kill('SIGKILL'); bad('Chrome never started'); process.exit(1); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const send = (m, p, s) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  /* Returns a marker instead of throwing. Deleting sw.js's fetch handler made the OFFLINE
     navigation land on Chrome's error page, where the probe threw and took the whole file
     down with a stack trace naming none of this — a crash where a clean red belonged.
     Each check now reports its own failure and the run continues. */
  const ev = async (expr) => {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) {
        return { __error: ((r.exceptionDetails.exception || {}).description || 'threw').split('\n')[0] };
      }
      return r.result.value;
    } catch (e) { return { __error: e.message.slice(0, 120) }; }
  };

  try {
    /* ---- 1. it registers at all ---- */
    await send('Page.navigate', { url: URL }, sessionId);
    await sleep(1800);
    // bounded wait: never hang the suite on a worker that will not activate
    const reg = await ev(`(async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const r = await navigator.serviceWorker.getRegistration();
        if (r && (r.active || r.installing || r.waiting)) {
          if (r.active) return { state: r.active.state, scope: r.scope };
          await new Promise(z => setTimeout(z, 250));
        } else await new Promise(z => setTimeout(z, 250));
      }
      return { state: 'never-registered', scope: null };
    })()`);
    (!reg.__error && reg.state === 'activated')
      ? ok(`the service worker registers and activates over http (scope ${reg.scope.replace(/^http:\/\/[^/]+/, '')})`)
      : bad(`service worker state "${reg.__error || reg.state}" — every rendered harness loads file://, where it is gated off, so this is the only check that would notice`);

    /* ---- 2. offline, the page still renders ---- */
    await send('Network.enable', {}, sessionId);
    await send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    await send('Page.navigate', { url: URL }, sessionId);
    await sleep(2000);
    const off = await ev(`(() => {
      const h1 = document.querySelector('h1');
      return { h1: h1 ? h1.textContent.trim().slice(0, 32) : null,
               sections: document.querySelectorAll('section[id]').length,
               // WITHOUT THIS the whole file proves nothing. Breaking sw.js to cache-first
               // — the exact stale-after-deploy bug — passed all three checks, because the
               // page was never actually being served THROUGH the worker; Chrome's own
               // memory cache was answering. "Controlled" is the precondition for every
               // claim below it.
               controlled: !!navigator.serviceWorker.controller };
    })()`);
    (!off.__error && off.h1 && off.sections >= 5 && off.controlled)
      ? ok(`offline reload still renders the page ("${off.h1}…", ${off.sections} sections) THROUGH the worker — the cache is doing its job`)
      : bad(`offline reload: ${off.__error ? 'the page did not load at all (' + off.__error + ') — with no working fetch handler there is nothing to serve'
              : off.controlled ? 'rendered nothing usable' : 'the page was NOT controlled by the worker, so this proves nothing'}`);

    /* ---- 3. NETWORK-FIRST IS REAL: fresh bytes must beat the cache ---- */
    await send('Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    const MARK = 'FRESH-BYTES-' + Date.now();
    const live = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    overrides.set('index.html', live.replace('</title>', `</title><meta name="sw-probe" content="${MARK}">`));
    await send('Page.navigate', { url: URL }, sessionId);
    await sleep(2000);
    const fresh0 = await ev(`(() => {
      const m = document.querySelector('meta[name="sw-probe"]');
      return { mark: m ? m.content : null, controlled: !!navigator.serviceWorker.controller };
    })()`);
    const fresh = fresh0.__error ? '__UNCONTROLLED__' : (fresh0.controlled ? fresh0.mark : '__UNCONTROLLED__');
    overrides.delete('index.html');
    (fresh === MARK)
      ? ok('a changed file reaches the reader on the next load — the cache never wins over a working network (this is what "stale after deploy" would break)')
      : bad(fresh === '__UNCONTROLLED__'
          ? 'the page was not controlled by the service worker on this load, so freshness was never actually tested'
          : `served a STALE page: expected the new bytes (${MARK}), got ${fresh === null ? 'the old page' : fresh} — every returning visitor would keep the pre-deploy site`);
    /* ---- 4. THE UPDATE PATH: a replaced worker must actually take over ----
       A cold audit injected an sw.js with NO install and NO activate handler — no
       skipWaiting, no clients.claim, no old-cache purge — and this file went 3/3 green.
       Every run starts from a throwaway profile, so the worker-REPLACEMENT path (the one
       that runs on every real deploy) was never exercised. */
    const swLive = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    overrides.set('sw.js', swLive.replace(/const CACHE = '[^']+'/, "const CACHE = 'baseline-v2-probe'"));
    await send('Page.navigate', { url: URL }, sessionId);
    await sleep(2500);
    const upd = await ev(`(async () => {
      /* 8s was not enough on a loaded machine — this went red inside a full suite run
         minutes after passing 4/4 in isolation. A flaky guard is worse than none: it
         teaches you to ignore reds. Longer deadline, and an explicit re-register so the
         update check is REQUESTED rather than waited for. */
      const deadline = Date.now() + 25000;
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) {}
      while (Date.now() < deadline) {
        const r = await navigator.serviceWorker.getRegistration();
        if (r) { try { await r.update(); } catch (e) {} }
        const keys = await caches.keys();
        /* The invariant is that the OLD cache is PURGED — that is what activate promises.
           Requiring the new cache to already exist raced its population and made this
           flaky (1 of 3 runs): a worker can be activated, having correctly deleted
           baseline-v1, a moment before anything has been fetched through it. */
        if (r && r.active && r.active.state === 'activated' && !keys.includes('baseline-v1')) {
          return { state: r.active.state, keys, controlled: !!navigator.serviceWorker.controller };
        }
        await new Promise(z => setTimeout(z, 400));
      }
      const keys = await caches.keys();
      const r = await navigator.serviceWorker.getRegistration();
      return { state: r && r.active ? r.active.state : 'none', keys,
               controlled: !!navigator.serviceWorker.controller };
    })()`);
    overrides.delete('sw.js');
    (!upd.__error && upd.state === 'activated' && upd.controlled && !upd.keys.includes('baseline-v1'))
      ? ok(`a new worker version takes over and purges the old cache (now: ${upd.keys.join(', ') || 'empty, awaiting first fetch'}) — the update path every deploy depends on`)
      : bad(`the replacement worker did not take over cleanly: state ${upd.__error || upd.state}, caches [${(upd.keys || []).join(', ')}] ` +
            `— a worker with no activate handler would leave the old cache behind forever`);
  } catch (e) {
    bad('PWA run threw: ' + e.message);
  }

  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
  srv.close();
  console.log('----------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
})();
