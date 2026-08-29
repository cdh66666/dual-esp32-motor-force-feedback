from __future__ import annotations

import json
import math
import os
import re
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import serial
from serial.tools import list_ports


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("MOTOR_DEBUG_PORT", "8766"))


class PortSession:
    def __init__(self, port: str):
        self.port = port
        self.ser = None
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.monitor_thread = None
        self.monitor_stop = threading.Event()
        self.seq = 0
        self.logs = deque(maxlen=300)
        self.write_ok = False
        self.last_error = ""
        self.connected_at = 0.0
        self.last_rx_at = 0.0
        self.reader_alive = False

    def add_log(self, direction: str, text: str):
        fault_snapshot = None
        with self.lock:
            self.seq += 1
            self.logs.append({
                "seq": self.seq,
                "time": time.strftime("%H:%M:%S"),
                "direction": direction,
                "text": text,
            })
            if direction == "rx" and re.match(
                r"^(?:CASCADE (?:no_current_response|no_power_response|fault|bus_low|timeout)|ERR )",
                text,
            ):
                fault_snapshot = list(self.logs)
        if fault_snapshot:
            threading.Thread(
                target=self._write_fault_capture,
                args=(fault_snapshot, text),
                daemon=True,
            ).start()

    def _write_fault_capture(self, entries, reason: str):
        try:
            folder = ROOT.parent / "evidence" / "fault-captures"
            folder.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            path = folder / f"{stamp}-{self.port}.jsonl"
            header = {
                "capture": "motor-controller-fault",
                "port": self.port,
                "reason": reason,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }
            lines = [json.dumps(header, ensure_ascii=False)]
            lines.extend(json.dumps(entry, ensure_ascii=False) for entry in entries)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self.add_log("system", f"fault capture saved: {path.name}")
        except Exception as exc:
            self.add_log("error", f"fault capture failed: {exc}")

    def connect(self):
        with self.lifecycle_lock:
            if self.ser and self.ser.is_open and self.reader_alive:
                return
            if self.ser:
                try:
                    self.ser.close()
                except Exception:
                    pass
            ser = serial.Serial()
            ser.port = self.port
            ser.baudrate = 115200
            ser.bytesize = serial.EIGHTBITS
            ser.parity = serial.PARITY_NONE
            ser.stopbits = serial.STOPBITS_ONE
            ser.timeout = 0.05
            ser.write_timeout = 0.5
            ser.rtscts = False
            ser.dsrdtr = False
            # TinyUSB CDC follows the USB CDC contract and suppresses output
            # until the host asserts DTR. Keep RTS low so this is never the
            # ESP32 DTR/RTS download-reset combination. Hardware HWCDC boards
            # also tolerate DTR asserted with RTS low.
            ser.dtr = True
            ser.rts = False
            ser.open()
            # Events are per connection. Reusing and clearing the previous
            # Event could revive an old reader/monitor thread after reconnect,
            # leaving two threads competing for the new CDC stream.
            stop_event = threading.Event()
            monitor_stop = threading.Event()
            self.stop_event = stop_event
            self.monitor_stop = monitor_stop
            self.ser = ser
            self.write_ok = True
            self.last_error = ""
            self.connected_at = time.monotonic()
            self.last_rx_at = 0.0
            self.thread = threading.Thread(
                target=self._reader, args=(ser, stop_event), daemon=True
            )
            self.thread.start()
            self.monitor_thread = threading.Thread(
                target=self._monitor, args=(ser, monitor_stop), daemon=True
            )
            self.monitor_thread.start()
            self.add_log("system", "connected")

    def disconnect(self):
        with self.lifecycle_lock:
            self.stop_event.set()
            self.monitor_stop.set()
            ser = self.ser
            self.ser = None
            self.write_ok = False
            self.reader_alive = False
            # Close before allowing a new connect() to open the same Windows
            # COM device; otherwise rapid reconnect can race the old handle.
            if ser:
                try:
                    ser.close()
                except Exception:
                    pass
        self.add_log("system", "disconnected")

    def _reader(self, ser, stop_event):
        pending = bytearray()
        self.reader_alive = True
        try:
            while not stop_event.is_set():
                if not ser.is_open:
                    break
                try:
                    data = ser.read(256)
                except Exception as exc:
                    self.last_error = f"read: {exc}"
                    self.write_ok = False
                    self.add_log("error", self.last_error)
                    break
                if not data:
                    continue
                self.last_rx_at = time.monotonic()
                pending.extend(data)
                while b"\n" in pending:
                    raw, _, pending = pending.partition(b"\n")
                    text = raw.rstrip(b"\r").decode("utf-8", errors="replace")
                    self.add_log("rx", text)
        finally:
            if self.ser is ser:
                self.reader_alive = False
                self.add_log("system", "reader stopped")

    def send(self, command: str, expected_ser=None):
        line = command.strip()
        with self.write_lock:
            ser = self.ser
            if not ser or not ser.is_open:
                raise RuntimeError("port is not connected")
            if expected_ser is not None and ser is not expected_ser:
                raise RuntimeError("serial connection was replaced")
            try:
                ser.write((line + "\r\n").encode("utf-8"))
                self.write_ok = True
                self.last_error = ""
                self.add_log("tx", line)
            except Exception as exc:
                self.write_ok = False
                self.last_error = str(exc)
                self.add_log("error", f"write: {exc}")
                raise

    def _monitor(self, ser, monitor_stop):
        # The firmware emits compact SAMPLE frames at 100 Hz over native USB CDC.
        # Keep a slow status request as a compatibility fallback for older builds.
        # Native USB CDC can enumerate before its OUT endpoint is ready after
        # a reset. Give it a deterministic settling window so automatic page
        # reconnects do not race the device firmware.
        if monitor_stop.wait(1.0):
            return
        try:
            if self.ser is ser and ser.is_open:
                self.send("stream 100", expected_ser=ser)
                # Monitoring must never change actuator state. A delayed
                # unconditional WAKE used to reset the controller one second
                # after connection and cancel a command sent meanwhile. The UI
                # performs readiness immediately before the first motion.
                self.send("businfo", expected_ser=ser)
                self.send("model", expected_ser=ser)
        except Exception as exc:
            self.add_log("error", f"stream start: {exc}")
        while not monitor_stop.wait(1.0):
            try:
                if self.ser is ser and ser.is_open:
                    self.send("status", expected_ser=ser)
                else:
                    break
            except Exception as exc:
                self.add_log("error", f"monitor: {exc}")
                break

    def snapshot(self):
        with self.lock:
            return list(self.logs)

    def snapshot_since(self, since: int):
        with self.lock:
            current = list(self.logs)
        # The web page may survive a local server restart with an old, much
        # larger sequence number. Treat that as a new session so telemetry
        # resumes instead of remaining permanently empty.
        if current and since > current[-1]["seq"]:
            return current
        return [x for x in current if x["seq"] > since]


