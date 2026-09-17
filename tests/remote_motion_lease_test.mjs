import assert from 'node:assert/strict';
import {remoteMotionLeaseAction} from '../web/remote-motion-lease.js';

const position={mode:'position',expiresAt:Number.POSITIVE_INFINITY};
assert.equal(remoteMotionLeaseAction(position,1200,900,1150),'wait');
assert.equal(remoteMotionLeaseAction(position,1400,900,1350),'refresh');
assert.equal(remoteMotionLeaseAction(position,3100,900,800),'stale');

const current={mode:'current',expiresAt:4000};
assert.equal(remoteMotionLeaseAction(current,3500,3000,3450),'refresh');
assert.equal(remoteMotionLeaseAction(current,4000,3500,3950),'expire');

const pwm={mode:'pwm',expiresAt:2000};
assert.equal(remoteMotionLeaseAction(pwm,1500,900,1450),'wait');
assert.equal(remoteMotionLeaseAction(pwm,2000,1500,1950),'expire');
assert.equal(remoteMotionLeaseAction(null,2000,1500,1950),'none');
console.log('PASS DATA position lease refresh, selected-duration expiry, stale telemetry stop and bounded PWM');
