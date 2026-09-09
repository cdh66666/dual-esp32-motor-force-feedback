"""Save current API state and read-only board diagnostics; never resets/wakes."""
import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', required=True)
args = parser.parse_args()
base = 'http://127.0.0.1:8766/api/'
def api(endpoint, body=None):
    request = urllib.request.Request(base + endpoint,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')
        try: detail = json.loads(detail)
        except ValueError: pass
        return {'http_status': error.code, 'detail': detail}
    except Exception as error:
        return {'error': repr(error)}

result = {'host_time': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'port': args.port}
result['before_ports'] = api('ports')
result['before_logs'] = api('logs?port=' + args.port + '&since=0')
result['queries'] = {}
for command in ('model', 'cascade status', 'diag', 'knob status', 'status'):
    result['queries'][command] = api('send', {'port': args.port, 'command': command, 'wait_ack': True})
time.sleep(.2)
result['after_ports'] = api('ports')
result['after_logs'] = api('logs?port=' + args.port + '&since=0')
folder = Path(__file__).resolve().parents[1] / 'evidence/link-stability'
folder.mkdir(parents=True, exist_ok=True)
path = folder / (time.strftime('%Y%m%d-%H%M%S') + '-state.json')
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(path)
