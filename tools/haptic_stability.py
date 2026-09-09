"""Explicitly powered, single-board haptic/USB bench test, bounded to <100 s.

No motion unless --powered-test-confirmed is supplied. Exercises four modes,
the 60 s hard limit, the 1 s command lease and STOP. This tests electronics
and no-external-load stability, not calibrated torque or human haptic feel.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--powered-test-confirmed', action='store_true')
    args = parser.parse_args()
    if not args.powered_test_confirmed:
        parser.error('Motor must be secured, powered, and testing explicitly authorized')
    root = Path(__file__).resolve().parents[1]
    stem = root / 'evidence/link-stability' / (time.strftime('%Y%m%d-%H%M%S') + '-powered-knob')
    stem.parent.mkdir(parents=True, exist_ok=True)
    url = 'http://127.0.0.1:8766/api/'
    cursor = 0
    session_id = None
    latest = None
    last_sample = time.monotonic()
    samples, events, latencies, diagnostics = [], [], [], []
    fatal = None
    original_config = None
    identity_verified = False
    report = {'kind': 'real-powered-haptic-no-external-load', 'port': args.port,
              'human_feel_tested': False, 'torque_calibrated': False, 'checks': {}}

    def api(endpoint, body=None):
        request = urllib.request.Request(url + endpoint,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            return {'ok': False, **json.loads(exc.read())}

    with stem.with_suffix('.jsonl').open('w', encoding='utf-8') as raw:
        def record(row):
            raw.write(json.dumps(row, ensure_ascii=False) + '\n')

        def send(command, expected_rejection=False):
            started = time.monotonic()
            result = api('send', {'port': args.port, 'command': command, 'wait_ack': True})
            elapsed = (time.monotonic() - started) * 1000
            record({'command': command, 'host': started, 'ack_ms': elapsed, 'result': result})
            if expected_rejection:
                if result.get('ok') or result.get('error_kind') != 'controller':
                    raise RuntimeError('Expected controller rejection: ' + str(result))
                return result
            if not result.get('ok') or not result.get('acknowledged'):
                raise RuntimeError(str(result))
            latencies.append(elapsed)
            return result['reply']

        def collect(label, guard=True):
            nonlocal cursor, latest, last_sample
            payload = api('logs?port=' + args.port + '&since=' + str(cursor))
            if payload.get('session_id') != session_id:
                raise RuntimeError('Serial session replaced during powered test')
            for row in payload['logs']:
                if row['seq'] <= cursor:
                    continue
                cursor = row['seq']
                record({'label': label, 'host': time.monotonic(), **row})
                text = row['text']
                if row['direction'] == 'error' or text.startswith('link stalled'):
                    events.append(row)
                    if guard:
                        raise RuntimeError(text)
                if row['direction'] != 'rx':
                    continue
                if not text.startswith('S,'):
                    diagnostics.append(text)
                    if guard and text.startswith(('ERR ', 'CASCADE fault', 'CASCADE no_')):
                        raise RuntimeError(text)
                    continue
                fields = list(map(float, text.split(',')[1:]))
                if len(fields) < 24 or not all(math.isfinite(x) for x in fields):
                    raise RuntimeError('Invalid telemetry frame')
                if latest and fields[0] <= latest[0]:
                    raise RuntimeError('MCU time reset or duplicate data')
                latest = fields
                samples.append((label, fields))
                last_sample = time.monotonic()
                if guard and (fields[6] != 1 or not 8 <= fields[3] <= 25 or
                              abs(fields[21]) > 800 or abs(fields[10]) > 1040):
                    raise RuntimeError('Haptic test envelope exceeded: ' + text)
            if guard and time.monotonic() - last_sample > .5:
                raise RuntimeError('No fresh telemetry for 500 ms')

        def wait(seconds, label, guard=True):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                collect(label, guard)
                time.sleep(.015)

        try:
            ports = api('ports')['ports']
            selected = [p for p in ports if p['port'] == args.port and p['present'] and p['active']]
            identity = args.serial.replace(':', '').upper()
            if len(selected) != 1 or '303A:1001' not in selected[0]['hwid'] or \
                    identity not in selected[0]['hwid'].replace(':', '').upper():
                raise RuntimeError('Live USB identity mismatch')
            identity_verified = True
            snapshot = api('logs?port=' + args.port + '&since=0')
            session_id = snapshot['session_id']
            cursor = max((r['seq'] for r in snapshot['logs']), default=0)
            report['identity'] = selected[0]['hwid']
            report['session_id'] = session_id
            send('stop')
            report['version'] = send('model')
            profile = send('motorprofile status')
            if 'id=36gp555' not in profile or 'gear=5.20' not in profile:
                raise RuntimeError('This test requires the commissioned 36GP-555 / 5.2 profile')
            config = send('knob status')
            original_config = re.search(r'effect=(\d+).*spacing_out_deg=([\d.]+).*peak_mA=([\d.]+).*damping_mA_per_out_dps=([\d.]+).*range_out_deg=([\d.]+)', config)
            if not original_config:
                raise RuntimeError('Cannot preserve original haptic configuration')
            send('cascade status')
            wait(.3, 'preflight')
            if latest is None or latest[5] != 0 or abs(latest[10]) > 10:
                raise RuntimeError('Preflight needs a stationary, stopped motor')
            send('wake')
            wait(.5, 'awake-zero')
            if abs(latest[21]) > 100:
                raise RuntimeError('Current zero exceeds 100 mA')
            token = int(time.time()) % 900000000 + 1
            send('knob config 0 15 200 1 90')
            start_reply = send(f'knob start {token}')
            origin = float(re.search(r'origin_out_deg=([+-]?[\d.]+)', start_reply)[1])
            start = time.monotonic()
            next_keep, next_query, next_print = start, start, start + 10
            effect = 0
            first_stop = None
            while time.monotonic() - start < 61.5:
                now = time.monotonic()
                elapsed = now - start
                desired_effect = min(3, int(elapsed // 12))
                if desired_effect != effect:
                    send(f'knob config {desired_effect} 15 200 1 90')
                    effect = desired_effect
                if elapsed < 59.6 and now >= next_keep:
                    send(f'knob keep {token}')
                    next_keep = time.monotonic() + .23
                if now >= next_query:
                    send('model')
                    next_query = time.monotonic() + .10
                collect('mode-' + str(effect))
                if latest and abs(latest[2] / 5.2 - origin) > 45:
                    raise RuntimeError('Unattended knob moved more than 45 output degrees')
                if latest and elapsed > .5 and latest[11] != 5:
                    first_stop = first_stop or elapsed
                    if elapsed < 59.5:
                        raise RuntimeError('Haptic control ended before its hard limit')
                if now >= next_print:
                    raw.flush()
                    print(json.dumps({'elapsed_s': round(elapsed, 1), 'mode': effect,
                          'frames': len(samples), 'current_mA': latest[21],
                          'output_delta_deg': latest[2] / 5.2 - origin}), flush=True)
                    next_print += 10
                time.sleep(.012)
            report['checks']['four_modes_continuous'] = True
            report['checks']['hard_limit_60s'] = first_stop is not None and 59.5 <= first_stop <= 60.5
            report['hard_stop_host_s'] = first_stop
            if not report['checks']['hard_limit_60s'] or latest[5] != 0:
                raise RuntimeError('60 second hard stop failed')
            send(f'knob keep {token}', expected_rejection=True)
            wait(.3, 'expired-token-rejected', guard=False)
            report['checks']['old_token_cannot_restart'] = latest[11] == 0 and latest[5] == 0
            send('stop')
            send(f'knob start {token + 1}')
            wait(.4, 'lease-running')
            send(f'knob keep {token + 1}')
            last_keep = time.monotonic()
            lease_stop = None
            while time.monotonic() - last_keep < 1.6:
                collect('lease-expiry')
                if latest[11] == 0 and lease_stop is None:
                    lease_stop = time.monotonic() - last_keep
                time.sleep(.015)
            report['lease_stop_host_s'] = lease_stop
            report['checks']['no_keep_stops_within_1_2s'] = lease_stop is not None and .85 <= lease_stop <= 1.2 and latest[5] == 0
            if not report['checks']['no_keep_stops_within_1_2s']:
                raise RuntimeError('1 second lease stop failed')
            send('stop')
            send(f'knob start {token + 2}')
            wait(.25, 'explicit-stop-test')
            stop_start = time.monotonic()
            send('stop')
            report['stop_ack_ms'] = (time.monotonic() - stop_start) * 1000
            wait(.15, 'explicit-stop-result')
            report['checks']['explicit_stop'] = latest[11] == 0 and latest[5] == 0
            send('cascade status')
            wait(.2, 'end-stats')
        except Exception as exc:
            fatal = repr(exc)
            print('TEST STOPPED: ' + fatal, flush=True)
            try:
                if identity_verified: collect('failure-capture', guard=False)
            except Exception as capture_error:
                record({'capture_error': repr(capture_error)})
        finally:
            if identity_verified:
                for safe_command in ('stop', 'sleep'):
                    try: send(safe_command)
                    except Exception as exc: fatal = fatal or repr(exc)
                try:
                    if original_config and fatal is None:
                        send('knob config ' + ' '.join(original_config.groups()))
                except Exception as exc: fatal = fatal or repr(exc)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try: collect('post-stop', guard=False)
                    except Exception as exc:
                        fatal = fatal or repr(exc)
                        record({'capture_error': repr(exc)})
                        break
                    time.sleep(.025)
            raw.flush()

    active = [(label, row) for label, row in samples if row[11] == 5]
    gaps = [b[1][0] - a[1][0] for a, b in zip(samples, samples[1:])
            if a[1][11] == 5 and b[1][11] == 5]
    report.update({'fatal': fatal, 'frames': len(samples), 'active_frames': len(active),
                   'peak_current_A': max((abs(r[21]) / 1000 for _, r in active), default=0),
                   'peak_output_speed_rps': max((abs(r[10]) / 1872 for _, r in active), default=0),
                   'max_active_gap_ms': max(gaps, default=0),
                   'active_gaps_over_20ms': sum(g > 20 for g in gaps),
                   'ack_count': len(latencies), 'ack_median_ms': statistics.median(latencies) if latencies else None,
                   'ack_max_ms': max(latencies, default=0),
                   'events': events, 'diagnostics': [d for d in diagnostics if d.startswith(('LINK_STATS', 'CONTROL_STATS', 'KNOB stopped', 'ERR '))],
                   'passed': fatal is None and not events and all(report['checks'].values())})
    stem.with_suffix('.report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    print('REPORT=' + str(stem.with_suffix('.report.json')), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
