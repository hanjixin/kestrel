function mandel(w: number, h: number, maxIter: number): number {
  let count = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x0 = (px / w) * 3.5 - 2.5, y0 = (py / h) * 2 - 1;
      let x = 0, y = 0, i = 0;
      while (x * x + y * y <= 4 && i < maxIter) { const xt = x * x - y * y + x0; y = 2 * x * y + y0; x = xt; i++; }
      count += i;
    }
  }
  return count;
}
const t = performance.now();
const r = mandel(1200, 800, 200);
console.log("mandel =", r, "in", (performance.now() - t).toFixed(1), "ms");
