// All endpoints are intercepted. This test never energises a physical board.
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await require('./offline_browser.cjs')(page);
  await page.route('**/api/**', route => {
    const url = route.request().url();
    let result = {ok:true,acknowledged:true,logs:[],session_id:'test-epoch'};
    if(url.includes('/ports')) result = {ports:[{port:'FAKE',esp32:true,active:true,write_ok:true,present:true,hwid:'mock',rx_age_ms:0}],usb_problems:[]};
    if(url.includes('/events')) return route.fulfill({status:503,body:''});
    return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto('http://127.0.0.1:18766/?test=data-contract');
  await page.click('#advancedToggle');
  await page.waitForSelector('[data-port="FAKE"]');
  const results = await page.evaluate(async () => {
    // Module lexical bindings can be accessed by a test-only copy imported
    // with exports; avoid modifying the production module's global namespace.
    const source = await (await fetch('/dashboard.js')).text();
    const declarationOnly = source.slice(0, source.indexOf("$('#unit').addEventListener"))
      .replaceAll("import('/gateway-transport.js')", "import('http://127.0.0.1:18766/gateway-transport.js')")
      .replaceAll("import('/usb-chain-transport.js')", "import('http://127.0.0.1:18766/usb-chain-transport.js')")
      .replaceAll("import('/remote-motion-lease.js')", "import('http://127.0.0.1:18766/remote-motion-lease.js')");
    const module = await import(URL.createObjectURL(new Blob([declarationOnly + '\nexport {initialBoard,parseLine,mirrorRemoteForceSample,applyMotorProfileUi,ingestLogs,axisRange,resetChartRanges,setTargetWindow,nice};'], {type:'text/javascript'})));
    const board = module.initialBoard('FAKE');
    board.root = document.querySelector('[data-port="FAKE"]');
    module.applyMotorProfileUi(board,'36gp555');
    module.parseLine(board,'KNOB_CFG active=0 effect=0 spacing_out_deg=15 peak_mA=600 damping_mA_per_out_dps=1 range_out_deg=90 origin_out_deg=0');
    const knobReadback = board.root.querySelector('[data-slider="knobStrength"]').value === '600' &&
      board.root.querySelector('[data-slider="knobSpacing"]').value === '15';
    module.parseLine(board,'CASCADE_CFG current_hz=2000 kp=600.000 ki=200000.000 max_pwm=4095 velocity_hz=500 kp=0.001000 ki=0.006000 max_current=0.600A friction=0.000A position_hz=200 kp=4.000 ki=0.000 kd=0.150 max_velocity=12000.0');
    const gainsReadBack = Number(board.root.querySelector('[data-slider="currentKi"]').value) === 200000 &&
      Math.abs(Number(board.root.querySelector('[data-slider="velocityKi"]').value) - 0.006 * 5.2) < 1e-9;
    const remote=module.initialBoard('DATA-184');
    remote.remote=true;remote.active=true;remote.entry='FAKE';remote.gear=5.2;remote.latest={t:0,bus:24.25};
    const peerFields=Array(37).fill('0');peerFields[27]='1';peerFields[28]='1872';
    peerFields[29]='520';peerFields[30]='400';peerFields[31]='120';peerFields[32]='1';
    peerFields[33]='1';peerFields[35]='0';peerFields[36]='300';
    const mirrored=module.mirrorRemoteForceSample(remote,board,{t:1000,forceActive:true},peerFields);
    const peerCurve=mirrored&&remote.samples.length===1&&Math.abs(remote.latest.multi-360)<1e-9&&
      Math.abs(remote.latest.velocity-100)<1e-9&&Math.abs(remote.latest.current-.4)<1e-9&&
      Math.abs(remote.latest.currentTarget-.3)<1e-9;
    const s = (t,multi=720,velocity=360) => `S,${t},0,${multi},20,0,0,1,1,0,0,${velocity},3,720,0,0,0,0,0,1,360,100,100,0,360`;
    module.parseLine(board,s(100));
    const angle = module.axisRange(board,'multi');
    const before = board.samples.length;
    const timestamp = board.lastTelemetryAt;
    module.parseLine(board,'S,broken');
    module.parseLine(board,s(100));
    module.parseLine(board,'MODEL fw=test');
    const validOnly = board.samples.length === before && board.lastTelemetryAt === timestamp;
    board.activeMotion={mode:'position',value:720};
    module.parseLine(board,s(110));
    const holdSurvivesSettled = board.activeMotion?.mode === 'position';
    board.seq=10000; board.sessionId='old';
    module.ingestLogs(board,{session_id:'new',logs:[
      {seq:1,direction:'rx',text:'MOTOR_PROFILE id=36gp555-24v-1538rpm gear=5.2 voltage_pwm_limit=4095/4095'},
      {seq:2,direction:'rx',text:s(5)}]});
    const epochResets = board.seq===2 && board.samples.length===1 && board.activeMotion===null;
    module.resetChartRanges(board,{multi:10000.52,multiTarget:10000.5,velocity:0,velocityTarget:0});
    const fineRange = (board.range.multi.max-board.range.multi.min) < 1.01 && board.range.velocity.max < 100;
    const readableTicks = module.nice(.001, .0005) !== module.nice(.0015, .0005);
    const input=board.root.querySelector('[data-slider="positionTarget"]');
    input.value='.52';
    module.setTargetWindow(board,'positionTarget',1);
    const preciseTarget = Number(input.value)===.52 && Math.abs(Number(input.max)-Number(input.min)-2)<1e-6;
    document.querySelector('#errorModal').hidden=true;
    board.activeMotion={mode:'current',value:100};
    module.parseLine(board,'CASCADE timeout');
    const normalEndNotFault = document.querySelector('#errorModal').hidden && board.activeMotion===null;
    module.parseLine(board,'CASCADE fault=0');
    const realFaultVisible = !document.querySelector('#errorModal').hidden;
    document.querySelector('#errorModal').hidden = true;
    const replay = module.initialBoard('REPLAY');
    replay.root = board.root;
    module.ingestLogs(replay,{session_id:'history',logs:[
      {seq:1,direction:'rx',text:'CASCADE fault knob_invalid_or_overspeed'}
    ]});
    const replayFaultSuppressed = document.querySelector('#errorModal').hidden;
    module.ingestLogs(replay,{session_id:'history',logs:[
      {seq:2,direction:'rx',text:'CASCADE fault encoder_stale age_us=10027 limit_us=10000 nack=0 short=0 rejected=0 read_max_us=490'}
    ]});
    const nearStaleSuppressed = document.querySelector('#errorModal').hidden;
    module.ingestLogs(replay,{session_id:'history',logs:[
      {seq:3,direction:'rx',text:'CASCADE fault nFAULT=0'}
    ]});
    const liveFaultVisible = !document.querySelector('#errorModal').hidden;
    return {validOnly,holdSurvivesSettled,epochResets,gainsReadBack,knobReadback,peerCurve,angle,rawDegrees:720,
      fineRange,readableTicks,preciseTarget,normalEndNotFault,realFaultVisible,
      replayFaultSuppressed,nearStaleSuppressed,liveFaultVisible};
  });
  assert(results.validOnly);
  assert(results.holdSurvivesSettled);
  assert(results.epochResets);
  assert(results.gainsReadBack, 'board readback must not silently clip PI gains');
  assert(results.knobReadback, 'knob UI must reflect board-side configuration');
  assert(results.peerCurve, 'single-USB force scope must mirror peer position/speed/current at USB rate from synchronized samples');
  for (const key of ['fineRange','readableTicks','preciseTarget','normalEndNotFault','realFaultVisible']) assert(results[key],key);
  assert(results.replayFaultSuppressed && results.nearStaleSuppressed && results.liveFaultVisible);
  assert(results.angle[1] >= 720/5.2/360 && results.angle[1] < 1, '720 rear degrees must render near 0.385 output turns');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(results));
  await browser.close();
})().catch(error => {console.error(error);process.exit(1);});