sessions: dict[str, PortSession] = {}
sessions_lock = threading.Lock()
usb_problem_lock = threading.Lock()
usb_problem_cache_at = 0.0
usb_problem_cache: list[dict] = []


def get_session(port: str) -> PortSession:
    with sessions_lock:
        if port not in sessions:
            sessions[port] = PortSession(port)
        return sessions[port]


def port_info():
    present = {item.device for item in list_ports.comports() if item.device}
    # Close stale handles after a physical unplug, but never report a missing
    # device as a synthetic "disconnected" port.
    with sessions_lock:
        stale_sessions = [session for port, session in sessions.items() if port not in present]
    for session in stale_sessions:
        if session.ser and session.ser.is_open:
            session.disconnect()
    result = []
    for item in list_ports.comports():
        if not item.device:
            continue
        session = sessions.get(item.device)
        now = time.monotonic()
        connected_age_ms = int(max(0.0, now - session.connected_at) * 1000) if session and session.connected_at else None
        rx_age_ms = int(max(0.0, now - session.last_rx_at) * 1000) if session and session.last_rx_at else None
        telemetry_ok = bool(session and session.reader_alive and rx_age_ms is not None and rx_age_ms < 2500)
        result.append({
            "port": item.device,
            "description": item.description,
            "hwid": item.hwid,
            "active": bool(sessions.get(item.device) and sessions[item.device].ser and sessions[item.device].ser.is_open),
            "write_ok": bool(sessions.get(item.device) and sessions[item.device].write_ok),
            "last_error": sessions[item.device].last_error if sessions.get(item.device) else "",
            "reader_alive": bool(session and session.reader_alive),
            "connected_age_ms": connected_age_ms,
            "rx_age_ms": rx_age_ms,
            "telemetry_ok": telemetry_ok,
            # Hardware USB-Serial/JTAG is PID 1001; TinyUSB CDC defaults to
            # PID 0002. Both are the same ESP32-S3 boards and must appear in
            # the live dashboard.
            "esp32": "VID:PID=303A:" in (item.hwid or "").upper(),
            "present": True,
        })
    return sorted(result, key=lambda x: x["port"])


