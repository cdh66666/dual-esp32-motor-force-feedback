# COM19 DATA bus RX isolation — 2026-08-25

## Known-good reference

- Prior public implementation: <https://github.com/cdh66666/Bus_Servo_Driver>
- Transport pattern restored here: persistent UART1, `write(buffer, len)`, `flush()`, continuous RX state machine.
- No UART `end()/begin()`, no manual BUS_TX pulse, no fixed turnaround delay.

## Identity lock

- COM18: `68:ee:8f:52:a7:9c`, configured DATA address 1.
- COM19: `68:ee:8f:53:81:e4`, configured DATA address 184.
- DATA format: 1,000,000 baud, 8-N-1, CRC16.

## One-way isolation test

Both motors were stopped. The sender emitted 100 broadcast STOP frames, so the
receiver never transmitted a response. A temporary ESP32 PCNT channel counted
rising edges arriving physically at GPIO42 in parallel with UART1.

### COM18 -> COM19

```text
COM18 tx=100
COM19 rx_edges=714 rx_bytes=279 valid=19 addressed=19 cmd_rx=19
COM19 crc_err=0 resync=0 uart_err=0
```

### COM19 -> COM18

```text
COM18 rx_edges=3647 rx_bytes=1400 valid=100 addressed=100 cmd_rx=100
COM18 crc_err=0 resync=0 uart_err=0
```

## Conclusion

COM18 continued to put all 100 frames on DATA, but after frame 19 the remaining
DATA edges did not reach COM19 GPIO42. UART wrapper changes, native IDF UART,
FIFO sizing, parser resynchronization, baud-rate comparison, and RX-state
clearing did not change the direction-specific failure. The fault boundary is
therefore on COM19's receive path before the ESP32 input:

`DATA -> U6 pin 2 -> U6 pin 4 -> BUS_RX trace -> ESP32 GPIO42`

Check U6 3.3 V supply/decoupling, U6 pin 1 OE (BUS_TX must remain high while
receiving), U6 solder joints, and continuity from U6 pin 4 to GPIO42. Replacing
or reflowing U6 is the highest-value repair. The temporary PCNT instrumentation
was removed from the production firmware after collecting this evidence.
