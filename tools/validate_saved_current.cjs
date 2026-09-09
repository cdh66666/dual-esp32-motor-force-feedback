// Bounded powered validation; calculates from saved data, always restores PI.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {restoreStoppedConfiguration}=require('./restore_stopped_configuration.cjs');
const electricalGroup=require('./electrical_configuration.cjs');
const {awaitCurrentZero}=require('./await_current_zero.cjs');
const root=path.resolve(__dirname,'..'),src=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8'),ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function currentTraceMetrics('),src.indexOf('async function runAutoTune(')),ctx);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(endpoint,body) {
  const r=await fetch('http://127.0.0.1:8766/api/'+endpoint,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(2000)});
  const data=await r.json(); if(!r.ok||data.ok===false)throw Error(JSON.stringify(data)); return data;
}
async function send(port,command) {const r=await api('send',{port,command,wait_ack:true});if(!r.acknowledged)throw Error('Missing ACK');return r.reply;}
async function stopped(port) {
  await send(port,'stop');
  const deadline=Date.now()+3000;let stable=Date.now();
  while(Date.now()<deadline) {
    const s=await send(port,'status');
    if(!s.includes('control=idle')||!s.includes('pwm=0/4095')||!s.includes('nFAULT=1'))throw Error(s);
    if(Math.abs(Number(s.match(/velocity=([-\d.]+)/)?.[1]))>5.2)stable=Date.now();
    if(Date.now()-stable>=300)return s;
    await delay(40);
  }
  throw Error('Motor did not settle');
}
function currentEnvelopeError(s,origin,gear,profile='short-position'){
  if(!['short-position','moving-current'].includes(profile))return 'Unknown test envelope';
  const currentLimit=profile==='moving-current'?400:800,positionLimit=profile==='moving-current'?90:25;
  if(s.length<24||s.some(x=>!Number.isFinite(x)))return 'Invalid telemetry';
  if(s[6]!==1)return `Driver nFAULT=${s[6]}`;
  if(s[3]<17||s[3]>21)return `Bus voltage ${s[3]}V outside 17-21V`;
  if(Math.abs(s[4])>currentLimit)return `Feedback current ${s[4]}mA exceeds ${currentLimit}mA test bound`;
  if(profile==='moving-current'&&Math.abs(s[10])/gear>400)return 'Output speed exceeds 400deg/s moving-current bound';
  const displacement=Math.abs(s[2]-origin)/gear;
  if(displacement>positionLimit)return `Output displacement ${displacement.toFixed(3)}deg exceeds ${positionLimit}deg ${profile} test bound`;
  return null;
}
async function trial(port,ma,gear,profile='short-position') {
  if(!['short-position','moving-current'].includes(profile)||!Number.isFinite(ma)||(profile==='moving-current'&&Math.abs(ma)>200))throw Error('Unsupported current trial scope');
  const status=await stopped(port),origin=Number(status.match(/multi=([-\d.]+)/)?.[1]);
  if(!Number.isFinite(origin))throw Error('Missing position');
  const prior=await api(`logs?port=${port}&since=0`),epoch=prior.session_id;
  let cursor=Math.max(0,...prior.logs.map(r=>r.seq)),trace=[],samples=[];
  await send(port,'trace arm 512');
  let error=null;
  try {
    await send(port,`current ${ma} 900 220`);
    const deadline=Date.now()+180;
    while(Date.now()<deadline) {
      const state=await api(`logs?port=${port}&since=${cursor}`);
      if(state.session_id!==epoch)throw Error('USB session changed');
      for(const row of state.logs) {
        cursor=Math.max(cursor,row.seq);
        if(row.direction!=='rx')continue;
        if(/^(ERR |CASCADE (fault|no_))/.test(row.text))throw Error(row.text);
        if(!row.text.startsWith('S,'))continue;
        const s=row.text.slice(2).split(',').map(Number);samples.push(s);
        const envelopeError=currentEnvelopeError(s,origin,gear,profile);
        if(envelopeError)throw Error(envelopeError);
      }
      await delay(15);
    }
  }catch(e){error=e.message;}
  finally{await send(port,'stop');}
  const meta=await send(port,'trace dump'),count=Number(meta.match(/count=(\d+)/)?.[1]);
  if(!Number.isInteger(count)||count<0||count>512)throw Error('Invalid trace count');
  const deadline=Date.now()+5000;
  while(trace.length<count&&Date.now()<deadline) {
    const state=await api(`logs?port=${port}&since=${cursor}`);
    if(state.session_id!==epoch)throw Error('USB session changed during dump');
    for(const row of state.logs) {
      cursor=Math.max(cursor,row.seq);
      if(row.direction==='rx'&&row.text.startsWith('T,'))trace.push(row.text.slice(2).split(',').map(Number));
    }
    await delay(20);
  }
  if(trace.length!==count)error=error||'Incomplete trace';
  let metrics=null;
  if(!error)try{metrics=ctx.currentTraceMetrics(trace,ma/1000);}catch(e){error=e.message;}
  return {ma,origin,gear,profile,error,metrics,samples,trace};
}
async function main() {
  const reports=[];
  const ladder=process.argv.includes('--ladder');
  const grouped=process.argv.includes('--grouped');
  const steady=process.argv.includes('--steady-ke');
  if(steady&&!grouped)throw Error('--steady-ke requires grouped application');
  const levels=steady?[100,-100,150,-150,200,-200]:ladder?[100,-100,150,-150,200,-200,250,-250,300,-300]:[150,-150];
  for(const port of ['COM4','COM23'])await send(port,'stop');
  try {
    for(const port of ['COM4','COM23']) {
      const saved=JSON.parse(fs.readFileSync(path.join(root,`evidence/bounded-identify-${port}-20260908.json`),'utf8'));
      const report={port,scope:ladder?'100-300mA signed short-pulse validation only; restore original PI':'150mA signed short-pulse validation only; restore original PI',trials:[]};reports.push(report);
      report.grouped=grouped;
      let original;
      try {
        const model=await send(port,'model');
        if(!model.includes('fw=0.5.9-sync-trace'))throw Error('Unexpected firmware');
        const config=await send(port,'cascade status');report.originalConfiguration=config;
        const m=config.match(/current_hz=2000 kp=([\d.]+) ki=([\d.]+) max_pwm=([\d.]+)/);
        if(!m)throw Error('Cannot parse current PI snapshot');
        const device=(await api('ports')).ports.find(p=>p.port===port);
        const expectedId=saved.hwid.match(/SER=([^ ]+)/)?.[1];
        if(!expectedId||!device?.hwid.includes('SER='+expectedId)||!device.telemetry_ok||device.maintenance)throw Error('Hardware identity/freshness mismatch');
        const profile=await send(port,'motorprofile status'),sync=await send(port,'sync status');
        if(!profile.includes('current_limit=1.50A gear=5.20')||!sync.includes('mode=off')||!sync.includes('armed=0'))throw Error('Unexpected profile or active synchronization');
        report.profile=profile;report.sync=sync;
        if(config.trim()!==saved.originalConfiguration.trim())throw Error('Configuration changed since identification');
        original=`cascade current ${m[1]} ${m[2]} ${m[3]}`;
        const status=await stopped(port),bus=Number(status.match(/bus=([\d.]+)/)?.[1]);
        if(!(bus>=17&&bus<=21))throw Error('Supply outside 20V test envelope');
        const calculated=ctx.electricalControllerFromFit(ctx.fitControlRows(ctx.movingElectricalRows(saved.pulses,saved.gear),'Electrical'),bus);
        if(steady){
          const file='evidence/steady-ke-1788882856743.json';
          const candidate=JSON.parse(fs.readFileSync(path.join(root,file),'utf8')).commonModels.find(r=>r.port===port);
          if(!candidate?.passed||Math.abs(candidate.R-calculated.R)>1e-6)throw Error('Steady candidate not validated or mismatched R');
          calculated.Ke=candidate.Ke;calculated.voltageDrop=0;calculated.electricalMethod='steady-Ke-fixed-transient-R-L';
          report.steadyCandidateFile=file;report.scope='Prospective +/-100/150/200mA short moving-current test of steady Ke; restore entire group';
        }
        report.calculated=calculated;
        if(grouped){
          const independent=JSON.parse(fs.readFileSync(path.join(root,'evidence/saved-current-validation-1788881164154.json'),'utf8')).find(r=>r.port===port);
          const pulses=independent.trials.filter(t=>!t.error).map(t=>({...t,samples:t.samples.map(s=>({t:s[0],velocity:s[10]/saved.gear}))}));
          const rows=ctx.movingElectricalRows(pulses,saved.gear),coefficients=[calculated.R,calculated.effectiveL,calculated.voltageDrop,calculated.Ke];
          report.independentErrors=pulses.map((p,i)=>{
            const r=rows.filter(r=>r.group===i),energy=r.reduce((s,r)=>s+r.y*r.y,0);
            const residual=r.reduce((s,r)=>s+(r.y-r.x.reduce((sum,x,j)=>sum+x*coefficients[j],0))**2,0);
            return {ma:p.ma,samples:r.length,relativeError:Math.sqrt(residual/energy)};
          });
          if(report.independentErrors.length<4||report.independentErrors.some(r=>r.samples<4||!Number.isFinite(r.relativeError)||r.relativeError>.25))throw Error('Independent per-pulse model validation failed; group not applied');
          report.originalElectrical=electricalGroup.parse(await send(port,'cascade electrical'));
          original=electricalGroup.command(report.originalElectrical);
          report.groupTransaction=await electricalGroup.apply(send,port,{R:calculated.R,Ke:calculated.Ke,kp:calculated.currentKp,ki:calculated.currentKi,max_pwm:Number(m[3])});
        }
        await send(port,'wake');await send(port,'stream 100');
        report.zeroCheck=await awaitCurrentZero(send,port);
        if(!grouped)await send(port,`cascade current ${calculated.currentKp} ${calculated.currentKi} ${m[3]}`);
        for(const ma of levels) {
          const r=await trial(port,ma,saved.gear,steady?'moving-current':'short-position');report.trials.push(r);
          console.log(JSON.stringify({port,ma,error:r.error,metrics:r.metrics}));
          if(r.error)throw Error(r.error);
        }
      }catch(e){report.error=e.message;}
      finally {
        report.cleanup=await restoreStoppedConfiguration(send,port,[original]);
        report.restored=report.cleanup.restores.find(x=>x.command===original)?.reply;
        report.finalStatus=report.cleanup.status;
        if(report.originalElectrical){
          try{
            report.restoredElectrical=electricalGroup.parse(await send(port,'cascade electrical'));
            if(!electricalGroup.matches(report.restoredElectrical,report.originalElectrical))throw Error('Electrical restore readback mismatch');
          }catch(e){report.cleanup.ok=false;report.cleanup.errors.push(e.message);}
        }
        if(!report.cleanup.ok)throw Error('Rollback incomplete; abort remaining tests: '+report.cleanup.errors.join('; '));
      }
    }
  } finally {
    for(const port of ['COM4','COM23'])try{await send(port,'stop');}catch(e){reports.push({port,stopError:e.message});}
    const out=path.join(root,'evidence',`saved-current-validation-${Date.now()}.json`);
    fs.writeFileSync(out,JSON.stringify(reports,null,2),{encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({file:out,reports:reports.map(r=>({port:r.port,error:r.error,trials:r.trials?.map(t=>({ma:t.ma,error:t.error,metrics:t.metrics})),restored:r.restored,finalStatus:r.finalStatus}))}));
    if(reports.some(r=>r.error||r.stopError||r.cleanup?.ok===false))process.exitCode=1;
  }
}
module.exports={api,send,stopped,delay,currentEnvelopeError,trial};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
