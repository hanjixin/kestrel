import argparse,json,os,re,signal,socket,statistics,subprocess,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--variants',required=True);p.add_argument('--out',required=True);p.add_argument('--rounds',type=int,default=3);p.add_argument('--duration',type=int,default=5);p.add_argument('--connections',type=int,default=64);p.add_argument('--fixture',default='bench/hello_node.mjs');a=p.parse_args()
variants=json.loads(Path(a.variants).read_text());out=Path(a.out);out.mkdir(parents=True,exist_ok=True);rows=[]
def sched(pid):
 try:
  s=Path(f'/proc/{pid}/sched').read_text();return {k:float(v) for k,v in re.findall(r'^\s*(se.nr_migrations|nr_switches|nr_voluntary_switches|nr_involuntary_switches)\s*:\s*([\d.]+)',s,re.M)}
 except OSError:return {}
def latency(raw,percent):
 m=re.search(r'^\s*'+str(percent)+r'%\s+([\d.]+)(us|ms|s)',raw,re.M)
 if not m:raise RuntimeError('missing latency percentile')
 return float(m[1])*{'us':.001,'ms':1,'s':1000}[m[2]]
for i in range(a.rounds):
 order=variants[i%len(variants):]+variants[:i%len(variants)]
 if (i//len(variants))%2:order=order[::-1]
 for v in order:
  with socket.socket(socket.AF_INET6) as sock:sock.bind(('::',0));port=sock.getsockname()[1]
  url=f'http://127.0.0.1:{port}/';env=dict(os.environ,PORT=str(port),WORKERS='1',**v.get('env',{}));label=v['name']
  with (out/f'{label}-{i+1}-server.log').open('w') as log:
   child=subprocess.Popen(v['cmd']+[v.get('fixture',a.fixture)],env=env,stdout=log,stderr=log,start_new_session=True)
   try:
    for _ in range(300):
     if child.poll() is not None:raise RuntimeError(f'{label} exited {child.returncode}')
     try:
      with urllib.request.urlopen(url,timeout=.3) as r:assert r.read()==b'Hello, World!'
      break
     except OSError:time.sleep(.02)
    else:raise RuntimeError('startup timeout')
    subprocess.run(['wrk','-t2',f'-c{a.connections}','-d1s',url],capture_output=True,check=True,timeout=15)
    before=sched(child.pid)
    raw=subprocess.check_output(['wrk','-t2',f'-c{a.connections}',f'-d{a.duration}s','--latency',url],text=True,timeout=a.duration+15)
    if 'Socket errors:' in raw or 'Non-2xx' in raw:raise RuntimeError(raw)
    after=sched(child.pid)
    row={'variant':label,'round':i+1,'rps':float(re.search(r'Requests/sec:\s+([\d.]+)',raw)[1]),'p50_ms':latency(raw,50),'p99_ms':latency(raw,99),'scheduler_delta':{k:after[k]-before.get(k,0) for k in after},'raw':raw};rows.append(row)
    (out/'samples.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps({k:v for k,v in row.items() if k!='raw'}),flush=True)
   finally:
    if child.poll() is None:
     os.killpg(child.pid,signal.SIGTERM)
     try:child.wait(timeout=5)
     except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
summary={v['name']:{m:statistics.median(r[m] for r in rows if r['variant']==v['name']) for m in ['rps','p50_ms','p99_ms']} for v in variants}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary),flush=True)
