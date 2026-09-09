"""Low-speed +/- current dither to tune the inner loop without free-running."""
from __future__ import annotations
import json, math, re, sys, time, urllib.request
from pathlib import Path

BASE='http://127.0.0.1:8766/api/'
TR=re.compile(r'^T,(-?\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$')

def api(ep, body=None):
    req=urllib.request.Request(BASE+ep, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=5) as r: return json.load(r)
def cmd(port, text):
    r=api('send', {'port':port,'command':text,'wait_ack':True})
    if not r.get('ok') or not r.get('acknowledged'): raise RuntimeError(r)
    return r.get('reply','')
def run(port,kp,ki,target,path):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w',encoding='utf-8') as out:
      def rec(x): out.write(json.dumps(x,ensure_ascii=False)+'\n'); out.flush()
      old=api(f'logs?port={port}&since=0').get('logs',[]); cursor=max((int(x['seq']) for x in old),default=0)
      for x in ('stop','sleep','motorprofile 36gp555',f'cascade current {kp} {ki} 4095','stream 100'):
          rec({'command':x,'reply':cmd(port,x)}); time.sleep(.05)
      rec({'command':'trace arm 1024','reply':cmd(port,'trace arm 1024')})
      rec({'command':'wake','reply':cmd(port,'wake')}); time.sleep(.05)
      # The profile's 10 A/s reference slew reaches 250 mA in 25 ms. Keep
      # each half-cycle long enough to settle while cancelling net rotation.
      for i in range(12):
          value=target if i%2==0 else -target
          rec({'command':f'current {value} 4095 300','reply':cmd(port,f'current {value} 4095 300')})
          time.sleep(.14)
      rec({'command':'stop','reply':cmd(port,'stop')}); time.sleep(.12)
      rec({'command':'trace dump','reply':cmd(port,'trace dump')})
      end=time.monotonic()+1.5; trace=[]
      while time.monotonic()<end:
          entries=api(f'logs?port={port}&since={cursor}').get('logs',[])
          for e in entries:
              cursor=max(cursor,int(e['seq'])); m=TR.match(e.get('text',''))
              if m: trace.append(tuple(float(v) for v in m.groups()))
          time.sleep(.01)
      if trace:
          tail=trace[len(trace)//4:]
          refs=[x[1] for x in tail]; vals=[x[2] for x in tail]
          errors=[v-r for r,v in zip(refs,vals)]
          mean=sum(errors)/len(errors)
          rec({'metrics':{'samples':len(trace),'tail_error_mean_A':mean,
              'tail_error_rms_A':math.sqrt(sum(x*x for x in errors)/len(errors)),
              'tail_measured_pp_A':max(vals)-min(vals),'peak_abs_A':max(abs(x[2]) for x in trace),
              'peak_abs_pwm':max(abs(x[3]) for x in trace)}})
      rec({'cleanup_stop':cmd(port,'stop'),'cleanup_sleep':cmd(port,'sleep')})
if __name__=='__main__':
    if len(sys.argv)!=5: raise SystemExit('usage: current_dither_trace.py PORT KP KI TARGET_MA')
    p,kp,ki,t=sys.argv[1],float(sys.argv[2]),float(sys.argv[3]),float(sys.argv[4])
    run(p,kp,ki,t,Path(__file__).resolve().parents[1]/'evidence'/'current-loop'/(time.strftime('%Y%m%d-%H%M%S')+f'-{p}-dither-kp{kp:g}-ki{ki:g}.jsonl'))
