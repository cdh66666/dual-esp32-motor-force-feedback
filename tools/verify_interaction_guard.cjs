// Bounded, one-motor-at-a-time current commissioning. No human load assumed.
// This is NOT a bilateral hand-feel, overvoltage, thermal or fault-injection test.
const fs=require('node:fs'),path=require('node:path');
const {api,send,delay}=require('./validate_saved_current.cjs');
async function stopped(port) {
  await send(port,'stop');
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const s=await send(port,'status');
    const v=Number(s.match(/velocity=([-\d.]+)deg\/s/)?.[1]);
    if(s.includes('control=idle')&&s.includes('pwm=0/4095')&&s.includes('nFAULT=1')&&Math.abs(v)<5)return s;
    await delay(100);
  }
  throw Error('Coast settling not confirmed');
}
async function main(){
  const exercise=process.argv.includes('--exercise-derating');
  const levels=exercise?[250,-250,300,-300]:[100,150,200];
  const report={scope:levels.join('/')+'mA,400ms each,one motor at a time; not hand-load acceptance',boards:[]};
  const devices=[{port:'COM4',id:'68EE8F5381E4'},{port:'COM23',id:'68EE8F52A79C'}];
  const ports=(await api('ports')).ports;
  for(const d of devices)if(!ports.some(p=>p.port===d.port&&p.hwid.includes(d.id)&&p.telemetry_ok&&!p.maintenance))throw Error('Identity or freshness mismatch');
  try {
    for(const d of devices){
      const r={port:d.port,trials:[]};report.boards.push(r);
      r.initial=await stopped(d.port);
      const model=await send(d.port,'model');
      await delay(100);
      const initial=await api(`logs?port=${d.port}&since=0`);
      if(!initial.logs.some(x=>x.text.includes('interaction_guard=1')))throw Error('New firmware capability not confirmed');
      r.model=model;
      await send(d.port,'wake');
      r.zero=await require('./await_current_zero.cjs').awaitCurrentZero(send,d.port);
      for(const ma of levels){
        await stopped(d.port);
        const before=await api(`logs?port=${d.port}&since=0`);
        let seq=Math.max(0,...before.logs.map(x=>x.seq)),fresh=Date.now();
        const trial={ma,duration_ms:400,samples:[],warnings:[]};r.trials.push(trial);
        await send(d.port,`current ${ma} 900 500`);
        const until=Date.now()+400;
        while(Date.now()<until){
          await delay(20);
          const batch=await api(`logs?port=${d.port}&since=${seq}`);
          if(batch.session_id!==before.session_id)throw Error('Session changed');
          for(const row of batch.logs){
            seq=Math.max(seq,row.seq);
            if(row.text.startsWith('CONTROL_WARN'))trial.warnings.push(row.text);
            if(/^(ERR |CASCADE fault|CASCADE no_)/.test(row.text))throw Error(row.text);
            if(!row.text.startsWith('S,'))continue;
            const s=row.text.slice(2).split(',').map(Number);
            fresh=Date.now();trial.samples.push(s);
            if(s.length<24||s.some(x=>!Number.isFinite(x))||s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>600||Math.abs(s[10])/5.2>650)throw Error('Commissioning envelope exceeded');
          }
          if(Date.now()-fresh>150)throw Error('Telemetry stale');
        }
        trial.final=await stopped(d.port);
        trial.peakCurrentMa=Math.max(...trial.samples.map(s=>Math.abs(s[4])));
        trial.peakOutputDps=Math.max(...trial.samples.map(s=>Math.abs(s[10])/5.2));
        trial.passed=trial.samples.length>=20&&trial.samples.some(s=>s[11]===1);
        if(!trial.passed)throw Error('Insufficient active-current telemetry');
      }
    }
  }catch(e){report.error=e.message;}
  finally{
    report.final=[];
    for(const d of devices)try{report.final.push({port:d.port,status:await stopped(d.port)});}catch(e){report.final.push({port:d.port,error:e.message});}
    report.passed=!report.error&&report.boards.length===2&&report.boards.every(r=>r.trials.length===levels.length&&r.trials.every(t=>t.passed))&&report.final.every(r=>r.status);
    const file=path.join(__dirname,'../evidence',`interaction-guard-live-${Date.now()}.json`);
    fs.writeFileSync(file,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({file,passed:report.passed,error:report.error,boards:report.boards.map(r=>({port:r.port,trials:r.trials.map(({samples,...t})=>({...t,count:samples.length}))})),final:report.final}));
    if(!report.passed)process.exitCode=1;
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
