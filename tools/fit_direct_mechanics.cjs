const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),src=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function fitControlRows('),src.indexOf('async function runAutoTune(')),ctx);
const input='evidence/direct-mechanics-1788883171193.json';
const reports=JSON.parse(fs.readFileSync(path.join(root,input),'utf8')).map(r=>{
 const rows=[],trials=r.trials.filter(t=>!t.error);
 for(const [group,t] of trials.entries())for(let j=3;j<t.samples.length;j+=3){
  const chunk=t.samples.slice(j-3,j+1),a=chunk[0],b=chunk.at(-1),dt=(b[0]-a[0])/1000;
  if(dt<=0||dt>.04||chunk.some(s=>Math.abs(s[10])<10||Math.sign(s[10])!==Math.sign(b[10])))continue;
  let integralI=0,integralW=0;
  for(let i=1;i<chunk.length;i++){const p=chunk[i-1],q=chunk[i],h=(q[0]-p[0])/1000;integralI+=(p[4]+q[4])*.5/1000*h;integralW+=(p[10]+q[10])*.5*Math.PI/180*h;}
  rows.push({group,x:[integralI/dt,-integralW/dt,-Math.sign(b[10])],y:(b[10]-a[10])*Math.PI/180/dt});
 }
 let fit;try{fit=ctx.fitControlRows(rows,'Direct mechanical');}catch(e){fit={error:e.message};}
 return {port:r.port,completedTrials:trials.length,abortedTrials:r.trials.length-trials.length,rows:rows.length,fit};
});
const file=path.join(root,'evidence',`direct-mechanical-fit-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify({input,reports},null,2),{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({file,reports}));
