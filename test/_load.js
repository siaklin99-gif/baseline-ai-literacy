/* ============================================================
   Shared loader: run index.html's inline script headless.

   Both test/functions.test.js and test/claims_harness.js need the page's REAL
   functions, and each needs its own fresh copy with its own localStorage and its
   own idea of "today". One loader, so the two suites can never drift apart in how
   they build that environment (ONE SOURCE OF TRUTH).
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function stubEl() {
  const t = { style: {}, dataset: {}, children: [], hidden: false, textContent: '', innerHTML: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false } };
  return new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k];
      if (['appendChild','addEventListener','removeAttribute','setAttribute','toggleAttribute',
           'scrollIntoView','click','remove','after','before','append','prepend',
           'insertAdjacentHTML','closest','focus','blur'].includes(k)) return () => {};
      if (k === 'getAttribute') return () => null;
      if (k === 'getBoundingClientRect') return () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 });
      if (k === 'offsetHeight' || k === 'offsetWidth' || k === 'offsetLeft') return 0;
      if (k === 'querySelector') return () => stubEl();
      if (k === 'querySelectorAll') return () => [];
      return undefined;
    },
    set(o, k, v) { o[k] = v; return true; }
  });
}

/* An in-memory localStorage so storage-backed functions are really exercised,
   not stubbed into always-empty. */
function memStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? String(map.get(k)) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  };
}

/**
 * @param {object}  opts.storage  initial localStorage contents
 * @param {string}  opts.today    'YYYY-MM-DD' the page should believe it is
 * @param {string}  opts.host     location.hostname (tally is gated on it)
 * @param {string[]} opts.expose  extra identifiers to lift out of the page scope
 */
function loadPage(opts = {}) {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
  if (!m) throw new Error('could not locate the inline script in index.html');
  const dataSrc = fs.readFileSync(path.join(root, 'data.js'), 'utf8');

  const storage = memStorage(opts.storage || {});
  const beacons = [];

  // pin "now" so date maths is testable at chosen boundaries
  let DateCtor = Date;
  if (opts.today) {
    const fixed = new Date(opts.today + 'T12:00:00').getTime();
    DateCtor = class extends Date {
      constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
      static now() { return fixed; }
    };
  }

  const sandbox = {
    document: { getElementById: () => stubEl(), createElement: () => stubEl(), createElementNS: () => stubEl(),
                querySelector: () => stubEl(), querySelectorAll: () => [], head: stubEl(), body: stubEl(),
                addEventListener: () => {}, removeEventListener: () => {}, documentElement: stubEl(),
                // the rail's scroll-spy reads scrollingElement; without it the page script
                // throws on load and every test reports an unrelated-looking failure
                scrollingElement: { scrollTop: 0, scrollHeight: 5000, clientHeight: 900, clientWidth: 1440, scrollWidth: 1440 },
                fonts: { ready: Promise.resolve() } },
    localStorage: storage,
    console: { log() {}, warn() {}, error() {} },
    getComputedStyle: () => ({ paddingLeft: '0px', display: 'block' }),
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    // the desktop rail's scroll-spy reads these; without them the whole page script
    // fails to load and every unit test dies with an unrelated-looking error
    innerHeight: 900, innerWidth: 1440, scrollY: 0, scrollX: 0, scrollTo: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    location: { protocol: 'https:', search: '', hostname: opts.host || 'example.test', hash: '' },
    URLSearchParams,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    unescape, escape, encodeURIComponent, decodeURIComponent,
    Date: DateCtor, JSON, Math, parseInt, parseFloat, Blob: function Blob(){}, fetch: () => Promise.resolve(),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const wanted = ['esc', 'daysSince', 'renderList', 'dataCard', 'STALE_DAYS',
                  'localDate', 'qzRemember', 'qzDueNow', 'QZ_STEPS', 'QUIZ',
                  'tally', 'TALLY_OK', ...(opts.expose || [])];
  const boot = dataSrc + '\n' + m[1] +
    `\n;this.__api = { ${wanted.map(n => `${n}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`).join(', ')} };` +
    `\n;this.__track = () => (typeof qzTrack !== 'undefined' ? qzTrack : undefined);`;
  vm.runInContext(boot, sandbox);

  return { api: sandbox.__api, track: sandbox.__track, storage, beacons, sandbox };
}

module.exports = { loadPage, stubEl, memStorage };
