"""Offline command validation and critical firmware-path regression checks."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'web'))
import server


class SettingsTest(unittest.TestCase):
    def test_ack(self):
        self.assertEqual(server.command_reply_prefix('motorset 24 1 5.2'), 'OK motorset ')

    def test_limits(self):
        for command in ('motorset 24 1 5.2', 'motorset 3 0.1 1'):
            self.assertEqual(server.validate_command(command), command)
        for command in ('motorset 25 1 5.2', 'motorset 20 8 5.2', 'motorset 20 1 0',
                        'motorset nan 1 5.2', 'motorset 20 1 5.2 wake'):
            with self.assertRaises(ValueError):
                server.validate_command(command)

    def test_force_not_on_manual_slew_or_auto_rearm(self):
        source = (ROOT/'firmware/src/main.cpp').read_text(encoding='utf-8')
        guard = (ROOT/'firmware/include/interaction_guard.h').read_text(encoding='utf-8')
        self.assertIn('syncMotionArmed && syncMode == SYNC_FORCE\n          ? modelTargetCurrentAmps', source)
        self.assertIn('keepSyncArmed = syncMotionArmed && syncMode != SYNC_FORCE', source)
        self.assertIn('nowMs - syncForceStartedMs >= 60000', source)
        # Supply protection is shared by current/knob/force modes.  It compares
        # the live bus against the mode's captured reference in the guard;
        # keeping the contract here avoids coupling the test to one caller's
        # local variable name.
        self.assertIn('const float reference = bilateralForce ? syncForceStartBusV :', source)
        self.assertIn('ratio = bus/referenceBus;', guard)
        self.assertIn('if (ratio < .85f || ratio > 1.15f || bus < 8 || bus > 50)', guard)
        self.assertIn('ERR motorset requires stop and sleep', source)
        self.assertIn('payload.awake = driverAwake && syncMotionArmed ? 1 : 0;', source)
        self.assertIn('CONTROL_WARN reason=%s gain=%.3f output_dps=', source)
        stop = source[source.index('static void motorStop() {'):]
        self.assertLess(stop.index('digitalWrite(PIN_DECAY, HIGH)'), stop.index('disableBridgeOutput()'))
        self.assertIn('if (duty > 0) digitalWrite(PIN_DECAY, runningDecayFast ? HIGH : LOW);', source)
        self.assertGreaterEqual(source.count('loadMotorSettings();'), 3)


if __name__ == '__main__':
    unittest.main()
