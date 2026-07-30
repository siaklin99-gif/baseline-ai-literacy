#!/usr/bin/env node
/* Runtime test of the 2026-07-30 cold-audit batch: causal attention, reasoning-based
   spot-the-fake, path FILTERING (+ reversibility + reachability), Labs next, tally gating. */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9381;
const PAGE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };
const getJSON = (u) => new Promise((res, rej) => http.get(u, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));

async function main() {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--no-first-run', '--user-data-dir=/tmp/baseline-b2-' + PORT], { stdio: 'ignore' });
  let ws;
  try {
    let ver, t = 0;
    while (t++ < 50) { try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params, sid) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId: sid })); });
    const { result: tr } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: ar } = await send('Target.attachToTarget', { targetId: tr.targetId, flatten: true });
    const sid = ar.sessionId;
    await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
    await send('Network.enable', {}, sid);

    // record every outbound request so we can prove the tally never fires off hlur.ai
    const requests = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    });

    const nav = async (w, h, mobile) => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }, sid);
      await send('Page.navigate', { url: PAGE_URL }, sid);
      await sleep(1400);
    };
    const evl = async (expr) => {
      const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };

    await nav(390, 844, true);
    await evl(`localStorage.clear()`);
    await nav(390, 844, true);

    /* ---- causal attention ---- */
    let r = await evl(`(function(){
      const chips=[...document.querySelectorAll('#attnPlay .attn-w')];
      const out=[];
      for (let i=0;i<chips.length;i++){
        chips[i].click();
        const targets=[...document.querySelectorAll('#attnBars .attn-bar em')].map(e=>e.textContent);
        const sum=[...document.querySelectorAll('#attnBars .attn-bar b')].reduce((s,b)=>s+parseFloat(b.textContent),0);
        out.push({word:chips[i].textContent, i, targets, sum:+sum.toFixed(2)});
      }
      return out;
    })()`);
    const WORDS = r.map(x => x.word);
    const forward = r.filter(x => x.targets.some(t => WORDS.indexOf(t) > x.i));
    forward.length === 0
      ? ok(`attention: all 9 words attend only backwards (rendered, not just in source)`)
      : bad(`attention: ${forward.map(f => f.word + '→' + f.targets).join('; ')} point forward`);
    r.every(x => Math.abs(x.sum - 1) < 0.011) ? ok('attention: every rendered row sums to 1.00') : bad('attention: a row does not sum to 1.00: ' + JSON.stringify(r.map(x=>x.sum)));
    (r[0].targets.length === 1 && r[0].targets[0] === 'The')
      ? ok('attention: first word attends only to itself (teaches the causal constraint)')
      : bad('attention: first word shows ' + JSON.stringify(r[0].targets));
    (r[6].targets[0] === 'dog') ? ok('attention: the "it → dog" teaching example survives the rewrite') : bad('attention: "it" now points at ' + r[6].targets[0]);

    /* ---- spot the fake: solvable from the other two statements ---- */
    r = await evl(`(async function(){
      const out=[];
      for (let round=0; round<3; round++){
        const items=[...document.querySelectorAll('#sfBody .mg-opt, #sfBody button')];
        const fake=items.find(b=>b.dataset.fake==='1');
        const texts=items.map(b=>b.textContent.trim());
        if(!fake) return {err:'no fake found', texts};
        fake.click();
        const note=document.getElementById('sfNote').textContent;
        out.push({texts, fake:fake.textContent.trim().slice(0,60), note:note.slice(0,220)});
        const next=document.querySelector('#sfNote .mg-again, #sfBody .mg-again');
        if(next) next.click(); else { const b=[...document.querySelectorAll('button')].find(x=>/Next round|Play again/.test(x.textContent)); if(b) b.click(); }
        await new Promise(r=>setTimeout(r,120));
      }
      return out;
    })()`).catch(e => ({ err: e.message }));
    if (r && r.err) bad('spot-the-fake: ' + r.err);
    else if (Array.isArray(r) && r.length === 3) {
      const allThree = r.every(x => x.texts.length === 3);
      allThree ? ok('spot-the-fake: 3 rounds each render 3 statements') : bad('spot-the-fake: a round did not render 3 statements');
      const cites = r.filter(x => /other two|next to it|each other|arithmetic|contradic|rule|fenced|1\.8/i.test(x.note));
      cites.length === 3 ? ok('spot-the-fake: every explanation points back at the other statements') : bad(`spot-the-fake: only ${cites.length}/3 explanations are deducible`);
    } else bad('spot-the-fake: unexpected result ' + JSON.stringify(r).slice(0, 200));

    /* ---- path filtering: the actual W2 target ---- */
    const measure = async (label) => await evl(`(function(){
      return { words: document.body.innerText.split(/\\s+/).filter(x=>/[a-z]/i.test(x)).length,
               screens: +(document.scrollingElement.scrollHeight/844).toFixed(1),
               hidden: document.querySelectorAll('.path-off').length,
               status: (document.getElementById('pathStatus')||{}).textContent || '' };
    })()`);
    await nav(390, 844, true);
    await evl(`document.querySelectorAll('details').forEach(d=>d.open=true); void document.body.offsetHeight;`);
    const base = await measure('base');
    // picking a path must hide NOTHING; focusing is a second, explicit tap
    await evl(`[...document.querySelectorAll('.path-chip')].find(c=>c.dataset.path==='new').click(); void document.body.offsetHeight;`);
    const marked = await measure('marked');
    (marked.hidden === 0 && marked.status.includes('whole page is still here'))
      ? ok('path pick marks the route and hides nothing (shortening is opt-in)')
      : bad(`path pick hid ${marked.hidden} section(s) without being asked: ${marked.status}`);
    await evl(`document.getElementById('pathFocus').click(); void document.body.offsetHeight;`);
    const asNew = await measure('new');
    (asNew.words < base.words && asNew.hidden >= 2)
      ? ok(`focus "New to AI": ${base.words} → ${asNew.words} words, ${base.screens} → ${asNew.screens} screens, ${asNew.hidden} sections tucked away`)
      : bad(`path "New to AI" did not filter: ${JSON.stringify(asNew)}`);
    (asNew.words < 3000 && asNew.screens < 15)
      ? ok(`path "New to AI" meets the target (<3000 words, <15 screens)`)
      : bad(`path "New to AI" MISSES target: ${asNew.words} words / ${asNew.screens} screens (want <3000 / <15)`);
    asNew.status.includes('tucked away') ? ok('path status honestly reports what was hidden') : bad('path status text: ' + asNew.status);

    // reversible
    await evl(`document.getElementById('pathAll').click(); void document.body.offsetHeight;`);
    const restored = await measure('restored');
    (restored.hidden === 0 && restored.words >= base.words - 40)
      ? ok('"Show everything" restores the full page')
      : bad(`restore failed: ${JSON.stringify(restored)}`);

    await nav(390, 844, true);
    await evl(`document.querySelectorAll('details').forEach(d=>d.open=true); void document.body.offsetHeight;`);
    await evl(`[...document.querySelectorAll('.path-chip')].find(c=>c.dataset.path==='tech').click(); void document.body.offsetHeight;`);
    await evl(`document.getElementById('pathFocus').click(); void document.body.offsetHeight;`);
    const asTech = await measure('tech');
    (asTech.words < base.words && asTech.hidden >= 2)
      ? ok(`path "Techie": ${base.words} → ${asTech.words} words, ${asTech.screens} screens, ${asTech.hidden} sections tucked away`)
      : bad(`path "Techie" did not filter: ${JSON.stringify(asTech)}`);

    // a link INTO hidden content must reveal it.
    // clear the saved path first: a second click on an already-on chip is toggle-to-CLEAR
    await evl(`localStorage.removeItem('baseline_path')`);
    await nav(390, 844, true);
    r = await evl(`(function(){
      [...document.querySelectorAll('.path-chip')].find(c=>c.dataset.path==='tech').click();
      document.getElementById('pathFocus').click();
      const hiddenBefore = document.querySelectorAll('.path-off').length;
      const tryHidden = !!document.querySelector('#try.path-off');
      // the hero CTA points at #try, which the techie path hides
      const cta = document.querySelector('a[href="#try"]');
      if (cta) cta.click();
      return { hiddenBefore, tryHidden, hiddenAfter: document.querySelectorAll('.path-off').length };
    })()`);
    (r.tryHidden && r.hiddenAfter === 0)
      ? ok('a link into hidden content reveals it instead of scrolling to nothing')
      : bad(`reveal-on-link failed: ${JSON.stringify(r)}`);

    /* ---- cold-audit fixes: ring nav + deep link must beat filtering ---- */
    await evl(`localStorage.removeItem('baseline_path')`);
    await nav(390, 844, true);
    r = await evl(`(function(){
      [...document.querySelectorAll('.path-chip')].find(c=>c.dataset.path==='new').click();
      document.getElementById('pathFocus').click();
      const hidden = !!document.querySelector('#howllm.path-off');
      // the numbered ring node for step 6 ("Peek under the hood") is NOT a link
      const node = document.querySelectorAll('.lc-node')[5] || document.querySelectorAll('[class*=lc-node]')[5];
      if (node) node.dispatchEvent(new MouseEvent('click', {bubbles:true}));
      return { hidden, stillHidden: !!document.querySelector('#howllm.path-off'), hadNode: !!node };
    })()`);
    (r.hidden && r.hadNode && !r.stillHidden)
      ? ok('ring-node tap on an off-path step reveals it (was silently dead)')
      : bad(`ring nav reveal: ${JSON.stringify(r)}`);

    // deep link must survive a saved path
    await evl(`localStorage.setItem('baseline_path', JSON.stringify('new'))`);
    await send('Page.navigate', { url: 'about:blank' }, sid); await sleep(250);
    await send('Page.navigate', { url: PAGE_URL + '#howllm' }, sid); await sleep(1600);
    r = await evl(`(function(){
      const f=document.getElementById('pathFocus'); if(f) f.click();
      const el=document.getElementById('howllm');
      return { hidden: !!el.closest('.path-off'), display: getComputedStyle(el).display,
               otherStillHidden: document.querySelectorAll('.path-off').length };
    })()`);
    // otherStillHidden > 0 proves the path DID apply — otherwise this check passes vacuously
    (!r.hidden && r.display !== 'none' && r.otherStillHidden > 0)
      ? ok(`deep link #howllm survives a saved path, and the path still applied (${r.otherStillHidden} other sections filtered)`)
      : bad(`deep link guard not proven: ${JSON.stringify(r)} (otherStillHidden must be >0 or the path never applied)`);
    await evl(`localStorage.removeItem('baseline_path')`);
    await nav(390, 844, true);

    /* ---- Labs next ---- */
    r = await evl(`(function(){
      const n=document.querySelector('.lab-next');
      return { present: !!n, text: n ? n.textContent.replace(/\\s+/g,' ').trim().slice(0,140) : '',
               mail: !!document.querySelector('.lab-next a[href^="mailto:"]'),
               undated: document.body.innerText.includes('More labs land here') };
    })()`);
    // Lab 002 SHIPPED, so the next-block no longer names it. What must stay true is the
    // substance: reachable without an account, and no undated promise of a specific lab.
    (r.present && r.mail && !r.undated && /No schedule promised/.test(r.text))
      ? ok('Labs: reachable by email, and promises no cadence it might not keep')
      : bad('Labs next block: ' + JSON.stringify(r));

    /* ---- Lab 002: triage exercise ---- */
    await evl(`localStorage.clear()`);
    await nav(390, 844, true);
    r = await evl(`(function(){
      const cards=[...document.querySelectorAll('#triage .tri-c')];
      if(cards.length!==5) return {err:'expected 5 claims, got '+cards.length};
      // flag the two that matter (indexes 1 and 2) and nothing else
      cards[1].click(); cards[2].click();
      const pressed=cards.filter(c=>c.getAttribute('aria-pressed')==='true').length;
      document.getElementById('triGo').click();
      const out=document.getElementById('triOut').textContent;
      const hits=document.querySelectorAll('#triage .tri-c.hit').length;
      const musts=document.querySelectorAll('#triage .tri-c.must').length;
      const safes=document.querySelectorAll('#triage .tri-c.safe').length;
      const everyTagged=cards.every(c=>c.querySelector('.tri-tag'));
      // clicking again after scoring must not change anything
      cards[0].click();
      const afterLock=document.querySelectorAll('#triage .tri-c.on').length;
      document.getElementById('triAgain').click();
      const reset=document.querySelectorAll('#triage .tri-tag').length;
      return {pressed,out:out.slice(0,60),hits,musts,safes,everyTagged,afterLock,reset,
              goHidden:document.getElementById('triGo').hidden};
    })()`);
    if (r.err) bad('lab002: ' + r.err);
    else {
      (r.pressed === 2 && r.hits === 2 && r.musts === 2 && r.safes === 3)
        ? ok('lab002: 5 claims, 2 must-check / 3 safe, both caught scored correctly')
        : bad(`lab002: pressed=${r.pressed} hits=${r.hits} musts=${r.musts} safes=${r.safes}`);
      r.out.includes('Exactly right') ? ok('lab002: perfect triage gets the "exactly right" verdict') : bad('lab002 verdict: ' + r.out);
      r.everyTagged ? ok('lab002: every claim explains itself after scoring') : bad('lab002: a claim had no explanation');
      r.afterLock === 0 ? ok('lab002: claims lock after scoring (no re-answering)') : bad('lab002: still editable after scoring');
      (r.reset === 0 && !r.goHidden) ? ok('lab002: reset restores a clean, replayable state') : bad(`lab002 reset: tags=${r.reset} goHidden=${r.goHidden}`);
    }

    /* ---- tally must be inert off hlur.ai ---- */
    const tallyCalls = requests.filter(u => u.includes('/tally'));
    tallyCalls.length === 0
      ? ok('tally sent 0 requests from a non-hlur.ai origin (mirror + local stay silent)')
      : bad(`tally fired ${tallyCalls.length} request(s) off-host: ${tallyCalls.slice(0,2)}`);
    r = await evl(`(function(){ try { tally('load'); tally('evil'); return 'no-throw'; } catch(e){ return 'threw: '+e.message; } })()`);
    r === 'no-throw' ? ok('tally() never throws, even on a rejected event name') : bad('tally(): ' + r);

    /* ---- honesty surfaces ---- */
    let r2; r = await evl(`(function(){
      const pills=[...document.querySelectorAll('.trust-pill')].map(p=>p.textContent);
      return { pills, numbers: !!document.getElementById('numbers'),
               mailto: !!document.querySelector('footer a[href^="mailto:hello@hlur.ai"]') };
    })()`);
    r2 = await evl(`(function(){
      const t=document.getElementById('numbers').textContent;
      // substance, not wording: every event actually sent must be named
      const named = ['loads','quiz finishes','lab copies','start-path picks'].filter(x => t.includes(x));
      return { four: /Four things, nothing else/.test(t) && named.length === 4, stored: /nothing stored that could point back/.test(t),
               rough: /rough signal, not a proof/.test(t) };
    })()`);
    (r2.four && r2.stored && r2.rough)
      ? ok('disclosure is accurate: names all four events, scopes the privacy claim, admits forgeability')
      : bad('disclosure still overstates: ' + JSON.stringify(r2));
    (!r.pills.includes('Nothing tracked') && r.pills.some(p => /No cookies/.test(p)))
      ? ok('trust pills: claim narrowed to what is still true (' + r.pills.join(' · ') + ')')
      : bad('trust pills wrong: ' + JSON.stringify(r.pills));
    (r.numbers && r.mailto) ? ok('counting disclosed + feedback reachable without a GitHub account') : bad('disclosure/feedback: ' + JSON.stringify(r));

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
