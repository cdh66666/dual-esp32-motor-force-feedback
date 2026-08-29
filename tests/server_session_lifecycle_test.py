from __future__ import annotations

import importlib.util
import threading
import time
from pathlib import Path


SERVER_PATH = Path(__file__).resolve().parents[1] / "web" / "server.py"
SPEC = importlib.util.spec_from_file_location("motor_web_server", SERVER_PATH)
assert SPEC and SPEC.loader
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class FakeSerial:
    instances: list["FakeSerial"] = []

    def __init__(self):
        self.is_open = False
        self.writes: list[str] = []
        self.read_calls = 0
        self._closed = threading.Event()
        self.__class__.instances.append(self)

    def open(self):
        self.is_open = True
        self._closed.clear()

    def close(self):
        self.is_open = False
        self._closed.set()

    def read(self, _size: int) -> bytes:
        self.read_calls += 1
        self._closed.wait(0.005)
        return b""

    def write(self, data: bytes) -> int:
        if not self.is_open:
            raise OSError("closed")
        self.writes.append(data.decode("utf-8").strip())
        return len(data)


def main() -> int:
    original_serial = server.serial.Serial
    server.serial.Serial = FakeSerial
    session = server.PortSession("FAKE")
    try:
        session.connect()
        first = session.ser
        first_stop = session.stop_event
        time.sleep(0.03)
        session.disconnect()
        first_reads_after_disconnect = first.read_calls

        session.connect()
        second = session.ser
        assert second is not first
        assert first_stop.is_set(), "old connection event was cleared/reused"
        time.sleep(1.15)
        # Allow at most one read already in flight when close() occurred.
        assert first.read_calls <= first_reads_after_disconnect + 1
        assert second.writes[:3] == ["stream 100", "businfo", "model"]
        assert "wake" not in second.writes, "monitor must not mutate actuator state"
        print({
            "old_reader_stopped": True,
            "monitor_writes": second.writes,
            "monitor_sent_wake": False,
        })
        return 0
    finally:
        session.disconnect()
        server.serial.Serial = original_serial


if __name__ == "__main__":
    raise SystemExit(main())
