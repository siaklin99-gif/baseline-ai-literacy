#!/usr/bin/env node
/* ============================================================
   Baseline — universal invariants sweep
   Run:  node test/invariants.js
   ------------------------------------------------------------
   Repo-wide guards that apply to any project (per the Proactive
   Auditing Agent Rule):
     • JavaScript syntax / type check on every .js
     • forbidden dev-marker sweep across .html/.js/.css/.csv
       (patterns assembled from fragments so THIS file never
        contains the literal markers)
     • leaked-token scan of data.js values (undefined/NaN/[object])
   FAILS CLOSED: any unreadable file or tooling error blocks.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.claude', 'crosscheck_shots']);
let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

function walk(dir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { bad('cannot read dir ' + dir + ' (failing closed): ' + e.message); return out; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

console.log('\nBaseline universal invariants\n-----------------------------');

const all = walk(ROOT);
const rel = (f) => path.relative(ROOT, f);

/* ---- 1. JS syntax check (language/type check) ---- */
const jsFiles = all.filter(f => f.endsWith('.js'));
let syntaxBad = 0;
if (!jsFiles.length) bad('no .js files found — walk() likely failed (failing closed)');
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { syntaxBad++; bad('syntax error in ' + rel(f) + ': ' + String(e.stderr || e.message).split('\n')[0]); }
}
if (jsFiles.length && !syntaxBad) ok(`all ${jsFiles.length} .js files pass syntax check`);

/* ---- 2. forbidden dev-marker sweep (fragments -> pattern) ---- */
const markers = [
  ['T','O','D','O'], ['F','I','X','M','E'], ['H','A','C','K'],
  ['l','o','r','e','m',' ','i','p','s','u','m'],
];
const markerRe = new RegExp('\\b(' + markers.map(a => a.join('')).join('|') + ')\\b', 'i');
const sweepExts = ['.html', '.js', '.css', '.csv', '.md', '.json'];
let markerHits = 0;
for (const f of all.filter(f => sweepExts.includes(path.extname(f)))) {
  if (f === __filename) continue; // don't scan the guard itself
  let txt; try { txt = fs.readFileSync(f, 'utf8'); }
  catch (e) { bad('cannot read ' + rel(f) + ' (failing closed): ' + e.message); continue; }
  txt.split('\n').forEach((line, i) => {
    if (markerRe.test(line)) { markerHits++; bad(`unresolved dev marker in ${rel(f)}:${i + 1} -> "${line.trim().slice(0, 60)}"`); }
  });
}
if (!markerHits) ok('no unresolved dev markers in source');

/* ---- 3. leaked-token scan of data.js values ----
   NOTE: JSON.stringify hides real NaN (-> null) and drops undefined properties,
   so we must (a) walk the LIVE parsed object for genuine NaN/undefined values,
   and (b) regex the RAW source for literal NaN/undefined in value position. */
try {
  const g = {}; global.window = g;
  delete require.cache[require.resolve('../data.js')];
  require('../data.js');
  let leaks = 0;
  const walkVal = (v, trail) => {
    if (v === undefined) { leaks++; bad(`data.js value is undefined at ${trail}`); return; }
    if (typeof v === 'number' && Number.isNaN(v)) { leaks++; bad(`data.js value is NaN at ${trail}`); return; }
    if (typeof v === 'string' && /undefined|\bNaN\b|\[object Object\]/.test(v)) { leaks++; bad(`data.js string contains a leaked token at ${trail}`); return; }
    if (Array.isArray(v)) v.forEach((x, i) => walkVal(x, `${trail}[${i}]`));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walkVal(v[k], `${trail}.${k}`);
  };
  walkVal(g.BASELINE_DATA || {}, 'BASELINE_DATA');
  // raw-source guard: catches `key: NaN` / `key: undefined` even if the loader ever normalized them
  const rawData = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
  if (/:\s*(NaN|undefined)\b/.test(rawData)) { leaks++; bad('data.js source has a literal NaN/undefined in value position'); }
  if (!leaks) ok('no leaked tokens in data.js values (walked live object + raw source)');
} catch (e) {
  bad('could not load data.js for leak scan (failing closed): ' + e.message);
}

/* ---- 4. publication-leak sweep (this repo is PUBLIC) ----
   Anything identifying the author's machine, other private projects, or
   credentials must not ship. Ported from AI_Hub/verify.js after verify.js
   HERE carried four absolute /U…/ paths naming a private sibling project —
   the exact class AI_Hub had already treated as a release blocker. Patterns
   are assembled from fragments so this guard never trips itself (and the
   sweep still skips __filename, because the email allowlist below must name
   real addresses). */
{
  const LEAKS = [
    { name: 'absolute macOS home path',   re: new RegExp('/' + 'Users' + '/[A-Za-z0-9._-]+/') },
    { name: 'absolute Linux home path',   re: new RegExp('/' + 'home' + '/[A-Za-z0-9._-]+/') },
    { name: 'absolute Windows home path', re: new RegExp('C:' + '\\\\Users\\\\[A-Za-z0-9._-]+') },
    { name: 'API-key-shaped string',      re: new RegExp('(' + 'sk' + '-[A-Za-z0-9]{16}|' + 'ghp' + '_[A-Za-z0-9]{20}|' + 'AKIA' + '[A-Z0-9]{12})') },
  ];
  // Deliberately-published addresses are not leaks: the page's own contact
  // address (verify.js REQUIRES the mailto), and GitHub's CI bot identity.
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const emailAllowed = (e) => e === 'hello@' + 'hlur.ai' || e.endsWith('@users.' + 'noreply.' + 'github.com');

  // Sweep the extensionless shell entrypoints and CI config too — walk()
  // skips dot-dirs, but .github/workflows SHIPS with the public repo.
  const leakExts = ['.html', '.js', '.mjs', '.css', '.csv', '.md', '.json', '.sh', '.yml', '.yaml'];
  const leakFiles = all.concat(fs.existsSync(path.join(ROOT, '.github')) ? walk(path.join(ROOT, '.github')) : [])
    .filter(f => leakExts.includes(path.extname(f)) || ['selfcheck', 'pre-commit'].includes(path.basename(f)));

  let leakHits = 0;
  for (const f of leakFiles) {
    if (f === __filename) continue;
    let body; try { body = fs.readFileSync(f, 'utf8'); }
    catch (e) { bad('cannot read ' + rel(f) + ' for leak sweep (failing closed): ' + e.message); leakHits++; continue; }
    for (const L of LEAKS) {
      const m = L.re.exec(body);
      if (m) {
        leakHits++;
        bad(`${rel(f)}:${body.slice(0, m.index).split('\n').length}: ${L.name} would be published -> "${m[0].slice(0, 60)}"`);
      }
    }
    for (const m of body.matchAll(EMAIL_RE)) {
      if (emailAllowed(m[0])) continue;
      leakHits++;
      bad(`${rel(f)}:${body.slice(0, m.index).split('\n').length}: email address would be published -> "${m[0]}"`);
    }
  }
  if (!leakFiles.length) { leakHits++; bad('leak sweep found no files to sweep — walk() likely failed (failing closed)'); }
  if (!leakHits) ok(`${leakFiles.length} files swept: no home paths, emails or key-shaped strings`);
}

console.log('-----------------------------');
console.log(`${checks} checks, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
