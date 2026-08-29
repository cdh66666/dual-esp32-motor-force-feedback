import sys
import time

import serial


def main() -> int:
    port = sys.argv[1] if len(sys.argv) > 1 else "COM18"
    commands = sys.argv[2:] or ["diag", "status"]
    ser = serial.Serial(
        port=port,
        baudrate=115200,
        timeout=0.05,
        write_timeout=0.5,
        rtscts=False,
        dsrdtr=False,
    )
    try:
        start = time.monotonic()
        while time.monotonic() - start < 0.8:
            data = ser.read(4096)
            if data:
                sys.stdout.write(data.decode("utf-8", errors="replace"))
                sys.stdout.flush()
        for command in commands:
            print(f"TX {command}", flush=True)
            try:
                ser.write((command + "\r\n").encode())
                ser.flush()
            except Exception as exc:
                print(f"WRITE_ERROR {type(exc).__name__}: {exc}", flush=True)
                return 2
            end = time.monotonic() + 0.25
            while time.monotonic() < end:
                data = ser.read(4096)
                if data:
                    sys.stdout.write(data.decode("utf-8", errors="replace"))
                    sys.stdout.flush()
        end = time.monotonic() + 1.0
        while time.monotonic() < end:
            data = ser.read(4096)
            if data:
                sys.stdout.write(data.decode("utf-8", errors="replace"))
                sys.stdout.flush()
    finally:
        try:
            ser.write(b"stop\r\n")
            ser.flush()
        except Exception:
            pass
        ser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
