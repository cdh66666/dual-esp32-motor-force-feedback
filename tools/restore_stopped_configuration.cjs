// Every restoration is attempted after a confirmed STOP. No motion commands.
async function restoreStoppedConfiguration(send,port,commands) {
  const result={port,stopConfirmed:false,restores:[],errors:[]};
  try {
    result.stopReply=await send(port,'stop');
    if(!result.stopReply.startsWith('OK stop'))throw Error('Unexpected STOP reply');
    result.stopConfirmed=true;
  }catch(e){result.errors.push('stop: '+e.message);}
  if(result.stopConfirmed) {
    for(const command of commands.filter(Boolean)) {
      // Deliberately restrict this helper to non-motion cascade configuration.
      if(!/^cascade (electrical |current |velocity |position |breakaway |hold (on|off)$|cogging enable )/.test(command)) {
        result.errors.push('invalid restore command: '+command);continue;
      }
      try {result.restores.push({command,ok:true,reply:await send(port,command)});}
      catch(e){result.restores.push({command,ok:false,error:e.message});result.errors.push(command+': '+e.message);}
    }
  }
  try {
    result.status=await send(port,'status');
    if(!result.status.includes('control=idle')||!result.status.includes('pwm=0/4095'))result.errors.push('final output not confirmed idle');
  }catch(e){result.errors.push('status: '+e.message);}
  result.ok=result.stopConfirmed&&result.errors.length===0;
  return result;
}
module.exports={restoreStoppedConfiguration};
