// Entire browser transport is intercepted by offline_browser.cjs. No hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let chromium;
try { ({chromium} = require('playwright')); }
catch { ({chromium} = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1100}});
    const errors = [], commands = [];
    page.on('pageerror', e => errors.push(e.message));
    await require('./offline_browser.cjs')(page);
    await page.route('**/api/**', async route => {
      const url = route.request().url();
      let result = {ok:true, acknowledged:true, logs:[], session_id:'mock'};
      if (url.includes('/events')) return route.fulfill({status:503,body:''});
      if (url.includes('/ports')) result = {ports:[{port:'OFFLINE', active:true, write_ok:true,
        esp32:true, present:true, rx_age_ms:0, hwid:'OFFLINE TEST - no connected motor'}], usb_problems:[]};
      if (url.includes('/send')) {
        const cmd = JSON.parse(route.request().postData()).command;
        commands.push(cmd);
        result.reply = cmd.startsWith('knob start ') ? 'OK knob_start token=' + cmd.split(' ')[2] + ' origin_out_deg=360.00000' : 'OK MOCK';
      }
      return route.fulfill({contentType:'application/json', body:JSON.stringify(result)});
    });
    await page.goto('http://127.0.0.1:18766/');
    await page.click('#advancedToggle');
    await page.waitForSelector('[data-port="OFFLINE"]');
    const results = await page.evaluate(async () => {
      const source = await (await fetch('/dashboard.js')).text();
      const cut = source.indexOf("$('#unit').addEventListener");
      const exports = `\nexport {initialBoard,parseLine,applyMotorProfileUi,applyCascade,parameterToMotor,
        positionCommand,startKnob,renewKnob,stopAndPrepare,scheduleKnobConfig,knobPreviewMa,
        knobSettings,updateKnobStatus,updateUi,runMotion,ingestLogs,exportCsv,gearOf,updateSliderOutput,drawKnobPreview,drawChart};
        export function unit(value) { displayUnit = value; }`;
      const declarations = source.slice(0,cut)
        .replaceAll("import('/gateway-transport.js')", "import('http://127.0.0.1:18766/gateway-transport.js')")
        .replaceAll("import('/usb-chain-transport.js')", "import('http://127.0.0.1:18766/usb-chain-transport.js')")
        .replaceAll("import('/remote-motion-lease.js')", "import('http://127.0.0.1:18766/remote-motion-lease.js')");
      const m = await import(URL.createObjectURL(new Blob([declarations+exports],{type:'text/javascript'})));
      const b = m.initialBoard('OFFLINE');
      b.root = document.querySelector('[data-port="OFFLINE"]'); b.active = true;
      b.canvases = Object.fromEntries([...b.root.querySelectorAll('[data-chart]')].map(e=>[e.dataset.chart,e.querySelector('canvas')]));
      const sample = (t, mode=3) => `S,${t},72,1872,20,0,0,1,1,3,3276,0,${mode},1872,1,0,0,0,0,1,1872,0,0,0,0`;
      m.parseLine(b, sample(10));
      const unknownGearBlocked = b.samples.length === 0;
      m.parseLine(b, 'MOTOR_PROFILE id=36gp555-24v-1538rpm gear=5.2 bus=20V voltage_pwm_limit=4095/4095');
      m.parseLine(b, 'MODEL fw=0.5.4-usb-dcd-guard R=6.20926Ohm Ke=0.022754V/(rad/s)');
      m.updateKnobStatus(b);
      const lever25mm = b.root.querySelector('[data-slider="knobLever"]').value === '25';
      if (!lever25mm) throw new Error('default lever must be 25 mm');
      const forceEstimate = b.root.querySelector('[data-knob-force]').textContent;
      if (!forceEstimate.includes('2.37 N') || !forceEstimate.includes('非实测')) throw new Error(forceEstimate);
      const priorGeneration = b.motionGeneration;
      b.root.querySelector('[data-slider="knobLever"]').value = 50;
      m.updateKnobStatus(b);
      if (!b.root.querySelector('[data-knob-force]').textContent.includes('1.18 N') || b.motionGeneration !== priorGeneration)
        throw new Error('lever changed current/motion instead of display conversion');
      b.root.querySelector('[data-slider="knobLever"]').value = 25;
      m.parseLine(b, sample(20));
      m.updateUi(b);
      const outputNumbers = {angle:b.latest.multi, target:b.latest.multiTarget, speed:b.latest.velocityTarget,
        single:b.latest.single, displayed:b.root.querySelector('[data-metric="multi"]').textContent};
      const legacyCommand = m.positionCommand(b, 360);
      const blockedBeforeFlash = b.root.querySelector('[data-act="knobStart"]').disabled;
      m.parseLine(b,'CAPS output_position=1 knob=1 haptic_protocol=1');
      const newCommand = m.positionCommand(b, 36000);
      const motorGains = ['velocityKp','velocityKi','positionMaxVelocity','positionDeadband'].map(n => m.parameterToMotor(b,n));
      const velocityRange = {
        min:Number(b.root.querySelector('[data-slider="velocityTarget"]').min),
        max:Number(b.root.querySelector('[data-slider="velocityTarget"]').max)
      };
      m.unit('deg'); m.updateUi(b);
      const degDisplay = b.root.querySelector('[data-metric="multi"]').textContent;
      m.unit('rev'); m.updateUi(b);
      const changedUnitsNoMutation = b.latest.multi === 360 && b.latest.multiTarget === 360;
      b.latest.bus = 0;
      let powerBlocked = false;
      try { await m.startKnob(b); } catch { powerBlocked = true; }
      b.latest.bus = 20;
      m.scheduleKnobConfig(b);
      await new Promise(r => setTimeout(r, 200));
      const preview = m.knobPreviewMa({effect:0,spacing:15,peak:200,range:90}, 3.75);
      b.lastTelemetryAt=Date.now();
      await m.startKnob(b);
      const started = b.activeMotion?.mode === 'knob';
      const token = b.activeMotion?.token;
      b.lastMotionSentAt=0; b.lastTelemetryAt=Date.now();
      await m.renewKnob(b);
      const renewed = b.activeMotion?.token === token;
      b.lastTelemetryAt=Date.now();
      await m.runMotion(b,'velocity',36);
      const switched = b.activeMotion?.mode === 'velocity';
      await m.stopAndPrepare(b);
      const stopped = b.activeMotion === null;
      b.lastTelemetryAt=Date.now();
      await m.startKnob(b);
      b.lastMotionSentAt=0; b.lastTelemetryAt=Date.now()-900;
      await m.renewKnob(b);
      const staleStopped = b.activeMotion === null;
      m.parseLine(b, sample(30,5));
      const knobCenterConverted = b.latest.multiTarget === 360;
      b.lastTelemetryAt=Date.now();
      await m.startKnob(b);
      b.sessionId='old'; b.seq=200;
      m.ingestLogs(b,{session_id:'new',logs:[]});
      const reconnectSafe = !b.activeMotion && !b.knobSupported && b.gear === null;
      m.applyMotorProfileUi(b, '36gp555', 5.2);
      m.parseLine(b,'CAPS output_position=1 knob=1 haptic_protocol=1');
      m.parseLine(b,sample(100));
      m.parseLine(b,sample(5));
      const rebootSafe = b.gear === null && !b.knobSupported && b.samples.length === 0;
      document.querySelector('#errorModal').hidden = true;
      // Make a clearly labelled offline screenshot with real source controls.
      m.applyMotorProfileUi(b, '36gp555', 5.2);
      m.parseLine(b,'CAPS output_position=1 knob=1 haptic_protocol=1');
      for (let t=100;t<=10000;t+=10) m.parseLine(b,sample(t));
      m.updateUi(b); m.drawKnobPreview(b);
      Object.entries(b.canvases).forEach(([key,canvas])=>m.drawChart(b,key,canvas));
      document.querySelector('h1').textContent = '离线界面测试 · 非电机实测';
      let csv = '';
      const create = URL.createObjectURL;
      URL.createObjectURL = blob => { if (blob.type.includes('csv')) blob.text().then(s=>csv=s); return create(blob); };
      m.exportCsv(b); await new Promise(r=>setTimeout(r,50));
      URL.createObjectURL = create;
      return {unknownGearBlocked,outputNumbers,legacyCommand,blockedBeforeFlash,newCommand,motorGains,velocityRange,
        degDisplay,changedUnitsNoMutation,powerBlocked,preview,started,renewed,switched,stopped,
        staleStopped,knobCenterConverted,reconnectSafe,rebootSafe,csv};
    });
    for (const key of ['unknownGearBlocked','blockedBeforeFlash','changedUnitsNoMutation','powerBlocked',
      'started','renewed','switched','stopped','staleStopped','knobCenterConverted','reconnectSafe','rebootSafe']) assert(results[key],key);
    assert.equal(results.outputNumbers.angle,360); assert.equal(results.outputNumbers.target,360);
    assert.equal(results.outputNumbers.speed,360); assert.equal(results.outputNumbers.single,0);
    // User-facing values are intentionally compact; charts keep the raw
    // samples while the dashboard shows two decimals consistently.
    assert.equal(results.outputNumbers.displayed,'1.00 圈'); assert.equal(results.degDisplay,'360.00 °');
    assert.equal(results.legacyCommand,'pos 1872 4095 30000');
    assert.equal(results.newCommand,'posout 36000 4095 30000');
    assert(Math.abs(results.motorGains[0]-.0004)<1e-9 &&
      Math.abs(results.motorGains[1]-.008)<1e-9 &&
      // 36GP-555 UI values are output-shaft units; 5400 deg/s is 15 r/s
      // and parameterToMotor applies the 5.2:1 ratio when sending.
      Math.abs(results.motorGains[2]-5400)<1e-3 &&
      Math.abs(results.motorGains[3]-.25)<1e-9);
    assert.deepEqual(results.velocityRange,{min:-5400,max:5400});
    assert.equal(results.preview,-200);
    assert(results.csv.includes('output_multi_deg') && results.csv.includes('gear_ratio'));
    assert(commands.includes('velocity 187.2 4095 3000'));
    const start = commands.findIndex(c=>c.startsWith('knob start '));
    assert(start >= 0);
    // Neither power-off start nor parameter preview sent knob start/keep.
    assert.equal(commands.slice(0,start).filter(c=>c.startsWith('knob config ')).length,1);
    assert(commands.slice(0,start).some(c=>/^knob config \d+ 15 500 /.test(c)), 'explicit knob start must use the 500 mA UI default');
    const vel = commands.indexOf('velocity 187.2 4095 3000');
    assert.equal(commands[vel-1],'stop');
    assert.deepEqual(errors,[]);
    await fs.mkdir(path.join(__dirname,'../evidence/haptic-offline'),{recursive:true});
    await page.screenshot({path:path.join(__dirname,'../evidence/haptic-offline/ui.png')});
    await fs.writeFile(path.join(__dirname,'../evidence/haptic-offline/browser-tests.json'),
      JSON.stringify({offline:true, results, commands, errors},null,2));
    console.log(JSON.stringify({offline:true,...results,csv:results.csv.split('\r\n')[0],commands:commands.length}));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
