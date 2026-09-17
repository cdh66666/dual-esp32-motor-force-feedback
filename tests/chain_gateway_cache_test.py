"""DATA cache contract; no serial port and no motor motion."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from chain_gateway import ChainGateway


class Session:
    pass


def main():
    gateway = ChainGateway(Session())
    calls = []

    def fake_request(address, command, session, timeout=1.0, expected_epoch=None):
        calls.append((address, command, session, expected_epoch))
        return {'address': address, 'uid': 'ABCDEF', 'gear': 5.2,
                'current_limit': 1.5, 'protocol': 2}

    gateway.request = fake_request
    first = gateway.metadata(1, 'session-a', expected_epoch=3)
    second = gateway.metadata(1, 'session-a', expected_epoch=3)
    assert first == second and len(calls) == 1
    # A STOP/reconnect epoch cannot reuse the previous identity transaction.
    gateway.metadata(1, 'session-a', expected_epoch=4)
    assert len(calls) == 2
    gateway.mark_awake(1, 'session-a', expected_epoch=4)
    assert gateway.remote_awake(1, 'session-a', expected_epoch=4)
    # STOP itself is not WAKE: it must not fabricate a positive hint for an
    # asleep/unknown board, but it can retain a recent acknowledged hint.
    gateway.mark_stopped(1, 'session-a', expected_epoch=4,
                         previously_awake=False)
    assert not gateway.remote_awake(1, 'session-a', expected_epoch=4)
    gateway.mark_awake(1, 'session-a', expected_epoch=4)
    gateway.mark_stopped(1, 'session-a', expected_epoch=4,
                         previously_awake=True)
    assert gateway.remote_awake(1, 'session-a', expected_epoch=4)
    gateway.mark_asleep(1, 'session-a', expected_epoch=4)
    assert not gateway.remote_awake(1, 'session-a', expected_epoch=4)
    gateway.invalidate_cache()
    assert not gateway.remote_awake(1, 'session-a', expected_epoch=4)
    print('PASS chain gateway cache: scoped META reuse and wake hint invalidation')


if __name__ == '__main__':
    main()
