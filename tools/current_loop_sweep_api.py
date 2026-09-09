"""Powered, bounded current-loop sweep through the local dashboard API.

This measures branch-current tracking only. It does not claim a motor stall or
continuous thermal rating. Every segment ends with STOP; faults and envelope
violations stop the run immediately.
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8766/api/"
FIELDS = [
    "device_ms", "single_deg", "multi_deg", "bus_v", "legacy_current_ma",
    "pwm_abs", "nfault", "awake", "step", "encoder_raw", "velocity_dps",
    "control_mode", "legacy_target", "phase", "pwm_signed_legacy", "pid_raw",
    "pid_applied", "stall_boost", "settled", "velocity_target_dps",
    "current_target_ma", "current_measured_ma", "cascade_pwm", "raw_velocity_dps",
]


def api(endpoint: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(BASE + endpoint,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


def command(port: str, text: str) -> str:
    result = api("send", {"port": port, "command": text, "wait_ack": True})
    if not result.get("ok") or not result.get("acknowledged"):
        raise RuntimeError(f"{port} {text}: {result}")
    return str(result.get("reply", ""))


def collect(port: str, cursor: int, seconds: float, out, max_current: float):
    rows = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        payload = api(f"logs?port={port}&since={cursor}")
        for entry in payload.get("logs", []):
            cursor = max(cursor, int(entry["seq"]))
            out.write(json.dumps({"port": port, "host": time.time(), **entry}, ensure_ascii=False) + "\n")
            out.flush()
            text = entry.get("text", "")
            if entry.get("direction") != "rx":
                continue
            if text.startswith("ERR ") or text.startswith("CASCADE fault") or text.startswith("CASCADE no_"):
                raise RuntimeError(f"board fault: {text}")
            if not text.startswith("S,"):
                continue
            values = text.split(",")[1:]
            if len(values) < len(FIELDS):
                continue
            try:
                row = {k: float(v) for k, v in zip(FIELDS, values)}
            except ValueError:
                continue
            if not all(math.isfinite(v) for v in row.values()):
                continue
            rows.append(row)
            if row["nfault"] != 1 or row["awake"] != 1 or row["bus_v"] < 8:
                raise RuntimeError(f"envelope/fault telemetry: {text}")
            # After STOP a freely spinning geared motor can regenerate and the
            # INA240 signal can show a short signed transient. It is not a
            # current-loop tracking sample. Guard only active current mode.
            if row["control_mode"] == 1 and abs(row["current_measured_ma"]) > max_current * 1000:
                raise RuntimeError(f"overcurrent telemetry: {text}")
        time.sleep(0.012)
    return cursor, rows


def metric(rows: list[dict], target: float) -> dict:
    if not rows:
        return {"samples": 0, "target_ma": target}
    # Ignore the first 200 ms after the command for steady-state ripple.
    t0 = rows[0]["device_ms"]
    tail = [r for r in rows if r["device_ms"] - t0 >= 200]
    if not tail:
        tail = rows[len(rows)//2:]
    values = [r["current_measured_ma"] for r in tail]
    signed = [v if target >= 0 else -v for v in values]
    error = [v - abs(target) for v in signed]
    peak = max(abs(r["current_measured_ma"]) for r in rows)
    command_rows = [r for r in rows if abs(r["current_target_ma"]) >= abs(target) * .9]
    rise = None
    if command_rows:
        command_time = command_rows[0]["device_ms"]
        reached = [r for r in rows if (r["current_measured_ma"] if target >= 0 else -r["current_measured_ma"]) >= abs(target)*.9]
        if reached:
            rise = reached[0]["device_ms"] - command_time
    return {
        "samples": len(rows), "target_ma": target,
        "tail_mean_ma": sum(signed) / len(signed),
        "tail_error_mean_ma": sum(error) / len(error),
        "tail_min_ma": min(signed), "tail_max_ma": max(signed),
        "tail_ripple_pp_ma": max(signed) - min(signed),
        "tail_ripple_rms_ma": math.sqrt(sum((x - sum(signed)/len(signed))**2 for x in signed) / len(signed)),
        "peak_abs_ma": peak, "overshoot_pct": max(0.0, (max(signed)-abs(target))/max(1.0, abs(target))*100),
        "rise90_ms": rise, "peak_pwm": max(abs(r["cascade_pwm"]) for r in rows),
        "peak_speed_dps": max(abs(r["velocity_dps"]) for r in rows),
        "nfault_min": min(r["nfault"] for r in rows), "bus_min_v": min(r["bus_v"] for r in rows),
    }


def run(port: str, output: Path):
    ports = {p["port"]: p for p in api("ports").get("ports", [])}
    board = ports.get(port, {})
    if not board.get("esp32") or "303A:1001" not in board.get("hwid", ""):
        raise RuntimeError(f"USB identity not verified for {port}: {board}")
    lines = api(f"logs?port={port}&since=0").get("logs", [])
    cursor = max((int(x["seq"]) for x in lines), default=0)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        def record(obj):
            out.write(json.dumps(obj, ensure_ascii=False) + "\n")
            out.flush()
        record({"test": "current-loop-sweep", "port": port, "started": time.time(), "board": board})
        try:
            for text in ("stop", "sleep", "motorprofile 36gp555", "cascade current 600 600000 4095", "stream 100", "wake"):
                reply = command(port, text)
                record({"command": text, "reply": reply})
                time.sleep(.08)
            # 2 A is the firmware profile envelope. A 2.1 A hard guard catches
            # overshoot without treating the profile as a winding rating.
            targets = [100, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800,
                       -100, -200, -400, -600, -800, -1000, -1200, -1400, -1600, -1800]
            metrics = []
            for target in targets:
                command(port, "stop")
                time.sleep(.10)
                command(port, "wake")
                time.sleep(.05)
                command(port, f"current {target} 4095 1800")
                # Commands are sent through the backend's reader thread. Move
                # the cursor past all pre-command telemetry so an old asleep
                # frame cannot trip the active-run envelope guard.
                recent = api(f"logs?port={port}&since=0").get("logs", [])
                cursor = max((int(x["seq"]) for x in recent), default=cursor)
                cursor, rows = collect(port, cursor, .48, out, 2.10)
                item = metric(rows, target)
                metrics.append(item)
                record({"metrics": item})
                print(json.dumps(item, ensure_ascii=False), flush=True)
                command(port, "stop")
                time.sleep(.18)
            record({"complete": True, "metrics": metrics})
        finally:
            try:
                record({"cleanup_stop": command(port, "stop")})
                record({"cleanup_sleep": command(port, "sleep")})
            except Exception as exc:
                record({"cleanup_error": str(exc)})


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"COM23", "COM4"}:
        raise SystemExit("usage: current_loop_sweep_api.py COM23|COM4")
    run(sys.argv[1], Path(__file__).resolve().parents[1] / "evidence" / "current-loop" / (time.strftime("%Y%m%d-%H%M%S") + "-" + sys.argv[1] + ".jsonl"))
