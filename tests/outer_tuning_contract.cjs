const fs=require('node:fs'),assert=require('node:assert/strict');
const src=fs.readFileSync('firmware/src/main.cpp','utf8');
const load=src.slice(src.indexOf('static void loadMotorModel()'),src.indexOf('static bool rotorCompensationValid('));
const save=src.slice(src.indexOf('rest == "save_outer"'),src.indexOf('rest.startsWith("cogging ")'));
assert(load.includes('motorModelNamespace()'));
assert(load.includes('getBytesLength("outer_v1") == sizeof(outer)'));
assert(load.includes('outerLoopTuningValid(outer)'));
assert(save.includes('driverAwake || modelControlActive || positionActive || pwmDuty() != 0'));
assert(save.includes('putBytes("outer_v2", &outerV2, sizeof(outerV2)) == sizeof(outerV2)'));
assert(load.includes('getBytesLength("outer_v2") == sizeof(outerV2)'));
assert(load.includes('outerLoopTuningV2Valid(outerV2)'));
assert(load.includes('cascadeVelocityFrictionA = outerV2.frictionA;'));
assert(load.includes('cascadePositionDeadbandDeg = outerV2.deadbandDeg;'));
assert(save.includes('putBytes("outer_v3", &outerV3, sizeof(outerV3)) == sizeof(outerV3)'));
assert(load.includes('getBytesLength("outer_v3") == sizeof(outerV3)'));
assert(load.includes('outerLoopTuningV3Valid(outerV3)'));
assert(load.includes('cascadePositionReverseKdScale = outerV3.reverseKdScale;'));
assert(src.includes('cascadePositionKd, cascadePositionReverseKdScale) + positionI;'));
for(const field of ['velocityKp','velocityKi','positionKp','positionKi','positionKd']){
  assert(src.includes(`isfinite(t.${field})`));
  assert(load.includes(`= outer.${field};`));
}
assert(!load.includes('cascadeCurrentKp ='));
assert(!load.includes('cascadeCurrentKi ='));
assert(!save.includes('setDriverAwake('));
assert(!save.includes('modelTargetPositionDegrees ='));
console.log('PASS outer-gain persistence contract: scoped NVS, directional damping, stopped-only save, no current gains/targets');
