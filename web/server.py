from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import serial
from serial.tools import list_ports

# ``server.py`` is normally launched as a script (where ``web`` is on
# ``sys.path``), while a few offline tests import it as ``web.server`` or via
# an explicit module spec.  Keep both supported without requiring callers to
# mutate ``PYTHONPATH``.
try:
    from chain_gateway import ChainGateway, RemoteRejected
    from device_topology import DeviceTopology
    import recorder
except ModuleNotFoundError:
    _WEB_DIR = str(Path(__file__).resolve().parent)
    if _WEB_DIR not in sys.path:
        sys.path.insert(0, _WEB_DIR)
    from chain_gateway import ChainGateway, RemoteRejected
    from device_topology import DeviceTopology
    import recorder


ROOT = Path(__file__).resolve().parent
topology = DeviceTopology(ROOT / 'device_ids.local.json')
HOST = "127.0.0.1"
PORT = int(os.environ.get("MOTOR_DEBUG_PORT", "8766"))


def recovery_usb(identity):
    """Project uses TinyUSB; colon-form MAC denotes hardware USB transport.

    This identifies transport, not a solder fault or proof of ROM execution.
    Hardware-CDC diagnostic builds also use this transport.
    """
    return bool(identity and identity.vid == 0x303A and identity.pid == 0x1001
                and re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}',
                                 identity.serial_number or ''))


class ControllerFault(RuntimeError):
    """A real board rejection is not a USB transport failure."""


def error_kind(exc):
    if isinstance(exc, (ControllerFault, RemoteRejected)): return "controller"
    if isinstance(exc, ValueError): return "validation"
    if "STOP" in str(exc) or "排队期间" in str(exc): return "cancelled"
    return "transport"


def command_reply_prefix(command: str):
    if command.startswith('busaddr '): return 'OK busaddr='
    if command == 'wifi status': return 'WIFI '
    exact = {"stop": "OK stop", "wake": "OK driver_awake=1",
             "sleep": "OK driver_awake=0", "recover": "OK recovered power_path_fault=0",
             "status": "STATUS ", "diag": "DIAG ", "model": "MODEL fw=", "motorprofile status": "MOTOR_PROFILE ",
             "cascade status": "CASCADE_CFG ", "encreset": "OK encoder_rebase",
             "encoder": "ENCODER ", "rawadc": "ADC ", "businfo": "BUS addr=",
             "sync status": "SYNC ",
             "knob status": "KNOB_CFG ", "knob stop": "OK knob_stop",
             "sync off": "OK sync=off", "sync stop": "OK sync=off",
             "sync disarm": "OK sync_disarmed", "sync arm": "OK sync_armed"}
    if command in exact:
        return exact[command]
    if command.startswith('trace arm '): return 'OK trace_armed '
    if command == 'trace dump': return 'TRACE_META '
    if command.startswith('knob start '): return 'OK knob_start token=' + command.split()[2] + ' '
    if command.startswith('knob keep '): return 'OK knob_keep token=' + command.split()[2] + ' '
    for verb, prefix in (("pos ", "OK model_position "), ("posout ", "OK model_position "),
                         ("knob start ", "OK knob_start "), ("knob keep ", "OK knob_keep"),
                         ("knob config ", "OK knob_config"), ("velocity ", "OK model_velocity "),
                         ("current ", "OK model_current "), ("cw ", "OK motion=cw"),
                         ("ccw ", "OK motion=ccw"), ("cascade ", "OK cascade_"),
                         ("motorset ", "OK motorset "),
                         ("motorprofile ", "OK motorprofile="), ("stream ", "OK stream="),
                         ("direction ", "OK direction="), ("sensepolarity ", "OK sensepolarity="),
                         ("setstep ", "OK step="), ("decay ", "OK decay="), ("led ", "OK led="),
                         ("sync position ", "OK sync_config mode=position"),
                         ("sync force ", "OK sync_config mode=force")):
        if command.startswith(verb):
            if verb == "cascade ":
                return prefix + command.split()[1]
            return prefix
    return None


