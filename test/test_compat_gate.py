import pathlib
import subprocess
import tempfile
import unittest

RUNNER = pathlib.Path(__file__).parent / 'compat/run.py'
class GateTests(unittest.TestCase):
    def check_gate(self, node, kestrel, expected, case='builtin_subpaths.mjs', timeout='10'):
        result = subprocess.run(['python3', str(RUNNER), '--node', node, '--kestrel', kestrel, '--timeout', timeout, case], capture_output=True)
        self.assertEqual(result.returncode, expected, result.stdout.decode())
    def test_match(self): self.check_gate('/usr/bin/true', '/usr/bin/true', 0)
    def test_mismatch(self): self.check_gate('/bin/echo', '/usr/bin/true', 1)
    def test_matching_failure(self): self.check_gate('/usr/bin/false', '/usr/bin/false', 1)
    def test_missing_case(self): self.check_gate('/usr/bin/true', '/usr/bin/true', 1, 'missing-case.mjs')
    def test_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'slow'
            path.write_text('#!/bin/sh\nsleep 20\n'); path.chmod(0o755)
            self.check_gate('/usr/bin/true', str(path), 1, timeout='1')
if __name__ == '__main__': unittest.main()
