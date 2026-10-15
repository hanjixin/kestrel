// Cold path: each function runs exactly once, so JIT warm-up is part of the cost.
function collatzMax(limit: number): number {
  let best = 0;
  for (let n = 1; n < limit; n++) {
    let x = n, steps = 0;
    while (x !== 1) { x = x % 2 === 0 ? x / 2 : 3 * x + 1; steps++; }
    if (steps > best) best = steps;
  }
  return best;
}
function piLeibniz(terms: number): number {
  let s = 0;
  for (let k = 0; k < terms; k++) s += (k % 2 === 0 ? 1 : -1) / (2 * k + 1);
  return 4 * s;
}
const t = performance.now();
const a = collatzMax(300000);
const b = piLeibniz(5_000_000);
console.log("cold:", a, b.toFixed(6), "in", (performance.now() - t).toFixed(1), "ms");
