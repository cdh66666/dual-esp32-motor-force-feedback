const test=require('node:test'),assert=require('node:assert/strict');
const {verify}=require('../tools/verify_electrical_group.cjs');
const original={R:2,Ke:.011,kp:600,ki:600000,max_pwm:4095};
const reply=s=>'OK cascade_electrical '+Object.entries(s).map(([k,v])=>k+'='+v).join(' ');
test('sleeping roundtrip restores all fields and issues no motion',async()=>{
 let state={...original};const calls=[];
 const send=async(p,c)=>{
  calls.push(c);
  if(c==='stop')return 'OK stop';if(c==='sleep')return 'OK driver_awake=0';
  if(c==='sync status')return 'SYNC mode=off armed=0';
  if(c==='status')return 'STATUS control=idle pwm=0/4095 awake=0';
  if(c==='cascade electrical')return reply(state);
  if(c.startsWith('cascade electrical ')){state=Object.fromEntries(Object.keys(original).map((k,i)=>[k,Number(c.split(' ')[i+2])]));return reply(state);}
  throw Error('Unexpected command '+c);
 };
 const r=await verify(send,'mock');assert.equal(r.passed,true);assert.deepEqual(state,original);
 assert.equal(calls.some(c=>/^(wake|current |velocity |pos |cw |ccw )/.test(c)),false);
});
test('unsupported firmware is not counted as passed',async()=>{
 const r=await verify(async(p,c)=>({stop:'OK stop',sleep:'OK driver_awake=0','sync status':'SYNC mode=off armed=0',status:'STATUS control=idle pwm=0/4095 awake=0'}[c]||'ERR usage'),'mock');
 assert.equal(r.passed,false);assert.match(r.error,/unavailable/);assert.equal(r.transaction,undefined);
});
