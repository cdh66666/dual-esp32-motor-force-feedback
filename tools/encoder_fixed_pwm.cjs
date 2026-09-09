// Fixed PWM, not PID. Healthy-host renewal retains the firmware's 1 s lease.
const fs=require('node:fs'),path=require('node:path');
const {api,send,stopped,delay}=require('./validate_saved_current.cjs');
const devices=[{port:'COM4',id:'68EE8F5381E4'},{port:'COM23',id:'68EE8F52A79C'}];
function analyze(rows,direction,gear) {
  const active=rows.filter(s=>s[5]>0);let accumulated=0,maxMismatch=0,maxGap=0,wraps=0,reverse=0,maxStep=0;
  for(let i=1;i<active.length;i++) {
    const a=active[i-1],b=active[i],gap=b[0]-a[0];maxGap=Math.max(maxGap,gap);
    let delta=b[9]-a[9];if(delta>8192){delta-=16384;wraps++;}if(delta< -8192){delta+=16384;wraps++;}
    accumulated+=delta*360/16384;maxStep=Math.max(maxStep,Math.abs(delta*360/16384));
    if(delta*direction*360/16384< -1)reverse++;
    maxMismatch=Math.max(maxMismatch,Math.abs((b[2]-active[0][2])-accumulated));
  }
  const turns=active.length?(active.at(-1)[2]-active[0][2])/360:0;
  return {samples:active.length,durationMs:active.length?active.at(-1)[0]-active[0][0]:0,rotorTurns:turns,outputTurns:turns/gear,
    wraps,maxGapMs:maxGap,maxRawVsMultiMismatchDeg:maxMismatch,maxStepDeg:maxStep,reverseStepsOverOneRotorDeg:reverse,
    peakCurrentA:Math.max(0,...active.map(s=>Math.abs(s[4])/1000)),peakOutputDps:Math.max(0,...active.map(s=>Math.abs(s[10])/gear)),
    enoughRotation:Math.abs(turns)>=2,scope:'100Hz raw-count unwrap consistency; not independent absolute-angle accuracy'};
}
async function stage(d,duty,direction,durationMs=20000,schedule=null) {
  if(!Number.isInteger(duty)||duty<1||duty>369||![1,-1].includes(direction)||!Number.isInteger(durationMs)||durationMs<1000||durationMs>20000)throw Error('Invalid bounded PWM stage');
  if(schedule&&(!Array.isArray(schedule)||!schedule.length||schedule[0]!==duty||schedule.some((v,i)=>!Number.isInteger(v)||v<1||v>369||(i>0&&v>=schedule[i-1]))||durationMs/schedule.length<1000))throw Error('Invalid descending schedule');
  const result={port:d.port,duty,pwmPercent:100*duty/4095,direction,requestedMs:durationMs,rows:[],events:[]};
  if(schedule)result.schedule=schedule;
  await stopped(d.port);
  const old=await api(`logs?port=${d.port}&since=0`),epoch=old.session_id;
  let cursor=Math.max(0,...old.logs.map(r=>r.seq)),lastRx=Date.now(),lastSample=null;
  let command=`${direction>0?'cw':'ccw'} ${duty} 1000`,expectedDuty=duty,segment=0,changedAt=Date.now();
  try {
    result.startAck=await send(d.port,command);
    const start=Date.now();let renewAt=start+300;
    while(Date.now()-start<durationMs) {
      const logs=await api(`logs?port=${d.port}&since=${cursor}`);
      if(logs.session_id!==epoch)throw Error('USB session changed');
      for(const entry of logs.logs) {
        cursor=Math.max(cursor,entry.seq);if(entry.direction!=='rx')continue;
        if(!entry.text.startsWith('S,')) {
          result.events.push(entry.text);
          if(/^(ERR |CASCADE (fault|no_)|MODEL fault)/.test(entry.text))throw Error(entry.text);
          continue;
        }
        const s=entry.text.slice(2).split(',').map(Number);result.rows.push(s);lastRx=Date.now();
        if(s.length<24||s.some(v=>!Number.isFinite(v)))throw Error('Invalid telemetry');
        if(lastSample!==null&&s[0]<=lastSample)throw Error('Non-monotonic board clock');lastSample=s[0];
        if(s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>1000||Math.abs(s[10])/5.2>900)throw Error('Current/power/fault/speed envelope exceeded');
        if(Date.now()-changedAt>250&&s[5]!==expectedDuty)throw Error('Fixed PWM interrupted or changed');
      }
      if(Date.now()-lastRx>150)throw Error('Telemetry stale; no lease renewal');
      const next=schedule?Math.min(schedule.length-1,Math.floor((Date.now()-start)/(durationMs/schedule.length))):0;
      if(next>segment){segment=next;expectedDuty=schedule[next];command=`${direction>0?'cw':'ccw'} ${expectedDuty} 1000`;changedAt=Date.now();renewAt=0;}
      if(Date.now()>=renewAt) {await send(d.port,command);renewAt=Date.now()+300;}
      await delay(15);
    }
  }catch(e){result.error=e.message;}
  finally {result.stopAck=await send(d.port,'stop');}
  result.finalStatus=await stopped(d.port);
  result.metrics=analyze(result.rows,direction,5.2);
  return result;
}
async function main() {
  const file=path.join(__dirname,'../evidence',`encoder-fixed-pwm-${Date.now()}.jsonl`);
  const out=fs.openSync(file,'wx');const save=r=>fs.writeSync(out,JSON.stringify(r)+'\n',null,'utf8');
  console.log(JSON.stringify({file}));
  try {
    const ports=(await api('ports')).ports;
    for(const d of devices) {
      const p=ports.find(p=>p.port===d.port);
      if(!p?.hwid.includes(d.id)||!p.telemetry_ok||p.maintenance)throw Error('Identity/freshness mismatch '+d.port);
      await stopped(d.port);
      const sync=await send(d.port,'sync status'),profile=await send(d.port,'motorprofile status');
      if(!sync.includes('mode=off')||!sync.includes('armed=0')||!profile.includes('current_limit=1.50A gear=5.20'))throw Error('Unexpected profile or sync state');
      save({port:d.port,profile,sync});await send(d.port,'wake');await send(d.port,'stream 100');
    }
    for(const d of devices)for(const duty of [123,246,369])for(const direction of [1,-1]) {
      console.log(JSON.stringify({starting:d.port,duty,direction,seconds:20}));
      const result=await stage(d,duty,direction);save(result);
      console.log(JSON.stringify({port:d.port,duty,direction,error:result.error,metrics:result.metrics}));
      if(result.error)throw Error('Stage aborted: '+result.error);
    }
  }finally {
    for(const d of devices)try{save({port:d.port,stop:await send(d.port,'stop'),status:await send(d.port,'status')});}catch(e){save({port:d.port,cleanupError:e.message});}
    fs.closeSync(out);
  }
}
module.exports={analyze,stage};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
