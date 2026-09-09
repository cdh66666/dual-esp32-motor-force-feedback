const assert=require('node:assert/strict');
const {acceptable}=require('../tools/await_current_zero.cjs');
const rows=Array.from({length:12},(_,i)=>({t:i*100,ma:2}));
assert.equal(acceptable(rows),true);
assert.equal(acceptable(rows.slice(0,9)),false);
assert.equal(acceptable(rows.map(r=>({...r,ma:20}))),false);
assert.equal(acceptable(rows.map((r,i)=>({...r,ma:i%2?10:-10}))),false);
assert.equal(acceptable(rows.map(r=>({...r,ma:NaN}))),false);
console.log('PASS: zero gate coverage, mean, noise and finite checks');
