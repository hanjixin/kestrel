#!/usr/bin/env python3
"""The real socket client stops reading until the producer hits backpressure."""
import http.client
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
for runtime in sys.argv[1:] or ['node', str(root / 'target/release/kestrel')]:
    child = subprocess.Popen([runtime, str(root / 'test/fixtures/http_backpressure.mjs')], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True)
    def line():
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            assert selector.select(15), 'server progress timed out'
        return child.stdout.readline().strip()
    try:
        port = int(line().split()[1])
        with socket.create_connection(('127.0.0.1', port), timeout=15) as client:
            client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 256 * 1024)
            client.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
            produced = int(line().split()[1])
            assert produced < 64 * 1024 * 1024, f'producer ignored backpressure: {produced}'
            response = http.client.HTTPResponse(client)
            response.begin()
            data = response.read()
            assert len(data) == 64 * 1024 * 1024
            assert data[0] == data[-1] == 42
        assert child.wait(timeout=15) == 0, child.stderr.read()
        print(f'PASS {Path(runtime).name}: stalled at {produced // 1024} KiB; delivered 64 MiB')
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
