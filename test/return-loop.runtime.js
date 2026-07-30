#!/usr/bin/env node
/* Runtime test of the roadmap-batch features (spaced repetition, attention
   playground, lab 001, path picker, share-score) in real headless Chrome. */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9383;
const PAGE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
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

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--user-data-dir=/tmp/baseline-nf-' + PORT
  ], { stdio: 'ignore' });
  let ws;
  try {
    let ver, tries = 0;
    while (tries++ < 50) { try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
    if (!ver) throw new Error('devtools endpoint never ready');
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const nav = async () => {
      const loaded = new Promise((res) => cdp.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') res(); }));
      await cdp.send('Page.navigate', { url: PAGE_URL }, sessionId);
      await Promise.race([loaded, sleep(20000).then(() => { throw new Error('load never fired'); })]);
      await sleep(300);
    };
    const evl = async (expr) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (exceptionDetails) throw new Error('page eval threw: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
      return result.value;
    };

    /* ============ scenario A: fresh visitor ============ */
    await nav();
    await evl(`localStorage.clear()`);
    await nav();

    let r = await evl(`(function(){
      const chips = [...document.querySelectorAll('#attnPlay .attn-w')];
      const bars = [...document.querySelectorAll('#attnBars .attn-bar')];
      const why1 = document.getElementById('attnWhy').textContent;
      const onWord = document.querySelector('#attnPlay .attn-w.on')?.textContent;
      chips.find(c => c.textContent === 'full').click();
      const why2 = document.getElementById('attnWhy').textContent;
      const bars2 = [...document.querySelectorAll('#attnBars .attn-bar')].map(b => b.querySelector('em').textContent);
      const w2 = [...document.querySelectorAll('#attnBars .attn-bar b')].map(b => parseFloat(b.textContent));
      return { nChips: chips.length, nBars: bars.length, onWord, whyChanged: why1 !== why2 && why2.length > 10,
               bars2, sum2: w2.reduce((a,b)=>a+b,0), on2: document.querySelector('#attnPlay .attn-w.on')?.textContent };
    })()`);
    r.nChips === 9 ? ok('attention: 9 word chips rendered') : bad(`attention: ${r.nChips} chips (want 9)`);
    (r.onWord === 'it' && r.nBars === 3) ? ok('attention: starts on "it" with 3 bars') : bad(`attention: start=${r.onWord}, bars=${r.nBars}`);
    (r.whyChanged && r.on2 === 'full') ? ok('attention: tapping "full" switches selection + explanation') : bad('attention: tap on "full" did not update');
    (r.bars2.includes('it') && Math.abs(r.sum2 - 1) < 0.01) ? ok(`attention: "full" attends to ${r.bars2.join(',')} — weights sum ${r.sum2.toFixed(2)}`) : bad(`attention: full→${r.bars2.join(',')} sum=${r.sum2}`);

    r = await evl(`(function(){
      const p = document.getElementById('labPrompt');
      const s = document.getElementById('labScore');
      const start = p.textContent;
      const chips = [...document.querySelectorAll('#labBuild .lab-chip')];
      chips.forEach(c => c.click());
      const full = p.textContent, fullScore = s.textContent;
      chips[0].click();   // toggle role back off
      const after = p.textContent, afterScore = s.textContent;
      return { start, full, fullScore, after, afterScore };
    })()`);
    r.start.includes('Help me plan a trip to Japan.') ? ok('lab001: weak prompt shown by default') : bad('lab001: weak prompt missing: ' + r.start);
    (r.full.includes('travel planner') && r.full.includes('7-day itinerary') && r.full.includes('day-by-day') && r.full.includes('bad idea') && !r.full.includes('Help me plan a trip to Japan.'))
      ? ok('lab001: all 4 upgrades stack; sharpened task replaces the weak line') : bad('lab001: 4-chip prompt wrong: ' + r.full);
    r.fullScore.startsWith('4/4') ? ok('lab001: score reads 4/4 pro-level') : bad('lab001: score at 4 chips: ' + r.fullScore);
    (!r.after.includes('travel planner') && r.afterScore.startsWith('3/4')) ? ok('lab001: toggling a chip off removes its line (3/4)') : bad('lab001: toggle-off broken: ' + r.afterScore);

    r = await evl(`(function(){
      const chips = [...document.querySelectorAll('.path-chip')];
      chips.find(c => c.dataset.path === 'new').click();
      const rec = [...document.querySelectorAll('.lc-row.lc-rec')].length;
      const saved = localStorage.getItem('baseline_path');
      const startHere = !!document.querySelector('.lc-rec-chip');
      return { nChips: chips.length, rec, saved, startHere };
    })()`);
    (r.nChips === 3 && r.rec === 3 && r.saved === '"new"' && r.startHere) ? ok('path picker: "New to AI" lights 3 rows + start-here chip + persists (JSON-encoded)') : bad(`path picker: chips=${r.nChips} rec=${r.rec} saved=${r.saved} startHere=${r.startHere}`);
    await nav();
    r = await evl(`(function(){ return { rec: document.querySelectorAll('.lc-row.lc-rec').length, on: document.querySelector('.path-chip.on')?.dataset.path }; })()`);
    (r.rec === 3 && r.on === 'new') ? ok('path picker: choice survives reload') : bad(`path picker after reload: rec=${r.rec} on=${r.on}`);

    // answer all 9 (q0 wrong on purpose, rest right) → share button + rotation copy
    r = await evl(`(function(){
      // deterministic: for each question click the CORRECT option, except q0 → wrong
      const A = ['yes','yes','no','yes','no','no','no','yes','no'];
      const els = [...document.querySelectorAll('.qz')];
      els.forEach((el, i) => {
        const want = i === 0 ? (A[i] === 'yes' ? 'no' : 'yes') : A[i];
        [...el.querySelectorAll('.qz-opt')].find(o => o.dataset.a === want).click();
      });
      const score = document.getElementById('qzScore').textContent;
      const share = !!document.getElementById('qzShare');
      const store = JSON.parse(localStorage.getItem('baseline_quiz_missed') || '[]');
      return { score, share, store };
    })()`);
    r.share ? ok('share-score: 📣 button appears after finishing the quiz') : bad('share-score button missing. score=' + r.score);
    (r.score.includes('8 / 9') && r.score.includes('rotation')) ? ok('quiz copy: final score + review-rotation line') : bad('quiz final copy: ' + r.score);
    (r.store.length === 1 && r.store[0].i === 0 && r.store[0].stage === 0 && typeof r.store[0].due === 'string')
      ? ok(`spaced: miss stored as {i:0,stage:0,due:${r.store[0].due}} (tomorrow)`) : bad('spaced: store after miss = ' + JSON.stringify(r.store));

    /* ============ scenario B: spaced repetition over time ============ */
    // v1 migration + due-today flow: seed old int-array format, due today
    await evl(`localStorage.clear(); localStorage.setItem('baseline_quiz_missed', JSON.stringify([0, 2]))`);
    await nav();
    r = await evl(`(function(){
      const banner = document.querySelector('.qz-return')?.textContent || '';
      const flags = [...document.querySelectorAll('.qz .qz-flag')].map(f => f.closest('.qz').querySelector('.qz-n').textContent);
      // answer q0 correctly (it is due today) → stage 1, next in 3 days
      const el = [...document.querySelectorAll('.qz')][0];
      [...el.querySelectorAll('.qz-opt')].find(o => o.dataset.a === 'yes').click();
      const chip = el.querySelector('.qz-a .qz-flag')?.textContent || el.querySelector('.qz-a .qz-lock')?.textContent || '';
      const flagGone = !el.querySelector('.qz-q .qz-flag');
      const bannerMid = document.querySelector('.qz-return').textContent;
      // answer q2 (the other due one) correctly too → banner flips to "review done"
      const el2 = [...document.querySelectorAll('.qz')][2];
      [...el2.querySelectorAll('.qz-opt')].find(o => o.dataset.a === 'no').click();
      const bannerEnd = document.querySelector('.qz-return').textContent;
      const store = JSON.parse(localStorage.getItem('baseline_quiz_missed'));
      return { banner, flags, chip, store, flagGone, bannerMid, bannerEnd };
    })()`);
    r.banner.includes('2 questions are due') ? ok('spaced: v1 ints migrate → "2 questions are due" banner') : bad('spaced: banner = ' + r.banner);
    (r.flags.length === 2 && r.flags.join(',') === '1,3') ? ok('spaced: due flags on q1 and q3 only') : bad('spaced: flags on ' + r.flags.join(','));
    r.chip.includes('3 days') ? ok('spaced: right-when-due → "next review in 3 days" chip') : bad('spaced: chip = ' + r.chip);
    (r.store.find(x => x.i === 0)?.stage === 1) ? ok('spaced: stage advanced 0→1 in storage') : bad('spaced: store = ' + JSON.stringify(r.store));
    (r.flagGone && r.bannerMid.includes('due for review')) ? ok('spaced: answered question loses its due flag; banner stays while one remains') : bad(`spaced: flagGone=${r.flagGone} bannerMid=${r.bannerMid}`);
    r.bannerEnd.includes('Review done for today') ? ok('spaced: banner flips to "Review done" when the last due question is answered') : bad('spaced: bannerEnd = ' + r.bannerEnd);

    // lock-in: stage 2, due yesterday → right answer retires it
    r = await evl(`(function(){
      const d = new Date(); d.setDate(d.getDate() - 1);
      const y = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      localStorage.setItem('baseline_quiz_missed', JSON.stringify([{ i: 4, stage: 2, due: y }]));
      return true;
    })()`);
    await nav();
    r = await evl(`(function(){
      const banner = document.querySelector('.qz-return')?.textContent || '';
      const el = [...document.querySelectorAll('.qz')][4];
      [...el.querySelectorAll('.qz-opt')].find(o => o.dataset.a === 'no').click();
      const lock = el.querySelector('.qz-a .qz-lock')?.textContent || '';
      const store = JSON.parse(localStorage.getItem('baseline_quiz_missed'));
      return { banner, lock, store };
    })()`);
    r.banner.includes('One question is') ? ok('spaced: overdue entry still counts as due (banner)') : bad('spaced: overdue banner = ' + r.banner);
    r.lock.includes('locked in') ? ok('spaced: third spaced win → "locked in ✓" chip') : bad('spaced: lock chip = ' + r.lock);
    r.store.length === 0 ? ok('spaced: locked-in entry retired from storage') : bad('spaced: store after lock = ' + JSON.stringify(r.store));

    // early answer (not due yet) must NOT advance
    r = await evl(`(function(){
      const d = new Date(); d.setDate(d.getDate() + 3);
      const f = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      localStorage.setItem('baseline_quiz_missed', JSON.stringify([{ i: 4, stage: 1, due: f }]));
      return true;
    })()`);
    await nav();
    r = await evl(`(function(){
      const banner = !!document.querySelector('.qz-return');
      const el = [...document.querySelectorAll('.qz')][4];
      [...el.querySelectorAll('.qz-opt')].find(o => o.dataset.a === 'no').click();
      const chip = (el.querySelector('.qz-a .qz-flag') || el.querySelector('.qz-a .qz-lock'))?.textContent || '';
      const store = JSON.parse(localStorage.getItem('baseline_quiz_missed'));
      return { banner, chip, store };
    })()`);
    (!r.banner) ? ok('spaced: nothing due → no welcome-back banner') : bad('spaced: banner shown with nothing due');
    (r.chip === '' && r.store[0].stage === 1) ? ok('spaced: early correct answer does NOT advance the schedule') : bad(`spaced: early answer chip="${r.chip}" store=${JSON.stringify(r.store)}`);

    // wrong-when-tracked resets the clock
    r = await evl(`(function(){
      localStorage.setItem('baseline_quiz_missed', JSON.stringify([{ i: 4, stage: 2, due: '2020-01-01' }]));
      return true;
    })()`);
    await nav();
    r = await evl(`(function(){
      const el = [...document.querySelectorAll('.qz')][4];
      [...el.querySelectorAll('.qz-opt')].find(o => o.dataset.a === 'yes').click();   // WRONG (answer is no)
      const chip = el.querySelector('.qz-a .qz-flag')?.textContent || '';
      const store = JSON.parse(localStorage.getItem('baseline_quiz_missed'));
      const t = new Date(); t.setDate(t.getDate() + 1);
      const tom = t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0') + '-' + String(t.getDate()).padStart(2,'0');
      return { store, tom, chip };
    })()`);
    (r.store[0].stage === 0 && r.store[0].due === r.tom) ? ok('spaced: wrong answer resets to stage 0, due tomorrow') : bad('spaced: reset broken: ' + JSON.stringify(r.store));
    r.chip.includes('1 day') && !r.chip.includes('days') ? ok('spaced: wrong answer shows "next review in 1 day" (singular)') : bad('spaced: wrong-answer chip = ' + r.chip);

    /* ============ scenario C: transfer round-trip with a path chosen (cold-audit #1) ============ */
    await evl(`localStorage.clear()`);
    await nav();
    r = await evl(`(async function(){
      // choose a path + miss a question, export, wipe, import
      [...document.querySelectorAll('.path-chip')].find(c => c.dataset.path === 'tech').click();
      const el = [...document.querySelectorAll('.qz')][2];
      [...el.querySelectorAll('.qz-opt')].find(o => o.dataset.a === 'yes').click();   // wrong (answer is no)
      document.getElementById('pxToggle').click();
      const code = document.getElementById('pxCode').value;
      localStorage.clear();
      document.getElementById('pxIn').value = code;
      document.getElementById('pxApply').click();
      await new Promise(r => setTimeout(r, 100));   // note is sync; reload is on a 600ms timer
      return { note: document.getElementById('pxNote').textContent,
               path: localStorage.getItem('baseline_path'),
               missed: localStorage.getItem('baseline_quiz_missed') };
    })()`);
    r.note.includes('applied') ? ok('transfer: code with a chosen path imports cleanly (cold-audit #1 fixed)') : bad('transfer note: ' + r.note);
    (r.path === '"tech"' && r.missed && r.missed.includes('"i":2')) ? ok('transfer: path + v2 spaced entry both restored') : bad(`transfer restored path=${r.path} missed=${r.missed}`);

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
