"""Read-only live gateway verification.

The test deliberately chooses whichever healthy USB entry is available. The
other board may be USB-disconnected and reachable only through DATA; COM
numbers and the local/remote address assignment are discovered at runtime.
No wake, target, PWM or force command is sent.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8766/api/"


def api(path: str, body: dict | None = None):
    request = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def usb_serial(hwid: str) -> str | None:
    match = re.search(r"\bSER=([^\s]+)", hwid or "", re.IGNORECASE)
    return match.group(1).replace(":", "").replace("-", "").upper() if match else None


ports = api("ports")
entries = [
    p for p in ports.get("ports", [])
    if p.get("esp32") and not p.get("recovery_usb") and
    p.get("active") and p.get("write_ok") and p.get("telemetry_ok") and
    not p.get("remote")
]
if not entries:
    raise RuntimeError("没有可用的 USB 入口；需要至少一块板保持 USB 遥测正常")

registry = api("chain/topology").get("devices", [])
if not registry:
    raise RuntimeError("设备拓扑为空，不能在未知身份下验证 DATA")

results = []
for entry in entries:
    port = entry["port"]
    session = api(f"logs?port={port}&since=0")["session_id"]
    local_serial = usb_serial(entry.get("hwid", ""))
    for spec in registry:
        address = int(spec["address"])
        uid = str(spec["uid"]).upper()
        scan = api("chain/scan", {
            "port": port,
            "session_id": session,
            "address": address,
            "first": address,
            "last": address,
        })
        matches = [d for d in scan.get("devices", []) if str(d.get("uid", "")).upper() == uid]
        if not matches:
            continue
        device = matches[0]
        if device.get("local") or (local_serial and uid == local_serial):
            continue
        context = {"port": port, "session_id": session, "address": address}
        status = api("chain/query", {**context, "command": "status"})
        metadata = api("chain/query", {**context, "command": "gatewayinfo"})
        fields = str(status["reply"]).split(",")
        if len(fields) != 13 or fields[0] != "STATUS" or int(fields[1]) != address:
            raise AssertionError(f"远端状态格式无效: {status}")
        if int(fields[6]) != 0 or int(fields[11]) != 0:
            raise AssertionError("远端不是停止状态；未继续任何动作")
        if (metadata.get("address") != address or
                str(metadata.get("uid", "")).upper() != uid or
                metadata.get("protocol") != 2 or
                not float(metadata.get("gear", 0)) > 0 or
                not float(metadata.get("current_limit", 0)) > 0):
            raise AssertionError(f"远端身份/参数无效: {metadata}")
        results.append({
            "gateway_usb": port,
            "gateway_serial": local_serial,
            "remote_address": address,
            "remote_uid": uid,
            "remote_status": status,
            "metadata": metadata,
        })

if not results:
    raise RuntimeError("未发现可回读的 DATA 对端；检查 DATA、共地和设备地址")

report = {
    "scope": "Dynamic single-USB DATA read-only; no motion or flash",
    "results": results,
}
path = Path(__file__).resolve().parents[1] / "evidence" / f"chain-readonly-{int(time.time())}.json"
path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(path)
print(f"PASS single-USB DATA gateway, {len(results)} remote device(s), identity/status idle; no motion commands")
