// Offline cross-campaign test. R fixed from prior fit, Ke/drop from steady PWM.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,'evidence',name),'utf8').trim().split(/\r?\n/).map(JSON.parse);
const fixedFile='encoder-fixed-pwm-1788880021448.jsonl',startupFile='startup-pwm-1788880836330.jsonl';
const fixed=read(fixedFile),startup=read(startupFile);
const models=JSON.parse(fs.readFileSync(path.join(root,'evidence/saved-current-validation-1788881164154.json'),'utf8'));
function point(stage,tailMs,R){
 const active=stage.rows.filter(s=>s[5]===stage.duty),last=active.at(-1)?.[0];
 const rows=active.filter(s=>s[0]>=last-tailMs);
 if(rows.length<80)throw Error('Insufficient samples');
 const mean=k=>rows.reduce((a,r)=>a+r[k],0)/rows.length;
 const omega=stage.direction*(rows.at(-1)[2]-rows[0][2])*Math.PI/180/((rows.at(-1)[0]-rows[0][0])/1000);
 const voltage=stage.duty/4095*mean(3),current=stage.direction*mean(4)/1000;
 return {duty:stage.duty,omega,voltage,current,residual:voltage-R*current,samples:rows.length};
}
const reports=[];
for(const model of models)for(const direction of [1,-1]){
 const R=model.calculated.R;
 const train=fixed.filter(s=>s.port===model.port&&s.direction===direction&&s.duty>=246&&s.rows).map(s=>point(s,15000,R));
 const [a,b]=train,Ke=(b.residual-a.residual)/(b.omega-a.omega),drop=a.residual-Ke*a.omega;
 const validation=startup.filter(s=>s.port===model.port&&s.direction===direction&&s.tail?.sustainedLastSecond).map(s=>{
  const p=point(s,1000,R),prediction=R*p.current+Ke*p.omega+drop;
  return {...p,prediction,errorV:prediction-p.voltage,relativeError:Math.abs(prediction-p.voltage)/p.voltage};
 });
 reports.push({port:model.port,direction,R,Ke,drop,priorKe:model.calculated.Ke,train,validation,
  passed:Ke>.0001&&Ke<.2&&drop>=-.05&&validation.length>=3&&validation.every(v=>v.relativeError<=.25)});
}
const source=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function currentTraceMetrics('),source.indexOf('async function runAutoTune(')),ctx);
const commonModels=models.map(model=>{
 const points=reports.filter(r=>r.port===model.port).flatMap(r=>r.train),R=model.calculated.R;
 // Reduced physical model: zero brush intercept, single Ke shared by directions.
 // Only steady training points determine this coefficient.
 const Ke=points.reduce((s,p)=>s+p.omega*p.residual,0)/points.reduce((s,p)=>s+p.omega*p.omega,0);
 const pulses=model.trials.filter(t=>!t.error).map(t=>({...t,samples:t.samples.map(s=>({t:s[0],velocity:s[10]/5.2}))}));
 const rows=ctx.movingElectricalRows(pulses,5.2),coeff=[R,model.calculated.effectiveL,0,Ke];
 const transientValidation=pulses.map((p,i)=>{
  const subset=rows.filter(r=>r.group===i),energy=subset.reduce((s,r)=>s+r.y*r.y,0);
  return {ma:p.ma,relativeError:Math.sqrt(subset.reduce((s,r)=>s+(r.y-r.x.reduce((a,x,j)=>a+x*coeff[j],0))**2,0)/energy)};
 });
 return {port:model.port,R,Ke,drop:0,transientValidation,passed:transientValidation.every(r=>Number.isFinite(r.relativeError)&&r.relativeError<=.25)};
});
const file=path.join(root,'evidence',`steady-ke-${Date.now()}.json`);
fs.writeFileSync(file,JSON.stringify({fixedFile,startupFile,scope:'Exploratory steady-state model; frozen R, only two training speeds per direction; prospective validation required',reports,commonModels},null,2),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({file,commonModels}));
