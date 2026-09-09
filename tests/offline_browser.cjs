// Serve real UI files inside Playwright. No HTTP server, device API or serial
// driver is touched, even if a test forgets to mock a newly added endpoint.
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function offlineBrowser(page) {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const files = {'/':'dashboard.html', '/dashboard.js':'dashboard.js',
      '/dashboard.css':'dashboard.css', '/dashboard-cascade.css':'dashboard-cascade.css'};
    if (files[pathname]) {
      const file = files[pathname];
      return route.fulfill({body:await fs.readFile(path.join(__dirname,'../web',file)),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'});
    }
    if (pathname.startsWith('/api/')) return route.fulfill({status:503,contentType:'application/json',
      body:JSON.stringify({ok:false,error:'OFFLINE fixture: endpoint not mocked'})});
    return route.abort();
  });
};
