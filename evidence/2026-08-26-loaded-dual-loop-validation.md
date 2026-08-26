# Loaded dual-board cascade validation — 2026-08-26

## Hardware identity and firmware

- COM18 eFuse MAC: `68:ee:8f:52:a7:9c`
- COM19 eFuse MAC: `68:ee:8f:53:81:e4`
- Both boards flashed with the same `0.3.23-cascade-final` binary; SHA-256 `B6283CA2A0586FF768B8B49495915CC050786A8CAEA45FF4605F211D0D7E6E26`; esptool verified both write hashes.
- Motor bus during final test: COM18 19.46 V, COM19 19.40 V.
- Control rates: current 2 kHz, velocity 200 Hz, position 100 Hz; raw USB telemetry 100 Hz.

Only assembly calibration differs between boards: COM18 direction/current sense normal; COM19 direction/current sense inverted. Controller code and gains are identical.

## Current-path boundary

The schematic gives `VREF = 3.3 V * 10 kOhm / (16.5 kOhm + 10 kOhm) = 1.245 V`. With the 50 mOhm ISEN resistor and `IFS = VREF / (5 * Rsense)`, SS6952T full-scale regulation is approximately 4.98 A. INA240A1 gain 20 with a 10 mOhm external shunt gives 0.2 V/A.

Short 6 A and 7 A diagnostic commands were applied in both directions. A 7 A command produced measured peaks of approximately 4.65 A on both boards, PWM about 3,800–3,900/4,095, `nFAULT=1`. This confirms the independent hardware chopper limit; it does not establish a 7 A continuous rating.

## Closed-loop measurements

### Current loop, target +/-0.5 A

| Board | Positive tail | Negative tail | Absolute error | nFAULT |
|---|---:|---:|---:|---:|
| COM18 | +0.501 A | -0.501 A | <=1.4 mA | 1 |
| COM19 | +0.500 A | -0.502 A | <=1.8 mA | 1 |

Final-binary raw captures: `tools/captures/current-step-COM18-20260826-101629.csv` and `tools/captures/current-step-COM19-20260826-101636.csv`.

### Velocity loop, target +/-3000 deg/s

| Board | Positive tail | Negative tail | Worst overshoot | nFAULT |
|---|---:|---:|---:|---:|
| COM18 | +2995.5 deg/s | -3000.8 deg/s | 3.40% | 1 |
| COM19 | +3001.3 deg/s | -3000.6 deg/s | 4.72% | 1 |

Final-binary raw captures: `tools/captures/velocity-step-20260826-101652.csv` and `tools/captures/velocity-step-20260826-101704.csv`. Both signs settled inside the 10% band within 0.52 s, with no PWM sign reversal and `nFAULT=1` throughout.

The unloaded motor cannot rotate smoothly below its magnetic-detent/breakaway region. Open-loop motion starts near 5% duty and already reaches roughly 2000 deg/s. Low-speed velocity mode therefore uses one-direction pulse-density/coast control; reported values below about 1000 deg/s are average speed, not a continuously smooth shaft speed.

### Position loop

Independent 1080 deg tests settled with final absolute error below 1.4 deg on both boards. The final browser-driven simultaneous test used a common 360 deg target, held the final position, then returned to zero and held again:

| State | COM18 | COM19 | Telemetry | nFAULT |
|---|---:|---:|---:|---:|
| 360 deg hold | 360.64 deg | 360.86 deg | 100.0–100.1 Hz | 1 / 1 |
| zero hold | 2.44 deg | 0.94 deg | 100.0 Hz | 1 / 1 |

Evidence screenshot: `evidence/dual-closed-loop.png`.

## UI and deferred scope

- Two real ESP32 USB ports are enumerated dynamically; no synthetic COM entries are used.
- Each board renders five independent charts with explicit axes and latest measured/target values.
- Raw serial acquisition is 100 Hz; all raw samples are retained for the 10-second chart window while paint is decoupled from acquisition to keep pointer interaction responsive.
- Motion commands now fail visibly before transmission when bus voltage is below 6 V or `nFAULT=0`.
- Final UI smoke test: two connected boards, five canvases each, telemetry present, no JavaScript errors.
- COM19 DATA loaded synchronization and bilateral force feedback were explicitly deferred. They are not claimed as accepted in this version.

Final safe state after testing: both boards received `STOP`; PWM is zero and `nFAULT=1`.
