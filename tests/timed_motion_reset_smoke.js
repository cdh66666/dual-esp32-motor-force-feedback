let chromium;
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const commands = [];

  await page.route('**/api/ports', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ports: [{
      port: 'COM18', description: 'ESP32-S3', hwid: 'USB VID:PID=303A:1001',
      active: true, write_ok: true, esp32: true, present: true,
      reader_alive: true, connected_age_ms: 100, rx_age_ms: 10, telemetry_ok: true,
    }], usb_problems: [] }),
  }));
  await page.route('**/api/logs**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [{
      seq: 1, direction: 'rx', text: 'S,0,0,0,20,0,0,1,1,0,0,0,0,0,0', time: '00:00:00',
    }] }),
  }));
  await page.route('**/api/send', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    commands.push(body.command);
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
    });
  });

  const baseUrl = process.env.MOTOR_DEBUG_URL || 'http://127.0.0.1:8766';
  await page.goto(baseUrl + '/?v=timed-motion-reset-smoke', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.board[data-port="COM18"]');
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
  await move('velocityTarget', 400);
  await page.locator('#resetAll').click();
  await page.waitForTimeout(180);

  const currentTimed = commands.includes('current 500 4095 1000');
  const velocityTimed = commands.includes('velocity 400 4095 3000');
  const resetTail = commands.slice(-3).join('|') === 'stop|recover|status';
  const result = { unit, defaults, currentTimed, velocityTimed, resetTail, commands };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (unit !== 'rev' || defaults.current !== '1' || defaults.velocity !== '3' ||
      !currentTimed || !velocityTimed || !resetTail) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
