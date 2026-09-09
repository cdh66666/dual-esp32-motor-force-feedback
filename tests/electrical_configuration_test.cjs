const assert=require('node:assert/strict'),test=require('node:test');
const {parse,command,apply}=require('../tools/electrical_configuration.cjs');
const original={R:2,Ke:.011,kp:600,ki:600000,max_pwm:4095},candidate={R:3,Ke:.03,kp:140,ki:35000,max_pwm:4095};
const reply=c=>'OK cascade_electrical '+Object.entries(c).map(([k,v])=>k+'='+v).join(' ')+' volatile=1';
test('roundtrip and range checking',()=>{assert.deepEqual(parse(reply(original)),original);assert.throws(()=>command({...candidate,Ke:NaN}));assert.throws(()=>parse('MODEL R=2'));});
test('group applies with readback, mismatch restores whole original group',async()=>{
 for(const fail of [false,true]){
  let state={...original},reads=0;const calls=[];
  const send=async(p,c)=>{calls.push(c);if(c==='stop')return 'OK stop';if(c==='cascade electrical'){reads++;return reply(fail&&reads===2?original:state);}state=Object.fromEntries(Object.keys(original).map((k,i)=>[k,Number(c.split(' ')[i+2])]));return reply(state);};
  if(fail){await assert.rejects(apply(send,'mock',candidate),/original electrical group restored/);assert.deepEqual(state,original);}
  else{const r=await apply(send,'mock',candidate);assert.deepEqual(r.applied,candidate);}
  assert.equal(calls[0],'stop');
 }
});
test('old firmware cannot receive candidate writes',async()=>{
 const calls=[];await assert.rejects(apply(async(p,c)=>{calls.push(c);return c==='stop'?'OK stop':'ERR unknown command';},'mock',candidate),/unavailable/);
 assert.deepEqual(calls,['stop','cascade electrical']);
});
