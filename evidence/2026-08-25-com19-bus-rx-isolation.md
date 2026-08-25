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

## Retest after U6-path hardware repair

The user repaired the board before installing it on the motor. Both bridges
were kept stopped/asleep during the following 1 Mbaud tests.

```text
Ping request/response:   COM18 -> COM19 1000/1000
                         COM19 -> COM18 1000/1000
Long STATUS response:    COM18 -> COM19 100/100
                         COM19 -> COM18 100/100
One-way at 100 Hz:       COM18 tx=1000, COM19 valid=1000, CRC=0
One-way at 200 Hz:       COM18 tx=1000, COM19 valid=910, CRC=2
200 Hz sync exchange:    leader tx=1001, response rx=71, then link stopped
```

The repair restored ordinary bidirectional communication, but the board is not
yet accepted for the intended 200 Hz position/force-feedback exchange.

The current schematic uses a 10 kOhm DATA pull-up (R9) on each board, or 5 kOhm
effective with two boards. An earlier revision of the same bus circuit used a
1 kOhm pull-up. Before motor installation, use one centralized 1-2.2 kOhm DATA
pull-up (or 2.2 kOhm on each of two boards for about 1.1 kOhm effective), then
repeat the 200 Hz one-way and synchronization tests. This keeps low-level sink
current within the SN74LVC1G126 capability while materially improving DATA rise
time at 1 Mbaud.

## Accepted retest after COM19 R9 changed to 1 kOhm

COM18 retained its 10 kOhm R9 and COM19 R9 was changed to 1 kOhm. The two
parallel pull-ups therefore measure approximately 909 Ohm effective. Device
identity was re-locked by eFuse MAC before testing. Both motor connectors were
uninstalled and both bridges were returned to sleep after every test.

```text
COM18 -> COM19 one-way: 1000/1000 at 200.00 Hz over 5.000 s
COM19 -> COM18 one-way: 1000/1000 at 200.00 Hz over 5.000 s
Both directions:        crc_err=0, resync=0, uart_err=0

200 Hz sync, 5 seconds: requests=984, responses=984
Effective sync rate:    196.80 Hz
Latest response age:    757 us
Sync bus errors:        crc_err=0, resync=0, uart_err=0

Ping request/response:  COM18 -> COM19 1000/1000
                        COM19 -> COM18 1000/1000
                        average 3.486 ms, worst 4.083 ms, timeouts 0
STATUS response:        COM18 -> COM19 100/100
                        COM19 -> COM18 100/100
                        average 5.971 ms, worst 6.572 ms, timeouts 0
```

The R9 change removes the previous direction-specific 200 Hz loss and the DATA
link is accepted for motor installation and loaded position/force-feedback
testing. The single sync `timeout=1` observed in the no-motor test was an
intentional fail-safe event because COM19 was held asleep; frame exchange
continued for the full five seconds.

Final safe state on both boards: `awake=0`, `pwm=0/4095`, `nFAULT=1`.
