#!/usr/bin/env python3
"""Alternating before/after HTTP benchmarks on the same host (wrk required)."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
import statistics
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--before', required=True)
p.add_argument('--after', default=str(ROOT / 'target/release/kestrel'))
p.add_argument('--rounds', type=int, default=5)
p.add_argument('--duration', type=int, default=3)
p.add_argument('--output', default='/tmp/kestrel-performance.json')
args = p.parse_args()
rows = []
for fixture in ['bench/hello_kestrel.ts', 'bench/hello_node.mjs']:
    for iteration in range(args.rounds):
        pair = [('before', args.before), ('after', args.after)]
        if iteration % 2: pair.reverse()
        for label, binary in pair:
            with socket.socket() as reserve:
                reserve.bind(('127.0.0.1', 0)); port = reserve.getsockname()[1]
            url = f'http://127.0.0.1:{port}/'
            child = subprocess.Popen([binary, fixture], cwd=ROOT, env=dict(os.environ, PORT=str(port), WORKERS='1'),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
            try:
                for _ in range(300):
                    if child.poll() is not None: raise RuntimeError(child.stderr.read().decode())
                    try: urllib.request.urlopen(url, timeout=.2).read(); break
                    except Exception: time.sleep(.02)
                else: raise RuntimeError('server did not start')
                subprocess.run(['wrk', '-t2', '-c64', '-d1s', url], capture_output=True, check=True)
                result = subprocess.check_output(['wrk', '-t2', '-c64', f'-d{args.duration}s', '--latency', url], text=True)
                if 'Socket errors:' in result or 'Non-2xx' in result: raise RuntimeError(result)
                rps = float(re.search(r'Requests/sec:\s+([\d.]+)', result)[1])
                rss = int(subprocess.check_output(['ps', '-o', 'rss=', '-p', str(child.pid)], text=True))
                rows.append(dict(fixture=fixture, label=label, round=iteration, rps=rps, rss_kib=rss, output=result))
                print(f'{fixture} {label} {iteration + 1}: {rps:.0f} req/s RSS={rss} KiB', flush=True)
            finally:
                if child.poll() is None: os.killpg(child.pid, signal.SIGTERM)
                child.wait()
summary = {}
for fixture in {row['fixture'] for row in rows}:
    medians = {label: statistics.median(row['rps'] for row in rows if row['fixture'] == fixture and row['label'] == label)
               for label in ['before', 'after']}
    medians['change_percent'] = (medians['after'] / medians['before'] - 1) * 100
    summary[fixture] = medians
Path(args.output).write_text(json.dumps(dict(system=os.uname().sysname, machine=os.uname().machine, summary=summary, samples=rows), indent=2))
print(json.dumps(summary, indent=2))
