"""DATA transport over one USB. No device is woken by discovery."""
import re
import time
import threading


class RemoteRejected(RuntimeError):
    pass


class RemoteTimeout(TimeoutError):
    pass


def decode_reply(text, address, sequence, command):
    match = re.fullmatch(r'BUS_RX from=(\d+) type=(\d+) seq=(\d+) payload=(.*)', text)
    if not match or int(match[1]) != address or int(match[3]) != sequence:
        return None
    kind, payload = int(match[2]), match[4]
    if kind == 2 and payload.startswith(f'NACK,{sequence},'):
        raise RemoteRejected(payload)
    if command == 'ping':
        pong = re.fullmatch(r'PONG,addr=(\d+),uid=([0-9a-fA-F]+)', payload)
        if kind == 5 and pong and int(pong[1]) == address:
            return {'address': address, 'uid': pong[2].upper(), 'reply': payload}
    elif command == 'status':
        if kind == 3 and payload.startswith(f'STATUS,{address},'):
            return {'address': address, 'reply': payload}
    elif command == 'gatewayinfo':
        meta_v3 = re.fullmatch(r'META,(\d+),([0-9A-Fa-f]+),([\d.]+),([\d.]+),([\d.]+),3',payload)
        meta_v2 = re.fullmatch(r'META,(\d+),([0-9A-Fa-f]+),([\d.]+),([\d.]+),2',payload)
        meta = meta_v3 or meta_v2
        if kind == 2 and meta and int(meta[1]) == address:
            result = {'address':address,'uid':meta[2].upper(),'gear':float(meta[3]),
                      'current_limit':float(meta[4]),'protocol':3 if meta_v3 else 2}
            if meta_v3:
                result['model_ke'] = float(meta[5])
            return result
    elif kind == 2 and payload.startswith(f'ACK,{sequence},'):
        # Old firmware lied with "executed=" even on rejection. Fail closed.
        if ',executed=' in payload:
            raise RemoteRejected('旧固件回执不可靠，请先升级远端板')
        return {'address': address, 'reply': payload}
    return None


class ChainGateway:
    def __init__(self, session):
        self.session = session
        self.lock = threading.Lock()
        # DATA identity is immutable for a live USB session in normal use.
        # Keeping it for a short, session/epoch-scoped window removes one
        # round-trip from every slider update without allowing a stale UID to
        # cross a reconnect or STOP epoch.  The cache is deliberately local to
        # this gateway; it is never persisted or shared between USB ports.
        self._cache_lock = threading.RLock()
        self._meta_cache = {}
        self._awake_cache = {}
        self._meta_ttl = 5.0
        self._awake_ttl = 10.0

    def invalidate_cache(self):
        with self._cache_lock:
            self._meta_cache.clear()
            self._awake_cache.clear()

    def _cache_key(self, address, expected_session_id, expected_epoch):
        return (int(address), str(expected_session_id),
                None if expected_epoch is None else int(expected_epoch))

    def metadata(self, address, expected_session_id, expected_epoch=None,
                 timeout=1.0):
        """Return gateway identity, avoiding duplicate DATA META queries."""
        key = self._cache_key(address, expected_session_id, expected_epoch)
        now = time.monotonic()
        with self._cache_lock:
            entry = self._meta_cache.get(key)
            if entry and now < entry[0]:
                return dict(entry[1])
        result = self.request(address, 'gatewayinfo', expected_session_id,
                              timeout=timeout, expected_epoch=expected_epoch)
        with self._cache_lock:
            self._meta_cache[key] = (time.monotonic() + self._meta_ttl,
                                     dict(result))
        return result

    def remote_awake(self, address, expected_session_id, expected_epoch=None):
        key = self._cache_key(address, expected_session_id, expected_epoch)
        with self._cache_lock:
            entry = self._awake_cache.get(key)
            return bool(entry and time.monotonic() < entry)

    def mark_awake(self, address, expected_session_id, expected_epoch=None):
        key = self._cache_key(address, expected_session_id, expected_epoch)
        with self._cache_lock:
            self._awake_cache[key] = time.monotonic() + self._awake_ttl

    def mark_asleep(self, address, expected_session_id, expected_epoch=None):
        key = self._cache_key(address, expected_session_id, expected_epoch)
        with self._cache_lock:
            self._awake_cache.pop(key, None)

    def mark_stopped(self, address, expected_session_id, expected_epoch=None,
                     previously_awake=False):
        """A STOP zeros torque but does not wake a sleeping remote driver."""
        if previously_awake:
            self.mark_awake(address, expected_session_id, expected_epoch)
        else:
            self.mark_asleep(address, expected_session_id, expected_epoch)

    def request(self, address, command, expected_session_id, timeout=1.0, expected_epoch=None):
        if not 1 <= address <= 254 or not command or len(command.encode('ascii')) > 96:
            raise ValueError('DATA 地址或负载长度无效')
        s = self.session
        if not self.lock.acquire(timeout=timeout):
            raise RuntimeError('网关忙；本次命令未发送')
        try:
            if not s.ack_lock.acquire(timeout=timeout):
                raise RuntimeError('USB 忙；本次命令未发送')
            try:
                with s.lifecycle_lock:
                    ser, epoch = s.ser, s.command_epoch
                    if expected_epoch is not None and epoch != expected_epoch:
                        raise RuntimeError('STOP 已取消旧网关目标')
                    if s.session_id != expected_session_id or not ser or not ser.is_open:
                        raise RuntimeError('USB 会话已变化；未发送旧命令')
                with s.lock:
                    cursor = s.seq
                # Keep the USB acknowledgement lock until the REMOTE reply.
                ack = s._send_and_wait(f'bus {address} {command}',
                                       f'OK bus_tx dest={address} ', timeout, ser, epoch)
                seq_match = re.search(r' seq=(\d+) ', ack)
                if not seq_match:
                    raise RuntimeError('网关缺少事务序号')
                sequence = int(seq_match[1])
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    if s.ser is not ser or not ser.is_open or s.command_epoch != epoch:
                        raise RuntimeError('STOP 或断线取消了网关事务')
                    with s.changed:
                        for entry in s.logs:
                            if entry['seq'] <= cursor or entry['direction'] != 'rx':
                                continue
                            result = decode_reply(entry['text'], address, sequence, command)
                            if result is not None:
                                return result
                        s.changed.wait(.02)
                raise RemoteTimeout(f'DATA 地址 {address} 无有效回执；不能据此断言物理不存在')
            finally:
                s.ack_lock.release()
        finally:
            self.lock.release()

    def scan(self, expected_session_id, first=1, last=254):
        if not 1 <= first <= last <= 254:
            raise ValueError('扫描范围必须在 1..254')
        local = self.session.send_checked('businfo', expected_session_id=expected_session_id)
        match = re.search(r'BUS addr=(\d+) uid=([0-9a-fA-F]+)', local)
        if not match:
            raise RuntimeError('无法读取网关身份')
        local_address = int(match[1])
        found = [{'address': local_address, 'uid': match[2].upper(), 'local': True}]
        unanswered = []
        for address in range(first, last + 1):
            if address == local_address:
                continue
            try:
                result = self.request(address, 'ping', expected_session_id, timeout=.35)
                found.append({**result, 'local': False})
            except RemoteTimeout:
                unanswered.append(address)
        return {'devices': found, 'unanswered': unanswered, 'session_id': expected_session_id,
                'note': '未响应不等于不存在；同地址冲突尚不能自动解决'}
