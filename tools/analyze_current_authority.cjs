// Offline only: no transport import, no motor access. Historical files remain unchanged.
const fs=require('node:fs');
const pulses=JSON.parse(fs.readFileSync('evidence/basic-current-1788922014858.json','utf8'));
const fits=JSON.parse(fs.readFileSync('evidence/steady-ke-1788882856743.json','utf8'));
const motion=JSON.parse(fs.readFileSync('evidence/full-range-retarget-1789369982777.json','utf8'));
const rms=a=>Math.sqrt(a.reduce((s,x)=>s+x*x,0)/Math.max(1,a.length));
const report={scope:'Historical data and analytic counterexample only; not closed-loop hardware acceptance',pulseCoverage:[],historicalFits:[],feedforwardReplay:[],counterexample:{}};
for(const b of pulses.boards){
 const traces=b.candidates.flatMap(c=>c.trials).flatMap(t=>t.trace||[]);
 report.pulseCoverage.push({port:b.port,maxOutputRps:Math.max(...traces.map(s=>Math.abs(s[5])/1872)),samples:traces.length});
}
for(const f of fits.reports)report.historicalFits.push({port:f.port,direction:f.direction,Ke:f.Ke,R:f.R,passed:f.passed,maxTrainingRotorRadS:Math.max(...f.train.map(t=>t.omega)),note:'Old low-speed effective fit; not certified after magnet remount or at 8 r/s'});
for(const b of motion.trials){
 let smoothed=b.rows[0].rps,previous=null,rawSteps=[],filteredSteps=[];
 for(const r of b.rows){
  if(previous){
   const dt=(r.mcuMs-previous.mcuMs)/1000;
   if(dt>0&&dt<.1){
    const before=smoothed;
    smoothed+=(r.rps-smoothed)*(-Math.expm1(-dt/.010));
    if(Math.abs(r.velocityRefRps)===8&&r.velocityRefRps===previous.velocityRefRps&&Math.abs((r.travelRps??0)-r.velocityRefRps)<.5){
     const voltsPerOutputRps=5.2*2*Math.PI*.011;
     rawSteps.push((r.rps-previous.rps)*voltsPerOutputRps);
     filteredSteps.push((smoothed-before)*voltsPerOutputRps);
    }
   }
  }
  previous=r;
 }
 report.feedforwardReplay.push({port:b.port,samples:rawSteps.length,rawVoltageStepRms:rms(rawSteps),filteredVoltageStepRms:rms(filteredSteps),scope:'100 Hz replay of FF only; cannot infer real current ripple or stability'});
}
// Illustrative mismatch, not an assertion that the old fit is the present motor.
const omega=8*5.2*2*Math.PI,modelKe=.011,exampleKe=.026,current=.15;
report.counterexample={outputRps:8,modelKe,exampleKe,modelUpperVoltage:modelKe*omega+2*1.2,exampleNeededVoltage:exampleKe*omega+3.3*current,busVoltage:19.5,note:'If this mismatch exists, voltage is physically available but the old model envelope excludes it.'};
console.log(JSON.stringify(report,null,2));
