// Offline phase coherence check. No sensor correction or hardware writes.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),input='evidence/encoder-fixed-pwm-1788880021448.jsonl';
const stages=fs.readFileSync(path.join(root,input),'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(s=>s.rows&&s.duty>=246);
const rawInterval=process.argv.includes('--raw-interval');
if(rawInterval)for(const stage of stages){
 const transformed=[];
 for(let i=1;i<stage.rows.length;i++){
  const a=stage.rows[i-1],b=stage.rows[i],dt=(b[0]-a[0])/1000;
  if(dt<=0||dt>.025||a[5]!==stage.duty||b[5]!==stage.duty)continue;
  let delta=b[9]-a[9];if(delta>8192)delta-=16384;if(delta< -8192)delta+=16384;
  const row=[...b];row[9]=((a[9]+delta/2)%16384+16384)%16384;row[10]=delta*360/16384/dt;transformed.push(row);
 }
 stage.rows=transformed;
}
const bins=36,mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function correlation(a,b){const ma=mean(a),mb=mean(b);return a.reduce((s,v,i)=>s+(v-ma)*(b[i]-mb),0)/Math.sqrt(a.reduce((s,v)=>s+(v-ma)**2,0)*b.reduce((s,v)=>s+(v-mb)**2,0));}
function profile(rows,average){const slots=Array.from({length:bins},()=>[]);for(const s of rows)slots[Math.floor(s[9]/16384*bins)].push(Math.abs(s[10])/average);return {counts:slots.map(a=>a.length),values:slots.map(mean)};}
const reports=stages.map(s=>{
 const rows=s.rows.filter(r=>r[5]===s.duty&&r[0]>=s.rows[0][0]+5000),average=mean(rows.map(r=>Math.abs(r[10])));
 const split=rows[0][0]+(rows.at(-1)[0]-rows[0][0])/2;
 const train=rows.filter(r=>r[0]<split),test=rows.filter(r=>r[0]>=split),p=profile(train,average),q=profile(test,average);
 const residual=test.reduce((sum,r)=>sum+(Math.abs(r[10])/average-p.values[Math.floor(r[9]/16384*bins)])**2,0);
 const energy=test.reduce((sum,r)=>sum+(Math.abs(r[10])/average-1)**2,0);
 const full=profile(rows,average),harmonics=Array.from({length:6},(_,j)=>{
  const k=j+1,sin=2/bins*full.values.reduce((a,v,i)=>a+(v-1)*Math.sin((i+.5)/bins*2*Math.PI*k),0),cos=2/bins*full.values.reduce((a,v,i)=>a+(v-1)*Math.cos((i+.5)/bins*2*Math.PI*k),0);
  return {order:k,amplitude:Math.hypot(sin,cos)};
 });
 return {port:s.port,direction:s.direction,duty:s.duty,samples:rows.length,meanRotorDps:average,profile:full,halfProfileCorrelation:correlation(p.values,q.values),heldoutExplainedFraction:1-residual/energy,minTrainBin:Math.min(...p.counts),harmonics};
});
const comparisons=[];
for(let i=0;i<reports.length;i++)for(let j=i+1;j<reports.length;j++)if(reports[i].port===reports[j].port)comparisons.push({port:reports[i].port,a:[reports[i].duty,reports[i].direction],b:[reports[j].duty,reports[j].direction],correlation:correlation(reports[i].profile.values,reports[j].profile.values)});
const file=path.join(root,'evidence',`angle-periodicity-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify({input,rawInterval,reports,comparisons,scope:'Same-sensor phase coherence only; cannot independently distinguish true speed ripple from angular distortion'},null,2),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({file,rawInterval,reports:reports.map(r=>({port:r.port,direction:r.direction,duty:r.duty,heldoutExplainedFraction:r.heldoutExplainedFraction,harmonics:r.harmonics})),comparisons}));
