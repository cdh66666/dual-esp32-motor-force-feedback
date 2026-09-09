"""Bounded, explicitly requested single-board tests through the same web API.

No motion by default. Example: --segment velocity:360:3 --segment velocity:720:3
Positions/speeds are ENCODER-side degrees; gearbox output is divided by 5.2.
Preserves raw process data and stops in finally, including on missing telemetry.
"""
from __future__ import annotations
import argparse
import json
import math
import re
import statistics
import time
import urllib.request
import urllib.error
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--url', default='http://127.0.0.1:8766')
    parser.add_argument('--segment', action='append', default=[], help='current:mA:seconds | velocity:deg/s:seconds | pos:deg:seconds | idle:0:seconds')
    parser.add_argument('--config', action='append', default=[])
    parser.add_argument('--max-current', type=float, default=0.9)
    parser.add_argument('--max-speed', type=float, default=12000)
    parser.add_argument('--zero', action='store_true')
    parser.add_argument('--trace', type=int, default=0, help='store first N current-loop ticks in firmware RAM, then dump after STOP')
    parser.add_argument('--pwm-limit', type=int, default=4095)
    parser.add_argument('--rotor-fit', type=Path, help='explicitly apply an offline calibration; no NVS save')
    parser.add_argument('--rotor-scale', type=float, default=.8)
    parser.add_argument('--post-stop-seconds', type=float, default=10,
                        help='continue recording after final STOP, including failed tests')
    args = parser.parse_args()
    if not 12 <= args.pwm_limit <= 4095 or not 0 <= args.trace <= 1024:
        raise ValueError('invalid PWM/trace limit')
    if not 0 <= args.post_stop_seconds <= 20:
        raise ValueError('post-STOP recording must be 0..20 seconds')
    segments = []
    for item in args.segment or ['idle:0:2']:
        mode, target, seconds = item.split(':')
        target, seconds = float(target), float(seconds)
        if mode not in {'current', 'velocity', 'pos', 'idle'} or not 0.1 <= seconds <= 20:
            raise ValueError('unsupported mode/duration')
        if not math.isfinite(target):
            raise ValueError('nonfinite target')
        segments.append((mode, target, seconds))
    for command in args.config:
        if not command.startswith('cascade '):
            raise ValueError('config accepts cascade parameters only')
    folder = Path(__file__).resolve().parents[1] / 'evidence' / 'commissioning'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (time.strftime('%Y%m%d-%H%M%S') + '-' + args.port + '-' + str(time.time_ns() % 1000000) + '.jsonl')
    cursor, last_sample_at = 0, time.monotonic()
    latest = None

    def api(endpoint, body=None):
        req = urllib.request.Request(args.url + '/api/' + endpoint,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=4) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(exc.read().decode('utf-8','replace')) from exc

    with path.open('w', encoding='utf-8') as out:
        def record(value):
            out.write(json.dumps(value, ensure_ascii=False) + '\n')
            out.flush()

        def command(text):
            result = api('send', {'port': args.port, 'command': text, 'wait_ack': True})
            record({'command': text, 'reply': result, 'host': time.monotonic()})
            print(result['reply'], flush=True)
            return result

        def collect(seconds, label, guarding=True):
            nonlocal cursor, latest, last_sample_at
            end = time.monotonic() + seconds
            rows = []
            while time.monotonic() < end:
                result = api('logs?port=' + args.port + '&since=' + str(cursor))
                for entry in result['logs']:
                    if entry['seq'] <= cursor:
                        continue
                    cursor = entry['seq']
                    record({'label': label, 'host': time.monotonic(), **entry})
                    text = entry['text']
                    if entry['direction'] != 'rx':
                        continue
                    if guarding and (text.startswith('ERR ') or text.startswith('CASCADE fault') or text.startswith('CASCADE no_')):
                        raise RuntimeError(text)
                    if text.startswith('CONTROL_STATS '):
                        carrier = re.search(r'pwm_hz=([\d.]+)', text)
                        if not carrier or float(carrier[1]) <= 0:
                            raise RuntimeError('PWM timer not configured: ' + text)
                    if not text.startswith('S,'):
                        continue
                    try:
                        sample = [float(x) for x in text.split(',')[1:]]
                    except ValueError:
                        continue
                    if len(sample) < 24 or not all(math.isfinite(x) for x in sample):
                        continue
                    if latest is not None and sample[0] < latest[0]:
                        raise RuntimeError('board timestamp reset during test')
                    latest = sample
                    rows.append(sample)
                    last_sample_at = time.monotonic()
                    # A STOP can leave the geared rotor coasting while the
                    # controller is already idle. Enforce current/speed
                    # envelopes only while a closed-loop mode is active; a
                    # post-STOP regenerative ADC transient is diagnostic data,
                    # not an active command violation.
                    active_mode = sample[11] != 0
                    if guarding and (sample[6] != 1 or not 8 <= sample[3] <= 30 or
                            (active_mode and (abs(sample[21]) > args.max_current * 1000 or
                                              abs(sample[10]) > args.max_speed))):
                        raise RuntimeError('test envelope exceeded: ' + text)
                if guarding and time.monotonic() - last_sample_at > 0.5:
                    raise RuntimeError('no valid sample for 500 ms')
                time.sleep(0.015)
            return rows

        try:
            enumeration_deadline=time.monotonic()+10
            while not any(p.get('port')==args.port and p.get('present') for p in api('ports')['ports']):
                if time.monotonic()>enumeration_deadline:
                    raise RuntimeError('requested port did not enumerate within 10 s')
                time.sleep(.2)
            api('connect', {'port': args.port})
            time.sleep(2)
            # Discard history before this test; preserve fresh queries below.
            old = api('logs?port=' + args.port + '&since=0')['logs']
            cursor = max((entry['seq'] for entry in old), default=0)
            command('stop')
            command('stream 100')
            command('model')
            command('motorprofile status')
            command('cascade status')
            last_sample_at = time.monotonic()
            collect(.4, 'preflight')
            if latest is None or latest[5] != 0:
                raise RuntimeError('preflight requires real telemetry and PWM=0')
            if args.zero:
                command('encreset')
            if args.rotor_fit:
                fit=json.loads(args.rotor_fit.read_text(encoding='utf-8'))
                if fit['metrics']['held_out_turns']['R2'] < .7 or not 0 <= args.rotor_scale <= 1.2:
                    raise ValueError('rotor fit fails held-out validation or scale bound')
                command('cascade cogging clear')
                for harmonic in fit['harmonics']:
                    command(f"cascade cogging harmonic {harmonic['k']} {harmonic['sin_A']:.7f} {harmonic['cos_A']:.7f}")
                command(f"cascade cogging enable {args.rotor_scale} {fit['coulomb_A']:.7f} {fit['offset_A']:.7f}")
            for text in args.config:
                command(text)
            if args.trace:
                command(f'trace arm {args.trace}')
            if any(mode != 'idle' for mode, _, _ in segments):
                command('wake')
            for index, (mode, target, seconds) in enumerate(segments):
                label = f'{index}:{mode}:{target:g}'
                if mode != 'idle':
                    # For a continuous speed retarget, the previous lease must
                    # still be alive when the next command is sent. Final and
                    # current-only segments keep their exact requested time.
                    margin = .5 if mode in {'velocity', 'pos'} and index+1 < len(segments) and segments[index+1][0] == mode else 0
                    command(f'{mode} {target:g} {args.pwm_limit} {round((seconds + margin) * 1000)}')
                rows = collect(seconds, label)
                mode_id = {'current': 1, 'velocity': 2, 'pos': 3}.get(mode)
                if mode_id is not None:
                    rows = [row for row in rows if row[11] == mode_id]
                if rows:
                    tail = rows[-max(5, len(rows)//4):]
                    result = {'label': label, 'samples': len(rows),
                        'device_hz': (len(rows)-1)*1000/(rows[-1][0]-rows[0][0]) if len(rows)>1 else 0,
                        'multi_start': rows[0][2], 'multi_end': rows[-1][2],
                        'tail_velocity_mean': statistics.mean(r[10] for r in tail),
                        'tail_velocity_span': max(r[10] for r in tail)-min(r[10] for r in tail),
                        'tail_position_span': max(r[2] for r in tail)-min(r[2] for r in tail),
                        'tail_current_mean_A': statistics.mean(r[21] for r in tail)/1000,
                        'peak_current_A': max(abs(r[21]) for r in rows)/1000,
                        'peak_speed_dps': max(abs(r[10]) for r in rows),
                        'bus_min': min(r[3] for r in rows), 'fault_min': min(r[6] for r in rows)}
                    record({'metrics': result})
                    print(json.dumps(result), flush=True)
            command('cascade status')
            collect(.1, 'stats')
            if args.trace:
                command('stop')
                command('trace dump')
                collect(1.5, 'current_trace', guarding=False)
        finally:
            try:
                command('stop')
                collect(args.post_stop_seconds, 'post_stop', guarding=False)
            except Exception as exc:
                print('STOP confirmation failed:', exc, flush=True)
            print('RAW_CAPTURE=' + str(path), flush=True)


if __name__ == '__main__':
    main()
