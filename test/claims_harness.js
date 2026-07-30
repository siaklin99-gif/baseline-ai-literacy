#!/usr/bin/env node
/* ============================================================
   Baseline — PROPERTY / ORACLE harness for the page's generated claims.
   Run:  node test/claims_harness.js

   WHY THIS EXISTS, AND WHY IT IS NOT A FIXTURE TEST
   The page writes SENTENCES a reader acts on: "next review in 3 days",
   "locked in ✓ · three spaced wins", "2 questions are due for review".
   Arithmetic tests do not check English, and a CORRECT number wrapped in a FALSE
   sentence passes every other harness in this repo — that is exactly what happened
   once already: the footer claimed the page "counts two things" while the code sent
   four, and a string-matching guard had cemented the understatement.

   So this is deliberately NOT a fixture test. Fixture tests pin the OUTPUT SHAPE,
   which turns a wrong claim into the protected baseline. Instead it runs RANDOM
   scenarios and asserts invariants no single example can cement.

   THE ORACLE IS INDEPENDENT. The expected schedule is re-declared below rather than
   imported from the page — a shared constant would mean a shared bug, and the test
   would agree with the code precisely when the code is wrong.
   ============================================================ */
const { loadPage } = require('./_load.js');

let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

/* ---- INDEPENDENT oracle: what a 1/3/7 spaced scheduler must do. Written from the
   product rule, NOT read from index.html. If the page changes its steps, this must
   be updated deliberately — that is the point. ---- */
const ORACLE_STEPS = [1, 3, 7];
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

/* deterministic PRNG so a failure is reproducible from its seed */
let _s = 20260730;
const rnd = () => { _s = (_s * 1103515245 + 12345) % 2147483648; return _s / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);

const DAYS = ['2026-01-31', '2026-02-28', '2026-12-31', '2026-03-01', '2026-07-30', '2027-02-28'];

console.log('\nBaseline generated-claims property harness\n------------------------------------------');

/* ============ P1. the schedule the sentences describe ============
   For random start states and random answers, the entry the page stores must match
   the independent oracle, and the value the page RETURNS (which becomes the chip
   text the reader sees) must describe that same entry. */
{
  let cases = 0, mismatch = [], contradiction = [], lied = [];
  for (let t = 0; t < 400; t++) {
    const today = pick(DAYS);
    const i = int(9);
    const stage = int(3);                       // 0,1,2
    const dueOffset = pick([-30, -1, 0, 1, 3, 7]);
    const seeded = { i, stage, due: addDays(today, dueOffset) };
    const { api, track } = loadPage({ today, storage: { baseline_quiz_missed: JSON.stringify([seeded]) } });
    const right = rnd() < 0.5;
    const rep = api.qzRemember(i, right);
    const after = (track() || []).find(x => x.i === i);
    cases++;

    const wasDue = seeded.due <= today;
    // --- oracle ---
    let expStage, expDue, expRep;
    if (!right) { expStage = 0; expDue = addDays(today, ORACLE_STEPS[0]); expRep = 'gap:1'; }
    else if (!wasDue) { expStage = stage; expDue = seeded.due; expRep = null; }   // not due: no free win
    else if (stage + 1 >= ORACLE_STEPS.length) { expStage = null; expDue = null; expRep = 'locked'; }
    else { expStage = stage + 1; expDue = addDays(today, ORACLE_STEPS[stage + 1]); expRep = 'gap:' + ORACLE_STEPS[stage + 1]; }

    if (expStage === null) { if (after) mismatch.push({ seeded, today, right, why: 'locked entry not retired' }); }
    else if (!after || after.stage !== expStage || after.due !== expDue)
      mismatch.push({ seeded, today, right, got: after, want: { stage: expStage, due: expDue } });
    if (rep !== expRep) lied.push({ seeded, today, right, rep, expRep });

    // the claim must not say two things at once
    if (rep === 'locked' && !right) contradiction.push({ seeded, today, why: 'a WRONG answer said "locked in"' });
    // and if it names a number of days, storage must actually be that many days out
    if (typeof rep === 'string' && rep.startsWith('gap:')) {
      const n = +rep.split(':')[1];
      const claimed = addDays(today, n);
      if (!after || after.due !== claimed)
        contradiction.push({ seeded, today, why: `chip says ${n} days but stored due is ${after && after.due}, not ${claimed}` });
    }
  }
  mismatch.length === 0 ? ok(`schedule matches the independent oracle across ${cases} random cases`)
    : bad(`${mismatch.length}/${cases} schedule mismatches, e.g. ${JSON.stringify(mismatch[0])}`);
  lied.length === 0 ? ok('the value shown to the reader always matches what was stored')
    : bad(`${lied.length} cases where the chip text disagreed with storage, e.g. ${JSON.stringify(lied[0])}`);
  contradiction.length === 0 ? ok('no self-contradictory claim (no "locked in" on a wrong answer; day counts are real)')
    : bad(`${contradiction.length} contradictions, e.g. ${JSON.stringify(contradiction[0])}`);
}

