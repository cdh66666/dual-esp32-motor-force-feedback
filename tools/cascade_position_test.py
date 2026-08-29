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


class SafetyAbort(RuntimeError):
    pass


def read_rows_guarded(
    port: serial.Serial,
    duration_s: float,
    label: str,
    max_velocity_dps: float = 800.0,
    max_current_ma: float = 5200.0,
) -> list[dict[str, float | str]]:
    deadline = time.monotonic() + duration_s
    host_start = time.monotonic()
    rows: list[dict[str, float | str]] = []
    unsafe_samples = 0
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
        unsafe = (
            int(float(row["nfault"])) == 0
            or abs(float(row["velocity_dps"])) > max_velocity_dps
            or abs(float(row["current_measured_ma"])) > max_current_ma
        )
        unsafe_samples = unsafe_samples + 1 if unsafe else 0
        if unsafe_samples >= 3:
            send(port, "stop")
            raise SafetyAbort(
                f"unsafe trajectory: velocity={float(row['velocity_dps']):.1f} deg/s, "
                f"current={float(row['current_measured_ma']):.0f} mA, "
                f"nFAULT={int(float(row['nfault']))}"
            )
    return rows


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
    accelerations = [
        abs(velocities[i] - velocities[i - 1]) /
        max(0.001, times[i] - times[i - 1])
        for i in range(1, len(velocities))
    ]
    hold_start = max(0.0, times[-1] - 10.0)
    hold_indices = [i for i, sample_time in enumerate(times) if sample_time >= hold_start]
    hold_angles = [angles[i] for i in hold_indices]
    hold_velocities = [velocities[i] for i in hold_indices]
    hold_currents = [float(rows[i]["current_measured_ma"]) for i in hold_indices]
    max_stuck_s = 0.0
    stuck_start: float | None = None
    for i, sample_time in enumerate(times):
        stuck = abs(errors[i]) > 0.5 and abs(velocities[i]) < 5.0
        if stuck and stuck_start is None:
            stuck_start = sample_time
        elif not stuck and stuck_start is not None:
            max_stuck_s = max(max_stuck_s, sample_time - stuck_start)
            stuck_start = None
    if stuck_start is not None:
        max_stuck_s = max(max_stuck_s, times[-1] - stuck_start)
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
        "acceleration_p95_dps2": percentile(accelerations, 0.95),
        "current_step_p95_ma": percentile(current_steps, 0.95),
        "max_stuck_s": max_stuck_s,
        "hold_window_s": times[-1] - hold_start,
        "hold_mean_deg": statistics.mean(hold_angles),
        "hold_abs_error_deg": statistics.mean(abs(target - value) for value in hold_angles),
        "hold_span_deg": max(hold_angles) - min(hold_angles),
        "hold_std_deg": statistics.pstdev(hold_angles),
        "hold_velocity_rms_dps": math.sqrt(statistics.mean(value * value for value in hold_velocities)),
        "hold_peak_velocity_dps": max(abs(value) for value in hold_velocities),
        "hold_current_rms_ma": math.sqrt(statistics.mean(value * value for value in hold_currents)),
        "hold_peak_current_ma": max(abs(value) for value in hold_currents),
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
    parser.add_argument("--duration", type=float, default=15.0)
    parser.add_argument("--kp", type=float, default=4.0)
    parser.add_argument("--ki", type=float, default=0.0)
    parser.add_argument("--kd", type=float, default=0.0)
    parser.add_argument("--max-velocity", type=float, default=120.0)
    parser.add_argument("--deadband", type=float, default=0.1)
    parser.add_argument("--min-velocity", type=float, default=0.0)
    parser.add_argument("--targets", type=float, nargs="+", default=[0.5, 0.0, 2.0, 0.0, 10.0, 0.0, 30.0, 0.0])
    parser.add_argument("--current-kp", type=float, default=400.0)
    parser.add_argument("--current-ki", type=float, default=1800.0)
    parser.add_argument("--current-max-pwm", type=float, default=4095.0)
    parser.add_argument("--velocity-kp", type=float, default=0.0005)
    parser.add_argument("--velocity-ki", type=float, default=0.001)
    parser.add_argument("--velocity-max-current", type=float, default=4.8)
    parser.add_argument("--velocity-friction", type=float, default=2.2)
    parser.add_argument("--velocity-current-slew", type=float, default=30.0)
    parser.add_argument("--velocity-brake-slew", type=float, default=30.0)
    parser.add_argument("--position-acceleration", type=float, default=300.0)
    parser.add_argument("--position-jerk", type=float, default=3000.0)
    parser.add_argument("--trajectory-bandwidth", type=float, default=5.0)
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
            f"cascade trajectory {args.max_velocity} {args.position_acceleration} {args.position_jerk} {args.trajectory_bandwidth}",
            "stream 100",
        )
        for command in commands:
            send(port, command)
            time.sleep(0.06)

        try:
            for target in args.targets:
                port.reset_input_buffer()
                send(port, f"pos {target:.3f} 4095 {int((args.duration + 1.0) * 1000)}")
                rows = read_rows_guarded(
                    port, args.duration, f"position_{target:+.3f}",
                    max_velocity_dps=max(800.0, args.max_velocity * 4.0),
                )
                all_rows.extend(rows)
                print(f"TARGET {target:+.3f} deg")
                for key, value in position_metrics(rows, target).items():
                    print(f"  {key}={value:.3f}" if isinstance(value, float) else f"  {key}={value}")
                time.sleep(0.15)
        finally:
            send(port, "stop")
            send(port, "stream off")
            send(port, "decay slow")

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