class PortSession:
    def __init__(self, port: str):
        self.port = port
        self.chain = ChainGateway(self)
        self.ser = None
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        # Keep Windows CDC data-plane operations mutually exclusive. A short
        # read wait preserves command latency without overlapping ReadFile /
        # ClearCommError with WriteFile on this native-USB transport.
        self.io_lock = threading.Lock()
        self.ack_lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.session_id = uuid.uuid4().hex
        self.command_epoch = 0
        self.lifecycle_lock = threading.Lock()
        self.monitor_thread = None
        self.monitor_stop = threading.Event()
        self.seq = 0
        self.logs = deque(maxlen=2000)
        self.write_ok = False
        self.last_error = ""
        self.last_ack_error = ""
        self.last_ack_at = 0.0
        self.connected_at = 0.0
        self.last_rx_at = 0.0
        self.last_sample_at = 0.0
        self.reader_alive = False
        self.missing_since = 0.0
        self.recover_lock = threading.Lock()
        self.capture_at = 0.0
        self.last_capture_reason = ""
        self.maintenance_until = 0.0
        self.phone_control = False

    def add_log(self, direction: str, text: str, *, capture=True):
        fault_snapshot = None
        with self.lock:
            self.seq += 1
            self.logs.append({
                "seq": self.seq,
                "time": time.strftime("%H:%M:%S"),
                "direction": direction,
                "text": text,
                "session_id": self.session_id,
            })
            self.changed.notify_all()
            is_fault = direction == "rx" and re.match(
                r"^(?:CASCADE (?:no_current_response|no_power_response|fault|bus_low)|ERR )",
                text,
            )
            is_link_fault = direction == "error" or (direction == "system" and text.startswith("link stalled"))
            capture_key = "link" if is_link_fault else text
            if capture and (is_fault or is_link_fault) and (
                capture_key != self.last_capture_reason or time.monotonic() - self.capture_at > 30
            ):
                self.capture_at = time.monotonic()
                self.last_capture_reason = capture_key
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
            stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1000000000:09d}"
            path = folder / f"{stamp}-{self.port}.jsonl"
            header = {
                "capture": "motor-controller-fault",
                "port": self.port,
                "reason": reason,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "session_id": entries[-1].get('session_id', self.session_id) if entries else self.session_id,
                "rx_age_ms": int((time.monotonic()-self.last_rx_at)*1000) if self.last_rx_at else None,
            }
            lines = [json.dumps(header, ensure_ascii=False)]
            lines.extend(json.dumps(entry, ensure_ascii=False) for entry in entries)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self.add_log("system", f"fault capture saved: {path.name}")
        except Exception as exc:
            self.add_log("error", f"fault capture failed: {exc}", capture=False)

    def connect(self):
        with self.lifecycle_lock:
            if self.phone_control:
                raise RuntimeError("控制权已交给手机，请点击接回电脑")
            if time.monotonic() < self.maintenance_until:
                raise RuntimeError("串口处于烧录维护中，暂不自动连接")
            # A newly opened handle can briefly precede the reader thread's
            # first scheduling turn. Treat the open handle as the connection
            # owner during that window; otherwise the 1 Hz port poll can call
            # connect() a second time and replace the reader underneath it.
            if self.ser and self.ser.is_open:
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
            ser.timeout = 0.002
            ser.write_timeout = 0.5
            ser.rtscts = False
            ser.dsrdtr = False
            # Keep the legacy, proven ESP32 USB-serial line state at open:
            # DTR=0/RTS=0 avoids the auto-reset/download combination. If a
            # TinyUSB build requires DTR, _monitor performs one adaptive
            # assertion only after the initial stream request gets no RX.
            identity = next((p for p in list_ports.comports() if p.device == self.port), None)
            if recovery_usb(identity):
                raise RuntimeError("设备处于 USB 恢复/调试接口，不能当作正常电机端口连接")
            tinyusb = bool(identity and identity.vid == 0x303A and
                           identity.serial_number and ':' not in identity.serial_number)
            ser.dtr = tinyusb
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
            self.command_epoch += 1
            with self.changed:
                self.session_id = uuid.uuid4().hex
                self.changed.notify_all()
            # A reconnect owns a new epoch/session.  Do not let DATA metadata
            # or an old remote-awake hint leak into the new USB handle.
            self.chain.invalidate_cache()
            self.write_ok = True
            self.last_error = ""
            self.last_ack_error = ""
            self.last_ack_at = 0.0
            self.connected_at = time.monotonic()
            self.last_rx_at = 0.0
            self.last_sample_at = 0.0
            self.reader_alive = False
            self.missing_since = 0.0
            self.thread = threading.Thread(
                target=self._reader, args=(ser, stop_event), daemon=True
            )
            self.thread.start()
            self.monitor_thread = threading.Thread(
                target=self._monitor, args=(ser, monitor_stop), daemon=True
            )
            self.monitor_thread.start()
            self.add_log("system", "connected")

    def recover_link(self):
        # Explicit recovery only; never resume any motion or reset the driver.
        if not self.recover_lock.acquire(blocking=False):
            raise RuntimeError("链路恢复正在进行")
        try:
            if (self.last_rx_at and time.monotonic() - self.last_rx_at < 1 and
                    self.reader_alive and self.write_ok and not self.last_error):
                try:
                    self.send_checked("stop")
                    return {"reconnected": False, "reply": self.send_checked("status")}
                except (OSError, TimeoutError, serial.SerialException) as exc:
                    # IN telemetry can remain healthy while OUT is wedged.
                    # A failed STOP/status probe must reach explicit reopen,
                    # not keep returning "healthy" based on one direction.
                    self.add_log("system", "link stalled; bidirectional probe failed: " + str(exc))
            self.add_log("system", "link stalled; explicit recovery requested")
            try: self.send("stop")
            except Exception: pass
            self.disconnect("explicit link recovery")
            self.connect()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if self.last_rx_at:
                    self.send_checked("stop")
                    return {"reconnected": True, "reply": self.send_checked("status")}
                time.sleep(.05)
            raise TimeoutError("端口仍在，但重开后无回包；已记录日志，未自动启动电机")
        finally:
            self.recover_lock.release()

    def disconnect(self, reason="manual", expected_ser=None):
        with self.lifecycle_lock:
            if expected_ser is not None and self.ser is not expected_ser:
                return
            self.stop_event.set()
            self.monitor_stop.set()
            ser = self.ser
            self.ser = None
            self.command_epoch += 1
            self.chain.invalidate_cache()
            self.write_ok = False
            self.reader_alive = False
            # Close before allowing a new connect() to open the same Windows
            # COM device; otherwise rapid reconnect can race the old handle.
            if ser:
                try:
                    ser.close()
                except Exception:
                    pass
            with self.changed:
                self.changed.notify_all()
        suffix = "" if reason == "manual" else f" ({reason})"
        self.add_log("system", "disconnected" + suffix)

    def health(self):
        # Take one coherent snapshot; a reader may close self.ser at any time.
        with self.lifecycle_lock:
            now = time.monotonic()
            def age(stamp):
                return int(max(0., now-stamp)*1000) if stamp else None
            sample_age = age(self.last_sample_at)
            return {"active": bool(self.ser and self.ser.is_open),
                    "write_ok": self.write_ok, "last_error": self.last_error,
                    "reader_alive": self.reader_alive,
                    "connected_age_ms": age(self.connected_at),
                    "rx_age_ms": age(self.last_rx_at), "sample_age_ms": sample_age,
                    "telemetry_ok": bool(self.reader_alive and sample_age is not None and sample_age < 2500),
                    "maintenance": now < self.maintenance_until or self.phone_control,
                    "phone_control": self.phone_control,
                    "last_ack_error": self.last_ack_error, "ack_age_ms": age(self.last_ack_at),
                    "io_serialized": True, "read_timeout_ms": 2}

    def _reader(self, ser, stop_event):
        pending = bytearray()
        with self.lifecycle_lock:
            if self.ser is not ser or stop_event.is_set():
                return
            self.reader_alive = True
        try:
            while not stop_event.is_set():
                if not ser.is_open:
                    break
                try:
                    # A telemetry frame is shorter than 256 bytes. Waiting
                    # for a fixed block batches 2-3 100 Hz frames and delayed
                    # ACKs, reducing visible redraws to about 35 fps.
                    with self.io_lock:
                        data = ser.read(min(4096, max(1, ser.in_waiting)))
                except Exception as exc:
                    with self.lifecycle_lock:
                        if self.ser is ser and not stop_event.is_set():
                            self.last_error = f"read: {exc}"
                            self.write_ok = False
                            self.add_log("error", self.last_error)
                    break
                if not data:
                    continue
                # read() can return *after* disconnect/reconnect. Old bytes
                # and old exceptions must not overwrite the new session.
                with self.lifecycle_lock:
                    if self.ser is not ser:
                        break
                    self.last_rx_at = time.monotonic()
                    pending.extend(data)
                    if len(pending) > 65536:
                        pending.clear()
                        self.add_log("error", "serial frame exceeds 64 KiB; discarded")
                        continue
                    while b"\n" in pending:
                        raw, _, pending = pending.partition(b"\n")
                        text = raw.rstrip(b"\r").decode("utf-8", errors="replace")
                        if text.startswith("S,"):
                            try:
                                values = [float(v) for v in text.split(',')[1:]]
                                if len(values) >= 13 and all(math.isfinite(v) for v in values):
                                    self.last_sample_at = self.last_rx_at
                            except ValueError:
                                pass
                        self.add_log("rx", text)
        finally:
            # Windows can invalidate an open-looking handle after the MCU
            # re-enumerates. Do not leave active=True forever while its reader
            # has died. A later connect is fresh and never restores a target.
            unexpected = not stop_event.is_set()
            with self.lifecycle_lock:
                owned = self.ser is ser
                if owned:
                    self.reader_alive = False
                    if unexpected:
                        stop_event.set()
                        self.monitor_stop.set()
                        self.ser = None
                        self.write_ok = False
                        self.command_epoch += 1
                        try: ser.close()
                        except Exception: pass
            if owned:
                self.add_log("system", "reader stopped; invalid handle closed" if unexpected else "reader stopped")

    def send(self, command: str, expected_ser=None, expected_epoch=None, expected_session_id=None):
        line = command.strip()
        with self.write_lock, self.lifecycle_lock:
            if getattr(self,'id_config_owner',None) not in (None,threading.get_ident()) and line not in {'stop','sleep','sync off','status'}:
                raise RuntimeError('正在配置设备 ID，本次操作未发送')
            if self.phone_control and line not in {"stop", "sync off", "sleep", "status"}:
                raise RuntimeError("控制权已交给手机，电脑动作未发送")
            ser = self.ser
            if not ser or not ser.is_open:
                raise RuntimeError("port is not connected")
            if expected_ser is not None and ser is not expected_ser:
                raise RuntimeError("serial connection was replaced")
            if expected_epoch is not None and expected_epoch != self.command_epoch:
                raise RuntimeError("排队命令已被 STOP 或会话变更取消")
            if expected_session_id and expected_session_id != self.session_id:
                raise RuntimeError("排队期间串口会话已变化，旧页面命令未发送")
            if line in {"stop", "knob stop"}:
                self.command_epoch += 1
            try:
                payload = (line + "\r\n").encode("utf-8")
                with self.io_lock:
                    written = ser.write(payload)
                if written != len(payload):
                    raise serial.SerialTimeoutException(
                        f"串口写入不完整 {written}/{len(payload)} 字节；未重发命令")
                # A completed Windows write is not a board acknowledgement.
                # Background STATUS probes must not hide a known OUT stall.
                self.write_ok = not self.last_ack_error
                self.last_error = self.last_ack_error
                self.add_log("tx", line)
            except Exception as exc:
                self.write_ok = False
                self.last_error = str(exc)
                self.add_log("error", f"write: {exc}")
                raise

    def send_checked(self, command: str, timeout=1.5, expected_session_id=None):
        prefix = command_reply_prefix(command)
        if prefix is None:
            raise ValueError("该命令未配置执行回执校验: " + command)
        with self.lifecycle_lock:
            if expected_session_id and expected_session_id != self.session_id:
                raise RuntimeError("排队期间串口会话已变化，旧页面命令未发送")
            queued_epoch = self.command_epoch
            queued_ser = self.ser
            if not queued_ser or not queued_ser.is_open:
                raise RuntimeError("port is not connected")
        # STOP has its own path so a missing reply can never delay the stop
        # byte behind another command's 1.5-second acknowledgement deadline.
        if command in {"stop", "knob stop"}:
            return self._send_and_wait(command, prefix, timeout, queued_ser, queued_epoch)
        if not self.ack_lock.acquire(timeout=timeout):
            raise RuntimeError("排队期间等待过久，命令已取消且未发送")
        try:
            if queued_epoch != self.command_epoch:
                raise RuntimeError("排队命令已被 STOP 取消")
            if queued_ser is not self.ser:
                raise RuntimeError("排队期间串口会话已变化，旧命令未发送")
            return self._send_and_wait(command, prefix, timeout, queued_ser, queued_epoch)
        finally:
            self.ack_lock.release()

    def _send_and_wait(self, command, prefix, timeout, queued_ser=None, queued_epoch=None):
        with self.lock:
            cursor = self.seq
        ser = queued_ser if queued_ser is not None else self.ser
        epoch = queued_epoch if queued_epoch is not None else self.command_epoch
        self.send(command, expected_ser=ser,
                  expected_epoch=None if command in {"stop", "knob stop"} else epoch)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ser is not ser or not ser or not ser.is_open:
                raise RuntimeError("等待板端回执时 USB 会话已断开")
            if command not in {"stop", "knob stop"} and epoch != self.command_epoch:
                raise RuntimeError("命令已被 STOP 取消")
            matched = None
            with self.changed:
                for entry in self.logs:
                    if entry["seq"] <= cursor or entry["direction"] != "rx":
                        continue
                    text = entry["text"]
                    if text.startswith("ERR ") or re.match(r"CASCADE (fault|no_power_response|no_current_response)", text):
                        raise ControllerFault(text)
                    if text.startswith(prefix):
                        matched = text
                        break
                if matched is None:
                    self.changed.wait(min(0.05, max(0.0, deadline - time.monotonic())))
            if matched is not None:
                # Do not acquire lifecycle_lock while holding changed: close
                # takes them in the opposite order. Also reject a late ACK
                # if reconnect replaced the handle while logs were scanned.
                with self.lifecycle_lock:
                    if self.ser is not ser:
                        raise RuntimeError("回执到达时 USB 会话已变化")
                    self.last_ack_at = time.monotonic()
                    self.last_ack_error = ""
                    self.write_ok = True
                    self.last_error = ""
                return matched
        # Delivery could have succeeded even though its reply was lost. Do not
        # leave an uncertain motor command active until its full lease expires.
        if command.split()[0] in {"pos", "posout", "knob", "velocity", "current", "cw", "ccw", "wake"}:
            try:
                self.send("stop", expected_ser=ser)
            except Exception:
                pass
        with self.lifecycle_lock:
            if self.ser is ser:
                self.last_ack_error = "板端回执超时: " + command
                self.last_error = self.last_ack_error
                self.write_ok = False
        self.add_log("system", "link stalled; ACK timeout for " + command)
        raise TimeoutError("已写入串口，但板端未确认执行：" + command)

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
                # A newly opened CDC handle must never inherit an actuator
                # lease from the previous host/session.  The firmware STOP is
                # idempotent and clears position/velocity/current/force state
                # without waking the bridge.  Send it before telemetry probes
                # so a reconnect cannot resume a stale target while the page
                # is still rebuilding its session state.
                self.send("stop", expected_ser=ser)
                self.send("stream 100", expected_ser=ser)
                # Monitoring must never change actuator state. A delayed
                # unconditional WAKE used to reset the controller one second
                # after connection and cancel a command sent meanwhile. The UI
                # performs readiness immediately before the first motion.
                self.send("businfo", expected_ser=ser)
                self.send("model", expected_ser=ser)
                self.send("motorprofile status", expected_ser=ser)
        except Exception as exc:
            self.add_log("error", f"stream start: {exc}")
        # Some TinyUSB CDC builds expose the port before reporting DTR. Give
        # the old HWCDC path first chance, then assert DTR once if no bytes
        # have arrived. This avoids a reset on every ordinary reconnect while
        # still recovering boards that require a connected CDC host.
        if not monitor_stop.wait(0.75):
            try:
                if self.ser is ser and ser.is_open and self.last_rx_at <= 0.0:
                    ser.dtr = True
                    self.send("stream 100", expected_ser=ser)
                    self.send("model", expected_ser=ser)
                    self.send("motorprofile status", expected_ser=ser)
                    self.send("cascade status", expected_ser=ser)
            except Exception as exc:
                self.add_log("error", f"CDC DTR fallback: {exc}")
        next_fallback_status = time.monotonic() + 2.0
        stalled_reported = False
        while not monitor_stop.wait(1.0):
            try:
                if self.ser is ser and ser.is_open:
                    # Once SAMPLE frames are flowing, periodic STATUS adds
                    # traffic and can contend with the high-rate CDC stream.
                    # Keep it only as a compatibility fallback for firmware
                    # that did not start streaming after connect().
                    now = time.monotonic()
                    no_recent_rx = (
                        self.last_rx_at <= 0.0 or now - self.last_rx_at > 2.0
                    )
                    if no_recent_rx and now >= next_fallback_status:
                        if not stalled_reported and now - self.connected_at > 5:
                            self.add_log("system", "link stalled; no receive data for over 2 seconds")
                            stalled_reported = True
                        self.send("status", expected_ser=ser)
                        next_fallback_status = now + 2.0
                    if not no_recent_rx:
                        stalled_reported = False
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

    def payload_since(self, since):
        with self.lock:
            # A negative `since` means "I only want the cursor".  Callers that
            # poll the log to measure something (rather than to display it) must
            # be able to learn where the log ends WITHOUT dragging the entire
            # buffer across USB; that buffer grows all session, so a poller that
            # starts from 0 gets slower and slower until it stalls the test.
            if since < 0:
                return {"session_id": self.session_id, "logs": [], "seq": self.seq}
            if since > self.seq: since = 0
            return {"session_id": self.session_id, "seq": self.seq,
                    "logs": [x for x in self.logs if x['seq'] > since and x['session_id'] == self.session_id]}


