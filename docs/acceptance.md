# Acceptance criteria

Each tagged iteration records the commands, firmware hash and CSV evidence used for acceptance.

1. Safety: reset starts asleep with PWM=0; STOP works from every mode; bus loss stops both force-feedback nodes.
2. Identity: both physical boards report the same firmware build hash; USB identity is re-enumerated before flashing.
3. Telemetry: raw USB samples are 100 Hz without invented interpolation; charts render independently from serial logging.
4. Current loop: both signs track the requested branch current without sustained saturation or nFAULT.
5. Velocity loop: both signs track commanded speed and return cleanly to zero.
6. Position loop: multi-turn target remains actively held after settling.
7. DATA bus: 1 Mbaud, 8N1, CRC16; bidirectional ping/status and 200 Hz synchronized state exchange have measured timeout/error counts.
8. Force feedback: both motors oppose relative displacement with bounded current, stable damping and link-loss shutdown.

## Current acceptance status (2026-09-05)

Latest update (22:32): **0.5.5-control-timing is built, NOT flashed or physically accepted.** It fixes missed-deadline catch-up, time-based current filtering and sample timestamps, and adds a 4 ms low-speed velocity estimator. The dashboard has a 25 mm lever/ideal-force estimate and a 500 mA explicit-start knob default; human feel is not measured. All 10 offline groups pass, including 31 backend tests. The project backend was autonomously restarted (PID 103152) and the short-write, one-way recovery and latched ACK-fault handling are deployed. Firmware 0.5.4 remains on the board: a standalone serial client passed 600.003 s / 60,002 frames / 11,627 queries, but the real backend failed at 429.496 s / 42,797 frames / 8,480 queries despite serialized 2 ms reads. Ordinary reopen/backend restart did not restore RX. This is an unresolved USB data-path fault, not accepted continuous operation. See [the current evidence and physical recovery boundary](2026-09-05-control-timing-and-haptic-lever.md). Historical failures below remain valid.

**Overall acceptance remains failed:** 0.5.1 completed small-current, continuous speed retarget and six 14-second position tests, but the first knob mode lost USB after about 9.3 s even with only 13 mA peak feedback. Speed ripple and a post-current-test reverse-current transient also remain open. Version 0.5.2 has since been flashed with motor power OFF. The updated backend was deployed at 18:24 and its invalid-handle cleanup was verified on a real failure. However, a subsequent USB-only soak failed after 27.254 s / 2,560 frames / 509 query replies; retained diagnostics identify the firmware's 1501 ms USB TX-stall software-restart path. Reopening the link succeeded without motion. The original USB stall cause remains unresolved. See [the current stability report](2026-09-05-powered-stability.md). The idle tests below are historical evidence and do not override the newer failures.

Source `0.5.1-link-stability` has been built, flashed and version-checked on the same COM23 identity. It retains the output-shaft/haptic implementation and stored motor calibration. The user turned motor power OFF for recovery; this turn issued no motion. A 120.242-second live USB test collected 12,004 telemetry frames at 100 Hz plus 2,383 read-only queries, with no errors, session replacement or timestamp reset. Maximum telemetry gap was 12 ms; command acknowledgement median/max were 5.67/34.11 ms. Ten offline test groups and the real read-only browser check passed. These are idle-link and software checks, not powered motor or haptic-feel acceptance. See [the stability report](2026-09-05-link-stability.md).

Two different failures must remain distinct: archived 1.300/1.384 A tests triggered the encoder freshness guard while USB continued; a later 12:25 knob session really stopped returning data despite an enumerated port. Version 0.5.1 separates 1 kHz encoder reads from 500 Hz velocity updates, adds timing/I2C counters, bounds USB output queuing, and avoids disconnecting a healthy port during control-fault recovery. The ultimate cause of the later USB data-path stall is not proven. Powered current/velocity/knob tests and intentionally injected USB-stall recovery still require acceptance; protection has not been disabled.

Only one current board/36GP-555 assembly is connected. Current tracking, position-process/10-second-hold tests and continuous speed retargets have fresh evidence in [the commissioning report](2026-09-05-COM23-commissioning.md). This is a usable commissioning build, not completion of every target: extreme low-speed ripple, independent output-angle metrology, thermal continuous operation, loaded dual-board DATA communication and force feedback remain open. No torque transducer or output-side encoder was used.

## Historical status (2026-08-26, different motors/firmware)

- Items 1–6: accepted on both motor-mounted boards over their independent USB ports.
- Item 7: 1 Mbaud unloaded communication was previously accepted after the COM19 R9 repair; loaded synchronized exchange is deferred by user request.
- Item 8: not accepted yet. Do not present force feedback as production-ready until the loaded DATA-link test is repeated.