/* ============ P2. hostile storage can never produce a false claim ============
   Storage is user-editable and arrives from the transfer code, so it is untrusted
   input. Whatever is in it, the page's due-count must be one it can justify. */
{
  const HOSTILE = [
    '[]', 'null', '"nope"', '{}', '[[]]', '[1,1,1]', '[-1]', '[999]',
    '[{"i":0}]', '[{"i":0,"stage":-5,"due":"2026-01-01"}]',
    '[{"i":0,"stage":0,"due":"2026-7-1"}]', '[{"i":0,"stage":0,"due":"not-a-date"}]',
    '[{"i":0,"stage":0,"due":"2099-01-01"}]', '[{"i":2,"stage":0,"due":"2026-01-01"},{"i":2,"stage":2,"due":"2026-01-02"}]',
    '[{"i":1.5,"stage":0,"due":"2026-01-01"}]', 'not json at all',
  ];
  const today = '2026-07-30';
  let bad_ = [];
  for (const s of HOSTILE) {
    let r;
    try { r = loadPage({ today, storage: { baseline_quiz_missed: s } }); }
    catch (e) { bad_.push({ s, why: 'page threw: ' + e.message }); continue; }
    const tr = r.track() || [];
    const due = r.api.qzDueNow();
    const idx = tr.map(x => x.i);
    if (tr.some(x => !Number.isInteger(x.i) || x.i < 0 || x.i >= r.api.QUIZ.length)) bad_.push({ s, why: 'out-of-range index survived' });
    if (new Set(idx).size !== idx.length) bad_.push({ s, why: 'duplicate index survived — banner count would exceed flags shown' });
    if (tr.some(x => !/^\d{4}-\d{2}-\d{2}$/.test(x.due))) bad_.push({ s, why: 'malformed due date survived' });
    if (tr.some(x => x.due > '2026-08-06')) bad_.push({ s, why: 'unreachable future due survived — would be counted forever, never actionable' });
    if (due.length > tr.length) bad_.push({ s, why: 'due count exceeds tracked count' });
  }
  bad_.length === 0 ? ok(`${HOSTILE.length} hostile storage payloads all produce a defensible state`)
    : bad(`${bad_.length} hostile payloads broke an invariant, e.g. ${JSON.stringify(bad_[0])}`);
}

/* ============ P3. monotonicity — progress must never go backwards ============
   Answering correctly, when due, must never lengthen the queue or demote a question. */
{
  const today = '2026-07-30';
  let regressions = 0;
  for (let t = 0; t < 200; t++) {
    const n = 1 + int(4);
    const seed = [];
    for (let k = 0; k < n; k++) {
      const i = int(9);
      if (seed.some(x => x.i === i)) continue;
      seed.push({ i, stage: int(3), due: addDays(today, pick([-5, -1, 0])) });   // all DUE
    }
    if (!seed.length) continue;
    const { api, track } = loadPage({ today, storage: { baseline_quiz_missed: JSON.stringify(seed) } });
    const before = (track() || []).length;
    const target = seed[int(seed.length)];
    const prevStage = (track() || []).find(x => x.i === target.i).stage;
    api.qzRemember(target.i, true);
    const afterArr = track() || [];
    const now = afterArr.find(x => x.i === target.i);
    if (afterArr.length > before) regressions++;                       // queue grew on a correct answer
    if (now && now.stage < prevStage) regressions++;                   // demoted despite being right
  }
  regressions === 0 ? ok('a correct, due answer never grows the queue or demotes a question (200 cases)')
    : bad(`${regressions} regressions where being right made things worse`);
}

/* ============ P4. the tally may only ever say allowlisted words ============ */
{
  const junk = ['evil', '', null, undefined, 0, {}, [], 'load; DROP', 'LOAD', 'quiz ', '../../etc'];
  {
    const { api, beacons } = loadPage({ host: 'hlur.ai' });
    beacons.length = 0;
    junk.forEach(j => { try { api.tally(j); } catch (e) { beacons.push({ threw: e.message }); } });
    beacons.length === 0 ? ok('tally() emits nothing for any non-allowlisted event (and never throws)')
      : bad(`tally leaked ${beacons.length} bad event(s): ${JSON.stringify(beacons[0])}`);
    api.TALLY_OK.forEach(e => api.tally(e));
    const bodies = beacons.map(b => { try { return JSON.parse(b.body && b.body.parts ? b.body.parts[0] : '{}'); } catch (e) { return {}; } });
    beacons.length === api.TALLY_OK.length
      ? ok(`tally() emits exactly one beacon per allowlisted event (${api.TALLY_OK.join(', ')})`)
      : bad(`expected ${api.TALLY_OK.length} beacons, got ${beacons.length}`);
  }
  {
    const { api, beacons } = loadPage({ host: 'siaklin99-gif.github.io' });
    beacons.length = 0;
    api.TALLY_OK.forEach(e => api.tally(e));
    beacons.length === 0 ? ok('tally() is silent on every host except hlur.ai (the mirror never phones home)')
      : bad(`the mirror sent ${beacons.length} beacon(s)`);
  }
}

/* ============ P5. date maths across the boundaries that break naive code ============ */
{
  const cases = [
    ['2026-01-31', 1, '2026-02-01'], ['2026-02-28', 1, '2026-03-01'],
    ['2028-02-28', 1, '2028-02-29'],                                   // leap year
    ['2026-12-31', 1, '2027-01-01'], ['2026-12-31', 7, '2027-01-07'],
    ['2026-03-01', 0, '2026-03-01'], ['2026-08-25', 7, '2026-09-01'],
  ];
  const wrong = cases.filter(([today, n, want]) => loadPage({ today }).api.localDate(n) !== want);
  wrong.length === 0 ? ok(`localDate() correct across ${cases.length} month/year/leap boundaries`)
    : bad(`localDate wrong: ${wrong.map(([d,n,w]) => `${d}+${n} wanted ${w} got ${loadPage({today:d}).api.localDate(n)}`).join('; ')}`);
}

console.log('------------------------------------------');
console.log(`${checks} checks, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
