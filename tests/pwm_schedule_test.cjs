const assert=require('node:assert/strict');
const test=require('node:test');
const {stage}=require('../tools/encoder_fixed_pwm.cjs');
test('invalid schedules rejected before any hardware request',async()=>{
 for(const schedule of [[],[225,205],[246,246],[246,369],[246,0]]){
  await assert.rejects(stage({port:'NO_HARDWARE'},246,1,14000,schedule),/Invalid descending schedule/);
 }
 await assert.rejects(stage({port:'NO_HARDWARE'},400,1,14000),/Invalid bounded/);
});
