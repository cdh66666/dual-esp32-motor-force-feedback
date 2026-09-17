const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/dashboard.js','utf8');
const backoffCode=source.slice(source.indexOf('function connectBackoffMs'),source.indexOf('function forceState'));
const code=source.slice(source.indexOf('async function connectOrRecover('),source.indexOf("$('#connectAll').addEventListener"));
(async()=>{
 const backoffContext=vm.createContext({Math});
 vm.runInContext(backoffCode,backoffContext);
 assert.equal(backoffContext.connectBackoffMs(1),1000);
 assert.equal(backoffContext.connectBackoffMs(3),4000);
 assert.equal(backoffContext.connectBackoffMs(99),60000);
 let state,commands=[];
 const context=vm.createContext({api:async(endpoint,body)=>{if(endpoint==='ports')return {ports:[state]};commands.push({endpoint,body});return {ok:true};}});
 vm.runInContext(code,context);
 for(const [properties,expected] of [
  [{active:true,write_ok:false,telemetry_ok:false},'recover-link'],
  [{active:true,write_ok:true,telemetry_ok:false,connected_age_ms:10000},'recover-link'],
  [{active:true,write_ok:true,telemetry_ok:true},'connect'],
  [{active:false},'connect']]){
  state={port:'COM4',present:true,...properties};commands=[];
  await context.connectOrRecover('COM4');assert.equal(commands.length,1);assert.equal(commands[0].endpoint,expected);
 }
 state={port:'COM4',present:false};commands=[];await assert.rejects(context.connectOrRecover('COM4'));assert.equal(commands.length,0);
 console.log('PASS explicit connect reopens stale link, no motion commands');
})().catch(e=>{console.error(e);process.exitCode=1;});
