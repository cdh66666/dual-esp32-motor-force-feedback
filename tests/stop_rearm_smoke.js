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
    try {
      requests.push(JSON.parse(request.postData() || '{}'));
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  const baseUrl = process.env.MOTOR_DEBUG_URL || 'http://127.0.0.1:8766';
  await page.goto(baseUrl + '/?focus=COM18&v=stop-rearm-smoke', { waitUntil: 'domcontentloaded' });
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
    position: await move('positionTarget', 30, 'pos 30 '),
    velocity: await move('velocityTarget', 300, 'velocity 300 '),
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
  const lastTargetWins = raceCommands.length === 1 &&
    raceCommands[0].startsWith('current 400 ');
  failNextSend = true;
  await page.evaluate(() => {
    const input = document.querySelector('[data-port="COM18"] [data-slider="currentTarget"]');
    input.value = '500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.querySelector('#errorModal')?.hidden);
  const modalText = await page.locator('#errorModal').innerText();
  const blockingModal = modalText.includes('通信失败') && modalText.includes('simulated CDC write timeout');
  await page.locator('#errorClose').click();
  await board.locator('[data-act="stop"]').click();
  await page.waitForTimeout(120);
  const visiblePorts = await page.locator('.board').evaluateAll(items => items.map(item => item.dataset.port));
  await page.screenshot({ path: 'D:/AI_Workspace/apps/dual-esp32-motor-force-feedback/evidence/stop-rearm-smoke.png', fullPage: true });
  await browser.close();

  const result = {
    stopIndex, wakeAfterStop, outputs, lastTargetWins, raceCommands,
    dualVisible: visiblePorts.length >= 2, visiblePorts, blockingModal, modalText,
    requests: requests.map(item => item.command),
  };
  console.log(JSON.stringify(result, null, 2));
  if (stopIndex < 0 || !wakeAfterStop || !lastTargetWins || !blockingModal || visiblePorts.length < 2 ||
      Object.values(outputs).some(value => !value)) process.exitCode = 1;
})();
