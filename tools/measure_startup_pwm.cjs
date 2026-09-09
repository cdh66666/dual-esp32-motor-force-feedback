// Each point starts from confirmed rest; this is NOT a descending sustain test.
const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped}=require('./validate_saved_current.cjs');
const {stage}=require('./encoder_fixed_pwm.cjs');
const devices=[{port:'COM4',id:'68EE8F5381E4'},{port:'COM23',id:'68EE8F52A79C'}];
function tailMetrics(rows,direction,duty){
 const active=rows.filter(s=>s[5]===duty),tail=active.filter(s=>s[0]>=active.at(-1)?.[0]-1000);
 const span=tail.length?tail.at(-1)[0]-tail[0][0]:0;
 const meanDps=span?(tail.at(-1)[2]-tail[0][2])/5.2/(span/1000):0;
 const forwardFraction=tail.filter(s=>s[10]/5.2*direction>2).length/Math.max(1,tail.length);
 return {tailSamples:tail.length,spanMs:span,meanOutputDps:meanDps,forwardFraction,
  sustainedLastSecond:span>=900&&meanDps*direction>5&&forwardFraction>.95};
}
async function main(){
 const file=path.join(__dirname,'../evidence',`startup-pwm-${Date.now()}.jsonl`),fd=fs.openSync(file,'wx');
 const save=r=>fs.writeSync(fd,JSON.stringify(r)+'\n',null,'utf8');console.log(JSON.stringify({file}));
 try{
  const ports=(await api('ports')).ports;
  for(const d of devices){
   const p=ports.find(p=>p.port===d.port);
   if(!p?.hwid.includes(d.id)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch');
   await stopped(d.port);
   const profile=await send(d.port,'motorprofile status'),sync=await send(d.port,'sync status');
   if(!profile.includes('current_limit=1.50A gear=5.20')||!sync.includes('mode=off')||!sync.includes('armed=0'))throw Error('Unexpected configuration');
   save({port:d.port,profile,sync});await send(d.port,'stream 100');
  }
  for(const d of devices)for(const direction of [1,-1])for(const duty of [143,164,184,205,225,246]){
   const result=await stage(d,duty,direction,3000);
   result.tail=tailMetrics(result.rows,direction,duty);save(result);
   console.log(JSON.stringify({port:d.port,direction,duty,error:result.error,tail:result.tail}));
   if(result.error)throw Error(result.error);
  }
 }finally{
  for(const d of devices)try{save({port:d.port,finalStatus:await stopped(d.port)});}catch(e){save({port:d.port,cleanupError:e.message});process.exitCode=1;}
  fs.closeSync(fd);
 }
}
module.exports={tailMetrics};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
