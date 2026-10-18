#!/usr/bin/env python3
"""Alternating local Kestrel/Bun HTTP and I/O benchmarks, optionally including Node."""
import subprocess,os,socket,time,urllib.request,signal,re,statistics,json,platform,shutil,argparse
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', default='/tmp/kestrel-bun-comparison')
parser.add_argument('--kestrel', default=str(root/'target/release/kestrel'))
parser.add_argument('--include-node', action='store_true')
parser.add_argument('--rounds', type=int, default=5)
parser.add_argument('--duration', type=int, default=5)
args=parser.parse_args()
out=Path(args.output_dir);out.mkdir(parents=True,exist_ok=True)
bins={'kestrel':str(Path(args.kestrel).resolve()),'bun':shutil.which('bun')}
if args.include_node: bins['node']=shutil.which('node')
if not all(bins.values()): parser.error('Required runtime executable is missing')
if args.rounds < 1 or args.duration < 1: parser.error('rounds and duration must be positive')
def order(labels, iteration):
 if len(labels)==2: return labels[::-1] if iteration%2 else labels
 base=labels if (iteration//len(labels))%2==0 else labels[::-1]
 shift=iteration%len(labels)
 return base[shift:]+base[:shift]
rows=[]
for workload in ['native-http','node-http']:
 for iteration in range(args.rounds):
  labels=order(['kestrel','bun'] if workload=='native-http' else list(bins),iteration)
  for label in labels:
   fixture=('bench/hello_'+label+'.ts') if workload=='native-http' else 'bench/hello_node.mjs'
   with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
   url=f'http://127.0.0.1:{port}/'
   child=subprocess.Popen([bins[label],fixture],cwd=root,env=dict(os.environ,PORT=str(port),WORKERS='1'),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
   try:
    for _ in range(300):
     if child.poll() is not None:raise RuntimeError(child.stderr.read().decode())
     try:
      r=urllib.request.urlopen(url,timeout=.2);assert r.read()==b'Hello, World!';break
     except OSError:time.sleep(.02)
    else:raise RuntimeError('startup timeout')
    subprocess.run(['wrk','-t2','-c64','-d1s',url],capture_output=True,check=True)
    output=subprocess.check_output(['wrk','-t2','-c64',f'-d{args.duration}s','--latency',url],text=True)
    if 'Socket errors:' in output or 'Non-2xx' in output:raise RuntimeError(output)
    row=dict(workload=workload,runtime=label,round=iteration+1,rps=float(re.search(r'Requests/sec:\s+([\d.]+)',output)[1]),rss_kib=int(subprocess.check_output(['ps','-o','rss=','-p',str(child.pid)],text=True)),output=output)
    rows.append(row);print(json.dumps({k:v for k,v in row.items() if k!='output'}),flush=True)
   finally:
    if child.poll() is None:os.killpg(child.pid,signal.SIGTERM)
    child.wait(timeout=10)
summary={}
for workload in ['native-http','node-http']:
 summary[workload]={label:{'rps':statistics.median(r['rps'] for r in rows if r['workload']==workload and r['runtime']==label),'rss_mib':statistics.median(r['rss_kib'] for r in rows if r['workload']==workload and r['runtime']==label)/1024} for label in (['kestrel','bun'] if workload=='native-http' else bins)}
(out/'http.json').write_text(json.dumps(dict(platform=platform.platform(),bun_version=subprocess.check_output([bins['bun'],'--version'],text=True).strip(),node_version=subprocess.check_output([bins['node'],'--version'],text=True).strip() if 'node' in bins else None,rounds=args.rounds,duration=args.duration,summary=summary,samples=rows),indent=2)+'\n')
print(json.dumps(summary,indent=2),flush=True)
rows=[]
for fixture in ['bench/worker_transfer.mjs','bench/fs_read.mjs']:
 for iteration in range(args.rounds):
  for label in order(list(bins),iteration):
   result=subprocess.run([bins[label],fixture],cwd=root,capture_output=True,text=True,timeout=60)
   row=dict(fixture=fixture,runtime=label,round=iteration+1,exit=result.returncode,stdout=result.stdout,stderr=result.stderr)
   rows.append(row);print(json.dumps(row),flush=True)
(out/'io.json').write_text(json.dumps(rows,indent=2)+'\n')

if any(row['exit'] != 0 for row in rows):
 raise SystemExit('I/O benchmark failed; do not use failed samples as performance results')
