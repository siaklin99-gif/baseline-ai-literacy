/* ============================================================
   Record one of the page's clip modes as a vertical MP4.
     node tools/record-clip.js <mode> <out.mp4> [seconds]
     modes: write | peel | attn | triage   (see ?clip= in index.html)

   Frames are captured over CDP and assembled with ffmpeg (brew install ffmpeg).
   The viewport is FITTED to the clip's own content, with a per-mode floor: peel
   GROWS as it descends, and fitting to the first layer once clipped the last one
   mid-sentence. Output is padded to 1080x1920 on the page's own background.
   ============================================================ */
const { spawn, execFileSync } = require('child_process'); const http=require('http'); const fs=require('fs');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MODE=process.argv[2], OUT=process.argv[3], SECS=+(process.argv[4]||20), PORT=9400+Math.floor(Math.random()*90);
const W=1080, H=1920, FPS=12;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=u=>new Promise((res,rej)=>http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej));
(async()=>{
  const dir=`/tmp/frames_${MODE}`; fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir,{recursive:true});
  const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port='+PORT,'--hide-scrollbars','--no-first-run',
    '--force-device-scale-factor=1','--user-data-dir=/tmp/rec-'+PORT],{stdio:'ignore'});
  let ver,t=0; while(t++<60){try{ver=await getJSON(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await sleep(200);}}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  let id=0; const pend=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
  const send=(m,p,s)=>new Promise(r=>{pend.set(++id,r);ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId); await send('Runtime.enable',{},sessionId);
  // 540x960 at dsf2 => a crisp 1080x1920
  await send('Emulation.setDeviceMetricsOverride',{width:540,height:960,deviceScaleFactor:2,mobile:true},sessionId);
  await send('Page.navigate',{url:`file://' + require('path').join(__dirname,'..','index.html') + '?clip=${MODE}`},sessionId);
  await sleep(2500);
  // Fit the viewport to the clip's own content. Recording a fixed 540x960 left most of a
  // vertical frame empty; measuring first means the component fills the shot.
  // Retried: a single attempt is taken while the clip is still settling and can return
  // the fallback, quietly recording a loosely-framed clip that still looks plausible.
  // A fit that silently does not fit is the worst kind, so measure until it answers.
  // NOTE: the measurement currently returns 0 in clip mode and the floors below are used
  // instead. Those floors ARE the values measured when the four published clips were made,
  // so output is unchanged — but the warning is left loud rather than removed, because a
  // tool that quietly stops measuring is how a loosely-framed clip ships unnoticed.
  let measured = 0;
  for (let attempt = 0; attempt < 6 && !measured; attempt++) {
    if (attempt) await sleep(600);
    const mm = await send('Runtime.evaluate', { expression: `(function(){
      const el = [...document.querySelectorAll('.wrap')].map(w => w.getBoundingClientRect())
        .filter(r => r.height > 60).sort((a,b) => b.height - a.height)[0];
      return el ? Math.ceil(el.height) + 56 : 0; })()`, returnByValue: true }, sessionId);
    measured = (mm && mm.result && mm.result.value) || 0;
  }
  // peel GROWS as it descends (layer 10 is far taller than layer 1), so fitting to the
  // first frame clipped the last one mid-sentence. Give the growing modes headroom.
  const FLOOR = { peel: 1000, write: 700, triage: 660, attn: 560 };
  if (!measured) console.log('  WARNING: could not measure the clip — falling back to the floor');
  const contentH = Math.min(1400, Math.max(FLOOR[MODE] || 520, measured || FLOOR[MODE] || 960));
  await send('Emulation.setDeviceMetricsOverride', { width: 540, height: contentH, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(600);
  console.log(`  measured ${measured || 'none'} -> viewport 540x${contentH}`);
  const total=SECS*FPS;
  for(let i=0;i<total;i++){
    const shot=await send('Page.captureScreenshot',{format:'png'},sessionId);
    fs.writeFileSync(`${dir}/f${String(i).padStart(4,'0')}.png`,Buffer.from(shot.data,'base64'));
    await sleep(Math.max(0, 1000/FPS - 55));
  }
  try{ws.close();}catch{} chrome.kill('SIGKILL');
  execFileSync('ffmpeg',['-y','-framerate',String(FPS),'-i',`${dir}/f%04d.png`,
    '-vf',`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xf9f8f6`,
    '-c:v','libx264','-pix_fmt','yuv420p','-crf','23','-movflags','+faststart',OUT],{stdio:'ignore'});
  fs.rmSync(dir,{recursive:true,force:true});
  console.log(`${OUT}  ${(fs.statSync(OUT).size/1048576).toFixed(2)} MB`);
})();
