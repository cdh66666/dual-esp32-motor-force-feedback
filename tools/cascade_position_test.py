#!/usr/bin/env python3
"""Capture cascaded position-loop trajectories on a selected motor board."""

from __future__ import annotations

import argparse
import csv
import math
import statistics
import time
from pathlib import Path

import serial

from cascade_step_test import FIELDS, percentile, read_rows, send


def position_metrics(rows: list[dict[str, float | str]], target: float) -> dict[str, float | int]:
    if len(rows) < 5:
        return {"samples": len(rows)}
    angles = [float(r["multi_deg"]) for r in rows]
    times = [float(r["host_s"]) for r in rows]
    errors = [target - value for value in angles]
    start_error = errors[0]
    direction = 1.0 if start_error >= 0 else -1.0
    tail_count = max(10, int(len(rows) * 0.25))
    tail = angles[-tail_count:]
    crossings = sum(1 for i in range(1, len(errors)) if errors[i - 1] * errors[i] < 0)
    pwm = [float(r["cascade_pwm"]) for r in rows]
    velocities = [float(r["velocity_dps"]) for r in rows]
    current_targets = [float(r["current_target_ma"]) for r in rows]
    pwm_reversals = sum(
        1 for i in range(1, len(pwm))
        if abs(pwm[i - 1]) > 10 and abs(pwm[i]) > 10 and pwm[i - 1] * pwm[i] < 0
    )
    within10 = next((times[i] for i, error in enumerate(errors) if abs(error) <= 10.0), math.nan)
    settle5 = math.nan
    for i in range(len(rows)):
        if all(abs(errors[j]) <= 5.0 for j in range(i, len(rows))):
            settle5 = times[i]
            break
    signed_progress = [(value - angles[0]) * direction for value in angles]
    commanded_distance = abs(target - angles[0])
    overshoot = max(0.0, max(signed_progress) - commanded_distance)
    intervals = [(times[i] - times[i - 1]) * 1000.0 for i in range(1, len(times))]
    velocity_steps = [abs(velocities[i] - velocities[i - 1]) for i in range(1, len(velocities))]
    current_steps = [abs(current_targets[i] - current_targets[i - 1]) for i in range(1, len(current_targets))]
    far_samples = [
        i for i, error in enumerate(errors)
        if abs(error) > 20.0
    ]
    stalled_far = [i for i in far_samples if abs(velocities[i]) < 50.0]
    return {
        "samples": len(rows),
        "sample_hz": 1000.0 / statistics.mean(intervals),
        "start_deg": angles[0],
        "target_deg": target,
        "reach_10deg_s": within10,
        "settle_5deg_s": settle5,
        "overshoot_deg": overshoot,
        "tail_mean_deg": statistics.mean(tail),
        "tail_abs_error_deg": statistics.mean(abs(target - value) for value in tail),
        "tail_span_deg": max(tail) - min(tail),
        "target_crossings": crossings,
        "pwm_reversals": pwm_reversals,
        "velocity_step_p95_dps": percentile(velocity_steps, 0.95),
        "current_step_p95_ma": percentile(current_steps, 0.95),
        "far_stall_fraction": len(stalled_far) / max(1, len(far_samples)),
        "peak_velocity_dps": max(abs(float(r["velocity_dps"])) for r in rows),
        "peak_current_ma": max(abs(float(r["current_measured_ma"])) for r in rows),
        "peak_pwm": max(abs(value) for value in pwm),
        "settled_seen": int(max(float(r["settled"]) for r in rows)),
        "nfault_min": int(min(float(r["nfault"]) for r in rows)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, help="Freshly enumerated USB CDC port")
    parser.add_argument("--duration", type=float, default=6.0)
    parser.add_argument("--kp", type=float, default=8.0)
    parser.add_argument("--ki", type=float, default=0.0)
    parser.add_argument("--kd", type=float, default=0.5)
    parser.add_argument("--max-velocity", type=float, default=3000.0)
    parser.add_argument("--deadband", type=float, default=3.0)
    parser.add_argument("--min-velocity", type=float, default=2000.0)
    parser.add_argument("--targets", type=float, nargs="+", default=[1080.0, 0.0])
    parser.add_argument("--current-kp", type=float, default=400.0)
    parser.add_argument("--current-ki", type=float, default=1800.0)
    parser.add_argument("--current-max-pwm", type=float, default=4095.0)
    parser.add_argument("--velocity-kp", type=float, default=0.0005)
    parser.add_argument("--velocity-ki", type=float, default=0.001)
    parser.add_argument("--velocity-max-current", type=float, default=4.8)
    parser.add_argument("--velocity-friction", type=float, default=2.2)
    parser.add_argument("--velocity-current-slew", type=float, default=10.0)
    parser.add_argument("--velocity-brake-slew", type=float, default=30.0)
    parser.add_argument("--position-acceleration", type=float, default=20000.0)
    parser.add_argument("--reverse-kd-scale", type=float, default=1.0)
    parser.add_argument("--decay", choices=("slow", "fast"), default="slow")
    parser.add_argument("--drive", choices=("sign", "locked"), default="sign")
    args = parser.parse_args()

    output_dir = Path(__file__).resolve().parent / "captures"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"position-step-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    all_rows: list[dict[str, float | str]] = []

    with serial.Serial(args.port, 115200, timeout=0.03, write_timeout=1.0) as port:
        time.sleep(1.8)
        port.reset_input_buffer()
        commands = (
            "stop", "wake", f"decay {args.decay}", "setstep 3", "encreset",
            f"drivemode {args.drive}",
            f"cascade current {args.current_kp} {args.current_ki} {args.current_max_pwm}",
            f"cascade velocity {args.velocity_kp} {args.velocity_ki} {args.velocity_max_current} {args.velocity_friction} {args.velocity_current_slew} {args.velocity_brake_slew}",
            f"cascade position {args.kp} {args.ki} {args.kd} {args.max_velocity} {args.deadband} {args.min_velocity} {args.position_acceleration} {args.reverse_kd_scale}",
            "stream 100",
        )
        for command in commands:
            send(port, command)
            time.sleep(0.06)

        for target in args.targets:
            port.reset_input_buffer()
            send(port, f"pos {target:.2f} 4095 {int((args.duration + 1.0) * 1000)}")
            rows = read_rows(port, args.duration, f"position_{target:+.0f}")
            all_rows.extend(rows)
            print(f"TARGET {target:+.0f} deg")
            for key, value in position_metrics(rows, target).items():
                print(f"  {key}={value:.3f}" if isinstance(value, float) else f"  {key}={value}")
            # Keep position mode active through the tail of each capture.
            # The next target replaces the command directly; STOP is reserved
            # for the end of the complete sequence so magnetic detent torque
            # cannot move the shaft during the hold-quality measurement.
            time.sleep(0.15)

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
