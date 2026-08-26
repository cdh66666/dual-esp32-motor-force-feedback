#!/usr/bin/env python3
"""Measure unidirectional DATA-bus delivery at a fixed frame rate, motors disabled."""

from __future__ import annotations

import argparse
import re
import time

import serial


BUS_LINE = re.compile(r"^BUS addr=(?P<addr>\d+).+baud=(?P<baud>\d+).+")
COUNTER = re.compile(r"\b(crc_err|resync|uart_err|rx_bytes|valid|addressed|cmd_rx|tx|response_tx)=(\d+)")


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))


class Reader:
    def __init__(self, port: serial.Serial) -> None:
        self.port = port
        self.pending = b""
        self.lines: list[str] = []

    def drain(self) -> list[str]:
        waiting = self.port.in_waiting
        if waiting:
            self.pending += self.port.read(waiting)
        parts = self.pending.split(b"\n")
        self.pending = parts.pop()
        new_lines = [part.rstrip(b"\r").decode("utf-8", errors="replace") for part in parts]
        self.lines.extend(line for line in new_lines if line)
        return new_lines

    def wait_for(self, prefix: str, timeout: float) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for line in self.drain():
                if line.startswith(prefix):
                    return line
            time.sleep(0.001)
        raise RuntimeError(f"timeout waiting for {prefix!r}; tail={self.lines[-10:]}")


def bus_counters(line: str) -> dict[str, int]:
    return {name: int(value) for name, value in COUNTER.findall(line)}


def businfo(port: serial.Serial, reader: Reader) -> tuple[str, dict[str, int]]:
    reader.drain()
    send(port, "businfo")
    line = reader.wait_for("BUS addr=", 1.0)
    return line, bus_counters(line)


def delta(before: dict[str, int], after: dict[str, int], key: str) -> int:
    return after.get(key, 0) - before.get(key, 0)


def run_direction(
    label: str,
    source: serial.Serial,
    destination: serial.Serial,
    source_reader: Reader,
    destination_reader: Reader,
    count: int,
    period: float,
) -> bool:
    source_reader.lines.clear()
    destination_reader.lines.clear()
    _, source_before = businfo(source, source_reader)
    _, destination_before = businfo(destination, destination_reader)
    source_reader.lines.clear()
    destination_reader.lines.clear()

    started = time.perf_counter()
    next_send = started
    for _ in range(count):
        send(source, "bus all stop")
        source_reader.drain()
        destination_reader.drain()
        next_send += period
        remaining = next_send - time.perf_counter()
        if remaining > 0.001:
            time.sleep(remaining - 0.0005)
        while time.perf_counter() < next_send:
            source_reader.drain()
            destination_reader.drain()

    transmission_elapsed = time.perf_counter() - started

    drain_deadline = time.monotonic() + 1.0
    while time.monotonic() < drain_deadline:
        source_reader.drain()
        destination_reader.drain()
        time.sleep(0.001)
    ok_logs = sum(line.startswith("OK bus_tx") for line in source_reader.lines)

    _, source_after = businfo(source, source_reader)
    destination_line, destination_after = businfo(destination, destination_reader)
    result = {
        "usb_ok": ok_logs,
        "src_tx": delta(source_before, source_after, "tx"),
        "dst_valid": delta(destination_before, destination_after, "valid"),
        "dst_addressed": delta(destination_before, destination_after, "addressed"),
        "dst_cmd_rx": delta(destination_before, destination_after, "cmd_rx"),
        "dst_crc_err": delta(destination_before, destination_after, "crc_err"),
        "dst_resync": delta(destination_before, destination_after, "resync"),
        "dst_uart_err": delta(destination_before, destination_after, "uart_err"),
    }
    passed = (
        result["usb_ok"] == count
        and result["src_tx"] == count
        and result["dst_valid"] == count
        and result["dst_addressed"] == count
        and result["dst_cmd_rx"] == count
        and result["dst_crc_err"] == 0
        and result["dst_resync"] == 0
        and result["dst_uart_err"] == 0
    )
    print(
        f"{label}={'PASS' if passed else 'FAIL'} count={count} "
        f"rate={count / transmission_elapsed:.2f}Hz elapsed={transmission_elapsed:.3f}s "
        + " ".join(f"{key}={value}" for key, value in result.items())
    )
    print(f"{label}_DESTINATION={destination_line}")
    return passed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-a", required=True)
    parser.add_argument("--port-b", required=True)
    parser.add_argument("--count", type=int, default=1000)
    parser.add_argument("--rate", type=float, default=200.0)
    parser.add_argument("--baud", type=int, default=1_000_000)
    parser.add_argument("--awake", action="store_true", help="wake both bridges but keep PWM at zero")
    args = parser.parse_args()
    if args.port_a == args.port_b or args.count <= 0 or args.rate <= 0:
        parser.error("ports must differ and count/rate must be positive")

    ports = {
        "A": serial.Serial(args.port_a, 115200, timeout=0, write_timeout=1),
        "B": serial.Serial(args.port_b, 115200, timeout=0, write_timeout=1),
    }
    readers = {name: Reader(port) for name, port in ports.items()}
    try:
        time.sleep(1.0)
        for name, port in ports.items():
            port.reset_input_buffer()
            for command in (
                "sync stop", "stop", "wake" if args.awake else "sleep",
                "stream off", f"busbaud {args.baud}",
            ):
                send(port, command)
                time.sleep(0.03)
            line, _ = businfo(port, readers[name])
            match = BUS_LINE.match(line)
            if not match or int(match.group("baud")) != args.baud:
                raise RuntimeError(f"{name} configuration mismatch: {line}")
            print(f"{name}_START={line}")

        period = 1.0 / args.rate
        passed_ab = run_direction(
            "A_TO_B", ports["A"], ports["B"], readers["A"], readers["B"], args.count, period
        )
        passed_ba = run_direction(
            "B_TO_A", ports["B"], ports["A"], readers["B"], readers["A"], args.count, period
        )
        passed = passed_ab and passed_ba
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
