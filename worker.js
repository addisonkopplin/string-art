/* String art worker. Runs the line solver off the page so the page stays responsive.
   'run': one full calculation; lines are posted in batches as they are chosen.
   'init', 'fit', 'job': parts of Find best settings (see core.js, SACore.auto). */
'use strict';
importScripts('core.js');
const SA = self.SACore;
let ctx = null;

self.onmessage = function (e) {
  const m = e.data;
  if (m.type === 'run') run(m);
  else if (m.type === 'joint') joint(m);
  else if (m.type === 'init') {
    ctx = { shape: m.shape, A: m.A, frameMM: m.frameMM || 400, photo: {}, cache: null, solveOpts: m.solveOpts };
    // p.m = subject mask (Uint8, 0-255) when Focus on subject is on: it becomes the solver's importance map
    for (const p of m.photos) ctx.photo[p.res] = { d: new Uint8ClampedArray(p.d), w: p.w, h: p.h, inside: SA.insideMask(m.shape, p.w, p.h), wmap: p.m ? SA.importance(new Uint8Array(p.m), p.w, p.h, { bgW: m.bgW }) : null };
    const t = ctx.photo[SA.auto.EVAL];
    ctx.T = SA.target(t.d, t.w, t.h, t.inside, m.shape, { frameMM: ctx.frameMM });
    self.postMessage({ type: 'ready', chroma: ctx.T.chroma });
  } else if (m.type === 'fit') {
    const t = ctx.photo[SA.auto.COARSE];
    self.postMessage({ type: 'fit', id: m.id, fits: SA.fitPalettes(t.d, t.inside, m.dmc, m.boards, 3, 0, m.hue || 0) });
  } else if (m.type === 'job') {
    self.postMessage({ type: 'job', id: m.id, result: SA.auto.evalJob(ctx, m.job), cache: ctx.cache && ctx.cache.key });
  }
};

function run(m) {
  const w = m.w, n = m.nails, t0 = performance.now();
  const P = SA.prepare(n, m.nx, m.ny, m.edge, w, m.skip, (f) => self.postMessage({ type: 'prep', done: f }));
  const tPrep = performance.now() - t0;
  const maps = m.maps.map((b) => new Float32Array(b));
  let sent = 0, lastPost = 0, order = null, color = 0;
  const flush = (k) => {
    if (k > sent) self.postMessage({ type: 'lines', color, nails: Array.from(order.subarray(sent + 1, k + 1)), count: k });
    sent = k; lastPost = performance.now();
  };
  const r = SA.solve(P, maps, m.budgets, m.strength, {
    penalty: m.penalty, start: m.start, clip: m.clip,
    onStart: (c, o, lines) => { color = c; order = o; sent = 0; lastPost = performance.now(); self.postMessage({ type: 'lines', color: c, nails: [o[0]], count: 0, budget: lines }); },
    onEnd: (c, k) => { flush(k); self.postMessage({ type: 'colorDone', color: c, count: k }); }
  }, (c, k) => { if (performance.now() - lastPost > 30) flush(k); });
  self.postMessage({ type: 'done', counts: r.counts, prepMs: tPrep, totalMs: performance.now() - t0 });
}

