// Production orchestrator, all transport and DOM mocked; never sends hardware IO.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/dashboard.js'),'utf8');
const code=source.slice(source.indexOf('async function runAutoTune('),source.indexOf("$('#autoTune').addEventListener"));
const board=p=>({port:p,active:true,motorProfile:'36gp555',lastTelemetryAt:Date.now(),latest:{bus:20,fault:1,multi:0,t:0},positionAcceleration:40000,positionHold:true});
const boards=new Map(['A','B'].map(p=>[p,board(p)])),commands=[];
const state={active:false,cancelled:false,reports:[]};
const ctx=vm.createContext({boards,autoTune:state,Date,Math,JSON,Number,Error,
  formatAutoReport:JSON.stringify,
  document:{body:{classList:{add(){},remove(){}}}},$:()=>({}),
  localStorage:{setItem(){},removeItem(){}},stopForceFeedback:async()=>{},
  gearOf:()=>5.2,parseLine:(b)=>{b.interactionGuard=true;},valueOf:()=>1,parameterToMotor:()=>1,
  waitUntil:async predicate=>{assert(predicate());},
  send:async(port,command)=>{
    commands.push([port,command]);
    if(command==='model')boards.get(port).interactionGuard=true;
    if(command==='cascade status')boards.get(port).rotorCompensation={scale:1,coulomb:.137,offset:-.0121};
    if(command.startsWith('cascade current ')) state.cancelled=true;
    return {reply:'CASCADE_CFG breakaway=0.2A/30ms retry=120ms speed=20deg/s ramp=2A/s'};
  }
});
vm.runInContext(code,ctx);
(async()=>{
  await assert.rejects(ctx.runAutoTune(),/取消/);
  assert.equal(state.active,false);
  assert(!commands.some(([,c])=>c.startsWith('current ')),'cancel must prevent next movement');
  assert(commands.some(([p,c])=>p==='A'&&c.startsWith('cascade position ')),'rollback position');
  assert(commands.some(([p,c])=>p==='A'&&c.startsWith('cascade velocity ')),'rollback velocity');
  assert(commands.some(([p,c])=>p==='A'&&c==='cascade cogging enable 1 0.137 -0.0121'),'rollback original compensation');
  for(const port of ['A','B']) assert(commands.some(([p,c])=>p===port&&c==='stop'));
  console.log('PASS: cancel before motion, restore gains, stop both boards, release UI ownership');
})().catch(e=>{console.error(e);process.exitCode=1;});
