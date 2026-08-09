/* ============================================================
   Baseline — the mobile swipe decks, measured in a real browser.
   Run:  node test/mobiledeck.runtime.js

   The doorway and the self-test were the two longest blocks on a phone (1517px and
   1046px at 390x844, against a whole page of 8.89 screens). On mobile they now move
   SIDEWAYS: native CSS scroll-snap, the next card peeking at the edge, progress dots
   below — the same deck mechanism Can/Can't and Topics already use.

   What must stay true:
     · they really scroll horizontally, and really snap
     · the next card PEEKS — that overhang is the only thing that says "swipe me"
     · the dots match the cards and follow the swipe, both directions
     · the running score is NOT inside the deck (as a child it becomes card 1)
     · a full-bleed deck (negative margins) must not make the PAGE scroll sideways
     · desktop keeps its grid: all five doors visible at once, no deck, no dots
   ============================================================ */
const { spawn } = require('child_process'); const http = require('http');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', PORT=9497;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=u=>new Promise((res,rej)=>http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej));
let fails=0,checks=0;
const ok=m=>{checks++;console.log('  \x1b[32m✓\x1b[0m '+m)};
const bad=m=>{checks++;fails++;console.log('  \x1b[31m✗ '+m+'\x1b[0m')};
(async()=>{
  const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port='+PORT,'--no-first-run','--hide-scrollbars','--user-data-dir=/tmp/md-'+PORT],{stdio:'ignore'});
  let ver,t=0; while(t++<50){try{ver=await getJSON(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await sleep(200);}}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  let id=0; const pend=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
  const send=(m,p,s)=>new Promise(r=>{pend.set(++id,r);ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId); await send('Runtime.enable',{},sessionId);
  const URL='file://'+require('path').join(__dirname,'..','index.html');
  const nav=async(w=390,h=844)=>{
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<760},sessionId);
    await send('Page.navigate',{url:URL},sessionId); await sleep(1800);};
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sessionId);
    if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300)); return r.result.value;};

  console.log('\nBaseline mobile swipe decks\n----------------------------');

  /* ---- 1. both decks scroll sideways and snap ---- */
  await nav();
  let r=await ev(`(function(){
    const out={};
    for (const [k,sel] of [['doors','#deepGrid'],['quiz','.qz-deck']]) {
      const d=document.querySelector(sel), cs=getComputedStyle(d);
      out[k]={cards:d.children.length, disp:cs.display, snap:cs.scrollSnapType,
              scrollable:d.scrollWidth-d.clientWidth};
    }
    out.screens=+(document.scrollingElement.scrollHeight/844).toFixed(2);
    return out;})()`);
  (r.doors.cards===5 && r.quiz.cards===9 &&
   r.doors.disp==='flex' && r.quiz.disp==='flex' &&
   /mandatory/.test(r.doors.snap) && /mandatory/.test(r.quiz.snap) &&
   r.doors.scrollable>100 && r.quiz.scrollable>100)
    ? ok(`both decks swipe: 5 doors and 9 questions in flex rows with mandatory snap (page is ${r.screens} screens, was 8.89)`)
    : bad('decks: '+JSON.stringify(r));

  /* ---- 2. the next card PEEKS — without the overhang nobody knows to swipe ---- */
  r=await ev(`(function(){
    const out={};
    for (const [k,sel] of [['doors','#deepGrid'],['quiz','.qz-deck']]) {
      const d=document.querySelector(sel);
      const first=d.children[0].getBoundingClientRect(), second=d.children[1].getBoundingClientRect();
      out[k]={pct:Math.round(first.width/innerWidth*100),
              nextVisible: second.left < innerWidth - 8};
    }
    return out;})()`);
  (r.doors.pct>=70 && r.doors.pct<=90 && r.doors.nextVisible &&
   r.quiz.pct>=70 && r.quiz.pct<=90 && r.quiz.nextVisible)
    ? ok(`cards are ${r.doors.pct}% / ${r.quiz.pct}% of the viewport and the next one is on screen — the swipe is discoverable`)
    : bad('peek: '+JSON.stringify(r));

  /* ---- 3. dots match the cards and follow the swipe, BOTH directions ---- */
  r=await ev(`(async function(){
    const d=document.querySelector('.qz-deck');
    const dots=d.nextElementSibling;
    const at=()=>[...dots.children].findIndex(x=>x.classList.contains('on'));
    const start=at();
    d.scrollLeft=d.scrollWidth*0.45; await new Promise(r=>setTimeout(r,300));
    const fwd=at();
    d.scrollLeft=0; await new Promise(r=>setTimeout(r,300));
    const back=at();
    return {isDots:dots.className, n:dots.children.length, start, fwd, back};})()`);
  (r.isDots==='dots' && r.n===9 && r.start===0 && r.fwd>2 && r.back===0)
    ? ok(`9 dots for 9 questions, tracking both ways (0 → ${r.fwd} → 0): left-to-right and right-to-left`)
    : bad('dots: '+JSON.stringify(r));

  /* ---- 4. the running score must not be a card ---- */
  r=await ev(`(function(){
    const deck=document.querySelector('.qz-deck');
    const score=document.getElementById('qzScore');
    return {insideDeck: deck.contains(score), firstCard: deck.children[0].className,
            scoreVisible: score.getBoundingClientRect().height>0,
            text: score.textContent.trim()};})()`);
  (!r.insideDeck && /qz/.test(r.firstCard) && r.scoreVisible)
    ? ok(`"${r.text}" stays outside the deck — the first card is a question, not the score`)
    : bad('score placement: '+JSON.stringify(r));

  /* ---- 5. the quiz still WORKS inside the deck ---- */
  r=await ev(`(function(){
    const card=document.querySelector('.qz-deck .qz');
    card.querySelector('.qz-opt').click();
    return {done:card.classList.contains('done'),
            score:document.getElementById('qzScore').textContent.trim(),
            answerShown:getComputedStyle(card.querySelector('.qz-a')).display!=='none'};})()`);
  (r.done && /1 of 9/.test(r.score) && r.answerShown)
    ? ok('answering inside the deck still scores and reveals the explanation ("'+r.score+'")')
    : bad('quiz in deck: '+JSON.stringify(r));

  /* ---- 6. FULL-BLEED MUST NOT LEAK. The decks use negative margins to reach the
           screen edges; if that escapes its container the whole PAGE scrolls sideways,
           which on a phone reads as the site being broken. scrollWidth-clientWidth on
           the scrolling element is the authoritative signal. ---- */
  r=await ev(`(function(){
    const d=document.scrollingElement;
    return {overflow:d.scrollWidth-d.clientWidth};})()`);
  (r.overflow<=0)
    ? ok('no horizontal overflow on the page itself — the full-bleed decks stay inside their container')
    : bad(`the page scrolls sideways by ${r.overflow}px — a full-bleed deck escaped`);

  /* ---- 7. THE CIRCLE IS A DIAL: swipe turns the ring, tapping the ring turns the swipe ---- */
  await nav();
  r=await ev(`(async function(){
    const list=document.getElementById('lcList'), nodes=document.getElementById('lcNodes');
    const cur=()=>[...nodes.children].findIndex(n=>n.classList.contains('cur'));
    const cs=getComputedStyle(list);
    const start=cur();
    // swipe the steps -> the ring should follow
    list.scrollLeft=list.scrollWidth*0.42; await new Promise(r=>setTimeout(r,320));
    const afterSwipe=cur();
    // tap a ring number -> the steps should move to it, and NOT leave the section
    const y0=scrollY;
    nodes.children[6].dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,600));
    return {deck:cs.display, snap:cs.scrollSnapType, steps:list.children.length,
            start, afterSwipe, afterTap:cur(),
            movedTo:Math.round(list.scrollLeft), atEnd:list.scrollLeft>list.scrollWidth-list.clientWidth-40,
            stayedPut: Math.abs(scrollY-y0) < 400,
            dots: list.nextElementSibling && list.nextElementSibling.className==='dots'};})()`);
  (r.deck==='flex' && r.steps===7 && r.start===0 && r.afterSwipe>1 && r.afterTap===6 && r.atEnd && r.stayedPut && !r.dots)
    ? ok(`the ring is a dial: swiping the 7 steps turned it 0 → ${r.afterSwipe}, tapping step 7 turned the deck to the end without leaving the section (no dots — the ring is the indicator)`)
    : bad('circle dial: '+JSON.stringify(r));

  /* ---- 8. the clip strip swipes instead of stacking 4 videos vertically ---- */
  // #share is a layer-2 section: display:none until its door is opened, so it has no
  // dimensions to measure until then. Measuring it closed reported 0 and looked like a
  // broken deck — the harness has to open the door the way a reader does.
  r=await ev(`(async function(){
    document.querySelector('[data-deep-open="share"]').click();
    await new Promise(r=>setTimeout(r,350));
    const d=document.querySelector('.clip-deck'), cs=getComputedStyle(d);
    return {disp:cs.display, snap:cs.scrollSnapType, clips:d.children.length,
            scrollable:d.scrollWidth-d.clientWidth,
            h:Math.round(d.getBoundingClientRect().height)};})()`);
  (r.disp==='flex' && /mandatory/.test(r.snap) && r.clips===4 && r.scrollable>100)
    ? ok(`the 4 clips swipe as one ${r.h}px row instead of stacking (was 1327px inside Pass it on)`)
    : bad('clip deck: '+JSON.stringify(r));

  /* ---- 9. DESKTOP KEEPS ITS GRID ---- */
  await nav(1440,900);
  r=await ev(`(function(){
    const g=document.getElementById('deepGrid'), q=document.querySelector('.qz-deck');
    const dots=[...document.querySelectorAll('.dots')].filter(d=>getComputedStyle(d).display!=='none').length;
    const doorsOnScreen=[...g.children].filter(c=>c.getBoundingClientRect().width>100).length;
    return {gridDisp:getComputedStyle(g).display, quizDisp:getComputedStyle(q).display,
            sideways:g.scrollWidth-g.clientWidth, dots, doorsOnScreen,
            pageOverflow:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth};})()`);
  (r.gridDisp==='grid' && r.sideways<=0 && r.dots===0 && r.doorsOnScreen===5 && r.pageOverflow<=0)
    ? ok('desktop unchanged: the doorway is still a grid with all 5 doors visible, no deck, no dots')
    : bad('desktop leaked the mobile deck: '+JSON.stringify(r));

  /* ---- the stack walkthrough: it must step, draw, and end on the honest note ---- */
  await nav();
  r=await ev(`(async function(){
    document.querySelector('[data-deep-open="bodysec"]').click();
    await new Promise(r=>setTimeout(r,250));
    const chips=[...document.querySelectorAll('.stk-chip')];
    const card=document.getElementById('stkCard');
    const first=card.querySelector('h4').textContent;
    // walk to the last piece the way a reader does — by pressing Next
    for (let i=0;i<4;i++){ card.querySelector('.stk-next').click(); await new Promise(r=>setTimeout(r,90)); }
    const last=card.querySelector('h4').textContent;
    const sel=chips.findIndex(c=>c.getAttribute('aria-selected')==='true');
    const chipR=chips[sel].getBoundingClientRect(), railR=document.getElementById('stkRail').getBoundingClientRect();
    // the agent must be drawn as a bracket around the tools, and lit at step 5
    const loop=document.querySelector('.stk-loop');
    const nodes=[...document.querySelectorAll('.stk-node')].length;
    // finish: the reply and the caveat only appear after the last press
    const outBefore=document.getElementById('stkOut').textContent;
    card.querySelector('.stk-next').click(); await new Promise(r=>setTimeout(r,90));
    return {first,last,sel,nodes,
      loopLit: loop.classList.contains('on'),
      chipInView: chipR.left>=railR.left-1 && chipR.right<=railR.right+1,
      outBefore: outBefore.slice(0,20),
      outAfter: document.getElementById('stkOut').textContent.slice(0,20),
      honest: document.getElementById('stkHonest').textContent.length};})()`);
  (r.first==='LLM' && r.last==='Agent' && r.sel===4 && r.nodes===4 && r.loopLit &&
   r.chipInView && /Step through/.test(r.outBefore) && /Sorry about that/.test(r.outAfter) && r.honest>80)
    ? ok(`the walkthrough steps LLM → Agent, lights the agent LOOP around ${r.nodes} tool rows, keeps the active chip in view, and only reveals the reply + the "it can be wrong" note at the end`)
    : bad('stack walkthrough: '+JSON.stringify(r));

  /* ---- the mind map: same five, one picture, and it must agree with the flow ---- */
  await nav();
  r=await ev(`(async function(){
    document.querySelector('[data-deep-open="bodysec"]').click();
    await new Promise(r=>setTimeout(r,220));
    const step=document.getElementById('stkViewStep'), mapBtn=document.getElementById('stkViewMap');
    const map=document.getElementById('stkMap'), rail=document.getElementById('stkRail');
    const card=document.getElementById('stkCard'), flow=document.querySelector('.stk-flow');
    const before={map:map.hidden, rail:rail.hidden};
    mapBtn.click(); await new Promise(r=>setTimeout(r,120));
    const names=[...map.querySelectorAll('.mp-head b')].map(b=>b.textContent);
    const roles=[...map.querySelectorAll('.mp-head i')].map(b=>b.textContent);
    const jobs=[...map.querySelectorAll('.mp-b')].map(b=>b.querySelectorAll('.mp-jobs li').length);
    const driver=map.querySelector('.mp-b.is-driver');
    const drivesTxt=(map.querySelector('.mp-drives')||{}).textContent||'';
    const out=document.querySelector('.stk-out');
    const afterMap={map:map.hidden, rail:rail.hidden, card:card.hidden, flow:flow.hidden, out:out.hidden};
    step.click(); await new Promise(r=>setTimeout(r,120));
    const back={map:map.hidden, rail:rail.hidden, card:card.hidden};
    return {before, names, roles, jobs, afterMap, back,
      driverIsAgent: !!driver && driver.querySelector('b').textContent==='Agent',
      drivesTxt, saysAbove:/\babove\b/.test(drivesTxt),
      pressed: mapBtn.getAttribute('aria-pressed')};})()`);
  (r.before.map===true && r.names.join(',')==='LLM,RAG,MCP,API,Agent' &&
   r.jobs.every(n=>n===3) && r.driverIsAgent && !r.saysAbove &&
   r.afterMap.map===false && r.afterMap.rail===true && r.afterMap.card===true && r.afterMap.flow===true && r.afterMap.out===true &&
   r.back.map===true && r.back.rail===false)
    ? ok(`the map shows all five at once (${r.jobs.reduce((a,b)=>a+b,0)} jobs), marks the Agent as the driver — "${r.drivesTxt.slice(0,44)}…" — and swapping views hides the stepper cleanly both ways`)
    : bad('mind map: '+JSON.stringify(r));

  console.log('----------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  try{ws.close();}catch{} chrome.kill('SIGKILL');
  process.exit(fails?1:0);
})();
