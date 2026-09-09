"""Offline only: inspect fault telemetry; never open a motor connection."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def analyze(path):
    records = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
    samples = []
    for row in records:
        text = row.get('text', '')
        if text.startswith('S,'):
            s = text.split(',')
            samples.append(dict(ms=float(s[1]), bus=float(s[4]),
                                speed=float(s[11])/5.2, target=float(s[21])/1000,
                                current=float(s[22])/1000, pwm=float(s[23])))
    drop = next((s for s in samples if s['bus'] < 18), None)
    nominal = [s for s in samples if s['bus'] >= 18 and (not drop or s['ms'] < drop['ms'])]
    # Hysteresis excludes noisy near-zero speed sign changes.
    reversals = []
    sign = 0
    for s in nominal:
        new = 1 if s['speed'] > 100 else -1 if s['speed'] < -100 else 0
        if new and sign and new != sign:
            reversals.append(s)
        if new:
            sign = new
    return dict(file=path.name, header=records[0], samples=len(samples),
                first_below_18V=drop, nominal_speed_reversals_above_100dps=reversals,
                nominal_peak_output_dps=max((abs(s['speed']) for s in nominal), default=0),
                last_samples=samples[-25:],
                limitations='100 Hz USB telemetry, not supply input current or oscilloscope; hand torque unmeasured')


if __name__ == '__main__':
    result = [analyze(p) for p in sorted((ROOT/'evidence/fault-captures').glob('20260908-155920-*.jsonl'))]
    out = ROOT/'evidence/commissioning/20260908-force-incident-analysis.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    for r in result:
        print(r['file'], 'reversals before drop:', len(r['nominal_speed_reversals_above_100dps']),
              'peak output dps:', round(r['nominal_peak_output_dps'], 1), 'drop:', r['first_below_18V'])
