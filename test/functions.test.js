#!/usr/bin/env node
/* ============================================================
   Baseline — adversarial unit tests for the page's pure functions
   Run:  node test/functions.test.js
   ------------------------------------------------------------
   Loads the REAL functions out of index.html (esc, daysSince,
   renderList, dataCard) by executing the inline script against a
   tiny DOM stub, then feeds them dirty, hostile, boundary input.
   Clean input was already covered by verify.js — these are the
   tests that earn trust (Adversarial Test Rule).
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fails = 0, checks = 0;
const eq = (got, want, m) => { checks++; if (JSON.stringify(got) === JSON.stringify(want)) console.log('  \x1b[32m✓\x1b[0m ' + m); else { fails++; console.log(`  \x1b[31m✗ ${m}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}\x1b[0m`); } };
const truthy = (got, m) => { checks++; if (got) console.log('  \x1b[32m✓\x1b[0m ' + m); else { fails++; console.log(`  \x1b[31m✗ ${m} (got ${JSON.stringify(got)})\x1b[0m`); } };

/* ---- tiny DOM stub: enough for index.html's inline script to run headless ---- */
function stubEl() {
  const t = { style: {}, dataset: {}, children: [],
    classList: { toggle() {}, add() {}, remove() {} } };
  return new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k];
      if (['appendChild','addEventListener','removeAttribute','setAttribute','toggleAttribute','scrollIntoView','click','remove','after','before','append','prepend'].includes(k)) return () => {};
      if (k === 'getAttribute') return () => null;
      if (k === 'getBoundingClientRect') return () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 });
      if (k === 'offsetHeight' || k === 'offsetWidth') return 0;
      if (k === 'querySelector') return () => stubEl();
      if (k === 'querySelectorAll') return () => [];
      return undefined;
    },
    set(o, k, v) { o[k] = v; return true; }
  });
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// the inline script is the only <script> with NO attributes
const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
if (!m) { console.log('\x1b[31mCould not locate inline script in index.html\x1b[0m'); process.exit(1); }

// load data.js (defines window.BASELINE_DATA), then the page script, in one sandbox
const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
const sandbox = {
  document: { getElementById: () => stubEl(), createElement: () => stubEl(), createElementNS: () => stubEl(),
              querySelector: () => stubEl(), querySelectorAll: () => [], head: stubEl(), body: stubEl() },
  localStorage: { getItem: () => null, setItem() {} },
  console: { log() {}, warn() {}, error() {} },
  getComputedStyle: () => ({ paddingLeft: '0px', display: 'block' }),
  requestAnimationFrame: () => 0,
  addEventListener: () => {},
  // browser timer globals the page uses (animated flow); no-op stubs for the headless harness
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  Date, JSON, Math, parseInt, parseFloat,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// expose the functions we want to test onto the sandbox global
const bootstrap = dataSrc + '\n' + m[1] + '\n;this.__api = { esc, daysSince, renderList, dataCard, STALE_DAYS };';
try { vm.runInContext(bootstrap, sandbox); }
catch (e) { console.log('\x1b[31mFailed to load page functions: ' + e.message + '\x1b[0m'); process.exit(1); }
const { esc, daysSince, renderList, dataCard, STALE_DAYS } = sandbox.__api;

console.log('\nBaseline adversarial unit tests\n-------------------------------');

/* ---- esc(): hostile characters must be neutralized ---- */
eq(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', 'esc neutralizes <script>');
eq(esc('Q&A "quoted" <tag>'), 'Q&amp;A &quot;quoted&quot; &lt;tag&gt;', 'esc escapes & " < >');
eq(esc(null), '', 'esc(null) -> empty string');
eq(esc(undefined), '', 'esc(undefined) -> empty string');
eq(esc(42), '42', 'esc coerces numbers');

/* ---- renderList(): dirty rows ---- */
truthy(renderList([]) === '', 'empty list -> empty string');
{
  const out = renderList([{name:'X<b>', kind:'k', best:'b'}]);
  truthy(!out.includes('<b>') && out.includes('X&lt;b&gt;'), 'model row escapes HTML in name (raw gone AND escaped form present)');
}
truthy(renderList([{plan:'P & Q', cost:'$0', notes:'n'}]).includes('P &amp; Q'), 'pricing row escapes &');
truthy(renderList([{title:'T', author:'A & B', kind:'Book', why:'w'}]).includes('A &amp; B'), 'book row escapes author');
truthy(renderList([{foo:'bar'}]).includes('Malformed row 1'), 'row with no name/plan/title -> visible fallback (not silent drop)');
truthy(renderList([{name:'a'},{oops:1},{title:'b',kind:'Book'}]).match(/Malformed row 2/), 'fallback numbering points to the bad row');

/* ---- daysSince(): boundary + garbage ---- */
eq(daysSince('not-a-date'), null, 'daysSince(garbage) -> null');
eq(daysSince('2026-13-45'), null, 'daysSince(impossible date) -> null');
const iso = (d) => new Date(d).toISOString().slice(0,10);
const at = (days) => iso(Date.now() - days*86400000);
truthy(daysSince(at(STALE_DAYS)) <= STALE_DAYS, `exactly ${STALE_DAYS}d ago is NOT stale (boundary)`);
truthy(daysSince(at(STALE_DAYS + 5)) > STALE_DAYS, `${STALE_DAYS+5}d ago IS stale`);

/* ---- dataCard(): every freshness branch ---- */
sandbox.window.BASELINE_DATA.__empty = { asOf:'', html:'<p>x</p>', list:[] };
sandbox.window.BASELINE_DATA.__bad   = { asOf:'13 Foo 2026', html:'<p>x</p>', list:[] };
sandbox.window.BASELINE_DATA.__stale = { asOf: at(400), html:'<p>x</p>', list:[] };
sandbox.window.BASELINE_DATA.__fresh = { asOf: at(3), source:'S', sourceUrl:'https://e.com', html:'<p>x</p>', list:[] };
sandbox.window.BASELINE_DATA.__miss  = undefined;
truthy(dataCard('__empty').includes('Needs live check'), 'empty asOf -> Needs live check');
truthy(dataCard('__bad').includes('Invalid date'), 'unparseable asOf -> Invalid date (not "not filled in")');
truthy(dataCard('__stale').includes('May be outdated'), 'old asOf -> May be outdated');
truthy(dataCard('__fresh').includes('Verified') && dataCard('__fresh').includes('href="https://e.com"'), 'recent asOf -> Verified + source link');
truthy(dataCard('__nonexistent') === (''+dataCard('__nonexistent')) && dataCard('__nonexistent').includes('Needs live check'), 'missing data key degrades to placeholder (no crash)');
truthy(!dataCard('__fresh').includes('undefined') && !dataCard('__fresh').includes('NaN'), 'no undefined/NaN leaks into a rendered card');

console.log('-------------------------------');
console.log(`${checks} checks, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
