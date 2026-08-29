import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from web import server


def main() -> int:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary) / "web"
        root.mkdir()
        server.ROOT = root
        session = server.PortSession("COM_TEST")
        session.add_log("rx", "S,1,0,0,19.4,0,4095,1,1,3,0,0,1,1000")
        session.add_log(
            "rx",
            "CASCADE no_power_response mode=current target=1.000A measured=0.000A pwm=4095 latched=1",
        )
        deadline = time.monotonic() + 2.0
        captures = []
        while time.monotonic() < deadline:
            captures = list((Path(temporary) / "evidence" / "fault-captures").glob("*.jsonl"))
            if captures:
                break
            time.sleep(0.02)
        if len(captures) != 1:
            raise AssertionError(f"expected one capture, found {captures}")
        rows = [json.loads(line) for line in captures[0].read_text(encoding="utf-8").splitlines()]
        assert rows[0]["port"] == "COM_TEST"
        assert any("no_power_response" in row.get("text", "") for row in rows[1:])
        print({"capture": captures[0].name, "rows": len(rows), "passed": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
