import re
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))
import server as debug_server


class StaticAssetRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), debug_server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def test_dashboard_module_dependencies_are_served(self):
        source = (ROOT / "web" / "dashboard.js").read_text(encoding="utf-8")
        module_urls = set(re.findall(
            r"(?:import\(|fetch\()\s*['\"](/[^'\"]+\.js)(?:\?[^'\"]*)?['\"]",
            source,
        ))
        self.assertTrue(module_urls, "expected dashboard module dependencies")

        for module_url in sorted(module_urls):
            with self.subTest(module=module_url), urlopen(self.base + module_url, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("javascript", response.headers.get_content_type())
                self.assertGreater(len(response.read()), 0)


if __name__ == "__main__":
    unittest.main()
