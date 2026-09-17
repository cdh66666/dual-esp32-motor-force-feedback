import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from chain_gateway import decode_reply, RemoteRejected

class Replies(unittest.TestCase):
    def test_identity(self):
        self.assertEqual(decode_reply('BUS_RX from=184 type=5 seq=7 payload=PONG,addr=184,uid=aabb',184,7,'ping')['uid'],'AABB')
    def test_protocol_gate(self):
        meta=decode_reply('BUS_RX from=184 type=2 seq=7 payload=META,184,AABB,5.2000,1.500,2',184,7,'gatewayinfo')
        self.assertEqual(meta['protocol'],2)
        self.assertEqual(meta['gear'],5.2)
        v3=decode_reply('BUS_RX from=184 type=2 seq=8 payload=META,184,AABB,5.2000,1.500,0.011000,3',184,8,'gatewayinfo')
        self.assertEqual(v3['protocol'],3)
        self.assertEqual(v3['model_ke'],0.011)
        self.assertIsNone(decode_reply('BUS_RX from=184 type=2 seq=7 payload=ACK,7,accepted=gatewayinfo',184,7,'gatewayinfo'))
    def test_wrong_transaction(self):
        self.assertIsNone(decode_reply('BUS_RX from=184 type=5 seq=8 payload=PONG,addr=184,uid=aabb',184,7,'ping'))
        self.assertIsNone(decode_reply('BUS_ACK from=184 type=2 seq=7',184,7,'current 1 4095 100'))
    def test_rejected(self):
        with self.assertRaises(RemoteRejected):
            decode_reply('BUS_RX from=184 type=2 seq=7 payload=NACK,7,rejected=current',184,7,'current')
    def test_old_false_success(self):
        with self.assertRaises(RemoteRejected):
            decode_reply('BUS_RX from=184 type=2 seq=7 payload=ACK,7,executed=current',184,7,'current')
    def test_acceptance_not_completion(self):
        self.assertIsNotNone(decode_reply('BUS_RX from=184 type=2 seq=7 payload=ACK,7,accepted=current',184,7,'current'))
    def test_payload_address(self):
        self.assertIsNone(decode_reply('BUS_RX from=184 type=5 seq=7 payload=PONG,addr=1,uid=aabb',184,7,'ping'))

if __name__=='__main__': unittest.main()
