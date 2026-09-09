const assert=require('node:assert/strict');
const {tailMetrics}=require('../tools/measure_startup_pwm.cjs');
function rows(direction){return Array.from({length:101},(_,i)=>{const s=Array(24).fill(0);s[0]=i*10;s[2]=direction*i*1.04;s[5]=164;s[10]=direction*104;return s;});}
assert.equal(tailMetrics(rows(1),1,164).sustainedLastSecond,true);
assert.equal(tailMetrics(rows(-1),-1,164).sustainedLastSecond,true);
assert.equal(tailMetrics(rows(-1),1,164).sustainedLastSecond,false);
assert.equal(tailMetrics(rows(1).slice(0,10),1,164).sustainedLastSecond,false);
assert.equal(tailMetrics([],1,164).sustainedLastSecond,false);
console.log('PASS: startup tail direction and coverage gates');
