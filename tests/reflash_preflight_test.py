"""Pure validation tests: no serial writes, USB resets or HTTP requests."""
import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from reflash_board import verify_passive_off, verify_flash_state


class PreflightTest(unittest.TestCase):
    def test_attached_guarded_is_explicit_and_requires_idle(self):
        s='STATUS bus=19.7V awake=0 pwm=0/4095 control=idle velocity=0.0deg/s nFAULT=1'
        with self.assertRaises(RuntimeError): verify_flash_state(s)
        self.assertEqual(verify_flash_state(s, attached_guarded=True),19.7)
        for a,b in [('awake=0','awake=1'),('pwm=0/','pwm=1/'),('velocity=0.0','velocity=2.0'),('nFAULT=1','nFAULT=0'),('control=idle','control=current'),('19.7V','22V')]:
            with self.assertRaises(RuntimeError): verify_flash_state(s.replace(a,b), attached_guarded=True)
    def inputs(self):
        health = {'active':True, 'reader_alive':True, 'sample_age_ms':5}
        def frame(t):
            return {'session_id':'live', 'logs':[{'session_id':'live', 'direction':'rx',
                'text':f'S,{t},0,0,0.28,0,0,1,0,0,0,0,0,0'}]}
        return health, frame(1000), frame(1060)

    def test_only_advancing_off_samples_pass(self):
        self.assertEqual(verify_passive_off(*self.inputs())['mcu_ms'], [1000,1060])

    def test_unknown_stale_or_mixed_session_rejected(self):
        for age in [None, -1, 251, float('nan')]:
            h,a,b=self.inputs();h['sample_age_ms']=age
            with self.assertRaises(RuntimeError): verify_passive_off(h,a,b)
        h,a,b=self.inputs();b['session_id']='replaced'
        with self.assertRaises(RuntimeError): verify_passive_off(h,a,b)
        h,a,b=self.inputs()
        with self.assertRaises(RuntimeError): verify_passive_off(h,a,copy.deepcopy(a))

    def test_power_awake_pwm_incomplete_or_invalid_rejected(self):
        for index,value in [(3,19.5),(5,1),(7,1),(3,float('nan'))]:
            h,a,b=self.inputs()
            fields=b['logs'][0]['text'].split(',')
            fields[index+1]=str(value)
            b['logs'][0]['text']=','.join(fields)
            with self.assertRaises(RuntimeError): verify_passive_off(h,a,b)
        h,a,b=self.inputs();b['logs'][0]['text']='S,1060,0,0'
        with self.assertRaises(RuntimeError): verify_passive_off(h,a,b)


if __name__=='__main__': unittest.main()
