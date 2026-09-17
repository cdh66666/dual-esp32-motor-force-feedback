const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requests = [];
  let failNextSend = false;
  // This is an interaction/state-machine test, not a motor test. Intercept
  // actuator writes so the smoke test can never energise attached hardware.
  await page.route('**/api/send', async route => {
    const request = route.request();
    let payload = {};
    try {
      payload = JSON.parse(request.postData() || '{}');
      requests.push(payload);
    } catch (_) {}
    if (failNextSend) {
      failNextSend = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'simulated CDC write timeout' }),
      });
      return;
    }
    const command = payload.command || '';
    const reply = command === 'stop' ? 'OK stop' : command === 'wake' ? 'OK driver_awake=1' :
      command === 'sleep' ? 'OK driver_awake=0' : command === 'model' ? 'MODEL fw=fixture' :
      command === 'motorprofile status' ? 'MOTOR_PROFILE id=36gp555-24v-1538rpm gear=5.2 bus=20V voltage_pwm_limit=4095/4095' :
      command === 'cascade status' ? 'CASCADE_CFG current_hz=2000 kp=400 ki=1800 max_pwm=4095 velocity_hz=500 kp=0.0005 ki=0.001 max_current=0.6A friction=0 position_hz=200 kp=4 ki=0 kd=0.25 max_velocity=5400' :
      command === 'knob status' ? 'KNOB_CFG active=0 effect=0 spacing_out_deg=15 peak_mA=500 damping_mA_per_out_dps=1 range_out_deg=90 origin_out_deg=0' : 'OK';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, acknowledged: true, reply }),
    });
  });
  // Keep this smoke test deterministic and completely offline: the browser
  // still loads the real dashboard, but its port/log/event feeds are fixed
  // fixtures so it never depends on whichever COM names happen to be plugged
  // in on the host.
  const fixturePorts = [
    {port:'COM18', description:'mock upper', hwid:'USB MOCK COM18', active:true,
      write_ok:true, esp32:true, present:true, reader_alive:true, rx_age_ms:0,
      connected_age_ms:100, telemetry_ok:true},
    {port:'COM23', description:'mock lower', hwid:'USB MOCK COM23', active:true,
      write_ok:true, esp32:true, present:true, reader_alive:true, rx_age_ms:0,
      connected_age_ms:100, telemetry_ok:true},
  ];
  await page.route('**/api/ports', route => route.fulfill({status:200,
    contentType:'application/json', body:JSON.stringify({ports:fixturePorts,usb_problems:[]})}));
  await page.route('**/api/events**', route => route.fulfill({status:503,body:''}));
  const fixtureLogs = [
    {seq:1, direction:'rx', text:'MOTOR_PROFILE id=36gp555-24v-1538rpm gear=5.2 bus=20V voltage_pwm_limit=4095/4095'},
    {seq:2, direction:'rx', text:'CAPS output_position=1 knob=1 haptic_protocol=1 interaction_guard=1'},
    {seq:3, direction:'rx', text:'S,10,72,1872,20,0,0,1,1,3,3276,0,3,1872,1,0,0,0,0,1,1872,0,0,0,0'},
  ];
  let fixtureSeq=3, fixtureTime=10;
  await page.route('**/api/logs**', route => {
    fixtureSeq += 1; fixtureTime += 100;
    fixtureLogs.push({seq:fixtureSeq, direction:'rx',
      text:`S,${fixtureTime},72,1872,20,0,0,1,1,3,3276,0,3,1872,1,0,0,0,0,1,1872,0,0,0,0`});
    return route.fulfill({status:200, contentType:'application/json',
      body:JSON.stringify({logs:fixtureLogs,session_id:'stop-rearm-fixture'})});
  });
  await page.route('**/api/capabilities', route => route.fulfill({status:200,
    contentType:'application/json', body:JSON.stringify({phone_handoff:false})}));

  const baseUrl = process.env.MOTOR_DEBUG_URL || 'http://127.0.0.1:8766';
  await page.goto(baseUrl + '/?focus=COM18&v=stop-rearm-smoke', { waitUntil: 'domcontentloaded' });
  await page.click('#advancedToggle');
  await page.waitForSelector('.board[data-port="COM18"]');
  await page.waitForFunction(() => document.querySelectorAll('.board').length >= 2);
  await page.waitForFunction(() => {
    const text = document.querySelector('.board[data-port="COM18"] [data-connected]')?.textContent || '';
    return text.includes('已连接');
  }, null, { timeout: 8000 });
  const board = page.locator('.board[data-port="COM18"]');

  await board.locator('[data-act="stop"]').click();
  await page.waitForTimeout(220);
  const stopIndex = requests.findIndex(item => item.port === 'COM18' && item.command === 'stop');
  const wakeAfterStop = requests.slice(Math.max(0, stopIndex)).some(item => item.command === 'wake');

  async function move(slider, value, commandPrefix) {
    await page.evaluate(({ slider, value }) => {
      const input = document.querySelector(`[data-port="COM18"] [data-slider="${slider}"]`);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { slider, value });
    await page.waitForTimeout(320);
    return requests.some(item => item.port === 'COM18' && item.command?.startsWith(commandPrefix));
  }

  const outputs = {
    position: await move('positionTarget', 30, 'posout 30 '),
    velocity: await move('velocityTarget', 300, 'velocity 1560 '),
    current: await move('currentTarget', 300, 'current 300 '),
  };
  const raceStart = requests.length;
  for (const [slider, value] of [
    ['positionTarget', 40], ['velocityTarget', 400], ['currentTarget', 400],
  ]) {
    await page.evaluate(({ slider, value }) => {
      const input = document.querySelector(`[data-port="COM18"] [data-slider="${slider}"]`);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { slider, value });
    await page.waitForTimeout(10);
  }
  await page.waitForTimeout(280);
  const raceCommands = requests.slice(raceStart)
    .map(item => item.command)
    .filter(command => /^(pos|velocity|current) /.test(command || ''));
  // A command already in flight may complete before the newer slider value
  // arrives; the important invariant is that the final queued target wins and
  // no older position command is sent after the three-slider burst.
  const lastTargetWins = raceCommands.length >= 1 &&
    raceCommands.at(-1).startsWith('current 400 ') &&
    !raceCommands.slice(-1)[0].startsWith('pos');
  failNextSend = true;
  await page.evaluate(() => {
    const input = document.querySelector('[data-port="COM18"] [data-slider="currentTarget"]');
    input.value = '500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.querySelector('#errorModal')?.hidden ||
    !document.querySelector('[data-port="COM18"] [data-link-issue]')?.hidden);
  const modalText = await page.locator('#errorModal').innerText();
  const blockingModal = modalText.includes('通信失败') && modalText.includes('simulated CDC write timeout');
  const linkIssueText = await page.locator('[data-port="COM18"] [data-link-issue]').innerText();
  const inlineIssue = !await page.locator('[data-port="COM18"] [data-link-issue]').getAttribute('hidden') &&
    linkIssueText.includes('simulated CDC write timeout');
  if (blockingModal) await page.locator('#errorClose').click();
  await board.locator('[data-act="stop"]').click();
  await page.waitForTimeout(120);
  const visiblePorts = await page.locator('.board').evaluateAll(items => items.map(item => item.dataset.port));
  await page.screenshot({ path: 'D:/AI_Workspace/apps/dual-esp32-motor-force-feedback/evidence/stop-rearm-smoke.png', fullPage: true });
  await browser.close();

  const result = {
    stopIndex, wakeAfterStop, outputs, lastTargetWins, raceCommands,
    dualVisible: visiblePorts.length >= 2, visiblePorts, blockingModal, inlineIssue, modalText,
    requests: requests.map(item => item.command),
  };
  console.log(JSON.stringify(result, null, 2));
  if (stopIndex < 0 || !wakeAfterStop || !lastTargetWins || (!blockingModal && !inlineIssue) || visiblePorts.length < 2 ||
      Object.values(outputs).some(value => !value)) process.exitCode = 1;
})();
