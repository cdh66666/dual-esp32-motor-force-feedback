const keys=['R','Ke','kp','ki','max_pwm'];
function parse(reply){
 if(!reply.startsWith('OK cascade_electrical '))throw Error('Grouped electrical API unavailable');
 const config={};for(const key of keys){const m=reply.match(new RegExp('(?:^| )'+key+'=([-+0-9.eE]+)(?: |$)'));config[key]=Number(m?.[1]);}
 validate(config);return config;
}
function validate(c){
 if(keys.some(k=>!Number.isFinite(c[k]))||c.R<.05||c.R>20||c.Ke<.0001||c.Ke>.2||c.kp<0||c.kp>5000||c.ki<0||c.ki>2000000||c.max_pwm<1||c.max_pwm>4095)throw Error('Invalid electrical configuration');
}
function command(c){validate(c);return 'cascade electrical '+keys.map(k=>c[k]).join(' ');}
function matches(a,b){return keys.every(k=>Math.abs(a[k]-b[k])<=Math.max(1e-7,Math.abs(b[k])*2e-6));}
async function apply(send,port,c){
 validate(c);
 if(!(await send(port,'stop')).startsWith('OK stop'))throw Error('STOP not confirmed');
 const original=parse(await send(port,'cascade electrical'));
 try{
  const ack=parse(await send(port,command(c)));
  const readback=parse(await send(port,'cascade electrical'));
  if(!matches(ack,c)||!matches(readback,c))throw Error('Grouped electrical readback mismatch');
  return {original,applied:readback,restoreCommand:command(original)};
 }catch(e){
  try{
   if(!(await send(port,'stop')).startsWith('OK stop'))throw Error('Rollback STOP not confirmed');
   await send(port,command(original));
   if(!matches(parse(await send(port,'cascade electrical')),original))throw Error('Rollback readback mismatch');
  }catch(rollback){throw Error(e.message+'; ROLLBACK FAILED: '+rollback.message);}
  throw Error(e.message+'; original electrical group restored');
 }
}
module.exports={parse,validate,command,matches,apply};
