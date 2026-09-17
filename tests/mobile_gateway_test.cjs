// Executes the real embedded page JS against a mock transport: no hardware.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('firmware/src/wifi_gateway.cpp','utf8');
const html=source.split('R"HTML(')[1].split(')HTML"')[0];
const js=html.split('<script>')[1].split('</script>')[0].replaceAll('%ADDR%','184');
const calls=[],elements=new Map();
function element(id){if(!elements.has(id))elements.set(id,{value:id==='#address'?'184':id==='#signal'?'position':'',textContent:'',options:[],replaceChildren(...v){this.options=v;},selectedOptions:[{textContent:'位置 r'}]});return elements.get(id);}
const ctx=vm.createContext({document:{querySelector:element,hidden:false},performance:{now:()=>1000},Option:function(text,value){this.text=text;this.value=value;},console,AbortController,setTimeout,clearTimeout,
 fetch:async(url,options)=>{const [addr,uid,cmd]=options.body.split('|');calls.push({addr,uid,cmd});let text='';
  if(cmd==='gatewayinfo')text=`META,${addr},${addr==='184'?'E481538FEE68':'9CA7528FEE68'},5.2,1.5,2`;
  else if(cmd==='status')text=`STATUS,${addr},0,1872,19.5,120,0,1,0,0,1872,0,0`;
  else text='ACK,1,accepted='+cmd;
  return {ok:true,text:async()=>text};}});
// Disable automatic startup only; functions and handlers remain actual source.
vm.runInContext(js.replace('scan(false).finally(poll);',''),ctx);
vm.runInContext('draw=()=>{}',ctx);
(async()=>{
 await vm.runInContext('scan(false)',ctx);
 assert(calls.length===2&&calls.every(x=>x.cmd==='gatewayinfo'),'startup discovery only reads two distinct addresses');
 assert.equal(vm.runInContext('known.size',ctx),2);
 await vm.runInContext("request('status','',184).then(s=>sample(184,s))",ctx);
 assert.equal(vm.runInContext('known.get(184).samples[0].position',ctx),1);
 assert.equal(vm.runInContext('known.get(184).samples[0].velocity',ctx),1);
 assert.equal(vm.runInContext('known.get(184).samples[0].current',ctx),.12);
 vm.runInContext("choose(1)",ctx);assert.equal(element('#address').value,1);
 vm.runInContext('busy=true',ctx);
 const stopped=element('#stop').onclick();
 assert.equal(vm.runInContext('stopPending',ctx),true);
 vm.runInContext('busy=false',ctx);await stopped;
 assert.equal(calls.at(-1).cmd,'stop');assert.equal(calls.at(-1).addr,'1');
 assert(calls.every(x=>['gatewayinfo','status','stop'].includes(x.cmd)));
 console.log('PASS embedded mobile discovery, units, queued stop; mocked transport only');
})().catch(e=>{console.error(e);process.exitCode=1;});
