// Offline, current timestamped telemetry only; no controller mutation.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),src=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function fitControlRows('),src.indexOf('async function runAutoTune(')),ctx);
const reports=JSON.parse(fs.readFileSync(path.join(root,'evidence/moving-mechanics-1788871968519.json'),'utf8'));
for(const r of reports) {
  const rows=[];
  for(const [group,stage] of r.stages.entries()) {
    const samples=stage.trace.filter(s=>s.control===2);
    for(let j=2;j<samples.length;j+=2) {
      const chunk=samples.slice(j-2,j+1),a=chunk[0],b=chunk.at(-1),dt=(b.t-a.t)/1000;
      if(dt<=0||dt>.035||chunk.some(s=>Math.abs(s.velocity)<2||Math.sign(s.velocity)!==Math.sign(b.velocity)))continue;
      const avg=k=>(chunk[0][k]+2*chunk[1][k]+chunk[2][k])/4;
      rows.push({group,displacement:(avg('multi')-stage.trace[0].multi)*r.gear,x:[avg('current'),-avg('velocity')*r.gear,-Math.sign(b.velocity)],y:(b.velocity-a.velocity)*r.gear/dt});
    }
  }
  let fit;try{fit=ctx.fitControlRows(rows,'moving mechanical');}catch(e){fit={error:e.message};}
  console.log(JSON.stringify({port:r.port,rows:rows.length,fit}));
  for(const includeCoulomb of [true,false]) {
    const expanded=rows.map(x=>({...x,x:[...(includeCoulomb?x.x:x.x.slice(0,2)),-x.displacement]}));
    let hypothesis;try{hypothesis=ctx.fitControlRows(expanded,'local restoring torque hypothesis');}catch(e){hypothesis={error:e.message};}
    console.log(JSON.stringify({port:r.port,exploratoryOnly:true,includeCoulomb,hypothesis}));
  }
  for(const speedScale of [10,30,100,300]) {
    const expanded=rows.map(x=>({...x,x:[...x.x,x.x[2]*Math.exp(-Math.pow(x.x[1]/speedScale,2))]}));
    let hypothesis;try{hypothesis=ctx.fitControlRows(expanded,'Stribeck hypothesis');}catch(e){hypothesis={error:e.message};}
    console.log(JSON.stringify({port:r.port,exploratoryOnly:true,speedScale,hypothesis}));
  }
}
