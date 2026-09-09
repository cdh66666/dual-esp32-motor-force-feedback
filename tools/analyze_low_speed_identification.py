"""Offline identification diagnostics; never writes to serial or adopts gains.

PWM*VM is only an applied-voltage proxy. R/Ke below are provisional fits,
not terminal measurements; sampling delay, bridge losses and L*di/dt remain.
"""
import json
import math
from pathlib import Path


def solve(matrix, rhs):
    a = [list(row) + [value] for row, value in zip(matrix, rhs)]
    n = len(rhs)
    for i in range(n):
        pivot = max(range(i, n), key=lambda j: abs(a[j][i]))
        a[i], a[pivot] = a[pivot], a[i]
        if abs(a[i][i]) < 1e-10:
            raise ValueError('insufficient independent excitation')
        div = a[i][i]
        a[i] = [v / div for v in a[i]]
        for j in range(n):
            if j != i:
                ratio = a[j][i]
                a[j] = [v - ratio*w for v, w in zip(a[j], a[i])]
    return [row[-1] for row in a]


def fit(rows):
    xs = [[r['current_A'], r['motor_rad_s'], math.copysign(1, r['current_A'])] for r in rows]
    ys = [r['voltage_proxy_V'] for r in rows]
    return solve([[sum(x[i]*x[j] for x in xs) for j in range(3)] for i in range(3)],
                 [sum(x[i]*y for x, y in zip(xs, ys)) for i in range(3)])


def analyze(record):
    rows = []
    for stage in record.get('identification', []):
        tail = stage['trace'][-20:]
        mean = lambda fn: sum(fn(s) for s in tail)/len(tail)
        rows.append({'target_output_deg_s': stage['targetOutputDps'],
                     'actual_output_deg_s': mean(lambda s: s['outputDps']),
                     'current_A': mean(lambda s: s['currentA']),
                     'motor_rad_s': mean(lambda s: s['outputDps'])*5.2*math.pi/180,
                     'voltage_proxy_V': mean(lambda s: s['busV']*s['pwm']/4095)})
    result = {'port': record['port'], 'hwid': record['hwid'], 'stages': rows,
              'adopted': False, 'limitations': ['100 Hz host telemetry, no inductance identification',
              'PWM voltage proxy, not measured motor terminal voltage',
              '0.2 s segment averages do not establish mechanical steady state',
              'No continuous-current, gearbox efficiency or output torque certification']}
    if len(rows) < 10:
        result['error'] = 'incomplete experiment'
        return result
    train = [r for i, r in enumerate(rows) if i % 3 != 0]
    validation = [r for i, r in enumerate(rows) if i % 3 == 0]
    try:
        resistance, ke, brush = fit(train)
        errors = [resistance*r['current_A']+ke*r['motor_rad_s']+
                  brush*math.copysign(1, r['current_A'])-r['voltage_proxy_V'] for r in validation]
        result['provisional_fit'] = {'R_ohm': resistance, 'Ke_V_per_rad_s': ke,
                                     'signed_voltage_offset_V': brush,
                                     'held_out_voltage_rmse_V': math.sqrt(sum(e*e for e in errors)/len(errors))}
        result['physical_signs_valid'] = resistance > 0 and ke > 0 and brush >= 0
    except ValueError as exc:
        result['error'] = str(exc)
    return result


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]/'evidence'/'commissioning'
    data = json.loads((root/'20260908-bidirectional-identification.json').read_text(encoding='utf-8'))
    result = [analyze(record) for record in data]
    (root/'20260908-identification-analysis.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps([{k: v for k, v in r.items() if k not in ('stages', 'limitations', 'hwid')} for r in result], ensure_ascii=False, indent=2))
