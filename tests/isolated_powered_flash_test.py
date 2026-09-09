import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('reflash',Path(__file__).resolve().parents[1]/'tools/reflash_board.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class StateTest(unittest.TestCase):
    def test_default_rejects_powered(self):
        with self.assertRaises(RuntimeError): module.verify_flash_state('STATUS bus=20.0V awake=0 pwm=0/4095')
    def test_isolated(self):
        self.assertEqual(module.verify_flash_state('STATUS bus=20.0V awake=0 pwm=0/4095',True),20)
        for state in ['bus=20V awake=1 pwm=0/4095','bus=20V awake=0 pwm=2/4095','bus=24V awake=0 pwm=0/4095','bus=0V awake=0 pwm=0/4095','awake=0 pwm=0/4095']:
            with self.assertRaises(RuntimeError): module.verify_flash_state(state,True)
    def test_off(self):
        self.assertEqual(module.verify_flash_state('STATUS bus=0.1V awake=0 pwm=0/4095'),.1)
if __name__=='__main__': unittest.main()
