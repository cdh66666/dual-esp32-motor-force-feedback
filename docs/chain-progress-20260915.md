# Chain implementation progress — 2026-09-15

## Implemented this pass

- `tools/reflash_board.py` now selects `tool-esptoolpy/esptool.py` from the PlatformIO core directory (including `PLATFORMIO_CORE_DIR`). No fallback to global esptool. The reset subcommand uses the project's v4-compatible `hard_reset` spelling. Existing power/identity preflights remain unchanged.
- Bus command receiver now caches accepted/rejected replies by source, sequence and exact command for 300 ms, covering the existing two retries at 80 ms. Duplicate commands replay the original reply without re-running motion handling or extending its duration. Storage is bounded to eight entries. Replies do not claim physical target completion.
- STOP, sleep, disarm, live queries and broadcasts bypass the cache. Prior motion cache entries survive STOP so a late retry does not restart that cached motion. This is bounded-window duplicate suppression, not an end-to-end exactly-once guarantee or protection against arbitrarily delayed packets.

## Verified, without motor movement

- Tool selector tests: 2 pass. Existing reflash preflight tests: 4 pass.
- Chain decoder tests: 7 pass. Phone handoff tests: 2 pass.
- Mock gateway drop/reconnect, refusal/no-target, paired STOP checks pass.
- Wi-Fi source contract and page syntax checks pass.
- C++ cache tests compiled and executed with MSVC: duplicate hits; differing source, sequence and command misses; expiry; uint32 timer wrap; bounded eviction.
- PlatformIO `esp32-s3-devkitc-1` build succeeds using esptool 4.5.1. RAM 139180 bytes, flash 977033 bytes. This build is not proof of board deployment.

## Remaining deployment/acceptance

No board was flashed or restarted into its application during this pass. COM19 remains the suspect board's download interface. User last explicitly confirmed motor supply is attached; application-based powered-flash preflight is unavailable there. Existing backend restart policy denial remains unresolved; no alternate restart was attempted.

Single-USB bidirectional chain operation and real phone hotspot control still require both production applications online and fresh end-to-end acceptance. Offline tests are not that acceptance. Do not repeat esptool version comparison work; use the validated project package.

## Deployment follow-up

Both boards were subsequently written with candidate SHA256 `C6F5C82D84A475AA758ABC8424FB7BBF7BA50352ED183C9F1C5AB76893C6DC02` using project esptool 4.5.1. Each upload verified all written segment hashes.

- COM23 / MAC 68:ee:8f:52:a7:9c: initial powered-profile preflight found actual VM=0.00 V and exited before reset/write. Default power-off flow then verified STOP/syncoff/sleep and uploaded through ROM COM18. Log: `evidence/chain-dedup-com23-off-deploy-20260915.log`.
- Former COM4 / MAC 68:ee:8f:53:81:e4: user explicitly confirmed BOTH motor supplies disconnected. Existing ROM identity COM19 was held in maintenance and uploaded successfully. Log: `evidence/chain-dedup-com19-off-deploy-20260915.log`.
- Application enumeration is not yet successful. Both still enumerate hardware USB serial with colon-form MAC (COM18 and COM19), not production TinyUSB application ports. COM23's automated reset/run and subsequent no-stub run did not restore its application interface. No motor-motion commands were sent.
- Next physical step: with BOOT released and motor supplies kept off, tap RST once on each board. Do not reflash merely because the ROM port remains visible. Once applications enumerate, reconnect without restoring targets; check status, identity, Wi-Fi and DATA communication before any powered motion acceptance.

## Post-RST live checks

Both production interfaces restored (COM4 UID E481538FEE68 and COM23 UID 9CA7528FEE68), with fresh telemetry. STOP/sleep and LED-on commands acknowledged on both. Both status reports: VM=0 V, awake=0, PWM=0, idle, nFAULT=1. No motion targets sent.

Both firmware Wi-Fi status responses report ready=1, password=none, URL http://192.168.4.1/, with SSIDs Motor-E481538FEE68 and Motor-9CA7528FEE68 respectively. This confirms firmware AP state, not phone HTTP acceptance.

`tools/check_chain_gateway.py` passed both DATA directions with UID/metadata and idle status; evidence `evidence/chain-readonly-1789458407.json`.

Additional live check closed the peer USB serial session using maintenance, queried the remote board via the remaining entry, sent chain broadcast STOP, then queried again; both directions returned remote PWM=0/awake=0. Broadcast STOP explicitly returned acknowledged=false; the already-idle status must not be described as proof that a running motor stopped. The peer session was restored in finally. Both physical USB cables remained connected: this proves DATA queries do not rely on the peer's open USB session, not single-cable electrical powering or motion acceptance.

The old backend later disappeared (no listener/process), allowing a normal start without terminating any process. A hidden background start briefly worked then also disappeared without Python traceback; cause not established. A tool-managed running session (92504) then served the updated backend. `/api/capabilities` reports phone_handoff=true. Live release/reclaim succeeded on both ports: release yielded active=false/phone_control=true/maintenance=true; reclaim acknowledged stopped state. Both DATA directions passed again, evidence `evidence/chain-readonly-1789458603.json`. A direct request from the PC to 192.168.4.1 timed out; actual hotspot browser/radio acceptance remains unverified. No Wi-Fi configuration changes or motor motion were performed.

## Physical single-cable acceptance: COM23 entry

User confirmed unplugging a cable. OS enumeration now has COM1 (unrelated) and only COM23 (USB serial 68EE8F52A79C), no COM4. `tools/accept_single_usb.py` verified this topology throughout 40 samples, all successful remote protocol-2 identity/status responses from DATA 184 / UID E481538FEE68. Evidence: `evidence/single-usb-68EE8F52A79C-1789459473.json`, SHA256 `73cba537b46cef798b0959b41a95795de33525627e0b7f2e86b7084f0d64fc65`. Query latency min/mean/max: 9.05/22.0825/41.62 ms (HTTP + USB + DATA round trip, not control-loop latency). Remote bus measured 19.44–19.46 V in first/last frames; PWM=0, awake=0, idle throughout.

An initial generic send with wait_ack=true was rejected by backend validation before transmission because that API does not configure execution-ACK matching for `bus 184 sleep`. Explicit transmit then log matching confirmed actual remote sleep reply: `BUS_RX from=184 type=2 seq=81 payload=ACK,81,awake=0 pwm=0` (log seq 90630). No wake or motion targets sent; port enumeration still showed only COM23 afterward.

Result: physical single USB via COM23 supports peer discovery, sustained status reads and an acknowledged remote sleep command. Reverse physical entry (COM4 only), continuous slider motion and force-feedback acceptance are still pending; do not report full arbitrary-entry motion acceptance from this check.
