"""Build + offline tests only. Never flashes, opens serial or calls live APIs."""
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ('interaction-guard', ['cmd', '/c', 'tests\\interaction_guard_test.cmd'], ROOT),
    ('interaction-warning-ui', ['node', 'tests/interaction_ui_test.cjs'], ROOT),
    ('firmware-build-only', [sys.executable, '-m', 'platformio', 'run', '-e', 'esp32-s3-devkitc-1'], ROOT/'firmware'),
    ('control-math', ['cmd', '/c', 'tests\\control_math_test.cmd'], ROOT),
    ('haptic-math-simulated-mechanics', ['cmd', '/c', 'tests\\haptic_knob_test.cmd'], ROOT),
    ('server-fake-serial-contracts', [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'server*test.py'], ROOT),
    ('chain-gateway-cache', [sys.executable, 'tests/chain_gateway_cache_test.py'], ROOT),
    ('session-fake-serial-lifecycle', [sys.executable, 'tests/server_session_lifecycle_test.py'], ROOT),
    ('browser-data-contract', ['node', 'tests/dashboard_data_contract_test.js'], ROOT),
    ('browser-timed-motion-and-throttle', ['node', 'tests/timed_motion_reset_smoke.js'], ROOT),
    ('browser-output-and-haptics', ['node', 'tests/output_haptic_contract_test.js'], ROOT),
    ('browser-link-recovery', ['node', 'tests/link_recovery_ui_test.js'], ROOT),
    ('fault-capture-isolated', [sys.executable, 'tests/fault_capture_test.py'], ROOT),
]

def main():
    results = []
    for name, command, cwd in CASES:
        print('OFFLINE CHECK: ' + name, flush=True)
        started = time.perf_counter()
        try:
            p = subprocess.run(command, cwd=cwd, text=True, encoding='utf-8', errors='replace',
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
            passed, output = p.returncode == 0, p.stdout
        except (subprocess.TimeoutExpired, OSError) as exc:
            passed, output = False, str(exc)
        results.append({'name':name,'passed':passed,'duration_s':time.perf_counter()-started,'output':output})
        print(output[-3000:], flush=True)
    binary = ROOT/'firmware/.pio/build/esp32-s3-devkitc-1/firmware.bin'
    version = re.search(r'FW_VERSION = "([^"]+)"', (ROOT/'firmware/src/main.cpp').read_text(encoding='utf-8')).group(1)
    report = {'version':version,'offline':True,'flashed':False,
              'physical_acceptance':False,'passed':all(x['passed'] for x in results),
              'firmware_sha256':hashlib.sha256(binary.read_bytes()).hexdigest() if results[0]['passed'] and binary.exists() else None,
              'tests':results}
    folder = ROOT/'evidence'/'link-stability-offline'/version/time.strftime('%Y%m%d-%H%M%S')
    folder.mkdir(parents=True,exist_ok=True)
    (folder/'checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='tests'},ensure_ascii=False))
    return 0 if report['passed'] else 1

if __name__=='__main__': raise SystemExit(main())
