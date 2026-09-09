// Model-based cross-check, not an independent tachometer or terminal-voltage measurement.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),input='evidence/encoder-fixed-pwm-1788880021448.jsonl';
const stages=fs.readFileSync(path.join(root,input),'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(s=>s.rows&&s.duty>=246);
const models=JSON.parse(fs.readFileSync(path.join(root,'evidence/saved-current-validation-1788881164154.json'),'utf8'));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function harmonic(values){const m=mean(values),n=values.length;
 const sin=2/n*values.reduce((s,v,i)=>s+(v/m-1)*Math.sin(4*Math.PI*(i+.5)/n),0),cos=2/n*values.reduce((s,v,i)=>s+(v/m-1)*Math.cos(4*Math.PI*(i+.5)/n),0);
 return {mean:m,relativeSecondAmplitude:Math.hypot(sin,cos),phaseRad:Math.atan2(sin,cos)};
}
const reports=stages.map(stage=>{
 const model=models.find(m=>m.port===stage.port).calculated,bins=Array.from({length:36},()=>[]);
 for(let i=1;i<stage.rows.length;i++){
  const a=stage.rows[i-1],b=stage.rows[i],dt=(b[0]-a[0])/1000;
  if(dt<=0||dt>.025||a[5]!==stage.duty||b[5]!==stage.duty||a[0]<stage.rows[0][0]+5000)continue;
  let delta=b[9]-a[9];if(delta>8192)delta-=16384;if(delta< -8192)delta+=16384;
  const angle=((a[9]+delta/2)%16384+16384)%16384;
  bins[Math.floor(angle/16384*36)].push({w:stage.direction*delta*2*Math.PI/16384/dt,
   v:stage.duty/4095*(a[3]+b[3])/2,i:stage.direction*(a[4]+b[4])/2000,di:stage.direction*(b[4]-a[4])/1000/dt});
 }
 const profile=bins.map(rows=>({w:mean(rows.map(r=>r.w)),v:mean(rows.map(r=>r.v)),i:mean(rows.map(r=>r.i)),di:mean(rows.map(r=>r.di))}));
 const encoder=harmonic(profile.map(p=>p.w));
 const estimates=[0,model.effectiveL].map(L=>({R:model.R,L,...harmonic(profile.map(p=>p.v-model.R*p.i-L*p.di))}));
 const sensitivity=[];for(const R of [1,2,4,6])for(const L of [0,.02])sensitivity.push({R,L,...harmonic(profile.map(p=>p.v-R*p.i-L*p.di))});
 return {port:stage.port,direction:stage.direction,duty:stage.duty,minBin:Math.min(...bins.map(b=>b.length)),encoder,estimates,sensitivity,profile};
});
const file=path.join(root,'evidence',`back-emf-periodicity-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify({input,reports,scope:'PWM*VM approximation and filtered current; R/L uncertain, no independent angular reference, no correction applied'},null,2),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({file,reports:reports.map(({profile,sensitivity,...r})=>r)}));
