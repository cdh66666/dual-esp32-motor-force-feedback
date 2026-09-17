// Source contract + numeric filter checks. No device access or motor motion.
const fs=require('node:fs'),assert=require('node:assert/strict');
const src=fs.readFileSync('firmware/src/main.cpp','utf8');
const start=src.indexOf('static void busSendStatus(');
const body=src.slice(start,src.indexOf('\n}',start)+2);
assert(body.includes('float currentMa = cascadeMeasuredCurrentA * 1000.0f;'));
assert(/if \(!modelControlActive\) \{\s*const float currentMv = filterCurrentSenseMillivolts\(readCurrentSenseMillivolts\(\)\);/.test(body));
assert(body.includes('if (!encoderTurnInitialized) readEncoder(raw, singleDegrees);'));
assert(!body.includes('\n  readEncoder(raw, singleDegrees);'));
const filter=src.slice(src.indexOf('static float filterCurrentSenseMillivolts('),src.indexOf('static float readSignedCurrentMilliamps('));
assert(filter.includes('1522.05f'));assert(filter.includes('motor_control::lowPassAlpha(elapsedUs, tauUs)'));
assert(src.includes('ENCODER_VELOCITY_WINDOW_US = 5000'));
assert(src.includes('ENCODER_MEDIAN_BLEND = 0.65f'));
assert(src.includes('encoderVelocityWindow.update(velocityDeltaDegrees, dtUs'));
assert(src.includes('CURRENT_ZERO_TARGET_A = 0.015f'));
assert(src.includes('CURRENT_ZERO_MEASURED_A = 0.035f'));
const tau=.00152205,alpha=1-Math.exp(-.0005/tau);
assert(Math.abs(alpha-.28)<.0001);
console.log(JSON.stringify({passed:true,scope:'cached DATA status; existing filter unchanged; numeric values are analytic, not hardware measurements',activeTauMs:tau*1000,cutoffHz:1/(2*Math.PI*tau),step90Ms:-Math.log(.1)*tau*1000}));
