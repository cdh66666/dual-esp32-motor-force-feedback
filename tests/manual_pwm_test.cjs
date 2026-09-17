// Real runMotion function with fake transport: never opens a serial port.
const assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync('web/dashboard.js','utf8');
const forceSession={active:false},wifiTransport=null,$=()=>({disabled:false}),gearOf=()=>5.2;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),fmt=String;
const commands=[],ready=[];
const send=async(port,command)=>commands.push(command);
const ensureReady=async(board,configure)=>ready.push(configure);
eval(source.slice(source.indexOf('async function runMotion('),source.indexOf('async function renewMotion(')));
(async()=>{
 const board={port:'FAKE',active:true,motionGeneration:0,lastTelemetryAt:Date.now(),latest:{bus:20,fault:1}};
 for(const value of [4095,-2047.5,0,9999])await runMotion(board,'pwm',value);
 assert.deepEqual(commands,['cw 4095 1000','ccw 2047 1000','stop','cw 4095 1000']);
 assert(ready.every(v=>v===false),'PWM must not apply cascade configuration');
 assert.equal(board.activeMotion.timeoutMs,1000);
 const n=commands.length;
 await runMotion(board,'pwm',100,99);assert.equal(commands.length,n);
 board.lastTelemetryAt=0;
 await assert.rejects(()=>runMotion(board,'pwm',100),/遥测/);
 console.log('PASS PWM: direct signed duty, zero STOP, clamp, no cascade, stale/generation guards');
})().catch(e=>{console.error(e);process.exitCode=1;});
