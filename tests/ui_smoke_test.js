const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  // The dashboard intentionally polls two 100 Hz serial sessions forever,
  // so "networkidle" is not a valid readiness condition.
  const baseUrl = process.env.MOTOR_DEBUG_URL || 'http://127.0.0.1:8766';
  const focus = process.env.MOTOR_DEBUG_FOCUS || '';
  const query = focus ? `/?focus=${encodeURIComponent(focus)}&v=smoke` : '/?v=smoke';
  if (focus) await page.route('**/api/connect', route => route.fulfill({status:200,
    contentType:'application/json', body:JSON.stringify({ok:true})}));
  await page.goto(baseUrl + query, {waitUntil: 'domcontentloaded'});
  await page.click('#advancedToggle');
  await page.waitForSelector('.board');
  await page.waitForTimeout(1800);
  const result = await page.evaluate(() => ({
    title: document.title,
    boards: [...document.querySelectorAll('.board')].map(board => ({
      port: board.dataset.port,
      connected: board.querySelector('[data-connected]')?.textContent,
      samples: board.querySelector('[data-metric="multi"]')?.textContent,
      canvases: [...board.querySelectorAll('canvas')].map(c => [c.width, c.height]),
      buttons: board.querySelectorAll('button').length,
      sliders: board.querySelectorAll('input[type="range"]').length,
    })),
    scripts: document.scripts.length,
  }));
  await page.locator('#stopAll').click();
  await page.screenshot({path: 'D:/AI_Workspace/apps/dual-esp32-motor-force-feedback/evidence/ui-smoke.png', fullPage: true});
  console.log(JSON.stringify({...result, errors}, null, 2));
  await browser.close();
  const checkedBoards = focus ? result.boards.filter(b => b.port.toUpperCase() === focus.toUpperCase()) : result.boards;
  const expectedBoards = focus ? 1 : 2;
  if (errors.length || checkedBoards.length !== expectedBoards || checkedBoards.some(b => b.samples.startsWith('—'))) process.exitCode = 1;
})();
