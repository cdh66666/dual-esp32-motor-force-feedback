// Synthetic identification only; not a hardware-performance test.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/dashboard.js'),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function fitControlRows('),source.indexOf('async function runAutoTune(')),context);
const rows=Array.from({length:48},(_,i)=>{const x=[Math.sin(i),Math.cos(i*.3),i%2?1:-1];return {x,y:3*x[0]+.002*x[1]+.1*x[2]};});
const fit=context.fitControlRows(rows,'synthetic');
assert(Math.abs(fit.coefficients[0]-3)<1e-9);
assert.throws(()=>context.fitControlRows(Array.from({length:20},()=>({x:[1,1,1],y:2})),'singular'));
const pulses=[150,-150,300,-300].map(ma=>{
 const sign=Math.sign(ma),amp=ma/1000,trace=[];
 for(let i=0;i<320;i++)trace.push([i*500,amp,amp*(1-Math.exp(-i*.0005/.012)),0]);
 for(let j=4;j<trace.length;j+=4){const mean=trace.slice(j-4,j).reduce((s,r)=>s+r[2],0)/4,di=(trace[j][2]-trace[j-4][2])/.002;
  for(let k=j-4;k<j;k++)trace[k][3]=(3*mean+.002*di+.1*sign)*4095/20;}
 let v=3*5.2*sign;const samples=[];
 for(let i=0;i<20;i++){
  const current=amp*(1+.08*Math.sin(i));
  if(i>4)v+=.01*(50000*current-2*v-50*sign);
  samples.push({t:i*10,current,velocity:i<4?0:v/5.2});
 }
 return {ma,bus:20,trace,samples};
});
const model=context.calculateThreeLoopModel(pulses,5.2,20);
assert(Math.abs(model.R-3)<1e-6);assert(Math.abs(model.effectiveL-.002)<1e-6);
assert(model.currentKp>0&&model.currentKi>0&&model.candidates.length);
assert(model.candidates.every(c=>c.positionKp>0&&c.velocityKi>0));
assert.throws(()=>context.calculateThreeLoopModel([],5.2,20));
console.log('PASS: effective electrical/mechanical fits, computed three-loop gains, rejection of incomplete and singular models');
