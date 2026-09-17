"""Physical single-USB DATA read-only acceptance. Never sends wake/targets.

Requires exactly one known board USB identity visible throughout sampling.
Motor powering and powered-motion acceptance are recorded separately.
"""
import hashlib
import json
import math
import time
import urllib.request
from pathlib import Path
from serial.tools import list_ports

KNOWN = {'68EE8F5381E4': (184, 'E481538FEE68'),
         '68EE8F52A79C': (1, '9CA7528FEE68')}
BASE = 'http://127.0.0.1:8766/api/'


def api(path, body=None):
    request = urllib.request.Request(BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        result = json.load(response)
    if result.get('ok') is False:
        raise RuntimeError(result)
    return result


def single():
    ports = [p for p in list_ports.comports() if p.vid == 0x303A and
             (p.serial_number or '').replace(':', '').upper() in KNOWN]
    if len(ports) != 1:
        raise RuntimeError(f'需要且只允许一块已知板的 USB 枚举，当前 {len(ports)} 块')
    p = ports[0]
    if ':' in p.serial_number:
        raise RuntimeError('仅发现下载接口，不能进行应用验收')
    return p.device, p.serial_number.upper()


def main():
    port, serial = single()
    peer = next(v for k, v in KNOWN.items() if k != serial)
    api('connect', {'port': port})
    session = api(f'logs?port={port}&since=0')['session_id']
    context = {'port': port, 'session_id': session, 'address': peer[0]}
    records = []
    for index in range(40):
        if single() != (port, serial):
            raise RuntimeError('USB 拓扑或入口身份变化；验收中止')
        meta = api('chain/query', {**context, 'command': 'gatewayinfo'})
        if meta['uid'] != peer[1] or meta['protocol'] != 2:
            raise RuntimeError('远端 UID 或协议不匹配')
        started = time.monotonic()
        status = api('chain/query', {**context, 'command': 'status'})
        fields = status['reply'].split(',')
        if len(fields) != 13 or fields[0] != 'STATUS' or int(fields[1]) != peer[0]:
            raise RuntimeError('状态帧格式/地址异常')
        if not all(math.isfinite(float(x)) for x in fields[1:]):
            raise RuntimeError('状态帧非有限数')
        if int(fields[6]) != 0 or int(fields[8]) != 0 or int(fields[11]) != 0:
            raise RuntimeError('远端不是停止/休眠状态；不继续只读验收')
        records.append({'at': time.time(), 'status': status['reply'],
                        'query_ms': round((time.monotonic()-started)*1000, 2)})
        time.sleep(.25)
    if single() != (port, serial):
        raise RuntimeError('结束时 USB 拓扑发生变化')
    report = {'scope': 'one physical known USB enumerated; peer DATA identity/status only; no motion acceptance',
              'entry': port, 'usb_serial': serial, 'peer': peer, 'samples': records,
              'passed': True}
    path = Path(__file__).resolve().parents[1] / 'evidence' / f'single-usb-{serial}-{int(time.time())}.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS', port, '->', peer[1], '40 fresh status replies; no motion commands')
    print(path)
    print('SHA256', hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
