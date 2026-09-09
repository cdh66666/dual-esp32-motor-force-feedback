// Offline diagnostic, never writes gains or commands a motor.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function fitControlRows('),source.indexOf('async function runAutoTune(')),ctx);
function mechanicalRows(pulses,halfWindowMs=4) {
  const rows=[];
  for(const [group,p] of pulses.entries()) {
    const tr=p.trace;
    const at=(t,k)=>{
      const i=tr.findIndex((r,j)=>j&&r[0]>=t&&tr[j-1][0]<=t);
      if(i<1)return null;
      const a=tr[i-1],b=tr[i];
      if(b[0]-a[0]>3000||a[6]>3000||b[6]>3000)return null;
      return a[k]+(b[k]-a[k])*(t-a[0])/(b[0]-a[0]);
    };
    const velocity=t=>{
      const a=at(t-halfWindowMs*1000,4),b=at(t+halfWindowMs*1000,4);
      return a===null||b===null?null:(b-a)/(halfWindowMs*.002);
    };
    for(let t=tr[0][0]+halfWindowMs*1000;t+20000+halfWindowMs*1000<=tr.at(-1)[0];t+=10000) {
      const chunk=Array.from({length:21},(_,i)=>({t:t+i*1000,v:velocity(t+i*1000),current:at(t+i*1000,2)}));
      const first=chunk[0],last=chunk.at(-1);
      if(chunk.some(r=>r.v===null||r.current===null||Math.abs(r.v)<10.4||Math.sign(r.v)!==Math.sign(last.v)))continue;
      const current=chunk.reduce((s,r,i)=>s+r.current*(i===0||i===20?.5:1),0)/20;
      const velocityMean=(at(t+20000,4)-at(t,4))/.02;
      rows.push({group,phase:at(t+10000,4)*Math.PI/180,x:[current,-velocityMean,-Math.sign(last.v)],y:(last.v-first.v)/.02});
    }
  }
  return rows;
}
for(const port of ['COM4','COM23']) {
  const report=JSON.parse(fs.readFileSync(path.join(root,`evidence/bounded-identify-${port}-20260908.json`),'utf8'));
  const rows=mechanicalRows(report.pulses);
  let fit;try{fit=ctx.fitControlRows(rows,'position-derived mechanical');}catch(e){fit={error:e.message};}
  console.log(JSON.stringify({port,method:'central 8ms position slope, 20ms current integral',rows:rows.length,groups:[...new Set(rows.map(r=>r.group))].map(g=>({g,n:rows.filter(r=>r.group===g).length})),fit}));
  // Exploratory hypotheses, not model selection or accepted tuning evidence.
  for(const harmonic of [0,1,3,6]) {
    const expanded=rows.map(r=>({...r,x:[...r.x,1,...(harmonic?[Math.sin(r.phase*harmonic),Math.cos(r.phase*harmonic)]:[])]}));
    let result;try{result=ctx.fitControlRows(expanded,'exploratory');}catch(e){result={error:e.message};}
    console.log(JSON.stringify({port,exploratoryOnly:true,harmonic,result}));
  }
}
