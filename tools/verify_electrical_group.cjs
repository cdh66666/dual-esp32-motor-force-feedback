// Non-motion RAM configuration round-trip. No wake/current/velocity commands.
const fs=require('node:fs'),path=require('node:path');
const group=require('./electrical_configuration.cjs');
async function verify(send,port){
 const report={port,scope:'sleeping configuration round-trip, not motor performance'};
 let original;
 try{
  if(!(await send(port,'stop')).startsWith('OK stop'))throw Error('STOP not confirmed');
  if(!(await send(port,'sleep')).startsWith('OK driver_awake=0'))throw Error('Sleep not confirmed');
  const sync=await send(port,'sync status');
  if(!sync.includes('mode=off')||!sync.includes('armed=0'))throw Error('Synchronization active');
  original=group.parse(await send(port,'cascade electrical'));report.original=original;
  // Distinct but bounded values test the entire RAM group; never energise it.
  const candidate={R:original.R>19?original.R*.99:original.R*1.01,
   Ke:original.Ke>.19?original.Ke*.99:original.Ke*1.01,
   kp:original.kp>4999?original.kp-1:original.kp+1,
   ki:original.ki>1999999?original.ki-1:original.ki+1,
   max_pwm:original.max_pwm>1?original.max_pwm-1:2};
  report.transaction=await group.apply(send,port,candidate);
 }catch(e){report.error=e.message;}
 finally{
  if(original)try{
   if(!(await send(port,'stop')).startsWith('OK stop'))throw Error('Restore STOP not confirmed');
   await send(port,group.command(original));
   report.restored=group.parse(await send(port,'cascade electrical'));
   if(!group.matches(report.restored,original))throw Error('Restore mismatch');
  }catch(e){report.restoreError=e.message;}
  try{
   report.finalStatus=await send(port,'status');
   if(!report.finalStatus.includes('control=idle')||!report.finalStatus.includes('pwm=0/4095')||!report.finalStatus.includes('awake=0'))throw Error('Final sleeping idle not confirmed');
  }catch(e){report.finalError=e.message;}
 }
 report.passed=!!report.transaction&&!report.error&&!report.restoreError&&!report.finalError;
 return report;
}
async function main(){
 const {api,send}=require('./validate_saved_current.cjs');
 const devices=[{port:'COM4',id:'68EE8F5381E4'},{port:'COM23',id:'68EE8F52A79C'}],reports=[];
 const ports=(await api('ports')).ports;
 for(const d of devices){const p=ports.find(p=>p.port===d.port);if(!p?.hwid.includes(d.id)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch');}
 for(const d of devices){const r=await verify(send,d.port);reports.push(r);if(r.restoreError||r.finalError)break;}
 const file=path.join(__dirname,'../evidence',`electrical-group-roundtrip-${Date.now()}.json`);
 fs.writeFileSync(file,JSON.stringify(reports,null,2),{encoding:'utf8',flag:'wx'});
 console.log(JSON.stringify({file,reports}));if(reports.length!==2||reports.some(r=>!r.passed))process.exitCode=1;
}
module.exports={verify};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
