"""Offline tool selection contract; no ports opened or resets performed."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from reflash_board import project_esptool, verify_flash_state


class ProjectEsptoolTests(unittest.TestCase):
    def test_uses_project_package(self):
        with patch.object(Path, 'is_file', return_value=True):
            self.assertEqual(project_esptool('test-core'),
                             Path('test-core/packages/tool-esptoolpy/esptool.py'))

    def test_missing_does_not_fall_back_to_global(self):
        with patch.object(Path, 'is_file', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'Project PlatformIO esptool missing'):
                project_esptool('missing-core')

    def test_attached_guard_reports_voltage_limit_without_changing_it(self):
        state = ('STATUS bus=24.32V velocity=0.0deg/s nFAULT=1 awake=0 '
                 'control=idle pwm=0/4095 motor_current=-14mA')
        self.assertEqual(verify_flash_state(state, attached_guarded=True,
                                            rated_voltage=24.0), 24.32)
        at_headroom = state.replace('24.32V', '25.20V')
        self.assertEqual(verify_flash_state(at_headroom, attached_guarded=True,
                                            rated_voltage=24.0), 25.2)
        above_headroom = state.replace('24.32V', '25.21V')
        with self.assertRaisesRegex(RuntimeError, '8..25.20 V in attached-guarded mode'):
            verify_flash_state(above_headroom, attached_guarded=True,
                               rated_voltage=24.0)

    def test_disconnected_motor_20v_guard_remains_unchanged(self):
        state = ('STATUS bus=20.0V velocity=0.0deg/s nFAULT=1 awake=0 '
                 'control=idle pwm=0/4095 motor_current=0mA')
        self.assertEqual(verify_flash_state(state, motor_leads_disconnected=True), 20.0)


if __name__ == '__main__':
    unittest.main()
