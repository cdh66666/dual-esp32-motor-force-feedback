// Independent campaign prediction: never refits coefficients on validation data.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),src=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function currentTraceMetrics('),src.indexOf('async function runAutoTune(')),ctx);
const input=process.argv[2]||'evidence/saved-current-validation-1788881164154.json';
const reports=JSON.parse(fs.readFileSync(path.resolve(root,input),'utf8'));
function score(rows,c){
 const mse=rows.reduce((sum,r)=>sum+(r.y-r.x.reduce((a,v,i)=>a+v*c[i],0))**2,0)/rows.length;
 const energy=rows.reduce((sum,r)=>sum+r.y*r.y,0)/rows.length;
 return {samples:rows.length,rmsVoltage:Math.sqrt(mse),relativeError:Math.sqrt(mse/energy)};
}
const result=reports.filter(b=>b.calculated).map(b=>{
 const pulses=b.trials.filter(t=>!t.error).map(t=>({...t,samples:t.samples.map(s=>({t:s[0],velocity:s[10]/5.2}))}));
 const rows=ctx.movingElectricalRows(pulses,5.2),c=b.calculated;
 return {port:b.port,completedPulses:pulses.length,independentModelPrediction:score(rows,[c.R,c.effectiveL,c.voltageDrop,c.Ke]),
  byPulse:pulses.map((p,i)=>({ma:p.ma,...score(rows.filter(r=>r.group===i),[c.R,c.effectiveL,c.voltageDrop,c.Ke])})),
  scope:'New campaign voltage prediction with frozen prior coefficients; excludes aborted pulses; no hardware writes'};
});
const out=path.join(root,'evidence',`electrical-holdout-${Date.now()}.json`);
fs.writeFileSync(out,JSON.stringify({input,result},null,2),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({file:out,result}));
