#!/usr/bin/env python3
"""Capture and score signed current-loop step responses."""

from __future__ import annotations

import argparse
import csv
import math
import statistics
import time
from pathlib import Path

import serial

from cascade_step_test import FIELDS, read_rows, send


def score(rows: list[dict[str, float | str]], target_ma: float) -> dict[str, float | int]:
    if len(rows) < 5:
        return {"samples": len(rows)}
    measured = [float(row["current_measured_ma"]) for row in rows]
    times = [float(row["host_s"]) for row in rows]
    direction = 1.0 if target_ma >= 0 else -1.0
    signed = [value * direction for value in measured]
    command_index = next(
        (
            index for index, row in enumerate(rows)
            if abs(float(row["current_target_ma"])) >= abs(target_ma) * 0.9
        ),
        0,
    )
    command_time = times[command_index]
    tail = signed[-max(10, int(len(rows) * 0.3)):]
    rise90_capture = next(
        (times[i] for i, value in enumerate(signed) if value >= abs(target_ma) * 0.9),
        math.nan,
    )
    rise90 = (
        max(0.0, rise90_capture - command_time)
        if math.isfinite(rise90_capture) else math.nan
    )
    pwm = [float(row["cascade_pwm"]) for row in rows]
    return {
        "samples": len(rows),
        "sample_hz": (len(times) - 1) / (times[-1] - times[0]),
        "command_seen_s": command_time,
        "rise90_s": rise90,
        "capture_rise90_s": rise90_capture,
        "tail_mean_ma": statistics.mean(tail) * direction,
        "tail_error_ma": abs(statistics.mean(tail) - abs(target_ma)),
        "tail_span_ma": max(tail) - min(tail),
        "peak_signed_ma": max(signed),
        "overshoot_pct": max(0.0, (max(signed) - abs(target_ma)) / abs(target_ma) * 100.0),
        "peak_pwm": max(abs(value) for value in pwm),
        "peak_velocity_dps": max(abs(float(row["velocity_dps"])) for row in rows),
        "nfault_min": int(min(float(row["nfault"]) for row in rows)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, help="Freshly enumerated USB CDC port")
    parser.add_argument("--target", type=float, default=500.0)
    parser.add_argument("--duration", type=float, default=1.5)
    parser.add_argument("--kp", type=float, default=400.0)
    parser.add_argument("--ki", type=float, default=1800.0)
    parser.add_argument("--max-pwm", type=float, default=4095.0)
    parser.add_argument("--drive", choices=("sign", "locked"), default="sign")
    args = parser.parse_args()

    output_dir = Path(__file__).resolve().parent / "captures"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"current-step-{args.port}-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    all_rows: list[dict[str, float | str]] = []
    with serial.Serial(args.port, 115200, timeout=0.03, write_timeout=1.0) as port:
        time.sleep(1.8)
        port.reset_input_buffer()
        for command in (
            "stop", "wake", "decay slow", "setstep 3",
            f"drivemode {args.drive}",
            f"cascade current {args.kp} {args.ki} {args.max_pwm}", "stream 100",
        ):
            send(port, command)
            time.sleep(0.06)
        for target in (abs(args.target), -abs(args.target)):
            send(port, "stop")
            time.sleep(0.3)
            port.reset_input_buffer()
            send(port, "wake")
            time.sleep(0.05)
            send(port, f"current {target:.1f} {int(args.max_pwm)} {int((args.duration + 0.5) * 1000)}")
            rows = read_rows(port, args.duration, f"current_{target:+.0f}")
            all_rows.extend(rows)
            send(port, "stop")
            time.sleep(0.35)
            print(f"TARGET {target:+.0f} mA")
            for key, value in score(rows, target).items():
                print(f"  {key}={value:.3f}" if isinstance(value, float) else f"  {key}={value}")
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
