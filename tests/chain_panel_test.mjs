import assert from 'node:assert/strict';
import {installChainPanel} from '../web/chain-panel.js';
class Element {
  constructor(){this.options=[];this.value='';this.textContent='';}
  append(o){this.options.push(o);if(!this.value)this.value=o.value;}
  replaceChildren(){this.options=[];this.value='';}
  showModal(){this.open=true;} close(){this.open=false;}
  addEventListener(name,fn){this[name]=fn;}
}
const elements=new Map();
globalThis.document={querySelector(s){if(!elements.has(s))elements.set(s,new Element());return elements.get(s);}};
globalThis.Option=class {constructor(text,value){this.text=text;this.value=value;}};
const $=s=>document.querySelector(s);
const boards=new Map([['COM4',{port:'COM4',active:true,sessionId:'a',busAddress:184}],['COM23',{port:'COM23',active:true,sessionId:'b',busAddress:1}],['DATA-1',{port:'DATA-1',active:true,remote:true,sessionId:'remote'}]]);
const calls=[];let pending=null;
const api=async(path,body)=>{
  if(path==='chain/topology')return {devices:[{address:184},{address:1}]};
  calls.push({path,body});
  if(path==='send')return {reply:'BUS addr=1 uid=9CA7528FEE68 baud=1000000'};
  if(path==='chain/assign-id')return {previous:1,address:body.address,note:'saved'};
  if(pending){const gate=pending;pending=null;await gate;}
  return {devices:body.first===184?[{address:184,uid:'LOCAL',local:true}]:[{address:1,uid:'PEER',local:false}]};
};
installChainPanel({api,boards});
$('#chainOpen').onclick();
assert.deepEqual($('#chainPort').options.map(x=>x.value),['COM4','COM23']);
await $('#chainScan').onclick();
assert.equal(calls.length,2);assert.equal($('#chainDevices').options.length,1);
assert(calls.every(x=>x.path==='chain/scan'),'discovery must never send motion');
let release;pending=new Promise(r=>release=r);
const scan=$('#chainScan').onclick();
$('#chainPort').value='COM23';$('#chainPort').onchange();release();await scan;
assert.equal($('#chainDevices').options.length,0,'old entry results must not leak into new entry');
assert.match($('#chainState').textContent,/入口已切换/);
pending=null;
await $('#chainIdRead').onclick();assert.equal($('#chainNewId').value,'1');
$('#chainNewId').value='7';await $('#chainIdSave').onclick();
assert.equal(calls.at(-1).body.uid,'9CA7528FEE68');
assert.equal(calls.at(-1).body.session_id,'b');assert.equal(boards.get('COM23').busAddress,7);
assert.match($('#chainState').textContent,/已回读/);
console.log('PASS quick two-board scan, physical USB filter, read-only requests and stale-entry cancellation (mock DOM/API)');
