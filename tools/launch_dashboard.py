from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


def reachable(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Install dependencies and launch the motor dashboard")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    project = Path(__file__).resolve().parents[1]
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(project / "requirements.txt")],
        check=True,
    )
    api_url = f"http://127.0.0.1:{args.port}/api/ports"
    if not reachable(api_url):
        environment = dict(os.environ)
        environment["MOTOR_DEBUG_PORT"] = str(args.port)
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        subprocess.Popen(
            [sys.executable, "server.py"],
            cwd=project / "web",
            env=environment,
            creationflags=creation_flags,
        )
        for _ in range(30):
            if reachable(api_url, 0.5):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("dashboard server did not become ready")

    dashboard_url = f"http://127.0.0.1:{args.port}/?v=portable-timed-debug"
    if not args.no_browser:
        webbrowser.open(dashboard_url)
    print(dashboard_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
