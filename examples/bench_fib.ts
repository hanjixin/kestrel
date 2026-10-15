function fib(n: number): number { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
const t = performance.now();
const r = fib(35);
console.log("fib(35) =", r, "in", (performance.now() - t).toFixed(1), "ms");
