// Offline browser only. API transport is intercepted; no physical motor access.
const assert=require('node:assert/strict');
let chromium;
try {({chromium}=require('playwright'));}catch{({chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await require('./offline_browser.cjs')(page);
  // Import the declaration harness only once. Loading the normal module as
  // well would bind the scope controls twice and double every zoom gesture.
  await page.route('http://127.0.0.1:18766/', async route=> {
    const html=require('node:fs').readFileSync(require('node:path').join(__dirname,'../web/dashboard.html'),'utf8');
    await route.fulfill({contentType:'text/html',body:html.replace(/<script type="module"[^>]*><\/script>/g,'')});
  });
  await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ports:[],usb_problems:[],logs:[]})}));
  await page.goto('http://127.0.0.1:18766/');
  const result=await page.evaluate(async()=>{
    const source=await(await fetch('/dashboard.js')).text();
    const code=source.slice(0,source.indexOf("$('#unit').addEventListener"));
    const m=await import(URL.createObjectURL(new Blob([code+'\nexport {forceSession,scope,boards,scopeRange,scopeSnapshot,drawScope,scopeZoomY,scopeLayout};'],{type:'text/javascript'})));
    const drawn=[],paint=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y){drawn.push({text:String(text),x,y,color:this.fillStyle,align:this.textAlign,width:this.measureText(text).width});return paint.call(this,text,x,y);};
    const at=Date.now();
    for(const [port,epoch] of [['A',1000],['B',50000]]) m.boards.set(port,{active:true,port,sessionId:port,lastTelemetryAt:at,latest:{t:epoch},samples:Array.from({length:101},(_,i)=>({t:epoch-1000+i*10,current:.1*Math.sin(i/10),multi:360,velocity:720,multiTarget:720,velocityTarget:900,currentTarget:.2,control:3}))});
    const data=m.scopeSnapshot();
    if(data.series[0].samples[0].multiTarget!==2 || data.series[0].samples[0].velocityTarget!==2.5)throw Error('Target unit conversion failed');
    if(data.series[0].samples[0].multi!==1 || data.series[0].samples[0].velocity!==2 || m.boards.get('A').samples[0].multi!==360)throw Error('Display conversion must not mutate control units');
    const aligned=data.series[0].samples.at(-1).wall===data.series[1].samples.at(-1).wall;
    m.scope.frozen=data;m.drawScope(100);
    if(m.scope.ranges['A:multi'][1]<2 || m.scope.ranges['A:current'][1]<.2)throw Error('Autoscale excludes targets');
    const ticks=drawn.filter(r=>/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/.test(r.text));
    const headers=drawn.filter(r=>r.text==='电流 A'||r.text==='位置 r');
    const oldRange=[...m.scope.ranges['A:current']];
    m.scopeZoomY(.5,0);
    const zoomTracks=Math.abs((m.scope.ranges['A:current'][1]-m.scope.ranges['A:current'][0])/(oldRange[1]-oldRange[0])-.5)<1e-9;
    m.scope.ranges['A:current']=oldRange;m.scope.manual.clear();
    const canvas=document.querySelector('#scopeCanvas'),before=canvas.toDataURL();
    m.boards.get('A').samples=[];m.drawScope(200);
    const frozen=before===canvas.toDataURL();
    m.scope.frozen=null;
    const tiny=m.scopeRange([10000,10000.001],.02);
    const finite=m.scopeRange([NaN,Infinity],.02).every(Number.isFinite);
    for(const box of document.querySelectorAll('[data-scope-channel]'))box.checked=true;
    drawn.length=0;m.drawScope(300);
    const fourAxisTicks=drawn.filter(r=>/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/.test(r.text));
    const noClipping=fourAxisTicks.every(r=>r.align==='right'?r.x-r.width>=0:r.x+r.width<=canvas.getBoundingClientRect().width);
    for(const box of document.querySelectorAll('[data-scope-channel]'))box.checked=['current','multi'].includes(box.dataset.scopeChannel);
    CanvasRenderingContext2D.prototype.fillText=paint;
    m.forceSession.active=true;m.scope.frozen=data;m.drawScope(400);
    if(m.scope.frozen!==null || !document.querySelector('#scopePause').disabled)throw Error('Force mode must remain live');
    m.forceSession.active=false;m.drawScope(500);
    return {aligned,frozen,finite,zoomTracks,ticks:ticks.length,headers:headers.length,fourAxisTicks:fourAxisTicks.length,noClipping,smallSpan:tiny[1]-tiny[0],legend:document.querySelector('#scopeLegend').textContent};
  });
  assert(result.aligned&&result.frozen&&result.finite);
  assert(result.smallSpan<.1);
  assert.equal(result.ticks,20);assert.equal(result.headers,4);
  assert.equal(result.fourAxisTicks,40);assert(result.noClipping&&result.zoomTracks);
  assert(result.legend.includes('A/div')&&result.legend.includes('r/div'));
  await page.click('#scopePause');assert.equal(await page.locator('#scopePause').getAttribute('aria-pressed'),'true');
  await page.click('#scopeScale');assert.equal(await page.locator('#scopeScale').getAttribute('aria-pressed'),'true');
  await page.click('#scopeZoomIn');assert.equal(await page.locator('#scopeWindow').inputValue(),'2500');
  await page.click('#scopeZoomOut');assert.equal(await page.locator('#scopeWindow').inputValue(),'5000');
  await page.click('#scopeReset');assert.equal(await page.locator('#scopePause').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#scopeChannels').count(),1);
  assert.equal(await page.locator('[data-scope-channel]').count(),4);
  await page.locator('#scopeChannels [data-scope-channel="current"]').uncheck();
  assert.equal(await page.locator('[data-scope-channel="current"]:checked').count(),0);
  assert.equal(await page.locator('#motorSettings input').count(),3);
  await page.screenshot({path:'evidence/live-targets-offline.png'});
  console.log(JSON.stringify(result));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
