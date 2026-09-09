const assert=require('node:assert/strict');const {analyze}=require('../tools/encoder_fixed_pwm.cjs');
function rows(sign){return Array.from({length:1000},(_,i)=>{const s=Array(24).fill(0);s[0]=i*10;s[2]=sign*i*40*360/16384;s[5]=123;s[9]=((sign*i*40)%16384+16384)%16384;return s;});}
let data=rows(1),r=analyze(data,1,5.2);assert(r.maxRawVsMultiMismatchDeg<1e-8);assert.equal(r.reverseStepsOverOneRotorDeg,0);assert(r.wraps>=2);assert(r.enoughRotation);
data=rows(-1);r=analyze(data,-1,5.2);assert(r.maxRawVsMultiMismatchDeg<1e-8);
data=rows(1);data[500][2]+=360;assert(analyze(data,1,5.2).maxRawVsMultiMismatchDeg>359);
console.log('PASS: positive/negative raw-count unwrapping and injected multi-turn discontinuity');
