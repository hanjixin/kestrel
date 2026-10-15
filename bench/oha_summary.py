import json, sys
tot = 0.0; p50 = []; p99 = []; ok = 0; n = 0
for f in sys.argv[1:]:
    d = json.load(open(f)); s = d["summary"]; p = d.get("latencyPercentiles") or {}
    tot += s["requestsPerSec"]; n += 1
    if p.get("p50") is not None: p50.append(p["p50"]); p99.append(p["p99"])
    ok += s.get("successRate", 0)
lat = f'p50 {max(p50)*1000:6.2f} ms   p99 {max(p99)*1000:6.2f} ms' if p50 else 'latency n/a'
print(f'{tot:9.0f} req/s   {lat}   success {ok/n*100:.1f}%')
