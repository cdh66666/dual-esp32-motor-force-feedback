# COM18 fast current/velocity response pass — 2026-08-28

## Delivered controller changes

- Shared firmware version: `0.4.3-fast-current-velocity`.
- Current loop remains at the loaded-hardware validated `Kp=400`, `Ki=1800`, 2 kHz. Its gain was not raised because the command-aligned capture already shows a fast, low-overshoot response.
- Direct velocity target ramp increased from `60000` to `600000 deg/s^2`; a 3000 deg/s target is therefore presented in one 200 Hz velocity-loop tick instead of being delayed by a second software ramp.
- Velocity-to-current build slew increased from `10` to `30 A/s` for large errors. Inside 500 deg/s error it blends down toward `12 A/s`; current release/reversal keeps the existing faster brake path.
- Velocity integral accumulation is frozen while the current reference is still slew-limited, except when it is unwinding. This prevents the faster launch from storing avoidable overshoot.
- Browser motion debounce is 45 ms for current/velocity and 60 ms for position. Browser, backend and both hardware test tools now send the same `30 A/s` default.
- `cascade_step_test.py --retarget-check` adds a no-STOP `1000 -> 3000 -> 1000 deg/s` test and reports the minimum absolute speed in the first 250 ms, transition time, current peaks and `nFAULT`.

## Re-analysed accepted baseline

The old scorer included serial-command latency in loop response. Aligning against the first telemetry frame in which the requested setpoint is actually active gives:

- COM18 current `+500 mA`: 90% response `11.1 ms`, overshoot `3.2%`, tail `500.42 mA`, tail error `0.42 mA`, `nFAULT=1`.
- COM18 velocity `+3000 deg/s`: 90% response `370.8 ms`, settle within 10% `500.1 ms`, overshoot `3.31%`, tail `2995.5 deg/s`, `nFAULT=1`.
- The old velocity capture shows the current target rising at the configured `10 A/s` and peaking near `2.18 A`; this was the dominant removable response delay.

Source captures:

- `tools/captures/current-step-COM18-20260826-115407.csv`
- `tools/captures/velocity-step-20260826-101652.csv`

## Build, flash and host verification

- PlatformIO release build: both USB and JTAG environments succeeded.
- RAM: 20,912 / 327,680 bytes; flash: 390,597 / 3,342,336 bytes.
- Flashed only the USB device with eFuse MAC `68:ee:8f:52:a7:9c`, freshly enumerated as COM18.
- Flash write hashes verified by esptool.
- Firmware binary SHA-256: `B307A0C70C42AAE50D637D464F92CE83CC24378ACFD4B0C97E31E6C88AE5DF1D`.
- Post-flash firmware banner and `cascade status` confirmed version `0.4.3-fast-current-velocity`, 20 kHz PWM, current slew `30 A/s`, 2 kHz current loop and 200 Hz velocity loop.
- Focused COM18 browser smoke test passed: one real connected board, five live canvases, 18 sliders and no JavaScript errors.
- Dashboard is running at `http://127.0.0.1:8766/?focus=COM18&v=fast-current-velocity-20260828`.

## Current physical acceptance blocker

The controller is flashed, but the present COM18 motor power path does not conduct:

- Bus voltage `19.44-19.46 V`, `nFAULT=1`, `nSLEEP=1`, `nRESET=1`, encoder valid.
- Direct GPIO diagnostic bypassed LEDC, set current limit to step 3 and held ENBL HIGH for 20 ms.
- CW: `0.00 deg`, peak branch current `22 mA`.
- CCW: `0.00 deg`, peak branch current `27 mA`.

Because both full-drive directions produce neither shaft movement nor winding current, a fresh closed-loop step cannot measure controller performance. Running a longer PI test would only integrate toward full PWM against an open/non-conducting driver-to-motor path. Physical acceptance remains pending until the motor connector/output/shunt path conducts again.

Required fresh acceptance after the path is restored:

1. `dctest cw 20` and `dctest ccw 20` must produce real branch current and encoder movement.
2. Signed `+/-500 mA` current steps: command-aligned rise, overshoot, tail error and `nFAULT`.
3. Signed `+/-3000 deg/s` velocity steps: whole trajectory, settling, overshoot, current/PWM peaks and `nFAULT`.
4. No-STOP `1000 -> 3000 -> 1000 deg/s` retarget: no zero-speed dip and continuous current target.

Final state after diagnostics: STOP sent, PWM zero; COM18 remains connected for telemetry only.
