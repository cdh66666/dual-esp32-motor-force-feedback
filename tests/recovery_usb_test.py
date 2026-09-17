"""Port classification tests; never opens real serial ports."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from server import PortSession, recovery_usb


class RecoveryUsbTests(unittest.TestCase):
    def identity(self, serial='68:EE:8F:53:81:E4', vid=0x303A, pid=0x1001):
        return SimpleNamespace(device='MOCK_ROM', serial_number=serial, vid=vid, pid=pid)

    def test_transport_only(self):
        self.assertTrue(recovery_usb(self.identity()))
        self.assertFalse(recovery_usb(self.identity('68EE8F5381E4')))
        self.assertFalse(recovery_usb(self.identity(vid=0x1234)))
        self.assertFalse(recovery_usb(None))

    def test_reject_before_open(self):
        with patch('server.list_ports.comports', return_value=[self.identity()]), \
                patch('server.serial.Serial') as serial:
            with self.assertRaisesRegex(RuntimeError, '恢复/调试'):
                PortSession('MOCK_ROM').connect()
            serial.return_value.open.assert_not_called()


if __name__ == '__main__':
    unittest.main()
