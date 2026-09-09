"""Log a real USB stream while issuing read-only queries. Never starts a motor."""
import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port',required=True)
    p.add_argument('--seconds',type=float,default=120)
    p.add_argument('--hz',type=float,default=20)
    args=p.parse_args()
    if not 1 <= args.seconds <= 600 or not 1 <= args.hz <= 40: p.error('invalid duration/rate')
    url='http://127.0.0.1:8766/api/'
    folder=Path(__file__).resolve().parents[1]/'evidence/link-stability'
    folder.mkdir(parents=True,exist_ok=True)
    stamp=time.strftime('%Y%m%d-%H%M%S')
    def api(endpoint,body=None):
        req=urllib.request.Request(url+endpoint,data=None if body is None else json.dumps(body).encode(),
                                   headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=4) as r: return json.load(r)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'HTTP {exc.code}: '+exc.read().decode('utf-8','replace')) from exc
    def send(command):
        result=api('send',{'port':args.port,'command':command,'wait_ack':True})
        if not result.get('acknowledged'): raise RuntimeError(result)
        return result['reply']
    model=None; cursor=0; session_id=None; loop_duration=0; before_diagnostics=[]
    samples=[]; latencies=[]; failures=[]; diagnostics=[]; error=None
    start=time.monotonic();next_print=start+10
    with (folder/(stamp+'-raw.jsonl')).open('w',encoding='utf-8') as out:
        try:
            api('connect',{'port':args.port})
            send('stop');send('sleep');send('stream 100')
            model=send('model');send('cascade status')
            time.sleep(.15)
            snapshot=api('logs?port='+args.port+'&since=0')
            before_diagnostics=[r['text'] for r in snapshot['logs'] if r['direction']=='rx' and
                                r['text'].startswith(('LINK_STATS ','USB_RECOVERY ','USB_TX_STATS ','USB_DCD_GUARD '))][-4:]
            cursor=max((x['seq'] for x in snapshot['logs']),default=0)
            session_id=snapshot['session_id']
            start=time.monotonic(); next_print=start+10
            while time.monotonic()-start < args.seconds:
                tick=time.monotonic()
                reply=send('model')
                latencies.append((time.monotonic()-tick)*1000)
                payload=api('logs?port='+args.port+'&since='+str(cursor))
                if payload['session_id']!=session_id: raise RuntimeError('serial session replaced')
                for row in payload['logs']:
                    if row['seq']<=cursor:continue
                    cursor=row['seq'];out.write(json.dumps(row,ensure_ascii=False)+'\n')
                    text=row['text']
                    if row['direction']=='error' or text.startswith('link stalled'):failures.append(row)
                    if row['direction']=='rx' and text.startswith('S,'):
                        fields=list(map(float,text.split(',')[1:]))
                        if len(fields)<13: raise RuntimeError('incomplete sample frame')
                        if samples and fields[0]<=samples[-1][0]:raise RuntimeError('MCU restarted/nonmonotonic timestamps')
                        if fields[5]!=0 or fields[7]!=0:raise RuntimeError('unexpected enabled actuator')
                        samples.append(fields)
                if time.monotonic()>=next_print:
                    out.flush();print(json.dumps({'elapsed_s':round(time.monotonic()-start,1),'queries':len(latencies),'frames':len(samples),'errors':len(failures)}),flush=True)
                    next_print+=10
                time.sleep(max(0,1/args.hz-(time.monotonic()-tick)))
            loop_duration=time.monotonic()-start
            send('cascade status')
            time.sleep(.15)
            tail=api('logs?port='+args.port+'&since='+str(cursor))
            diagnostics=[r['text'] for r in tail['logs'] if r['direction']=='rx' and not r['text'].startswith('S,')]
        except Exception as exc:
            error=repr(exc)
            loop_duration=time.monotonic()-start
        finally:
            try:
                tail=api('logs?port='+args.port+'&since='+str(cursor))
                for row in tail['logs']:
                    if row['seq']<=cursor: continue
                    cursor=row['seq']
                    out.write(json.dumps(row,ensure_ascii=False)+'\n')
                    if row['direction']=='error' or row['text'].startswith('link stalled'): failures.append(row)
                diagnostics=[r['text'] for r in tail['logs'] if r['direction']=='rx' and not r['text'].startswith('S,')]
            except Exception as exc:
                diagnostics.append('Unable to capture final logs: '+repr(exc))
            try: send('stop');send('sleep')
            except Exception as exc: error=error or repr(exc)
            # Keep errors that arrive while the final STOP is waiting too,
            # including Windows handle cancellation following MCU restart.
            try:
                tail=api('logs?port='+args.port+'&since='+str(cursor))
                if session_id and tail['session_id']!=session_id:
                    error=error or 'serial session replaced during final STOP'
                for row in tail['logs']:
                    if row['seq']<=cursor: continue
                    cursor=row['seq'];out.write(json.dumps(row,ensure_ascii=False)+'\n')
                    if row['direction']=='error' or row['text'].startswith('link stalled'): failures.append(row)
            except Exception as exc:
                diagnostics.append('Unable to capture post-STOP logs: '+repr(exc))
    gaps=[b[0]-a[0] for a,b in zip(samples,samples[1:])]
    rate=(len(samples)-1)*1000/(samples[-1][0]-samples[0][0]) if len(samples)>1 else 0
    gates={'full_duration':loop_duration>=args.seconds,
           'sample_coverage':len(samples)>=args.seconds*98,
           'telemetry_98_to_102_hz':98<=rate<=102,
           'no_gap_over_50ms':bool(gaps) and max(gaps)<=50,
           'query_coverage_95pct':len(latencies)>=args.seconds*args.hz*.95,
           'no_errors':error is None and not failures}
    report={'kind':'real-usb-motor-disabled','version':model,'port':args.port,'motor_tested':False,
            'duration_s':round(loop_duration,3),'requested_duration_s':args.seconds,
            'queries':len(latencies),'requested_query_hz':args.hz,
            'frames':len(samples),'telemetry_hz':rate,
            'max_frame_gap_ms':max(gaps,default=0),'gap_over_20ms':sum(x>20 for x in gaps),
            'median_ack_ms':statistics.median(latencies) if latencies else None,
            'max_ack_ms':max(latencies,default=0),'errors':failures,'fatal':error,'diagnostics':diagnostics,
            'before_diagnostics':before_diagnostics,'acceptance_gates':gates,
            'passed':all(gates.values())}
    path=folder/(stamp+'-report.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True);print(path,flush=True)
    return 0 if report['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
