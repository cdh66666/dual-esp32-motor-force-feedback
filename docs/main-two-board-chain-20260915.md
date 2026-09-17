# Main dashboard: two-board single-USB topology

## Implemented and served

- `web/usb-chain-transport.js` adds the missing board to the main dashboard automatically, using the current USB session plus DATA protocol-2 metadata and exact expected UID. Topology is intentionally the user's two boards: UID E481538FEE68/address184 and UID 9CA7528FEE68/address1. This is not arbitrary-length automatic enrollment.
- Physical USB takes precedence over DATA. The same board is not counted twice when both USBs are present. Existing USB identity retirement clears samples/timers/targets when changing routes. Stale remote DATA ports cannot fall through to OS serial opens.
- The main scope and control selector display both boards, including the DATA peer. Remote telemetry is polled at a nominal 150 ms minimum interval, with actual interval depending on round-trip time. It is not advertised as the direct USB 100 Hz stream.
- Main position/velocity/current/PWM controls route through `/api/chain/control`; identity is checked before execution. Units are output revolutions, output revolutions/s, amperes and PWM counts respectively. Remote command duration remains 1 second per explicit update, without automatic renewal. UI states this limit.
- Remote STOP/sleep return actual matched DATA ACK, not a fabricated serial reply. Generic unsupported configuration commands fail rather than being silently applied only to the local board. Single-USB force-feedback/configuration/calibration advanced controls are marked unavailable, pending implementation. Two-direct-USB paths remain.
- Signed remote PWM is unavailable in the existing compact status protocol; shown as unavailable instead of fabricating direction from current or velocity.
- Only desktop backend/static files changed; no firmware flash in this turn. Phone embedded UI was not redeployed.

## Verification

- OS has only known board COM4 connected. `tools/accept_single_usb.py` passed 40 identity/status samples to UID 9CA7528FEE68 at DATA1. Evidence `evidence/single-usb-68EE8F5381E4-1789460190.json`, SHA256 `42e2fa5d2ca50dad14c70025d07b238ad44ac59e6b5d62523c3ab1ccc5ecaaa7`. Earlier opposite physical direction is separately recorded.
- Actual browser main page shows 2 / 2 online, COM4 plus DATA-1, two scope lanes and both/individual control choices. Screenshot `evidence/main-single-usb-two-boards.png` (real telemetry, no mock readings).
- A separate phase of the isolated test browser intercepted all action POSTs. Moving actual UI sliders produced chain/control requests for address1/UID9CA7528FEE68 via COM4: position0.2r, velocity0.3r/s, current0.1A, PWM81.9counts for2%. These requests were mocked, not sent to motors. Switching modes generated remote STOP routes. Browser was closed and reopened after mocking.
- Live backend sleep response: `ACK,28,awake=0 pwm=0` from address1. No motor-motion target was sent by the agent.
- `tests/usb_chain_transport_test.mjs`: both entry directions, dual-USB dedup, unit conversions, matched stop ACK mapping, stale telemetry, session changes and route loss pass with mocked I/O. Existing seven chain decoder tests and two phone handoff tests pass. JS/Python syntax checks pass.
- Backend listener's exact PID/command was verified, STOP/broadcastSTOP/sleep sent, then that project's process restarted to load new API/static route. Connections restored without targets. Tool-center entry for port8766 verified; URL unchanged.

## Not yet accepted

Actual motor motion through the main single-USB sliders, sustained single-USB force feedback, full remote configuration and phone radio/browser end-to-end behavior. Do not call those passed from the display/routing checks above.