def usb_problem_devices():
    """Return connected Windows PnP problem devices without inventing ports."""
    global usb_problem_cache_at, usb_problem_cache
    now = time.monotonic()
    with usb_problem_lock:
        # PnP problem enumeration launches pnputil and is much heavier than
        # the live serial-port list. Keep the port list real-time, but scan
        # problem devices at most once every five seconds.
        if now - usb_problem_cache_at < 5.0:
            return list(usb_problem_cache)
    if os.name != "nt":
        return []
    try:
        completed = subprocess.run(
            ["pnputil", "/enum-devices", "/problem", "43", "/connected"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1.5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    blocks = re.split(r"\r?\n\s*\r?\n", completed.stdout)
    problems = []
    for block in blocks:
        instance = re.search(r"^Instance ID:\s*(.+)$", block, re.MULTILINE | re.IGNORECASE)
        description = re.search(r"^Device Description:\s*(.+)$", block, re.MULTILINE | re.IGNORECASE)
        code = re.search(r"^Problem Code:\s*(\d+)", block, re.MULTILINE | re.IGNORECASE)
        if instance and code:
            problems.append({
                "instance_id": instance.group(1).strip(),
                "description": description.group(1).strip() if description else "PnP device problem",
                "code": int(code.group(1)),
            })
    with usb_problem_lock:
        usb_problem_cache = problems
        usb_problem_cache_at = time.monotonic()
        return list(usb_problem_cache)


def validate_command(command: str, _armed: bool = True):
    command = command.strip()
    safe = {"help", "status", "diag", "encoder", "encreset", "rawadc", "model", "businfo", "wake", "recover", "sleep", "stop", "led on", "led off", "decay slow", "decay fast", "pospid on", "pospid off", "pospid status", "cascade status", "sync off", "sync stop", "sync disarm", "sync status"}
    if command in safe:
        return command
    if command == "sync arm":
        return command
    busbaud = re.fullmatch(r"busbaud\s+(115200|250000|500000|750000|1000000)", command)
    if busbaud:
        return f"busbaud {busbaud.group(1)}"
    sync_position = re.fullmatch(
        r"sync\s+position\s+(\d{1,3})\s+" +
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+(\d{1,4})\s+(\d{1,5})",
        command,
    )
    if sync_position:
        peer, offset, duty, timeout = (
            int(sync_position.group(1)), float(sync_position.group(2)),
            int(sync_position.group(3)), int(sync_position.group(4)),
        )
        if not 1 <= peer <= 254 or not math.isfinite(offset) or abs(offset) > 36000:
            raise ValueError("invalid synchronized-position peer or offset")
        if not 12 <= duty <= 4095 or not 100 <= timeout <= 30000:
            raise ValueError("invalid synchronized-position duty or timeout")
        return f"sync position {peer} {offset:g} {duty} {timeout}"
    sync_force = re.fullmatch(
        r"sync\s+force\s+(\d{1,3})\s+" +
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+" * 4 +
        r"(\d{1,4})\s+(\d{1,5})(?:\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?",
        command,
    )
    if sync_force:
        peer = int(sync_force.group(1))
        stiffness, damping, reflection, limit = map(float, sync_force.groups()[1:5])
        duty, timeout = int(sync_force.group(6)), int(sync_force.group(7))
        offset = float(sync_force.group(8) or 0.0)
        if not 1 <= peer <= 254 or not all(math.isfinite(x) for x in (stiffness, damping, reflection, limit, offset)):
            raise ValueError("invalid force-feedback peer or parameter")
        if not 0 <= stiffness <= 1000 or not 0 <= damping <= 1000 or not 0 <= reflection <= 4:
            raise ValueError("force-feedback gain outside firmware range")
        if not 10 <= limit <= 4500 or not 12 <= duty <= 4095 or not 100 <= timeout <= 30000 or abs(offset) > 360:
            raise ValueError("force-feedback limit, duty, timeout or offset outside range")
        return f"sync force {peer} {stiffness:g} {damping:g} {reflection:g} {limit:g} {duty} {timeout} {offset:g}"
    busaddr = re.fullmatch(r"busaddr\s+([1-9]\d?|1\d\d|2[0-4]\d|25[0-4])", command)
    if busaddr:
        return f"busaddr {int(busaddr.group(1))}"
    bus = re.fullmatch(r"bus\s+(all|\d{1,3})\s+(.+)", command)
    if bus:
        destination, inner = bus.group(1), bus.group(2).strip()
        if destination != "all" and not 1 <= int(destination) <= 254:
            raise ValueError("bus address must be 1..254 or all")
        if destination == "all":
            if inner != "stop":
                raise ValueError("broadcast bus command only supports stop")
            return "bus all stop"
        if inner in {"ping", "status", "wake", "sleep", "stop"}:
            return f"bus {int(destination)} {inner}"
        if inner == "arm":
            return f"bus {int(destination)} arm"
        if inner == "disarm":
            return f"bus {int(destination)} disarm"
        normalized = validate_command(inner)
        if normalized.startswith(("pos ", "velocity ", "current ", "cw ", "ccw ", "identify start")):
            return f"bus {int(destination)} {normalized}"
        raise ValueError("unsupported bus command")
    step = re.fullmatch(r"setstep\s+([0-3])", command)
    if step:
        return f"setstep {step.group(1)}"
    direction = re.fullmatch(r"direction\s+(normal|invert)", command)
    if direction:
        return f"direction {direction.group(1)}"
    sense_polarity = re.fullmatch(r"sensepolarity\s+(normal|invert)", command)
    if sense_polarity:
        return f"sensepolarity {sense_polarity.group(1)}"
    pospid = re.fullmatch(
        r"pospid\s+set\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+"
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+"
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+"
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+"
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+"
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
        r"(?:\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))?",
        command,
    )
    if pospid:
        values = [float(x) for x in pospid.groups() if x is not None]
        if not all(math.isfinite(x) for x in values):
            raise ValueError("PID 参数必须是有限数字")
        kp, ki, kd, max_pwm, i_limit, deadband = values[:6]
        min_pwm = values[6] if len(values) == 7 else 205.0
        if not 0 <= kp <= 1000 or not 0 <= ki <= 1000 or not 0 <= kd <= 100:
            raise ValueError("PID 范围：Kp 0..1000，Ki 0..1000，Kd 0..100")
        if not 1 <= max_pwm <= 4095 or not 0 <= i_limit <= 100000 or not 0 <= deadband <= 36000 or not 0 <= min_pwm <= max_pwm:
            raise ValueError("PWM上限 1..4095，最小PWM 0..最大PWM，积分限幅 0..100000 °·s，死区 0..36000°")
        return "pospid set " + " ".join(f"{x:g}" for x in values)
    number = r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
    cascade_current = re.fullmatch(
        rf"cascade\s+current\s+{number}\s+{number}\s+{number}", command
    )
    if cascade_current:
        kp, ki, max_pwm = map(float, cascade_current.groups())
        if not all(math.isfinite(x) for x in (kp, ki, max_pwm)) or not (
            0 <= kp <= 5000 and 0 <= ki <= 100000 and 1 <= max_pwm <= 4095
        ):
            raise ValueError("电流环范围：Kp 0..5000，Ki 0..100000，最大 PWM 1..4095")
        return f"cascade current {kp:g} {ki:g} {max_pwm:g}"
    cascade_low_speed_current = re.fullmatch(
        rf"cascade\s+low_speed_current\s+{number}", command
    )
    if cascade_low_speed_current:
        current = float(cascade_low_speed_current.group(1))
        if not math.isfinite(current) or not 0 <= current <= 7:
            raise ValueError("低速电流下限范围：0..7 A；位置环接近目标或刹车时不会强制恒流")
        return f"cascade low_speed_current {current:g}"
    cascade_velocity = re.fullmatch(
        rf"cascade\s+velocity\s+{number}\s+{number}\s+{number}"
        rf"(?:\s+{number}(?:\s+{number}\s+{number})?)?", command
    )
    if cascade_velocity:
        values = [float(x) for x in cascade_velocity.groups() if x is not None]
        kp, ki, max_current = values[:3]
        friction = values[3] if len(values) >= 4 else 2.2
        current_slew = values[4] if len(values) >= 6 else 30.0
        brake_slew = values[5] if len(values) >= 6 else 30.0
        if not all(math.isfinite(x) for x in values) or not (
            0 <= kp <= 1 and 0 <= ki <= 1 and 0.05 <= max_current <= 7 and 0 <= friction <= 5
            and 0.1 <= current_slew <= 100 and 1 <= brake_slew <= 50
        ):
            raise ValueError("速度环范围：Kp/Ki 0..1，最大电流 0.05..7 A，摩擦前馈 0..5 A")
        return f"cascade velocity {kp:g} {ki:g} {max_current:g} {friction:g} {current_slew:g} {brake_slew:g}"
    cascade_position = re.fullmatch(
        rf"cascade\s+position\s+{number}\s+{number}\s+{number}\s+{number}\s+{number}"
        rf"(?:\s+{number}(?:\s+{number}(?:\s+{number})?)?)?",
        command,
    )
    if cascade_position:
        values = [float(x) for x in cascade_position.groups() if x is not None]
        kp, ki, kd, max_velocity, deadband = values[:5]
        min_velocity = values[5] if len(values) >= 6 else 2000.0
        acceleration = values[6] if len(values) >= 7 else 20000.0
        reverse_kd = values[7] if len(values) >= 8 else 1.0
        if not all(math.isfinite(x) for x in values) or not (
            0 <= kp <= 1000 and 0 <= ki <= 1000 and 0 <= kd <= 100
            and 1 <= max_velocity <= 60000 and 0 <= deadband <= 360
            and 0 <= min_velocity <= max_velocity
            and 1 <= acceleration <= 200000 and 0.1 <= reverse_kd <= 20
        ):
            raise ValueError("位置环范围：Kp/Ki 0..1000，Kd 0..100，速度 1..60000 °/s，死区 0..360°")
        return f"cascade position {kp:g} {ki:g} {kd:g} {max_velocity:g} {deadband:g} {min_velocity:g} {acceleration:g} {reverse_kd:g}"
    # The MT6701 unwraps the single-turn reading into a float accumulator in
    # the firmware. Keep the UI contract consistent at +/-100 turns.
    position = re.fullmatch(
        r"pos\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(\d{1,4})\s+(\d{1,5})",
        command,
    )
    if position:
        target = float(position.group(1))
        duty = int(position.group(2))
        timeout = int(position.group(3))
        if not 12 <= duty <= 4095 or not 100 <= timeout <= 30000:
            raise ValueError("position safe limit is duty 12..4095 (0..100%) and timeout 100..30000 ms")
        if not math.isfinite(target) or abs(target) > 36000:
            raise ValueError("position target must be -36000..36000 deg (+/-100 turns)")
        return f"pos {target:g} {duty} {timeout}"
    identify = re.fullmatch(r"identify\s+(on|off|reset|start)", command)
    if identify:
        return f"identify {identify.group(1)}"
    current = re.fullmatch(
        r"current\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(\d{1,4})\s+(\d{1,5})",
        command,
    )
    if current:
        target = float(current.group(1)); duty = int(current.group(2)); timeout = int(current.group(3))
        if not math.isfinite(target) or abs(target) > 7000 or not 12 <= duty <= 4095 or not 100 <= timeout <= 30000:
            raise ValueError("current target must be -7000..7000 mA; hardware regulation is about 5 A; duty 12..4095; timeout 100..30000 ms")
        return f"current {target:g} {duty} {timeout}"
    velocity = re.fullmatch(
        r"velocity\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(\d{1,4})\s+(\d{1,5})",
        command,
    )
    if velocity:
        target = float(velocity.group(1)); duty = int(velocity.group(2)); timeout = int(velocity.group(3))
        if not math.isfinite(target) or abs(target) > 60000 or not 12 <= duty <= 4095 or not 100 <= timeout <= 30000:
            raise ValueError("velocity target must be -60000..60000 deg/s; duty 12..4095; timeout 100..30000 ms")
        return f"velocity {target:g} {duty} {timeout}"
    stream = re.fullmatch(r"stream\s+(off|\d{1,3})", command)
    if stream:
        value = stream.group(1)
        if value != "off" and not 1 <= int(value) <= 100:
            raise ValueError("stream rate must be 1..100 Hz or off")
        return f"stream {value}"
    match = re.fullmatch(r"(cw|ccw)\s+(\d{1,4})\s+(\d{1,4})", command)
    if not match:
        raise ValueError("unsupported command")
    duty = int(match.group(2))
    duration = int(match.group(3))
    if not 0 <= duty <= 4095 or not 1 <= duration <= 1000:
        raise ValueError("safe limit is duty 0..4095 (0..100%) and time 1..1000 ms")
    return f"{match.group(1)} {duty} {duration}"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 100 Hz telemetry is intentionally polled incrementally. Avoid
        # printing every /api/logs and /api/ports request to the PTY because
        # console I/O can compete with the browser and serial reader.
        if self.path.startswith("/api/logs") or self.path.startswith("/api/ports"):
            return
        print(fmt % args)

    def send_json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if parsed.path == "/api/ports":
            return self.send_json({"ports": port_info(), "usb_problems": usb_problem_devices()})
        if parsed.path == "/api/logs":
            query = parse_qs(parsed.query)
            port = query.get("port", [""])[0]
            since = int(query.get("since", ["0"])[0])
            logs = get_session(port).snapshot_since(since)
            return self.send_json({"logs": logs})
        static_files = {
            "/": ("dashboard.html", "text/html; charset=utf-8"),
            "/index.html": ("dashboard.html", "text/html; charset=utf-8"),
            "/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
            "/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
            "/dashboard-cascade.css": ("dashboard-cascade.css", "text/css; charset=utf-8"),
        }
        if parsed.path in static_files:
            filename, content_type = static_files[parsed.path]
            data = (ROOT / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self.read_json()
            port = str(body.get("port", "")).upper()
            if parsed.path == "/api/connect":
                get_session(port).connect()
                return self.send_json({"ok": True, "port": port})
            if parsed.path == "/api/disconnect":
                get_session(port).disconnect()
                return self.send_json({"ok": True, "port": port})
            if parsed.path == "/api/send":
                command = validate_command(str(body.get("command", "")))
                get_session(port).send(command)
                return self.send_json({"ok": True, "command": command})
            self.send_error(404)
        except ValueError as exc:
            self.send_json({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)


if __name__ == "__main__":
    print(f"USB motor debug web: http://{HOST}:{PORT}")
    print("Limits: manual duty 0..4095 (0..100%) / 1..1000 ms; position target -36000..36000 deg (+/-100 turns); position duty 12..4095; timeout 100..30000 ms; no ARM gate; STOP is always available.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for session in sessions.values():
            session.disconnect()
        server.server_close()
