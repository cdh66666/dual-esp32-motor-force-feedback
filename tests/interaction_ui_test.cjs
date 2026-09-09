// Run production event branches in isolation. No network or motor IO.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/dashboard.js'),'utf8');
const from=source.indexOf("  if (text.startsWith('CONTROL_WARN '))");
const to=source.indexOf("  if (/^(DIAG|ERR|MODEL|MOTOR_PROFILE",from);
assert(from>0&&to>from);
let stops=0,latest='';
const health={},board={port:'mock',activeMotion:{mode:'current'},root:{}};
const context=vm.createContext({board,$:()=>health,forceSession:{active:true},
  forceState:s=>{latest=s;},stopForceFeedback:async()=>{stops++;},console});
vm.runInContext('function receive(text){'+source.slice(from,to)+'}',context);
for(const reason of ['speed_derating','supply_derating','current_derating']) {
  context.receive('CONTROL_WARN reason='+reason+' gain=0.4');
  assert.equal(health.className,'health warn');
  assert(board.interactionWarning);
  assert.equal(board.activeMotion.mode,'current');
  assert.equal(stops,0);
}
context.receive('CONTROL_WARN reason=clear gain=0.01');
assert.equal(health.className,'health good');
assert.equal(board.interactionWarning,null);
context.receive('ERR usage: knob config');
assert.equal(health.className,'health warn');
assert(board.activeMotion);
context.receive('CONTROL_COMPLETE mode=force reason=session_end');
setImmediate(()=>{
  assert.equal(stops,1);
  assert(latest.includes('非设备故障'));
  assert(source.includes('expectedControl!==1 && Math.abs(b.latest.multi-origin)>25'));
  assert(source.includes('b.interactionGuard===true'));
  console.log('PASS warnings preserve motion; completion stops normally; current identification requires firmware guard');
});
