#!/usr/bin/env python3
"""Capture and score cascaded velocity-loop step responses."""

from __future__ import annotations

import argparse
import csv
import math
import statistics
import time
from pathlib import Path

import serial


FIELDS = [
    "device_ms", "single_deg", "multi_deg", "bus_v", "legacy_current_ma",
    "pwm_abs", "nfault", "awake", "step", "encoder_raw", "velocity_dps",
    "control_mode", "legacy_target", "phase", "pwm_signed_legacy",
    "pid_raw", "pid_applied", "stall_boost", "settled",
    "velocity_target_dps", "current_target_ma", "current_measured_ma",
    "cascade_pwm",
]


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))
    port.flush()


def read_rows(port: serial.Serial, duration_s: float, label: str) -> list[dict[str, float | str]]:
    deadline = time.monotonic() + duration_s
    rows: list[dict[str, float | str]] = []
    host_start = time.monotonic()
    while time.monotonic() < deadline:
        raw = port.readline().decode("ascii", errors="replace").strip()
        if not raw.startswith("S,"):
            continue
        parts = raw.split(",")[1:]
        if len(parts) < len(FIELDS):
            continue
        try:
            row: dict[str, float | str] = {
                key: float(value) for key, value in zip(FIELDS, parts)
            }
        except ValueError:
            continue
        row["host_s"] = time.monotonic() - host_start
        row["label"] = label
        rows.append(row)
    return rows


def percentile(values: list[float], q: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    index = (len(ordered) - 1) * q
    lo = math.floor(index)
    hi = math.ceil(index)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] * (hi - index) + ordered[hi] * (index - lo)


def metrics(rows: list[dict[str, float | str]], target: float) -> dict[str, float | int]:
    if len(rows) < 5:
        return {"samples": len(rows)}
    sign = 1.0 if target >= 0 else -1.0
    velocities = [float(r["velocity_dps"]) for r in rows]
    signed_velocities = [v * sign for v in velocities]
    times = [float(r["host_s"]) for r in rows]
    intervals = [(times[i] - times[i - 1]) * 1000.0 for i in range(1, len(times))]
    tail = signed_velocities[max(0, len(rows) - max(5, int(len(rows) * 0.25))):]
    errors = [abs(target - v) for v in velocities]
    crossings = sum(
        1 for i in range(1, len(rows))
        if (velocities[i - 1] - target) * (velocities[i] - target) < 0
    )
    pwm = [float(r["cascade_pwm"]) for r in rows]
    pwm_reversals = sum(
        1 for i in range(1, len(pwm))
        if abs(pwm[i - 1]) > 10 and abs(pwm[i]) > 10 and pwm[i - 1] * pwm[i] < 0
    )
    reach10 = next((times[i] for i, v in enumerate(signed_velocities) if v >= abs(target) * 0.1), math.nan)
    reach90 = next((times[i] for i, v in enumerate(signed_velocities) if v >= abs(target) * 0.9), math.nan)
    settle_s = math.nan
    band = max(50.0, abs(target) * 0.10)
    for i in range(len(rows)):
        if all(abs(target - velocities[j]) <= band for j in range(i, len(rows))):
            settle_s = times[i]
            break
    return {
        "samples": len(rows),
        "sample_hz": 1000.0 / statistics.mean(intervals),
        "interval_p95_ms": percentile(intervals, 0.95),
        "start_velocity_dps": velocities[0],
        "rise10_s": reach10,
        "rise90_s": reach90,
        "settle10_s": settle_s,
        "peak_signed_velocity_dps": max(signed_velocities),
        "overshoot_pct": max(0.0, (max(signed_velocities) - abs(target)) / abs(target) * 100.0),
        "tail_mean_dps": statistics.mean(tail) * sign,
        "tail_span_dps": max(tail) - min(tail),
        "mean_abs_error_dps": statistics.mean(errors),
        "target_crossings": crossings,
        "pwm_reversals": pwm_reversals,
        "peak_current_target_ma": max(abs(float(r["current_target_ma"])) for r in rows),
        "peak_current_measured_ma": max(abs(float(r["current_measured_ma"])) for r in rows),
        "peak_pwm": max(abs(v) for v in pwm),
        "nfault_min": int(min(float(r["nfault"]) for r in rows)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, help="Freshly enumerated USB CDC port")
    parser.add_argument("--target", type=float, default=1000.0)
    parser.add_argument("--duration", type=float, default=2.2)
    parser.add_argument("--kp", type=float, default=0.0005)
    parser.add_argument("--ki", type=float, default=0.0005)
    parser.add_argument("--max-current", type=float, default=2.0)
    parser.add_argument("--friction", type=float, default=0.75)
    parser.add_argument("--current-kp", type=float, default=150.0)
    parser.add_argument("--current-ki", type=float, default=1800.0)
    parser.add_argument("--current-max-pwm", type=float, default=1500.0)
    parser.add_argument("--current-slew", type=float, default=3.0)
    parser.add_argument("--brake-slew", type=float, default=4.0)
    parser.add_argument("--drive", choices=("sign", "locked"), default="sign")
    args = parser.parse_args()

    output_dir = Path(__file__).resolve().parent / "captures"
    output_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    output = output_dir / f"velocity-step-{stamp}.csv"
    all_rows: list[dict[str, float | str]] = []

    with serial.Serial(args.port, 115200, timeout=0.03, write_timeout=1.0) as port:
        time.sleep(1.8)
        port.reset_input_buffer()
        for command in (
            "stop", "wake", "decay slow", "setstep 3", f"drivemode {args.drive}",
            f"cascade current {args.current_kp} {args.current_ki} {args.current_max_pwm}",
            f"cascade velocity {args.kp} {args.ki} {args.max_current} {args.friction} {args.current_slew} {args.brake_slew}",
            "stream 100",
        ):
            send(port, command)
            time.sleep(0.06)

        for target in (abs(args.target), -abs(args.target)):
            send(port, "stop")
            time.sleep(0.35)
            port.reset_input_buffer()
            send(port, "wake")
            time.sleep(0.08)
            send(port, f"velocity {target:.3f} 1500 {int((args.duration + 0.8) * 1000)}")
            rows = read_rows(port, args.duration, f"velocity_{target:+.0f}")
            all_rows.extend(rows)
            send(port, "stop")
            time.sleep(0.45)
            print(f"TARGET {target:+.0f} dps")
            for key, value in metrics(rows, target).items():
                if isinstance(value, float):
                    print(f"  {key}={value:.3f}")
                else:
                    print(f"  {key}={value}")

        send(port, "stop")
        send(port, "stream off")

    if all_rows:
        columns = ["label", "host_s", *FIELDS]
        with output.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(all_rows)
        print(f"CSV={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
