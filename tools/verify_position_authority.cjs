// User-authorized unloaded +/-18 output-degree steps, sequential boards.
const fs=require('node:fs'),path=require('node:path');
const {api,send,delay}=require('./validate_saved_current.cjs');
const {awaitCurrentZero}=require('./await_current_zero.cjs');
const devices=[['COM4','68EE8F5381E4'],['COM23','68EE8F52A79C']];
const selectedPort=process.argv.find(a=>a.startsWith('--port='))?.slice(7);
const holdMs=Number(process.argv.find(a=>a.startsWith('--hold-ms='))?.slice(10)??1200);
const overshootArg=process.argv.find(a=>a.startsWith('--max-overshoot='));
const overshootLimit=overshootArg?Number(overshootArg.slice(16)):null;
if(overshootLimit!==null&&(!Number.isFinite(overshootLimit)||overshootLimit<0||overshootLimit>5))throw Error('Overshoot limit must be 0..5 output degrees');
if(!Number.isInteger(holdMs)||holdMs<1200||holdMs>5000)throw Error('Hold duration must be 1200..5000 ms');
if(selectedPort&&!devices.some(([port])=>port===selectedPort))throw Error('Unknown test port');
const selected=selectedPort?devices.filter(([port])=>port===selectedPort):devices;
const report={scope:'Unloaded +/-18 output degrees; not full-speed or haptic acceptance',overshootLimit,trials:[],final:[]};
async function main(){
 const ports=(await api('ports')).ports;
 for(const [port,id] of devices)if(!ports.some(p=>p.port===port&&p.hwid.includes(id)&&p.telemetry_ok&&!p.maintenance))throw Error('Identity/freshness mismatch');
 try{
  for(const [port] of devices){await send(port,'stop');await send(port,'sleep');}
  for(const [port] of selected){
   await send(port,'wake');await awaitCurrentZero(send,port);
   const status=await send(port,'status'),profile=await send(port,'motorprofile status');
   const gear=Number(profile.match(/gear=([\d.]+)/)?.[1]);
   const origin=Number(status.match(/multi=([-\d.]+)/)?.[1])/gear;
   if(!Number.isFinite(origin)||gear!==5.2)throw Error('Unexpected coordinates');
   let previousTarget=origin;
   for(const offset of [18,0,-18,0]){
    const target=origin+offset,prior=await api(`logs?port=${port}&since=0`);
    let seq=Math.max(...prior.logs.map(r=>r.seq)),fresh=Date.now();
    const trial={port,target,origin,rows:[]};report.trials.push(trial);
    await send(port,`posout ${target} 4095 ${holdMs+600}`);
    const start=Date.now();
    while(Date.now()-start<holdMs){
     await delay(30);
     const logs=await api(`logs?port=${port}&since=${seq}`);
     if(logs.session_id!==prior.session_id)throw Error('USB session changed');
     for(const row of logs.logs){
      seq=Math.max(seq,row.seq);
      if(/^(CASCADE fault|CASCADE no_|ERR )/.test(row.text))throw Error(row.text);
      if(!row.text.startsWith('S,'))continue;
      const s=row.text.slice(2).split(',').map(Number);fresh=Date.now();
      if(s.length<24||s.some(v=>!Number.isFinite(v))||s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>1800||Math.abs(s[2]/gear-origin)>36||Math.abs(s[10]/gear)>2000)throw Error('Small-step test envelope exceeded');
      trial.rows.push({ms:Date.now()-start,pos:s[2]/gear,velocity:s[10]/gear,current:s[4]/1000,pwm:s[5]});
     }
     if(Date.now()-fresh>200)throw Error('Telemetry stale');
    }
    const tail=trial.rows.filter(r=>r.ms>holdMs-200);
    trial.holdMs=holdMs;
    trial.tailPeakToPeakDeg=Math.max(...tail.map(r=>r.pos))-Math.min(...tail.map(r=>r.pos));
    trial.errorDeg=tail.reduce((sum,r)=>sum+Math.abs(r.pos-target),0)/Math.max(1,tail.length);
    trial.peakCurrent=Math.max(...trial.rows.map(r=>Math.abs(r.current)));
    trial.peakOutputRps=Math.max(...trial.rows.map(r=>Math.abs(r.velocity)))/360;
    trial.reachHalfDegreeMs=trial.rows.find(r=>Math.abs(r.pos-target)<=.5)?.ms??null;
    const direction=Math.sign(target-previousTarget);
    trial.overshootDeg=Math.max(0,...trial.rows.map(r=>direction*(r.pos-target)));
    const outside=trial.rows.filter(r=>Math.abs(r.pos-target)>.5);
    trial.settleHalfDegreeMs=outside.length ? (trial.rows.find(r=>r.ms>outside.at(-1).ms)?.ms??null) : 0;
    previousTarget=target;
    trial.passed=tail.length>=5&&trial.errorDeg<.5&&trial.tailPeakToPeakDeg<.5&&(overshootLimit===null||trial.overshootDeg<=overshootLimit);
    await send(port,'stop');await delay(150);
    if(!trial.passed)throw Error(`Position acceptance failed: tail error=${trial.errorDeg}, tail swing=${trial.tailPeakToPeakDeg} (limits 0.5), overshoot=${trial.overshootDeg} (limit ${overshootLimit??'report only'}) output deg`);
   }
   await send(port,'sleep');
  }
 }catch(e){report.error=e.message;}
 finally{
  for(const [port] of devices)try{await send(port,'stop');await send(port,'sleep');report.final.push({port,status:await send(port,'status')});}catch(e){report.final.push({port,error:e.message});}
  report.passed=!report.error&&report.trials.length===selected.length*4&&report.final.every(r=>r.status?.includes('awake=0')&&r.status.includes('pwm=0/4095'));
  const file=path.join(__dirname,`../evidence/position-authority-live-${Date.now()}.json`);
  fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({file,...report,trials:report.trials.map(({rows,...r})=>({...r,samples:rows.length}))}));
  if(!report.passed)process.exitCode=1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
