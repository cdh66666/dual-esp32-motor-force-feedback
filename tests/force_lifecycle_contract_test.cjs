// Execute the production force lifecycle with mocked transport. No hardware IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/dashboard.js'), 'utf8');
const lifecycle = source.slice(source.indexOf('async function cleanupForcePair('), source.indexOf("['forceK', 'forceD', 'forceLimit'].forEach"));
async function scenario(failStatus = false, failStop = false, largeOffset = false, singleUsb = false) {
  const commands = [];
  const readiness=[];
  const pair = [
    {port:'A',active:true,busAddress:1,modelKe:.022754,latest:{multi:12},motionGeneration:0},
    {port:'B',active:true,busAddress:184,modelKe:.028295,latest:{multi:-8},motionGeneration:0,
      ...(singleUsb?{remote:true,entry:'A',gatewayProtocol:3}:{})},
  ];
  pair.forEach(b=>{b.lastTelemetryAt=Date.now();b.latest.fault=1;b.motorSettings={current:1.5};});
  if(largeOffset)pair[0].latest.multi=200;
  const controls = {forceRebase:{addEventListener(){}},forceK:{value:18},forceD:{value:.35},forceLimit:{value:1600},forceStart:{disabled:false}};
  let message = '', liveResets=0;
  const context = vm.createContext({
    autoTune:{active:false},
    scopeReset:()=>{liveResets++;},
    boards:new Map(pair.map(b=>[b.port,b])), forceSession:{active:false,boards:[],token:0},
    $:s=>controls[s.slice(1)], forceState:s=>{message=s;}, forceLocked:fn=>fn(),
    forcePair:async()=>pair, ensureReady:async(board,configure=true)=>{readiness.push({port:board.port,configure});},clearMotionTimers:()=>{},
    gearOf:()=>5.2, serialNumber:n=>String(n),pause:async()=>{},
    setSlider:()=>{},resetChartRanges:()=>{},waitUntil:async(predicate,timeout,message)=>{assert(predicate(),message);},
    setTimeout:()=>1, clearTimeout:()=>{},
    send:async(port,command)=>{
      commands.push({port,command});
      if(command==='encreset'){const b=pair.find(b=>b.port===port);b.latest.multi=0;b.lastTelemetryAt=Date.now();}
      if(failStop && command==='stop') throw new Error('mock link lost');
      return {acknowledged:true,reply:command==='sync status' ?
        `SYNC mode=force armed=${failStatus && port==='B' ? 0 : 1} timeout=10` : command==='model' ? 'MODEL fw=0.5.10-single-usb-force Ke=0.022754V/(rad/s)' : 'OK'};
    },
  });
  vm.runInContext(lifecycle, context);
  let failure;
  try { await context.startForceFeedback(); } catch(error) {failure=error;}
  if(failStatus) {
    assert(failure);
    assert.equal(context.forceSession.active,false);
    for(const b of pair) assert(commands.some(c=>c.port===b.port && c.command==='sync stop'));
    return;
  }
  assert.ifError(failure);
  assert(context.forceSession.active);
  assert.equal(liveResets,1);
  const force = commands.filter(c=>c.command.startsWith('sync force '));
  assert.deepEqual(force.map(c=>c.port),['B','A']);
  if(largeOffset)assert.equal(commands.filter(c=>c.command==='encreset').length,0,'large valid relative offsets must not reset encoder references');
  const args = force.map(c=>c.command.split(' ').map(Number));
  assert(args.every(a=>a[6]<=1200), 'force commands must stay within 80% of 1.5 A');
  assert(Math.abs(args[0][9] + args[1][9])<1e-9, 'offsets must be opposite');
  assert(Math.abs(args[0][6]*pair[1].modelKe-args[1][6]*pair[0].modelKe)<1e-9, 'equal ideal torque ceilings');
  if(singleUsb){
    assert(!commands.some(c=>c.port==='B'&&c.command==='model'),'remote command must use cached META, not unsupported USB model query');
    assert(!commands.some(c=>c.port==='B'&&c.command==='stream 50'),'remote peer has no USB stream control');
    assert(readiness.some(r=>r.port==='B'&&r.configure===false),'remote readiness must wake without USB-only cascade setup');
  }
  await context.stopForceFeedback();
  assert.equal(context.forceSession.active,false);
  assert(message.includes('停止指令已确认'));
  // A missing STOP acknowledgment must never become a successful stop notice.
  context.send=async(port,command)=>{if(port==='B' && command==='stop') throw Error('lost');return {acknowledged:true};};
  await assert.rejects(context.stopForceFeedback(),/停机回执未确认/);
  assert.equal(context.forceSession.boards[0].port,'B');
}
(async()=>{
  await scenario();
  await scenario(true);
  await scenario(false,false,true);
  await scenario(false,false,false,true);
  // Real transport must request an acknowledgment for the startup status query.
  const sendBody=source.slice(source.indexOf('async function send('),source.indexOf('function initialBoard('));
  assert(sendBody.includes('^sync (status|'));
  console.log('PASS: dual-USB and single-USB force startup, paired rollback, torque normalization, absolute offsets, stop acknowledgment; mocked I/O only');
})().catch(error=>{console.error(error);process.exitCode=1;});
