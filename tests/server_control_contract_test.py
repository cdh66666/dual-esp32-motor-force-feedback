"""No hardware: command limits, acknowledgements, STOP priority, session IDs."""
import sys
import threading
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import server


class ReplySerial:
    is_open = True
    def __init__(self, session, reply=None):
        self.session, self.reply, self.writes = session, reply, []
    def write(self, payload):
        self.writes.append(payload.decode().strip())
        if self.reply:
            self.session.add_log('rx', self.reply)
        return len(payload)


class QueuedAckLock:
    """Expose the point after send_checked has captured its session/epoch."""
    def __init__(self):
        self.lock = threading.Lock()
        self.lock.acquire()
        self.waiting = threading.Event()
    def acquire(self, timeout):
        self.waiting.set()
        return self.lock.acquire(timeout=timeout)
    def release(self):
        self.lock.release()


class ContractTest(unittest.TestCase):
    def test_grouped_electrical_configuration(self):
        self.assertEqual(server.validate_command('cascade electrical'), 'cascade electrical')
        command = 'cascade electrical 3.25 0.031 140 35000 4095'
        self.assertEqual(server.validate_command(command), command)
        self.assertEqual(server.command_reply_prefix(command), 'OK cascade_electrical')
        for bad in ('cascade electrical 3 .3 140 35000 4095',
                    'cascade electrical nan .03 140 35000 4095',
                    command + ' extra'):
            with self.assertRaises(ValueError):
                server.validate_command(bad)
    def test_error_categories(self):
        self.assertEqual(server.error_kind(server.ControllerFault('CASCADE fault encoder_stale')), 'controller')
        self.assertEqual(server.error_kind(TimeoutError('no ACK')), 'transport')
        self.assertEqual(server.error_kind(ValueError('bad parameter')), 'validation')
        self.assertEqual(server.error_kind(RuntimeError('排队命令已被 STOP 取消')), 'cancelled')
    def test_fresh_control_fault_recovery_keeps_handle(self):
        s = self.session()
        def reply(payload):
            line = payload.decode().strip()
            s.ser.writes.append(line)
            s.add_log('rx', 'OK stop' if line == 'stop' else 'STATUS awake=0 pwm=0')
            return len(payload)
        original = s.ser
        s.ser.write = reply
        s.last_rx_at = time.monotonic()
        s.reader_alive = True
        s.write_ok = True
        result = s.recover_link()
        self.assertFalse(result['reconnected'])
        self.assertIs(s.ser, original)
        self.assertEqual(s.ser.writes, ['stop', 'status'])
    def test_maintenance_blocks_new_handles(self):
        s = self.session()
        s.maintenance_until = time.monotonic() + 10
        with self.assertRaisesRegex(RuntimeError, '维护'): s.connect()
    def test_queued_start_cannot_cross_serial_reconnect(self):
        s = self.session()
        prior = s.ser
        s.ack_lock = QueuedAckLock()
        caught = []
        def queued():
            try: s.send_checked('knob start 123', timeout=1)
            except RuntimeError as error: caught.append(str(error))
        thread = threading.Thread(target=queued)
        thread.start()
        self.assertTrue(s.ack_lock.waiting.wait(.5))
        s.ser = ReplySerial(s)
        s.ack_lock.release(); thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(prior.writes, [])
        self.assertEqual(s.ser.writes, [])
        self.assertIn('会话', caught[0])
    def test_knob_reply_must_match_complete_token(self):
        prefix = server.command_reply_prefix('knob keep 123')
        self.assertFalse('OK knob_keep token=1234 active=1'.startswith(prefix))
        self.assertTrue('OK knob_keep token=123 active=1'.startswith(prefix))
    def test_stop_cancels_a_queued_start(self):
        s = self.session()
        s.ack_lock = QueuedAckLock()
        caught = []
        def queued():
            try: s.send_checked('knob start 123', timeout=1)
            except RuntimeError as error: caught.append(str(error))
        thread = threading.Thread(target=queued)
        thread.start()
        self.assertTrue(s.ack_lock.waiting.wait(.5))
        s.send('stop')
        s.ack_lock.release(); thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(s.ser.writes, ['stop'])
        self.assertIn('STOP', caught[0])
    def test_output_position_and_knob_contract(self):
        for command in ['posout 36000 4095 30000', 'pos 36000 4095 1000',
                        'knob config 0 15 200 1 90', 'knob config 3 2 600 10 720',
                        'knob start 1', 'knob keep 1000000000', 'knob stop', 'knob status']:
            self.assertEqual(server.validate_command(command), command)
            self.assertTrue(server.command_reply_prefix(command))
        for command in ['posout 36001 4095 1000', 'knob config 0 1 200 1 90',
                        'knob config 0 15 601 1 90', 'knob config 0 15 100 -1 90',
                        'knob config 3 15 100 1 10', 'knob config 4 15 200 1 90',
                        'knob config 0 nan 100 1 90', 'knob config 0 15 100 1 inf',
                        'knob config 0 15 200 1 90 extra', 'knob start 0', 'knob keep -1']:
            with self.assertRaises(ValueError): server.validate_command(command)
    def test_remote_recovery_command_contract(self):
        self.assertEqual(server.validate_command('bus 1 recover'), 'bus 1 recover')
    def test_uncertain_knob_start_and_keep_are_stopped(self):
        for command in ['knob start 1', 'knob keep 1', 'posout 1 4095 1000']:
            s = self.session()
            with self.assertRaises(TimeoutError): s.send_checked(command, timeout=.01)
            self.assertEqual(s.ser.writes[-1], 'stop')
    def session(self, reply=None):
        s = server.PortSession('FAKE')
        s._write_fault_capture = lambda *args: None
        s.ser = ReplySerial(s, reply)
        return s
    def test_optional_profile_parameters_untouched(self):
        for command in ['cascade velocity 0.00012 0.0005 0.5',
                        'cascade velocity 0.00012 0.0005 0.5 0.1 3',
                        'cascade position 4 0 0.15 12000 0.35',
                        'cascade hold on', 'cascade breakaway 0.25 15 120 40 80']:
            self.assertEqual(server.validate_command(command), command)
    def test_firmware_bounds(self):
        for bad in ['cascade position 4 0 0.15 12000 0.35 0 100001',
                    'cascade position 4 0 0.15 12000 0.35 0 40000 6',
                    'cascade breakaway 0.2 15 120 40 nan',
                    'cascade trajectory 12000 40000 1000 21']:
            with self.assertRaises(ValueError): server.validate_command(bad)
    def test_real_ack_required(self):
        s = self.session('OK model_velocity target=360.000deg/s')
        self.assertTrue(s.send_checked('velocity 360 4095 1000').startswith('OK model_velocity'))
        s = self.session('ERR power_path_fault_latched')
        with self.assertRaises(RuntimeError): s.send_checked('velocity 360 4095 1000')
    def test_bounded_rotor_calibration(self):
        for good in ['cascade cogging clear', 'cascade cogging save',
                     'cascade cogging harmonic 18 -0.01 0.2',
                     'cascade cogging enable 1 0.13 -0.01']:
            self.assertEqual(server.validate_command(good), good)
        for bad in ['cascade cogging harmonic 0 0 0',
                    'cascade cogging harmonic 19 0 0',
                    'cascade cogging enable 2 0.13 0',
                    'cascade cogging enable 1 nan 0',
                    'cascade cogging harmonic 1 0.5 0']:
            with self.assertRaises(ValueError): server.validate_command(bad)
    def test_single_usb_force_configuration_is_typed_and_bounded(self):
        remote={'address':1,'protocol':3,'gear':5.2,'current_limit':1.5,'model_ke':.011}
        peer={'address':184,'protocol':3,'gear':5.2,'current_limit':1.5,'model_ke':.011}
        command=server.remote_force_command({
            'peer':184,'stiffness':18,'damping':.35,'reflection':0,
            'limit':1200,'duty':4095,'timeout':30000,'offset':36000,
        },remote,peer)
        self.assertEqual(command,'sync force 184 18 0.35 0 1200 4095 30000 36000')
        for body in (
            {'peer':184,'stiffness':18,'damping':.35,'reflection':0,'limit':1201,'duty':4095,'timeout':30000,'offset':0},
            {'peer':1,'stiffness':18,'damping':.35,'reflection':0,'limit':1200,'duty':4095,'timeout':30000,'offset':0},
        ):
            with self.assertRaises(ValueError): server.remote_force_command(body,remote,peer)
        with self.assertRaises(ValueError): server.remote_force_command(
            {'peer':184,'stiffness':18,'damping':.35,'reflection':0,'limit':1200,'duty':4095,'timeout':30000,'offset':0},
            {**remote,'protocol':2},peer)
        with self.assertRaises(ValueError): server.validate_command('sync force 184 18 .35 0 1200 4095 30000 36001')
    def test_single_usb_force_status_requires_full_valid_frame(self):
        fields=server.parse_chain_status('STATUS,1,0,0,24.2,0,0,1,1,0,0,0,0',1)
        self.assertEqual(fields[3],24.2)
        self.assertEqual(fields[6],1)
        for reply in ('STATUS,1,0,0,24.2,0,0,1,1',
                      'STATUS,1,0,0,nan,0,0,1,1,0,0,0,0',
                      'STATUS,2,0,0,24.2,0,0,1,1,0,0,0,0'):
            with self.assertRaises(ValueError): server.parse_chain_status(reply,1)
        self.assertEqual(server.parse_usb_status(
            'STATUS bus=24.25V bus_adc=25000mV angle=0.00deg multi=0.00deg velocity=0.0deg/s raw=1 nFAULT=1 awake=1 step=0 pwm=0/4095'),
            {'bus':24.25,'fault':1,'awake':1})
    def test_timeout_stops_uncertain_motion(self):
        s = self.session()
        with self.assertRaises(TimeoutError): s.send_checked('velocity 360 4095 1000', timeout=.03)
        self.assertEqual(s.ser.writes[-1], 'stop')
    def test_stop_is_not_queued_behind_ack(self):
        s = self.session()
        errors = []
        def run():
            try: s.send_checked('current 100 4095 1000', timeout=1)
            except RuntimeError as exc: errors.append(str(exc))
        worker = threading.Thread(target=run)
        worker.start()
        deadline = time.monotonic() + .5
        while not s.ser.writes and time.monotonic() < deadline: time.sleep(.001)
        start = time.monotonic()
        s.send('stop')
        self.assertLess(time.monotonic() - start, .05)
        worker.join(.2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(errors and 'STOP' in errors[0])
    def test_restart_epoch(self):
        self.assertNotEqual(self.session().session_id, self.session().session_id)
    def test_reader_delivers_short_frame_without_batch_wait(self):
        session=self.session()
        stopped=threading.Event()
        packet=b'S,10,0,0\r\n'
        class ShortFrameSerial:
            is_open=True
            in_waiting=len(packet)
            def read(self,size):
                if size>len(packet): raise AssertionError('reader waits for more than available telemetry')
                stopped.set()
                return packet
        transport=ShortFrameSerial()
        session.ser=transport
        session._reader(transport,stopped)
        self.assertTrue(any(e['direction']=='rx' and e['text']=='S,10,0,0' for e in session.logs))

    def test_invalid_windows_handle_is_closed_without_waking_motor(self):
        session = self.session()
        stop = threading.Event()
        class LostDevice:
            is_open = True
            in_waiting = 0
            def read(self, size): raise OSError('ClearCommError: device re-enumerated')
            def close(self): self.is_open = False
        lost = LostDevice()
        session.ser = lost
        epoch = session.command_epoch
        session._reader(lost, stop)
        self.assertIsNone(session.ser)
        self.assertFalse(lost.is_open)
        self.assertFalse(session.reader_alive)
        self.assertTrue(stop.is_set() and session.monitor_stop.is_set())
        self.assertGreater(session.command_epoch, epoch)
        self.assertFalse(any(e['direction'] == 'tx' for e in session.logs))


if __name__ == '__main__': unittest.main()
