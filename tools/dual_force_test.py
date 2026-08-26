#!/usr/bin/env python3
"""Exercise the 1 Mbaud DATA link and bilateral force controller on two boards."""

from __future__ import annotations

import argparse
import re
import statistics
import time

import serial

from cascade_step_test import FIELDS


BUS = re.compile(r"BUS addr=(\d+).+baud=(\d+)")
SYNC = re.compile(
    r"SYNC mode=force.+tx=(\d+)\((\d+)/(\d+)\) "
    r"rx=(\d+)\((\d+)/(\d+)\) timeout=(\d+)"
)


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))
    port.flush()


def drain_pair(ports: dict[str, serial.Serial], duration: float):
    deadline = time.monotonic() + duration
    rows = {name: [] for name in ports}
    lines = {name: [] for name in ports}
    while time.monotonic() < deadline:
        had_data = False
        for name, port in ports.items():
            raw = port.readline()
            if not raw:
                continue
            had_data = True
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            lines[name].append(text)
            if text.startswith("S,"):
                values = text.split(",")[1:]
                if len(values) >= len(FIELDS):
                    try:
                        rows[name].append({key: float(value) for key, value in zip(FIELDS, values)})
                    except ValueError:
                        pass
        if not had_data:
            time.sleep(0.001)
    return rows, lines


