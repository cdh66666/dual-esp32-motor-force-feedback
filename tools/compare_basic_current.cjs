// Bounded unloaded +/-100/150 mA comparison. Never increases existing gains.
const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped,trial}=require('./validate_saved_current.cjs');
const group=require('./electrical_configuration.cjs');
const {awaitCurrentZero}=require('./await_current_zero.cjs');
(async()=>{
 const report={scope:'180 ms unloaded current pulses; not torque/thermal/outer-loop acceptance',boards:[]};
 const devices=[['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']];
 try{
  for(const [port,id] of devices){
   const device=(await api('ports')).ports.find(p=>p.port===port);
   if(!device?.hwid.includes(id)||!device.telemetry_ok||device.maintenance)throw Error('Identity/freshness mismatch');
   await stopped(port);await send(port,'sync off');await send(port,'wake');await awaitCurrentZero(send,port);
   const original=group.parse(await send(port,'cascade electrical'));
   const r={port,original,candidates:[],adopted:false};report.boards.push(r);
   let committed=false;
   try{
    for(const scale of [1,.75]){
     const config={...original,ki:original.ki*scale};await group.apply(send,port,config);
     const c={config,trials:[]};r.candidates.push(c);
     for(const ma of [100,-100,150,-150]){
      const t=await trial(port,ma,5.2,'moving-current');c.trials.push(t);
      if(t.error)throw Error(t.error);
     }
     c.passed=c.trials.every(t=>t.metrics?.passed);
     c.score=c.trials.reduce((s,t)=>s+t.metrics.rms,0)/c.trials.length;
    }
    const [base,candidate]=r.candidates;
    if(candidate.passed && candidate.score<base.score*.8){
     await group.apply(send,port,candidate.config);
     r.confirmation=[];
     for(const ma of [150,-150])r.confirmation.push(await trial(port,ma,5.2,'moving-current'));
     if(r.confirmation.every(t=>!t.error&&t.metrics?.passed&&t.metrics.rms<base.score)){
      r.selected=candidate.config;r.adopted=true;committed=true;
     }
    }
   }finally{
    await stopped(port);if(!committed)await group.apply(send,port,original);
    r.final=group.parse(await send(port,'cascade electrical'));
    if(!group.matches(r.final,committed?r.selected:original))throw Error('Final configuration mismatch');
    await send(port,'sleep');
   }
  }
 }catch(e){report.error=e.message;process.exitCode=1;}
 finally{
  report.stopped=[];
  for(const [port] of devices)try{await stopped(port);await send(port,'sleep');report.stopped.push(port);}catch(e){report.stopError=e.message;process.exitCode=1;}
  const file=path.join(__dirname,'../evidence/basic-current-'+Date.now()+'.json');fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({file,error:report.error,stopError:report.stopError,boards:report.boards.map(r=>({port:r.port,adopted:r.adopted,final:r.final,candidates:r.candidates.map(c=>({ki:c.config.ki,score:c.score,passed:c.passed,errors:c.trials.map(t=>t.error)}))}))}));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
