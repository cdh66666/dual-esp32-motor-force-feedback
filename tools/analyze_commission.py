"""Reproducible plots/statistics from raw commissioning JSONL, no live writes."""
import argparse
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def process_metrics(entries):
    """Use whole segments and a full last 10 s hold, never only the endpoint."""
    reports=[]
    labels=list(dict.fromkeys(e.get('label','') for e in entries if e.get('text','').startswith('S,')))
    for label in labels:
        parts=label.split(':')
        if len(parts)!=3 or parts[1] not in {'pos','velocity','current'}: continue
        mode, target=parts[1],float(parts[2])
        rows=np.array([list(map(float,e['text'].split(',')[1:])) for e in entries
                       if e.get('label')==label and e.get('text','').startswith('S,')])
        mode_id={'current':1,'velocity':2,'pos':3}[mode]
        # Field 12 is the requested target, not the ramped inner reference.
        rows=rows[(rows[:,11]==mode_id)&np.isclose(rows[:,12],target,atol=.011)]
        if len(rows)<3: continue
        rows=rows[np.sort(np.unique(rows[:,0],return_index=True)[1])]
        t=(rows[:,0]-rows[0,0])/1000
        measured=rows[:,2] if mode=='pos' else rows[:,10] if mode=='velocity' else rows[:,21]
        error=measured-target
        report={'label':label,'samples':len(rows),'duration_s':float(t[-1]),
                'device_hz':float((len(t)-1)/t[-1]),'gap_max_ms':float(np.max(np.diff(rows[:,0]))),
                'peak_current_A':float(np.max(np.abs(rows[:,21]))/1000),
                'bus_min_V':float(np.min(rows[:,3])),'fault_samples':int(np.sum(rows[:,6]!=1))}
        tail=t>=max(0,t[-1]-min(10,t[-1]/2 if mode!='pos' else 10))
        report.update({'tail_duration_s':float(t[-1]-t[tail][0]),'tail_mean':float(np.mean(measured[tail])),
                       'tail_peak_to_peak':float(np.ptp(measured[tail])),
                       'tail_error_rms':float(np.sqrt(np.mean(error[tail]**2)))})
        if mode=='pos':
            bad=np.flatnonzero(np.abs(error)>.10)
            settled=bad[-1]+1 if len(bad) else 0
            report.update({'coordinate':'rear motor encoder degrees, NOT independent output metrology',
                'target_output_estimate_deg':target/5.2,
                'settle_band_deg':.10,'settle_s':float(t[settled]) if settled<len(t) else None,
                'overshoot_deg':float(max(0,np.max((measured-target)*np.sign(target-measured[0])))),
                'tail_max_abs_error_deg':float(np.max(np.abs(error[tail]))),
                'tail_velocity_max_dps':float(np.max(np.abs(rows[tail,10])))})
        reports.append(report)
    return reports

parser=argparse.ArgumentParser()
parser.add_argument('paths',nargs='+',type=Path)
args=parser.parse_args()
for path in args.paths:
    entries=[json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
    metrics=process_metrics(entries)
    for item in metrics: print(json.dumps(item))
    trace=np.array([list(map(float,e['text'].split(',')[1:])) for e in entries if e.get('text','').startswith('T,')])
    if len(trace):
        t=(trace[:,0]-trace[0,0])/1000
        target=trace[-1,1]
        good=np.abs(trace[:,2]-target)<=max(.003,abs(target)*.05)
        last_bad=np.flatnonzero(~good)
        settle=t[last_bad[-1]+1] if len(last_bad) and last_bad[-1]+1<len(t) else None
        direction=1 if target>=0 else -1
        reached=np.flatnonzero(trace[:,2]*direction>=abs(target)*.9)
        good10=np.abs(trace[:,2]-target)<=.01
        dwell=np.convolve(good10.astype(int),np.ones(40,dtype=int),mode='valid')
        window=np.flatnonzero(dwell==40)
        result={'file':path.name,'trace_count':len(t),'sample_hz':1e6/np.mean(np.diff(trace[:,0])),
            'gap_max_us':float(np.max(np.diff(trace[:,0]))),'target_A':float(target),
            'peak_abs_A':float(np.max(np.abs(trace[:,2]))), 'tail_mean_A':float(np.mean(trace[-200:,2])),
            'tail_span_A':float(np.ptp(trace[-200:,2])),'tail_error_rms_A':float(np.sqrt(np.mean((trace[-200:,2]-target)**2))),
            'first_90pct_ms':float(t[reached[0]]) if len(reached) else None,
            'within_10mA_20ms_start_ms':float(t[window[0]]) if len(window) else None,
            'settle5pct_ms':float(settle) if settle is not None else None}
        metrics.append(result)
        print(json.dumps(result))
        fig, axes=plt.subplots(2,1,figsize=(10,5),sharex=True,layout='constrained')
        axes[0].plot(t,trace[:,1],label='Target A'); axes[0].plot(t,trace[:,2],label='Measured A')
        axes[0].set_ylabel('Current (A)'); axes[0].legend()
        axes[1].plot(t,trace[:,3]); axes[1].set_ylabel('PWM command'); axes[1].set_xlabel('Device time (ms)')
    else:
        data=np.array([list(map(float,e['text'].split(',')[1:])) for e in entries if e.get('text','').startswith('S,') and e.get('label','') not in {'preflight','stats'}])
        if not len(data):continue
        t=(data[:,0]-data[0,0])/1000
        fig,axes=plt.subplots(3,1,figsize=(12,8),sharex=True,layout='constrained')
        axes[0].plot(t,data[:,2]/5.2,label='Encoder / 5.2');axes[0].plot(t,np.where(data[:,11]==3,data[:,12]/5.2,np.nan),'--',label='Position target')
        axes[0].set_ylabel('Output estimate (deg)');axes[0].legend()
        axes[1].plot(t,data[:,10]/1872,label='Measured rps');axes[1].plot(t,data[:,19]/1872,'--',label='Target rps');axes[1].legend();axes[1].set_ylabel('Output estimate (rps)')
        axes[2].plot(t,data[:,21]/1000,label='Measured A');axes[2].plot(t,data[:,20]/1000,'--',label='Target A');axes[2].legend();axes[2].set_ylabel('Branch current (A)');axes[2].set_xlabel('Device time (s)')
    for axis in axes:axis.grid(alpha=.3)
    fig.suptitle(path.name)
    dest=path.with_suffix('.png');fig.savefig(dest,dpi=130);plt.close(fig)
    path.with_suffix('.metrics.json').write_text(json.dumps(metrics,indent=2)+'\n',encoding='utf-8')
    print('PLOT='+str(dest))
