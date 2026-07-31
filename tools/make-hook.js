/* ============================================================
   Render transparent 1080x1920 hook-text overlays:  node tools/make-hook.js
   Writes /tmp/hook_<clip>.png, then burn them in with:

     ffmpeg -i clip.mp4 -loop 1 -framerate 30 -t 3 -i /tmp/hook_<clip>.png \
       -filter_complex "[1:v]format=rgba,fade=t=in:st=0.15:d=0.35:alpha=1,\
       fade=t=out:st=2.2:d=0.5:alpha=1[t];[0:v][t]overlay=0:0:shortest=0[v]" \
       -map "[v]" -map 0:a -c:v libx264 -pix_fmt yuv420p -crf 21 -r 30 -c:a copy out.mp4

   TWO TRAPS, both hit while building this:
   - macOS ffmpeg often has NO drawtext filter, hence rendering text in Chrome.
   - `-loop 1 -t 3` is REQUIRED. A still image input is a single frame at t=0, so
     without it the fades and the overlay window silently do nothing at all.
   ============================================================ */
const { spawn } = require('child_process'); const http=require('http'); const fs=require('fs');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', PORT=9470;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=u=>new Promise((res,rej)=>http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej));
const HOOKS=[
  ["1-peel-to-the-core","What is AI,<br>really?","Ten layers, peeled"],
  ["2-watch-it-write","This is how every<br>chatbot works","one word at a time"],
  ["3-where-each-word-looks","How does AI know<br>what &ldquo;it&rdquo; means?","tap a word, watch it look"],
  ["4-check-its-work","Which line would<br>you check first?","you can&rsquo;t verify everything"]];
(async()=>{
  const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port='+PORT,'--no-first-run',
    '--default-background-color=00000000','--hide-scrollbars','--user-data-dir=/tmp/hook-'+PORT],{stdio:'ignore'});
  let ver,t=0; while(t++<60){try{ver=await getJSON(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await sleep(200);}}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  let id=0; const pend=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){
    if(m.error) console.log('CDP ERROR:', JSON.stringify(m.error));
    pend.get(m.id)(m.result);pend.delete(m.id);}};
  const send=(m,p,s)=>new Promise(r=>{pend.set(++id,r);ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId); await send('Runtime.enable',{},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:1080,height:1920,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}},sessionId);
  for (const [name,hook,sub] of HOOKS) {
    const html=`<!doctype html><meta charset=utf-8><style>
      html,body{margin:0;height:100%;background:transparent}
      body{display:flex;flex-direction:column;justify-content:flex-start;align-items:center;
        padding-top:150px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
      .h{font-size:74px;font-weight:800;line-height:1.12;letter-spacing:-.02em;color:#1a1a18;
        text-align:center;max-width:900px}
      .s{margin-top:22px;font-size:34px;font-weight:600;color:#5f5e5a;text-align:center;
        background:rgba(249,248,246,.92);padding:10px 26px;border-radius:999px}
    </style><div class=h>${hook}</div><div class=s>${sub}</div>`;
    await send('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(html)},sessionId);
    await sleep(700);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);
    fs.writeFileSync(`/tmp/hook_${name}.png`,Buffer.from(shot.data,'base64'));
    console.log('rendered hook for '+name);
  }
  try{ws.close();}catch{} chrome.kill('SIGKILL');
})();
