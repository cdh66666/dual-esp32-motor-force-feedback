const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/dashboard.js'), 'utf8');
const start = source.indexOf('async function send(');
const end = source.indexOf('\nfunction ', start);
const calls = [];
const context = vm.createContext({
  autoTune: {active: false}, boards: new Map(),
  api: async (_, body) => {calls.push(body); return {acknowledged: true, reply: 'TRACE_META count=160'};},
});
vm.runInContext(source.slice(start, end), context);
(async () => {
  for (const command of ['trace arm 512', 'trace dump']) {
    const response = await context.send('test-only', command);
    assert.equal(calls.at(-1).wait_ack, true);
    assert.equal(typeof response.reply, 'string');
  }
  console.log('PASS: trace arm and dump request acknowledged responses (mock transport only)');
})().catch(error => {console.error(error); process.exitCode = 1;});
