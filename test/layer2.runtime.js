const { spawn } = require('child_process'); const http=require('http');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', PORT=9490;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=u=>new Promise((res,rej)=>http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej));
let fails=0,checks=0;
const ok=m=>{checks++;console.log('  \x1b[32m✓\x1b[0m '+m)};
const bad=m=>{checks++;fails++;console.log('  \x1b[31m✗ '+m+'\x1b[0m')};
(async()=>{
  const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port='+PORT,'--no-first-run','--hide-scrollbars','--user-data-dir=/tmp/dc-'+PORT],{stdio:'ignore'});
  let ver,t=0; while(t++<50){try{ver=await getJSON(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await sleep(200);}}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  let id=0; const pend=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
  const send=(m,p,s)=>new Promise(r=>{pend.set(++id,r);ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId); await send('Runtime.enable',{},sessionId);
  const URL='file://'+require('path').join(__dirname,'..','index.html');
  const nav=async(u=URL,w=1440)=>{await send('Emulation.setDeviceMetricsOverride',{width:w,height:900,deviceScaleFactor:1,mobile:w<500},sessionId);
    await send('Page.navigate',{url:u},sessionId); await sleep(1600);};
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sessionId);
    // history.back() destroys the execution context, so `r` itself can come back
    // undefined. Returning null beats taking the whole file down with a TypeError that
    // names nothing about what was being tested.
    if(!r) return null;
    if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200));
    return r.result ? r.result.value : null;};

  await nav();
  let r=await ev(`(function(){return {screens:+(document.scrollingElement.scrollHeight/900).toFixed(1),
    deepHidden:[...document.querySelectorAll('.deep')].every(d=>getComputedStyle(d).display==='none'),
    doors:document.querySelectorAll('.deep-card').length,art:document.querySelectorAll('.deep-card .deep-art').length};})()`);
  (r.deepHidden && r.doors===5 && r.art===5) ? ok(`layer 1 is ${r.screens} screens; all 5 deep sections hidden, 5 doors each with artwork`)
    : bad(`layer1: ${JSON.stringify(r)}`);

  // open via a door
  r=await ev(`(function(){document.querySelector('[data-deep-open="howllm"]').click();
    const s=document.getElementById('howllm');
    return {open:s.classList.contains('open'),disp:getComputedStyle(s).display,
      htmlAttr:document.documentElement.dataset.deep,closeShown:!document.getElementById('deepClose').hidden,
      bodyLocked:getComputedStyle(document.documentElement).overflow,hash:location.hash};})()`);
  (r.open&&r.disp==='block'&&r.htmlAttr==='howllm'&&r.closeShown&&r.bodyLocked==='hidden'&&r.hash==='#howllm')
    ? ok('door opens the layer, locks the page behind, and puts it in the URL') : bad('open: '+JSON.stringify(r));

  // Esc closes
  r=await ev(`(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    return {stillOpen:!!document.querySelector('.deep.open'),attr:document.documentElement.dataset.deep||null};})()`);
  (!r.stillOpen) ? ok('Escape closes the layer') : bad('Escape did not close: '+JSON.stringify(r));

  /* CLOSING MUST ALSO UNDO EVERYTHING OPENING DID. A cold audit deleted the unlock lines
     from deepClose and all 181 static + 7 runtime + 17 layout checks still passed, while
     the real page was left permanently unscrollable with a floating "✕ Close" over
     nothing. The state was being READ into this test and then never asserted. */
  r=await ev(`(function(){return {
      attr: document.documentElement.dataset.deep||null,
      overflow: getComputedStyle(document.documentElement).overflow,
      closeHidden: document.getElementById('deepClose').hidden,
      inertLeft: [...document.body.children].filter(el=>el.inert).length,
      openLeft: document.querySelectorAll('.deep.open').length};})()`);
  (r.attr===null && r.overflow!=='hidden' && r.closeHidden && r.inertLeft===0 && r.openLeft===0)
    ? ok('closing restores the page: scroll unlocked, close button gone, background reachable again')
    : bad('close left state behind: '+JSON.stringify(r));

  /* The background must be unreachable while a layer is open — not merely invisible.
     Tab from the close button used to walk into the footer, putting the focus ring on
     content 5000px away that the locked page could not scroll to. */
  r=await ev(`(function(){document.querySelector('[data-deep-open="topics"]').click();
    const sec=document.getElementById('topics');
    const inert=[...document.body.children].filter(el=>el.inert).map(el=>el.id||el.tagName);
    const reachable=[...document.body.children].filter(el=>!el.inert).map(el=>el.id||el.tagName);
    const r={inertCount:inert.length, reachable, role:sec.getAttribute('role'),
             modal:sec.getAttribute('aria-modal')};
    document.getElementById('deepClose').click(); return r;})()`);
  (r.inertCount>0 && r.role==='dialog' && r.modal==='true' &&
   r.reachable.every(x=>x==='topics'||x==='deepClose'||x==='SCRIPT'||x==='NOSCRIPT'))
    ? ok(`an open layer is a real dialog: ${r.inertCount} background block(s) inert, only the layer and its close button reachable`)
    : bad('background still reachable: '+JSON.stringify(r));

  /* Back must LEAVE, not re-open. deepClose used to push a second entry, so Back replayed
     the door the reader had just dismissed and three doors cost six presses to escape. */
  r=await ev(`(async function(){
    const before=history.length;
    document.querySelector('[data-deep-open="labs"]').click();
    await new Promise(r=>setTimeout(r,120));
    const opened=location.hash;
    document.getElementById('deepClose').click();
    await new Promise(r=>setTimeout(r,250));
    return {opened, after:location.hash, grew:history.length-before,
            reopened:!!document.querySelector('.deep.open')};})()`);
  /* ACTUALLY PRESS BACK — in its own call. The sentence claimed "Back leaves the page,
     it does not replay the door" while the predicate only counted history entries; Back
     was never pressed, and at grew===1 the sentence contradicted its own test.
     It has to be a SEPARATE evaluate: history.back() tears down the execution context,
     so reading state in the same expression returns undefined and kills the run. */
  await ev(`history.back()`).catch(() => {});
  await sleep(400);
  const back = await ev(`(function(){return {
      hash: location.hash,
      doorOpen: !!document.querySelector('.deep.open')};})()`);
  (r.opened==='#labs' && !r.reopened && r.after!=='#labs' && r.grew<=1 && !back.doorOpen)
    ? ok(`open then close is history-neutral (${r.grew} net entry), and a real Back press lands on "${back.hash || 'no hash'}" with no door reopened`)
    : bad('history trap: '+JSON.stringify({...r, afterBack: back}));

  // the four learning-circle steps that point INTO layer 2
  await nav();
  r=await ev(`(async function(){
    const out=[];
    for (const i of [2,3,4,5]) {
      const row=document.querySelectorAll('#lcList .lc-row')[i];
      const link=row.querySelector('a.lc-t');
      link.click(); await new Promise(r=>setTimeout(r,200));
      const open=document.querySelector('.deep.open');
      out.push({step:i+1, label:link.textContent.trim().slice(0,26), opened: open?open.id:null});
      if(open){ document.getElementById('deepClose').click(); await new Promise(r=>setTimeout(r,120)); }
    }
    return out;})()`);
  const okSteps=r.filter(x=>x.opened);
  (okSteps.length===4) ? ok('all 4 learning-circle steps into layer 2 open it: '+r.map(x=>x.step+'→'+x.opened).join(', '))
    : bad('circle steps failed: '+JSON.stringify(r));

  // in-card cross reference (#card-bias lives inside topics)
  await nav();
  r=await ev(`(async function(){
    const a=document.querySelector('a[href="#card-bias"]');
    if(!a) return {err:'no cross-ref link'};
    a.click(); await new Promise(r=>setTimeout(r,300));
    const open=document.querySelector('.deep.open');
    const card=document.getElementById('card-bias');
    return {opened:open?open.id:null, cardOpen:card?card.open:null};})()`);
  (r.opened==='topics'&&r.cardOpen===true) ? ok('a cross-reference into a layer-2 card opens the layer AND the card')
    : bad('cross-ref: '+JSON.stringify(r));

  // shared deep link
  await nav(URL+'#labs');
  r=await ev(`(function(){const s=document.getElementById('labs');
    return {open:s.classList.contains('open'),disp:getComputedStyle(s).display};})()`);
  (r.open&&r.disp==='block') ? ok('a shared link straight to #labs opens that layer on load') : bad('deep link: '+JSON.stringify(r));

  /* A link SHARED to a card inside a layer must land the reader on that card. Clicking a
     cross-reference expanded it; pasting the same href into a fresh tab opened the layer
     and left the card collapsed hundreds of pixels off-screen — two code paths for one
     job, only one of which had the reveal. */
  await nav(URL+'#card-bias');
  await new Promise(res=>setTimeout(res,500));
  r=await ev(`(function(){const c=document.getElementById('card-bias');
    const s=document.querySelector('.deep.open');const rect=c.getBoundingClientRect();
    return {layer:s?s.id:null, cardOpen:c.open, top:Math.round(rect.top),
            inView: rect.top>=0 && rect.top<innerHeight};})()`);
  (r.layer==='topics'&&r.cardOpen===true&&r.inView)
    ? ok(`a shared link to a card opens the layer, expands the card and scrolls to it (top ${r.top}px)`)
    : bad('shared card link: '+JSON.stringify(r));

  // mobile
  await nav(URL,390);
  r=await ev(`(function(){document.querySelector('[data-deep-open="topics"]').click();
    const s=document.getElementById('topics');const rect=s.getBoundingClientRect();
    return {open:s.classList.contains('open'),w:Math.round(rect.width),
      overflow:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth};})()`);
  (r.open&&r.w===390&&r.overflow<=0) ? ok('layer 2 works full-screen on mobile with no overflow') : bad('mobile: '+JSON.stringify(r));

  /* THE FIXED CLOSE BUTTON MUST NOT SIT ON THE CONTENT. It is fixed over the top 68px of
     the layer, and scrollIntoView({block:'start'}) puts the target at y=0 — so on a 390px
     screen a card's own summary landed UNDER the button and tapping its corner closed the
     layer instead of opening the card. No pixel reference could catch this: every visual
     capture flattens the layer and hides the button. Measured geometry, on mobile. */
  await nav(URL,390);
  r=await ev(`(async function(){
    const a=document.querySelector('a[href="#card-daily"]')||document.querySelector('a[href^="#card-"]');
    if(!a) return {err:'no in-layer card link'};
    const href=a.getAttribute('href');
    a.click(); await new Promise(r=>setTimeout(r,700));
    const t=document.querySelector(href+' > summary')||document.querySelector(href);
    const b=document.getElementById('deepClose');
    const A=t.getBoundingClientRect(), B=b.getBoundingClientRect();
    const ox=Math.max(0,Math.min(A.right,B.right)-Math.max(A.left,B.left));
    const oy=Math.max(0,Math.min(A.bottom,B.bottom)-Math.max(A.top,B.top));
    return {href, target:Math.round(A.top), overlap:Math.round(ox)+'x'+Math.round(oy), area:ox*oy};})()`);
  (r.area===0) ? ok(`mobile: the close button never covers the card it scrolled to (${r.href} at y=${r.target})`)
    : bad('close button overlaps content: '+JSON.stringify(r));

  console.log('----------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  try{ws.close();}catch{} chrome.kill('SIGKILL');
  process.exit(fails?1:0);
})();