// All threads placed together (SA.solveJoint); progress is posted while it runs.
function joint(m) {
  const t0 = performance.now(), n = m.nails, K = m.threads.length;
  // sa8 memory check: the line table is kept only if it fits m.tableMB (the page sets it from the device);
  // otherwise each line is stepped when needed (same result, slower, a few MB)
  const tb = SA.tableBytes(n, m.nx, m.ny, m.edge, m.skip), lazy = tb > (m.tableMB || 256) * 1048576;
  const P = SA.prepare(n, m.nx, m.ny, m.edge, m.w, m.skip, null, lazy);
  const tPrep = performance.now() - t0;
  const inside = SA.insideMask(m.shape, m.w, m.h);
  // m.wm = subject mask (Uint8, 0-255, w x h) when Focus on subject is on
  const wmap = m.wm ? SA.importance(new Uint8Array(m.wm), m.w, m.h, { bgW: m.bgW, feather: m.feather }) : null;
  // With m.ed (the photo at the search's scoring size), the result is scored as the search scores
  // it at 70%, 80%, 90% of the lines and at the end, and cut to the best of these: the search
  // tests at a smaller size, where the best line count can come out higher.
  let T = null, lay = null, cps = [], best = null;
  if (m.ed) {
    T = SA.target(new Uint8ClampedArray(m.ed), m.ew, m.eh, SA.insideMask(m.shape, m.ew, m.eh), m.shape, { frameMM: m.frameMM });
    lay = SA.nailLayout(m.shape, n, m.A);
    // sa8: 50 % and 60 % are not scored any more (in 96 bench cuts the best was always at 70 % or later)
    cps = [0.7, 0.8, 0.9].map((f) => Math.round(m.maxLines * f));
  }
  // a result is scored as the app will show it: threads under MIN_SHARE of the lines are left out
  const scoreAt = (total, orders, blocks) => {
    const fl = SA.firstLines(blocks, K, total), kc = fl.counts.map((c) => (K > 1 && c < SA.auto.MIN_SHARE * total ? 0 : c));
    const r = SA.score(SA.render(m.ew, m.eh, lay, orders, kc, m.threads, m.board, 0, m.frameMM, fl.blocks), T), sc = r.score;
    if (!best || sc < best.score) best = { score: sc, L: total, hue: r.hue };
  };
  // sa8: lines are posted in batches as they are placed (type 'lines', segs = [thread, from nail, to nail, ...]),
  // so the page draws the result while it is solved. A second winding (palette guard) is not streamed:
  // the page keeps the first one visible and only posts progress (phase 'check').
  const once = (detailW, stream) => {
    let last = 0, buf = [], total = 0; best = null;
    const post = () => {
      if (stream) { const segs = Int16Array.from(buf); buf = []; self.postMessage({ type: 'lines', segs, total }, [segs.buffer]); }
      else self.postMessage({ type: 'progress', total, phase: 'check' });
    };
    const r = SA.solveJoint(P, new Uint8ClampedArray(m.d), inside, m.threads, m.board, {
      frameMM: m.frameMM, wmap, maxLines: m.maxLines, minBlock: m.minBlock, switchPenalty: m.switchPenalty, detailW, detailEvery: m.detailEvery, hueW: m.hueW, toneK: m.toneK, hiW: m.hiW, centerW: m.centerW, fineW: m.fineW, fineS1: m.fineS1, fineS2: m.fineS2, fineEvery: m.fineEvery, detailCap: m.detailCap, refresh: m.refresh, reuseW: m.reuseW, reuseCell: m.reuseCell, edgeW: m.edgeW,
      onLine: stream ? (t, a, b) => { buf.push(t, a, b); } : null,
      stop: (tot, st) => {
        total = tot;
        const t = performance.now(); if (t - last > 40) { last = t; post(); } return false;
      }
    });
    if (stream && buf.length) post();
    // sa8: the checkpoints are scored after the run, all in one render pass when no thread is left out at
    // any of them (the same images as rendering each one); otherwise one render each as before
    if (T && r.total > 0) {
      // sa9: the checkpoints are 70/80/90 % of what was placed (the same as before when the run reached maxLines;
      // a run that stopped by itself is cut among its own lines)
      const top = Math.min(m.maxLines, r.total), at = cps.length ? [0.7, 0.8, 0.9].map((f) => Math.round(top * f)).filter((v) => v > 0 && v < r.total).concat([r.total]).filter((v, i, a) => a.indexOf(v) === i) : [r.total], fls = at.map((L) => SA.firstLines(r.blocks, K, L));
      const one = fls.every((fl, i) => K === 1 || fl.counts.every((c) => c >= SA.auto.MIN_SHARE * at[i]));
      if (one) {
        const res = [];
        SA.render(m.ew, m.eh, lay, r.orders, r.counts, m.threads, m.board, 0, m.frameMM, r.blocks, null, { at, fn: (i, img) => { res[i] = SA.score(img, T); } });
        // ties: the earlier count wins, as before (only a strictly lower score replaced the best)
        at.forEach((L, i) => { if (i < at.length - 1 ? (!best || res[i].score < best.score) : !best || !(best.score < res[i].score)) best = { score: res[i].score, L, hue: res[i].hue }; });
      } else {
        for (let i = 0; i < at.length - 1; i++) scoreAt(at[i], r.orders, fls[i].blocks);
        const prev = best; best = null; scoreAt(r.total, r.orders, r.blocks); const end = best; best = prev && prev.score < end.score ? prev : end;
      }
    }
    return { r, best };
  };
  let run = once(m.detailW, m.stream !== false), guard = null, guardHue = null;
  // palette guard (sa7, as in AUTO.evalJob): if the detail term leaves a thread under MIN_SHARE of the
  // lines, the threads are also wound without it, and the better result is kept
  if (T && K > 1 && run.best && m.detailW !== 0 && m.guard !== false) {
    const fl = SA.firstLines(run.r.blocks, K, run.best.L);
    // sa8: only when the result also lost the photo's hue mix (hue distance over SA.auto.GUARD_HUE): with
    // the key-hue term a dropped thread is usually one the picture does not need, and the second
    // winding would only cost time
    if (fl.counts.some((c) => c < SA.auto.MIN_SHARE * run.best.L)) guardHue = run.best.hue;
    if (fl.counts.some((c) => c < SA.auto.MIN_SHARE * run.best.L) && !(run.best.hue <= SA.auto.GUARD_HUE)) { const alt = once(0, false); guard = alt.best && alt.best.score < run.best.score ? 'alt' : 'kept'; if (guard === 'alt') run = alt; }
  }
  const r = run.r; best = run.best;
  let orders = r.orders, counts = r.counts, blocks = r.blocks, cut = null;
  if (T && r.total > 0 && best.L < r.total) {
    const fl = SA.firstLines(r.blocks, K, best.L); counts = fl.counts; blocks = fl.blocks;
    orders = r.orders.map((o, t) => o.subarray(0, counts[t] + 1)); cut = { from: r.total, to: best.L };
  }
  const switches = Math.max(0, blocks.length - 1);
  self.postMessage({ type: 'done', joint: true, orders: orders.map((o) => Array.from(o)), counts, blocks, switches, cut, guard, guardHue, lazy, tableMB: Math.round(tb / 1048576), prepMs: tPrep, totalMs: performance.now() - t0 });
}
