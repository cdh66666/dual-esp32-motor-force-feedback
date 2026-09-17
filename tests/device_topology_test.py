import sys, tempfile, threading, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'web'))
from device_topology import DeviceTopology, DEFAULTS

class Board:
    def __init__(self,port,spec):
        self.port=port;self.session_id=port+'session';self.uid=spec['uid'];self.address=spec['address']
        self.lifecycle_lock=threading.RLock();self.commands=[];self.reject_write=False
    def send_checked(self,c,expected_session_id=None):
        if expected_session_id!=self.session_id: raise RuntimeError('session mismatch')
        self.commands.append(c)
        if c=='businfo': return f'BUS addr={self.address} uid={self.uid} baud=1000000'
        if c=='status': return 'STATUS awake=0 pwm=0/4095 control=idle'
        if c.startswith('busaddr '):
            if not self.reject_write:self.address=int(c.split()[1])
            return 'OK busaddr='+str(self.address)
        return 'OK'

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'ids.json';self.registry=DeviceTopology(self.path)
        self.a=Board('COM4',DEFAULTS[0]);self.b=Board('COM23',DEFAULTS[1])
    def assign(self,n,uid=None,boards=None):
        return self.registry.assign(boards or [self.a,self.b],self.a.port,self.a.session_id,uid or self.a.uid,n)
    def test_assignment_persists_and_stops(self):
        r=self.assign(7);self.assertEqual(r['address'],7)
        self.assertLess(self.a.commands.index('sleep'),self.a.commands.index('busaddr 7'))
        self.assertIn('sleep',self.b.commands)
        self.assertEqual(DeviceTopology(self.path).snapshot()[0]['address'],7)
        self.assertIsNone(self.a.id_config_owner)
    def test_conflict_no_write(self):
        with self.assertRaisesRegex(ValueError,'占用'):self.assign(1)
        self.assertFalse(any(c.startswith('busaddr') for c in self.a.commands))
    def test_identity_no_write(self):
        with self.assertRaisesRegex(ValueError,'身份'):self.assign(7,uid=self.b.uid)
    def test_two_boards_required(self):
        with self.assertRaisesRegex(ValueError,'两块'):self.assign(7,boards=[self.a])
    def test_invalid_id(self):
        for n in (0,255,1.5,True):
            with self.assertRaises(ValueError):self.assign(n)
    def test_bad_readback_not_saved(self):
        self.a.reject_write=True
        with self.assertRaisesRegex(RuntimeError,'回读'):self.assign(7)
        self.assertFalse(self.path.exists());self.assertIsNone(self.a.id_config_owner)
    def test_same_id_does_not_write_flash(self):
        self.assign(184)
        self.assertFalse(any(c.startswith('busaddr') for c in self.a.commands))

if __name__=='__main__':unittest.main()
