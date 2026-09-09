"""Offline process identification; never writes to a live board.

Fit I = acceleration/Kt_over_J + viscous*w + Coulomb*sign(w)
        + periodic rotor-angle load. Hold out complete revolutions, not random
adjacent samples. A repeatable fit is not proof of encoder/output accuracy.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.optimize import lsq_linear

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('path', type=Path)
parser.add_argument('--harmonics', type=int, default=18)
args = parser.parse_args()
entries = [json.loads(line) for line in args.path.read_text(encoding='utf-8').splitlines()]
labels = sorted({e.get('label') for e in entries if ':velocity:' in e.get('label','')})
design, measurements, turns = [], [], []
for label in labels:
    rows = np.array([list(map(float,e['text'].split(',')[1:])) for e in entries
                    if e.get('label') == label and e.get('text','').startswith('S,')])
    rows = rows[rows[:,11] == 2]
    _, unique = np.unique(rows[:,0], return_index=True)
    rows = rows[np.sort(unique)]
    if len(rows)<80: continue
    t=rows[:,0]/1000
    dt=np.median(np.diff(t))
    w=gaussian_filter1d(rows[:,10], 0.6)
    alpha=np.gradient(w,t)
    angle=rows[:,1]*np.pi/180
    X=np.column_stack([alpha, w, np.sign(w), np.ones(len(t))] +
        [f(k*angle) for k in range(1,args.harmonics+1) for f in (np.sin,np.cos)])
    keep=(t>t[0]+.4)&(t<t[-1]-.1)&(np.abs(w)>80)
    design.append(X[keep]); measurements.append(rows[keep,21]/1000)
    turns.append(np.floor(rows[keep,2]/360).astype(int))
X=np.vstack(design); y=np.concatenate(measurements); revolutions=np.concatenate(turns)
test=revolutions%3==0
lo=np.array([1e-7,0,0,-.1]+[-.4]*(2*args.harmonics))
hi=np.array([1e-3,.002,.5,.1]+[.4]*(2*args.harmonics))
scale=np.sqrt(np.mean(X[~test]**2,axis=0));scale[scale<1e-9]=1
fit=lsq_linear(X[~test]/scale,y[~test],bounds=(lo*scale,hi*scale))
coef=fit.x/scale
metrics={}
for key,keep in [('train',~test),('held_out_turns',test)]:
    predicted=X[keep]@coef
    residual=y[keep]-predicted
    metrics[key]={'samples':int(keep.sum()),'R2':float(1-np.var(residual)/np.var(y[keep])),
                  'RMSE_A':float(np.sqrt(np.mean(residual**2)))}
theta=np.linspace(0,2*np.pi,721)
periodic=np.column_stack([f(k*theta) for k in range(1,args.harmonics+1) for f in (np.sin,np.cos)])@coef[4:]
result={'source':args.path.name,'method':'bounded LS, entire revolutions held out',
        'acceleration_per_A_dps2':float(1/coef[0]),'viscous_A_per_dps':float(coef[1]),
        'coulomb_A':float(coef[2]),'offset_A':float(coef[3]),'metrics':metrics,
        'periodic_peak_A':float(np.max(np.abs(periodic))),
        'harmonics':[{'k':k,'sin_A':float(coef[2+2*k]),'cos_A':float(coef[3+2*k]),
                     'amplitude_A':float(np.hypot(coef[2+2*k],coef[3+2*k]))} for k in range(1,args.harmonics+1)]}
print(json.dumps(result,indent=2))
destination=args.path.with_suffix('.rotor-fit.json')
destination.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
