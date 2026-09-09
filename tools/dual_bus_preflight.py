"""No-motion, identity-checked DATA diagnostics through the running dashboard."""
import json
import re
import time
import urllib.request

BASE = 'http://127.0.0.1:8766/api/'
BOARDS = {'COM23': ('68EE8F52A79C', 1), 'COM4': ('68EE8F5381E4', 184)}


def api(endpoint, body=None):
    request = urllib.request.Request(BASE + endpoint,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def send(port, command, checked=False):
    return api('send', {'port': port, 'command': command, 'wait_ack': checked})


def query(port, command, prefix):
    before = api('logs?port=' + port + '&since=0')
    cursor = before['logs'][-1]['seq'] if before['logs'] else 0
    send(port, command)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        after = api(f'logs?port={port}&since={cursor}')
        if after['session_id'] != before['session_id']:
            raise RuntimeError('USB session changed')
        hits = [r['text'] for r in after['logs']
                if r['direction'] == 'rx' and r['text'].startswith(prefix)]
        if hits:
            return hits[-1]
        time.sleep(.02)
    raise RuntimeError(f'{port} missing response to {command}')


def counters(port):
    line = query(port, 'businfo', 'BUS addr=')
    return {key: int(value) for key, value in re.findall(r'(\w+)=(\d+)\b', line)}


def main():
    ports = {p['port']: p for p in api('ports')['ports']}
    for port, (identity, address) in BOARDS.items():
        if identity not in ports.get(port, {}).get('hwid', ''):
            raise RuntimeError(f'{port} identity mismatch')
        send(port, 'stop', True)
        send(port, 'sleep', True)
        state = send(port, 'status', True)['reply']
        if 'awake=0' not in state or 'pwm=0/' not in state:
            raise RuntimeError(f'{port} not asleep: {state}')
        if counters(port)['addr'] != address:
            raise RuntimeError(f'{port} address changed')
        print(json.dumps({'port': port, 'state': state,
            'model': send(port, 'model', True)['reply'],
            'profile': send(port, 'motorprofile status', True)['reply']}, ensure_ascii=False), flush=True)
    try:
        for baud in (115200, 250000, 500000, 750000, 1000000):
            for port in BOARDS:
                query(port, f'busbaud {baud}', 'OK busbaud=')
            for sender, receiver in (('COM23', 'COM4'), ('COM4', 'COM23')):
                before = {p: counters(p) for p in BOARDS}
                for _ in range(5):
                    send(sender, f'bus {BOARDS[receiver][1]} ping')
                    time.sleep(.30)
                after = {p: counters(p) for p in BOARDS}
                delta = {p: {k: after[p][k] - before[p][k] for k in
                    ('rx_bytes', 'valid', 'cmd_rx', 'tx', 'response_tx', 'crc_err', 'uart_err')}
                    for p in BOARDS}
                print(json.dumps({'baud': baud, 'sender': sender, 'receiver': receiver,
                    'requests': 5, 'delta': delta}), flush=True)
    finally:
        for port in BOARDS:
            try:
                query(port, 'busbaud 1000000', 'OK busbaud=')
                send(port, 'stop', True)
                send(port, 'sleep', True)
                print(json.dumps({'final_port': port, 'bus': counters(port),
                    'state': send(port, 'status', True)['reply']}), flush=True)
            except Exception as exc:
                print(json.dumps({'cleanup_error': port, 'error': str(exc)}), flush=True)


if __name__ == '__main__':
    main()
