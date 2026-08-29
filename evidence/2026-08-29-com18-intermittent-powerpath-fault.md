# COM18 intermittent power-path fault — 2026-08-29

## Captured failure

At 14:05:53 the dashboard sent `current 1190 4095 30000` to COM18.

- Current target: 1.190 A.
- Measured INA240 motor-branch current: approximately -0.002 to +0.002 A.
- Signed PWM command: ramped from 638 to 4095.
- Encoder velocity and displacement: 0 throughout the event.
- Motor bus: stable at approximately 19.43–19.47 V.
- Driver state: `nFAULT=1`, `awake=1`, `nSLEEP=1`, `nRESET=1`, current-step I0/I1 both high.
- Firmware response: `CASCADE no_current_response target=1.190A measured=-0.002A pwm=4095`, followed by `control=idle`, target 0, PWM 0.

This excludes USB loss, command timeout, bus undervoltage, encoder-only failure, and ordinary PID tuning as the cause of that stop. The controller was producing an increasing bridge command, but the motor branch was open or the bridge was not switching.

## Intermittent nature

After a deterministic MCU/driver reset, the same board and wiring accepted a 0.600 A command and regulated approximately 0.590–0.607 A at PWM 67–74. Firmware 0.4.8 then accepted 0.500 A and measured approximately 0.459–0.485 A during the short transient, with nFAULT remaining high.

Therefore the evidence does not support a permanently broken motor wire. The leading explanations are:

1. SS6952T internal switching state stopped and did not recover from an idempotent WAKE, even though nFAULT had returned high.
2. ESP32 LEDC-to-ENBL GPIO routing became inactive while software duty bookkeeping still reported the requested PWM.
3. A genuinely intermittent output connector or solder joint remains possible, but is not proven because reset alone restored conduction during this run.

## Implemented containment and next-occurrence evidence

- Firmware `0.4.8-latched-powerpath-recovery` applies the no-power-response detector to current, velocity, and position modes.
- A detected event stops PWM and latches the controller. Old renewals and new motion commands are rejected until an explicit `recover`.
- `recover` forces nSLEEP and nRESET low, executes the complete wake sequence, rebuilds the LEDC mapping, recalibrates zero current, and leaves PWM at zero.
- The server automatically writes the pre-fault ring buffer and fault line to `evidence/fault-captures/<timestamp>-COM18.jsonl`.
- A controller timestamp rollback clears every browser-side motion renewal so a firmware restart cannot silently resume a stale slider command.

## Safe final state

COM18 was left at `control=idle`, PWM 0. COM4 was disconnected by the user and was not accessed during this investigation.