sessions: dict[str, PortSession] = {}
sessions_lock = threading.Lock()
usb_problem_lock = threading.Lock()
usb_problem_scan_lock = threading.Lock()
usb_problem_cache_at = 0.0
usb_problem_cache: list[dict] = []


def get_session(port: str) -> PortSession:
    with sessions_lock:
        if port not in sessions:
            sessions[port] = PortSession(port)
        return sessions[port]


def port_info():
    items = [item for item in list_ports.comports() if item.device]
    present = {item.device for item in items}
    now = time.monotonic()
    # Windows can briefly omit a native USB CDC device during enumeration.
    # Do not close a live handle on one missed poll; require a sustained
    # absence before treating it as a physical unplug.
    with sessions_lock:
        sessions_snapshot = list(sessions.items())
    stale_sessions = []
    for port, session in sessions_snapshot:
        with session.lifecycle_lock:
            if port in present:
                session.missing_since = 0.0
            elif session.ser and session.ser.is_open:
                if session.missing_since <= 0.0:
                    session.missing_since = now
                elif now - session.missing_since >= 2.5:
                    stale_sessions.append((session, session.ser))
    for session, ser in stale_sessions:
        session.disconnect("device absent >2.5s", expected_ser=ser)
    result = []
    for item in items:
        session = dict(sessions_snapshot).get(item.device)
        health = session.health() if session else {
            "active": False, "write_ok": False, "last_error": "", "reader_alive": False,
            "connected_age_ms": None, "rx_age_ms": None, "sample_age_ms": None,
            "telemetry_ok": False, "maintenance": False}
        result.append({
            "port": item.device,
            "description": item.description,
            "hwid": item.hwid,
            **health,
            # Hardware USB-Serial/JTAG is PID 1001; TinyUSB CDC defaults to
            # PID 0002. Both are the same ESP32-S3 boards and must appear in
            # the live dashboard.
            "esp32": "VID:PID=303A:" in (item.hwid or "").upper(),
            "recovery_usb": recovery_usb(item),
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
    # Five tabs must not launch five simultaneous PnP scans. Other callers
    # use the last completed scan while the sole scan is in progress.
    if not usb_problem_scan_lock.acquire(blocking=False):
        with usb_problem_lock:
            return list(usb_problem_cache)
    try:
        completed = subprocess.run(
            ["pnputil", "/enum-devices", "/problem", "43", "/connected"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1.5,
        )
        blocks = re.split(r"\r?\n\s*\r?\n", completed.stdout)
        problems = []
        for block in blocks:
            instance = re.search(r"^(?:Instance ID|实例 ID):\s*(.+)$", block, re.MULTILINE | re.IGNORECASE)
            description = re.search(r"^(?:Device Description|设备描述):\s*(.+)$", block, re.MULTILINE | re.IGNORECASE)
            code = re.search(r"^(?:Problem Code|问题代码):\s*(\d+)", block, re.MULTILINE | re.IGNORECASE)
            if instance and code:
                problems.append({
                    "instance_id": instance.group(1).strip(),
                    "description": description.group(1).strip() if description else "PnP device problem",
                    "code": int(code.group(1)),
                })
        with usb_problem_lock:
            usb_problem_cache = problems
    except (OSError, subprocess.SubprocessError):
        pass  # Preserve the last scan, but throttle failed scans too.
    finally:
        with usb_problem_lock:
            usb_problem_cache_at = time.monotonic()
        usb_problem_scan_lock.release()
    with usb_problem_lock:
        return list(usb_problem_cache)


def validate_command(command: str, _armed: bool = True):
    if command == 'wifi status': return command
    if not isinstance(command, str) or len(command) > 127 or any(
        ord(c) < 32 and c != '\t' or ord(c) > 126 for c in command
    ):
        raise ValueError("命令必须是单行 ASCII 文本，且不超过 127 字节")
    command = command.strip()
    if command in {"knob status", "knob stop"}: return command
    if command.startswith("knob "):
        parts = command.split()
        if len(parts) == 3 and parts[1] in {"start", "keep"} and parts[2].isdigit() and 1 <= int(parts[2]) <= 1000000000:
            return f"knob {parts[1]} {int(parts[2])}"
        if len(parts) == 7 and parts[1] == "config":
            effect, spacing, peak, damping, width = map(float, parts[2:])
            if (all(math.isfinite(x) for x in (effect, spacing, peak, damping, width)) and
                effect in (0, 1, 2, 3) and 2 <= spacing <= 90 and 0 <= peak <= 600 and
                0 <= damping <= 10 and spacing <= width <= 720):
                return "knob config " + " ".join(f"{v:g}" for v in (effect, spacing, peak, damping, width))
        raise ValueError("旋钮参数无效：模式0..3，输出轴间距2..90°，强度0..600 mA，阻尼0..10 mA/(°/s)，范围间距..720°")
    safe = {"help", "status", "diag", "encoder", "encreset", "rawadc", "model", "motorprofile status", "businfo", "wake", "recover", "sleep", "stop", "led on", "led off", "led auto", "decay slow", "decay fast", "pospid on", "pospid off", "pospid status", "cascade status", "sync off", "sync stop", "sync disarm", "sync status",
            # Firmware-side diagnostics.  The whitelist silently swallowed these
            # once, which looked exactly like "the firmware ignored the command".
            "cost", "gapclear"}
    if command in safe:
        return command
    if command in {"cascade hold on", "cascade hold off"}:
        return command
    # Re-time the encoder I2C bus on a live board so the transaction-time vs
    # bit-error trade can be A/B tested without a reflash.
    i2c_clock = re.fullmatch(r"i2cclk\s+(\d{6,7})", command)
    if i2c_clock:
        hz = int(i2c_clock.group(1))
        if not 100000 <= hz <= 1000000:
            raise ValueError("编码器 I2C 时钟范围：100000..1000000 Hz")
        return f"i2cclk {hz}"
    if command == 'trace dump': return command
    if re.fullmatch(r'trace arm (?:[1-9][0-9]{1,2}|10[01][0-9]|102[0-4])', command):
        return command
    if command == "sync arm":
        return command
    motor_profile = re.fullmatch(r"motorprofile\s+(775|25ga370|36gp555)", command)
    if motor_profile:
        return f"motorprofile {motor_profile.group(1)}"
    motor_settings = re.fullmatch(r"motorset\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)", command)
    if motor_settings:
        voltage, current, gear = map(float, motor_settings.groups())
        if not all(math.isfinite(x) for x in (voltage, current, gear)) or not (
                3 <= voltage <= 24 and .1 <= current <= 7 and 1 <= gear <= 1000):
            raise ValueError("motor settings outside supported envelope")
        return f"motorset {voltage:g} {current:g} {gear:g}"
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
        if not 10 <= limit <= 4500 or not 12 <= duty <= 4095 or not 100 <= timeout <= 30000 or abs(offset) > 36000:
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
        if inner in {"ping", "status", "wake", "sleep", "stop", "recover"}:
            return f"bus {int(destination)} {inner}"
        if inner == "arm":
            return f"bus {int(destination)} arm"
        if inner == "disarm":
            return f"bus {int(destination)} disarm"
        normalized = validate_command(inner)
        if normalized.startswith(("pos ", "velocity ", "current ", "cw ", "ccw ", "identify start")):
            return f"bus {int(destination)} {normalized}"
        raise ValueError("unsupported bus command")
    if command.startswith('cascade cogging '):
        parts=command.split()
        if parts[2:] in (['clear'],['save']): return command
        if len(parts)==6 and parts[2] in {'harmonic','enable'}:
            a,b,c=map(float,parts[3:])
            valid=all(math.isfinite(v) for v in (a,b,c))
            if parts[2]=='harmonic': valid=valid and a.is_integer() and 1<=a<=18 and abs(b)<=.4 and abs(c)<=.4
            else: valid=valid and 0<=a<=1.2 and 0<=b<=.3 and abs(c)<=.1
            if valid: return f'cascade cogging {parts[2]} {a:g} {b:g} {c:g}'
        raise ValueError('invalid bounded cogging calibration parameters')
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
    if command == "cascade electrical":
        return command
    if command == "cascade save_outer":
        return command  # Firmware requires STOP + sleep before NVS writes.
    electrical = re.fullmatch(
        rf"cascade\s+electrical\s+{number}\s+{number}\s+{number}\s+{number}\s+{number}", command
    )
    if electrical:
        r, ke, kp, ki, limit = map(float, electrical.groups())
        if not all(math.isfinite(x) for x in (r, ke, kp, ki, limit)) or not (
            .05 <= r <= 20 and .0001 <= ke <= .2 and
            0 <= kp <= 5000 and 0 <= ki <= 2000000 and 1 <= limit <= 4095
        ):
            raise ValueError("成组电气参数超出固件范围")
        return "cascade electrical " + " ".join(format(x, '.9g') for x in (r, ke, kp, ki, limit))
    cascade_current = re.fullmatch(
        rf"cascade\s+current\s+{number}\s+{number}\s+{number}", command
    )
    if cascade_current:
        kp, ki, max_pwm = map(float, cascade_current.groups())
        if not all(math.isfinite(x) for x in (kp, ki, max_pwm)) or not (
            0 <= kp <= 5000 and 0 <= ki <= 2000000 and 1 <= max_pwm <= 4095
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
        rf"(?:\s+{number}(?:\s+{number}(?:\s+{number})?)?)?", command
    )
    if cascade_velocity:
        values = [float(x) for x in cascade_velocity.groups() if x is not None]
        kp, ki, max_current = values[:3]
        friction = values[3] if len(values) >= 4 else 0.0
        current_slew = values[4] if len(values) >= 5 else 1.0
        brake_slew = values[5] if len(values) >= 6 else 1.0
        if not all(math.isfinite(x) for x in values) or not (
            0 <= kp <= 1 and 0 <= ki <= 1 and 0.05 <= max_current <= 7 and 0 <= friction <= 5
            and 0.1 <= current_slew <= 20000 and 1 <= brake_slew <= 50
        ):
            raise ValueError(
                "速度环范围：Kp/Ki 0..1，最大电流 0.05..7 A，摩擦前馈 0..5 A，"
                "电流斜率 0.1..20000 A/s（>=5000 表示直接给，不做缓启动）")
        # Omitted parameters belong to the board's active motor profile.
        return "cascade velocity " + " ".join(f"{x:g}" for x in values)
    cascade_position = re.fullmatch(
        rf"cascade\s+position\s+{number}\s+{number}\s+{number}\s+{number}\s+{number}"
        rf"(?:\s+{number}(?:\s+{number}(?:\s+{number})?)?)?",
        command,
    )
    if cascade_position:
        values = [float(x) for x in cascade_position.groups() if x is not None]
        kp, ki, kd, max_velocity, deadband = values[:5]
        min_velocity = values[5] if len(values) >= 6 else 0.0
        acceleration = values[6] if len(values) >= 7 else 1.0
        reverse_kd = values[7] if len(values) >= 8 else 1.0
        if not all(math.isfinite(x) for x in values) or not (
            0 <= kp <= 1000 and 0 <= ki <= 1000 and 0 <= kd <= 100
            and 1 <= max_velocity <= 60000 and 0 <= deadband <= 360
            and 0 <= min_velocity <= max_velocity
            and 1 <= acceleration <= 100000 and 0.1 <= reverse_kd <= 5
        ):
            raise ValueError("位置环范围：Kp/Ki 0..1000，Kd 0..100，速度 1..60000 °/s，死区 0..360°")
        return "cascade position " + " ".join(f"{x:g}" for x in values)
    for name, bounds, minimum in (
        ("breakaway", [(0, 5), (1, 500), (5, 1000), (1, 500), (0.1, 400)], 4),
        ("trajectory", [(1, 60000), (1, 100000), (10, 1000000), (0.2, 20)], 4),
    ):
        if command.startswith("cascade " + name + " "):
            values = [float(x) for x in command.split()[2:]]
            if not minimum <= len(values) <= len(bounds) or any(
                not math.isfinite(x) or not lo <= x <= hi
                for x, (lo, hi) in zip(values, bounds)
            ):
                raise ValueError("cascade " + name + " 参数超出固件范围")
            return "cascade " + name + " " + " ".join(f"{x:g}" for x in values)
    # The MT6701 unwraps the single-turn reading into a float accumulator in
    # the firmware. Keep the UI contract consistent at +/-100 turns.
    position = re.fullmatch(
        r"(?:pos|posout)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(\d{1,4})\s+(\d{1,5})",
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
        return f"{command.split()[0]} {target:.10g} {duty} {timeout}"
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
    direct_test = re.fullmatch(r"dctest\s+(cw|ccw)\s+(\d{1,3})", command)
    if direct_test:
        duration = int(direct_test.group(2))
        if not 1 <= duration <= 200:
            raise ValueError("direct bridge test is limited to 1..200 ms")
        return f"dctest {direct_test.group(1)} {duration}"
    match = re.fullmatch(r"(cw|ccw)\s+(\d{1,4})\s+(\d{1,4})", command)
    if not match:
        raise ValueError("unsupported command")
    duty = int(match.group(2))
    duration = int(match.group(3))
    if not 0 <= duty <= 4095 or not 1 <= duration <= 1000:
        raise ValueError("safe limit is duty 0..4095 (0..100%) and time 1..1000 ms")
    return f"{match.group(1)} {duty} {duration}"


def remote_force_command(body, remote_meta, peer_meta):
    """Build the only force command allowed through a DATA gateway.

    The browser supplies typed parameters, never an arbitrary remote command.
    Both peer identities and the lower board current ceiling are checked here.
    """
    try:
        def exact_int(name):
            raw = float(body.get(name, float('nan')))
            if not math.isfinite(raw) or not raw.is_integer():
                raise ValueError(name + ' 必须是整数')
            return int(raw)
        peer = exact_int('peer')
        stiffness = float(body.get('stiffness', float('nan')))
        damping = float(body.get('damping', float('nan')))
        reflection = float(body.get('reflection', float('nan')))
        limit = float(body.get('limit', float('nan')))
        duty = exact_int('duty')
        timeout = exact_int('timeout')
        offset = float(body.get('offset', float('nan')))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError('力反馈参数格式无效') from exc
    if (remote_meta.get('protocol') != 3 or peer_meta.get('protocol') != 3 or
            not math.isfinite(remote_meta.get('model_ke', float('nan'))) or
            remote_meta['model_ke'] <= 0 or
            not math.isfinite(peer_meta.get('model_ke', float('nan'))) or
            peer_meta['model_ke'] <= 0):
        raise ValueError('单 USB 力反馈需要两板协议 3 和有效 Ke 参数；请更新固件')
    if peer == remote_meta.get('address') or peer != peer_meta.get('address'):
        raise ValueError('力反馈对端地址与已核实的本机板不匹配')
    if not math.isfinite(remote_meta.get('gear', float('nan'))) or not math.isfinite(peer_meta.get('gear', float('nan'))):
        raise ValueError('缺少力反馈减速比')
    if abs(remote_meta['gear'] - peer_meta['gear']) > 0.01:
        raise ValueError('两板减速比不一致')
    currents = (remote_meta.get('current_limit'), peer_meta.get('current_limit'))
    if not all(isinstance(value, (int, float)) and math.isfinite(value) and value > 0
               for value in currents):
        raise ValueError('缺少有效的两板电流上限')
    max_limit = min(currents) * 800.0
    if not math.isfinite(limit) or limit > max_limit:
        raise ValueError('力反馈电流限制超过两板共同的 80% 上限')
    command = (f'sync force {peer} {stiffness:g} {damping:g} {reflection:g} '
               f'{limit:g} {duty} {timeout} {offset:g}')
    return validate_command(command)


def parse_chain_status(reply, address):
    """Parse the fixed 13-field STATUS frame without accepting partial data."""
    fields = reply.split(',') if isinstance(reply, str) else []
    if (len(fields) != 13 or fields[0] != 'STATUS' or
            not fields[1].isdigit() or int(fields[1]) != int(address)):
        raise ValueError('DATA 状态帧无效')
    try:
        values = [float(value) for value in fields[1:]]
    except ValueError as exc:
        raise ValueError('DATA 状态帧包含非数字字段') from exc
    if not all(math.isfinite(value) for value in values):
        raise ValueError('DATA 状态帧包含非有限值')
    # STATUS,address,position,single,bus,current,pwm,fault,awake,...
    if values[6] not in (0, 1):
        raise ValueError('DATA 状态帧 nFAULT 标记无效')
    return values


def parse_usb_status(reply):
    """Extract only the live power/fault/awake interlocks from USB STATUS."""
    if not isinstance(reply, str) or not reply.startswith('STATUS '):
        raise ValueError('本机 USB 状态回读无效')
    bus = re.search(r'\bbus=([+-]?(?:\d+(?:\.\d*)?|\.\d+))V\b', reply)
    fault = re.search(r'\bnFAULT=(\d+)\b', reply)
    awake = re.search(r'\bawake=(\d+)\b', reply)
    if not bus or not fault or not awake:
        raise ValueError('本机 USB 状态缺少电压/驱动/nFAULT 字段')
    bus_v = float(bus.group(1))
    if not math.isfinite(bus_v) or int(fault.group(1)) not in (0, 1) or int(awake.group(1)) not in (0, 1):
        raise ValueError('本机 USB 状态字段无效')
    return {'bus':bus_v,'fault':int(fault.group(1)),'awake':int(awake.group(1))}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            # Browser/SSE socket closing is not a COM-port exception.
            # The serial reader records its own errors and fault captures.
            return

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
        if not 0 <= length <= 4096:
            self.close_connection = True
            raise ValueError("请求内容超过 4096 字节")
        body = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(body, dict): raise ValueError("请求必须是 JSON 对象")
        return body

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/chain/topology':
            return self.send_json({'devices':topology.snapshot()})
        if parsed.path == "/api/capabilities":
            return self.send_json({'phone_handoff': True})
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
            session = get_session(port)
            return self.send_json(session.payload_since(since))
        if parsed.path == "/api/record/status":
            return self.send_json(recorder.status())
        if parsed.path == "/api/record/clip":
            query = parse_qs(parsed.query)
            path = recorder.clip_path(query.get("name", [""])[0])
            if path is None:
                return self.send_error(404)
            size = path.stat().st_size
            total = size
            # Honour Range so the <video> element can seek without pulling the
            # whole clip again.
            start, end = 0, size - 1
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                first, _, last = rng[len("bytes="):].partition("-")
                if first:
                    start = int(first)
                if last:
                    end = min(int(last), size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            length = end - start + 1
            self.send_response(206 if (rng and rng.startswith("bytes=")) else 200)
            self.send_header("Content-Type", "video/webm")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if rng and rng.startswith("bytes="):
                self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(262144, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return
        if parsed.path == "/api/events":
            query = parse_qs(parsed.query)
            session = get_session(query.get("port", [""])[0])
            cursor = int(query.get("since", ["0"])[0])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    with session.changed:
                        if cursor == session.seq:
                            session.changed.wait(3.0)
                        logs = [entry for entry in session.logs if entry["seq"] > cursor and entry['session_id'] == session.session_id]
                        if cursor > session.seq:
                            logs = [entry for entry in session.logs if entry['session_id'] == session.session_id]
                        cursor = session.seq
                        payload = json.dumps({"logs": logs, "session_id": session.session_id}, ensure_ascii=False)
                    self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
                    self.wfile.flush()
            except (ConnectionError, OSError):
                return
        static_files = {
            "/chain-panel.js": ("chain-panel.js", "text/javascript; charset=utf-8"),
            "/gateway-transport.js": ("gateway-transport.js", "text/javascript; charset=utf-8"),
            "/remote-motion-lease.js": ("remote-motion-lease.js", "text/javascript; charset=utf-8"),
            "/usb-chain-transport.js": ("usb-chain-transport.js", "text/javascript; charset=utf-8"),
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
            # Acceptance recording, driven from the 录制 button on the page.
            # These are the only endpoints here that outlive their request: the
            # take runs for tens of seconds while the handler has long returned.
            if parsed.path == '/api/record/start':
                live = [item['port'] for item in port_info() if item.get('active')]
                return self.send_json(recorder.start(
                    seconds=body.get('seconds', 15),
                    suite=str(body.get('suite') or 'manual'),
                    ports=live or body.get('ports'),
                ))
            if parsed.path == '/api/record/stop':
                return self.send_json(recorder.stop())
            port = str(body.get("port", "")).upper()
            if parsed.path == '/api/chain/assign-id':
                live=[]
                for item in list_ports.comports():
                    if item.vid==0x303A and not recovery_usb(item):
                        s=get_session(item.device)
                        if s.health().get('telemetry_ok') and not s.phone_control: live.append(s)
                result = topology.assign(live,port,body.get('session_id'),body.get('uid'),body.get('address'))
                # An ID reassignment changes which UID answers at an address;
                # discard any per-address META/awake hints before the next
                # control request can consult them.
                for session in live:
                    session.chain.invalidate_cache()
                return self.send_json(result)
            if parsed.path == '/api/chain/scan':
                session = get_session(port)
                identity = body.get('session_id')
                if not identity: raise ValueError('必须提供当前 USB session_id')
                result = session.chain.scan(identity, int(body.get('first', 1)), int(body.get('last', 254)))
                topology.remember([(d['uid'],d['address']) for d in result['devices'] if d['uid'] in topology.devices])
                return self.send_json({'ok': True, **result})
            if parsed.path == '/api/chain/query':
                session = get_session(port)
                identity = body.get('session_id')
                if not identity: raise ValueError('必须提供当前 USB session_id')
                command = str(body.get('command', 'status'))
                # Stage 1 is read-only until identity, retry and lease tests pass.
                if command not in {'ping', 'status', 'gatewayinfo', 'sync status'}: raise ValueError('不支持的网关查询')
                address = int(body.get('address', 0))
                result = (session.chain.metadata(address, identity,
                                                 expected_epoch=session.command_epoch)
                          if command == 'gatewayinfo' else
                          session.chain.request(address, command, identity))
                return self.send_json({'ok': True, **result})
            if parsed.path == '/api/chain/stop':
                session=get_session(port)
                identity=body.get('session_id')
                if not identity: raise ValueError('必须提供当前 USB session_id')
                # STOP bypasses the transaction wait; cancellation precedes broadcast.
                session.send('stop',expected_session_id=identity)
                session.send('bus all stop',expected_session_id=identity)
                return self.send_json({'ok':True,'acknowledged':False,'note':'全链 STOP 已发送，需回读确认'})
            if parsed.path == '/api/chain/control':
                session=get_session(port)
                identity=body.get('session_id')
                if not identity: raise ValueError('必须提供当前 USB session_id')
                address=int(body.get('address',0))
                epoch=session.command_epoch
                # Identity is still checked before every *new* session/epoch,
                # but repeated slider updates reuse the short-lived, scoped
                # META result.  This removes a full DATA transaction from the
                # 25 ms motion dispatch path while keeping UID validation.
                meta=session.chain.metadata(address,identity,expected_epoch=epoch)
                if meta['uid'] != str(body.get('uid','')).upper(): raise ValueError('远端 UID 已变化；未执行')
                mode=str(body.get('mode',''))
                if mode in {'stop','sleep','recover','wake','sync_stop'}:
                    was_awake = session.chain.remote_awake(
                        address, identity, expected_epoch=epoch)
                    command = 'sync stop' if mode == 'sync_stop' else mode
                    result=session.chain.request(address,command,identity,expected_epoch=epoch)
                    if mode == 'sleep':
                        session.chain.mark_asleep(address,identity,expected_epoch=epoch)
                    elif mode == 'wake':
                        session.chain.mark_awake(address,identity,expected_epoch=epoch)
                    elif mode == 'stop':
                        # STOP does not report or change the driver's wake
                        # state. Preserve only a positive hint established by
                        # an earlier acknowledged wake/motion; an unknown or
                        # sleeping board must not be marked awake by STOP.
                        session.chain.mark_stopped(
                            address, identity, expected_epoch=epoch,
                            previously_awake=was_awake)
                    return self.send_json({'ok':True,'accepted':True,**result})
                if mode == 'sync_force':
                    peer = int(body.get('peer', 0))
                    # The peer is the board physically attached to this USB
                    # session. Read it over USB rather than addressing the
                    # gateway's own half-duplex DATA receiver (which may not
                    # see its own transmitted frames).
                    local_bus_reply = session.send_checked(
                        'businfo', expected_session_id=identity)
                    local_uid, local_address = topology.observe(local_bus_reply)
                    if local_address != peer:
                        raise ValueError('力反馈对端地址不是当前 USB 本机板')
                    local_fw_reply = session.send_checked(
                        'model', expected_session_id=identity)
                    firmware = re.search(r'\bfw=([^\s]+)', local_fw_reply)
                    model_ke = re.search(r'\bKe=([0-9.eE+-]+)V/', local_fw_reply)
                    if not firmware or firmware.group(1) != '0.5.10-single-usb-force' or not model_ke:
                        raise ValueError('本机 USB 板需要 0.5.10 单 USB 力反馈固件')
                    local_profile_reply = session.send_checked(
                        'motorprofile status', expected_session_id=identity)
                    local_gear = re.search(r'\bgear=([0-9.eE+-]+)', local_profile_reply)
                    local_current = re.search(r'\bcurrent_limit=([0-9.eE+-]+)A', local_profile_reply)
                    if not local_gear or not local_current:
                        raise ValueError('本机电机减速比/电流上限回读不完整')
                    peer_meta = {
                        'address':local_address,'uid':local_uid,'protocol':3,
                        'gear':float(local_gear.group(1)),
                        'current_limit':float(local_current.group(1)),
                        'model_ke':float(model_ke.group(1)),
                    }
                    remote_status = parse_chain_status(
                        session.chain.request(address, 'status', identity,
                                              expected_epoch=epoch).get('reply'), address)
                    peer_status = parse_usb_status(session.send_checked(
                        'status', expected_session_id=identity))
                    if not 8 <= remote_status[3] <= 50:
                        raise ValueError('远端母线电压不在 8–50 V 范围')
                    if remote_status[6] != 1 or remote_status[7] != 1:
                        raise ValueError('远端驱动未就绪或 nFAULT 异常；未启动力反馈')
                    if not 8 <= peer_status['bus'] <= 50:
                        raise ValueError('本机母线电压不在 8–50 V 范围')
                    if peer_status['fault'] != 1 or peer_status['awake'] != 1:
                        raise ValueError('本机驱动未就绪或 nFAULT 异常；未启动力反馈')
                    if not session.chain.remote_awake(address, identity,
                                                      expected_epoch=epoch):
                        session.chain.mark_awake(address, identity,
                                                  expected_epoch=epoch)
                    command = remote_force_command(body, meta, peer_meta)
                    result = session.chain.request(address, command, identity,
                                                   expected_epoch=epoch)
                    return self.send_json({'ok': True, 'accepted': True, **result})
                value=float(body.get('value',0))
                if not math.isfinite(value): raise ValueError('无效目标')
                if mode=='position' and abs(value)<=10: command=f'posout {value*360:.6f} 4095 1000'
                elif mode=='velocity' and abs(value)<=15: command=f'velocity {value*360*meta["gear"]:.6f} 4095 1000'
                elif mode=='current' and abs(value)<=min(1,meta['current_limit']*.8): command=f'current {value*1000:.3f} 4095 1000'
                elif mode=='pwm' and abs(value)<=4095:
                    command='stop' if abs(value)<12 else f'{"cw" if value>0 else "ccw"} {int(abs(value))} 1000'
                else: raise ValueError('目标范围：±10圈、±15圈/秒、电流不超过1A或板端80%上限')
                validate_command(command)
                if not session.chain.remote_awake(address,identity,expected_epoch=epoch):
                    session.chain.request(address,'wake',identity,expected_epoch=epoch)
                    session.chain.mark_awake(address,identity,expected_epoch=epoch)
                try:
                    result=session.chain.request(address,command,identity,expected_epoch=epoch)
                    session.chain.mark_awake(address,identity,expected_epoch=epoch)
                except Exception:
                    # Keep the next update able to perform a fresh wake.  Do
                    # not blindly wake/retry a rejected target: the board may
                    # have rejected it for power/fault/limit reasons, and a
                    # duplicate retry could hide that diagnosis.
                    session.chain.mark_asleep(address,identity,expected_epoch=epoch)
                    session.send('bus all stop',expected_session_id=identity)
                    raise
                return self.send_json({'ok':True,'accepted':True,**result})
            if parsed.path == "/api/phone-control":
                session = get_session(port)
                with session.recover_lock:
                    if body.get('release') is True:
                        with session.lifecycle_lock:
                            session.phone_control = True
                        try:
                            for command in ('stop', 'sync off', 'sleep'):
                                session.send_checked(command)
                            session.disconnect('phone control handoff')
                        except Exception:
                            with session.lifecycle_lock:
                                session.phone_control = False
                            raise
                        return self.send_json({'ok': True, 'note': '已停止并释放串口；手机可连接热点控制。后台重启需重新交接。'})
                    if body.get('release') is not False:
                        raise ValueError('release must be true or false')
                    with session.lifecycle_lock:
                        session.phone_control = False
                    session.connect()
                    session.send_checked('stop')
                    session.send_checked('sleep')
                    return self.send_json({'ok': True, 'note': '已接回电脑，保持停止'})
            if parsed.path == "/api/connect":
                get_session(port).connect()
                return self.send_json({"ok": True, "port": port})
            if parsed.path == "/api/disconnect":
                get_session(port).disconnect()
                return self.send_json({"ok": True, "port": port})
            if parsed.path == "/api/recover-link":
                result = get_session(port).recover_link()
                return self.send_json({"ok": True, "port": port, **result})
            if parsed.path == "/api/maintenance":
                session = get_session(port)
                session.maintenance_until = time.monotonic() + 180 if body.get("enabled") else 0
                if body.get("enabled"): session.disconnect("flashing maintenance")
                return self.send_json({"ok": True, "port": port})
            if parsed.path == "/api/send":
                command = validate_command(str(body.get("command", "")))
                if body.get("wait_ack"):
                    reply = get_session(port).send_checked(command, expected_session_id=body.get('session_id'))
                    return self.send_json({"ok": True, "command": command,
                                           "acknowledged": True, "reply": reply})
                get_session(port).send(command, expected_session_id=body.get('session_id'))
                return self.send_json({"ok": True, "command": command, "acknowledged": False})
            self.send_error(404)
        except ValueError as exc:
            self.send_json({"ok": False, "error": str(exc), "error_kind": error_kind(exc)}, 400)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc), "error_kind": error_kind(exc)}, 500)


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
