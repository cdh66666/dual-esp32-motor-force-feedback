# USB recovery investigation — 2026-09-15

No motor-motion commands, firmware writes, application resets or supply changes were performed in this investigation.

## Live evidence

- COM19: hardware USB serial `68:EE:8F:53:81:E4`, same normalized identity as former COM4. ESP32-S3 revision v0.2, MAC `68:ee:8f:53:81:e4` confirmed with esptool 5.2.0. COM23 remained active with fresh telemetry.
- Backend was incorrectly opening COM19 and issuing `model` to a download-mode device. `/api/maintenance` disconnected and held this port before esptool access.
- `read-flash 0x10000 0x100000` succeeded: 1,048,576 bytes in 91.9 seconds, saved locally as `evidence/com19-app-read-a.bin`. Image checksum and embedded validation hash both valid. Validation hash: `b3049db159e29e143b52c6cbcb479b5df0b9774c4e0c698e57a282e77a1b8f1c`. This covers the image at that offset, not a complete flash/OTA/NVS audit.
- Subsequent 64 KiB reads stopped after the first 4096-byte progress report twice (`The chip stopped responding`, teardown StopIteration). A no-stub `read-mac` succeeded between failures. A later no-stub read attempt could not synchronize (`Serial data stream stopped`). Backend maintenance was true, port inactive, reader stopped during failure inspection; Windows still showed COM19 status OK.
- The fixed-position repeated failure may be loader/transport state related; it is NOT proof of a solder defect. Initial successful ROM reads also do NOT rule out an intermittent physical fault.
- The Arduino library compile date printed by image-info is not reliable evidence of this project's firmware build date.

## Implemented correction

- Desktop discovery excludes this project's hardware USB recovery/debug transport from automatic motor connection and labels it explicitly. Compatibility fallback recognizes its colon-form MAC even with the currently running older backend.
- Backend source rejects attempts to open that transport for normal motor control. The classification describes transport, not proof that every such device is in ROM: hardware-CDC diagnostic firmware also uses it. Production firmware here is TinyUSB.
- Two classification/open-guard tests and two existing phone-handoff tests passed. JavaScript syntax check passed. HTTP GET confirmed new dashboard source is served. Existing tool-center entry and API verified.
- Backend changes are not active: the earlier project restart was rejected by tool policy, and no alternate restart method was attempted. Frontend requires refresh; embedded mobile assets have not been rebuilt/flashed for this change.

## Next prerequisite

Preserve known-good COM23. Obtain a fresh physical ROM entry for the suspect board (BOOT held while tapping RST). For recovery flashing without a responding application to verify driver state, first disconnect motor supply while keeping USB attached. Repeat short read-only checks in the fresh ROM session before attempting a known-good firmware baseline. Do not infer motor power-off from USB enumeration or restore old motion targets.

Hardware fault localization still needs measurements or board photographs: connector/USB traces, 3.3 V supply and reset stability are candidates, not established defective components. Single-USB chain and phone control are not accepted as complete until both devices respond and end-to-end tests pass.

## Fresh ROM follow-up: tool-version A/B comparison

After the user physically re-entered download mode, the same MAC was confirmed on COM19. Backend maintenance was enabled before each diagnostic sequence. The global esptool 5.2.0 again failed at the first 4096-byte progress report of a 64 KiB read.

Without replugging, re-soldering, resetting into the application or changing motor parameters, the installed PlatformIO esptool 4.5.1 successfully read the same 64 KiB range four times. All four SHA256 values equal `4FCFB7D19CADB97FEED52098CFE0B5A5EDECE51C1F91E824BCB92DE2ED6C83AA`. Files: `evidence/com19-fresh-rom-v4-a.bin`, and `evidence/com19-fresh-rom-v4-repeat-{1,2,3}.bin`.

Reproduction command (read-only flash operation; leaves the chip in download mode):

```powershell
& 'C:/Users/admin/scoop/apps/python313/current/python.exe' 'C:/Users/admin/.platformio/packages/tool-esptoolpy/esptool.py' --port COM19 --before no_reset --after no_reset read_flash 0x10000 0x10000 <new-local-evidence-file>
```

Upstream corroboration: https://github.com/espressif/esptool/issues/1155 reports Windows 11 / ESP32-S3 / esptool 5.2.0 reads stopping at 4096 or 8192 bytes. The local A/B test establishes a tool-version dependency for this read failure; it does not establish that the application-mode USB descriptor failure has the same cause. Do not recommend re-soldering based on this read failure alone. Use the project-bundled tool for subsequent diagnostic reads, not the global 5.2.0 module.

User explicitly confirmed the suspect board still has motor supply connected. COM23 status independently measured 19.55 V, awake=0, PWM=0, nFAULT=1, idle; that is not proof of COM19's driver state. No flash write or application restart was attempted. ROM recovery flashing remains pending motor-supply disconnection because this board cannot provide its application-level powered-flash preflight. No further BOOT/RST action is requested at this point.
