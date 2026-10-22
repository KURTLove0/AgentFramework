"""Protocol integration test against the real demo server subprocess."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DemoMCPTests(unittest.TestCase):
    def test_initialize_list_and_synthetic_lookup_over_stdio(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'calls.jsonl'
            server = Path(__file__).resolve().parents[1] / 'examples/mock_facts_mcp.py'
            messages = [
                {'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
                {'method': 'notifications/initialized'},
                {'id': 2, 'method': 'tools/list'},
                {'id': 3, 'method': 'tools/call', 'params': {'name': 'lookup', 'arguments': {}}},
            ]
            result = subprocess.run([sys.executable, str(server), '--log', str(log)],
                                    input=''.join(json.dumps({'jsonrpc': '2.0', **m})+'\n' for m in messages),
                                    capture_output=True, text=True, timeout=5, check=True)
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual([r['id'] for r in replies], [1, 2, 3])
            self.assertEqual(replies[0]['result']['protocolVersion'], '2025-03-26')
            self.assertEqual([t['name'] for t in replies[1]['result']['tools']], ['lookup', 'unlisted'])
            marker = json.loads(replies[2]['result']['content'][0]['text'])
            self.assertEqual(marker, {'marker': 'SYNTHETIC-FACTS-V1', 'scope': 'synthetic-only'})
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual([c['tool'] for c in calls], ['lookup'])
