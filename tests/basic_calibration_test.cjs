// Pure mocked command transport; never connects to hardware.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/dashboard.js','utf8');
const code=source.slice(source.indexOf('async function runBasicCalibration()'),source.indexOf("$('#identifyCapture').addEventListener('click'"));
async function scenario(cancel){
 const autoTune={active:false,cancelled:false},commands=[],nodes={};
 const board={port:'A',active:true,motionGeneration:0,activeMotion:{mode:'position'}};
 const context=vm.createContext({autoTune,boards:new Map([['A',board]]),
  $:id=>nodes[id]??(nodes[id]={}),clearMotionTimers:()=>{},pause:async()=>{},
  quickStop:async(p,owner)=>assert.equal(owner,autoTune),
  stopForceFeedback:async owner=>assert.equal(owner,autoTune),
  send:async(port,cmd,owner)=>{
   assert.equal(owner,autoTune);commands.push(cmd);
   if(cancel&&cmd==='sleep')autoTune.cancelled=true;
   return {reply:cmd==='status'?'STATUS pwm=0/4095 control=idle':'OK'};
  }});
 vm.runInContext(code,context);
 if(cancel)await assert.rejects(context.runBasicCalibration(),/校准已取消/);
 else await context.runBasicCalibration();
 assert.equal(board.activeMotion,null);assert.equal(autoTune.active,false);
 assert.deepEqual(commands.slice(-2),['stop','sleep']);
 assert.equal(commands.includes('wake'),!cancel);
 assert(!commands.some(c=>/^(pos|current|velocity|cascade|motorprofile set)/.test(c)));
}
(async()=>{await scenario(false);await scenario(true);console.log('PASS basic calibration: no motion, preserve settings, cancellation before wake, final stop/sleep');})().catch(e=>{console.error(e);process.exitCode=1;});
