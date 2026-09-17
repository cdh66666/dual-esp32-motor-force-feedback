// User-authorized bounded live acceptance through one USB gateway.
// Moves each output by a configurable positive step at a bounded PWM ceiling,
// then sends STOP and proves both local and DATA-remote outputs are idle.
// This is deliberately not a full-range, speed, or haptic test.
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.MOTOR_DEBUG_URL || 'http://127.0.0.1:8766';
const USB = process.env.MOTOR_READONLY_PORT || 'COM4';
const REMOTE = Number(process.env.MOTOR_REMOTE_ADDRESS || 1);
const GEAR = 5.2;
// A visible but bounded default step: large enough to judge by eye, still far
// below the full-range UI limit. Override with MOTOR_STEP_DEG when needed.
const STEP_DEG = Number(process.env.MOTOR_STEP_DEG || 45);
const DUTY = Number(process.env.MOTOR_TEST_DUTY || 800);
const COMMAND_MS = Number(process.env.MOTOR_COMMAND_MS || 7000);
const ONLY_LOCAL = process.env.MOTOR_ONLY_LOCAL === '1';
const ONLY_REMOTE = process.env.MOTOR_ONLY_REMOTE === '1';
const RETURN_TO_ORIGIN = process.env.MOTOR_RETURN_TO_ORIGIN !== '0';
const ISOLATE_PEER_USB = process.env.MOTOR_ISOLATE_PEER_USB !== '0';
const REMOTE_SAMPLE_INTERVAL_MS = 20;
const PEER_PORT = USB === 'COM4' ? 'COM23' : 'COM4';
const KNOWN_SERIAL = {COM4: '68EE8F5381E4', COM23: '68EE8F52A79C'};
const MIN_BUS_V = Number(process.env.MOTOR_TEST_BUS_MIN_V || 20);
const MAX_BUS_V = Number(process.env.MOTOR_TEST_BUS_MAX_V || 26);
const MAX_ACCEPTABLE_OVERSHOOT_DEG = Number(process.env.MOTOR_MAX_OVERSHOOT_DEG || 0.5);
const SETTLE_TIMEOUT_MS = Math.min(6000, COMMAND_MS - 250);
if (!Number.isFinite(STEP_DEG) || STEP_DEG < 1 || STEP_DEG > 180) throw new Error('MOTOR_STEP_DEG must be 1..180 output degrees');
if (!Number.isInteger(DUTY) || DUTY < 12 || DUTY > 1800) throw new Error('MOTOR_TEST_DUTY must be 12..1800');
if (ONLY_LOCAL && ONLY_REMOTE) throw new Error('Select only one of MOTOR_ONLY_LOCAL or MOTOR_ONLY_REMOTE');
if (!Number.isInteger(COMMAND_MS) || COMMAND_MS < 1000 || COMMAND_MS > 10000) throw new Error('MOTOR_COMMAND_MS must be 1000..10000');
if (!Number.isFinite(MIN_BUS_V) || !Number.isFinite(MAX_BUS_V) || MIN_BUS_V < 8 || MAX_BUS_V > 50 || MIN_BUS_V >= MAX_BUS_V) throw new Error('Invalid bus-voltage test envelope');
if (!Number.isFinite(MAX_ACCEPTABLE_OVERSHOOT_DEG) || MAX_ACCEPTABLE_OVERSHOOT_DEG < 0 || MAX_ACCEPTABLE_OVERSHOOT_DEG > 5) throw new Error('MOTOR_MAX_OVERSHOOT_DEG must be 0..5');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(endpoint, body) {
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: {'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(JSON.stringify(data));
  return data;
}
async function sessionId() {
  return (await api(`logs?port=${encodeURIComponent(USB)}&since=0`)).session_id;
}
async function send(command, session) {
  const data = await api('send', {port: USB, command, wait_ack: true, session_id: session});
  if (!data.acknowledged) throw new Error(`missing ACK for ${command}`);
  return data.reply;
}
async function remoteQuery(command, session) {
  return api('chain/query', {port: USB, session_id: session, address: REMOTE, command});
}
async function remoteControl(mode, value, session, spec) {
  const result = await api('chain/control', {
    port: USB, session_id: session, address: REMOTE, uid: spec.uid, mode, value,
  });
  if (result.ok !== true || result.accepted !== true) {
    throw new Error(`remote ${mode} rejected: ${JSON.stringify(result)}`);
  }
  return result;
}
function parseLocalStatus(reply) {
  const get = name => Number(reply.match(new RegExp(`${name}=([-+\\d.]+)`))?.[1]);
  return {
    busV: get('bus'), angleDeg: get('angle'), multiDeg: get('multi'),
    velocityDps: get('velocity'), pwm: get('pwm'), currentMa: get('motor_current'),
    nFault: get('nFAULT'), awake: get('awake'), control: reply.match(/control=([^ ]+)/)?.[1] || '',
    raw: reply,
  };
}
function parseRemoteStatus(reply) {
  const fields = reply.split(',');
  if (fields.length !== 13 || fields[0] !== 'STATUS') throw new Error(`invalid remote status: ${reply}`);
  const numbers = fields.slice(1).map(Number);
  if (numbers.some(value => !Number.isFinite(value)) || numbers[0] !== REMOTE) {
    throw new Error(`non-numeric remote status: ${reply}`);
  }
  return {
    address: numbers[0], singleDeg: numbers[1], multiDeg: numbers[2], busV: numbers[3],
    currentMa: numbers[4], pwm: numbers[5], nFault: numbers[6], awake: numbers[7],
    velocityDps: numbers[9], control: numbers[10], target: numbers[11], raw: reply,
  };
}
async function readLocalUntilSettled(cursor, session, targetOutputDeg) {
  const rows = [];
  const startedAt = Date.now();
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let settledSince = 0;
  let lastDirection = 0;
  let directionReversals = 0;
  while (Date.now() < deadline) {
    const state = await api(`logs?port=${encodeURIComponent(USB)}&since=${cursor}`);
    if (state.session_id !== session) throw new Error('USB session changed during motion');
    for (const entry of state.logs) {
      cursor = Math.max(cursor, entry.seq);
      if (entry.direction !== 'rx' || !entry.text.startsWith('S,')) continue;
      const fields = entry.text.slice(2).split(',').map(Number);
      if (fields.length < 26 || fields.some(value => !Number.isFinite(value))) continue;
      const positionOutputDeg = fields[2] / GEAR;
      const velocityOutputRps = fields[10] / (360 * GEAR);
      const row = {         // S telemetry fields after the leading `S,` are:
        // t,single,multi,bus,current,pwm,nFAULT,awake,step,raw,velocity,
        // control,target,phase,pwm_signed,pid_raw,pid_applied,stall,settled,
        // velocity_target,current_target,current_measured,cascade_pwm,
        // raw_velocity,target_position,flags.
        timeMs: fields[0], motorAngleDeg: fields[1], motorMultiDeg: fields[2],
        positionOutputDeg, velocityOutputRps,
        busV: fields[3], currentA: fields[4] / 1000, pwm: fields[5], nFault: fields[6],
        awake: fields[7], velocityDps: fields[10], control: fields[11], target: fields[12],
        phase: fields[13], signedPwm: fields[14], positionPidRaw: fields[15],
        positionPidApplied: fields[16], stall: fields[17], controllerSettled: fields[18],
        velocityTargetDps: fields[19], currentTargetA: fields[20] / 1000,
        currentMeasuredA: fields[21] / 1000, cascadePwm: fields[22],
        rawVelocityDps: fields[23], targetPositionOutputDeg: fields[24] / GEAR,
        flags: fields[25],
      };
      if (row.nFault !== 1 || row.busV < MIN_BUS_V || row.busV > MAX_BUS_V || Math.abs(row.currentA) > 1.8 || Math.abs(row.velocityOutputRps) > 16) {
        throw new Error(`local motion envelope exceeded: ${JSON.stringify(row)}`);
      }
      rows.push(row);
      const direction = Math.abs(velocityOutputRps) > 0.08 ? Math.sign(velocityOutputRps) : 0;
      if (direction && lastDirection && direction !== lastDirection) directionReversals++;
      if (direction) lastDirection = direction;
      const settled = Math.abs(targetOutputDeg - positionOutputDeg) <= 0.75 && Math.abs(velocityOutputRps) <= 0.08;
      if (settled) settledSince ||= Date.now();
      else settledSince = 0;
      if (settledSince && Date.now() - settledSince >= 250) {
        rows.directionReversals = directionReversals;
        rows.settleTimeMs = Date.now() - startedAt;
        return {cursor, rows, settled: true};
      }
    }
    await wait(20);
  }
  rows.directionReversals = directionReversals;
  return {cursor, rows, settled: false};
}
async function readRemoteUntilSettled(session, spec, targetOutputDeg) {
  const rows = [];
  const startedAt = Date.now();
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let lastRenew = Date.now();
  let settledSince = 0;
  let lastDirection = 0;
  let directionReversals = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastRenew >= 500) {
      await remoteControl('position', targetOutputDeg / 360, session, spec);
      lastRenew = Date.now();
    }
    const row = parseRemoteStatus((await remoteQuery('status', session)).reply);
    row.timeMs = Date.now();
    row.positionOutputDeg = row.multiDeg / GEAR;
    row.velocityOutputRps = row.velocityDps / (360 * GEAR);
    row.currentA = row.currentMa / 1000;
    if (row.nFault !== 1 || row.busV < MIN_BUS_V || row.busV > MAX_BUS_V || Math.abs(row.currentA) > 1.8 || Math.abs(row.velocityOutputRps) > 16) {
      throw new Error(`remote motion envelope exceeded: ${JSON.stringify(row)}`);
    }
    rows.push(row);
    const direction = Math.abs(row.velocityOutputRps) > 0.08 ? Math.sign(row.velocityOutputRps) : 0;
    if (direction && lastDirection && direction !== lastDirection) directionReversals++;
    if (direction) lastDirection = direction;
    const settled = Math.abs(targetOutputDeg - row.positionOutputDeg) <= 0.75 && Math.abs(row.velocityOutputRps) <= 0.08;
    if (settled) settledSince ||= Date.now();
    else settledSince = 0;
    if (settledSince && Date.now() - settledSince >= 250) {
      rows.directionReversals = directionReversals;
      rows.settleTimeMs = Date.now() - startedAt;
      return {rows, settled: true};
    }
    await wait(REMOTE_SAMPLE_INTERVAL_MS);
  }
  rows.directionReversals = directionReversals;
  return {rows, settled: false};
}
function motionSummary(rows, originOutputDeg, targetOutputDeg, settled = false) {
  const points = rows.filter(row => Number.isFinite(row.positionOutputDeg));
  if (!points.length) return {samples: 0, settled: false};
  const direction = Math.sign(targetOutputDeg - originOutputDeg);
  const overshootDeg = Math.max(0, ...points.map(row => direction * (row.positionOutputDeg - targetOutputDeg)));
  return {
    samples: points.length,
    finalErrorDeg: targetOutputDeg - points.at(-1).positionOutputDeg,
    overshootDeg,
    peakOutputRps: Math.max(...points.map(row => Math.abs(row.velocityOutputRps))),
    peakCurrentA: Math.max(...points.map(row => Math.abs(row.currentA))),
    minBusV: Math.min(...points.map(row => row.busV)),
    directionReversals: rows.directionReversals || 0,
    settleTimeMs: rows.settleTimeMs ?? null,
    settled,
  };
}
function assertMotionQuality(summary, label) {
  if (!summary.settled) {
    throw new Error(`${label} did not settle within ${SETTLE_TIMEOUT_MS} ms; samples=${summary.samples}`);
  }
  if (summary.overshootDeg > MAX_ACCEPTABLE_OVERSHOOT_DEG) {
    throw new Error(`${label} overshoot ${summary.overshootDeg.toFixed(3)}° exceeds ${MAX_ACCEPTABLE_OVERSHOOT_DEG.toFixed(3)}° acceptance`);
  }
}
function assertIdle(local, remote) {
  if (!local.raw.includes('pwm=0/4095') || !local.raw.includes('control=idle') || local.nFault !== 1) {
    throw new Error(`local not idle: ${local.raw}`);
  }
  if (remote.pwm !== 0 || remote.control !== 0 || remote.nFault !== 1) {
    throw new Error(`remote not idle: ${remote.raw}`);
  }
}
async function main() {
  const report = {
    scope: `single USB gateway, unloaded +/-${STEP_DEG} output-degree move${RETURN_TO_ORIGIN ? ' with trajectory return' : ''}, duty<=${DUTY}, ${ONLY_LOCAL ? 'local only' : ONLY_REMOTE ? 'remote only' : 'sequential pair'}, settled and stop-verified`,
    usb: USB, remoteAddress: REMOTE, gear: GEAR, stepDeg: STEP_DEG, duty: DUTY,
    busVoltageEnvelope: [MIN_BUS_V, MAX_BUS_V],
    peerUsbIsolated: false,
    startedAt: new Date().toISOString(), local: {}, remote: {}, cleanup: {}, passed: false,
  };
  let session;
  let spec;
  let peerIsolated = false;
  try {
    const ports = (await api('ports')).ports;
    const physical = ports.find(p => p.port === USB && p.esp32 && p.active && p.telemetry_ok && !p.maintenance);
    if (!physical) throw new Error(`healthy physical USB entry not available: ${USB}`);
    session = await sessionId();
    const topology = (await api('chain/topology')).devices || [];
    spec = topology.find(d => d.address === REMOTE);
    if (!spec) throw new Error(`remote address ${REMOTE} not in topology`);

    await send('stop', session);
    // Explicitly clear the backend wake hint for remote-only tests. Older
    // running backends incorrectly treated STOP as WAKE; sleeping the idle
    // peer makes the test exercise the acknowledged wake-then-position path.
    if (ONLY_REMOTE) await remoteControl('sleep', 0, session, spec);
    else await remoteControl('stop', 0, session, spec);
    let localStatus = parseLocalStatus(await send('status', session));
    let remoteStatus = parseRemoteStatus((await remoteQuery('status', session)).reply);
    assertIdle(localStatus, remoteStatus);

    if (ISOLATE_PEER_USB) {
      const peer = ports.find(p => p.port === PEER_PORT && p.present && p.esp32);
      if (peer && peer.hwid && peer.hwid.includes(KNOWN_SERIAL[PEER_PORT]) && peer.active) {
        await api('maintenance', {port: PEER_PORT, enabled: true});
        peerIsolated = true;
        report.peerUsbIsolated = true;
      }
      // Prove the peer is still reachable through DATA after its application
      // USB session is deliberately held in maintenance.
      remoteStatus = parseRemoteStatus((await remoteQuery('status', session)).reply);
      assertIdle(localStatus, remoteStatus);
    }

    if (!ONLY_REMOTE) {
      // Local board: wake, read origin, issue one bounded output step.
      await send('wake', session);
      await send('stream 100', session);
      localStatus = parseLocalStatus(await send('status', session));
      const localOriginOutputDeg = localStatus.multiDeg / GEAR;
      const localTargetOutputDeg = localOriginOutputDeg + STEP_DEG;
      const before = (await api(`logs?port=${encodeURIComponent(USB)}&since=0`));
      const localTrace = await (async () => {
        await send(`posout ${localTargetOutputDeg.toFixed(6)} ${DUTY} ${COMMAND_MS}`, session);
        return readLocalUntilSettled(Math.max(0, ...before.logs.map(row => row.seq)), session, localTargetOutputDeg);
      })();
      report.local = {
        originOutputDeg: localOriginOutputDeg,
        targetOutputDeg: localTargetOutputDeg,
        samples: localTrace.rows,
        outward: motionSummary(localTrace.rows, localOriginOutputDeg, localTargetOutputDeg, localTrace.settled),
      };
      assertMotionQuality(report.local.outward, 'local outward');
      if (RETURN_TO_ORIGIN) {
        const returnBefore = await api(`logs?port=${encodeURIComponent(USB)}&since=0`);
        await send(`posout ${localOriginOutputDeg.toFixed(6)} ${DUTY} ${COMMAND_MS}`, session);
        const returned = await readLocalUntilSettled(
          Math.max(0, ...returnBefore.logs.map(row => row.seq)), session, localOriginOutputDeg);
        report.local.returnTargetOutputDeg = localOriginOutputDeg;
        report.local.returnSamples = returned.rows;
        report.local.return = motionSummary(returned.rows, localTargetOutputDeg, localOriginOutputDeg, returned.settled);
        assertMotionQuality(report.local.return, 'local return');
      }
      await send('stop', session);
      await wait(160);
      localStatus = parseLocalStatus(await send('status', session));
      report.local.final = localStatus;
      if (!localStatus.raw.includes('pwm=0/4095') || !localStatus.raw.includes('control=idle')) {
        throw new Error(`local stop readback failed: ${localStatus.raw}`);
      }
    }

    if (!ONLY_LOCAL) {
      // DATA peer: use the same bounded command, routed through the single USB.
      remoteStatus = parseRemoteStatus((await remoteQuery('status', session)).reply);
      const remoteOriginOutputDeg = remoteStatus.multiDeg / GEAR;
      const remoteTargetOutputDeg = remoteOriginOutputDeg + STEP_DEG;
      // chain/control uses the same output-coordinate contract as the UI and
      // waits for the remote ACK, so no second DATA transaction can collide.
      await remoteControl('position', remoteTargetOutputDeg / 360, session, spec);
      const remoteTrace = await readRemoteUntilSettled(session, spec, remoteTargetOutputDeg);
      report.remote = {
        originOutputDeg: remoteOriginOutputDeg,
        targetOutputDeg: remoteTargetOutputDeg,
        samples: remoteTrace.rows,
        outward: motionSummary(remoteTrace.rows, remoteOriginOutputDeg, remoteTargetOutputDeg, remoteTrace.settled),
      };
      assertMotionQuality(report.remote.outward, 'remote outward');
      if (RETURN_TO_ORIGIN) {
        await remoteControl('position', remoteOriginOutputDeg / 360, session, spec);
        const returned = await readRemoteUntilSettled(session, spec, remoteOriginOutputDeg);
        report.remote.returnTargetOutputDeg = remoteOriginOutputDeg;
        report.remote.returnSamples = returned.rows;
        report.remote.return = motionSummary(returned.rows, remoteTargetOutputDeg, remoteOriginOutputDeg, returned.settled);
        assertMotionQuality(report.remote.return, 'remote return');
      }
      await remoteControl('stop', 0, session, spec);
      await wait(160);
      remoteStatus = parseRemoteStatus((await remoteQuery('status', session)).reply);
      report.remote.final = remoteStatus;
      if (remoteStatus.pwm !== 0 || remoteStatus.control !== 0) {
        throw new Error(`remote stop readback failed: ${remoteStatus.raw}`);
      }
    }
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (session) {
      try { await send('stop', session); report.cleanup.localStop = true; } catch (error) { report.cleanup.localStop = String(error); }
      try { await remoteControl('stop', 0, session, spec); report.cleanup.remoteStop = true; } catch (error) { report.cleanup.remoteStop = String(error); }
      try { await send('sleep', session); report.cleanup.localSleep = true; } catch (error) { report.cleanup.localSleep = String(error); }
      try { await remoteControl('sleep', 0, session, spec); report.cleanup.remoteSleep = true; } catch (error) { report.cleanup.remoteSleep = String(error); }
      try {
        const local = parseLocalStatus(await send('status', session));
        const remote = parseRemoteStatus((await remoteQuery('status', session)).reply);
        report.cleanup.finalLocal = local;
        report.cleanup.finalRemote = remote;
        report.passed = report.passed && local.pwm === 0 && local.control === 'idle' && remote.pwm === 0 && remote.control === 0;
      } catch (error) { report.cleanup.readback = String(error); report.passed = false; }
    }
    if (peerIsolated) {
      try {
        await api('maintenance', {port: PEER_PORT, enabled: false});
        await api('connect', {port: PEER_PORT});
        await wait(300);
        const peerState = await api('send', {port: PEER_PORT, command: 'status', wait_ack: true});
        report.cleanup.peerDirectStatus = peerState.reply;
        if (!peerState.reply.includes('awake=0') || !peerState.reply.includes('pwm=0/4095') || !peerState.reply.includes('control=idle')) {
          report.cleanup.peerDirectStatusError = 'reconnected peer was not idle/asleep';
          report.passed = false;
        }
      } catch (error) {
        report.cleanup.peerReconnect = String(error);
        report.passed = false;
      }
    }
    report.finishedAt = new Date().toISOString();
    const file = path.join(__dirname, '..', 'evidence', `single-usb-pair-step-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), {encoding: 'utf8', flag: 'wx'});
    // Keep full-rate traces in the evidence file, but make the console output
    // a compact test result so long unsettled traces do not flood the UI.
    console.log(JSON.stringify({
      file,
      scope: report.scope,
      usb: report.usb,
      remoteAddress: report.remoteAddress,
      stepDeg: report.stepDeg,
      duty: report.duty,
      passed: report.passed,
      error: report.error,
      local: {
        originOutputDeg: report.local.originOutputDeg,
        targetOutputDeg: report.local.targetOutputDeg,
        outward: report.local.outward,
        return: report.local.return,
        final: report.local.final,
      },
      remote: {
        originOutputDeg: report.remote.originOutputDeg,
        targetOutputDeg: report.remote.targetOutputDeg,
        outward: report.remote.outward,
        return: report.remote.return,
        final: report.remote.final,
      },
      cleanup: report.cleanup,
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
module.exports = {motionSummary, assertMotionQuality};
if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