def telemetry_rate(rows: list[dict[str, float]]) -> float:
    if len(rows) < 3:
        return 0.0
    elapsed = rows[-1]["device_ms"] - rows[0]["device_ms"]
    return (len(rows) - 1) * 1000.0 / max(1.0, elapsed)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-a", required=True)
    parser.add_argument("--port-b", required=True)
    parser.add_argument("--stiffness", type=float, default=150.0, help="mA/deg")
    parser.add_argument("--damping", type=float, default=0.2, help="mA/(deg/s)")
    parser.add_argument("--limit", type=float, default=2000.0, help="mA")
    parser.add_argument("--offset", type=float, default=15.0, help="opposed test offset in deg")
    parser.add_argument("--duration", type=float, default=3.0)
    parser.add_argument("--baud", type=int, default=1_000_000)
    parser.add_argument("--stream-rate", type=int, default=100)
    args = parser.parse_args()
    if args.port_a == args.port_b:
        parser.error("ports must be different")

    ports = {
        "A": serial.Serial(args.port_a, 115200, timeout=0.005, write_timeout=1.0),
        "B": serial.Serial(args.port_b, 115200, timeout=0.005, write_timeout=1.0),
    }
    addresses: dict[str, int] = {}
    try:
        time.sleep(1.0)
        for port in ports.values():
            port.reset_input_buffer()
            for command in (
                "stop", "wake", "encreset", f"busbaud {args.baud}",
                "cascade current 400 1800 4095",
                "cascade velocity 0.0005 0.001 3 2 10 30",
                "cascade position 8 0 0.5 3000 3 2000 20000 1",
                f"stream {args.stream_rate}" if args.stream_rate else "stream off",
                "businfo",
            ):
                send(port, command)
                time.sleep(0.04)
        _, startup_lines = drain_pair(ports, 0.8)
        for name, lines in startup_lines.items():
            for line in lines:
                match = BUS.search(line)
                if match:
                    addresses[name] = int(match.group(1))
                    baud = int(match.group(2))
                    if baud != args.baud:
                        raise RuntimeError(f"{name} DATA baud is {baud}, expected {args.baud}")
        if len(addresses) != 2 or addresses["A"] == addresses["B"]:
            raise RuntimeError(f"invalid bus addresses: {addresses}")

        # Ping and status in both directions before enabling motion.
        for name, port in ports.items():
            peer_name = "B" if name == "A" else "A"
            for command in (f"bus {addresses[peer_name]} ping", f"bus {addresses[peer_name]} status"):
                send(port, command)
                time.sleep(0.08)
        _, bus_lines = drain_pair(ports, 0.8)
        for name, lines in bus_lines.items():
            print(f"{name}_BUS=" + " | ".join(line for line in lines if line.startswith("BUS_")))

        # Configure the higher-address responder first and the request owner last.
        ordered = sorted(ports, key=lambda name: addresses[name], reverse=True)
        for name in ordered:
            peer_name = "B" if name == "A" else "A"
            signed_offset = args.offset if name == "A" else -args.offset
            send(
                ports[name],
                "sync force {} {} {} 0 {} 4095 30000 {}".format(
                    addresses[peer_name], args.stiffness, args.damping,
                    args.limit, signed_offset,
                ),
            )
            time.sleep(0.1)

        rows, motion_lines = drain_pair(ports, args.duration)
        for name, lines in motion_lines.items():
            events = [line for line in lines if not line.startswith("S,")]
            if events:
                print(f"{name}_EVENTS=" + " | ".join(events[-20:]))
        for port in ports.values():
            send(port, "sync status")
            send(port, "businfo")
        _, status_lines = drain_pair(ports, 0.5)

        statuses = {}
        for name, lines in status_lines.items():
            candidates = [line for line in lines if line.startswith("SYNC mode=force")]
            print(f"{name}_SYNC=" + (candidates[-1] if candidates else "missing"))
            businfo = [line for line in lines if line.startswith("BUS addr=")]
            print(f"{name}_BUSINFO=" + (businfo[-1] if businfo else "missing"))
            if candidates:
                match = SYNC.search(candidates[-1])
                if match:
                    statuses[name] = tuple(map(int, match.groups()))

        metrics = {}
        for name, samples in rows.items():
            tail = samples[-max(10, len(samples) // 5):]
            metrics[name] = {
                "samples": len(samples),
                "sample_hz": telemetry_rate(samples),
                "nfault_min": min((row["nfault"] for row in samples), default=0),
                "peak_current_ma": max((abs(row["current_measured_ma"]) for row in samples), default=0),
                "peak_target_ma": max((abs(row["current_target_ma"]) for row in samples), default=0),
                "peak_pwm": max((abs(row["cascade_pwm"]) for row in samples), default=0),
                "tail_position_deg": statistics.mean(row["multi_deg"] for row in tail) if tail else 0,
            }
            print(name + "_METRICS=" + " ".join(f"{key}={value:.3f}" for key, value in metrics[name].items()))

        paired = min(len(rows["A"]), len(rows["B"]))
        opposed = 0
        active = 0
        for index in range(paired):
            ia = rows["A"][index]["current_target_ma"]
            ib = rows["B"][index]["current_target_ma"]
            if max(abs(ia), abs(ib)) >= 100:
                active += 1
                if ia * ib < 0:
                    opposed += 1
        opposition = opposed / max(1, active)
        relative = metrics["A"]["tail_position_deg"] - metrics["B"]["tail_position_deg"]
        coupling_error = abs(relative - args.offset)
        print(f"PAIR opposition={opposition:.3f} relative={relative:.3f}deg coupling_error={coupling_error:.3f}deg")

        passed = (
            (args.stream_rate == 0 or
             all(args.stream_rate * 0.95 <= metrics[name]["sample_hz"] <=
                 args.stream_rate * 1.05 for name in ports))
            and all(metrics[name]["nfault_min"] >= 1 for name in ports)
            and all(metrics[name]["peak_current_ma"] <= args.limit * 1.25 for name in ports)
            and opposition >= 0.9
            and len(statuses) == 2
            and all(statuses[name][6] == 0 and statuses[name][3] > 10 for name in ports)
        )
        print("RESULT=" + ("PASS" if passed else "FAIL"))
        return 0 if passed else 3
    finally:
        for port in ports.values():
            try:
                send(port, "sync stop")
                send(port, "stream off")
            except Exception:
                pass
            port.close()


if __name__ == "__main__":
    raise SystemExit(main())
