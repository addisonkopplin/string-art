/* Focus on subject. Finds the photo's main subject with U^2-Net (u2netp; Apache License 2.0,
   see LICENSES.txt), run in the browser by ONNX Runtime Web (MIT). The page loads this file only when
   Focus on subject is turned on. Nothing leaves the device. */
(function () {
  'use strict';
  const base = new URL('.', document.currentScript.src).href;
  const SIZE = 320, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  let ready = null;
  const addScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s);
  });
  function load() {
    if (!ready) ready = (async () => {
      // opened straight from disk: browsers block fetch() on file://, so skip it quietly (the page then uses the whole photo)
      if (location.protocol === 'file:') throw new Error('Focus on subject needs the page served over http(s)');
      if (!window.ort) await addScript(base + 'ort/ort.wasm.min.js');
      ort.env.wasm.wasmPaths = base + 'ort/';
      ort.env.wasm.numThreads = 1;   // a static host cannot send COOP/COEP headers, so no SharedArrayBuffer: one thread
      ort.env.wasm.proxy = true;     // the model runs in a worker: the page stays responsive meanwhile
      // fetched here as bytes, so the server's Content-Type for .onnx (often application/octet-stream) does not matter
      const r = await fetch(base + 'u2netp.onnx');
      if (!r.ok) throw new Error('could not load u2netp.onnx (' + r.status + ')');
      const model = new Uint8Array(await r.arrayBuffer());
      return ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  // rgba: SIZE x SIZE pixels (canvas RGBA). Returns the subject mask, SIZE x SIZE, 0-255 (255 = subject).
  async function mask(rgba) {
    const s = await load(), n = SIZE * SIZE, x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]) }), y = out[s.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
    const m = new Uint8Array(n), k = hi > lo ? 255 / (hi - lo) : 0;
    for (let i = 0; i < n; i++) m[i] = Math.round((y[i] - lo) * k);
    return m;
  }
  window.SAFocus = { load, mask, SIZE };
})();
