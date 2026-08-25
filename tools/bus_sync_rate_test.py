#!/usr/bin/env python3
"""Validate the 200 Hz request/response synchronisation link without motors."""

from __future__ import annotations

import argparse
import re
import time

import serial


BUS = re.compile(r"BUS addr=(\d+).+baud=(\d+).+crc_err=(\d+).+resync=(\d+).+uart_err=(\d+)")
SYNC = re.compile(
    r"SYNC mode=position peer=(\d+) armed=(\d+) leader=(\d+) period=(\d+)us "
    r"age=(\d+)us tx=(\d+)\((\d+)/(\d+)\) rx=(\d+)\((\d+)/(\d+)\) timeout=(\d+)"
)


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))


def drain(ports: dict[str, serial.Serial], duration: float) -> dict[str, list[str]]:
    deadline = time.monotonic() + duration
    buffers = {name: b"" for name in ports}
    lines = {name: [] for name in ports}
    while time.monotonic() < deadline:
        had_data = False
        for name, port in ports.items():
            waiting = port.in_waiting
            if not waiting:
                continue
            had_data = True
            buffers[name] += port.read(waiting)
            parts = buffers[name].split(b"\n")
            buffers[name] = parts.pop()
            lines[name].extend(
                part.rstrip(b"\r").decode("utf-8", errors="replace")
                for part in parts
                if part
            )
        if not had_data:
            time.sleep(0.001)
    return lines


def latest(lines: list[str], prefix: str) -> str:
    candidates = [line for line in lines if line.startswith(prefix)]
    if not candidates:
        raise RuntimeError(f"missing {prefix!r}; tail={lines[-20:]}")
    return candidates[-1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-a", required=True)
    parser.add_argument("--port-b", required=True)
    parser.add_argument("--baud", type=int, default=1_000_000)
    parser.add_argument("--duration", type=float, default=5.0)
    args = parser.parse_args()
    if args.port_a == args.port_b or args.duration <= 0:
        parser.error("ports must differ and duration must be positive")

    ports = {
        "A": serial.Serial(args.port_a, 115200, timeout=0, write_timeout=1),
        "B": serial.Serial(args.port_b, 115200, timeout=0, write_timeout=1),
    }
    try:
        time.sleep(1.0)
        for port in ports.values():
            port.reset_input_buffer()
            for command in ("sync stop", "stop", "sleep", "stream off", f"busbaud {args.baud}", "businfo"):
                send(port, command)
                time.sleep(0.03)
        startup = drain(ports, 0.5)
        addresses: dict[str, int] = {}
        initial_errors: dict[str, tuple[int, int, int]] = {}
        for name, lines in startup.items():
            line = latest(lines, "BUS addr=")
            match = BUS.search(line)
            if not match or int(match.group(2)) != args.baud:
                raise RuntimeError(f"{name} bus mismatch: {line}")
            addresses[name] = int(match.group(1))
            initial_errors[name] = tuple(map(int, match.groups()[2:5]))
            print(f"{name}_START={line}")
        if addresses["A"] == addresses["B"]:
            raise RuntimeError(f"duplicate bus addresses: {addresses}")

        leader = min(addresses, key=addresses.get)
        follower = "B" if leader == "A" else "A"
        # The follower is deliberately left asleep, so an uninstalled motor can
        # never be driven. It still parses requests and returns state frames.
        send(ports[follower], f"sync position {addresses[leader]} 0 12 1000")
        time.sleep(0.05)
        send(ports[leader], "wake")
        time.sleep(0.05)
        send(ports[leader], f"sync position {addresses[follower]} 0 12 1000")
        activity = drain(ports, args.duration)
        for name, lines in activity.items():
            events = [line for line in lines if line.startswith(("SYNC_", "OK sync", "OK wake"))]
            if events:
                print(f"{name}_EVENTS=" + " | ".join(events[-10:]))

        for port in ports.values():
            send(port, "sync status")
            send(port, "businfo")
        status_lines = drain(ports, 0.5)

        parsed = {}
        errors_clean = True
        for name, lines in status_lines.items():
            sync_line = latest(lines, "SYNC mode=position")
            bus_line = latest(lines, "BUS addr=")
            print(f"{name}_SYNC={sync_line}")
            print(f"{name}_BUSINFO={bus_line}")
            sync_match = SYNC.search(sync_line)
            bus_match = BUS.search(bus_line)
            if not sync_match or not bus_match:
                raise RuntimeError(f"cannot parse {name} status")
            parsed[name] = tuple(map(int, sync_match.groups()))
            errors = tuple(map(int, bus_match.groups()[2:5]))
            errors_clean &= errors == initial_errors[name]

        leader_values = parsed[leader]
        follower_values = parsed[follower]
        expected = args.duration * 200.0
        leader_tx = leader_values[5]
        leader_request_tx = leader_values[6]
        leader_rx = leader_values[8]
        leader_response_rx = leader_values[10]
        follower_tx = follower_values[5]
        follower_response_tx = follower_values[7]
        follower_rx = follower_values[8]
        follower_request_rx = follower_values[9]
        leader_age_us = leader_values[4]
        delivered = min(leader_response_rx, follower_request_rx)
        passed = (
            expected * 0.95 <= leader_request_tx <= expected * 1.05 + 5
            and leader_tx == leader_request_tx
            and leader_rx == leader_response_rx
            and follower_tx == follower_response_tx
            and follower_rx == follower_request_rx
            and abs(leader_request_tx - follower_request_rx) <= 2
            and abs(follower_response_tx - leader_response_rx) <= 2
            and leader_age_us < 30_000
            and errors_clean
        )
        print(
            f"LINK leader={leader} follower={follower} expected={expected:.0f} "
            f"requests={leader_request_tx} delivered={delivered} "
            f"effective_rate={delivered / args.duration:.2f}Hz age={leader_age_us}us "
            f"errors_clean={int(errors_clean)}"
        )
        print(f"RESULT={'PASS' if passed else 'FAIL'}")
        return 0 if passed else 3
    finally:
        for port in ports.values():
            try:
                send(port, "sync stop")
                send(port, "stop")
                send(port, "sleep")
                send(port, "stream off")
            except Exception:
                pass
            port.close()


if __name__ == "__main__":
    raise SystemExit(main())
