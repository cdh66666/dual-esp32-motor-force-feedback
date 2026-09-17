"""Handoff guard tests. No real serial object is opened."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'web'))
from server import PortSession

class HandoffTests(unittest.TestCase):
    def test_hold_blocks_reopen(self):
        s=PortSession('MOCK_ONLY')
        s.phone_control=True
        with self.assertRaisesRegex(RuntimeError,'手机'):
            s.connect()
        self.assertTrue(s.health()['maintenance'])
        self.assertTrue(s.health()['phone_control'])

    def test_hold_rejects_targets_before_serial_io(self):
        s=PortSession('MOCK_ONLY')
        s.phone_control=True
        for command in ('wake','current 100 100 100','bus 1 wake'):
            with self.assertRaisesRegex(RuntimeError,'手机'):
                s.send(command)

if __name__=='__main__': unittest.main()
