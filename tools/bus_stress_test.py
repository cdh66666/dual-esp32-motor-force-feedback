#!/usr/bin/env python3
"""Stress the framed DATA bus without enabling either motor bridge."""

from __future__ import annotations

import argparse
import re
import time

import serial


BUS = re.compile(r"BUS addr=(\d+).+baud=(\d+)")


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))
    port.flush()


def read_until(port: serial.Serial, predicate, timeout: float) -> list[str]:
    deadline = time.monotonic() + timeout
    lines: list[str] = []
    while time.monotonic() < deadline:
        raw = port.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace").strip()
        if line:
            lines.append(line)
            if predicate(line):
                break
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-a", required=True)
    parser.add_argument("--port-b", required=True)
    parser.add_argument("--baud", type=int, default=1_000_000)
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--first", choices=("A", "B"), default="A")
    parser.add_argument("--gap-ms", type=float, default=0.0)
    parser.add_argument("--command", choices=("ping", "status"), default="ping")
    args = parser.parse_args()

    ports = {
        "A": serial.Serial(args.port_a, 115200, timeout=0.003, write_timeout=1),
        "B": serial.Serial(args.port_b, 115200, timeout=0.003, write_timeout=1),
    }
    addresses: dict[str, int] = {}
    try:
        time.sleep(1)
        for name, port in ports.items():
            port.reset_input_buffer()
            for command in ("stop", "stream off", f"busbaud {args.baud}", "businfo"):
                send(port, command)
                time.sleep(0.03)
            lines = read_until(port, lambda line: line.startswith("BUS addr="), 0.5)
            for line in lines:
                match = BUS.search(line)
                if match:
                    addresses[name] = int(match.group(1))
                    if int(match.group(2)) != args.baud:
                        raise RuntimeError(f"{name} baud mismatch: {line}")
        if len(addresses) != 2 or addresses["A"] == addresses["B"]:
            raise RuntimeError(f"invalid addresses: {addresses}")

        total_ok = 0
        total_timeout = 0
        latencies_ms: list[float] = []
        source_order = (args.first, "B" if args.first == "A" else "A")
        for source in source_order:
            peer = "B" if source == "A" else "A"
            port = ports[source]
            ok = 0
            first_failure_reported = False
            for _ in range(args.count):
                port.reset_input_buffer()
                started = time.perf_counter()
                expected_payload = "payload=PONG" if args.command == "ping" else "payload=STATUS,"
                send(port, f"bus {addresses[peer]} {args.command}")
                lines = read_until(port, lambda line: expected_payload in line, 0.2)
                if any(expected_payload in line for line in lines):
                    ok += 1
                    latencies_ms.append((time.perf_counter() - started) * 1000)
                else:
                    total_timeout += 1
                    if not first_failure_reported:
                        print(f"{source}_FIRST_FAILURE=" + " | ".join(lines[-20:]))
                        first_failure_reported = True
                if args.gap_ms > 0:
                    time.sleep(args.gap_ms / 1000.0)
            total_ok += ok
            print(f"{source}_TO_{peer}={ok}/{args.count}")

        for name, port in ports.items():
            send(port, "businfo")
            lines = read_until(port, lambda line: line.startswith("BUS addr="), 0.5)
            info = [line for line in lines if line.startswith("BUS addr=")]
            print(f"{name}_BUSINFO=" + (info[-1] if info else "missing"))
        average = sum(latencies_ms) / max(1, len(latencies_ms))
        worst = max(latencies_ms, default=0)
        print(
            f"RESULT={'PASS' if total_timeout == 0 else 'FAIL'} "
            f"command={args.command} ok={total_ok}/{args.count * 2} avg={average:.3f}ms "
            f"worst={worst:.3f}ms timeouts={total_timeout}"
        )
        return 0 if total_timeout == 0 else 3
    finally:
        for port in ports.values():
            try:
                send(port, "stop")
            except Exception:
                pass
            port.close()


if __name__ == "__main__":
    raise SystemExit(main())
