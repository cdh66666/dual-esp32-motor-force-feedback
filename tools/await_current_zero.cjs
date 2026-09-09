function statistics(rows){
 const mean=rows.reduce((a,r)=>a+r.ma,0)/Math.max(1,rows.length);
 const rms=Math.sqrt(rows.reduce((a,r)=>a+r.ma*r.ma,0)/Math.max(1,rows.length));
 return {samples:rows.length,spanMs:rows.length?rows.at(-1).t-rows[0].t:0,meanMa:mean,rmsMa:rms};
}
function acceptable(rows){const s=statistics(rows);return rows.every(r=>Number.isFinite(r.ma)&&Number.isFinite(r.t))&&s.samples>=10&&s.spanMs>=900&&Math.abs(s.meanMa)<=5&&s.rmsMa<=5;}
async function awaitCurrentZero(send,port){
 const start=Date.now(),rows=[];let stableRows=[];
 while(Date.now()-start<8000){
  const reply=await send(port,'status');
  const ma=Number(reply.match(/motor_current=([-\d.]+)mA/)?.[1]),speed=Number(reply.match(/velocity=([-\d.]+)deg\/s/)?.[1]);
  if(!reply.includes('control=idle')||!reply.includes('awake=1')||!reply.includes('pwm=0/4095')||!reply.includes('nFAULT=1')||!Number.isFinite(ma)||!Number.isFinite(speed))throw Error('Zero check invalid state: '+reply);
  const row={t:Date.now(),ma,speed};rows.push(row);
  if(Math.abs(speed)>2)stableRows=[];else stableRows.push(row);
  const window=stableRows.slice(-12);
  if(acceptable(window))return {waitMs:Date.now()-start,...statistics(window),rows};
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error('Awake zero did not settle within 8s: '+JSON.stringify({current:statistics(stableRows.slice(-12)),last:rows.at(-1)}));
}
module.exports={statistics,acceptable,awaitCurrentZero};
