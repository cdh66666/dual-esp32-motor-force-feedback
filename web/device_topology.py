"""Two-board ID registry. Runtime observations, never COM numbers, own identity."""
import json
import os
import re
import threading
from pathlib import Path

DEFAULTS = [dict(serial='68EE8F5381E4', uid='E481538FEE68', address=184),
            dict(serial='68EE8F52A79C', uid='9CA7528FEE68', address=1)]

class DeviceTopology:
    def __init__(self, path):
        self.path=Path(path)
        self.lock=threading.RLock()
        self.devices={d['uid']:dict(d) for d in DEFAULTS}
        if self.path.exists():
            for d in json.loads(self.path.read_text(encoding='utf-8')):
                if d['uid'] in self.devices and type(d['address']) is int and 1<=d['address']<=254:
                    self.devices[d['uid']]['address']=d['address']

    def snapshot(self):
        with self.lock: return [dict(d) for d in self.devices.values()]

    def observe(self, reply):
        m=re.search(r'\bBUS addr=(\d+) uid=([0-9a-fA-F]+)\b',reply)
        if not m or not 1<=int(m[1])<=254: raise ValueError('无法读取设备 ID/身份')
        return m[2].upper(),int(m[1])

    def remember(self, observations):
        with self.lock:
            updated={uid:dict(d) for uid,d in self.devices.items()}
            for uid,address in observations:
                if uid not in updated: raise ValueError('设备不属于当前双板配置')
                updated[uid]['address']=address
            if updated==self.devices and self.path.exists(): return
            self.path.parent.mkdir(parents=True,exist_ok=True)
            temp=self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(list(updated.values()),ensure_ascii=False,indent=2),encoding='utf-8')
            os.replace(temp,self.path)
            self.devices=updated

    def assign(self, sessions, target_port, target_session, uid, address):
        if type(address) is not int or not 1<=address<=254: raise ValueError('设备 ID 必须是 1–254 的整数')
        with self.lock:
            if len(sessions)!=2: raise ValueError('修改 ID 时请将两块板的 USB 都接入；改完后可恢复单 USB')
            target=next((s for s in sessions if s.port==target_port and s.session_id==target_session),None)
            if not target: raise ValueError('设备会话已变化，请重新读取 ID')
            captured=[(s,s.session_id) for s in sessions]
            owner=threading.get_ident()
            try:
                for s,_ in captured:
                    with s.lifecycle_lock: s.id_config_owner=owner
                observed=[]
                for s,session in captured:
                    reply=s.send_checked('businfo',expected_session_id=session)
                    identity,current=self.observe(reply)
                    observed.append((s,identity,current))
                if {i for _,i,_ in observed}!=set(self.devices): raise ValueError('双板身份不匹配；未写入 ID')
                actual=next(i for s,i,_ in observed if s is target)
                if uid!=actual: raise ValueError('所选设备身份已变化；未写入 ID')
                if any(s is not target and a==address for s,_,a in observed): raise ValueError('此 ID 已被另一块板占用；未写入')
                for s,session in captured:
                    for command in ('stop','sync off','sleep'):
                        s.send_checked(command,expected_session_id=session)
                    status=s.send_checked('status',expected_session_id=session)
                    if not all(x in status for x in ('awake=0','pwm=0/','control=idle')):
                        raise RuntimeError('停止状态未确认；未写入 ID')
                old=next(a for s,_,a in observed if s is target)
                if old!=address:
                    target.send_checked(f'busaddr {address}',expected_session_id=target_session)
                confirmed=self.observe(target.send_checked('businfo',expected_session_id=target_session))
                if confirmed!=(uid,address): raise RuntimeError('ID 写入后回读不匹配；请重新读取，未声明成功')
                self.remember([(i,address if s is target else a) for s,i,a in observed])
                return dict(ok=True,uid=uid,address=address,previous=old,devices=self.snapshot(),
                            note='双板已停止；ID 已回读并保存。热点入口 ID 在下次板端重启后更新。')
            finally:
                for s,_ in captured:
                    with s.lifecycle_lock: s.id_config_owner=None
