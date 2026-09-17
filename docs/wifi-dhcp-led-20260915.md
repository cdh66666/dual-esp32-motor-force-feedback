# Hotspot DHCP and communication LED — 2026-09-15

Both application USB ports responded before deployment. Their SSIDs were distinct. Old WIFI ready=1 indicated HTTP initialization, not phone association or IP assignment. The reported phone failure remains unclassified; affected SSID unknown. Desktop WLAN remained on SCF-Corp.

## Changes

- Explicit AP/gateway 192.168.4.1, subnet /24, DHCP lease start 192.168.4.2.
- Verify DHCP started; every 2 seconds restart only a stopped DHCP server. Do not reset healthy leases or disconnect clients.
- UID-derived channels: COM4 channel 11, COM23 channel 1. Open authentication retained; four-client maximum.
- WIFI status adds IP/channel/client count, association/disconnection/IP-assignment counters, DHCP state/repair count and startup errors.
- Default LED follows open USB or valid addressed DATA/HTTP activity, with a 3-second grace period. Manual LED overrides remain.
- Motor gains and protection thresholds unchanged. No motor motion tests.

## Verification

PlatformIO build passed. LinkIndicator native tests passed, including rollover and timeout. Wi-Fi source contracts and mocked USB-chain tests passed; these are not radio acceptance.

Firmware SHA256: 6557ACCFE2626B43AFE89BADE9B17A3C9A5FFCB1099E4B58650CAEE1CA19786D

Both project flash runs confirmed stopped/asleep, PWM zero, approximately 19.5 V and nFAULT=1 before writing. Both writes and segment hash verifications passed. Logs:

- evidence/wifi-dhcp-led-com23-20260915.log
- evidence/wifi-dhcp-led-com4-20260915.log

Automatic RTS resets did not restore application USB; ROM COM18/COM19 remain. User must tap RST on both boards. Runtime DHCP and physical LED validation are pending.

After reset, release application-port maintenance, reconnect, verify STOP/sleep and WIFI status. During a phone retry, compare joins/leaves and leases to distinguish association failure, DHCP failure and later portal failure. No claim yet that phone IP acquisition is fixed.

ID management and remaining single-USB/mobile feature parity are separate unfinished work.

## After user RST confirmation

Both application identities returned as COM4/COM23. Maintenance was released and connections restored. Fresh STOP and sleep acknowledgements received on both, bus 19.43 V, PWM=0, awake=0, nFAULT=1. New WIFI diagnostics prove both updated applications are running: ready=1, IP=192.168.4.1, DHCP=started, startup_error=0; channels 11 and 1 respectively. Both report clients=0, joins=0, leaves=0, leases=0, repairs=0. No phone association has yet been recorded since this boot. Phone retry is needed for IP-acquisition acceptance; DHCP started alone is not proof of a successful lease.
