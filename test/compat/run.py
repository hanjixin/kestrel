#!/usr/bin/env python3
"""Compare Node/Kestrel behavior. Any missing case, nonzero exit or mismatch fails."""
import argparse
import difflib
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys

HERE = Path(__file__).resolve().parent
DEFAULTS = '''http_end_strings.mjs http_early_body_read.mjs http_request_metadata.mjs worker_clone.mjs fork_advanced.mjs fs_async.mjs fs_handles.mjs http_streaming.mjs http_stream_lifecycle.mjs http_end_buffer.mjs builtin_subpaths.mjs server_close.mjs server_close_active.mjs
server_close_idle.mjs http2.mjs http2_stress.mjs http.mjs
http_implicit_headers.mjs http_async_close.mjs https.mjs net.mjs unix.mjs
fork.mjs fork_disconnect.mjs worker.mjs fs_streams.mjs esm.mjs npm.mjs
realworld.cjs misc.mjs als.mjs builtins.cjs proc.mjs express.cjs'''.split()


def run(command, timeout, env):
    with subprocess.Popen(command, cwd=HERE, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as child:
        try:
            out, err = child.communicate(timeout=timeout)
            return child.returncode, out, err
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            out, err = child.communicate()
            return 124, out, err + b'\nTIMEOUT\n'


def environment():
    env = dict(os.environ, NODE_TLS_REJECT_UNAUTHORIZED='0')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        env['PORT'] = str(sock.getsockname()[1])
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kestrel', default=str(HERE.parents[1] / 'target/release/kestrel'))
    parser.add_argument('--node', default='node')
    parser.add_argument('--timeout', type=float, default=90)
    parser.add_argument('cases', nargs='*')
    args = parser.parse_args()
    runtimes = [shutil.which(args.node), shutil.which(args.kestrel)]
    if not all(runtimes):
        parser.error('Node and Kestrel must both be executable')
    runtimes = [str(Path(runtime).resolve()) for runtime in runtimes]
    failures = 0
    cases = args.cases or DEFAULTS
    for case in cases:
        if not (HERE / case).is_file():
            print(f'FAIL {case}: missing case', flush=True)
            failures += 1
            continue
        commands = [[runtime, case] for runtime in runtimes]
        if case == 'vmmod.mjs':
            commands[0].insert(1, '--experimental-vm-modules')
        if case == 'inspect.mjs':
            results = [run([runtimes[0], case], args.timeout,
                           dict(environment(), RUNTIME=runtime)) for runtime in runtimes]
        elif case == 'serve.ts':
            # This fixture explicitly exercises the Kestrel-only serve API.
            results = [run(commands[1], args.timeout, environment())]
        else:
            results = [run(command, args.timeout, environment()) for command in commands]
        ok = all(code == 0 for code, _, _ in results)
        ok = ok and (len(results) == 1 or results[0][1] == results[1][1])
        print(f'{"PASS" if ok else "FAIL"} {case} exits={[r[0] for r in results]}', flush=True)
        if not ok:
            failures += 1
            if len(results) == 2:
                diff = difflib.unified_diff(results[0][1].decode(errors='replace').splitlines(),
                                            results[1][1].decode(errors='replace').splitlines(),
                                            fromfile='node', tofile='kestrel', lineterm='')
                print('\n'.join(list(diff)[:30]))
            for code, _, err in results:
                if code:
                    print(err.decode(errors='replace')[:2000])
    print(f'{len(cases) - failures}/{len(cases)} passed', flush=True)
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
