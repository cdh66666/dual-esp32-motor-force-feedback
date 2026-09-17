const assert = require('node:assert/strict');
const {motionSummary, assertMotionQuality} = require('../tools/verify_single_usb_pair_step.cjs');

const point = (positionOutputDeg) => ({
  positionOutputDeg,
  velocityOutputRps: 0,
  currentA: 0.1,
  busV: 24,
});

const forward = motionSummary([point(0), point(45), point(45.2)], 0, 45, true);
assert.ok(Math.abs(forward.overshootDeg - 0.2) < 1e-9);
assert.doesNotThrow(() => assertMotionQuality(forward, 'forward'));

const reverse = motionSummary([point(45), point(0), point(-0.5)], 45, 0, true);
assert.equal(reverse.overshootDeg, 0.5);
assert.doesNotThrow(() => assertMotionQuality(reverse, 'reverse'));

const overshot = motionSummary([point(45), point(0), point(-0.501)], 45, 0, true);
assert.throws(() => assertMotionQuality(overshot, 'reverse'), /overshoot/);

const unsettled = motionSummary([point(45), point(12)], 45, 0, false);
assert.throws(() => assertMotionQuality(unsettled, 'reverse'), /did not settle/);

console.log('PASS: single-USB motion acceptance rejects unsettled or >0.5-degree overshoot traces');
