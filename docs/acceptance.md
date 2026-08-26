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

## Current acceptance status (2026-08-26)

- Items 1–6: accepted on both motor-mounted boards over their independent USB ports.
- Item 7: 1 Mbaud unloaded communication was previously accepted after the COM19 R9 repair; loaded synchronized exchange is deferred by user request.
- Item 8: not accepted yet. Do not present force feedback as production-ready until the loaded DATA-link test is repeated.
