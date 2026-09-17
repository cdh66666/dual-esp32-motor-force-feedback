// Authorized unloaded paired full-range validation. Never changes gains.
const fs=require('node:fs'),path=require('node:path');
const {api,send,delay}=require('./validate_saved_current.cjs');
const devices=[['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']];
const report={scope:'Two motors simultaneously; absolute +/-10 output turns; 8 r/s reference maximum',commands:[],boards:[],final:[]};
async function main(){
 const ports=(await api('ports')).ports;
 for(const [port,id] of devices)if(!ports.some(p=>p.port===port&&p.hwid.includes(id)&&p.telemetry_ok))throw Error('Identity/freshness mismatch');
 try{
  for(const [port] of devices){
   await send(port,'stop');await send(port,'sync stop');await send(port,'sleep');
   const cfg=await send(port,'cascade status');
   if(Number(cfg.match(/max_velocity=([\d.]+)/)?.[1])>14976)throw Error('Paired test requires <=8 r/s position envelope');
   const profile=await send(port,'motorprofile status');
   if(Number(profile.match(/gear=([\d.]+)/)?.[1])!==5.2)throw Error('Unexpected gear');
   await send(port,'wake');await send(port,'stream 100');
   const logs=await api(`logs?port=${port}&since=0`);
   report.boards.push({port,cfg,session:logs.session_id,cursor:Math.max(0,...logs.logs.map(r=>r.seq)),fresh:Date.now(),rows:[]});
  }
  const start=Date.now();
  for(const [target,hold] of [[0,4000],[10,6000],[-10,7000],[6,250],[-3,200],[9,300],[-8,200],[1,250],[0,6000]]){
   const issued=Date.now();
   const replies=await Promise.allSettled(report.boards.map(async b=>{await send(b.port,`posout ${target*360} 4095 ${Math.max(2000,hold+1000)}`);return{port:b.port,ackMs:Date.now()-issued};}));
   report.commands.push({ms:issued-start,target,hold,replies});
   if(replies.some(r=>r.status==='rejected'))throw Error('Paired target rejected');
   const until=Date.now()+hold;
   while(Date.now()<until){
    await delay(25);
    await Promise.all(report.boards.map(async b=>{
     const logs=await api(`logs?port=${b.port}&since=${b.cursor}`);
     if(logs.session_id!==b.session)throw Error('USB session changed');
     for(const row of logs.logs){
      b.cursor=Math.max(b.cursor,row.seq);
      if(/^(ERR |CASCADE (fault|no_))/.test(row.text))throw Error(row.text);
      if(!row.text.startsWith('S,'))continue;
      const s=row.text.slice(2).split(',').map(Number);b.fresh=Date.now();
      if(s.length<24||s.some(v=>!Number.isFinite(v))||s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>1800||Math.abs(s[2]/1872)>11||Math.abs(s[10]/1872)>20)throw Error(b.port+' paired envelope: '+row.text);
      b.rows.push({ms:Date.now()-start,mcuMs:s[0],r:s[2]/1872,rps:s[10]/1872,a:s[4]/1000,volts:s[3],target});
     }
     if(Date.now()-b.fresh>250)throw Error(b.port+' stale telemetry');
    }));
   }
  }
 }catch(e){report.error=e.message;}
 finally{
  for(const [port] of devices)try{await send(port,'stop');await send(port,'sleep');report.final.push({port,status:await send(port,'status')});}catch(e){report.final.push({port,error:e.message});}
  const file=path.join(__dirname,`../evidence/paired-position-${Date.now()}.json`);
  fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({file,error:report.error,boards:report.boards.map(({rows,...b})=>({...b,samples:rows.length,minVolts:Math.min(...rows.map(r=>r.volts)),peakA:Math.max(...rows.map(r=>Math.abs(r.a)))})),final:report.final}));
  if(report.error||report.final.some(r=>!r.status?.includes('awake=0')))process.exitCode=1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
