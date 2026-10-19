/* String art core, shared by the page (app.js) and the workers (worker.js):
   nail layout, color separation, the line solver, a model of the preview image,
   and a score of how closely a preview matches the photo. No network access. */
(function (G) {
  'use strict';
  const SA = {};

  // ---------- nails ----------
  /* Nail layout for a frame of width A and height 1 (A = width / height).
     Returns positions as fractions of the frame width (u, to the right) and height (v, down),
     the outward direction at each nail (radians, counter-clockwise, 0 = right), the frame
     sides each nail lies on (bit mask, rectangles only), and the perimeter in height units.
     Nails are equally spaced by arc length, nail 0 at the middle of the right side,
     numbered counter-clockwise. */
  SA.nailLayout = function (shape, n, A) {
    const u = new Float64Array(n), v = new Float64Array(n), dir = new Float64Array(n), edge = new Uint8Array(n);
    let P;
    if (shape === 'circle' || (shape === 'ellipse' && Math.abs(A - 1) < 1e-6)) {
      for (let i = 0; i < n; i++) { const t = 2 * Math.PI * i / n; u[i] = 0.5 + 0.5 * Math.cos(t); v[i] = 0.5 - 0.5 * Math.sin(t); dir[i] = t; }
      P = Math.PI * Math.min(A, 1);
    } else if (shape === 'ellipse') {
      const a = A / 2, b = 0.5, M = 8192, L = new Float64Array(M + 1);
      for (let k = 1; k <= M; k++) {
        const t0 = 2 * Math.PI * (k - 1) / M, t1 = 2 * Math.PI * k / M;
        L[k] = L[k - 1] + Math.hypot(a * (Math.cos(t1) - Math.cos(t0)), b * (Math.sin(t1) - Math.sin(t0)));
      }
      P = L[M];
      for (let i = 0, k = 0; i < n; i++) {
        const s = i * P / n;
        while (L[k + 1] < s) k++;
        const t = 2 * Math.PI * (k + (s - L[k]) / (L[k + 1] - L[k])) / M;
        u[i] = 0.5 + 0.5 * Math.cos(t); v[i] = 0.5 - 0.5 * Math.sin(t);
        dir[i] = Math.atan2(Math.sin(t) / b, Math.cos(t) / a);
      }
    } else { // square or rectangle
      P = 2 * (A + 1);
      // path segments: [x0, y0, x1, y1, side bit, outward direction]
      const seg = [[A, 0.5, A, 0, 1, 0], [A, 0, 0, 0, 2, Math.PI / 2], [0, 0, 0, 1, 4, Math.PI], [0, 1, A, 1, 8, -Math.PI / 2], [A, 1, A, 0.5, 1, 0]];
      const eps = P * 1e-7;
      for (let i = 0; i < n; i++) {
        let s = i * P / n, q = 0;
        for (; q < seg.length - 1; q++) { const l = Math.hypot(seg[q][2] - seg[q][0], seg[q][3] - seg[q][1]); if (s <= l + eps) break; s -= l; }
        const g = seg[q], l = Math.hypot(g[2] - g[0], g[3] - g[1]), f = Math.min(1, Math.max(0, s / l));
        const x = g[0] + (g[2] - g[0]) * f, y = g[1] + (g[3] - g[1]) * f;
        u[i] = x / A; v[i] = y; edge[i] = g[4]; dir[i] = g[5];
        const cx = x < eps ? 4 : x > A - eps ? 1 : 0, cy = y < eps ? 2 : y > 1 - eps ? 8 : 0;
        if (cx && cy) { edge[i] = cx | cy; dir[i] = Math.atan2(cy === 2 ? 1 : -1, cx === 1 ? 1 : -1); }
      }
    }
    return { u, v, dir, edge, P };
  };
  // working size in pixels for frame proportions A, longer side = T
  SA.workSize = (A, T) => (A >= 1 ? [T, Math.max(1, Math.round(T / A))] : [Math.max(1, Math.round(T * A)), T]);
  // nail positions in pixels of a w x h working image (float); the solver rounds them
  SA.nailPx = function (lay, w, h) {
    const n = lay.u.length, X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = (w - 1) / 2 + (lay.u[i] - 0.5) * (w - 2); Y[i] = (h - 1) / 2 + (lay.v[i] - 0.5) * (h - 2); }
    return { X, Y };
  };
  SA.DEPOSIT = 0.65;   // need removed per line, per unit of strength (one thread); set by benchmark
  SA.skipFor = (n) => Math.round(n * 20 / 288);
  SA.insideMask = function (shape, w, h) {
    const m = new Uint8Array(w * h);
    if (shape === 'circle' || shape === 'ellipse') {
      const cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2;
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { const a = (x - cx) / rx, b = (y - cy) / ry; m[i] = a * a + b * b <= 1 ? 1 : 0; }
    } else m.fill(1);
    return m;
  };

  // ---------- color ----------
  const hex2rgb = SA.hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = SA.lum = (h) => { const [r, g, b] = hex2rgb(h); return 0.299 * r + 0.587 * g + 0.114 * b; };
  SA.lightOnDark = (thread, board) => lum(thread) > lum(board);
  const LIN4 = new Float64Array(4097);
  for (let i = 0; i <= 4096; i++) { const x = i / 4096; LIN4[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
  // sRGB value (0-255, float) to linear light, by table with linear interpolation
  const lin = (x) => { x = x * (4096 / 255); if (x <= 0) return 0; if (x >= 4096) return 1; const i = x | 0, f = x - i; return LIN4[i] + (LIN4[i + 1] - LIN4[i]) * f; };
  const ft = (x) => (x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116);
  // sRGB (0-255, float allowed) to CIELAB (D65), written into out[o..o+2]
  function labInto(r, g, b, out, o) {
    r = lin(r); g = lin(g); b = lin(b);
    const X = ft((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), Y = ft(0.2126 * r + 0.7152 * g + 0.0722 * b), Z = ft((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    out[o] = 116 * Y - 16; out[o + 1] = 500 * (X - Y); out[o + 2] = 200 * (Y - Z);
  }
  SA.lab = function (hex) { const c = hex2rgb(hex), o = [0, 0, 0]; labInto(c[0], c[1], c[2], o, 0); return o; };

  // Luminance range that clips the darkest and lightest 1% of pixels inside the frame.
  SA.levels = function (d, inside) {
    const hist = new Uint32Array(256); let count = 0;
    for (let i = 0; i < inside.length; i++) if (inside[i]) { hist[(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0]++; count++; }
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > count * 0.01) break; }
    for (acc = 0; hi > 0; hi--) { acc += hist[hi]; if (acc > count * 0.01) break; }
    if (hi <= lo) { lo = 0; hi = 255; }
    return [lo, hi];
  };
  // One thread: coverage follows the photo's brightness. A dark thread on a light board covers
  // the dark parts; a light thread on a dark board covers the light parts.
  SA.monoMap = function (d, inside, light) {
    const [lo, hi] = SA.levels(d, inside), N = inside.length, map = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (!inside[i]) continue;
      let a = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2] - lo) / (hi - lo); a = a < 0 ? 0 : a > 1 ? 1 : a;
      map[i] = light ? 1 - Math.pow(1 - a, 1.8) : 1 - Math.pow(a, 1.8);  // exponent 1.8 strengthens mid-tones
    }
    return [map];
  };
  function projectCapped(a) {   // project onto {a_k >= 0, sum a_k <= 1}
    for (let k = 0; k < a.length; k++) if (a[k] < 0) a[k] = 0;
    let s = 0; for (let k = 0; k < a.length; k++) s += a[k];
    if (s <= 1) return;
    const z = Array.from(a).sort((p, q) => q - p); let cum = 0, th = 0;
    for (let j = 0; j < z.length; j++) { cum += z[j]; const t = (cum - 1) / (j + 1); if (z[j] - t > 0) th = t; }
    for (let k = 0; k < a.length; k++) a[k] = Math.max(0, a[k] - th);
  }
  /* Coverages a_k >= 0, sum <= 1, so that board + sum a_k (thread_k - board) is closest to T
     (sRGB, 0-1). Projected gradient descent. Returns the squared error; a holds the result. */
  function mix(T, B, D, a, iters, eta, r) {
    const K = D.length;
    a.fill(1 / (K + 1));
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < 3; c++) { let v = B[c] - T[c]; for (let k = 0; k < K; k++) v += a[k] * D[k][c]; r[c] = v; }
      for (let k = 0; k < K; k++) a[k] -= eta * (r[0] * D[k][0] + r[1] * D[k][1] + r[2] * D[k][2]);
      projectCapped(a);
    }
  }
  /* Several threads: coverage of each thread color per pixel, from a 32 x 32 x 32 lookup table.
     The photo's brightness range is first mapped onto the range the threads and board can show. */
  const lutCache = new Map();
  SA.multiMaps = function (d, inside, threads, board, mo) {
    const linear = mo && mo.linear != null ? mo.linear : SA.LINEAR_MIX, tf = linear ? (x) => lin(x * 255) : (x) => x;
    const K = threads.length, B = hex2rgb(board).map((x) => tf(x / 255));
    const D = threads.map((t) => hex2rgb(t).map((x, c) => tf(x / 255) - B[c]));
    let tr = 0; for (const dd of D) for (const x of dd) tr += x * x;
    const eta = 1 / Math.max(tr, 1e-6), Q = 32, key = (linear ? 'L' : 'S') + board + threads.join('');
    // table entries are computed when first needed (NaN = not yet computed)
    let lut = lutCache.get(key);
    if (!lut) {
      lut = new Float32Array(Q * Q * Q * K).fill(NaN);
      if (lutCache.size > 12) lutCache.clear();
      lutCache.set(key, lut);
    }
    const a = new Float64Array(K), r = [0, 0, 0];
    const entry = (ri, gi, bi) => {
      const o = ((ri * Q + gi) * Q + bi) * K;
      if (lut[o] !== lut[o]) {
        mix([tf(ri / (Q - 1)), tf(gi / (Q - 1)), tf(bi / (Q - 1))], B, D, a, 150, eta, r);
        for (let k = 0; k < K; k++) lut[o + k] = a[k];
      }
      return o;
    };
    const [lo, hi] = SA.levels(d, inside), N = inside.length;
    const L = [board].concat(threads).map((h) => lum(h) / 255), tlo = Math.min(...L), thi = Math.max(...L);
    const BOOST = 1.8, GAM = 1.3;
    const q = (x) => { x = (x - lo) / (hi - lo); x = x < 0 ? 0 : x > 1 ? 1 : x; x = tlo + (thi - tlo) * Math.pow(x, GAM); return Math.round(x * (Q - 1)); };
    const maps = threads.map(() => new Float32Array(N));
    for (let i = 0; i < N; i++) {
      if (!inside[i]) continue;
      const o = entry(q(d[i * 4]), q(d[i * 4 + 1]), q(d[i * 4 + 2]));
      for (let k = 0; k < K; k++) maps[k][i] = 1 - Math.pow(1 - lut[o + k], BOOST);
    }
    return maps;
  };
  SA.LINEAR_MIX = false;
  SA.maps = function (d, inside, threads, board, mo) {
    return threads.length > 1 ? SA.multiMaps(d, inside, threads, board, mo) : SA.monoMap(d, inside, SA.lightOnDark(threads[0], board));
  };
  // Lines are shared out in proportion to each map's total coverage, at least 5% each.
  SA.budgets = function (maps, L) {
    const s = maps.map((m) => { let t = 0; for (let i = 0; i < m.length; i++) t += m[i]; return t; });
    const tot = s.reduce((p, q) => p + q, 0) || 1, min = 0.05;
    let f = s.map((x) => Math.max(min, x / tot)); const fs = f.reduce((p, q) => p + q, 0); f = f.map((x) => x / fs);
    const b = f.map((x) => Math.round(x * L)); b[b.length - 1] += L - b.reduce((p, q) => p + q, 0);
    return b;
  };

  // ---------- solver ----------
  /* Pixels under every usable nail pair. A pair is usable if the nails are more than `skip`
     apart along the frame and do not lie on the same straight side. Each line steps one pixel
     along its major axis. NX, NY: integer nail positions. */
  // sa8: the pixels of one line (nail i to nail j, i < j), written to out from position q; returns the end position.
  // Integer stepping, the same pixels as Math.round(x0 + dx * s / L), Math.round(y0 + dy * s / L)
  // (round half up: floor((2 d s + L) / 2L) kept as quotient and remainder).
  const stepLine = (x0, y0, dx, dy, w, out, q) => {
    const L = Math.max(Math.abs(dx), Math.abs(dy));
    if (L === 0) { out[q] = y0 * w + x0; return q + 1; }
    const L2 = 2 * L, ax = 2 * dx, ay = 2 * dy;
    let qx = Math.floor(L / L2), rx = L - qx * L2, qy = qx, ry = rx;
    for (let s = 0; s <= L; s++) {
      // at an exact half (remainder 0) the old float expression decides, so the pixels stay the same
      out[q++] = (ry === 0 ? Math.round(y0 + dy * (s / L)) : y0 + qy) * w + (rx === 0 ? Math.round(x0 + dx * (s / L)) : x0 + qx);
      rx += ax; while (rx >= L2) { rx -= L2; qx++; } while (rx < 0) { rx += L2; qx--; }
      ry += ay; while (ry >= L2) { ry -= L2; qy++; } while (ry < 0) { ry += L2; qy--; }
    }
    return q;
  };
  /* sa8: SA.linePix(P, i, j, out): the pixels of the line between nails i and j into out; returns how many.
     With a table (P.pix) it copies them; without (P.lazy) it steps the line, so no table is kept. */
  SA.linePix = function (P, i, j, out) {
    if (i > j) { const t = i; i = j; j = t; }
    if (!P.lazy) { const pr = P.rowStart[i] + (j - i - 1), a = P.offs[pr], b = P.offs[pr + 1]; for (let k = a; k < b; k++) out[k - a] = P.pix[k]; return b - a; }
    return stepLine(P.NX[i], P.NY[i], P.NX[j] - P.NX[i], P.NY[j] - P.NY[i], P.w, out, 0);
  };
  // bytes of the line table SA.prepare would build (without making it), for the memory check
  SA.tableBytes = function (n, NX, NY, edge, skip) {
    let total = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let d = j - i; if (n - d < d) d = n - d;
      if (d > skip && !(edge[i] & edge[j])) total += Math.max(Math.abs(NX[j] - NX[i]), Math.abs(NY[j] - NY[i])) + 1;
    }
    return total * 4;
  };
  // lazy (sa8): no line table; offs then holds line lengths as offsets only (for usable / length) and the
  // solver steps each line when it needs it (memory stays small at any nail count; slower)
  SA.prepare = function (n, NX, NY, edge, w, skip, onProgress, lazy) {
    const pairs = n * (n - 1) / 2, offs = new Uint32Array(pairs + 1);
    let p = 0, total = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      offs[p++] = total;
      let d = j - i; if (n - d < d) d = n - d;
      if (d > skip && !(edge[i] & edge[j])) total += Math.max(Math.abs(NX[j] - NX[i]), Math.abs(NY[j] - NY[i])) + 1;
    }
    offs[pairs] = total;
    const rowStart = new Uint32Array(n);
    for (let i = 0, acc = 0; i < n; i++) { rowStart[i] = acc; acc += n - 1 - i; }
    if (lazy) return { n, offs, pix: null, lazy: true, rowStart, NX, NY, w };
    const pix = new Uint32Array(total);
    p = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++, p++) {
        if (offs[p + 1] === offs[p]) continue;
        stepLine(NX[i], NY[i], NX[j] - NX[i], NY[j] - NY[i], w, pix, offs[p]);
      }
      if (onProgress && i % 12 === 0) onProgress(i / n);
    }
    return { n, offs, pix, rowStart, NX, NY, w };
  };
  /* Greedy line choice, one thread at a time in winding order. From the current nail, every
     line to another nail is scored by the average remaining need along it; the best line is
     taken and the need under it is reduced by `strength`.
     o.clip: need stops at zero. Otherwise need can go below zero, so a line over an area that
       already has enough thread scores lower. Default: below zero with one thread (it scores
       better there), stop at zero with several threads (it scores better there).
     o.repeat: allow the same nail pair twice in one thread.
     o.stop(color, k, order): called after every line; returning true ends that thread there.
     With several threads, a line also scores lower where it crosses areas that need the other
     threads more (o.penalty). onLine(color, k, order) is called after every line. */
  SA.solve = function (P, maps, bud, strength, o, onLine) {
    o = o || {};
    const n = P.n, offs = P.offs, pix = P.pix, rowStart = P.rowStart, K = maps.length;
    const lam = K > 1 ? (o.penalty == null ? 0.25 : o.penalty) : 0, clip = o.clip == null ? K > 1 : !!o.clip;
    const orig = K > 1 ? maps.map((m) => m.slice()) : null;
    const dep = strength * (o.deposit == null ? SA.DEPOSIT : o.deposit);
    const orders = [], counts = []; let carry = 0;
    for (let c = 0; c < K; c++) {
      const dark = maps[c], lines = bud[c] + carry;
      let val = dark;
      if (lam > 0) {
        val = new Float32Array(dark.length);
        for (let i = 0; i < val.length; i++) { let x = 0; for (let j = 0; j < K; j++) if (j !== c) x += orig[j][i]; x -= orig[c][i]; val[i] = dark[i] - (x > 0 ? lam * x : 0); }
      }
      const used = o.repeat ? null : new Uint8Array(offs.length);
      const order = new Uint16Array(lines + 1);
      let cur = o.start || 0, prev = -1, k = 0;
      order[0] = cur;
      if (o.onStart) o.onStart(c, order, lines);
      for (k = 0; k < lines; k++) {
        let best = 0, bj = -1, bp = 0;
        const rc = rowStart[cur];
        for (let j = 0; j < n; j++) {
          if (j === cur || j === prev) continue;
          const pr = cur < j ? rc + (j - cur - 1) : rowStart[j] + (cur - j - 1);
          const a = offs[pr], b = offs[pr + 1];
          if (a === b || (used && used[pr])) continue;
          let sum = 0;
          for (let q = a; q < b; q++) sum += val[pix[q]];
          const score = sum / (b - a);
          if (score > best) { best = score; bj = j; bp = pr; }
        }
        if (bj < 0) break; // no line adds anything
        if (used) used[bp] = 1;
        const a = offs[bp], b = offs[bp + 1];
        if (clip) {
          if (val === dark) for (let q = a; q < b; q++) { const v = dark[pix[q]] - strength; dark[pix[q]] = v > 0 ? v : 0; }
          else for (let q = a; q < b; q++) { const i = pix[q], dd = dark[i] < strength ? dark[i] : strength; dark[i] -= dd; val[i] -= dd; }
        } else {
          if (val === dark) for (let q = a; q < b; q++) dark[pix[q]] -= dep;
          else for (let q = a; q < b; q++) { const i = pix[q]; dark[i] -= dep; val[i] -= dep; }
        }
        prev = cur; cur = bj; order[k + 1] = cur;
        if (onLine) onLine(c, k + 1, order);
        if (o.stop && o.stop(c, k + 1, order)) { k++; break; }
      }
      carry = lines - k;   // lines a thread does not use pass to the next thread
      orders.push(order); counts.push(k);
      if (o.onEnd) o.onEnd(c, k);
    }
    return { orders, counts };
  };

  // ---------- joint solver (several threads) ----------
  /* All threads are placed together on one simulated board. The board is kept as it looks:
     opaque thread SA.THREAD_MM wide over the board color, later lines on top, in a linear
     opponent color space (lightness Y, red-green X/Xn - Y, blue-yellow Y - Z/Zn). The error
     against the photo is weighted as CIELAB sees it (more weight in dark areas, a* and b*
     scaled as in CIELAB) and, as seen from the viewing distance, color differences count
     partly blurred over a wider area (S-CIELAB), so neighboring lines of two colors can mix.
     Each step takes the line, from the current nail of a thread, that lowers the error most.
     Threads are wound in turns of at least o.minBlock lines; another thread takes over when its
     best line beats the current thread's best line. It stops when no line lowers the error, or
     after o.maxLines lines.
     P: SA.prepare at the working size; d: photo RGBA at that size; inside: frame mask.
     o: {frameMM, viewMM, maxLines, minBlock, chromaW, refresh, stop(total) -> true to stop}.
     Returns {orders, counts, blocks: [[thread, from, to], ...]} (lines from..to-1 of a thread). */
  SA.solveJoint = function (P, d, inside, threads, board, o) {
    o = o || {};
    const n = P.n, offs = P.offs, pix = P.pix, rowStart = P.rowStart, w = P.w, N = inside.length, h = N / w, K = threads.length;
    // sa8: without a line table (P.lazy) each line is stepped into lp when needed
    const lazy = !!P.lazy, lp = lazy ? new Uint32Array(Math.max(w, h) + 2) : null;
    const frameMM = o.frameMM || 400, viewMM = o.viewMM || SA.viewMM(frameMM);
    const c0 = SA.THREAD_MM * Math.max(w, h) / frameMM;
    const maxLines = o.maxLines || 6000, minBlock = o.minBlock == null ? 60 : o.minBlock, refresh = o.refresh || 32;
    // colors as XYZ / white point (linear)
    const xyz = (r, g, b) => [(0.4124 * r + 0.3576 * g + 0.1805 * b) / XN, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / ZN];
    const hx = (hexc) => { const c = hex2rgb(hexc); return xyz(lin(c[0]), lin(c[1]), lin(c[2])); };
    const tau = threads.map(hx), B0 = hx(board);
    // per pixel: canvas C (XYZ), target CIELAB, error e = Lab(C) - Lab(target)
    const C = [new Float32Array(N), new Float32Array(N), new Float32Array(N)], TL = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    const e = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    const labOf = (X, Y, Z, out) => { const fx = ft(X), fy = ft(Y), fz = ft(Z); out[0] = 116 * fy - 16; out[1] = 500 * (fx - fy); out[2] = 200 * (fy - fz); };
    const q = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const T = xyz(lin(d[i * 4]), lin(d[i * 4 + 1]), lin(d[i * 4 + 2]));
      labOf(T[0], T[1], T[2], q); TL[0][i] = q[0]; TL[1][i] = q[1]; TL[2][i] = q[2];
      for (let c = 0; c < 3; c++) C[c][i] = B0[c];
    }
    function setErr(i) {   // error at the current canvas color
      labOf(C[0][i], C[1][i], C[2][i], q);
      e[0][i] = q[0] - TL[0][i]; e[1][i] = q[1] - TL[1][i]; e[2][i] = q[2] - TL[2][i];
    }
    // Experimental objective options (sa8 study; off by default):
    //  o.toneK: target lightness compressed toward the board's by this share (dark threads spend less on deep shadows)
    //  o.hiW: lightness error counts up to 1 + hiW times in the photo's highlights (L* 70-100: fewer dark streaks there); sa8 default SA.HI_W
    //  o.centerW: lightness error counts up to 1 + centerW times near the centre (a cheap stand-in for face saliency)
    // o.hiW applies on a light board only (L* over 50: the threads darken it, and dark lines over highlights are the streaks).
    // sa8 defaults (SA.HI_W, SA.DETAIL_CAP) apply to one thread on a light board only: with colour palettes they lost
    // hues (the wave's blue) in the bench; an explicit o.hiW / o.detailCap applies as given
    labOf(B0[0], B0[1], B0[2], q); const lightBoard = q[0] > 50, monoLight = K === 1 && lightBoard;
    const toneK = o.toneK || 0, hiW = lightBoard ? (o.hiW == null ? (monoLight ? SA.HI_W : 0) : o.hiW) : 0, centerW = o.centerW || 0;
    if (toneK) { labOf(B0[0], B0[1], B0[2], q); const Lb = q[0]; for (let i = 0; i < N; i++) TL[0][i] = Lb + (TL[0][i] - Lb) * (1 - toneK); }
    const wpx = hiW || centerW ? new Float32Array(N) : null;
    if (wpx) for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const dx = (x - (w - 1) / 2) / (Math.max(w, h) / 2), dy = (y - (h - 1) / 2) / (Math.max(w, h) / 2);
      wpx[i] = 1 + hiW * Math.max(0, (TL[0][i] - 70) / 30) + centerW * Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
    }
    for (let i = 0; i < N; i++) setErr(i);
    // weights: lightness 1, color chromaW (the match score counts color more)
    const cw = o.chromaW == null ? 2 : o.chromaW, Wc = [1, cw, cw];
    // S-CIELAB: share of each channel seen sharp and blurred, blur width in pixels
    const ppd = Math.max(w, h) / frameMM * viewMM * Math.tan(Math.PI / 180);
    const alpha = [1, 0.616725, 0.567885], beta = [0, 0.383275, 0.432115], sigPx = [0, 0.826 * ppd / 2.3548, 0.6451 * ppd / 2.3548];
    // the blurred part on a coarse grid of f x f pixel cells
    const f = Math.max(1, Math.round(sigPx[2] / 1.5)), gw = Math.ceil(w / f), gh = Math.ceil(h / f), GN = gw * gh, f2 = 1 / (f * f);
    const cell = new Uint32Array(N); for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) cell[i] = ((y / f) | 0) * gw + ((x / f) | 0);
    const Ec = [null, new Float32Array(GN), new Float32Array(GN)], F = [null, new Float32Array(GN), new Float32Array(GN)];
    for (let c = 1; c < 3; c++) for (let i = 0; i < N; i++) if (inside[i]) Ec[c][cell[i]] += e[c][i] * f2;
    const kap = [0, 1 / (2 * Math.sqrt(Math.PI) * sigPx[1]), 1 / (2 * Math.sqrt(Math.PI) * sigPx[2])];
    // Detail term (sa7): squared error of band-pass detail in lightness, DoG of 1.5 % - 4.5 % of the frame width
    // (the scale the match score's detail term looks at). Linearised like the blurred colour part: field
    // Hd = B'B e_L, refreshed with F, on a grid of fd x fd pixel cells (about 100 cells across), plus the
    // self term kD per unit of line length.
    const lamD = o.detailW == null ? SA.DETAIL_W : o.detailW, W0 = Math.max(w, h), fd = Math.max(1, Math.round(W0 / 100));
    const dw = Math.ceil(w / fd), dh = Math.ceil(h / fd), DN = dw * dh, sD1 = 0.015 * W0, sD2 = 0.045 * W0;
    const kD = lamD ? 1 / (2 * Math.sqrt(Math.PI) * sD1) + 1 / (2 * Math.sqrt(Math.PI) * sD2) - 2 / Math.sqrt(2 * Math.PI * (sD1 * sD1 + sD2 * sD2)) : 0;
    const dcell = new Uint32Array(N); for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) dcell[i] = ((y / fd) | 0) * dw + ((x / fd) | 0);
    const Hc = new Float32Array(DN), e0r = new Float32Array(N), Ein = new Float32Array(DN), Min = new Float32Array(DN);
    for (let i = 0; i < N; i++) if (inside[i]) Min[dcell[i]] += 1 / (fd * fd);
    const dog = (x) => { const p = SA.boxBlur(x, dw, dh, sD1 / fd), q = SA.boxBlur(x, dw, dh, sD2 / fd); for (let i = 0; i < DN; i++) p[i] = (p[i] - q[i]) * Min[i]; return p; };
    // o.fineW (sa8 study, off by default): a second, finer detail band (DoG o.fineS1-o.fineS2 of the width,
    // default 0.5 %-1.5 %), full resolution, true Gaussians, same linearisation as the detail term
    const lamF = o.fineW || 0, sF1 = (o.fineS1 || 0.005) * W0, sF2 = (o.fineS2 || 0.015) * W0;
    const kF = lamF ? 1 / (2 * Math.sqrt(Math.PI) * sF1) + 1 / (2 * Math.sqrt(Math.PI) * sF2) - 2 / Math.sqrt(2 * Math.PI * (sF1 * sF1 + sF2 * sF2)) : 0;
    const Hf = lamF ? new Float32Array(N) : null, e0f = lamF ? new Float32Array(N) : null, Ef = lamF ? new Float32Array(N) : null;
    const gF = (x, sg) => gaussN(x, null, w, h, sg, null);
    const fEvery = Math.max(1, o.fineEvery || 1); let nRefF = 0;
    // the detail field can be refreshed every dEvery-th time only (the search does this to save time)
    const dEvery = Math.max(1, o.detailEvery || 1); let nRef = 0;
    const dCap = o.detailCap == null ? (monoLight ? SA.DETAIL_CAP : 0) : o.detailCap;
    const neutral = [board].concat(threads).every((x) => { const c = hex2rgb(x); return c[0] === c[1] && c[1] === c[2]; }); let fDone = false;
    function refreshF() {
      if (lamH) hueRefresh();
      // sa9: with grey threads on a grey board (r = g = b: black on white, the 'Black and white' presets) the
      // canvas stays neutral, so the color error and its blur F never change: F is made once (same result, faster)
      if (!neutral || !fDone) for (let c = 1; c < 3; c++) { const sg = sigPx[c] / f; F[c] = gaussN(gaussN(Ec[c], null, gw, gh, sg, null), null, gw, gh, sg, null); }
      fDone = true;
      if (lamD && nRef++ % dEvery === 0) {
        Ein.fill(0);
        for (let i = 0; i < N; i++) { e0r[i] = e[0][i]; if (inside[i]) Ein[dcell[i]] += e[0][i] / (fd * fd); }
        const a = dog(Ein);
        // o.detailCap (sa8 study): band error clipped to +-detailCap (L* units), so one strong edge band
        // cannot keep attracting lines (stacked dark streaks)
        if (dCap) for (let i = 0; i < DN; i++) a[i] = a[i] > dCap ? dCap : a[i] < -dCap ? -dCap : a[i];
        if (o.__dbg && nRef === 1) { const s = Array.from(a).map(Math.abs).sort((x, y) => x - y); console.log('band |a| p50', s[DN >> 1].toFixed(2), 'p90', s[(DN * 0.9) | 0].toFixed(2), 'p99', s[(DN * 0.99) | 0].toFixed(2)); }
        const p = SA.boxBlur(a, dw, dh, sD1 / fd), q = SA.boxBlur(a, dw, dh, sD2 / fd);
        for (let i = 0; i < DN; i++) Hc[i] = p[i] - q[i];
      }
      if (lamF && nRefF++ % fEvery === 0) {
        // B'B for B = G1 - G2 is G(sqrt2 s1) - 2 G(sqrt(s1^2 + s2^2)) + G(sqrt2 s2) (Gaussians compose); the
        // three as three-box blurs of the same variance (SA.boxBlur)
        for (let i = 0; i < N; i++) { e0f[i] = e[0][i]; Ef[i] = inside[i] ? e[0][i] : 0; }
        const g1 = SA.boxBlur(Ef, w, h, Math.SQRT2 * sF1), g2 = SA.boxBlur(Ef, w, h, Math.sqrt(sF1 * sF1 + sF2 * sF2)), g3 = SA.boxBlur(Ef, w, h, Math.SQRT2 * sF2);
        for (let i = 0; i < N; i++) Hf[i] = g1[i] - 2 * g2[i] + g3[i];
      }
    }
    // Key-hue term (sa8): lamH x (number of pixels) x sum over 12 hue bins of (render - photo)^2 of the
    // chroma-weighted hue mix (as the match score's hue term, but squared and on the solver's own Lab).
    // Linearised: the bin weights G are refreshed with F; per pixel and thread the change of the
    // pixel's hue contribution over one line's coverage is kept (setD), so a light colored thread
    // keeps its value where its hue is missing even when the detail term favours dark lines.
    const lamH = K > 1 ? (o.hueW == null ? SA.HUE_W : o.hueW) : 0, HB = 12, HS = HB / (2 * Math.PI);
    const Hp = new Float64Array(HB), Hr = new Float64Array(HB), G = new Float64Array(HB + 1);   // G[HB] = G[0]
    let nIn = 0; for (let i = 0; i < N; i++) if (inside[i]) nIn++;
    const hb0 = lamH ? new Uint8Array(N) : null, hf0 = lamH ? new Float32Array(N) : null, hc0 = lamH ? new Float32Array(N) : null;
    const hb1 = lamH ? threads.map(() => new Uint8Array(N)) : null, hf1 = lamH ? threads.map(() => new Float32Array(N)) : null, hc1 = lamH ? threads.map(() => new Float32Array(N)) : null;
    let hB = 0, hF = 0, hC = 0;
    // hue angle by a fast atan2 (error under 0.005 rad, 1 % of a bin), in bins 0..HB
    const atan2f = (y, x) => {
      const ax = Math.abs(x), ay = Math.abs(y), mn = Math.min(ax, ay), mx = Math.max(ax, ay), z = mn / mx, z2 = z * z;
      let r = z * (0.9998660 + z2 * (-0.3302995 + z2 * (0.1801410 + z2 * (-0.0851330 + z2 * 0.0208351))));
      if (ay > ax) r = 1.5707963267948966 - r; if (x < 0) r = 3.141592653589793 - r; return y < 0 ? -r : r;
    };
    const hueOf = (a, b) => { const c2 = a * a + b * b; if (c2 < 1e-12) { hC = 0; hB = 0; hF = 0; return; } hC = Math.sqrt(c2); let x = atan2f(b, a) * HS; if (x < 0) x += HB; if (x >= HB) x -= HB; hB = x | 0; hF = x - hB; if (hB >= HB) { hB = 0; hF = 0; } };
    const hueG = (bn, fr, cc) => cc * (G[bn] + fr * (G[bn + 1] - G[bn]));
    const hueSet = (i) => { hueOf(TL[1][i] + e[1][i], TL[2][i] + e[2][i]); hb0[i] = hB; hf0[i] = hF; hc0[i] = hC; Hr[hB] += hC * (1 - hF); Hr[(hB + 1) % HB] += hC * hF; };
    const hueDrop = (i) => { const bn = hb0[i], fr = hf0[i], cc = hc0[i]; Hr[bn] -= cc * (1 - fr); Hr[(bn + 1) % HB] -= cc * fr; };
    if (lamH) for (let i = 0; i < N; i++) if (inside[i]) { hueOf(TL[1][i], TL[2][i]); Hp[hB] += hC * (1 - hF); Hp[(hB + 1) % HB] += hC * hF; hueSet(i); }
    const hueRefresh = () => { for (let k = 0; k < HB; k++) G[k] = 2 * lamH * (Hr[k] - Hp[k]) / nIn; G[HB] = G[0]; };
    // per thread and pixel: Lt (times the line coverage) and Qt (times coverage squared)
    const Lt = threads.map(() => new Float32Array(N)), Qt = threads.map(() => new Float32Array(N));
    const qa = [Wc[0] * alpha[0] + lamD * kD + lamF * kF, Wc[1] * (alpha[1] + beta[1] * kap[1]), Wc[2] * (alpha[2] + beta[2] * kap[2])];
    // Dt: CIELAB change per unit of coverage when one line of thread t crosses the pixel
    // (measured over one line's coverage c0, so it stays right for large steps such as light
    // thread on black)
    const Dt = threads.map(() => [new Float32Array(N), new Float32Array(N), new Float32Array(N)]), q2 = [0, 0, 0];
    function setD(i) {
      const X = C[0][i], Y = C[1][i], Z = C[2][i]; labOf(X, Y, Z, q);
      for (let t = 0; t < K; t++) {
        const tc = tau[t]; labOf(X + c0 * (tc[0] - X), Y + c0 * (tc[1] - Y), Z + c0 * (tc[2] - Z), q2);
        for (let c = 0; c < 3; c++) Dt[t][c][i] = (q2[c] - q[c]) / c0;
        if (lamH) { hueOf(q2[1], q2[2]); hb1[t][i] = hB; hf1[t][i] = hF; hc1[t][i] = hC; }
      }
    }
    // o.wmap (optional, per pixel, 0..1): importance of each pixel's error (SA.importance: the subject 1,
    // the background a low weight). Every error term of the pixel is scaled by it (weighted least squares).
    const wm = o.wmap && o.wmap.length === N ? o.wmap : null;
    function upd(i, onlyL) {   // onlyL: at a refresh only the linear part moves (Qt depends on the canvas only)
      if (!inside[i]) return;
      const g = cell[i], mi = wm ? wm[i] : 1;
      const wp = wpx ? wpx[i] : 1, g0 = mi * (Wc[0] * alpha[0] * e[0][i] * wp + (lamD ? lamD * (Hc[dcell[i]] + kD * (e[0][i] - e0r[i])) : 0) + (lamF ? lamF * (Hf[i] + kF * (e[0][i] - e0f[i])) : 0)), g1 = mi * Wc[1] * (alpha[1] * e[1][i] + beta[1] * F[1][g]), g2 = mi * Wc[2] * (alpha[2] * e[2][i] + beta[2] * F[2][g]);
      const h0 = lamH ? hueG(hb0[i], hf0[i], hc0[i]) : 0, ic0 = 1 / c0;
      for (let t = 0; t < K; t++) {
        const D = Dt[t], DL = D[0][i], Da = D[1][i], Db = D[2][i];
        Lt[t][i] = 2 * (g0 * DL + g1 * Da + g2 * Db) + (lamH ? (hueG(hb1[t][i], hf1[t][i], hc1[t][i]) - h0) * ic0 : 0) + (rpen ? rpen[i] : 0);
        if (!onlyL) Qt[t][i] = mi * ((qa[0] + (wp - 1) * Wc[0] * alpha[0]) * DL * DL + qa[1] * Da * Da + qa[2] * Db * Db);
      }
    }
    // sa9 options:
    //  o.reuseW (default SA.REUSE_W for one thread on a light board, else 0): per patch (o.reuseCell px, default 3) a penalty that grows with each line through it, weighted by the
    //    photo's gradient there (discourages many lines through one small high-gradient patch: the stacked 'Z' slash)
    //  o.edgeW: a fixed cost per line: sum along the line of (gradient . direction)^2 - (gradient . normal)^2
    //    (lines across strong edges cost more, lines along edges get a bonus; about zero on average)
    const reuseW = o.reuseW == null ? (monoLight ? SA.REUSE_W : 0) : o.reuseW, edgeW = o.edgeW || 0;  // edgeW: study only, off
    const rpen = reuseW ? new Float32Array(N) : null;
    let gx = null, gy = null, gm = null;
    if (reuseW || edgeW) {
      const Lb = SA.boxBlur(TL[0], w, h, 1); gx = new Float32Array(N); gy = new Float32Array(N); gm = new Float32Array(N);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx[i] = (Lb[i + 1] - Lb[i - 1]) / 2; gy[i] = (Lb[i + w] - Lb[i - w]) / 2; gm[i] = Math.hypot(gx[i], gy[i]); }
      const srt = Array.from(gm).filter((v, i) => inside[i]).sort((a, b) => a - b), g95 = srt[(srt.length * 0.95) | 0] || 1;
      for (let i = 0; i < N; i++) gm[i] = Math.min(1, gm[i] / g95);
    }
    for (let i = 0; i < N; i++) if (inside[i]) setD(i);
    refreshF();
    for (let i = 0; i < N; i++) upd(i);
    // line coverage: thread width over the pixels the line steps through
    const NX = P.NX, NY = P.NY;
    const cov = (i, j) => { const dx = NX[j] - NX[i], dy = NY[j] - NY[i], L = Math.max(Math.abs(dx), Math.abs(dy)); return L ? Math.min(1, c0 * Math.hypot(dx, dy) / L) : 0; };
    // scale of the study terms: mean |Lt| at the start (first thread)
    let ltScale = 0; if (reuseW || edgeW) { let c = 0; for (let i = 0; i < N; i++) if (inside[i]) { ltScale += Math.abs(Lt[0][i]); c++; } ltScale /= c || 1; }
    const rc = Math.max(1, o.reuseCell || 3), rw = Math.ceil(w / rc), rcnt = reuseW ? new Uint32Array(rw * Math.ceil(h / rc)) : null, rseen = reuseW ? new Uint32Array(rcnt.length) : null; let rstamp = 0;
    const covP = new Float64Array(offs.length);   // sa8: cov per nail pair, computed once (Math.hypot is slow)
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) covP[rowStart[i] + (j - i - 1)] = cov(i, j);
    // edge cost per pair (o.edgeW), already scaled: edgeW * ltScale * sum over the line of ((g.u)^2 - (g.n)^2) / mean |g|^2
    let EP = null;
    if (edgeW) {
      EP = new Float32Array(offs.length); const buf = new Uint32Array(Math.max(w, h) + 2); let g2 = 0, c = 0;
      for (let i = 0; i < N; i++) if (inside[i]) { g2 += gx[i] * gx[i] + gy[i] * gy[i]; c++; }
      g2 = g2 / (c || 1) || 1;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const pr = rowStart[i] + (j - i - 1); if (offs[pr] === offs[pr + 1]) continue;
        const dx = NX[j] - NX[i], dy = NY[j] - NY[i], L = Math.hypot(dx, dy); if (!L) continue;
        const ux = dx / L, uy = dy / L, m = SA.linePix(P, i, j, buf); let sc = 0;
        for (let k = 0; k < m; k++) { const p = buf[k]; if (inside[p]) { const d = gx[p] * ux + gy[p] * uy, e = gx[p] * uy - gy[p] * ux; sc += d * d - e * e; } }
        EP[pr] = edgeW * ltScale * sc / g2;
      }
    }
    const used = threads.map(() => new Uint8Array(offs.length));
    const cur = threads.map(() => o.start || 0), prev = threads.map(() => -1);
    const orders = threads.map((_, t) => [cur[t]]), blocks = [];
    // Each thread ties on at its best starting nail: its first line is the best line anywhere
    // (o.start: a fixed first nail for every thread instead).
    const started = new Uint8Array(K); if (o.start != null) started.fill(1);
    const lineD = (t, i, j, pr) => {
      let a = offs[pr], b = offs[pr + 1], px = pix; if (a === b) return 0;
      if (lazy) { b = SA.linePix(P, i, j, lp); a = 0; px = lp; }
      const Lr = Lt[t], Qr = Qt[t]; let sl = 0, sq = 0;
      for (let k = a; k < b; k++) { const p = px[k]; sl += Lr[p]; sq += Qr[p]; }
      const wv = covP[pr]; return wv * (sl + (EP ? EP[pr] : 0)) + wv * wv * sq;
    };
    function bestAnywhere(t) {
      let bd = 0, bj = -1, bp = 0, bs = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const pr = rowStart[i] + (j - i - 1), dlt = lineD(t, i, j, pr);
        if (dlt < bd) { bd = dlt; bj = j; bp = pr; bs = i; }
      }
      return [bd, bj, bp, bs];
    }
    // best line from thread t's current nail: [error change, nail, pair, start nail]
    // A thread not started yet competes with its best line from nail 0, as if tied on there (this
    // keeps the order in which threads come in, which matters as later lines lie on top); when it
    // is picked, its first line is the best line anywhere, and it ties on at that line's start.
    let total = 0;
    function bestFrom(t) {
      const c = cur[t], rc = rowStart[c], Lr = Lt[t], Qr = Qt[t], us = used[t];
      let bd = 0, bj = -1, bp = 0;
      for (let j = 0; j < n; j++) {
        if (j === c || j === prev[t]) continue;
        const pr = c < j ? rc + (j - c - 1) : rowStart[j] + (c - j - 1);
        let a = offs[pr], b = offs[pr + 1], px = pix;
        if (a === b || us[pr]) continue;
        if (lazy) { b = SA.linePix(P, c, j, lp); a = 0; px = lp; }
        let sl = 0, sq = 0;
        for (let k = a; k < b; k++) { const p = px[k]; sl += Lr[p]; sq += Qr[p]; }
        const wv = covP[pr], dlt = wv * (sl + (EP ? EP[pr] : 0)) + wv * wv * sq;
        if (dlt < bd) { bd = dlt; bj = j; bp = pr; }
      }
      return [bd, bj, bp, c];
    }
    function place(t, j, pr, s) {
      if (!started[t]) { started[t] = 1; cur[t] = s; orders[t][0] = s; }
      let a = offs[pr], b = offs[pr + 1], px = pix; const wv = covP[pr], tc = tau[t];
      if (lazy) { b = SA.linePix(P, cur[t], j, lp); a = 0; px = lp; }
      for (let k = a; k < b; k++) {
        const i = px[k], g = cell[i], e1 = e[1][i], e2 = e[2][i];
        for (let c = 0; c < 3; c++) C[c][i] += wv * (tc[c] - C[c][i]);
        setErr(i);
        if (lamH && inside[i]) { hueDrop(i); hueSet(i); }
        if (inside[i]) { Ec[1][g] += (e[1][i] - e1) * f2; Ec[2][g] += (e[2][i] - e2) * f2; }
      }
      for (let k = a; k < b; k++) { const i = px[k]; if (inside[i]) { setD(i); upd(i); } }
      if (reuseW) {
        // each patch the line passes through: one more line; its pixels cost more for the next lines
        rstamp++;
        for (let k = a; k < b; k++) {
          const i = px[k]; if (!inside[i]) continue;
          const y = (i / w) | 0, x = i - y * w, ci = ((y / rc) | 0) * rw + ((x / rc) | 0);
          if (rseen[ci] === rstamp) continue; rseen[ci] = rstamp; rcnt[ci]++;
          const x0 = ((x / rc) | 0) * rc, y0 = ((y / rc) | 0) * rc;
          for (let yy = y0; yy < Math.min(h, y0 + rc); yy++) for (let xx = x0; xx < Math.min(w, x0 + rc); xx++) {
            const p = yy * w + xx; if (!inside[p]) continue; rpen[p] += reuseW * ltScale * gm[p]; upd(p);
          }
        }
      }
      used[t][pr] = 1; prev[t] = cur[t]; cur[t] = j; orders[t].push(j);
      if (o.onLine) o.onLine(t, prev[t], j);   // sa8: lets the worker stream lines as they are placed
    }
    // o.switchPenalty p: another thread takes over only if its best line is (1 + p) times better.
    // o.layered: each thread is finished before the next starts (no return to a finished thread).
    const pen = o.switchPenalty || 0, layered = !!o.layered, closed = new Uint8Array(K), every = o.checkEvery || 8;
    let ct = -1, blockStart = 0, blockLen = 0, switches = 0;
    const closeBlock = () => { if (ct >= 0 && orders[ct].length - 1 > blockStart) blocks.push([ct, blockStart, orders[ct].length - 1]); };
    while (total < maxLines) {
      if (total && total % refresh === 0) { refreshF(); for (let i = 0; i < N; i++) upd(i, true); }
      let pick = null;
      if (ct >= 0) { const r = bestFrom(ct); if (r[1] >= 0) pick = [ct, r]; else if (layered) closed[ct] = 1; }
      // after minBlock lines of a turn, the other threads are tried every checkEvery lines
      if (ct < 0 || !pick || (!layered && blockLen >= minBlock && (blockLen - minBlock) % every === 0)) {
        const own = pick ? pick[1][0] * (1 + pen) : 0;
        for (let t = 0; t < K; t++) {
          if (t === ct || closed[t]) continue;
          const r = bestFrom(t);
          if (r[1] >= 0 && r[0] < own && (!pick || pick[0] === ct || r[0] < pick[1][0])) pick = [t, r];
        }
      }
      if (pick && !started[pick[0]]) { const r = bestAnywhere(pick[0]); if (r[1] >= 0) pick = [pick[0], r]; }
      if (!pick) break;   // no line lowers the error
      const [t, [, j, pr, s0]] = pick;
      if (t !== ct) { closeBlock(); if (ct >= 0) switches++; ct = t; blockStart = orders[t].length - 1; blockLen = 0; }
      place(t, j, pr, s0); total++; blockLen++;
      if (o.stop && o.stop(total, { orders, blocks: blocks.concat([[ct, blockStart, orders[ct].length - 1]]) })) break;
    }
    closeBlock();
    return { orders: orders.map((x) => Uint16Array.from(x)), counts: orders.map((x) => x.length - 1), blocks, total, switches };
  };

  // ---------- subject focus (background removal as a soft importance mask) ----------
  /* mask: subject mask at w x h (Uint8Array 0-255 or Float32Array 0-1, from the segmentation model).
     Returns per-pixel weights for SA.solveJoint's o.wmap: 1 on the subject, o.bgW (default SA.FOCUS_BG)
     on the background, with an edge feathered over o.feather (share of the longer side). */
  SA.FOCUS_BG = 0.3; SA.FOCUS_FEATHER = 0.02;
  SA.subjectMask = function (mask, w, h, o) {
    o = o || {}; const N = w * h, sc = mask instanceof Uint8Array || mask instanceof Uint8ClampedArray ? 1 / 255 : 1, m = new Float32Array(N);
    // a soft threshold first (the model's grey halo counts as background), then the feather
    for (let i = 0; i < N; i++) { const v = Math.min(1, Math.max(0, (mask[i] * sc - 0.15) / 0.7)); m[i] = v * v * (3 - 2 * v); }
    const fs = (o.feather == null ? SA.FOCUS_FEATHER : o.feather) * Math.max(w, h);
    return fs > 0.5 ? SA.boxBlur(m, w, h, fs) : m;
  };
  SA.importance = function (mask, w, h, o) {
    o = o || {}; const bg = o.bgW == null ? SA.FOCUS_BG : o.bgW, m = SA.subjectMask(mask, w, h, o), out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = bg + (1 - bg) * Math.min(1, Math.max(0, m[i]));
    return out;
  };

  // ---------- render ----------
  /* Thread lines drawn in winding order over the board, each line spread over the two nearest
     pixel rows or columns. Returns sRGB channels (0-255). counts[t] = lines of thread t to draw.
     With frameMM, lines are drawn at the real thread width: opaque, SA.THREAD_MM wide on a frame
     frameMM across (the longer side). Without it, the old screen preview is drawn instead: width
     0.857 px on a 1200 px canvas, opacity min(0.9, 2.2 x strength). */
  SA.THREAD_MM = 0.45;   // DMC six-strand embroidery floss used whole, pulled tight
  SA.HI_W = 3;        // sa8: lightness error counts up to 1 + HI_W times in the photo's highlights, one thread on a light board (fewer dark streaks over light areas)
  SA.REUSE_W = 0.002; // sa9: reuse penalty per patch (o.reuseW), one thread on a light board (fewer stacked lines through one high-gradient patch: the einstein 'Z' slash)
  SA.DETAIL_CAP = 6;  // sa8: the detail term's band error is clipped at +-6 L*, one thread on a light board (fewer stacked dark lines on one strong edge band)
  SA.HUE_W = 10;  // weight of the key-hue term in SA.solveJoint with several threads (sa8)
  SA.DETAIL_W = 12;   // weight of the detail term in SA.solveJoint (sa7, see sa-bench/algos/REPORT.md)
  /* blocks (optional): [[thread, from, to], ...] draws lines from..to-1 of each thread in this
     order (threads wound in turns); without it, each thread is drawn whole, in thread order. */
  SA.render = function (W, H, lay, orders, counts, colors, board, strength, frameMM, blocks, rows, snaps) {
    // rows (optional): [y0, y1], only these rows are made (to draw a large image in strips)
    // snaps (optional, sa8): { at: [line counts, ascending], fn(index, [R, G, B]) }: the image after the first
    //   at[i] lines, the same as rendering only those lines (one pass instead of one render per count)
    const ya = rows ? rows[0] : 0, yb = rows ? rows[1] : H, HH = yb - ya;
    const N = W * HH, R = new Float32Array(N), Gc = new Float32Array(N), B = new Float32Array(N);
    const b = hex2rgb(board);
    const { X, Y } = SA.nailPx(lay, W, H);
    const c0 = frameMM ? SA.THREAD_MM * Math.max(W, H) / frameMM : Math.min(0.9, strength * 2.2) * (1200 / 1400) * Math.max(W, H) / 1200;
    // mixing is done in linear light for the real thread, in sRGB for the screen preview (as a canvas does)
    const toL = frameMM ? lin : (v) => v;
    R.fill(toL(b[0])); Gc.fill(toL(b[1])); B.fill(toL(b[2]));
    const put = (i, w, cr, cg, cb) => { if (w > 1) w = 1; R[i] += (cr - R[i]) * w; Gc[i] += (cg - Gc[i]) * w; B[i] += (cb - B[i]) * w; };
    // a line c pixels thick across the minor axis at position p: coverage of each pixel
    // (up to 1 px thick: shared by the two nearest pixels; thicker: overlap of the thread with each pixel)
    const across = (p, c, lim, fn) => {
      if (c <= 1) { const pi = Math.floor(p), f = p - pi; if (pi >= 0 && pi < lim) fn(pi, c * (1 - f)); if (pi + 1 < lim && f > 0) fn(pi + 1, c * f); return; }
      const lo = p - c / 2 + 0.5, hi = p + c / 2 + 0.5;
      for (let r = Math.max(0, Math.floor(lo)); r < lim && r < hi; r++) { const ov = Math.min(r + 1, hi) - Math.max(r, lo); if (ov > 0) fn(r, ov); }
    };
    const cols = colors.map((c) => hex2rgb(c).map(toL));
    const runs = blocks ? SA.blocksUpTo(blocks, counts) : orders.map((o, t) => [t, 0, counts[t]]);
    const conv = (r, g, bb) => { if (frameMM) for (let i = 0; i < N; i++) { r[i] = srgbT(r[i]); g[i] = srgbT(g[i]); bb[i] = srgbT(bb[i]); } return [r, g, bb]; };
    let drawn = 0, si = 0;
    const snap = () => { while (snaps && si < snaps.at.length && snaps.at[si] === drawn) { snaps.fn(si, conv(R.slice(), Gc.slice(), B.slice())); si++; } };
    // sa8: the same coverage as before (across / put), written out without closures (about 2x faster)
    for (const [t, from, to] of runs) {
      const [cr, cg, cb] = cols[t], o = orders[t];
      for (let k = from; k < to; k++) {
        if (snaps) { snap(); drawn++; }
        let x0 = X[o[k]], y0 = Y[o[k]], x1 = X[o[k + 1]], y1 = Y[o[k + 1]];
        const dx = x1 - x0, dy = y1 - y0, hor = Math.abs(dx) >= Math.abs(dy);
        let sl, c, a0, a1, lim;
        if (hor) {
          if (x1 < x0) { let q = x0; x0 = x1; x1 = q; q = y0; y0 = y1; y1 = q; }
          sl = dx === 0 ? 0 : (y1 - y0) / (x1 - x0); c = c0 * Math.sqrt(1 + sl * sl);
          if (Math.max(y0, y1) + c + 1 < ya || Math.min(y0, y1) - c - 1 > yb) continue;
          a0 = Math.ceil(x0); a1 = x1; lim = HH;
        } else {
          if (y1 < y0) { let q = x0; x0 = x1; x1 = q; q = y0; y0 = y1; y1 = q; }
          sl = (x1 - x0) / (y1 - y0); c = c0 * Math.sqrt(1 + sl * sl);
          a0 = Math.max(Math.ceil(y0), ya); a1 = Math.min(y1, yb - 1); lim = W;
        }
        for (let u = a0; u <= a1; u++) {
          // p: position across the line's minor axis; idx(r) = pixel index of cross position r
          let p, base, step;
          if (hor) { p = y0 + sl * (u - x0) - ya; base = u; step = W; } else { p = x0 + sl * (u - y0); base = (u - ya) * W; step = 1; }
          if (c <= 1) {
            const pi = Math.floor(p), f = p - pi;
            if (pi >= 0 && pi < lim) { let w = c * (1 - f); if (w > 1) w = 1; const i = base + pi * step; R[i] += (cr - R[i]) * w; Gc[i] += (cg - Gc[i]) * w; B[i] += (cb - B[i]) * w; }
            if (pi + 1 < lim && f > 0 && pi + 1 >= 0) { let w = c * f; if (w > 1) w = 1; const i = base + (pi + 1) * step; R[i] += (cr - R[i]) * w; Gc[i] += (cg - Gc[i]) * w; B[i] += (cb - B[i]) * w; }
          } else {
            const lo = p - c / 2 + 0.5, hi = p + c / 2 + 0.5;
            for (let r = Math.max(0, Math.floor(lo)); r < lim && r < hi; r++) {
              let w = Math.min(r + 1, hi) - Math.max(r, lo);
              if (w > 0) { if (w > 1) w = 1; const i = base + r * step; R[i] += (cr - R[i]) * w; Gc[i] += (cg - Gc[i]) * w; B[i] += (cb - B[i]) * w; }
            }
          }
        }
      }
    }
    if (snaps) snap();
    return conv(R, Gc, B);
  };
  // blocks cut to at most counts[t] lines of each thread
  SA.blocksUpTo = function (blocks, counts) {
    const out = [];
    for (const [t, a, b] of blocks) { const e = Math.min(b, counts[t]); if (e > a) out.push([t, a, e]); }
    return out;
  };
  // the first L lines of a wound sequence: lines per thread and the blocks
  SA.firstLines = function (blocks, K, L) {
    const counts = new Array(K).fill(0), out = []; let left = L;
    for (const [t, a, b] of blocks) { if (left <= 0) break; const e = Math.min(b, a + left); out.push([t, a, e]); counts[t] = e; left -= e - a; }
    return { counts, blocks: out };
  };
  const srgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  // sa8: table version for SA.render (linear interpolation over 8192 steps, within 0.01 of srgb)
  const SRGB_T = new Float32Array(8194); for (let i = 0; i <= 8193; i++) SRGB_T[i] = srgb(Math.min(1, i / 8192));
  const srgbT = (v) => { v *= 8192; if (v <= 0) return 0; if (v >= 8192) return SRGB_T[8192]; const i = v | 0; return SRGB_T[i] + (SRGB_T[i + 1] - SRGB_T[i]) * (v - i); };

  // ---------- match score ----------
  // Gaussian blur of src weighted by mask m (normalized convolution); mb = blurred mask
  function gaussN(src, m, w, h, sigma, mb) {
    if (sigma > 3) return boxN(src, m, w, h, sigma, mb);
    const r = Math.max(1, Math.ceil(sigma * 3)), ker = new Float32Array(2 * r + 1);
    let ks = 0; for (let i = -r; i <= r; i++) { ker[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); ks += ker[i + r]; }
    for (let i = 0; i < ker.length; i++) ker[i] /= ks;
    const N = w * h, inp = new Float32Array(N), tmp = new Float32Array(N), out = new Float32Array(N);
    for (let i = 0; i < N; i++) inp[i] = m ? src[i] * m[i] : src[i];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        const k0 = x - r < 0 ? r - x : 0, k1 = x + r >= w ? r + (w - 1 - x) : 2 * r;
        for (let k = k0, i = row + x - r + k0; k <= k1; k++, i++) s += ker[k] * inp[i];
        tmp[row + x] = s;
      }
    }
    // sa9: the vertical pass runs along rows (the same sums in the same order, cache-friendly)
    const acc = new Float64Array(w);
    for (let y = 0; y < h; y++) {
      const k0 = y - r < 0 ? r - y : 0, k1 = y + r >= h ? r + (h - 1 - y) : 2 * r;
      acc.fill(0);
      for (let k = k0, o = (y - r + k0) * w; k <= k1; k++, o += w) { const kk = ker[k]; for (let x = 0; x < w; x++) acc[x] += kk * tmp[o + x]; }
      const ro = y * w; for (let x = 0; x < w; x++) out[ro + x] = acc[x];
    }
    if (mb) for (let i = 0; i < N; i++) out[i] = mb[i] > 1e-4 ? out[i] / mb[i] : 0;
    return out;
  }
  // Wide blurs: three box blurs in each direction (same variance as the Gaussian), zero outside the image.
  function boxN(src, m, w, h, sigma, mb) {
    const r = Math.max(1, Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2)), k = 1 / (2 * r + 1);
    const N = w * h; let a = new Float32Array(N), b = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = m ? src[i] * m[i] : src[i];
    for (let pass = 0; pass < 6; pass++) {
      const horiz = pass % 2 === 0, len = horiz ? w : h, lines = horiz ? h : w, st = horiz ? 1 : w, ls = horiz ? w : 1;
      for (let l = 0; l < lines; l++) {
        const o = l * ls; let s = 0;
        for (let x = 0; x <= r && x < len; x++) s += a[o + x * st];
        for (let x = 0; x < len; x++) {
          b[o + x * st] = s * k;
          const p = x + r + 1, q = x - r;
          if (p < len) s += a[o + p * st];
          if (q >= 0) s -= a[o + q * st];
        }
      }
      const t = a; a = b; b = t;
    }
    if (mb) for (let i = 0; i < N; i++) a[i] = mb[i] > 1e-4 ? a[i] / mb[i] : 0;
    return a;
  }
  SA.blur = gaussN;
  /* Gaussian blur by three box blurs per direction whose widths match the variance exactly (two widths,
     Kovesi 2010), zero outside the image. O(N) whatever sigma. */
  SA.boxBlur = function (src, w, h, sigma) {
    const n = 3, wI = Math.floor(Math.sqrt(12 * sigma * sigma / n + 1)), wl = wI % 2 ? wI : wI - 1, wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    for (let it = 0; it < n; it++) {
      const r = ((it < m ? wl : wu) - 1) / 2; if (r < 1) continue; const k = 1 / (2 * r + 1);
      for (let pass = 0; pass < 2; pass++) {
        const horiz = pass === 0, len = horiz ? w : h, lines = horiz ? h : w, st = horiz ? 1 : w, ls = horiz ? w : 1;
        for (let l = 0; l < lines; l++) {
          const o = l * ls; let s = 0;
          for (let x = 0; x <= r && x < len; x++) s += a[o + x * st];
          for (let x = 0; x < len; x++) { b[o + x * st] = s * k; const p = x + r + 1, q = x - r; if (p < len) s += a[o + p * st]; if (q >= 0) s -= a[o + q * st]; }
        }
        const t = a; a = b; b = t;
      }
    }
    return a;
  };
  const CW = 1;   // weight of color (a, b) differences when fitting palettes
  SA.HUE_FIT = 0; // default weight of the hue-mix distance when fitting palettes (the search also fits with AUTO.HUE_FIT)
  /* Match score: how the finished piece looks from a normal viewing distance compared with the
     photo. The piece is drawn at the real thread width (SA.render with frameMM) and both images
     are seen as the eye sees them from the viewing distance (S-CIELAB filters, Zhang & Wandell
     1996, on an opponent space that keeps greys grey; distance 5 x the frame size, at least 1 m).
     Inside the frame, leaving out the nail ring:
       de      mean CIELAB difference (CIE76): overall tone and color
       dab     mean difference of color (a*, b*) only
       detail  correlation of lightness detail (difference of blurs at 1.5% and 4.5% of the
               width). Unaffected by overall lightness and contrast, so it measures whether
               features such as eyes and edges are drawn.
       ssim, ssimC  structural similarity of L* and of a*, b* (computed only if weighted)
       hue     how far the result's mix of hues is from the photo's: chroma-weighted hue
               histograms (12 bins), half their L1 distance after normalising, times the photo's
               mean chroma. A result with almost no color counts as an even spread of hues.
               This keeps the photo's key hues (blue sky, red balloon) in the chosen palette.
     score = 0.5 de + 1 dab + 120 (1 - detail) + 3 hue; lower is better. The same weights as the
     bench's physical score, tuned on a set of results with a known quality order
     (sa-bench/ranking, including pairs where a palette drops a key hue). */
  SA.scoreWeights = { de: 0.5, ab: 1, d: 120, hue: 3, l: 0, c: 0 };
  const NB = 12;
  function hueHist(A, Bb, T) {   // chroma per pixel, by hue, soft-binned
    const H = new Float64Array(NB), ins = T.ins;
    for (let i = 0; i < A.length; i++) if (ins[i]) {
      const a = A[i], b = Bb[i], C = Math.sqrt(a * a + b * b); if (C < 1e-6) continue;
      let h = Math.atan2(b, a) / (2 * Math.PI) * NB; h = ((h % NB) + NB) % NB;
      const i0 = Math.floor(h), f = h - i0;
      H[i0 % NB] += C * (1 - f); H[(i0 + 1) % NB] += C * f;
    }
    for (let k = 0; k < NB; k++) H[k] /= T.cnt;
    return H;
  }
  function hueDist(hp, hr) {
    let sp = 0, sr = 0; for (let k = 0; k < NB; k++) { sp += hp[k]; sr += hr[k]; }
    if (sp <= 0) return 0;
    let d = 0; for (let k = 0; k < NB; k++) d += Math.abs(hp[k] / sp - (hr[k] + 1 / NB) / (sr + 1));
    return 0.5 * d * sp;
  }
  const XN = 0.95047, ZN = 1.08883;
  // [FWHM in degrees, weight] for the lightness, red-green and blue-yellow channels
  const SCIELAB = [[[0.05, 1.00327], [0.225, 0.114416], [7.0, -0.117686]], [[0.0685, 0.616725], [0.826, 0.383275]], [[0.092, 0.567885], [0.6451, 0.432115]]];
  const mbFor = (T, s) => { let v = T.mbs.get(s); if (!v) { v = gaussN(T.m, null, T.w, T.h, s); T.mbs.set(s, v); } return v; };
  const blurT = (x, T, s) => gaussN(x, T.m, T.w, T.h, s, mbFor(T, s));
  function seen(lc, T) {   // linear RGB channels -> CIELAB as seen from the viewing distance
    const N = T.w * T.h, opp = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    for (let i = 0; i < N; i++) {
      const r = lc[0][i], g = lc[1][i], b = lc[2][i];
      const X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
      opp[0][i] = Y; opp[1][i] = X / XN - Y; opp[2][i] = Y - Z / ZN;
    }
    const f = opp.map((ch, c) => {
      const out = new Float32Array(N), tot = SCIELAB[c].reduce((s, k) => s + k[1], 0);
      for (const [spread, wt] of SCIELAB[c]) {
        const s = Math.max(0.3, spread * T.ppd / 2.3548);
        const bl = blurT(ch, T, Math.round(s * 100) / 100);
        for (let i = 0; i < N; i++) out[i] += (wt / tot) * bl[i];
      }
      return out;
    });
    const L = new Float32Array(N), A = new Float32Array(N), Bb = new Float32Array(N), ins = T.ins;
    for (let i = 0; i < N; i++) if (ins[i]) {
      const Y = f[0][i], X = XN * (f[1][i] + Y), Z = ZN * (Y - f[2][i]);
      const fx = ft(X > 0 ? X / XN : 0), fy = ft(Y > 0 ? Y : 0), fz = ft(Z > 0 ? Z / ZN : 0);
      L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); Bb[i] = 200 * (fy - fz);
    }
    return [L, A, Bb];
  }
  const linCh = (ch) => ch.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = lin(c[i]); return o; });
  function stats(x, T) {
    const mu = blurT(x, T, T.sw), xx = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) xx[i] = x[i] * x[i];
    const v = blurT(xx, T, T.sw);
    for (let i = 0; i < x.length; i++) v[i] -= mu[i] * mu[i];
    return { x, mu, v };
  }
  function ssim(X, y, T) {
    const Y = stats(y, T), N = X.x.length, xy = new Float32Array(N);
    for (let i = 0; i < N; i++) xy[i] = X.x[i] * y[i];
    const cxy = blurT(xy, T, T.sw);
    let s = 0;
    for (let i = 0; i < N; i++) if (T.ins[i]) {
      const mx = X.mu[i], my = Y.mu[i], cv = cxy[i] - mx * my;
      s += ((2 * mx * my + 1) * (2 * cv + 9)) / ((mx * mx + my * my + 1) * (X.v[i] + Y.v[i] + 9));
    }
    return s / T.cnt;
  }
  function band(L, T) { const p = blurT(L, T, T.b1), q = blurT(L, T, T.b2); for (let i = 0; i < p.length; i++) p[i] -= q[i]; return p; }
  function ncc(a, b, T) {
    let sa = 0, sb = 0; const ins = T.ins;
    for (let i = 0; i < a.length; i++) if (ins[i]) { sa += a[i]; sb += b[i]; }
    sa /= T.cnt; sb /= T.cnt;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) if (ins[i]) { const x = a[i] - sa, y = b[i] - sb; ab += x * y; aa += x * x; bb += y * y; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }
  SA.viewMM = (frameMM) => Math.max(1000, 5 * frameMM);
  /* Target for the score: the photo (RGBA, w x h) as it is, without contrast stretching.
     view: {frameMM: longer frame side in mm (default 400), viewMM: viewing distance}. */
  SA.target = function (d, w, h, inside, shape, view) {
    view = view || {};
    const N = w * h, W = Math.max(w, h), frameMM = view.frameMM || 400, viewMM = view.viewMM || SA.viewMM(frameMM);
    // frame area without the nail ring: 97% of the size for round frames, 1.5% border otherwise
    const ins = new Uint8Array(N), round = shape ? (shape === 'circle' || shape === 'ellipse') : inside[0] === 0;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      if (round) { const a = (x - cx) / (w * 0.485), b = (y - cy) / (h * 0.485); ins[i] = a * a + b * b <= 1 ? 1 : 0; }
      else ins[i] = x >= W * 0.015 && x < w - W * 0.015 && y >= W * 0.015 && y < h - W * 0.015 ? 1 : 0;
    }
    const m = new Float32Array(N); let cnt = 0; for (let i = 0; i < N; i++) { m[i] = ins[i]; cnt += ins[i]; }
    const T = { w, h, ins, m, cnt, frameMM, viewMM, mbs: new Map(), sw: 1.5 * W / 512, b1: 0.015 * W, b2: 0.045 * W };
    T.ppd = W / frameMM * viewMM * Math.tan(Math.PI / 180);   // pixels per degree of visual angle
    const ch = [0, 1, 2].map((c) => Float32Array.from({ length: N }, (_, i) => d[i * 4 + c]));
    T.lab = seen(linCh(ch), T);
    T.band = band(T.lab[0], T);
    const W_ = SA.scoreWeights;
    if (W_.l || SA.SCORE_ALL) T.stL = stats(T.lab[0], T);
    if (W_.c || SA.SCORE_ALL) T.stC = [stats(T.lab[1], T), stats(T.lab[2], T)];
    // colorfulness: mean chroma C* of the photo inside the frame
    let c = 0; for (let i = 0; i < N; i++) if (ins[i]) c += Math.hypot(T.lab[1][i], T.lab[2][i]);
    T.chroma = c / cnt;
    T.hue = hueHist(T.lab[1], T.lab[2], T);
    return T;
  };
  /* ch: sRGB channels of SA.render(..., frameMM) at the target size. */
  SA.score = function (ch, T) {
    const R = seen(linCh(ch), T), P = T.lab, N = T.w * T.h, ins = T.ins;
    let de = 0, dab = 0;
    for (let i = 0; i < N; i++) if (ins[i]) {
      const a = R[0][i] - P[0][i], b = R[1][i] - P[1][i], c = R[2][i] - P[2][i], ab = b * b + c * c;
      de += Math.sqrt(a * a + ab); dab += Math.sqrt(ab);
    }
    de /= T.cnt; dab /= T.cnt;
    const detail = ncc(T.band, band(R[0], T), T), W_ = SA.scoreWeights;
    const ssimL = W_.l || SA.SCORE_ALL ? ssim(T.stL, R[0], T) : null;
    const ssimC = W_.c || SA.SCORE_ALL ? (ssim(T.stC[0], R[1], T) + ssim(T.stC[1], R[2], T)) / 2 : null;
    const hue = hueDist(T.hue, hueHist(R[1], R[2], T));
    const score = W_.de * de + W_.ab * dab + W_.d * (1 - detail) + W_.hue * hue + (W_.l ? W_.l * (1 - ssimL) : 0) + (W_.c ? W_.c * (1 - ssimC) : 0);
    return { score, de, dab, detail, hue, ssim: ssimL, ssimC };
  };
  /* Score of a finished result, as Find best settings scores it.
     o: {photo(w, h) -> RGBA, shape, A, lay, orders, counts, threads (hex), board (hex), strength, frameMM} */
  SA.scoreResult = function (o) {
    const [w, h] = SA.workSize(o.A, SA.auto.EVAL), ins = SA.insideMask(o.shape, w, h);
    const T = SA.target(o.photo(w, h), w, h, ins, o.shape, { frameMM: o.frameMM });
    return SA.score(SA.render(w, h, o.lay, o.orders, o.counts, o.threads, o.board, o.strength, o.frameMM || 400, o.blocks), T);
  };

  // ---------- palette candidates ----------
  /* Thread colors for a photo. The photo's colors (contrast-stretched, grouped into bins) are
     matched by mixes of the board color and up to 3 DMC floss colors, mixed in linear light as
     thread and board mix when seen from a distance. Only floss near one of the photo's main
     colors is considered, plus white and black. For each board and thread count, threads are
     added one at a time, each time the floss that lowers the mean CIELAB difference most, then
     each thread is swapped for a better one if there is one.
     dmc: [[code, name, hex], ...]; boards: {key: hex}. Returns [{board, threads:[codes], err}]. */
  SA.fitPalettes = function (d, inside, dmc, boards, maxK, cw, hueW) {
    const CWf = cw || CW;
    const [lo, hi] = SA.levels(d, inside), bins = new Map();
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      const c = [0, 1, 2].map((k) => { const v = (d[i * 4 + k] - lo) / (hi - lo); return v < 0 ? 0 : v > 1 ? 1 : v; });
      const key = ((c[0] * 7.99 | 0) * 8 + (c[1] * 7.99 | 0)) * 8 + (c[2] * 7.99 | 0);
      let e = bins.get(key); if (!e) bins.set(key, e = [0, 0, 0, 0]);
      e[0] += c[0]; e[1] += c[1]; e[2] += c[2]; e[3]++;
    }
    let pts = [...bins.values()].map((e) => ({ c: [e[0] / e[3], e[1] / e[3], e[2] / e[3]], w: e[3] }));
    pts.sort((p, q) => q.w - p.w); pts = pts.slice(0, 56);
    const wsum = pts.reduce((s, p) => s + p.w, 0);
    pts.forEach((p) => { p.lab = [0, 0, 0]; labInto(p.c[0] * 255, p.c[1] * 255, p.c[2] * 255, p.lab, 0); p.l = p.c.map((v) => lin(v * 255)); });
    const all = dmc.map((x) => { const rgb = hex2rgb(x[2]), lab = [0, 0, 0]; labInto(rgb[0], rgb[1], rgb[2], lab, 0); return { code: x[0], l: rgb.map(lin), lab }; });
    // floss near the main photo colors (the 6 nearest to each of the 20 largest bins), white and black
    const near = new Set();
    for (const p of pts.slice(0, 20)) {
      all.map((c) => [c, (c.lab[0] - p.lab[0]) ** 2 + (c.lab[1] - p.lab[1]) ** 2 + (c.lab[2] - p.lab[2]) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, 6).forEach((x) => near.add(x[0]));
    }
    all.filter((c) => c.code === 'B5200' || c.code === '310').forEach((c) => near.add(c));
    const cand = [...near];
    const a = new Float64Array(3), r = [0, 0, 0], q = [0, 0, 0];
    // hue mix of the photo colors (chroma-weighted, 12 bins), to keep the photo's key hues: the
    // fit error adds HUE_FIT x the distance of the mixes' hue mix from it (as in SA.score)
    const binInto = (H, A, Bv, wgt) => {
      const C = Math.sqrt(A * A + Bv * Bv); if (C < 1e-6) return;
      let h = Math.atan2(Bv, A) / (2 * Math.PI) * NB; h = ((h % NB) + NB) % NB;
      const i0 = Math.floor(h), f = h - i0; H[i0 % NB] += wgt * C * (1 - f); H[(i0 + 1) % NB] += wgt * C * f;
    };
    const Hp = new Float64Array(NB); for (const p of pts) binInto(Hp, p.lab[1], p.lab[2], p.w);
    const Hm = new Float64Array(NB), hw0 = hueW == null ? SA.HUE_FIT : hueW;
    function err(B, set, hwx) {
      const hw = hwx == null ? hw0 : hwx;
      Hm.fill(0);
      const D = set.map((s) => [s.l[0] - B[0], s.l[1] - B[1], s.l[2] - B[2]]);
      let tr = 0; for (const x of D) tr += x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
      const eta = 1 / Math.max(tr, 1e-6), aa = a.subarray(0, D.length);
      let e = 0;
      for (const p of pts) {
        mix(p.l, B, D, aa, 24, eta, r);
        let X = 0, Y = 0, Z = 0;
        const m = [0, 1, 2].map((c) => { let v = B[c]; for (let k = 0; k < D.length; k++) v += aa[k] * D[k][c]; return v; });
        X = ft((0.4124 * m[0] + 0.3576 * m[1] + 0.1805 * m[2]) / 0.95047); Y = ft(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]); Z = ft((0.0193 * m[0] + 0.1192 * m[1] + 0.9505 * m[2]) / 1.08883);
        q[0] = 116 * Y - 16; q[1] = 500 * (X - Y); q[2] = 200 * (Y - Z);
        const x = q[0] - p.lab[0], y = q[1] - p.lab[1], z = q[2] - p.lab[2];
        e += p.w * Math.sqrt(x * x + CWf * CWf * (y * y + z * z));
        if (hw) binInto(Hm, q[1], q[2], p.w);
      }
      if (!hw) return e / wsum;
      let sp = 0, sm = 0, d = 0; for (let k = 0; k < NB; k++) { sp += Hp[k]; sm += Hm[k]; }
      if (sp > 0) for (let k = 0; k < NB; k++) d += Math.abs(Hp[k] / sp - (Hm[k] + wsum / NB) / (sm + wsum));
      return e / wsum + hw * 0.5 * d * sp / wsum;
    }
    const out = [];
    for (const bk of Object.keys(boards)) {
      const B = hex2rgb(boards[bk]).map(lin), Bs = hex2rgb(boards[bk]).map((v) => v / 255);
      // skip floss too close to the board color: it would not show
      const pool = cand.filter((c) => { const s = c.l.map((v) => srgb(v) / 255); return Math.abs(s[0] - Bs[0]) + Math.abs(s[1] - Bs[1]) + Math.abs(s[2] - Bs[2]) > 0.25; });
      let set = [];
      for (let K = 1; K <= maxK && K <= pool.length; K++) {
        let bestC = null, be = Infinity;
        for (const c of pool) { if (set.includes(c)) continue; const e = err(B, set.concat([c])); if (e < be) { be = e; bestC = c; } }
        set = set.concat([bestC]);
        if (K > 1) {  // one swap pass
          for (let s = 0; s < set.length; s++) for (const c of pool) {
            if (set.includes(c)) continue;
            const t = set.slice(); t[s] = c; const e = err(B, t);
            if (e < be - 1e-6) { be = e; set = t; }
          }
        }
        // errH: the error with hue weight 1, the same for every fit, to order the candidates
        out.push({ board: bk, threads: set.map((c) => c.code), err: be, hue: hw0, errH: err(B, set, 1) });
      }
      // Key-hue palettes (white board, with the hue fit): a dark, a mid and a light thread built
      // from the photo's own tones and its main hue, as a painter would choose them, and a second
      // one with the second main hue instead of the light thread.
      if (bk === 'white' && hw0 > 0 && maxK >= 3) keyHue(pool).forEach((set) => { if (new Set(set).size === 3) out.push({ board: bk, threads: set.map((c) => c.code), err: err(B, set), hue: 'key', errH: err(B, set, 1) }); });
    }
    return out;
    function keyHue(pool) {
      const mean = (sel) => { let w = 0; const m = [0, 0, 0]; for (const p of sel) { w += p.w; for (let k = 0; k < 3; k++) m[k] += p.w * p.lab[k]; } return w ? m.map((v) => v / w) : null; };
      // nearest floss, with a and b counted twice so that the hue is kept
      const nearest = (lab) => { let b = null, bd = Infinity; for (const c of all) { const d = (c.lab[0] - lab[0]) ** 2 + 4 * ((c.lab[1] - lab[1]) ** 2 + (c.lab[2] - lab[2]) ** 2); if (d < bd) { bd = d; b = c; } } return b; };
      const H = Hp.slice(), hues = [];
      for (let r = 0; r < 2; r++) { let k = 0; for (let i = 1; i < NB; i++) if (H[i] > H[k]) k = i; if (H[k] <= 0) break; hues.push(k); H[k] = H[(k + 1) % NB] = H[(k + NB - 1) % NB] = 0; }
      const binOf = (p) => { let h = Math.atan2(p.lab[2], p.lab[1]) / (2 * Math.PI) * NB; return Math.round(((h % NB) + NB) % NB) % NB; };
      const ofHue = (k) => mean(pts.filter((p) => Math.hypot(p.lab[1], p.lab[2]) > 12 && Math.abs(((binOf(p) - k + NB + NB / 2) % NB) - NB / 2) <= 1));
      const dark = mean(pts.filter((p) => p.lab[0] < 35)), light = mean(pts.filter((p) => p.lab[0] > 75));
      const h1 = hues.length ? ofHue(hues[0]) : null, h2 = hues.length > 1 ? ofHue(hues[1]) : null;
      const out = [];
      if (dark && h1 && light) out.push([nearest(dark), nearest(h1), nearest(light)]);
      if (dark && h1 && h2) out.push([nearest(dark), nearest(h1), nearest(h2)]);
      return out;
    }
  };


  // ---------- automatic settings ----------
  /* Search for the settings whose finished piece best matches the photo (see the match score).
     The page runs the tests in several workers; the plan and the choice are made here, so they
     can be tested alone. */
  const AUTO = SA.auto = {
    MIN_SPACING_MM: 3.5,   // nails closer than this are hard to place and to wind
    LINES: [200, 6000],    // line count range, as on the Lines slider
    STRENGTH: [3, 60],     // thread strength range, as on the slider
    TOL: 0.01,             // a simpler setup is chosen if it scores within 1% of the best
    HUE_TOL: 0,            // among setups within this share of the best, those that keep the hues best win (off: it chose worse)
    HUE_FIT: 1,            // hue weight of the second palette fit for white and black boards
    BOARD_MARGIN: 0.08,    // a grey or wood board must score 8% better than white or black, with no less detail
    FIRST: 80,             // working size (pixels along the longer side) of the first pass
    COARSE: 120,           // working size of the later passes
    EVAL: 120,             // size of the images compared with the photo
    MIN_SHARE: 0.03,       // threads with a smaller share of the lines are dropped
    GUARD: false,          // sa7: a palette that drops a thread is also tried without the detail term; sa8: off (the key-hue term keeps the threads; Make string art keeps its own guard)
    DETAIL_EVERY: 4,       // the search refreshes the detail field every 4th time only (Make string art: every time)
    GREY_CHROMA: 8,        // photos with less mean chroma (C*) are made with black or white thread only
    FULL: 500,             // working size of Make string art
    GUARD_HUE: 6,          // Make string art: the guard's second winding runs only if the result's hue distance (SA.score hue) is over this (sa8; dog without the key-hue term 8.5, fruit 3-thread 4.8)
    OVERRUN: 0.15,         // a running test may go on this share of the time limit past a stage's limit (as sa7)
    BUDGET_MS: 3000,       // after this, the search stops refining and chooses from what it has (sa7: was 4500; only slow devices reach it)
    PRESETS: [{ board: 'white', threads: ['310'] }, { board: 'black', threads: ['B5200'] }],
    // sa8, large frames (sa-bench/sizes/REPORT.md): nails 4 mm apart up to NAIL_CAP (NAIL_CAP_LOW on phones and
    // low-memory devices); small frames keep the old rule (3.5 mm, at most 360)
    BIG_SPACING_MM: 4, NAIL_CAP: 600, NAIL_CAP_LOW: 480,
    TEST_NAILS: 400,       // the search tests at most this many nails (at 120 px it cannot see finer spacing); if its most nails win, the frame's most are used
    LINES_PER_CM: 60,      // Lines slider maximum: 60 per cm of the longer side, at least 6000
    SELF_NEAR: 0.8         // sa9: a choice at 80 % or more of a test that stopped by itself counts as 'near that end'
  };
  /* Where the thread covers the board about once, from the frame size (longer side, mm):
     a 40 cm frame looks best with about 1500 lines at strength 24; the line count grows and the
     strength falls in proportion to the frame size. */
  AUTO.linesFor = (frameMM) => Math.round(1500 * frameMM / 400 / 100) * 100;
  AUTO.strengthFor = (frameMM) => Math.round(Math.min(AUTO.STRENGTH[1], Math.max(AUTO.STRENGTH[0], 24 * 400 / frameMM)));
  // working size of the joint solver: about 2 mm per pixel, where single threads merge into tone
  AUTO.jointRes = (frameMM) => Math.round(Math.min(400, Math.max(120, frameMM / 2)));
  AUTO.workers = (cores) => (!cores || cores <= 4 ? 2 : Math.min(4, cores - 1));
  // Nail counts to try: up to the most nails that keep the minimum spacing, in steps of 6.
  // sa8: the most nails for a frame: the old rule (3.5 mm apart, at most 360) or 4 mm apart up to cap
  // (AUTO.NAIL_CAP, or NAIL_CAP_LOW on phones), whichever is more
  AUTO.nailMax = function (shape, A, heightMm, cap) {
    const P = SA.nailLayout(shape, 8, A).P * heightMm, f6 = (x) => Math.floor(x / 6) * 6;
    return Math.max(150, Math.min(360, f6(P / AUTO.MIN_SPACING_MM)), Math.min(cap || AUTO.NAIL_CAP, f6(P / AUTO.BIG_SPACING_MM)));
  };
  AUTO.linesMax = (frameMM) => Math.max(6000, Math.round(AUTO.LINES_PER_CM * frameMM / 10 / 100) * 100);
  // list: the counts the search tests (at most TEST_NAILS)
  AUTO.nailCounts = function (shape, A, heightMm, cap) {
    const P = SA.nailLayout(shape, 8, A).P * heightMm;
    const max = AUTO.nailMax(shape, A, heightMm, cap), top = Math.min(max, AUTO.TEST_NAILS);
    const set = new Set([0.75, 1].map((f) => Math.min(top, Math.max(150, Math.round(top * f / 6) * 6))));
    return { max, top, list: [...set].sort((a, b) => a - b), spacingAt: (n) => P / n };
  };
  const r100 = (x, hi) => Math.max(AUTO.LINES[0], Math.min(hi || AUTO.LINES[1], Math.round(x / 100) * 100));
  AUTO.checkpoints = (L0, hi) => [...new Set([0.5, 0.67, 0.83, 1, 1.2, 1.45, 1.75, 2.1, 2.5].map((f) => r100(L0 * f, hi)))];

  /* One test: solve the lines for a palette, nail count and strength at working size `res`,
     then score the finished piece at several line counts. Because each thread's lines are chosen
     one after another, the first L lines of a long run are the same as a run of L lines.
     ctx: { shape, A, frameMM, photo: {res: {d, w, h, inside}}, T: score target, cache } */
  /* One test: the joint solver for a palette and nail count at working size `res`, scored as a
     finished piece after several line counts. Because lines are placed one after another, the
     first L lines of a long run are the same as a run of L lines; the test stops once the score
     has risen at two line counts in a row, or when no line lowers the error.
     ctx: { shape, A, frameMM, photo: {res: {d, w, h, inside}}, T: score target, cache } */
  AUTO.evalJob = function (ctx, job) {
    const t0 = Date.now(), ph = ctx.photo[job.res], w = ph.w, h = ph.h, n = job.n;
    const lay = SA.nailLayout(ctx.shape, n, ctx.A), px = SA.nailPx(lay, w, h);
    const key = n + '|' + job.res;
    if (!ctx.cache || ctx.cache.key !== key) {
      ctx.cache = null;   // free the previous pixel lists first
      ctx.cache = { key, P: SA.prepare(n, Int32Array.from(px.X, Math.round), Int32Array.from(px.Y, Math.round), lay.edge, w, SA.skipFor(n)) };
    }
    const T = ctx.T, K = job.threads.length, cps = job.checkpoints;
    const once = (extra) => {
      const results = []; let ci = 0, last = null, worse = 0, late = false;
      const evalAt = (total, orders, blocks) => {
        const fl = SA.firstLines(blocks, K, total), cnt = fl.counts;
        // threads with under 3% of the lines are left out of the result, and do not count
        const keep = cnt.map((c) => c >= AUTO.MIN_SHARE * total), kc = cnt.map((c, i) => (keep[i] ? c : 0));
        const sc = SA.score(SA.render(T.w, T.h, lay, orders, kc, job.threads, job.board, 0, ctx.frameMM, fl.blocks), T);
        const res = { L: total, used: total, score: sc.score, de: sc.de, dab: sc.dab, detail: sc.detail, hue: sc.hue, keep, k: keep.filter(Boolean).length, cnt };
        if (extra.detailW != null) res.detailW = extra.detailW;
        worse = last && res.score > last.score ? worse + 1 : 0;
        results.push(res); last = res;
      };
      const r = SA.solveJoint(ctx.cache.P, ph.d, ph.inside, job.threads, job.board, Object.assign({ frameMM: ctx.frameMM, maxLines: cps[cps.length - 1], detailEvery: AUTO.DETAIL_EVERY }, ctx.jointOpts || {}, ph.wmap ? { wmap: ph.wmap } : {}, extra, {
        stop: (total, st) => {
          // past the time limit: score what is there and stop
          if (job.deadline && total > 0 && !(total & 15) && Date.now() > job.deadline) { if (!last || last.L !== total) evalAt(total, st.orders, st.blocks); late = true; return true; }
          if (total !== cps[ci]) return false;
          evalAt(total, st.orders, st.blocks); ci++;
          return worse >= 2;
        }
      }));
      // the solver stopped by itself (no line lowers the error): score what it made
      if (!late && worse < 2 && (!last || last.L !== r.total) && r.total > 0) evalAt(r.total, r.orders, r.blocks);
      // sa9: the solver stopped by itself before the last checkpoint (selfStop = its line count)
      if (!late && worse < 2 && r.total < cps[cps.length - 1]) results.forEach((x) => { x.selfStop = r.total; });
      return { results, switches: r.switches, late };
    };
    let out = once({});
    // Palette guard (sa7): the detail term can crowd a light colored thread out (under 3% of the lines,
    // e.g. green on the dog photo, which then comes out purple). If the best result of a palette drops
    // a thread, the palette is also tried without the detail term, and the better one is kept; the
    // pick carries detailW so Make string art uses the same solver.
    if (K > 1 && AUTO.GUARD && out.results.length && (!job.deadline || Date.now() < job.deadline)) {
      const b0 = best(out);
      if (b0.k < K) { AUTO.guardRuns = (AUTO.guardRuns || 0) + 1; const alt = once({ detailW: 0 }); if (alt.results.length && best(alt).score < b0.score) out = alt; }
    }
    return { job, results: out.results, ms: Date.now() - t0, switches: out.switches, late: out.late };
  };
  const best = (res) => (res.results.length ? res.results.reduce((a, b) => (b.score < a.score ? b : a)) : { score: Infinity });
  const cfgKey = (j) => j.board + j.threads.join('') + '|' + j.n + '|' + j.res;

  /* Palettes to test: the presets, the current one, and the best fitted palette for each thread
     count. Palettes are {board: board key, threads: DMC numbers}. */
  AUTO.palettes = function (presets, fits, current, colors, chroma) {
    if (!colors) return [current];
    // a photo with little color is made with black or white thread on a white or black board
    if (chroma < AUTO.GREY_CHROMA) return [{ board: 'white', threads: ['310'] }, { board: 'black', threads: ['B5200'] }];
    const out = [], seen = new Set();
    const add = (p) => { const k = p.board + ':' + p.threads.join('+'); if (!seen.has(k)) { seen.add(k); out.push({ board: p.board, threads: p.threads.slice() }); } };
    // in order of priority (a slow device may only get through the first few): black on white,
    // the fitted three threads and pair on white, the current colors, the other presets, then the
    // fitted three threads on each other board
    // Fits come with and without the hue term (f.hue); errH (fit error with hue weight 1) orders
    // them, so the fits that keep the photo's key hues come first.
    const rank = (f) => (f.board === 'white' ? 0 : f.board === 'black' ? 1 : 2), by = (a, b) => rank(a) - rank(b) || a.errH - b.errH;
    const f3 = fits.filter((f) => f.threads.length === 3).sort(by), f2 = fits.filter((f) => f.threads.length === 2).sort(by);
    const white = (f) => f.board === 'white';
    add(presets[0]);
    // white board: the fitted threes and pairs, best first (each kind of fit once)
    const w = f3.filter(white).concat(f2.filter(white)).sort((a, b) => a.errH - b.errH);
    w.forEach(add);
    add(current); add(presets[1]);
    // black board: the fitted three threads (with and without the hue term); grey and wood
    // boards only when there is time (they are rarely chosen: see BOARD_MARGIN)
    f3.filter((f) => f.board === 'black').forEach(add);
    f3.filter((f) => !plain(f.board)).sort((a, b) => a.errH - b.errH).slice(0, 1).forEach(add);
    return out;
  };
  const plain = (b) => b === 'white' || b === 'black';
  /* Final choice: the lowest score. A grey or wood board is only chosen if it beats the best
     white or black board result by BOARD_MARGIN, with and without the hue term, and shows at
     least as much detail. A setup with
     fewer threads, then fewer lines, then fewer nails is preferred if it scores within TOL. */
  AUTO.choose = function (rs, palettes) {
    let all = [];
    rs.forEach((r) => r.results.forEach((x) => all.push({ job: r.job, ...x })));
    const boardOf = (x) => (palettes ? palettes[x.job.pi].board : 'white');
    const P = all.filter((x) => plain(boardOf(x)));
    if (P.length) {
      const bp = P.reduce((a, b) => (b.score < a.score ? b : a));
      // the margin also holds without the hue term: a colored board adds its own hue everywhere,
      // which the hue term alone would reward
      const nh = (x) => x.score - SA.scoreWeights.hue * (x.hue || 0);
      all = all.filter((x) => plain(boardOf(x)) || (x.score < bp.score * (1 - AUTO.BOARD_MARGIN) && nh(x) < nh(bp) * (1 - AUTO.BOARD_MARGIN) && x.detail >= bp.detail));
    }
    // near ties (within HUE_TOL) go to the setups that keep the photo's hues best
    const lo0 = Math.min(...all.map((x) => x.score)), near = all.filter((x) => x.score <= lo0 * (1 + AUTO.HUE_TOL));
    const hmin = Math.min(...near.map((x) => x.hue || 0));
    all = near.filter((x) => (x.hue || 0) <= hmin + 1);
    const lo = Math.min(...all.map((x) => x.score));
    const ok = all.filter((x) => x.score <= lo * (1 + AUTO.TOL));
    ok.sort((a, b) => a.k - b.k || a.used - b.used || a.job.n - b.job.n || a.score - b.score || a.L - b.L);
    return { pick: ok[0], bestScore: lo0 };
  };

  /* The whole search. o: {shape, A, frameMM: [width, height] in mm, photos: [{res, w, h, d}],
     dmc: [[code, name, hex]], boards: {key: {hex}}, presets, current, colors,
     init(msg): send msg to every worker; run(msgs, label, from, to) -> results (or a promise),
     now(): ms clock, budgetMs}. Returns {settings, tested, pick, palettes, stages}. */
  AUTO.search = async function (o) {
    const now = o.now || (() => Date.now()), t0 = now(), budget = o.budgetMs == null ? AUTO.BUDGET_MS : o.budgetMs;
    const fMM = Math.max(o.frameMM[0], o.frameMM[1]), L0 = AUTO.linesFor(fMM), s0 = AUTO.strengthFor(fMM);
    // time limit: on a slow device, tests not started by a stage's limit are skipped and running
    // tests stop at it; the choice is made from what finished. Deadlines are Date.now() times.
    const limit = (f) => (isFinite(budget) ? Date.now() + budget * f - (now() - t0) : 0);
    const ready = await o.init({ type: 'init', shape: o.shape, A: o.A, photos: o.photos, frameMM: fMM });
    const chroma = ready && ready.chroma != null ? ready.chroma : 99;
    const nails = AUTO.nailCounts(o.shape, o.A, o.frameMM[1], o.nailCap), LH = AUTO.linesMax(fMM);
    let fits = [];
    if (o.colors && chroma >= AUTO.GREY_CHROMA) {
      // white and black boards first
      const bs = Object.keys(o.boards).sort((a, b) => plain(b) - plain(a));
      // each plain board is fitted with and without the hue term; grey and wood without
      const fj = [].concat(...bs.map((b) => (plain(b) ? [AUTO.HUE_FIT, 0] : [0]).map((hue) => ({ type: 'fit', dmc: o.dmc, boards: { [b]: o.boards[b].hex }, hue }))));
      const parts = await o.run(fj, 'choosing thread colors', 0, 0.1, limit(0.25));
      fits = [].concat(...parts.filter(Boolean).map((p) => p.fits));
    }
    const hex = new Map(o.dmc.map((d) => [d[0], d[2]]));
    const pals = AUTO.palettes(o.presets || AUTO.PRESETS, fits, o.current, o.colors, chroma)
      .map((p) => Object.assign(p, { boardHex: o.boards[p.board].hex, threadHex: p.threads.map((c) => hex.get(c)) }));
    const cps = AUTO.checkpoints(L0, LH), nMax = nails.list[nails.list.length - 1], nLo = nails.list[0];
    const jobsRun = async (jobs, label, a, b, f) => {
      if (!jobs.length) return [];
      const dl = f ? limit(f) : 0;
      // stable order: palette priority, then nails and size
      // a started test stops at the stage limit plus a little, so it can usually finish
      const ms = jobs.map((job) => ({ type: 'job', job: Object.assign(job, { deadline: dl && dl + AUTO.OVERRUN * budget }) }));
      return (await o.run(ms, label, a, b, dl)).filter((m) => m && m.result && m.result.results.length).map((m) => m.result);
    };
    const mk = (pi, n, res) => ({ pi, threads: pals[pi].threadHex, board: pals[pi].boardHex, n, res, checkpoints: cps });
    // 1: every palette, quickly (small working size, fewer nails)
    // a slow device (setup took over 15% of the time limit) skips step 2 and spends that time on
    // step 1, so that more palettes are tried
    const slowStart = isFinite(budget) && now() - t0 > 0.15 * budget;
    // on a slow device the best fitted palette goes first, before black on white, so that a
    // colored photo gets at least one colored test
    const ord = pals.map((p, pi) => pi);
    if (slowStart && pals.length > 1 && pals[1].threads.length > 1) { ord[0] = 1; ord[1] = 0; }
    const r1 = await jobsRun(ord.map((pi) => mk(pi, nLo, AUTO.FIRST)), 'step 1 of 2', 0.1, slowStart ? 1 : 0.5, slowStart ? 0.95 : 0.6);
    if (!r1.length) r1.push(...(await jobsRun([mk(0, nLo, AUTO.FIRST)], 'step 1 of 2', 0.1, 0.5, 0)));
    const byPal = r1.map((r) => ({ pi: r.job.pi, b: best(r).score })).sort((a, b) => a.b - b.b);
    // 2: the palettes within 15% of the best (at most 3; 2 on a slow device), at full search size
    const slow = now() - t0 > budget / 2;
    const keep = byPal.filter((x) => x.b <= byPal[0].b * 1.15).slice(0, slow ? 2 : 3).map((x) => x.pi);
    let all = r1.slice(), stage2 = 0;
    if (!slowStart && now() - t0 < budget * 0.75) {
      const js = [].concat(...keep.map((pi) => (slow ? [mk(pi, nMax, AUTO.COARSE)] : [mk(pi, nMax, AUTO.COARSE), mk(pi, nLo, AUTO.COARSE)])));
      const r2 = await jobsRun(js, 'step 2 of 2', 0.5, 1, 1); stage2 = r2.length;
      // the step-1 results are only a guide when step 2 ran
      if (r2.length) all = r2;
    }
    const ch = AUTO.choose(all, pals), pk = ch.pick, pal = pals[pk.job.pi];
    const tested = (all === r1 ? [r1] : [r1, all]).reduce((a, rs) => a + rs.reduce((b, r) => b + r.results.length, 0), 0);
    const keptUsed = pk.cnt.reduce((a, c, i) => a + (pk.keep[i] ? c : 0), 0), dropped = pk.k < pk.job.threads.length;
    let lines = pk.k === 1 || dropped ? r100(Math.ceil(keptUsed / 100) * 100, LH) : pk.L;
    // sa9: when the chosen test ran until no line helped (at its small size) and the choice is near that end,
    // Make string art gets room for as many lines as that is at its own size; it stops by itself and is then
    // cut to the best of 70/80/90 % and the end of what it placed (worker.js). The wave chose 1000 lines
    // here at 120 px (its test stopped at 1085), while at 200 px it places 1691 and scores best there.
    if (pk.selfStop && pk.L >= AUTO.SELF_NEAR * pk.selfStop) lines = Math.max(lines, r100(pk.selfStop * AUTO.jointRes(fMM) / pk.job.res, LH));
    // sa8: tests stop at TEST_NAILS; when their most nails win and the frame takes more, it gets the most it takes
    const nPick = pk.job.n === nMax && nails.max > nMax ? nails.max : pk.job.n;
    return {
      settings: Object.assign({ nails: nPick, lines, strength: s0, threads: pal.threads.filter((c, i) => pk.keep[i]), board: pal.board }, pk.detailW != null ? { detailW: pk.detailW } : {}),
      tested, pick: pk, bestScore: ch.bestScore, chroma, palettes: pals.map((p) => p.board + ':' + p.threads.join('+')),
      stages: [r1.length, stage2], ms: now() - t0, spacingMM: nails.spacingAt(nPick), testedNails: pk.job.n,
      first: r1.map((r) => { const b = best(r); return { palette: pals[r.job.pi].board + ':' + pals[r.job.pi].threads.join('+'), score: b.score, L: b.L, detail: b.detail, dab: b.dab }; })
    };
  };

  G.SACore = SA;
  if (typeof module !== 'undefined' && module.exports) module.exports = SA;
})(typeof self !== 'undefined' ? self : globalThis);
