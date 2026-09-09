"""Deterministic offline reproductions of reconnect/STOP/cache races."""
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import server


class Transport:
    is_open = True
    in_waiting = 1
    def __init__(self): self.writes = []
    def write(self, data): self.writes.append(data); return len(data)
    def close(self): self.is_open = False


class StabilityTest(unittest.TestCase):
    def test_ack_timeout_stays_faulted_until_a_real_board_reply(self):
        s = self.session()
        with self.assertRaises(TimeoutError):
            s.send_checked('model', timeout=.002)
        s.send('status') # OS write accepted, but still no board response
        health = s.health()
        self.assertFalse(health['write_ok'])
        self.assertIn('model', health['last_ack_error'])
        self.assertIsNone(health['ack_age_ms'])
        original = s.ser.write
        def acknowledged(data):
            written = original(data)
            s.add_log('rx','MODEL fw=test')
            return written
        s.ser.write = acknowledged
        self.assertEqual(s.send_checked('model'), 'MODEL fw=test')
        self.assertTrue(s.health()['write_ok'])
        self.assertEqual(s.health()['last_ack_error'], '')
        self.assertIsNotNone(s.health()['ack_age_ms'])

    def test_native_cdc_read_and_write_never_overlap(self):
        s = self.session()
        reading, release, writing = threading.Event(), threading.Event(), threading.Event()
        stop = threading.Event()
        class GatedTransport(Transport):
            def read(self, size):
                reading.set()
                if not release.wait(1): raise RuntimeError('test release missing')
                stop.set()
                return b'S,10,0,0\r\n'
            def write(self, data):
                writing.set()
                return super().write(data)
        s.ser = GatedTransport()
        reader = threading.Thread(target=s._reader,args=(s.ser,stop))
        reader.start()
        self.assertTrue(reading.wait(.5))
        writer = threading.Thread(target=s.send,args=('status',))
        writer.start()
        self.assertFalse(writing.wait(.02))
        release.set()
        writer.join(1); reader.join(1)
        self.assertFalse(reader.is_alive() or writer.is_alive())
        self.assertEqual(s.ser.writes, [b'status\r\n'])

    def session(self):
        s = server.PortSession('FAKE')
        s._write_fault_capture = lambda *args: None
        s.ser = Transport()
        return s

    def test_old_reader_never_marks_new_connection_alive(self):
        s = self.session()
        s.reader_alive = False
        s._reader(Transport(), threading.Event())
        self.assertFalse(s.reader_alive)
        self.assertEqual(s.snapshot(), [])

    def test_old_read_result_and_exception_cannot_pollute_reconnect(self):
        for failure in [False, True]:
            s = self.session()
            entered, release = threading.Event(), threading.Event()
            old, stopped = s.ser, s.stop_event
            def delayed_read(size):
                entered.set()
                if not release.wait(1): raise AssertionError('test stalled')
                if failure: raise OSError('old handle cancelled')
                return b'ERR stale old session\n'
            old.read = delayed_read
            worker = threading.Thread(target=s._reader, args=(old, stopped))
            worker.start()
            self.assertTrue(entered.wait(1))
            s.disconnect()
            with s.lifecycle_lock:
                s.ser = Transport()
                s.reader_alive, s.write_ok = True, True
                s.last_error, s.last_rx_at = '', 1234.
            release.set(); worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertTrue(s.reader_alive and s.write_ok)
            self.assertEqual(s.last_error, '')
            self.assertEqual(s.last_rx_at, 1234.)
            self.assertFalse(any(e['direction'] in ('rx', 'error') for e in s.snapshot()))

    def test_stop_epoch_checked_at_actual_write(self):
        s = self.session()
        prior = s.command_epoch
        s.send('stop')
        with self.assertRaisesRegex(RuntimeError, 'STOP'):
            s.send('current 100 4095 1000', expected_ser=s.ser, expected_epoch=prior)
        self.assertEqual(s.ser.writes, [b'stop\r\n'])

    def test_busy_ack_queue_has_bounded_wait_and_no_late_write(self):
        s = self.session()
        s.ack_lock.acquire()
        try:
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, '排队期间'):
                s.send_checked('velocity 10 4095 1000', timeout=.02)
            self.assertLess(time.monotonic()-start, .25)
            self.assertEqual(s.ser.writes, [])
        finally: s.ack_lock.release()

    def test_capture_write_failure_does_not_spawn_recursive_captures(self):
        s = self.session()
        with patch.object(Path, 'mkdir', side_effect=OSError('disk unavailable')):
            with patch.object(server.threading, 'Thread') as thread:
                server.PortSession._write_fault_capture(s, [], 'test fault')
                thread.assert_not_called()
        self.assertIn('fault capture failed', s.snapshot()[-1]['text'])

    def test_stale_port_enumeration_cannot_close_new_handle(self):
        s = self.session()
        current = s.ser
        s.disconnect('old enumeration', expected_ser=Transport())
        self.assertIs(s.ser, current)
        s.disconnect()
        self.assertFalse(s.health()['active'])

    def test_rx_is_not_a_fresh_waveform(self):
        s = self.session()
        s.reader_alive = True
        s.last_rx_at = time.monotonic()
        self.assertFalse(s.health()['telemetry_ok'])
        s.last_sample_at = time.monotonic()
        self.assertTrue(s.health()['telemetry_ok'])
        s.last_sample_at -= 3
        self.assertFalse(s.health()['telemetry_ok'])

    def test_old_waveforms_not_republished_as_fresh_after_reconnect(self):
        s = self.session()
        old_id = s.session_id
        s.add_log('rx', 'S,100,old')
        s.session_id = 'new-session'
        s.add_log('system', 'connected')
        data = s.payload_since(0)
        self.assertEqual(data['session_id'], 'new-session')
        self.assertEqual([e['text'] for e in data['logs']], ['connected'])
        self.assertEqual(len(s.snapshot()), 2)  # history retained for diagnostics
        for checked in [False, True]:
            with self.assertRaisesRegex(RuntimeError, '旧页面'):
                if checked: s.send_checked('current 100 4095 1000', expected_session_id=old_id)
                else: s.send('current 100 4095 1000', expected_session_id=old_id)
        self.assertEqual(s.ser.writes, [])

    def test_invalid_and_multiline_commands_rejected_before_serial(self):
        for text in ['wake\ncurrent 100 4095 1000', 'stop\0', 'x'*128, '\x80', []]:
            with self.assertRaises(ValueError): server.validate_command(text)
        self.assertEqual(server.validate_command('current 100 4095 1000'), 'current 100 4095 1000')

    def test_short_write_is_failure_and_not_replayed(self):
        for result in [0, 3, None]:
            s = self.session()
            with patch.object(s.ser, 'write', return_value=result) as write:
                with self.assertRaisesRegex(server.serial.SerialTimeoutException, '写入不完整'):
                    s.send('current 100 4095 1000')
                self.assertEqual(write.call_count, 1)
            self.assertFalse(s.write_ok)
            self.assertFalse(any(e['direction'] == 'tx' for e in s.snapshot()))

    def test_fresh_in_stream_does_not_hide_out_failure(self):
        for known_write_failure in [False, True]:
            s = self.session()
            old = s.ser
            s.reader_alive, s.write_ok = True, not known_write_failure
            s.last_rx_at = time.monotonic()
            s.last_error = 'Write timeout' if known_write_failure else ''
            def reconnect():
                s.ser = Transport()
                s.reader_alive, s.write_ok = True, True
                s.last_rx_at = time.monotonic()
                s.last_error = ''
            def checked(command):
                if s.ser is old: raise TimeoutError('OUT no ACK')
                return 'OK stop' if command == 'stop' else 'STATUS awake=0 pwm=0'
            with patch.object(s, 'connect', side_effect=reconnect) as connect:
                with patch.object(s, 'send_checked', side_effect=checked):
                    result = s.recover_link()
            self.assertTrue(result['reconnected'])
            self.assertEqual(connect.call_count, 1)
            self.assertFalse(old.is_open)
            self.assertEqual(old.writes, [b'stop\r\n'])

    def test_pnp_scan_is_single_flight_for_many_tabs(self):
        entered, release = threading.Event(), threading.Event()
        saved = server.usb_problem_cache, server.usb_problem_cache_at
        server.usb_problem_cache, server.usb_problem_cache_at = [], 0.
        def slow_scan(*args, **kwargs):
            entered.set()
            if not release.wait(1): raise AssertionError('scan not released')
            return SimpleNamespace(stdout='实例 ID: USB\\TEST\n设备描述: Test\n问题代码: 43\n')
        try:
            with patch.object(server.subprocess, 'run', side_effect=slow_scan) as mock:
                worker = threading.Thread(target=server.usb_problem_devices)
                worker.start()
                self.assertTrue(entered.wait(1))
                for _ in range(20): self.assertEqual(server.usb_problem_devices(), [])
                release.set(); worker.join(1)
                self.assertFalse(worker.is_alive())
                self.assertEqual(mock.call_count, 1)
                self.assertEqual(server.usb_problem_devices()[0]['code'], 43)
        finally:
            release.set()
            server.usb_problem_cache, server.usb_problem_cache_at = saved


if __name__ == '__main__': unittest.main()
