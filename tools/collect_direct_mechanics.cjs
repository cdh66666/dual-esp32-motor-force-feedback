const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped,delay,currentEnvelopeError}=require('./validate_saved_current.cjs');
const group=require('./electrical_configuration.cjs');
const {awaitCurrentZero}=require('./await_current_zero.cjs');
async function excitation(port,direction){
 const status=await stopped(port),origin=Number(status.match(/multi=([-\d.]+)/)?.[1]);
 if(!Number.isFinite(origin))throw Error('Missing origin');
 const old=await api(`logs?port=${port}&since=0`),epoch=old.session_id;
 let cursor=Math.max(0,...old.logs.map(r=>r.seq)),lastRx=Date.now(),lastTime=null;
 const result={port,direction,origin,samples:[],commands:[]};
 try{
  for(const [ma,duration] of [[direction*250,80],[direction*100,80],[0,200]]){
   const command=ma?`current ${ma} 900 100`:'stop';
   result.commands.push({command,hostMs:Date.now(),ack:await send(port,command)});
   const deadline=Date.now()+duration;
   while(Date.now()<deadline){
    const logs=await api(`logs?port=${port}&since=${cursor}`);
    if(logs.session_id!==epoch)throw Error('USB session changed');
    for(const row of logs.logs){
     cursor=Math.max(cursor,row.seq);if(row.direction!=='rx')continue;
     if(/^(ERR |CASCADE (fault|no_)|MODEL fault)/.test(row.text))throw Error(row.text);
     if(!row.text.startsWith('S,'))continue;
     const s=row.text.slice(2).split(',').map(Number);result.samples.push(s);lastRx=Date.now();
     const failure=currentEnvelopeError(s,origin,5.2,'moving-current');if(failure)throw Error(failure);
     if(lastTime!==null&&s[0]<=lastTime)throw Error('Non-monotonic MCU clock');lastTime=s[0];
    }
    if(Date.now()-lastRx>150)throw Error('Stale telemetry');
    await delay(15);
   }
  }
 }catch(e){result.error=e.message;}
 finally{result.finalStatus=await stopped(port);}
 result.peakOutputDps=Math.max(0,...result.samples.map(s=>Math.abs(s[10])/5.2));
 result.peakCurrentA=Math.max(0,...result.samples.map(s=>Math.abs(s[4])/1000));
 result.travelDeg=result.samples.length?(result.samples.at(-1)[2]-origin)/5.2:0;
 return result;
}
async function main(){
 const reports=[],devices=[['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']];
 const candidates=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence/saved-current-validation-1788882901973.json'),'utf8'));
 try{
  const ports=(await api('ports')).ports;
  for(const [port,id] of devices){
   const p=ports.find(p=>p.port===port);if(!p?.hwid.includes(id)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch');
   await stopped(port);const sync=await send(port,'sync status'),profile=await send(port,'motorprofile status');
   if(!sync.includes('mode=off')||!sync.includes('armed=0')||!profile.includes('current_limit=1.50A gear=5.20'))throw Error('Profile/sync mismatch');
  }
  for(const [port] of devices){
   const report={port,scope:'250mA 80ms,100mA 80ms,coast200ms; direct current, no velocity loop',trials:[]};reports.push(report);
   let original;
   try{
    const candidate=candidates.find(r=>r.port===port);
    if(candidate?.error||candidate?.trials?.length!==6||candidate.trials.some(t=>t.error||!t.metrics?.passed)||!candidate.cleanup?.ok)throw Error('Missing current candidate validation');
    original=group.parse(await send(port,'cascade electrical'));report.original=original;
    report.transaction=await group.apply(send,port,candidate.groupTransaction.applied);
    await send(port,'wake');await send(port,'stream 100');report.zeroCheck=await awaitCurrentZero(send,port);
    for(const direction of [1,-1,1,-1,1,-1]){
     const r=await excitation(port,direction);report.trials.push(r);console.log(JSON.stringify({port,direction,error:r.error,peakOutputDps:r.peakOutputDps,peakCurrentA:r.peakCurrentA,travelDeg:r.travelDeg}));
     if(r.error)throw Error(r.error);
    }
   }catch(e){report.error=e.message;process.exitCode=1;}
   finally{
    await stopped(port);
    if(original){await send(port,group.command(original));report.restored=group.parse(await send(port,'cascade electrical'));if(!group.matches(original,report.restored))throw Error('Restore mismatch');}
    report.finalStatus=await stopped(port);
   }
  }
 }finally{
  for(const [port] of devices)try{await stopped(port);}catch(e){reports.push({port,cleanupError:e.message});process.exitCode=1;}
  const file=path.join(__dirname,'../evidence',`direct-mechanics-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify(reports,null,2),{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({file}));
 }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
