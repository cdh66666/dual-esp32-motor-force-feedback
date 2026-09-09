// Offline only. Old campaign fits; later campaign is never used for fitting.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),src=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function currentTraceMetrics('),src.indexOf('async function runAutoTune(')),ctx);
const validationFile='evidence/saved-current-validation-1788881164154.json';
const validation=JSON.parse(fs.readFileSync(path.join(root,validationFile),'utf8'));
function score(rows,c){
 if(rows.length<4)throw Error('Insufficient validation coverage');
 const residual=rows.reduce((s,r)=>s+(r.y-r.x.reduce((a,v,i)=>a+v*c[i],0))**2,0);
 const energy=rows.reduce((s,r)=>s+r.y*r.y,0);
 return {samples:rows.length,relativeError:Math.sqrt(residual/energy)};
}
const reports=[];
for(const port of ['COM4','COM23']){
 const trainingFile=`evidence/bounded-identify-${port}-20260908.json`;
 const saved=JSON.parse(fs.readFileSync(path.join(root,trainingFile),'utf8'));
 const trainingRows=ctx.movingElectricalRows(saved.pulses,saved.gear);
 const pulses=validation.find(r=>r.port===port).trials.filter(t=>!t.error).map(t=>({...t,samples:t.samples.map(s=>({t:s[0],velocity:s[10]/saved.gear}))}));
 const validationRows=ctx.movingElectricalRows(pulses,saved.gear);
 for(const direction of [1,-1]){
  const report={port,direction,trainingFile,validationFile};reports.push(report);
  try{
   const rows=trainingRows.filter(r=>Math.sign(saved.pulses[r.group].ma)===direction);
   report.fit=ctx.fitControlRows(rows,'Directional electrical');
   const c=report.fit.coefficients;
   report.physical=!!(c[0]>.05&&c[0]<20&&c[1]>1e-6&&c[1]<.1&&c[2]>=-.05&&c[3]>.0001&&c[3]<.2);
   report.validation=pulses.flatMap((p,i)=>Math.sign(p.ma)===direction?[{ma:p.ma,...score(validationRows.filter(r=>r.group===i),c)}]:[]);
   report.passed=report.physical&&report.validation.length>=2&&report.validation.every(r=>Number.isFinite(r.relativeError)&&r.relativeError<=.25);
  }catch(e){report.error=e.message;report.passed=false;}
 }
}
const file=path.join(root,'evidence',`directional-model-${Date.now()}.json`);
fs.writeFileSync(file,JSON.stringify({scope:'Exploratory offline model comparison; fresh prospective validation still required before adoption',reports},null,2),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({file,reports}));
