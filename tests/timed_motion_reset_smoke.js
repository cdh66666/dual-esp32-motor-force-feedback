let chromium, activeBrowser;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  activeBrowser = browser;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const commands = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await require('./offline_browser.cjs')(page);
  // Never touch live serial sessions from a browser fixture.
  await page.route('**/api/events**', route => route.fulfill({status: 503, body: ''}));

  await page.route('**/api/ports', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ports: [{
      port: 'COM18', description: 'ESP32-S3', hwid: 'USB VID:PID=303A:1001',
      active: true, write_ok: true, esp32: true, present: true,
      reader_alive: true, connected_age_ms: 100, rx_age_ms: 10, telemetry_ok: true,
    }], usb_problems: [] }),
  }));
  let seq = 0;
  await page.route('**/api/logs**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [{
      seq: ++seq, direction: 'rx', text: 'MOTOR_PROFILE id=36gp555-24v-1538rpm gear=5.2 voltage_pwm_limit=4095/4095', time: '00:00:00',
    }, {
      seq: ++seq, direction: 'rx', text: 'S,' + (seq * 10) + ',0,0,20,0,0,1,1,0,0,0,0,0,0', time: '00:00:00',
    }], session_id: 'mock-one' }),
  }));
  await page.route('**/api/send', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    commands.push(body.command);
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, acknowledged: true, reply: 'MOCK ONLY' }),
    });
  });

  const baseUrl = 'http://127.0.0.1:18766';
  await page.goto(baseUrl + '/?v=timed-motion-reset-smoke', { waitUntil: 'domcontentloaded' });
  await page.click('#advancedToggle');
  await page.waitForSelector('.board[data-port="COM18"]');
  await page.waitForFunction(() => document.querySelector('[data-metric="bus"]')?.textContent.includes('20.00'));
  const unit = await page.locator('#unit').inputValue();
  const defaults = await page.evaluate(() => ({
    current: document.querySelector('[data-slider="currentDuration"]').value,
    velocity: document.querySelector('[data-slider="velocityDuration"]').value,
  }));

  async function move(name, value) {
    await page.evaluate(({ name, value }) => {
      const input = document.querySelector(`[data-slider="${name}"]`);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { name, value });
    await page.waitForTimeout(260);
  }

  await move('currentTarget', 500);
  await move('velocityTarget', 300);
  await page.locator('#resetAll').click();
  await page.waitForTimeout(180);

  const currentTimed = commands.includes('current 500 4095 1000');
  const velocityTimed = commands.includes('velocity 1560 4095 3000');
  const resetTail = commands.slice(-3).join('|') === 'stop|recover|status';
  const profileSafe = commands.includes('cascade current 600 600000 4095') &&
    commands.some(command => command.startsWith('cascade velocity 0.0004 0.008 ')) &&
    commands.some(command => command.startsWith('cascade position 12 0 0.15 ')) &&
    commands.includes('cascade hold on');
  const beforeViewChange = commands.length;
  await page.locator('[data-window="positionTarget"]').selectOption('1');
  await page.locator('[data-window="velocityTarget"]').selectOption('36');
  await page.locator('#unit').selectOption('deg');
  await page.waitForTimeout(260);
  const viewOnly = commands.length === beforeViewChange;
  if (!viewOnly) throw new Error('Changing display units/ranges must not energise the motor');
  const beforeDrag = commands.length;
  await page.evaluate(async () => {
    const input = document.querySelector('[data-slider="velocityTarget"]');
    for (let n=0;n<30;n++) {
      input.value = String(n);
      input.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r=>setTimeout(r,10));
    }
  });
  const duringDragCommands = commands.slice(beforeDrag).filter(c=>c.startsWith('velocity ')).length;
  if (duringDragCommands < 3) throw new Error('Dragging must send continuous targets, not debounce until release');
  await page.locator('#stopAll').click();
  await page.waitForTimeout(120);
  const lastStop = commands.lastIndexOf('stop');
  if (commands.slice(lastStop+1).some(c=>/^velocity |^current |^pos/.test(c))) throw new Error('STOP must cancel unsent drag targets');
  const result = { unit, defaults, currentTimed, velocityTimed, resetTail, profileSafe, viewOnly, duringDragCommands, errors, commands };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (unit !== 'rev' || defaults.current !== '1' || defaults.velocity !== '3' ||
      !currentTimed || !velocityTimed || !resetTail || !profileSafe || errors.length) process.exitCode = 1;
})().catch(async error => {
  console.error(error);
  if (activeBrowser) await activeBrowser.close();
  process.exitCode = 1;
});
