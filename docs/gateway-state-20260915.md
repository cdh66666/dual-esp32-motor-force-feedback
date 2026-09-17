# Transport state follow-up — 2026-09-15

User reported phone testing was satisfactory following the DHCP/LED firmware. Record this as user-reported phone acceptance, not an instrumented performance measurement.

## Implemented

- Desktop DATA rediscovery preserves the existing device object within the same USB session, so an in-flight status reply updates the displayed state instead of an orphaned object.
- Successful metadata alone no longer clears a status failure. New USB sessions still discard old telemetry.
- Phone reconnect now validates the complete numeric status frame and marks malformed responses failed.
- Phone identity metadata validates UID syntax and current limit; failed discovery marks known devices failed.
- Queued phone motion requests check per-device revision, current identity object, telemetry freshness and STOP epoch before transmission. A superseded queued target is not sent. Commands already transmitted cannot be recalled.
- Shared tool-center description updated with its registration skill; existing entry retained.

## Verification

- Gateway health and USB-chain mock regression tests passed, including malformed reconnect, object identity, preserved failure, and three concurrent targets resulting in only the latest target transmission.
- Fresh real DATA read-only verification passed in both directions, with both USB cables attached: evidence/chain-readonly-1789462154.json. No motion commands.
- Desktop served transport exactly matches updated disk source; no backend restart needed.
- Embedded phone build passed. Firmware SHA256 DFB43CB5AC5C8F4A3D85F32CC69195115D4D6C46E1F30E8778950FF553BD483A.
- Both boards written using the existing project flasher, with image hashes verified. Logs: evidence/gateway-state-com4-20260915.log and evidence/gateway-state-com23-20260915.log.
- Automatic RTS reset did not return COM4 to application mode; both application restarts require verification after RST. These new phone changes are not yet runtime-accepted.

Motor gains, device IDs, motion limits and DHCP settings unchanged. Configurable IDs and remaining remote advanced functions are still unfinished, not represented as complete.

## Post-reset verification

User tapped RST on both boards. COM4 and COM23 application USB identities returned; maintenance released and connections restored. Fresh STOP/sleep acknowledgements passed on both. PWM=0, awake=0, nFAULT=1, voltage 19.41/19.53 V. Both WIFI services report ready=1, DHCP started, startup_error=0, zero clients/leases since boot. Bidirectional DATA UID/metadata/status checks passed again: evidence/chain-readonly-1789462309.json. No motion sent. Updated phone request handling still has mock regression coverage only; phone interaction has not been retested since this latest update.

After the user confirmed both physical LEDs were lit, the desktop `led auto` whitelist omission was fixed and the backend restarted. COM4 and COM23 each acknowledged `OK led=auto`; a fresh COM23 status read also passed with awake=0 and PWM=0. Both boards remained connected and idle. This confirms command receipt and the observed LED state; it does not claim a timed unplug/reconnect LED decay test.
