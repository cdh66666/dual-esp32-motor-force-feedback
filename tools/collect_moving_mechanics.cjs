// Powered, bounded velocity identification with original PI; no tuning adoption.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {api,send,stopped,delay}=require('./validate_saved_current.cjs');
const {restoreStoppedConfiguration}=require('./restore_stopped_configuration.cjs');
const electricalGroup=require('./electrical_configuration.cjs');
const {awaitCurrentZero}=require('./await_current_zero.cjs');
const root=path.resolve(__dirname,'..');
async function capture(port,target,gear,duration=600) {
  const status=await stopped(port),origin=Number(status.match(/multi=([-\d.]+)/)?.[1]);
  if(!Number.isFinite(origin))throw Error('Missing origin');
  const old=await api(`logs?port=${port}&since=0`),epoch=old.session_id;
  let cursor=Math.max(0,...old.logs.map(r=>r.seq)),freshAt=Date.now();
  const result={targetOutputDps:target,trace:[]};
  try {
    await send(port,`velocity ${target*gear} 900 ${duration+200}`);
    const until=Date.now()+duration;
    while(Date.now()<until) {
      const state=await api(`logs?port=${port}&since=${cursor}`);
      if(state.session_id!==epoch)throw Error('USB session changed');
      for(const row of state.logs) {
        cursor=Math.max(cursor,row.seq);
        if(row.direction!=='rx')continue;
        if(/^(ERR |CASCADE (fault|no_))/.test(row.text))throw Error(row.text);
        if(!row.text.startsWith('S,'))continue;
        const s=row.text.slice(2).split(',').map(Number); freshAt=Date.now();
        result.trace.push({t:s[0],multi:s[2]/gear,velocity:s[10]/gear,current:s[4]/1000,pwm:s[5],bus:s[3],control:s[11]});
        if(s.some(x=>!Number.isFinite(x))||s[6]!==1||s[3]<17||s[3]>21||Math.abs(s[4])>400||Math.abs(s[2]-origin)/gear>25||Math.abs(s[10])/gear>180)throw Error('Identification telemetry envelope exceeded');
      }
      if(Date.now()-freshAt>150)throw Error('Telemetry stale');
      await delay(15);
    }
  }catch(e){result.error=e.message;}
  finally{await send(port,'stop');}
  return result;
}
async function main() {
  const reports=[];
  const neutralCompensation=process.argv.includes('--neutral-compensation');
  const computedCurrent=process.argv.includes('--computed-current');
  const validatedCurrent=process.argv.includes('--validated-current');
  if(validatedCurrent&&computedCurrent)throw Error('Select one current candidate source');
  const slowIntegral=process.argv.includes('--slow-integral');
  for(const port of ['COM4','COM23'])await send(port,'stop');
  try {
    for(const port of ['COM4','COM23']) {
      const saved=JSON.parse(fs.readFileSync(path.join(root,`evidence/bounded-identify-${port}-20260908.json`),'utf8'));
      const report={port,date:new Date().toISOString(),gear:saved.gear,scope:'600ms low-speed stages; original PI; 0.3A outer limit; no new gains adopted',stages:[]};reports.push(report);
      report.neutralCompensation=neutralCompensation;
      report.computedCurrent=computedCurrent;
      report.velocityKiScale=slowIntegral?.25:1;
      report.durationMs=slowIntegral?1200:600;
      if(slowIntegral)report.scope='1200ms signed 10deg/s candidate validation; Ki quarter baseline; 0.3A limit; no gain adoption';
      let restore,restoreCompensation,restoreCurrent;
      try {
        const device=(await api('ports')).ports.find(p=>p.port===port),id=saved.hwid.match(/SER=([^ ]+)/)?.[1];
        if(!id||!device?.hwid.includes('SER='+id)||!device.telemetry_ok||device.maintenance)throw Error('Identity/freshness mismatch');
        report.hwid=device.hwid;
        const profile=await send(port,'motorprofile status'),sync=await send(port,'sync status');
        if(!profile.includes('current_limit=1.50A gear=5.20')||!sync.includes('mode=off')||!sync.includes('armed=0'))throw Error('Profile/sync mismatch');
        report.model=await send(port,'model');if(!report.model.includes('fw=0.5.9-sync-trace'))throw Error('Unexpected firmware');
        const oldLogs=await api(`logs?port=${port}&since=0`),cfgCursor=Math.max(0,...oldLogs.logs.map(x=>x.seq));
        const config=await send(port,'cascade status');report.originalConfiguration=config;
        if(config.trim()!==saved.originalConfiguration.trim())throw Error('Configuration changed');
        const m=config.match(/velocity_hz=500 kp=([\d.]+) ki=([\d.]+) max_current=([\d.]+)A friction=([\d.]+)A current_slew=([\d.]+)A\/s brake_slew_x=([\d.]+)/);
        if(!m)throw Error('Missing velocity snapshot');
        restore=`cascade velocity ${m.slice(1).join(' ')}`;
        await stopped(port);await send(port,'wake');await send(port,'stream 100');
        report.zeroCheck=await awaitCurrentZero(send,port);
        if(validatedCurrent){
          const file='evidence/saved-current-validation-1788882901973.json';
          const candidate=JSON.parse(fs.readFileSync(path.join(root,file),'utf8')).find(r=>r.port===port);
          if(candidate?.error||candidate?.trials?.length!==6||candidate.trials.some(t=>t.error||!t.metrics?.passed)||!candidate.cleanup?.ok)throw Error('Missing prospective current validation');
          report.currentValidationFile=file;report.scope='600ms low-speed stages; prospectively tested electrical group; 0.3A outer limit; original gains restored';
          report.originalElectrical=electricalGroup.parse(await send(port,'cascade electrical'));
          restoreCurrent=electricalGroup.command(report.originalElectrical);
          report.electricalTransaction=await electricalGroup.apply(send,port,candidate.groupTransaction.applied);
        }
        if(computedCurrent) {
          const c=config.match(/current_hz=2000 kp=([\d.]+) ki=([\d.]+) max_pwm=([\d.]+)/);
          if(!c)throw Error('Missing current snapshot');
          restoreCurrent=`cascade current ${c[1]} ${c[2]} ${c[3]}`;
          const src=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
          vm.runInContext(src.slice(src.indexOf('function fitControlRows('),src.indexOf('async function runAutoTune(')),ctx);
          const status=await send(port,'status'),bus=Number(status.match(/bus=([\d.]+)/)?.[1]);
          const e=ctx.fitControlRows(ctx.movingElectricalRows(saved.pulses,saved.gear),'electrical');
          report.calculatedCurrent=ctx.electricalControllerFromFit(e,bus);
          await send(port,`cascade current ${report.calculatedCurrent.currentKp} ${report.calculatedCurrent.currentKi} ${c[3]}`);
        }
        if(neutralCompensation) {
          let compensation;const until=Date.now()+1500;
          while(!compensation&&Date.now()<until) {
            const logs=await api(`logs?port=${port}&since=${cfgCursor}`);
            compensation=logs.logs.find(x=>x.direction==='rx'&&x.text.startsWith('COGGING_CFG '))?.text;
            if(!compensation)await delay(30);
          }
          const c=compensation?.match(/scale=([\d.]+) coulomb=([-\d.]+)A offset=([-\d.]+)A/);
          if(!c)throw Error('Missing fresh compensation snapshot');
          report.originalCompensation=compensation;
          restoreCompensation=`cascade cogging enable ${c[1]} ${c[2]} ${c[3]}`;
          report.compensationDisabled=await send(port,`cascade cogging enable 0 ${c[2]} ${c[3]}`);
        }
        await send(port,`cascade velocity ${m[1]} ${Number(m[2])*report.velocityKiScale} ${Math.min(.3,Number(m[3]))} 0 ${m[5]} ${m[6]}`);
        for(const target of (slowIntegral?[10,-10,10,-10]:[10,20,10,-10,-20,-10,20,-20])) {
          const stage=await capture(port,target,saved.gear,report.durationMs);report.stages.push(stage);
          if(stage.error)throw Error(stage.error);
        }
      }catch(e){report.error=e.message;}
      finally {
        report.cleanup=await restoreStoppedConfiguration(send,port,[restoreCurrent,restore,restoreCompensation]);
        report.restored=report.cleanup.restores.find(x=>x.command===restore)?.reply;
        report.compensationRestored=report.cleanup.restores.find(x=>x.command===restoreCompensation)?.reply;
        report.finalStatus=report.cleanup.status;
        if(report.originalElectrical){
          try{
            report.restoredElectrical=electricalGroup.parse(await send(port,'cascade electrical'));
            if(!electricalGroup.matches(report.restoredElectrical,report.originalElectrical))throw Error('Electrical group restore mismatch');
          }catch(e){report.cleanup.ok=false;report.cleanup.errors.push(e.message);}
        }
        if(!report.cleanup.ok)throw Error('Rollback incomplete; abort remaining tests: '+report.cleanup.errors.join('; '));
        report.finalStatus=await stopped(port);
      }
    }
  }finally {
    for(const port of ['COM4','COM23'])try{await send(port,'stop');}catch(e){reports.push({port,stopError:e.message});}
    const out=path.join(root,'evidence',`moving-mechanics-${Date.now()}.json`);
    fs.writeFileSync(out,JSON.stringify(reports,null,2),{encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({file:out,reports:reports.map(r=>({port:r.port,error:r.error,restored:r.restored,stages:r.stages?.map(s=>({target:s.targetOutputDps,samples:s.trace.length,error:s.error,meanVelocity:s.trace.slice(-20).reduce((a,r)=>a+r.velocity,0)/Math.min(20,s.trace.length)})),finalStatus:r.finalStatus}))}));
    if(reports.some(r=>r.error||r.stopError||r.cleanup?.ok===false))process.exitCode=1;
  }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
