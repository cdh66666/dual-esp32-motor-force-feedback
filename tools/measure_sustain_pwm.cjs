const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped}=require('./validate_saved_current.cjs');
const {stage}=require('./encoder_fixed_pwm.cjs');
const {tailMetrics}=require('./measure_startup_pwm.cjs');
const devices=[{port:'COM4',id:'68EE8F5381E4'},{port:'COM23',id:'68EE8F52A79C'}];
async function main(){
 const file=path.join(__dirname,'../evidence',`sustain-pwm-${Date.now()}.jsonl`),fd=fs.openSync(file,'wx');
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
  for(const d of devices)for(const direction of [1,-1]){
   const schedule=[246,225,205,184,164,143,123];
   const result=await stage(d,246,direction,14000,schedule);
   result.tails=schedule.map(duty=>({duty,...tailMetrics(result.rows,direction,duty)}));save(result);
   console.log(JSON.stringify({port:d.port,direction,error:result.error,tails:result.tails}));
   if(result.error)throw Error(result.error);
  }
 }finally{
  for(const d of devices)try{save({port:d.port,finalStatus:await stopped(d.port)});}catch(e){save({port:d.port,cleanupError:e.message});process.exitCode=1;}
  fs.closeSync(fd);
 }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
