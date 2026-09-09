// COM4 diagnostic ABBA trial: only Ke changes; no permanent adoption.
const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped,trial}=require('./validate_saved_current.cjs');
const group=require('./electrical_configuration.cjs');
const {awaitCurrentZero}=require('./await_current_zero.cjs');
async function main(){
 const report={scope:'COM4 +/-200mA 180ms ABBA Ke comparison; original group restored',trials:[]};
 const profile=process.argv.includes('--moving-current')?'moving-current':'short-position';report.profile=profile;
 let original;
 try{
  const ports=(await api('ports')).ports;
  for(const [port,id] of [['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']]){
   const p=ports.find(p=>p.port===port);
   if(!p?.hwid.includes(id)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch');
   await stopped(port);
   const sync=await send(port,'sync status'),profile=await send(port,'motorprofile status');
   if(!sync.includes('mode=off')||!sync.includes('armed=0')||!profile.includes('current_limit=1.50A gear=5.20'))throw Error('Configuration mismatch');
  }
  original=group.parse(await send('COM4','cascade electrical'));report.original=original;
  const prior=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence/saved-current-validation-1788882127340.json'),'utf8')).find(r=>r.port==='COM4');
  if(!prior.groupTransaction||prior.independentErrors.some(r=>r.relativeError>.25))throw Error('Missing prior validated model');
  const full=prior.groupTransaction.applied,low={...full,Ke:original.Ke};
  await send('COM4','stream 100');
  for(const [index,label] of ['low','full','full','low'].entries()){
   await stopped('COM4');
   const c=label==='full'?full:low;await group.apply(send,'COM4',c);await send('COM4','wake');
   const zeroCheck=await awaitCurrentZero(send,'COM4');
   for(const ma of index%2?[ -200,200]:[200,-200]){
    const r=await trial('COM4',ma,5.2,profile);report.trials.push({index,label,configuration:c,zeroCheck,...r});
    console.log(JSON.stringify({index,label,ma,error:r.error,metrics:r.metrics}));
    if(r.error)throw Error(r.error);
   }
  }
 }catch(e){report.error=e.message;process.exitCode=1;}
 finally{
  try{
   await stopped('COM4');
   if(original){await send('COM4',group.command(original));report.restored=group.parse(await send('COM4','cascade electrical'));if(!group.matches(report.restored,original))throw Error('Restore mismatch');}
   report.finalStatus=await stopped('COM4');report.peerStatus=await stopped('COM23');
  }catch(e){report.cleanupError=e.message;process.exitCode=1;}
  const file=path.join(__dirname,'../evidence',`velocity-ff-comparison-${Date.now()}.json`);
  fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({file,error:report.error,cleanupError:report.cleanupError,restored:report.restored}));
 }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
