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
    if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200)); return r.result.value;};

  await nav();
  let r=await ev(`(function(){return {screens:+(document.scrollingElement.scrollHeight/900).toFixed(1),
    deepHidden:[...document.querySelectorAll('.deep')].every(d=>getComputedStyle(d).display==='none'),
    doors:document.querySelectorAll('.deep-card').length};})()`);
  (r.deepHidden && r.doors===4) ? ok(`layer 1 is ${r.screens} screens; all 4 deep sections hidden, 4 doors present`)
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

  // mobile
  await nav(URL,390);
  r=await ev(`(function(){document.querySelector('[data-deep-open="topics"]').click();
    const s=document.getElementById('topics');const rect=s.getBoundingClientRect();
    return {open:s.classList.contains('open'),w:Math.round(rect.width),
      overflow:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth};})()`);
  (r.open&&r.w===390&&r.overflow<=0) ? ok('layer 2 works full-screen on mobile with no overflow') : bad('mobile: '+JSON.stringify(r));

  console.log('----------------------------');
  console.log(`${checks} checks, ${fails} failure(s)`);
  try{ws.close();}catch{} chrome.kill('SIGKILL');
  process.exit(fails?1:0);
})();
