# Software-first audit and bridge-output A/B — 2026-08-29

## Outcome

The current software did contain several real race conditions that could make a
valid command appear to do nothing. They are fixed in the working tree and the
COM18 firmware is now `0.4.4-idempotent-wake-diagnostics`.

Those software defects do **not** explain COM18's remaining zero-output result.
The same bounded direct-bridge test was run with the current firmware and the
last physically accepted `0.3.23-cascade-final` firmware. COM18 produced no
encoder movement and only tens of milliamps in both builds, while COM19 moved
hundreds of degrees and drew amperes with `0.3.23`. This is a board/path-specific
result, not a common PID, PWM-frequency, web, serial, or motor-model result.

## Confirmed software defects fixed

1. The server sent an unconditional delayed `wake` one second after connect.
   Because firmware WAKE called `motorStop()`, a command sent just after page
   load could be cancelled one second later.
2. WAKE was not idempotent. Duplicate readiness requests reset all controller
   state. It now leaves an already-awake, active controller untouched; an
   intentional recovery reset remains `sleep` followed by `wake`.
3. The browser combined its local readiness flag with a stale telemetry frame,
   causing a second WAKE during motion startup.
4. Reconnect reused and cleared the previous reader/monitor Event. An old thread
   could resume and read the new serial handle concurrently with the new thread.
   Each connection now has immutable events and an immutable serial object.
5. Position, velocity and current sliders had independent delayed sends. An old
   mode could arrive after a newer mode and overwrite it. All three now share a
   latest-target-wins generation.
6. The four cascade-parameter commands could interleave with motion. They now
   execute as one serialized transaction and repeat if values changed mid-send.
7. Active-control `status` substituted the stored current zero and `0 mV` bus
   ADC instead of live ADC snapshots. Status now reads and reports the real pins.
8. The STOP/re-arm browser smoke test sent real actuator commands. Its `/api/send`
   requests are now intercepted, so it is a software-only regression test.

## Static and software-only verification

- PlatformIO firmware build: success, 20,912 bytes RAM, 391,609 bytes flash.
- PlatformIO cppcheck: 0 high, 0 medium; only unreachable legacy/style findings.
- Python compile and Node syntax checks: pass.
- Serial lifecycle test: old reader stopped; monitor sent only `stream 100`,
  `businfo`, `model`; no WAKE.
- Browser STOP/re-arm test: position, velocity and current commands all available
  after STOP.
- Rapid cross-mode test: `position 40`, `velocity 400`, `current 400` produced
  exactly one actuator command, `current 400`.
- Physical duplicate-WAKE test on COM18: current control continued from PWM
  146.8 to 578.0 after a second WAKE; it was no longer reset.

## Physical A/B evidence

All direct tests first set nSLEEP/nRESET/I0/I1 high, select PHASE, detach LEDC,
hold ENBL high directly, and finish with ENBL low/STOP.

| Board / firmware | Direct pulse | Encoder delta | Peak branch current | Result |
|---|---:|---:|---:|---|
| COM18 / 0.4.4 | CW 50 ms | 0.00 deg | 41 mA | no output |
| COM18 / 0.4.4 | CCW 50 ms | 0.00 deg | 58 mA | no output |
| COM18 / 0.3.23 accepted baseline | CW 50 ms | 0.00 deg | 28 mA | no output |
| COM18 / 0.3.23 accepted baseline | CCW 50 ms | 0.00 deg | 29 mA | no output |
| COM19 / 0.3.23 same baseline | CW 50 ms | -344.77 deg | 7.631 A transient | output works |
| COM19 / 0.3.23 same baseline | CCW 50 ms | +384.87 deg | 8.134 A transient | output works |

During the COM18 0.4.4 test:

- ENBL stayed 1; PHASE stayed 1 for CW and 0 for CCW.
- nSLEEP=1, nRESET=1, I0=1, I1=1, nFAULT remained 1.
- Motor bus remained 19.41–19.46 V.
- INA240 ADC remained about 1.647–1.653 V, close to its zero.

The 7–8 A COM19 numbers are short transient measurements, not a continuous
current recommendation or a validated thermal rating.

## Remaining code debt (not on the active control path)

`modelControlTick`, `updateCascadePositionTrajectory`, and `wrappedAngleError`
are unreachable legacy helpers according to cppcheck. The page and current
commands use `cascadeControlTick`. They cannot cause the current COM18 failure,
but should be removed in a later cleanup instead of being mistaken for active
features.

## Narrow hardware check now justified for COM18

The next check is not “replace the motor.” It is to locate the open/inhibited
node on COM18 while running a bounded direct test:

1. Power off: measure resistance across H1 MOTOR+ / MOTOR-. An open circuit
   isolates the connector/cable/motor path.
2. Power on, awake, bounded direct pulse: verify at U5 itself that pin 21 ENBL,
   pin 17 nSLEEP, pin 16 nRESET, pins 23/24 I0/I1 are about 3.3 V.
3. Verify U5 VM pins 4/11, V3P3OUT pin 15, VREF pins 12/13, and charge-pump C15.
4. Measure OUT1 and OUT2 during CW/CCW. If logic pins are valid but OUT1/OUT2 do
   not switch, the fault is U5/VCP/VREF/MODE1/assembly. If they switch at U5 but
   not at H1, inspect R15/MOTOR+ and MOTOR- routing/connector soldering.

COM19's attempted update failed during the USB handshake before erase/write, so
its old application should still be intact. Its CDC OUT endpoint currently needs
a physical unplug/replug before another upload attempt.
