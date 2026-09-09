// Isolated DOM and fake commands only: no server or physical motor access.
const assert=require('node:assert/strict'),fs=require('node:fs');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
  const page=await browser.newPage();await require('./offline_browser.cjs')(page);
  await page.route('http://127.0.0.1:18766/',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('web/dashboard.html','utf8').replace(/<script type="module"[^>]*><\/script>/g,'')}));
  await page.goto('http://127.0.0.1:18766/');
  const source=fs.readFileSync('web/dashboard.js','utf8');
  const result=await page.evaluate(async code=>{
   const $=(s,r=document)=>r.querySelector(s),commands=[],forceSession={active:false},fmt=v=>Number(v).toFixed(2);
   const boards=new Map(['A','B'].map(port=>[port,{port,active:true,sessionId:port,motionGeneration:0,lastTelemetryAt:Date.now(),latest:{multi:100},motorSettings:{current:.5},targetLimits:{velocityTarget:4000,positionTarget:36000}}]));
   const clearMotionTimers=()=>{};
   let failure=false;
   const send=async(port,command)=>{commands.push([port,command]);};
   const runMotion=async(b,mode,value,generation)=>{if(failure&&b.port==='B')throw Error('B rejected');if(generation!==b.motionGeneration)return;commands.push([b.port,mode,value]);b.activeMotion={mode};};
   eval(code+'\nwindow.testQuick={quickApply,quickStop};');
   const q=window.testQuick;
   document.querySelector('#quick-position').value=.01;
   document.querySelector('#quick-position').dispatchEvent(new Event('input'));
   const previewSilent=commands.length===0;
   await new Promise(r=>setTimeout(r,100));
   const pair=commands.filter(c=>c[1]==='position');
   await q.quickStop();commands.length=0;
   await q.quickApply('position',false);const noResume=!commands.some(c=>c[1]==='position');
   commands.length=0;$('#quickBoard').value='1';await q.quickApply('velocity',true);
   const single=commands.filter(c=>c[1]==='velocity');await q.quickStop();commands.length=0;
   $('#quickBoard').value='both';failure=true;await q.quickApply('position',true);
   const rollback=['A','B'].every(p=>commands.some(c=>c[0]===p&&c[1]==='stop'));
   failure=false;commands.length=0;forceSession.active=true;await q.quickApply('current',true);const forceUntouched=commands.length===0;
   forceSession.active=false;commands.length=0;$('#quickBoard').value='both';
   for(let i=0;i<50;i++) {$('#quick-position').value=i/100;$('#quick-position').dispatchEvent(new Event('input'));}
   await new Promise(r=>setTimeout(r,100));
   const coalesced=commands.filter(c=>c[1]==='position');
   await q.quickStop();commands.length=0;
   $('#quick-position').dispatchEvent(new Event('input'));await q.quickStop();await new Promise(r=>setTimeout(r,100));
   const stopCancelsPending=commands.length===0;
   return {previewSilent,pair,noResume,single,rollback,forceUntouched,coalesced,stopCancelsPending};
  },source.slice(source.indexOf('// Quick controls share'),source.indexOf("$('#unit').addEventListener")));
  assert(result.previewSilent&&result.noResume&&result.rollback&&result.forceUntouched);
  assert.equal(result.pair.length,2);assert(result.pair.every(c=>Math.abs(c[2]-3.6)<1e-6));
  assert.equal(result.coalesced.length,2);assert(result.coalesced.every(c=>Math.abs(c[2]-.49*360)<1e-6));assert(result.stopCancelsPending);
  assert.equal(result.single.length,1);assert.equal(result.single[0][0],'B');
  assert.equal(await page.locator('.quick-row button,.quick-row select').count(),0);
  for(const [mode,limit] of [['position','10'],['velocity','15'],['current','1']])assert.equal(await page.locator('#quick-'+mode).getAttribute('max'),limit);
  await page.setViewportSize({width:980,height:670});
  const controlBottom=await page.locator('#quickControl').evaluate(e=>e.getBoundingClientRect().bottom);
  assert(controlBottom<=670,`controls bottom ${controlBottom} exceeds 670px viewport`);
  console.log('PASS live sliders: coalescing, final value, pair, selection, rollback, stop cancellation, force exclusion');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
