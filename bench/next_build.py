#!/usr/bin/env python3
"""Compare clean Next builds in three prepared, dependency-identical app copies."""
import argparse, hashlib, json, os, platform, re, shutil, signal, socket, statistics
import subprocess, time, urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workspace', type=Path, required=True, help='Contains node/, bun/, kestrel/ app copies with installed dependencies')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--kestrel', type=Path, default=Path(__file__).resolve().parents[1] / 'target/release/kestrel')
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--timeout', type=int, default=120)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
runtimes = {'node': [shutil.which('node')], 'bun': [shutil.which('bun'), '--bun'], 'kestrel': [str(args.kestrel.resolve())]}
assert all(cmd[0] for cmd in runtimes.values())
env = dict(os.environ, NEXT_TELEMETRY_DISABLED='1', NODE_ENV='production', CI='1')

def stop(proc):
    try: os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()
    # A failed parent may have left children in its process group.
    try: os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError: pass

def sample(pgid):
    result = subprocess.run(['ps', '-g', str(pgid), '-o', 'pid=,pgid=,rss=,comm=,args='], capture_output=True, text=True, errors='replace')
    rss = 0; commands = set()
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) >= 4 and int(parts[1]) == pgid:
            rss += int(parts[2]); commands.add(parts[4] if len(parts) == 5 else parts[3])
    return rss, commands

def smoke(app, command, tag):
    standalone = app / '.next/standalone'
    server = standalone / 'server.js'
    if not server.exists(): return {'ok': False, 'error': 'standalone/server.js missing'}
    shutil.copytree(app / '.next/static', standalone / '.next/static', dirs_exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    with (args.output / (tag + '-serve.log')).open('w') as log:
        started = time.monotonic()
        proc = subprocess.Popen(command + [str(server)], cwd=standalone,
                                env=dict(env, PORT=str(port), HOSTNAME='127.0.0.1'),
                                stdout=log, stderr=log, start_new_session=True)
        try:
            while time.monotonic() - started < 20:
                if proc.poll() is not None: return {'ok': False, 'error': 'server exited', 'exit': proc.returncode}
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=1) as response:
                        html = response.read().decode()
                    assert 'Hello from Next' in html and '2, 4, 6' in html
                    assets = re.findall(r'<script[^>]+src="([^"]+)"', html)
                    assert assets, 'no script assets'
                    for asset in assets:
                        with urllib.request.urlopen(f'http://127.0.0.1:{port}' + asset, timeout=2) as response:
                            assert response.status == 200 and response.read()
                    return {'ok': True, 'startup_and_validation_seconds': round(time.monotonic() - started, 3), 'script_assets': len(assets)}
                except (OSError, AssertionError): time.sleep(.1)
            return {'ok': False, 'error': 'startup or response validation timed out'}
        finally: stop(proc)

metadata = {'platform': platform.platform(), 'machine': platform.machine(),
            'node': subprocess.check_output([runtimes['node'][0], '--version'], text=True).strip(),
            'bun': subprocess.check_output([runtimes['bun'][0], '--version'], text=True).strip(),
            'kestrel_sha256': hashlib.sha256(args.kestrel.read_bytes()).hexdigest(),
            'rounds_requested': args.rounds, 'timeout_seconds': args.timeout,
            'memory_method': 'ps sum of RSS for the build process group, sampled about every 100ms; shared pages can be counted more than once',
            'cache_policy': '.next removed before each build; dependencies and OS file cache retained; dependency installation and smoke checks excluded from build time'}
locks = []
for label in runtimes:
    app = args.workspace / label
    locks.append(hashlib.sha256((app / 'package-lock.json').read_bytes()).hexdigest())
    metadata['next'] = json.loads((app / 'node_modules/next/package.json').read_text())['version']
assert len(set(locks)) == 1, 'dependency locks differ'
metadata['lock_sha256'] = locks[0]
results = []; failed = set()
for iteration in range(args.rounds):
    labels = ['node', 'bun', 'kestrel']
    labels = labels[iteration % 3:] + labels[:iteration % 3]
    for label in labels:
        if label in failed: continue
        app = args.workspace / label
        shutil.rmtree(app / '.next', ignore_errors=True)
        tag = f'{label}-{iteration + 1}'
        command = runtimes[label] + ['node_modules/next/dist/bin/next', 'build']
        with (args.output / (tag + '-build.log')).open('w') as log:
            started = time.monotonic()
            proc = subprocess.Popen(['/usr/bin/time', '-l'] + command, cwd=app, env=env,
                                    stdout=log, stderr=log, start_new_session=True)
            peak_rss = 0; observed = set(); timed_out = False
            try:
                while proc.poll() is None:
                    rss, commands = sample(proc.pid); peak_rss = max(peak_rss, rss); observed.update(commands)
                    if time.monotonic() - started >= args.timeout:
                        timed_out = True; break
                    time.sleep(.1)
            finally: stop(proc)
            seconds = time.monotonic() - started
        text = (args.output / (tag + '-build.log')).read_text()
        built = not timed_out and proc.returncode == 0 and (app / '.next/BUILD_ID').exists() and (app / '.next/standalone/server.js').exists()
        row = {'runtime': label, 'round': iteration + 1, 'command': command, 'exit': proc.returncode,
               'timeout': timed_out, 'build_ok': built, 'wall_seconds': round(seconds, 3),
               'sampled_process_group_peak_rss_mib': round(peak_rss / 1024, 2), 'observed_commands': sorted(observed)}
        usage = re.search(r'(\d+)\s+maximum resident set size', text)
        if usage: row['time_max_rss_mib'] = round(int(usage[1]) / 1024**2, 2)
        if built:
            row['smoke'] = smoke(app, runtimes[label], tag)
            row['output_bytes_without_cache'] = sum(p.stat().st_size for p in (app / '.next').rglob('*') if p.is_file() and 'cache' not in p.relative_to(app / '.next').parts)
        else: failed.add(label)
        results.append(row)
        (args.output / 'results.json').write_text(json.dumps({'metadata': metadata, 'samples': results}, indent=2) + '\n')
        print(json.dumps({k:v for k,v in row.items() if k != 'observed_commands'}), flush=True)
summary = {}
for label in runtimes:
    rows = [r for r in results if r['runtime'] == label]
    good = [r for r in rows if r['build_ok']]
    summary[label] = {'builds_passed': len(good), 'builds_attempted': len(rows), 'smoke_passed': sum(r.get('smoke', {}).get('ok', False) for r in rows),
                      'median_build_seconds': statistics.median(r['wall_seconds'] for r in good) if good else None,
                      'median_sampled_peak_rss_mib': statistics.median(r['sampled_process_group_peak_rss_mib'] for r in good) if good else None}
(args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2), flush=True)
