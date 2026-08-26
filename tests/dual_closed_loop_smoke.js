const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  const baseUrl = process.env.MOTOR_DEBUG_URL || 'http://127.0.0.1:8766';
  await page.goto(baseUrl + '/?v=dual-loop-smoke', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-connected]')]
    .filter(element => element.textContent.includes('已连接')).length === 2);
  await page.waitForFunction(() => {
    const boards = [...document.querySelectorAll('.board')];
    return boards.length === 2 && boards.every(board => {
      const position = Number.parseFloat(board.querySelector('[data-metric="multi"]')?.textContent ?? '');
      const rate = Number.parseFloat(board.querySelector('[data-metric="rate"]')?.textContent ?? '');
      return Number.isFinite(position) && Number.isFinite(rate) && rate >= 90;
    });
  }, { timeout: 15000 });
  const preflight = await page.evaluate(() => [...document.querySelectorAll('.board')].map(board => ({
    port: board.dataset.port,
    bus: Number.parseFloat(board.querySelector('[data-metric="bus"]')?.textContent ?? ''),
    fault: board.querySelector('[data-metric="fault"]')?.textContent ?? '',
  })));
  if (!preflight.every(board => board.bus >= 6 && board.fault.startsWith('1'))) {
    await page.locator('#stopAll').click();
    await browser.close();
    throw new Error('dual preflight failed: ' + JSON.stringify(preflight));
  }
  await page.locator('[data-act="zero"]').nth(0).click();
  await page.locator('[data-act="zero"]').nth(1).click();
  await page.waitForTimeout(300);

  async function fleetTarget(value) {
    await page.locator('#fleetTarget').evaluate((input, target) => {
      input.value = String(target);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.locator('#fleetSend').click();
  }

  async function snapshot(label) {
    return page.evaluate(name => ({
      label: name,
      boards: [...document.querySelectorAll('.board')].map(board => ({
        port: board.dataset.port,
        position: board.querySelector('[data-metric="multi"]').textContent,
        fault: board.querySelector('[data-metric="fault"]').textContent,
        rate: board.querySelector('[data-metric="rate"]').textContent,
        pwm: board.querySelector('[data-metric="pwm"]').textContent,
      })),
    }), label);
  }

  await fleetTarget(360);
  await page.waitForTimeout(4200);
  const at360 = await snapshot('360deg');
  await fleetTarget(0);
  await page.waitForTimeout(4200);
  const atZero = await snapshot('zero');
  await page.screenshot({ path: 'D:/AI_Workspace/apps/dual-esp32-motor-force-feedback/evidence/dual-closed-loop.png', fullPage: true });
  await page.locator('#stopAll').click();
  console.log(JSON.stringify({ at360, atZero, errors }, null, 2));
  const positions360 = at360.boards.map(board => Number.parseFloat(board.position));
  const positions0 = atZero.boards.map(board => Number.parseFloat(board.position));
  const rates = [...at360.boards, ...atZero.boards].map(board => Number.parseFloat(board.rate));
  const pass = positions360.every(value => Math.abs(value - 360) <= 5) &&
    positions0.every(value => Math.abs(value) <= 5) &&
    rates.every(value => value >= 95 && value <= 105) &&
    [...at360.boards, ...atZero.boards].every(board => board.fault.startsWith('1')) &&
    errors.length === 0;
  await browser.close();
  if (!pass) throw new Error('dual closed-loop acceptance failed');
})();
