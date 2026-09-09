"""Bounded STOP/sleep/wake acknowledgement test; no PWM/motion requests."""
import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port',required=True)
parser.add_argument('--cycles',type=int,default=0,help='explicit nonzero count enables stopped-driver cycling')
args=parser.parse_args()
if not 0<=args.cycles<=50: raise ValueError('cycles must be 0..50')
base='http://127.0.0.1:8766/api/'
events=[]
def request(endpoint,body=None):
    req=urllib.request.Request(base+endpoint,data=None if body is None else json.dumps(body).encode(),
                               headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=4) as response:return json.load(response)
def send(command):
    start=time.monotonic()
    result=request('send',{'port':args.port,'command':command,'wait_ack':True})
    elapsed=(time.monotonic()-start)*1000
    events.append({'command':command,'ack_ms':elapsed,**result})
    if not result.get('acknowledged'):raise RuntimeError(result)
    return result['reply']
ports=request('ports')['ports']
selected=[p for p in ports if p['port']==args.port and p['present'] and p['active']]
if len(selected)!=1:raise RuntimeError('Specified active port not found')
try:
    send('stop')
    for _ in range(args.cycles):
        send('sleep');send('wake');send('stop')
        status=send('status')
        if 'pwm=0/4095' not in status or 'control=idle' not in status or 'nFAULT=1' not in status:
            raise RuntimeError('Nonzero/faulted state in stopped-driver test: '+status)
    send('cascade status')
finally:
    send('stop')
    folder=Path(__file__).resolve().parents[1]/'evidence'/'commissioning'
    folder.mkdir(parents=True,exist_ok=True)
    dest=folder/(time.strftime('%Y%m%d-%H%M%S')+'-link-ack.json')
    dest.write_text(json.dumps({'port':args.port,'usb':selected[0]['hwid'],'events':events},indent=2)+'\n',encoding='utf-8')
print(json.dumps({'cycles':args.cycles,'ack_count':len(events),'mean_ack_ms':statistics.mean(e['ack_ms'] for e in events),
                  'max_ack_ms':max(e['ack_ms'] for e in events),'evidence':str(dest)}))
