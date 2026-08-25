#!/usr/bin/env python3
"""Run the firmware's bounded electrical/mechanical identification sequence."""

from __future__ import annotations

import argparse
import re
import time

import serial


DONE = re.compile(
    r"IDENTIFY done electrical=(\d) mechanical=(\d) samples=(\d+)/(\d+) "
    r"R=([0-9.]+) Ke=([0-9.]+) accel_per_A=([0-9.]+) friction=([0-9.]+)"
)


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))
    port.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, help="Freshly enumerated USB CDC port")
    parser.add_argument("--timeout", type=float, default=6.0)
    args = parser.parse_args()

    match = None
    lines: list[str] = []
    with serial.Serial(args.port, 115200, timeout=0.05, write_timeout=1.0) as port:
        time.sleep(0.8)
        port.reset_input_buffer()
        for command in ("stop", "wake", "identify reset", "identify start"):
            send(port, command)
            time.sleep(0.08)
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            line = port.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            lines.append(line)
            print(line)
            match = DONE.search(line)
            if match:
                break
            if "IDENTIFY aborted" in line or line.startswith("ERR "):
                break
        send(port, "stop")
        time.sleep(0.1)
        send(port, "model")
        model_deadline = time.monotonic() + 0.6
        while time.monotonic() < model_deadline:
            line = port.readline().decode("utf-8", errors="replace").strip()
            if line:
                print(line)

    if not match:
        print("RESULT=FAIL no completed identification frame")
        return 2
    electrical, mechanical, electrical_n, mechanical_n = map(int, match.groups()[:4])
    resistance, ke, acceleration, friction = map(float, match.groups()[4:])
    valid = (
        electrical == 1
        and mechanical == 1
        and electrical_n >= 20
        and mechanical_n >= 50
        and 0.05 <= resistance <= 5.0
        and 0.0001 <= ke <= 0.1
        and 200.0 <= acceleration <= 200000.0
        and 0.0 <= friction <= 20.0
    )
    print(
        "RESULT={} R={:.5f}Ohm Ke={:.6f}V_per_rad_s "
        "accel_per_A={:.2f} friction={:.4f}".format(
            "PASS" if valid else "FAIL", resistance, ke, acceleration, friction
        )
    )
    return 0 if valid else 3


if __name__ == "__main__":
    raise SystemExit(main())
