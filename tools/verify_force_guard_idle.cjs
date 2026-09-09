// Bounded 2-second, 200mA ceiling, zero-offset bilateral link check.
// No claim of hand-load feel or runaway/thermal fault injection acceptance.
const fs=require('node:fs'),path=require('node:path');
const {api,send,delay}=require('./validate_saved_current.cjs');
async function main(){
 const ds=[{port:'COM4',id:'68EE8F5381E4'},{port:'COM23',id:'68EE8F52A79C'}];
 const report={scope:'2s zero-error bilateral,200mA ceiling,PWM900; no hand load',boards:[]};
 try{
  const ps=(await api('ports')).ports;
  for(const d of ds){
   if(!ps.some(p=>p.port===d.port&&p.hwid.includes(d.id)&&p.telemetry_ok&&!p.maintenance))throw Error('identity/freshness');
   await send(d.port,'stop');await send(d.port,'sync off');await send(d.port,'wake');
   await require('./await_current_zero.cjs').awaitCurrentZero(send,d.port);
   const state=await send(d.port,'status');
   d.origin=Number(state.match(/multi=([-\d.]+)deg/)?.[1]);
   const bus=await send(d.port,'businfo');
   d.addr=Number(bus.match(/\baddr=(\d+)/)?.[1]);
   if(!Number.isFinite(d.origin)||!d.addr)throw Error('missing coordinate/address');
   const logs=await api(`logs?port=${d.port}&since=0`);
   d.seq=Math.max(0,...logs.logs.map(r=>r.seq));d.session=logs.session_id;d.fresh=Date.now();
   d.record={port:d.port,samples:[],events:[]};report.boards.push(d.record);
  }
  if(ds[0].addr===ds[1].addr)throw Error('duplicate address');
  for(const d of [...ds].sort((a,b)=>b.addr-a.addr)){
   const peer=ds.find(x=>x!==d),offset=d.origin-peer.origin;
   if(Math.abs(offset)>360)throw Error('offset too large');
   await send(d.port,`sync force ${peer.addr} 1 0.05 0 200 900 1000 ${offset}`);
  }
  const end=Date.now()+2000;
  while(Date.now()<end){
   await delay(20);
   for(const d of ds){
    const log=await api(`logs?port=${d.port}&since=${d.seq}`);
    if(log.session_id!==d.session)throw Error('session changed');
    for(const row of log.logs){
     d.seq=Math.max(d.seq,row.seq);
     if(/^(CASCADE fault|ERR |SYNC_STOP|CONTROL_WARN)/.test(row.text))d.record.events.push(row.text);
     if(/^(CASCADE fault|ERR |SYNC_STOP)/.test(row.text))throw Error(row.text);
     if(!row.text.startsWith('S,'))continue;
     const s=row.text.slice(2).split(',').map(Number);d.fresh=Date.now();d.record.samples.push(s);
     if(s.length<24||s.some(x=>!Number.isFinite(x))||s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>400||Math.abs(s[10])/5.2>180)throw Error('idle coupling envelope');
    }
    if(Date.now()-d.fresh>150)throw Error('stale telemetry');
   }
  }
  for(const d of ds){
   d.record.sync=await send(d.port,'sync status');
   if(!d.record.sync.includes('armed=1')||!d.record.sync.includes('mode=force')||d.record.samples.filter(s=>s[11]===1).length<100)throw Error('force not continuously active');
  }
 }catch(e){report.error=e.message;}
 finally{
  for(const d of ds)try{await send(d.port,'stop');await send(d.port,'sync off');const s=await send(d.port,'status');if(!s.includes('control=idle')||!s.includes('pwm=0/4095'))throw Error('not idle');if(d.record)d.record.final=s;}catch(e){report.stopError=e.message;}
  report.passed=!report.error&&!report.stopError&&report.boards.length===2;
  const file=path.join(__dirname,'../evidence',`force-guard-idle-${Date.now()}.json`);
  fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({file,...report,boards:report.boards.map(({samples,...r})=>({...r,samples:samples.length}))}));
  if(!report.passed)process.exitCode=1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
