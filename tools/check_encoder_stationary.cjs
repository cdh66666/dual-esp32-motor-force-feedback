// Passive telemetry capture. No wake or motion command is issued.
const fs=require('node:fs');
const {api,send,delay}=require('./validate_saved_current.cjs');
(async()=>{
 const ids={COM4:'68EE8F5381E4',COM23:'68EE8F52A79C'},report={date:new Date().toISOString(),boards:{}};
 const ports=(await api('ports')).ports;
 for(const [port,id] of Object.entries(ids)){
  if(!ports.some(p=>p.port===port&&p.hwid.includes(id)&&p.telemetry_ok))throw Error('Identity/freshness mismatch: '+port);
  const status=await send(port,'status');
  if(!status.includes('awake=0')||!status.includes('pwm=0/4095')||!status.includes('control=idle'))throw Error('Not stopped: '+port);
  const logs=await api(`logs?port=${port}&since=0`);
  report.boards[port]={status,session:logs.session_id,seq:Math.max(0,...logs.logs.map(r=>r.seq)),samples:[]};
 }
 const start=Date.now();
 while(Date.now()-start<6000){
  await delay(100);
  for(const [port,b] of Object.entries(report.boards)){
   const logs=await api(`logs?port=${port}&since=${b.seq}`);
   if(logs.session_id!==b.session)throw Error('Session changed: '+port);
   for(const r of logs.logs){b.seq=Math.max(b.seq,r.seq);if(!r.text.startsWith('S,'))continue;
    const s=r.text.slice(2).split(',').map(Number);
    if(s[5]!==0||s[7]!==0)throw Error('Motor no longer asleep: '+port);
    b.samples.push({t:s[0],multi:s[2],raw:s[9],velocity:s[10]});
   }
  }
 }
 for(const b of Object.values(report.boards)){
  const p=b.samples.map(s=>s.multi),raw=b.samples.map(s=>s.raw);
  b.metrics={samples:p.length,motorPeakToPeakDeg:Math.max(...p)-Math.min(...p),rawPeakToPeakCounts:Math.max(...raw)-Math.min(...raw),maxStepMotorDeg:Math.max(0,...p.slice(1).map((v,i)=>Math.abs(v-p[i])))};
 }
 const file=`evidence/encoder-stationary-${Date.now()}.json`;
 fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
 console.log(JSON.stringify({file,boards:Object.fromEntries(Object.entries(report.boards).map(([p,b])=>[p,b.metrics]))}));
})().catch(e=>{console.error(e);process.exitCode=1;});
