#!/usr/bin/env node
/* ============================================================
   Baseline — SOURCE⇄LIVE parity harness  (Static Web Build BKM #2)
   Run:  node parity.js         (or:  SITE_URL=... node parity.js)
   ------------------------------------------------------------
   Proves the DEPLOYED site matches local source:
     • data.js must be byte-identical live vs local (SHA-256) —
       a static host serves .js verbatim, so any diff means the
       deploy is stale or wrong.
     • index.html: the host may re-quote/rewrite HTML, so we assert
       the key structural markers survive rather than full-hashing.
   Exits non-zero on any mismatch OR if the site is unreachable
   (fail closed — "can't verify" is not "verified").
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = (process.env.SITE_URL || 'https://siaklin99-gif.github.io/baseline-ai-literacy').replace(/\/+$/, '');
let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

async function get(url) {
  const ctl = AbortSignal.timeout(15000);
  const r = await fetch(url, { redirect: 'follow', signal: ctl });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  console.log('\nBaseline source⇄live parity\n---------------------------');
  console.log('  site: ' + SITE);

  let liveIndex = null, liveData = null;
  try { liveIndex = await get(SITE + '/index.html'); ok('fetched live index.html'); }
  catch (e) { bad('cannot reach live index.html: ' + e.message + ' (is it deployed yet?)'); }
  try { liveData = await get(SITE + '/data.js'); ok('fetched live data.js'); }
  catch (e) { bad('cannot reach live data.js: ' + e.message); }
  // the social-share image must actually be served (a card with a broken image is worse than none)
  try {
    const og = await get(SITE + '/og.png');
    const localOg = fs.readFileSync(path.join(__dirname, 'og.png'));
    sha(og) === sha(localOg) ? ok(`og.png live == local (sha ${sha(og)})`)
                             : bad(`og.png DIFFERS live vs local`);
  } catch (e) { bad('og.png not reachable live: ' + e.message); }

  // data.js must be byte-identical (static host serves .js as-is)
  if (liveData) {
    const localData = fs.readFileSync(path.join(__dirname, 'data.js'));
    sha(localData) === sha(liveData)
      ? ok(`data.js live == local (sha ${sha(localData)})`)
      : bad(`data.js DIFFERS — local ${sha(localData)} vs live ${sha(liveData)} (stale deploy?)`);
  }

  // index.html: assert the key structure survived the deploy
  if (liveIndex) {
    const html = liveIndex.toString();
    const markers = ['id="peel"', 'id="bodymap"', 'id="glossary"', 'class="gl-table"',
      'What is AI', 'AI jargon in plain English', '--grad',
      'property="og:image"', 'meta name="description"'];
    markers.forEach(m => html.includes(m) ? ok(`live index has: ${m}`) : bad(`live index MISSING: ${m}`));
    // the local source's markers must all be present live (nothing dropped)
    const local = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const localMissing = markers.filter(m => local.includes(m) && !html.includes(m));
    localMissing.length === 0 ? ok('every checked local marker is live')
                              : bad('local markers not live: ' + localMissing.join(', '));
  }

  console.log('---------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
})();
