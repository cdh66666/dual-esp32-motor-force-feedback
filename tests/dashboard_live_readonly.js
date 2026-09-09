// Real telemetry/DOM check. A request guard rejects any actuation/config write.
const assert = require('node:assert/strict');
const path = require('node:path');
let chromium;
try { ({chromium}=require('playwright')); }
catch { ({chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
  const page=await browser.newPage({viewport:{width:1500,height:1120}});
  const errors=[],blocked=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const request=route.request();
    if(request.method()==='POST'){
      const body=request.postDataJSON();
      const readCommand=/^(model|motorprofile status|cascade status|knob status|status|diag|businfo|stream 100)$/;
      if(!request.url().endsWith('/send') || !readCommand.test(body.command||'')){
        blocked.push({url:request.url(),body});
        return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:'Read-only test rejects writes'})});
      }
      writes.push(body.command);
    }
    return route.continue();
  });
  await page.goto('http://127.0.0.1:8766/?focus=COM23&v=readonly-commissioning');
  await page.click('#advancedToggle');
  await page.waitForSelector('[data-port="COM23"] [data-metric="rate"]');
  await page.waitForTimeout(3200);
  const root=page.locator('[data-port="COM23"]');
  const before=writes.length;
  await root.locator('[data-window="positionTarget"]').selectOption('1');
  await page.locator('#unit').selectOption('deg');
  await root.locator('[data-act="clear"]').click();
  await page.waitForTimeout(600);
  const afterView=writes.length;
  const state=await root.evaluate(element=>({
    connected:element.querySelector('[data-connected]').textContent,
    rates:element.querySelector('[data-metric="rate"]').textContent,
    currentKi:element.querySelector('[data-slider="currentKi"]').value,
    velocityMaxCurrent:element.querySelector('[data-slider="velocityMaxCurrent"]').value,
    positionKp:element.querySelector('[data-slider="positionKp"]').value,
    knobStrength:element.querySelector('[data-slider="knobStrength"]').value,
    fineMin:element.querySelector('[data-slider="positionTarget"]').min,
    fineMax:element.querySelector('[data-slider="positionTarget"]').max,
    calibration:element.querySelector('[data-compensation]').textContent,
    canvases:[...element.querySelectorAll('[data-chart] canvas')].map(c=>[c.width,c.height]),
    overflow:document.documentElement.scrollWidth>window.innerWidth+2,
    modal:!document.querySelector('#errorModal').hidden
  }));
  const output=path.resolve(process.env.MOTOR_UI_EVIDENCE || 'evidence/commissioning/20260905-dashboard-live.png');
  await page.screenshot({path:output,fullPage:true});
  assert.equal(blocked.length,0);assert.deepEqual(errors,[]);
  assert.equal(before,afterView,'view changes sent commands');
  assert.match(state.rates,/100\.\d Hz/);
  const readBack=async command => (await (await page.request.post('http://127.0.0.1:8766/api/send',
    {data:{port:'COM23',command,wait_ack:true}})).json()).reply;
  const config=await readBack('cascade status');
  const knob=await readBack('knob status');
  assert.equal(Number(state.currentKi),Number(config.match(/current_hz=\d+ kp=\S+ ki=(\S+)/)[1]));
  assert.equal(Number(state.velocityMaxCurrent),Number(config.match(/max_current=([\d.]+)A/)[1]));
  assert.equal(Number(state.positionKp),Number(config.match(/position_hz=\d+ kp=([\d.]+)/)[1]));
  assert.equal(Number(state.knobStrength),Number(knob.match(/peak_mA=([\d.]+)/)[1]));
  assert(!state.overflow && !state.modal);
  assert(state.canvases.length===5 && state.canvases.every(([w,h])=>w>100&&h>100));
  console.log(JSON.stringify({state,readCommands:writes,errors,blocked,screenshot:output}));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
