// No motion, no baud/address/power changes. Correlate DATA PONG by seq and UID.
const fs=require('node:fs'),path=require('node:path');
const {api,send,delay}=require('./validate_saved_current.cjs');
const devices=[{port:'COM4',serial:'68EE8F5381E4',address:184,uid:'e481538fee68'},
  {port:'COM23',serial:'68EE8F52A79C',address:1,uid:'9ca7528fee68'}];
async function ping(sender,receiver) {
  const prior=await api(`logs?port=${sender.port}&since=0`),epoch=prior.session_id;
  let cursor=Math.max(0,...prior.logs.map(r=>r.seq)),entries=[];
  const started=Date.now();
  await api('send',{port:sender.port,command:`bus ${receiver.address} ping`,wait_ack:false});
  while(Date.now()-started<1200) {
    const logs=await api(`logs?port=${sender.port}&since=${cursor}`);
    if(logs.session_id!==epoch)throw Error('USB session changed');
    for(const r of logs.logs){cursor=Math.max(cursor,r.seq);if(r.direction==='rx'&&!r.text.startsWith('S,'))entries.push(r.text);}
    const tx=entries.find(x=>x.startsWith(`OK bus_tx dest=${receiver.address} `));
    const seq=tx?.match(/seq=(\d+)/)?.[1];
    const pong=entries.find(x=>seq&&x.startsWith(`BUS_RX from=${receiver.address} type=5 seq=${seq} `)&&x.toLowerCase().includes(`payload=pong,addr=${receiver.address},uid=${receiver.uid}`));
    if(pong)return {ok:true,hostRoundTripMs:Date.now()-started,tx,pong};
    if(entries.some(x=>x.startsWith('ERR ')))break;
    await delay(15);
  }
  return {ok:false,hostRoundTripMs:Date.now()-started,entries};
}
async function main() {
  const report={date:new Date().toISOString(),scope:'idle DATA PING/PONG only; not force-loop latency acceptance',before:[],trials:[],after:[]};
  try {
    const ports=(await api('ports')).ports;
    for(const d of devices) {
      const p=ports.find(p=>p.port===d.port);
      if(!p?.hwid.includes(d.serial)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch '+d.port);
      const status=await send(d.port,'status'),sync=await send(d.port,'sync status'),bus=await send(d.port,'businfo');
      if(!status.includes('control=idle')||!status.includes('pwm=0/4095')||!sync.includes('mode=off')||!sync.includes('armed=0'))throw Error('Not idle '+d.port);
      if(!bus.includes(`addr=${d.address} `)||!bus.includes('baud=1000000 '))throw Error('Unexpected bus settings');
      report.before.push({port:d.port,status,sync,bus});
    }
    for(const [sender,receiver] of [[devices[0],devices[1]],[devices[1],devices[0]]]) {
      for(let i=0;i<5;i++)report.trials.push({sender:sender.port,receiver:receiver.port,...await ping(sender,receiver)});
    }
  }catch(e){report.error=e.message;}
  finally {
    for(const d of devices)try{report.after.push({port:d.port,status:await send(d.port,'status'),bus:await send(d.port,'businfo')});}catch(e){report.after.push({port:d.port,error:e.message});}
    const file=path.join(__dirname,'../evidence',`idle-bus-${Date.now()}.json`);
    fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({file,...report}));
  }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
