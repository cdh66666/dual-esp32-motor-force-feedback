const fs=require('node:fs'),assert=require('node:assert/strict');
const firmware=fs.readFileSync('firmware/src/main.cpp','utf8');
const match=firmware.match(/const bool useModelEnvelope = ([\s\S]*?);/);
assert(match);
const choose=new Function('continuousCurrent','controlMode','CONTROL_POSITION','CONTROL_VELOCITY',`return ${match[1]};`);
assert.equal(choose(true,1,1,2),false);
assert.equal(choose(true,2,1,2),false);
assert.equal(choose(true,3,1,2),true); // Haptic runs in current mode: unchanged.
assert.equal(choose(true,4,1,2),true); // Knob path: unchanged.
assert.equal(choose(false,3,1,2),false);
assert(firmware.includes('15.0f * 360.0f * motorProfileGearRatio'));
assert(firmware.includes('? interaction::operatingCurrentLimit(current) : min(cascadeVelocityMaxCurrentA, current)'));
assert(firmware.includes('constrain(cascadeCurrentCommandA, -operatingLimit, operatingLimit)'));
console.log('PASS position/velocity voltage authority; haptic/knob selection unchanged; current reference ceiling retained');
