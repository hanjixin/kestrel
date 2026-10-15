// Correctness: every function here must give identical results on V8 and native.
export function fib(n: number): number { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
function bits(a: number, b: number): number {
  return ((a | 0) + (a & b) + (a ^ b) + (a << 3) + (a >> 2) + (a >>> 1) + (~b)) % 1000003;
}
function mixed(x: number): number {
  let acc = 0;
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0 && x > 0 || i === 3) acc += Math.floor(x / (i + 1));
    else acc -= Math.sqrt(Math.abs(x)) * 0.5;
    acc = acc ** 1.0001;
  }
  return acc !== acc ? -1 : acc;
}
function loopy(n: number): number {
  let s = 0, i = 0;
  while (true) { if (i >= n) break; if (i % 7 === 0) { i++; continue; } s += i * 1.5; i++; }
  do { s -= 1; } while (s > 1e9);
  return s;
}
function trunc32(x: number): number { return x | 0; }
function notReturning(x: number): number { if (x > 0) return 1; }  // falls through -> stays on V8
function usesString(x: number): number { const s = "a" + x; return s.length; } // stays on V8
let counter = 0;
function reassigned(x: number): number { return x + counter; }
reassigned = (x) => x;

const out = [
  fib(20), bits(123456789, -987654321), bits(2 ** 40 + 7, -(2 ** 33)), bits(NaN, Infinity), bits(2 ** 70, 3.7),
  mixed(12345.678), mixed(-3), loopy(1000), trunc32(2147483648), trunc32(-0.9), trunc32(1e21), trunc32(-1e21), trunc32(2 ** 63 + 2 ** 12),
  notReturning(1), usesString(5), reassigned(5),
  // guard fall-back: non-number args must behave exactly like plain JS
  (fib as any)("5"), (bits as any)(true, "3"), fib.length, fib.name,
  (() => { try { return fib(NaN); } catch (e) { return (e as Error).name + ": " + (e as Error).message; } })(),
  (() => { try { return fib(30); } catch (e) { return "bad"; } })(),
];
console.log(JSON.stringify(out));
