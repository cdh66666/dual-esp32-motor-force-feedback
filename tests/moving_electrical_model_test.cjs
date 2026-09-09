const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function fitControlRows('),source.indexOf('async function runAutoTune(')),ctx);
const gear=5.2,R=3,L=.002,drop=.1,Ke=.025;
const pulses=[150,-150,300,-300].map((ma,g)=>{
  const sign=Math.sign(ma),base=1000000+g*1000000;
  const speed=t=>sign*(10+(30+g*10)*t);
  const samples=Array.from({length:21},(_,i)=>({t:base/1000+i*10,velocity:speed(i*.01)/gear*180/Math.PI}));
  const trace=Array.from({length:401},(_,i)=>[base+i*500,ma/1000,ma/1000*(1-Math.exp(-i*.0005/.02))+.01*Math.sin(i*.1),0]);
  for(let i=1;i<trace.length;i++) {
    const a=trace[i-1],b=trace[i];
    b[3]=(R*(a[2]+b[2])/2+L*(b[2]-a[2])/.0005+drop*sign+Ke*speed((i-.5)*.0005))*4095/20;
  }
  return {ma,bus:20,samples,trace};
});
const rows=ctx.movingElectricalRows(pulses,gear),fit=ctx.fitControlRows(rows,'synthetic moving');
for(const [i,value] of [R,L,drop,Ke].entries())assert(Math.abs(fit.coefficients[i]-value)<1e-7);
assert(fit.relativeError<1e-7);
const synced=pulses.map((p,g)=>({...p,trace:p.trace.map(r=>{
  const t=(r[0]-(1000000+g*1000000))/1e6;
  return [...r,0,Math.sign(p.ma)*(10+(30+g*10)*t)*180/Math.PI,500,20];
})}));
const syncFit=ctx.fitControlRows(ctx.movingElectricalRows(synced,gear),'sync');
for(const [i,value] of [R,L,drop,Ke].entries())assert(Math.abs(syncFit.coefficients[i]-value)<1e-7);
const stale=synced.map(p=>({...p,trace:p.trace.map(r=>r.map((v,i)=>i===6?10000:v))}));
assert.equal(ctx.movingElectricalRows(stale,gear).length,0,'stale encoder must not fall back to interpolated USB speed');
const shifted=pulses.map(p=>({...p,samples:p.samples.map(s=>({...s,t:s.t+10000}))}));
assert.equal(ctx.movingElectricalRows(shifted,gear).length,0,'must not extrapolate mismatched clocks');
const bad=JSON.parse(JSON.stringify(pulses));bad[0].samples[1].t=bad[0].samples[0].t;
assert.throws(()=>ctx.movingElectricalRows(bad,gear),/时间戳无效/);
console.log('PASS: moving R/L/Ke fit, rotor units, clock alignment, no extrapolation');
