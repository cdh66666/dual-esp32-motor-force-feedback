// Stationary ADC baseline, no motion commands. Sleep/wake are explicit.
const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped,delay}=require('./validate_saved_current.cjs');
function metric(values){const mean=values.reduce((a,b)=>a+b,0)/values.length;return {samples:values.length,mean,rms:Math.sqrt(values.reduce((a,b)=>a+b*b,0)/values.length),std:Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length),min:Math.min(...values),max:Math.max(...values)};}
async function main(){
 const reports=[];
 try{
  const ports=(await api('ports')).ports;
  for(const [port,id] of [['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']]){
   const p=ports.find(p=>p.port===port);if(!p?.hwid.includes(id)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch');
   await stopped(port);const sync=await send(port,'sync status');if(!sync.includes('mode=off')||!sync.includes('armed=0'))throw Error('Sync active');
  }
  for(const port of ['COM4','COM23'])for(const phase of ['sleep','wake']){
   await stopped(port);await send(port,phase);
   const report={port,phase,rows:[]};reports.push(report);
   for(let i=0;i<25;i++){
    const reply=await send(port,'status');
    const get=k=>Number(reply.match(new RegExp('(?:^| )'+k+'=([-0-9.]+)'))?.[1]);
    const row={hostMs:Date.now(),currentMa:get('motor_current'),rawMv:get('current_raw'),zeroMv:get('current_zero'),bus:get('bus'),velocity:get('velocity'),reply};
    report.rows.push(row);
    if(!reply.includes('pwm=0/4095')||!reply.includes('control=idle')||!reply.includes('nFAULT=1')||!reply.includes('awake='+(phase==='wake'?1:0))||!Number.isFinite(row.velocity)||Math.abs(row.velocity)>2||row.bus<17||row.bus>21)throw Error('Stationary baseline state mismatch');
    await delay(200);
   }
   report.all=metric(report.rows.map(r=>r.currentMa));report.lastTwoSeconds=metric(report.rows.slice(-10).map(r=>r.currentMa));
   console.log(JSON.stringify({port,phase,all:report.all,tail:report.lastTwoSeconds}));
  }
 }finally{
  for(const port of ['COM4','COM23'])try{await stopped(port);await send(port,'sleep');}catch(e){reports.push({port,cleanupError:e.message});process.exitCode=1;}
  const file=path.join(__dirname,'../evidence',`current-zero-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify(reports,null,2),{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({file}));
 }
}
module.exports={metric};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
