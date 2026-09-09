// Replays saved hardware data; never sends commands to a motor.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/dashboard.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function fitControlRows('), source.indexOf('async function runAutoTune(')), context);
const reports = JSON.parse(fs.readFileSync(path.join(__dirname, '../evidence/autotune-powered-20260908.json'), 'utf8'));
for (const report of reports) {
  assert.equal(report.pulses.length, 4);
  const expected=report.port==='COM4'?/机械模型：有效样本不足/:/电气模型：留出样本相对误差/;
  assert.throws(() => context.calculateThreeLoopModel(report.pulses, report.gear, report.pulses[0].bus), expected);
  if(report.port==='COM4') {
    const fit=context.fitControlRows(context.movingElectricalRows(report.pulses,report.gear),'motion');
    assert(fit.samples>80 && fit.relativeError<.05);
    assert(fit.coefficients.every(x=>x>0));
  }
  console.log(JSON.stringify({port:report.port, accepted:false, pulses:report.pulses.map(p => ({ma:p.ma, traceCount:p.trace.length, peakMeasuredA:Math.max(...p.trace.map(r=>Math.abs(r[2]))), nearStationary40ms:p.samples.filter(s=>s.t-p.samples[0].t<40).every(s=>Math.abs(s.velocity)<5)}))}));
}
console.log('PASS: real-data replay reproduces rejection; no unsupported gains adopted');
