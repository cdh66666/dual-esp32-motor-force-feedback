// Serve real UI files inside Playwright. No HTTP server, device API or serial
// driver is touched. API requests fall through so each test can install its
// own response fixture; an unmocked request then fails against the isolated
// test origin rather than reaching the live debugger.
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function offlineBrowser(page) {
  const files = {'/':'dashboard.html', '/dashboard.js':'dashboard.js', '/chain-panel.js':'chain-panel.js', '/gateway-transport.js':'gateway-transport.js', '/usb-chain-transport.js':'usb-chain-transport.js', '/remote-motion-lease.js':'remote-motion-lease.js',
    '/dashboard.css':'dashboard.css', '/dashboard-cascade.css':'dashboard-cascade.css'};
  // Register only static asset routes.  A catch-all route registered here
  // would win over a test's later /api/** fixture in Playwright, preventing
  // the fixture from supplying its fake port list.
  const fulfillFile = file => async route => route.fulfill({
    body: await fs.readFile(path.join(__dirname,'../web',file)),
    contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
  });
  // A literal root route is needed because a URL query is not matched by the
  // generic ``**/`` pattern in all Playwright versions used on this machine.
  await page.route('http://127.0.0.1:18766/', fulfillFile('dashboard.html'));
  await page.route('http://127.0.0.1:18766/?*', fulfillFile('dashboard.html'));
  for (const [pathname,file] of Object.entries(files)) {
    if (pathname === '/') continue;
    // ``*`` also covers the cache-busting query used by dashboard.html.
    const pattern = `**${pathname}*`;
    await page.route(pattern, fulfillFile(file));
  }
};
