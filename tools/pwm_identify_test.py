import argparse
import csv
import time
from pathlib import Path

import serial


FIELDS = [
    "device_ms", "single_deg", "multi_deg", "bus_v", "legacy_current_ma",
    "pwm_abs", "nfault", "awake", "step", "encoder_raw", "velocity_dps",
    "control_mode", "legacy_target", "phase", "pwm_signed_legacy", "pid_raw",
    "pid_applied", "stall_boost", "settled", "velocity_target_dps",
    "current_target_ma", "current_measured_ma", "cascade_pwm", "raw_velocity_dps",
]


def send(port: serial.Serial, command: str) -> None:
    port.write((command + "\n").encode("ascii"))
    port.flush()


def read_rows(port: serial.Serial, duration_s: float, label: str) -> list[dict[str, float | str]]:
    deadline = time.monotonic() + duration_s
    start = time.monotonic()
    rows: list[dict[str, float | str]] = []
    while time.monotonic() < deadline:
        line = port.readline().decode("ascii", errors="ignore").strip()
        if not line.startswith(("S,", "T,")):
            continue
        values = line.split(",")[1:]
        if len(values) < len(FIELDS):
            continue
        row: dict[str, float | str] = {"label": label, "host_s": time.monotonic() - start}
        try:
            row.update({key: float(value) for key, value in zip(FIELDS, values)})
        except ValueError:
            continue
        rows.append(row)
    return rows


def summarize(rows: list[dict[str, float | str]]) -> dict[str, float]:
    if not rows:
        return {}
    start = float(rows[0]["multi_deg"])
    end = float(rows[-1]["multi_deg"])
    moving = [abs(float(row["velocity_dps"])) for row in rows if abs(float(row["velocity_dps"])) > 50.0]
    tail = rows[len(rows) * 2 // 3:]
    return {
        "sample_hz": (len(rows) - 1) / max(0.001, float(rows[-1]["host_s"]) - float(rows[0]["host_s"])),
        "delta_deg": end - start,
        "moving_fraction": len(moving) / len(rows),
        "tail_mean_abs_velocity_dps": sum(abs(float(row["velocity_dps"])) for row in tail) / len(tail),
        "peak_abs_velocity_dps": max(abs(float(row["velocity_dps"])) for row in rows),
        "mean_abs_current_ma": sum(abs(float(row["current_measured_ma"])) for row in rows) / len(rows),
        "peak_abs_current_ma": max(abs(float(row["current_measured_ma"])) for row in rows),
        "nfault_min": min(float(row["nfault"]) for row in rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, help="Freshly enumerated USB CDC port")
    parser.add_argument("--duties", type=int, nargs="+", default=[160, 200, 240, 280, 320])
    parser.add_argument("--duration", type=float, default=1.0)
    parser.add_argument("--decay", choices=("slow", "fast"), default="slow")
    args = parser.parse_args()
    if not 0.2 <= args.duration <= 1.0:
        parser.error("duration must be 0.2..1.0 seconds")

    output_dir = Path(__file__).resolve().parent / "captures"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"pwm-identify-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    all_rows: list[dict[str, float | str]] = []

    with serial.Serial(args.port, 115200, timeout=0.03, write_timeout=1.0) as port:
        time.sleep(1.8)
        port.reset_input_buffer()
        for command in ("stop", "wake", f"decay {args.decay}", "setstep 3", "drivemode sign", "stream 100"):
            send(port, command)
            time.sleep(0.06)
        for direction in ("cw", "ccw"):
            for duty in args.duties:
                send(port, "stop")
                time.sleep(0.35)
                port.reset_input_buffer()
                send(port, f"{direction} {duty} {int(args.duration * 1000)}")
                rows = read_rows(port, args.duration, f"{direction}_{duty}")
                all_rows.extend(rows)
                send(port, "stop")
                time.sleep(0.35)
                print(f"{direction.upper()} duty={duty}/4095 ({100.0*duty/4095.0:.2f}%)")
                for key, value in summarize(rows).items():
                    print(f"  {key}={value:.3f}")
        send(port, "stop")
        send(port, "stream off")

    if all_rows:
        with output.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=["label", "host_s", *FIELDS])
            writer.writeheader()
            writer.writerows(all_rows)
        print(f"CSV={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
