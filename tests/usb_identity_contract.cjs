const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/dashboard.js','utf8');
const code=source.slice(source.indexOf('function usbBoardIdentity('),source.indexOf('function setSlider('));
let closed=0,removed=0,cleared=0,quickStops=0,forceStops=0;
const element=()=>({classList:{toggle(){},remove(){}},addEventListener(){},remove(){removed++},insertAdjacentHTML(){}});
const boards=new Map();
const context=vm.createContext({boards,quickRun:null,forceSession:{active:false,boards:[]},
 clearMotionTimers(){cleared++},quickStop:async()=>{quickStops++},stopForceFeedback:async()=>{forceStops++},
 initialBoard:port=>({port,root:element(),motionGeneration:0,timers:{},seq:0}),
 boardHtml:()=>'',bindBoard(){},$:()=>element(),clearTimeout(){},reportLinkIssue(){}});
vm.runInContext(code,context);
const info=(port,serial,extra='')=>({port,hwid:`USB VID:PID=303A:1001 SER=${serial} ${extra}`,active:true,write_ok:true,telemetry_ok:true,rx_age_ms:1});
const old=context.ensureBoard(info('COM4','68EE8F5381E4'));
old.events={close(){closed++}};old.activeMotion='position';old.motorProfile={old:true};
context.quickRun={targets:[old]};context.forceSession={active:true,boards:[old]};
const fresh=context.ensureBoard(info('COM30','68EE8F5381E4','LOCATION=1-8'));
assert.equal(boards.size,1);assert.equal(boards.has('COM4'),false);assert.equal(old.retired,true);
assert.equal(closed,1);assert.equal(removed,1);assert.equal(cleared,1);
assert.equal(quickStops,1);assert.equal(forceStops,1);
assert.equal(fresh.driverReady,false);assert.equal(fresh.motorProfile,undefined);assert.equal(fresh.activeMotion,undefined);
assert.equal(context.ensureBoard(info('COM30','68EE8F5381E4','LOCATION=2-3')),fresh);
const replacement=context.ensureBoard(info('COM30','68EE8F52A79C'));
assert.notEqual(replacement,fresh);assert.equal(fresh.retired,true);assert.equal(boards.size,1);
context.ensureBoard(info('COM31','68EE8F5381E4'));assert.equal(boards.size,2);
assert.equal(context.usbBoardIdentity({hwid:'USB no serial'}),null);
console.log('PASS USB identity migration, same-port replacement, location independence, no stale motion/profile reuse');
