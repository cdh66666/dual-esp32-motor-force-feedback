"""Capture the firmware's 2 kHz current-loop trace for one bounded step."""
from __future__ import annotations
import json, math, re, sys, time, urllib.request
from pathlib import Path

BASE = 'http://127.0.0.1:8766/api/'
TRACE = re.compile(r'^T,(-?\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$')

def api(endpoint, body=None):
    req = urllib.request.Request(BASE + endpoint,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)

def send(port, text):
    result = api('send', {'port':port, 'command':text, 'wait_ack':True})
    if not result.get('ok') or not result.get('acknowledged'):
        raise RuntimeError(f'{port} {text}: {result}')
    return result.get('reply','')

def logs_since(port, cursor):
    result = api(f'logs?port={port}&since={cursor}')
    return result.get('logs', []), result.get('session_id')

def collect(port, cursor, seconds, path, *, stop_on_fault=True):
    end = time.monotonic() + seconds
    rows, trace = [], []
    while time.monotonic() < end:
        entries, _ = logs_since(port, cursor)
        for entry in entries:
            cursor = max(cursor, int(entry['seq']))
            path.write_text('', encoding='utf-8') if False else None
            text = entry.get('text','')
            if entry.get('direction') != 'rx': continue
            if stop_on_fault and (text.startswith('ERR ') or text.startswith('CASCADE fault') or text.startswith('CASCADE no_')):
                raise RuntimeError(text)
            if text.startswith('S,'):
                try:
                    values = [float(v) for v in text.split(',')[1:]]
                    if len(values) >= 24 and all(math.isfinite(v) for v in values): rows.append(values)
                except ValueError: pass
            match = TRACE.match(text)
            if match:
                trace.append(tuple(float(v) for v in match.groups()))
        time.sleep(.01)
    return cursor, rows, trace

def run(port, kp, ki, target, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('w', encoding='utf-8') as out:
        def rec(obj): out.write(json.dumps(obj, ensure_ascii=False)+'\n'); out.flush()
        old = api(f'logs?port={port}&since=0').get('logs', [])
        cursor = max((int(e['seq']) for e in old), default=0)
        for text in ('stop','sleep','motorprofile 36gp555',f'cascade current {kp} {ki} 4095','stream 100'):
            rec({'command':text,'reply':send(port,text)}); time.sleep(.06)
        rec({'command':'trace arm 1024','reply':send(port,'trace arm 1024')})
        rec({'command':'wake','reply':send(port,'wake')})
        time.sleep(.05)
        rec({'command':f'current {target} 4095 1200','reply':send(port,f'current {target} 4095 1200')})
        recent = api(f'logs?port={port}&since=0').get('logs', [])
        cursor = max((int(e['seq']) for e in recent), default=cursor)
        cursor, samples, trace = collect(port,cursor,.34,output)
        send(port,'stop'); time.sleep(.12)
        rec({'command':'trace dump','reply':send(port,'trace dump')})
        cursor, _, dumped = collect(port,cursor,1.2,output,stop_on_fault=False)
        rec({'telemetry_samples':len(samples),'trace_samples':len(dumped)})
        signed = [x[2] for x in dumped]
        if signed:
            tail = signed[len(signed)//2:]
            mean = sum(tail)/len(tail)
            rec({'metrics':{'port':port,'kp':kp,'ki':ki,'target_A':target/1000,
                'trace_samples':len(dumped),'tail_mean_A':mean,
                'tail_ripple_pp_A':max(tail)-min(tail),
                'tail_ripple_rms_A':math.sqrt(sum((x-mean)**2 for x in tail)/len(tail)),
                'peak_abs_A':max(abs(x) for x in signed),
                'peak_abs_pwm':max(abs(x[3]) for x in dumped)}})
        rec({'cleanup_stop':send(port,'stop'),'cleanup_sleep':send(port,'sleep')})

if __name__ == '__main__':
    if len(sys.argv) != 5: raise SystemExit('usage: current_trace_api.py PORT KP KI TARGET_MA')
    port,kp,ki,target = sys.argv[1],float(sys.argv[2]),float(sys.argv[3]),float(sys.argv[4])
    stamp = time.strftime('%Y%m%d-%H%M%S')
    run(port,kp,ki,target,Path(__file__).resolve().parents[1]/'evidence'/'current-loop'/f'{stamp}-{port}-kp{kp:g}-ki{ki:g}.jsonl')
