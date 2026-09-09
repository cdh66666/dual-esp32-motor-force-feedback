"""Bounded, identity-checked USB recovery with the motor supply OFF.

The dashboard backend must be paused, so no browser can acquire the handle.
No motor start, WAKE or calibration writes. This tool does not erase flash.
"""
import argparse
import json
import time
import serial
from serial.tools import list_ports


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', required=True)
    p.add_argument('--serial', required=True)
    p.add_argument('--power-off-confirmed', action='store_true')
    p.add_argument('--bootloader', action='store_true')
    args = p.parse_args()
    if not args.power_off_confirmed:
        p.error('Confirm physical motor power is OFF before recovery')
    normalize = lambda value: (value or '').replace(':', '').replace('-', '').upper()
    def selected():
        return [x for x in list_ports.comports() if x.vid == 0x303A and
                normalize(x.serial_number) == normalize(args.serial)]
    found = selected()
    if len(found) != 1 or found[0].device.upper() != args.port.upper():
        raise RuntimeError('USB identity/port mismatch; no control request sent')
    print('SELECTED', found[0].device, found[0].serial_number, flush=True)
    if ':' in found[0].serial_number:
        print('ROM already ready', found[0].device, flush=True)
        return
    transport = serial.Serial()
    transport.port = args.port
    transport.baudrate = 115200
    transport.timeout = .1
    transport.write_timeout = .5
    transport.dtr = True
    transport.rts = False
    received = bytearray()
    try:
        transport.open()
        for command in ['stop', 'sleep', 'model', 'status']:
            transport.write((command + '\r\n').encode())
            deadline = time.monotonic() + .7
            while time.monotonic() < deadline:
                received.extend(transport.read(max(1, min(4096, transport.in_waiting))))
        print(json.dumps({'bytes_received':len(received), 'tail':received[-1500:].decode('utf-8','replace')},
                         ensure_ascii=False), flush=True)
        if args.bootloader:
            try: transport.baudrate = 1200
            except serial.SerialException as exc:
                print('1200 touch detach (not proof of ROM):', exc, flush=True)
    finally:
        transport.close()
    if args.bootloader:
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            found = selected()
            if len(found) == 1 and ':' in found[0].serial_number:
                print('VERIFIED_ROM', found[0].device, found[0].serial_number, flush=True)
                return
            time.sleep(.2)
        raise RuntimeError('No matching ROM enumerated; no flash attempted')


if __name__ == '__main__': main()
