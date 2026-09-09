"""Isolate USB from HTTP/backend threads. STOP/SLEEP and read-only queries only.

Reserves the exact board via backend maintenance; never resets, flashes, wakes,
or restores a motion target. Raw bytes/lines and acknowledgements are retained.
"""
import argparse
import json
import math
import time
import urllib.request
from pathlib import Path
import serial
from serial.tools import list_ports


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', required=True)
    p.add_argument('--serial', required=True)
    p.add_argument('--seconds', type=float, default=120)
    p.add_argument('--hz', type=float, default=20)
    a = p.parse_args()
    if not 1 <= a.seconds <= 600 or not 1 <= a.hz <= 40: p.error('invalid test rate/duration')
    normalize = lambda x: (x or '').replace(':', '').replace('-', '').upper()
    found = [x for x in list_ports.comports() if x.vid == 0x303A and
             normalize(x.serial_number) == normalize(a.serial)]
    if len(found) != 1 or found[0].device != a.port or ':' in found[0].serial_number:
        raise RuntimeError('Application USB identity mismatch; no commands sent')
    def api(name, data):
        req = urllib.request.Request('http://127.0.0.1:8766/api/' + name,
            data=json.dumps(data).encode(), headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=5) as r: result = json.load(r)
        if not result.get('ok'): raise RuntimeError(result)
        return result
    folder = Path(__file__).resolve().parents[1] / 'evidence/link-stability'
    folder.mkdir(exist_ok=True, parents=True)
    stamp = time.strftime('%Y%m%d-%H%M%S') + '-direct'
    report = {'kind':'independent-pyserial-no-backend-data-path', 'port':a.port,
              'serial':found[0].serial_number, 'motor_tested':False,
              'requested_s':a.seconds, 'query_hz':a.hz, 'queries':0, 'error':None}
    samples, replies = [], []
    pending = bytearray()
    transport = serial.Serial(port=None, baudrate=115200, timeout=.002, write_timeout=.5)
    transport.port = a.port; transport.dtr = True; transport.rts = False
    test_started = None
    with (folder / (stamp + '-raw.jsonl')).open('w', encoding='utf-8') as out:
        def log(direction, text):
            row = {'host_mono':time.monotonic(), 'direction':direction, 'text':text}
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
            return row
        def receive():
            data = transport.read(min(4096, max(1, transport.in_waiting)))
            pending.extend(data)
            if len(pending) > 65536: raise RuntimeError('unbounded partial frame')
            while b'\n' in pending:
                raw, _, tail = pending.partition(b'\n'); pending[:] = tail
                text = raw.rstrip(b'\r').decode('utf-8', 'replace')
                row = log('rx', text)
                if text.startswith('S,'):
                    values = list(map(float, text[2:].split(',')))
                    if len(values) < 13 or not all(map(math.isfinite, values)):
                        raise RuntimeError('invalid telemetry')
                    if values[5] != 0 or values[7] != 0:
                        raise RuntimeError('unexpected actuator enabled')
                    if samples and values[0] <= samples[-1][1][0]:
                        raise RuntimeError('MCU clock reset or nonmonotonic telemetry')
                    samples.append((row['host_mono'], values))
                else:
                    replies.append(row)
        def send(command, prefix):
            start = time.monotonic(); payload = (command+'\r\n').encode()
            written = transport.write(payload)
            log('tx', command)
            if written != len(payload): raise RuntimeError(f'short write {written}/{len(payload)}')
            deadline = start + 1.5
            while time.monotonic() < deadline:
                receive()
                for row in reversed(replies):
                    if row['host_mono'] < start: break
                    if row['text'].startswith(prefix): return row['text']
            raise RuntimeError('ACK timeout: '+command)
        try:
            api('maintenance', {'port':a.port, 'enabled':True})
            transport.open()
            # Drain startup data before matching replies to new commands.
            until = time.monotonic() + .2
            while time.monotonic() < until: receive()
            send('stop','OK stop'); send('sleep','OK driver_awake=0')
            send('stream 100','OK stream=')
            report['version'] = send('model','MODEL fw=')
            send('cascade status','CASCADE_CFG ')
            test_started = time.monotonic(); next_query = test_started; next_print = test_started+10
            while time.monotonic() - test_started < a.seconds:
                receive()
                if time.monotonic() >= next_query:
                    started = time.monotonic()
                    send('model','MODEL fw='); report['queries'] += 1
                    next_query = started + 1/a.hz
                if time.monotonic() >= next_print:
                    print(json.dumps({'seconds':round(time.monotonic()-test_started,1),
                        'queries':report['queries'], 'frames':len(samples)}), flush=True)
                    out.flush(); next_print += 10
            report['duration_s'] = time.monotonic()-test_started
            send('cascade status','CASCADE_CFG ')
        except Exception as e:
            report['error'] = repr(e); log('error', repr(e))
            report['duration_s'] = time.monotonic()-test_started if test_started else 0
            # Distinguish dead OUT from a stopped MCU/IN endpoint.
            count = len(samples); until = time.monotonic()+2
            try:
                while time.monotonic() < until and transport.is_open: receive()
            except Exception as tail_error: report['tail_error'] = repr(tail_error)
            report['frames_after_failure'] = len(samples)-count
        finally:
            if transport.is_open:
                try: send('stop','OK stop'); send('sleep','OK driver_awake=0')
                except Exception as e: report['final_stop_error'] = repr(e)
                transport.close()
            try:
                api('maintenance', {'port':a.port, 'enabled':False})
                api('connect', {'port':a.port})
            except Exception as e: report['backend_restore_error'] = repr(e)
    selected = [v for host,v in samples if test_started and
                test_started <= host <= test_started + report['duration_s']]
    gaps = [b[0]-x[0] for x,b in zip(selected,selected[1:])]
    report['frames'] = len(selected)
    report['telemetry_hz'] = (len(selected)-1)*1000/(selected[-1][0]-selected[0][0]) if len(selected)>1 else 0
    report['max_frame_gap_ms'] = max(gaps,default=0)
    report['diagnostics'] = [x['text'] for x in replies if
        x['text'].startswith(('USB_', 'LINK_STATS ', 'WATCHDOG_CFG '))]
    report['passed'] = (not report['error'] and not report.get('final_stop_error') and
        report['duration_s'] >= a.seconds and 98 <= report['telemetry_hz'] <= 102 and
        len(selected) >= a.seconds*98 and report['queries'] >= a.seconds*a.hz*.95 and
        bool(gaps) and max(gaps) <= 50)
    path = folder / (stamp+'-report.json')
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
    print(path,flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
