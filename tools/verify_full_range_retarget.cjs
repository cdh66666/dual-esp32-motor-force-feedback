// Explicitly authorized unloaded full slider range, sequential motors.
// No gain changes. Test envelope is independent of firmware protection.
const fs=require('node:fs'),path=require('node:path');
const {api,send,delay}=require('./validate_saved_current.cjs');
const devices=[['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']];
const selected=process.argv.find(a=>a.startsWith('--port='))?.slice(7);
const candidate=process.argv.includes('--candidate');
const supplyRps=Number(process.argv.find(a=>a.startsWith('--supply-rps='))?.slice(13)||0);
const matched=process.argv.includes('--matched');
const com4Baseline=process.argv.includes('--com4-baseline');
const damped=process.argv.includes('--damped');
if(damped&&(!supplyRps||matched||candidate||com4Baseline))throw Error('Damped comparison requires supply envelope only');
if(com4Baseline&&(!supplyRps||matched||candidate))throw Error('Baseline comparison requires supply envelope only');
if(matched&&!supplyRps)throw Error('Matched trial requires supply envelope');
if(supplyRps&&(!Number.isFinite(supplyRps)||supplyRps<4||supplyRps>10||candidate))throw Error('Supply trial requires 4..10 r/s, no gain candidate');
if(selected&&!devices.some(([p])=>p===selected))throw Error('Unknown test port');
const report={scope:'Absolute output +/-10 turns; unloaded sequential continuous retarget baseline',candidate,trials:[],final:[]};
const restore=new Map();
async function main(){
 const ports=(await api('ports')).ports;
 for(const [port,id] of devices)if(!ports.some(p=>p.port===port&&p.hwid.includes(id)&&p.telemetry_ok))throw Error('Identity/freshness mismatch: '+port);
 try{
  for(const [port] of devices){await send(port,'stop');await send(port,'sync stop');await send(port,'sleep');}
  for(const [port] of devices.filter(([p])=>!selected||p===selected)){
   const profile=await send(port,'motorprofile status');
   const gear=Number(profile.match(/gear=([\d.]+)/)?.[1]);
   if(gear!==5.2)throw Error('Unexpected gear ratio');
   const trial={port,profile,cascade:await send(port,'cascade status'),commands:[],rows:[]};report.trials.push(trial);
   if(candidate||supplyRps){
    const v=trial.cascade.match(/velocity_hz=\d+ kp=([\d.]+) ki=([\d.]+) max_current=([\d.]+)A friction=([\d.]+)A current_slew=([\d.]+)A\/s brake_slew_x=([\d.]+)/);
    const p=trial.cascade.match(/position_hz=\d+ kp=([\d.]+) ki=([\d.]+) kd=([\d.]+) max_velocity=([\d.]+) acceleration=([\d.]+).*deadband=([\d.]+)/);
    if(!v||!p)throw Error('Cannot snapshot gain configuration');
    restore.set(port,[`cascade velocity ${v.slice(1).join(' ')}`,`cascade position ${p[1]} ${p[2]} ${p[3]} ${p[4]} ${p[6]} 0 ${p[5]}`]);
    if(candidate){
     await send(port,'cascade velocity 0.0003 0.001 1.2 0 80 1');
     await send(port,`cascade position 6 0 0.3 28080 ${p[6]} 0 25000`);
    }else{
     await send(port,`cascade position ${p[1]} ${p[2]} ${p[3]} ${supplyRps*360*gear} ${p[6]} 0 18000`);
     if(matched){
      await send(port,`cascade velocity ${v[1]} ${port==='COM4'?'0.001':'0.002'} ${v[3]} ${v[4]} ${v[5]} ${v[6]}`);
      await send(port,`cascade position 8 0 0.15 ${supplyRps*360*gear} 1 0 18000`);
     }
     if(com4Baseline){
      await send(port,'cascade velocity 0.001 0 1.2 0.3 80 1');
      await send(port,`cascade position 8 0 0.1 ${supplyRps*360*gear} 1 0 18000`);
     }
     if(damped)await send(port,`cascade position 9 0 0.3 ${supplyRps*360*gear} 1 0 18000`);
    }
    trial.candidateConfig=await send(port,'cascade status');
   }
   await send(port,'wake');await send(port,'stream 100');await delay(300);
   const prior=await api(`logs?port=${port}&since=0`);
   let cursor=Math.max(0,...prior.logs.map(r=>r.seq)),fresh=Date.now(),target=NaN;
   const start=Date.now();
   async function collect(ms){
    const end=Date.now()+ms;
    while(Date.now()<end){
     await delay(25);const logs=await api(`logs?port=${port}&since=${cursor}`);
     if(logs.session_id!==prior.session_id)throw Error('USB session changed');
     for(const row of logs.logs){
      cursor=Math.max(cursor,row.seq);
      if(/^(ERR |CASCADE (fault|no_))/.test(row.text))throw Error(row.text);
      if(!row.text.startsWith('S,'))continue;
      const s=row.text.slice(2).split(',').map(Number);fresh=Date.now();
      if(s.length<24||s.some(v=>!Number.isFinite(v))||s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>1800||Math.abs(s[2]/gear/360)>11||Math.abs(s[10]/gear/360)>20)throw Error('Full-range test envelope exceeded: '+row.text);
      const sample={ms:Date.now()-start,mcuMs:s[0],r:s[2]/gear/360,rps:s[10]/gear/360,a:s[4]/1000,pwm:s[5],volts:s[3],target,velocityRefRps:s[19]/gear/360};
      // Rear-shaft instantaneous velocity includes magnetic cyclic error.
      // Keep the raw signal; independently check sustained output speed from
      // unwrapped position over >=100 ms, not from a single derivative sample.
      const previous=trial.rows.findLast(x=>sample.mcuMs-x.mcuMs>=100);
      if(previous&&sample.mcuMs-previous.mcuMs<200){
       sample.travelRps=(sample.r-previous.r)*1000/(sample.mcuMs-previous.mcuMs);
       if(Math.abs(sample.travelRps)>16)throw Error('Sustained 100 ms travel exceeds 16 r/s');
      }
      trial.rows.push(sample);
     }
     if(Date.now()-fresh>250)throw Error('Telemetry stale');
    }
   }
   // Reach full travel, then simulate successive arbitrary slider updates.
   for(const [r,hold] of [[0,4000],[2,3000],[-2,4000],[5,4000],[-5,6000],[10,8000],[-10,10000],[6,250],[-3,200],[9,300],[-8,200],[1,250],[0,6000]]){
    target=r;const at=Date.now();
    await send(port,`posout ${r*360} 4095 ${Math.max(2000,hold+1000)}`);
    trial.commands.push({ms:at-start,r,ackMs:Date.now()-at,hold});
    await collect(hold);
   }
   await send(port,'stop');await send(port,'sleep');
   trial.peakRps=Math.max(...trial.rows.map(r=>Math.abs(r.rps)));
   trial.peakA=Math.max(...trial.rows.map(r=>Math.abs(r.a)));
   trial.minVolts=Math.min(...trial.rows.map(r=>r.volts));
  }
 }catch(e){report.error=e.message;}
 finally{
  for(const [port] of devices)try{await send(port,'stop');await send(port,'sleep');for(const cmd of restore.get(port)||[])await send(port,cmd);report.final.push({port,status:await send(port,'status'),restored:restore.has(port)?await send(port,'cascade status'):null});}catch(e){report.final.push({port,error:e.message});}
  const file=path.join(__dirname,`../evidence/full-range-retarget-${Date.now()}.json`);
  fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({file,error:report.error,trials:report.trials.map(({rows,...t})=>({...t,samples:rows.length})),final:report.final}));
  if(report.error||report.final.some(r=>!r.status?.includes('awake=0')))process.exitCode=1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
