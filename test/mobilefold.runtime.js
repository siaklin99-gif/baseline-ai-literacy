/* ============================================================
   Baseline — the mobile fold, measured in a real browser.
   Run:  node test/mobilefold.runtime.js

   Mobile ran 8.9 screens against desktop's 6.2, because it has no rail and every
   desktop row becomes a stacked column. The two longest blocks are also the two
   OPTIONAL ones — the doorway and the self-test — so on a phone they start folded.

   What must stay true, and what each check is really defending:
     · the fold is MOBILE ONLY — desktop must not gain a toggle or lose content
     · the markup ships OPEN and JS closes it, so no-JS readers and crawlers keep
       the whole page (folding by default in the HTML would hide it from both)
     · folded ≠ removed — the nodes stay in the DOM and every #anchor resolves
     · anything navigating INTO a folded section unfolds it first, or the link
       scrolls to a display:none element and reads as broken
     · crossing the breakpoint (rotate a phone, resize a tablet) must never leave
       content hidden on a layout that has no toggle to bring it back
   ============================================================ */
const { spawn } = require('child_process'); const http = require('http');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', PORT=9497;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=u=>new Promise((res,rej)=>http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej));
let fails=0,checks=0;
const ok=m=>{checks++;console.log('  \x1b[32m✓\x1b[0m '+m)};
const bad=m=>{checks++;fails++;console.log('  \x1b[31m✗ '+m+'\x1b[0m')};
(async()=>{
  const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port='+PORT,'--no-first-run','--hide-scrollbars','--user-data-dir=/tmp/mf-'+PORT],{stdio:'ignore'});
  let ver,t=0; while(t++<50){try{ver=await getJSON(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await sleep(200);}}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  let id=0; const pend=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
  const send=(m,p,s)=>new Promise(r=>{pend.set(++id,r);ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId); await send('Runtime.enable',{},sessionId);
  const URL='file://'+require('path').join(__dirname,'..','index.html');
  const nav=async(w=390,h=844,u=URL)=>{
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<760},sessionId);
    await send('Page.navigate',{url:u},sessionId); await sleep(1700);};
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sessionId);
    if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300)); return r.result.value;};

  console.log('\nBaseline mobile fold\n----------------------------');

  /* ---- 1. mobile: folded, and materially shorter ---- */
  await nav(390,844);
  let r=await ev(`(function(){
    const secs=[...document.querySelectorAll('section[data-mcol]')];
    return {n:secs.length,
      closed:secs.filter(s=>s.dataset.mcol==='closed').length,
      bodiesHidden:secs.every(s=>getComputedStyle(s.querySelector('.mcol-body')).display==='none'),
      togglesVisible:secs.every(s=>getComputedStyle(s.querySelector('.mcol-toggle')).display!=='none'),
      inDom:secs.every(s=>!!s.querySelector('.mcol-body')),
      screens:+(document.scrollingElement.scrollHeight/844).toFixed(2)};})()`);
  (r.n===2 && r.closed===2 && r.bodiesHidden && r.togglesVisible && r.inDom && r.screens < 7.5)
    ? ok(`mobile is ${r.screens} screens (was 8.89); both optional sections folded, both bodies still in the DOM`)
    : bad('mobile fold: '+JSON.stringify(r));

  /* ---- 2. tapping the toggle actually reveals the content ---- */
  r=await ev(`(function(){
    const sec=document.getElementById('quizsec');
    sec.querySelector('.mcol-toggle').click();
    const body=sec.querySelector('.mcol-body');
    const qs=body.querySelectorAll('.qz-q, [class*="qz"]').length;
    return {state:sec.dataset.mcol, disp:getComputedStyle(body).display,
      h:Math.round(body.getBoundingClientRect().height), qs,
      expanded:sec.querySelector('.mcol-toggle').getAttribute('aria-expanded'),
      hiddenReveals:[...sec.querySelectorAll('.reveal')].filter(x=>!x.classList.contains('in')).length};})()`);
  (r.state==='open' && r.disp!=='none' && r.h>200 && r.expanded==='true' && r.hiddenReveals===0)
    ? ok(`tapping unfolds the self-test: ${r.h}px of questions, aria-expanded=true, no .reveal left invisible`)
    : bad('unfold: '+JSON.stringify(r));

  /* ---- 3. it folds again (a toggle that only opens is a one-way door) ---- */
  r=await ev(`(function(){const sec=document.getElementById('quizsec');
    sec.querySelector('.mcol-toggle').click();
    return {state:sec.dataset.mcol, disp:getComputedStyle(sec.querySelector('.mcol-body')).display,
      expanded:sec.querySelector('.mcol-toggle').getAttribute('aria-expanded')};})()`);
  (r.state==='closed' && r.disp==='none' && r.expanded==='false')
    ? ok('tapping again folds it back — the control is two-way')
    : bad('refold: '+JSON.stringify(r));

  /* ---- 4. the doorway still WORKS while folded: unfold, then open a door ---- */
  r=await ev(`(async function(){
    const sec=document.getElementById('deeper');
    sec.querySelector('.mcol-toggle').click();
    await new Promise(r=>setTimeout(r,120));
    const doors=document.querySelectorAll('.deep-card').length;
    document.querySelector('[data-deep-open="labs"]').click();
    await new Promise(r=>setTimeout(r,200));
    const open=document.querySelector('.deep.open');
    return {doors, opened:open?open.id:null};})()`);
  (r.doors===5 && r.opened==='labs')
    ? ok('unfolding the doorway leaves all 5 doors working — layer 2 still opens')
    : bad('doorway after unfold: '+JSON.stringify(r));

  /* ---- 5. a link INTO a folded section unfolds it (not a dead scroll) ---- */
  await nav(390,844);
  r=await ev(`(async function(){
    const before=document.getElementById('quizsec').dataset.mcol;
    const a=document.createElement('a'); a.href='#quiz'; a.textContent='go';
    document.body.appendChild(a); a.click();
    await new Promise(r=>setTimeout(r,300));
    const sec=document.getElementById('quizsec');
    return {before, after:sec.dataset.mcol,
      visible:getComputedStyle(sec.querySelector('.mcol-body')).display!=='none'};})()`);
  (r.before==='closed' && r.after==='open' && r.visible)
    ? ok('a link pointing inside a folded section unfolds it instead of scrolling to nothing')
    : bad('link into fold: '+JSON.stringify(r));

  /* ---- 6. DESKTOP IS UNTOUCHED — the whole point of "mobile only" ---- */
  await nav(1440,900);
  r=await ev(`(function(){
    const secs=[...document.querySelectorAll('section[data-mcol]')];
    return {toggles:secs.filter(s=>getComputedStyle(s.querySelector('.mcol-toggle')).display!=='none').length,
      hiddenBodies:secs.filter(s=>getComputedStyle(s.querySelector('.mcol-body')).display==='none').length,
      doors:document.querySelectorAll('.deep-card').length,
      screens:+(document.scrollingElement.scrollHeight/900).toFixed(1)};})()`);
  (r.toggles===0 && r.hiddenBodies===0 && r.doors===5)
    ? ok(`desktop unchanged at ${r.screens} screens: no toggle rendered, nothing folded, 5 doors visible`)
    : bad('desktop leaked the mobile fold: '+JSON.stringify(r));

  /* ---- 7. crossing the breakpoint must not strand hidden content ---- */
  await nav(390,844);
  r=await ev(`(function(){return document.getElementById('deeper').dataset.mcol;})()`);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},sessionId);
  await sleep(400);
  const after=await ev(`(function(){
    const secs=[...document.querySelectorAll('section[data-mcol]')];
    return {hidden:secs.filter(s=>getComputedStyle(s.querySelector('.mcol-body')).display==='none').length,
      toggles:secs.filter(s=>getComputedStyle(s.querySelector('.mcol-toggle')).display!=='none').length};})()`);
  (r==='closed' && after.hidden===0 && after.toggles===0)
    ? ok('resizing a folded phone up to desktop restores every section (no content stranded behind a toggle that no longer exists)')
    : bad('breakpoint cross: folded='+r+' after='+JSON.stringify(after));

  /* ---- 8. no-JS / crawler: the markup itself must ship OPEN ---- */
  const fs=require('fs');
  const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  // Match the SECTION TAG, not the stylesheet. The first version of this check tested the
  // whole file for data-mcol="closed" and hit the CSS selector `section[data-mcol="closed"]
  // .mcol-body`, reporting that the page shipped folded when it does not. A guard's own
  // false red costs as much trust as a miss — check the markup, which is the claim.
  const closedInSource=/<section[^>]*\sdata-mcol=["']closed["']/.test(html);
  const bodies=(html.match(/class="mcol-body"/g)||[]).length;
  (!closedInSource && bodies===2)
    ? ok('the HTML ships unfolded — a reader with no JS, and every crawler, still gets both sections')
    : bad(`source ships folded (closed=${closedInSource}, bodies=${bodies}) — no-JS readers would lose content`);

  console.log('----------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  try{ws.close();}catch{} chrome.kill('SIGKILL');
  process.exit(fails?1:0);
})();
