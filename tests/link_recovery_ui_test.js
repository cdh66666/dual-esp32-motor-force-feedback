// Entire UI test is isolated from actual USB and live APIs.
const assert=require('node:assert/strict');
let chromium;
try { ({chromium}=require('playwright')); }
catch { ({chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try {
  const page=await browser.newPage();const requests=[];const errors=[];
  // Exercise refreshPorts explicitly below. The original page's background
  // interval must not race this isolated module's mocked fetch counter.
  await page.addInitScript(() => { window.setInterval = () => 0; });
  page.on('pageerror',e=>errors.push(e.message));
  await require('./offline_browser.cjs')(page);
  await page.route('**/api/**',r=>{
   const url=new URL(r.request().url());
   if(url.pathname==='/api/events')return r.fulfill({status:503,body:''});
   requests.push({path:url.pathname,body:r.request().postDataJSON()});
   const data=url.pathname==='/api/ports'?{ports:[{port:'FAKE',esp32:true,active:true,write_ok:true,rx_age_ms:0}],usb_problems:[]}:
    {ok:true,acknowledged:true,reply:'OK',logs:[],session_id:'test'};
   return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://127.0.0.1:18766/');
  await page.click('#advancedToggle');
  await page.waitForSelector('[data-port="FAKE"]');
  const result=await page.evaluate(async()=>{
   const source=await(await fetch('/dashboard.js')).text();
   const declarations=source.slice(0,source.indexOf("$('#unit').addEventListener"));
   const m=await import(URL.createObjectURL(new Blob([declarations+'\nexport {boards,initialBoard,reportLinkIssue,recoverConnection,showErrorModal,api,refreshPorts};'],{type:'text/javascript'})));
   const board=m.initialBoard('FAKE');board.root=document.querySelector('[data-port="FAKE"]');
   board.active=true;board.lastTelemetryAt=Date.now();m.boards.set('FAKE',board);
   document.querySelector('#errorModal').hidden=true;
   board.activeMotion={mode:'knob'};
   for(let i=0;i<10;i++)m.reportLinkIssue('FAKE','No receive data');
   const cancelledOldMotion = board.motionGeneration === 10;
   const inline=!board.root.querySelector('[data-link-issue]').hidden&&document.querySelector('#errorModal').hidden&&board.activeMotion===null;
   await m.recoverConnection(board);
   const healthyKept=!board.root.querySelector('[data-link-issue]').hidden===false;
   const oneWayCleared = !board.linkFault;
   // Healthy control recovery still keeps the handle; failed OUT must use
   // backend bidirectional recovery even if telemetry was received just now.
   board.lastTelemetryAt=Date.now();
   await m.recoverConnection(board);
   board.lastTelemetryAt=0;
   await m.recoverConnection(board);
   m.showErrorModal('FAKE fault','nFAULT=0','Stop','same-fault');
   document.querySelector('#errorModal').hidden=true;
   m.showErrorModal('FAKE fault','nFAULT=0','Stop','same-fault');
   const originalFetch = window.fetch;
   let boundedTimeout=false, queries=0;
   try {
    window.fetch=(_url,options)=>new Promise((_resolve,reject)=>
      options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
    try { await m.api('ports', undefined, 20); }
    catch(error) { boundedTimeout=error.kind==='transport' && error.message.includes('超时'); }
    window.fetch=async()=>{
      queries++; await new Promise(resolve=>setTimeout(resolve,30));
      return {ok:true,json:async()=>({ports:[],usb_problems:[]})};
    };
    await Promise.all([m.refreshPorts(),m.refreshPorts(),m.refreshPorts()]);
   } finally { window.fetch=originalFetch; }
   return {inline,healthyKept,deduplicated:document.querySelector('#errorModal').hidden,
     cancelledOldMotion,oneWayCleared,boundedTimeout,singlePortPoll:queries===1};
  });
  assert(result.inline);assert(result.healthyKept);assert(result.deduplicated);
  assert(result.cancelledOldMotion);assert(result.boundedTimeout);assert(result.singlePortPoll);
  assert.equal(requests.filter(r=>r.path==='/api/disconnect').length,0);
  assert(result.oneWayCleared);
  assert.equal(requests.filter(r=>r.path==='/api/recover-link').length,2);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({...result,healthyRecoveryNoDisconnect:true,staleRecoveryExplicit:true}));
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
