import sys
import time

import serial


def drain(ser, seconds):
    end = time.monotonic() + seconds
    chunks = []
    while time.monotonic() < end:
        data = ser.read(4096)
        if data:
            chunks.append(data.decode("utf-8", errors="replace"))
    return "".join(chunks)


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "COM18"
    ser = serial.Serial(port, 115200, timeout=0.05, write_timeout=0.5,
                        rtscts=False, dsrdtr=False)
    try:
        print(f"OPEN dtr={ser.dtr} rts={ser.rts}", flush=True)
        print(drain(ser, 0.5), end="", flush=True)
        for dtr, rts in ((False, False), (True, False), (False, True), (True, True)):
            try:
                ser.dtr = dtr
                ser.rts = rts
                time.sleep(0.15)
                print(f"TRY dtr={dtr} rts={rts}", flush=True)
                ser.write(b"diag\r\n")
                ser.flush()
                print(drain(ser, 0.35), end="", flush=True)
            except Exception as exc:
                print(f"WRITE_ERROR {type(exc).__name__}: {exc}", flush=True)
    finally:
        try:
            ser.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
