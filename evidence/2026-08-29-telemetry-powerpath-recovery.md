# Dual-board telemetry and power-path recovery — 2026-08-29

## Faults reproduced

- COM18 accepted a 2530 mA current command but remained at PWM 4095, approximately 0 A measured current, and 0 deg/s. The controller was still active; it had not actually stopped.
- COM4 was present and writable but produced no RX bytes under any DTR/RTS combination.

## Changes

- Firmware `0.4.6-telemetry-powerpath-watchdog` stops direct-current control after 350 ms when current target is at least 0.5 A, PWM is at least 90%, measured current remains near zero, and the encoder remains stationary. It reports `CASCADE no_current_response`.
- The server now reports reader state, RX age, connection age, and `telemetry_ok`; stale CDC sessions are no longer presented as healthy.
- The dashboard stops control renewal on serial errors, retries stale telemetry twice, shows a blocking fault dialog, and provides `停止输出并重新连接` recovery.

## Physical verification

- COM18 MAC `68:ee:8f:52:a7:9c`: 0.5 A command held approximately 0.499–0.502 A. A 2.5 A / 1 s test produced measured current up to approximately 2.47 A and encoder speed up to approximately 29,392 deg/s. `nFAULT=1`; timeout returned PWM to zero.
- COM4/COM19 MAC `68:ee:8f:53:81:e4`: recovered through the ROM USB-Serial/JTAG port, flashed with the TinyUSB build, and explicitly returned to application mode. A 0.5 A / 0.8 s test measured approximately 0.508–0.528 A and moved the encoder from 0 to approximately 106 deg. `nFAULT=1`; timeout returned PWM to zero.
- Both live sessions reported `active=true`, `write_ok=true`, `reader_alive=true`, `telemetry_ok=true`, and exactly 100.00 Hz telemetry over 294 samples each.
- UI smoke test showed COM18 and COM4 simultaneously with five live canvases per board and no JavaScript errors.
- STOP/re-arm smoke test passed for position, velocity, and current; latest-slider-target wins; simulated CDC write failure produced the blocking recovery dialog.

## Safe final state

Both boards were issued STOP after testing. No active motion command is retained by the test process.
