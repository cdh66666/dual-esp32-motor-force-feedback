const assert=require('node:assert/strict');
const {restoreStoppedConfiguration}=require('../tools/restore_stopped_configuration.cjs');
const velocity='cascade velocity 0.0008 0.016 0.6 0 80 1',comp='cascade cogging enable 1 0.137 -0.0121';
async function scenario(failure,commands=[velocity,comp]) {
  const calls=[];
  const result=await restoreStoppedConfiguration(async(port,command)=>{
    assert.equal(port,'mock');calls.push(command);
    if(command===failure)throw Error('injected failure');
    return command==='stop'?'OK stop':command==='status'?'STATUS control=idle pwm=0/4095':'OK config';
  },'mock',commands);
  return {calls,result};
}
(async()=>{
  let x=await scenario(null);assert(x.result.ok);assert.deepEqual(x.calls,['stop',velocity,comp,'status']);
  x=await scenario(velocity);assert(!x.result.ok);assert(x.calls.includes(comp),'later restore must still run');assert(x.calls.includes('status'));
  x=await scenario('stop');assert(!x.result.ok);assert.deepEqual(x.calls,['stop','status'],'uncertain stop must not mutate gains');
  x=await scenario('status');assert(!x.result.ok);
  x=await scenario(null,['current 100 900 200',comp]);assert(!x.result.ok);assert(!x.calls.includes('current 100 900 200'));
  console.log('PASS: all rollback branches, STOP gating, no motion, final-state evidence (mock IO)');
})().catch(e=>{console.error(e);process.exitCode=1;});
