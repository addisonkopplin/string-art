/* String Art Maker: user interface, crop, rendering, downloads, build guide and the
   Find best settings search. Nail layout, color separation, the line solver and the match
   score are in core.js; the solver runs in worker.js. Nothing is sent over the network.
   offline.js lets the page run straight from disk (file://): see tools/build_offline.py. */
(function () {
  'use strict';
  const SA = window.SACore;
  const $ = (id) => document.getElementById(id);
  const TARGET = 500;   // working resolution of the photo: pixels along the longer side
  const MAXSRC = 2400;  // photos are downscaled to this many pixels along the longer side
  const fmt = (n) => n.toLocaleString('en-US');

  // ---------- state ----------
  const S = { img: null, imgId: 0, zoom: 1, cx: 0, cy: 0, sample: false, running: false, worker: null, result: null, auto: null, onFinish: null };

  // ---------- frame ----------
  const ASPECT = { '4:5': 4 / 5, '3:4': 3 / 4, '2:3': 2 / 3, '9:16': 9 / 16, '5:4': 5 / 4, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9 };
  const SHAPE_NAME = { circle: 'Circle', square: 'Square', rect: 'Rectangle', ellipse: 'Oval' };
  // sizes in millimetres, kept per shape so switching shapes does not lose them
  const F = { shape: 'circle', unit: 'cm',
    size: { circle: [400, 400], square: [400, 400], rect: [400, 500], ellipse: [400, 500] },
    aspect: { rect: '4:5', ellipse: '4:5' } };
  const fw = () => F.size[F.shape][0], fh = () => F.size[F.shape][1];
  const frameAspect = () => fw() / fh();
  // sa8: phones and low-memory devices get fewer nails at most and a smaller line table (worker.js memory check)
  const LOWMEM = (navigator.deviceMemory && navigator.deviceMemory < 4) || window.matchMedia('(pointer: coarse)').matches;
  const nailCap = () => (LOWMEM ? SA.auto.NAIL_CAP_LOW : SA.auto.NAIL_CAP);
  const frameKey = () => F.shape + ':' + frameAspect().toFixed(4);
  const UNIT = { cm: 10, in: 25.4 };
  const toUnit = (mm) => +(mm / UNIT[F.unit]).toFixed(F.unit === 'cm' ? 1 : 2);
  const unitStr = (mm) => String(+(mm / UNIT[F.unit]).toFixed(1)) + (F.unit === 'cm' ? ' cm' : ' in');
  function frameText() {
    const w = fw(), h = fh(), u = F.unit === 'cm' ? ' cm' : ' in', v = (mm) => String(+(mm / UNIT[F.unit]).toFixed(1));
    if (F.shape === 'circle') return 'Circle, ' + v(w) + u + ' diameter';
    if (F.shape === 'square') return 'Square, ' + v(w) + u + ' sides';
    return SHAPE_NAME[F.shape] + ', ' + v(w) + ' × ' + v(h) + u + ' (width × height)';
  }

  const nailLayout = SA.nailLayout;
  function workSize(A) { return A >= 1 ? [TARGET, Math.round(TARGET / A)] : [Math.round(TARGET * A), TARGET]; }
  function fitSize(A, max) { return A >= 1 ? [max, Math.round(max / A)] : [Math.round(max * A), max]; }

  // ---------- crop ----------
  const crop = $('crop'), cc = $('crop-canvas'), cctx = cc.getContext('2d');
  function cropDims() { const [w, h] = fitSize(frameAspect(), 840); if (cc.width !== w || cc.height !== h) { cc.width = w; cc.height = h; } return [w, h]; }
  function baseScale(w, h) { return Math.max(w / S.img.width, h / S.img.height); }
  function clampCenter() {
    const w = cc.width, h = cc.height, s = baseScale(w, h) * S.zoom, hx = w / 2 / s, hy = h / 2 / s;
    S.cx = Math.min(Math.max(S.cx, hx), S.img.width - hx);
    S.cy = Math.min(Math.max(S.cy, hy), S.img.height - hy);
  }
  function drawImageTo(ctx, w, h) {
    const s = baseScale(w, h) * S.zoom;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.img, w / 2 - S.cx * s, h / 2 - S.cy * s, S.img.width * s, S.img.height * s);
  }
  function shapePath(ctx, w, h, inset) {
    if (F.shape === 'circle' || F.shape === 'ellipse') ctx.ellipse(w / 2, h / 2, w / 2 - inset, h / 2 - inset, 0, 0, Math.PI * 2);
    else ctx.rect(inset, inset, w - 2 * inset, h - 2 * inset);
  }
  function drawCrop() {
    const [w, h] = cropDims();
    if (!S.img) { cctx.clearRect(0, 0, w, h); return; }
    clampCenter();
    drawImageTo(cctx, w, h);
    cctx.save();
    if (F.shape === 'circle' || F.shape === 'ellipse') {
      cctx.beginPath(); cctx.rect(0, 0, w, h); shapePath(cctx, w, h, 1);
      cctx.fillStyle = 'rgba(255,255,255,0.78)'; cctx.fill('evenodd');
    }
    cctx.beginPath(); shapePath(cctx, w, h, 1);
    cctx.lineWidth = 2; cctx.strokeStyle = '#111'; cctx.stroke();
    cctx.restore();
  }
  const SAMPLE_CREDIT = $('credit').textContent;
  function setImage(img, isSample) {
    S.img = img; S.imgId++; S.sample = isSample; S.zoom = 1;
    S.cx = img.width / 2; S.cy = img.height / 2;
    $('zoom').value = 1; $('zoom-o').textContent = '1.00×';
    $('crop-empty').hidden = true; $('credit').hidden = !isSample; if (isSample) $('credit').textContent = SAMPLE_CREDIT;
    $('run').disabled = S.running; $('auto').disabled = S.running;
    drawCrop();
    setStatus('Position the photo, then select Make string art.');
  }

  // Photos are decoded with their EXIF orientation applied, then downscaled.
  const HEIC_MSG = 'This browser cannot open HEIC photos. Convert the photo to JPEG first. On an iPhone, Settings › Camera › Formats › Most Compatible saves new photos as JPEG.';
  function decodeWithImg(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  async function loadBlob(blob, isSample, name) {
    const heic = /hei[cf]/i.test(blob.type) || /\.(heic|heif)$/i.test(name || '');
    setStatus('Opening photo…');
    let src = null;
    try {
      if (window.createImageBitmap) { try { src = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { src = null; } }
      if (!src) src = await decodeWithImg(blob);
      if (!src.width || !src.height) throw new Error('empty');
    } catch (e) {
      setStatus(heic ? HEIC_MSG : 'This file could not be opened as an image. Use a JPEG, PNG or WebP file.');
      return;
    }
    const k = Math.min(1, MAXSRC / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    setImage(c, isSample);
  }
  function loadFile(file) {
    if (!file) return;
    const okType = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name);
    if (!okType) { setStatus('Choose an image file, such as a JPEG, PNG or WebP photo.'); return; }
    loadBlob(file, false, file.name);
  }
  $('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('sample').addEventListener('click', () => SAOffline.sampleBlob().then((b) => loadBlob(b, true, 'sample.jpg'))
    .catch(() => setStatus('The sample photo could not be loaded.')));
  ['dragenter', 'dragover'].forEach((t) => crop.addEventListener(t, (e) => { e.preventDefault(); crop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => crop.addEventListener(t, (e) => { e.preventDefault(); crop.classList.remove('over'); }));
  crop.addEventListener('drop', (e) => {
    const dt = e.dataTransfer, f = dt && dt.files && dt.files[0];
    if (f) { loadFile(f); return; }
    const u = dt && (dt.getData('text/uri-list') || dt.getData('text/plain'));
    if (u && /^https?:\/\//i.test(u.trim())) loadURL(u.trim().split(/\s+/)[0]);
  });

  const ptrs = new Map(); let pinch0 = 0, zoom0 = 1;
  function setZoom(z) {
    S.zoom = Math.min(4, Math.max(1, z));
    $('zoom').value = S.zoom; $('zoom-o').textContent = S.zoom.toFixed(2) + '×';
    drawCrop();
  }
  crop.addEventListener('pointerdown', (e) => {
    if (!S.img) return;
    crop.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    crop.classList.add('dragging');
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = S.zoom; }
  });
  crop.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId), dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      const k = cc.width / crop.clientWidth / (baseScale(cc.width, cc.height) * S.zoom);
      S.cx -= dx * k; S.cy -= dy * k; drawCrop();
    } else if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()]; setZoom(zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0);
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = 0; if (!ptrs.size) crop.classList.remove('dragging'); };
  crop.addEventListener('pointerup', up); crop.addEventListener('pointercancel', up);
  crop.addEventListener('wheel', (e) => { if (!S.img) return; e.preventDefault(); setZoom(S.zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  crop.addEventListener('keydown', (e) => {
    if (!S.img) return;
    const step = 10 / (baseScale(cc.width, cc.height) * S.zoom), keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (keys[e.key]) { e.preventDefault(); S.cx += keys[e.key][0] * step; S.cy += keys[e.key][1] * step; drawCrop(); }
    else if (e.key === '+' || e.key === '=') setZoom(S.zoom * 1.1);
    else if (e.key === '-') setZoom(S.zoom / 1.1);
  });
  $('zoom').addEventListener('input', (e) => setZoom(+e.target.value));

  // ---------- frame controls ----------
  const radios = (name) => [...document.querySelectorAll('input[name="' + name + '"]')];
  function syncFrameInputs() {
    const sh = F.shape, two = sh === 'rect' || sh === 'ellipse';
    $('aspect-f').hidden = !two; $('fh-f').hidden = !two;
    if (two) $('aspect').value = F.aspect[sh];
    $('fw-l').textContent = sh === 'circle' ? 'Diameter' : sh === 'square' ? 'Side' : 'Width';
    $('fw').value = toUnit(fw()); $('fh').value = toUnit(fh());
    const step = F.unit === 'cm' ? 0.5 : 0.25, lo = F.unit === 'cm' ? 10 : 4, hi = F.unit === 'cm' ? 200 : 80;
    ['fw', 'fh'].forEach((id) => { $(id).step = step; $(id).min = lo; $(id).max = hi; });
  }
  function frameChanged() {
    const A = frameAspect();
    // keep the photo view and the result at the frame's proportions
    const cap = (rem) => A < 1 ? 'min(100%, ' + (rem * A).toFixed(2) + 'rem)' : '';
    crop.style.aspectRatio = String(A); crop.style.maxWidth = cap(26);
    $('stage').style.aspectRatio = String(A); $('stage').style.maxWidth = A < 1 ? 'min(44rem, ' + (40 * A).toFixed(2) + 'rem)' : '';
    if (S.img) drawCrop(); else cropDims();
    updateSpacing(); syncPreset();
    if (S.result && !S.running) {
      if (S.result.key !== frameKey()) {
        setOutputsEnabled(false);
        setStatus('The frame shape or proportions changed. Select Make string art to make a new result for this frame.');
      } else { resizeOut(); redrawResult(); setOutputsEnabled(true); }
    } else if (!S.running) resizeOut(true);
  }
  // sa8: the Nails and Lines maximums follow the frame (SACore.auto.nailMax, linesMax)
  function updateRanges() {
    const set = (id, max) => { const el = $(id), v = +el.value; el.max = max; if (+el.value !== v || v > max) { el.value = Math.min(v, max); $(id + '-o').textContent = fmt(+el.value); } };
    set('nails', SA.auto.nailMax(F.shape, frameAspect(), fh(), nailCap()));
    set('lines', SA.auto.linesMax(Math.max(fw(), fh())));
  }
  function updateSpacing() {
    updateRanges();
    const n = +$('nails').value, lay = nailLayout(F.shape, 8, frameAspect());
    const mm = lay.P * fh() / n;
    const fm = Math.max(fw(), fh());
    $('suggest').textContent = 'About ' + fmt(SA.auto.linesFor(fm)) + ' lines suit this frame size.';
    $('spacing').textContent = 'Spacing on this frame: ' + (F.unit === 'cm' ? mm.toFixed(1) + ' mm' : (mm / 25.4).toFixed(2) + ' in') + '.';
  }
  radios('shape').forEach((r) => r.addEventListener('change', () => { if (r.checked) { F.shape = r.value; syncFrameInputs(); frameChanged(); } }));
  $('aspect').addEventListener('change', (e) => {
    const sh = F.shape; F.aspect[sh] = e.target.value;
    if (ASPECT[e.target.value]) F.size[sh][1] = F.size[sh][0] / ASPECT[e.target.value];
    syncFrameInputs(); frameChanged();
  });
  function readSize(id, final) {
    let x = parseFloat($(id).value);
    if (!isFinite(x) || x <= 0) { if (final) syncFrameInputs(); return; }
    let mm = x * UNIT[F.unit];
    if (final) mm = Math.min(2000, Math.max(100, mm));
    const sh = F.shape, sz = F.size[sh], r = ASPECT[F.aspect[sh]];
    if (sh === 'circle' || sh === 'square') { sz[0] = sz[1] = mm; }
    else if (id === 'fw') { sz[0] = mm; if (F.aspect[sh] !== 'custom') sz[1] = mm / r; }
    else { sz[1] = mm; if (F.aspect[sh] !== 'custom') sz[0] = mm * r; }
    if (final) syncFrameInputs();
    else if (F.aspect[sh] !== 'custom' && (sh === 'rect' || sh === 'ellipse')) $(id === 'fw' ? 'fh' : 'fw').value = toUnit(id === 'fw' ? sz[1] : sz[0]);
    frameChanged();
  }
  // sa8: Frame size presets set the longer side (40, 60, 80 or 120 cm); Custom keeps the size fields as they are
  $('preset').addEventListener('change', (e) => {
    const v = +e.target.value; if (!v) return;
    const sz = F.size[F.shape], k = v / Math.max(sz[0], sz[1]); sz[0] *= k; sz[1] *= k;
    syncFrameInputs(); frameChanged();
  });
  function syncPreset() { const L = Math.round(Math.max(fw(), fh())), o = [...$('preset').options].find((x) => +x.value === L); $('preset').value = o ? o.value : ''; }
  ['fw', 'fh'].forEach((id) => { $(id).addEventListener('input', () => readSize(id, false)); $(id).addEventListener('change', () => readSize(id, true)); });
  $('unit').addEventListener('change', (e) => { F.unit = e.target.value; syncFrameInputs(); updateSpacing(); });

  // ---------- color controls ----------
  // Threads are DMC floss numbers (see dmc.js). Board colors are approximate screen colors.
  const DMC = new Map((window.DMC || []).map((d) => [d[0], { code: d[0], name: d[1], hex: d[2] }]));
  const BOARDS = { white: { name: 'White', hex: '#ffffff' }, black: { name: 'Black', hex: '#161616' },
    grey: { name: 'Grey', hex: '#8c8c8c' }, wood: { name: 'Natural wood', hex: '#c9a67a' } };
  const PALETTES = {
    black: { board: 'white', threads: ['310'] },
    rgb: { board: 'black', threads: ['666', '702', '995'] },
    cmy: { board: 'white', threads: ['973', '3846', '3805'] },
    bw: { board: 'grey', threads: ['B5200', '310'] }
  };
  const C = { threads: PALETTES.black.threads.slice(), board: 'white' };
  const dmcLabel = (code) => { const d = DMC.get(code); return 'DMC ' + d.code + ' ' + d.name; };
  const cur = () => ({ threads: C.threads.map((c) => DMC.get(c).hex), board: BOARDS[C.board].hex });
  const threadSig = () => C.board + ':' + C.threads.join('+');   // the search's solver setting holds while the threads are unchanged
  const modeOf = (n) => (n > 1 ? 'multi' : 'one');
  const lab = SA.lab;
  // closest DMC floss to a picked color, by distance in CIELAB
  function nearestDMC(hex) {
    const p = lab(hex); let best = null, bd = Infinity;
    for (const d of DMC.values()) { const q = d.lab || (d.lab = lab(d.hex)); const e = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (e < bd) { bd = e; best = d; } }
    return best.code;
  }
  function renderThreads() {
    const box = $('threads'), t = C.threads;
    box.innerHTML = '';
    t.forEach((code, i) => {
      const d = DMC.get(code), li = document.createElement('li');
      const l = document.createElement('label'); l.className = 'sw';
      const inp = document.createElement('input'); inp.type = 'color'; inp.value = d.hex;
      inp.setAttribute('aria-label', 'Thread ' + (i + 1) + ' color: ' + dmcLabel(code) + '. Pick a color to change it to the closest DMC floss.');
      inp.addEventListener('change', () => { t[i] = nearestDMC(inp.value); $('palette').value = 'custom'; renderThreads(); colorsChanged(); });
      l.appendChild(inp); li.appendChild(l);
      const s = document.createElement('span'); s.className = 'tname';
      s.innerHTML = '<b>' + (t.length > 1 ? (i + 1) + '. ' : '') + 'DMC ' + d.code + '</b> ' + d.name;
      li.appendChild(s); box.appendChild(li);
    });
    $('board').value = C.board;
    $('add-thread').disabled = t.length >= 3; $('del-thread').disabled = t.length <= 1;
  }
  $('palette').addEventListener('change', (e) => {
    const p = PALETTES[e.target.value]; if (!p) return;
    C.board = p.board; C.threads = p.threads.slice(); renderThreads(); colorsChanged();
  });
  $('add-thread').addEventListener('click', () => {
    const t = C.threads; if (t.length >= 3) return;
    const extra = ['B5200', '666', '995', '973', '310'].find((c) => !t.includes(c)) || '702';
    t.push(extra); $('palette').value = 'custom'; renderThreads(); colorsChanged();
  });
  $('del-thread').addEventListener('click', () => { const t = C.threads; if (t.length <= 1) return; t.pop(); $('palette').value = 'custom'; renderThreads(); colorsChanged(); });
  $('board').addEventListener('change', (e) => { C.board = e.target.value; $('palette').value = 'custom'; colorsChanged(); });
  // After a result exists, color edits recolor the preview at once. If the edit changes what the
  // solver would do, a note asks for a new run.
  function colorsChanged() {
    const R = S.result; if (!R || S.running || !R.finished) return;
    const c = cur();
    if (R.threads.length === c.threads.length) {
      R.board = c.board; R.boardKey = C.board;
      R.threads.forEach((t, i) => { t.color = c.threads[i]; t.code = C.threads[i]; });
      if (R.key === frameKey()) redrawResult();
      const flip = R.threads.length === 1 && lightOnDark(c.threads[0], c.board) !== R.light;
      if (R.threads.length > 1 || flip) setStatus('Colors changed. The preview shows the new colors. Select Make string art to fit the lines to them.');
    } else setStatus('The number of threads changed. Select Make string art to make a new result.');
  }

  // ---------- settings ----------
  const bind = (id, f) => { const el = $(id), o = $(id + '-o'); const u = () => (o.textContent = f(+el.value)); el.addEventListener('input', u); u(); };
  bind('nails', fmt); bind('lines', fmt);
  $('nails').addEventListener('input', updateSpacing);

  // ---------- color helpers ----------
  const hex2rgb = SA.hex2rgb, lum = SA.lum, lightOnDark = SA.lightOnDark;

  // ---------- preprocessing: photo -> coverage maps (see core.js) ----------
  function photoPixels(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    drawImageTo(ctx, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  // ---------- result rendering ----------
  const out = $('out'), octx = out.getContext('2d');
  function resizeOut(clear) {
    // sa8: the canvas has about as many pixels as the screen shows (at most 1200, at least 600), so a
    // phone does not paint a 1200 px picture it shows at 700; downloads and the guide have their own size
    const shown = Math.ceil((out.clientWidth || 0) * (window.devicePixelRatio || 1) / 100) * 100;
    const A = S.result ? S.result.A : frameAspect(), [w, h] = fitSize(A, shown ? Math.max(600, Math.min(1200, shown)) : 1200);
    if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
    if (clear) { octx.fillStyle = '#fff'; octx.fillRect(0, 0, w, h); }
  }
  function geom(lay, w, h) {
    const inset = Math.max(w, h) * 0.006, n = lay.u.length, X = new Float32Array(n), Y = new Float32Array(n);
    for (let i = 0; i < n; i++) { X[i] = inset + lay.u[i] * (w - 2 * inset); Y[i] = inset + lay.v[i] * (h - 2 * inset); }
    return { X, Y };
  }
  // lines are drawn at the real thread width for the frame size, opaque
  const threadPx = (R, w, h) => Math.max(0.35, SA.THREAD_MM * Math.max(w, h) / R.frameMM);
  function paintBoard(ctx, w, h, R) {
    ctx.fillStyle = R.board; ctx.fillRect(0, 0, w, h);
    const { X, Y } = geom(R.lay, w, h), M = Math.max(w, h);
    ctx.fillStyle = lum(R.board) < 110 ? '#bdbdbd' : '#8a8a8a';
    for (let i = 0; i < X.length; i++) { ctx.beginPath(); ctx.arc(X[i], Y[i], Math.max(1, M / 900), 0, Math.PI * 2); ctx.fill(); }
  }
  // lines streamed from the worker: segs = [thread, from nail, to nail, ...] in placement order
  function drawRaw(ctx, w, h, R, segs) {
    const { X, Y } = geom(R.lay, w, h);
    ctx.lineWidth = threadPx(R, w, h); ctx.lineCap = 'butt';
    for (let k = 0; k < segs.length;) {
      const t = segs[k]; ctx.strokeStyle = R.threads[t].color; ctx.beginPath();
      for (; k < segs.length && segs[k] === t; k += 3) { ctx.moveTo(X[segs[k + 1]], Y[segs[k + 1]]); ctx.lineTo(X[segs[k + 2]], Y[segs[k + 2]]); }
      ctx.stroke();
    }
  }
  // finished result: thread and board mixed in linear light, as they look from a distance
  function paintAll(ctx, w, h, R) {
    // in strips, so a large export needs little memory beyond the canvas itself
    const rows = Math.max(16, Math.floor(4e6 / w)), args = [R.lay, R.threads.map((t) => t.order), R.threads.map((t) => t.count), R.threads.map((t) => t.color), R.board, R.strength, R.frameMM, R.blocks];
    for (let y0 = 0; y0 < h; y0 += rows) {
      const y1 = Math.min(h, y0 + rows), ch = SA.render(w, h, ...args, [y0, y1]), n = (y1 - y0) * w;
      const img = ctx.createImageData(w, y1 - y0), d = img.data;
      for (let i = 0, j = 0; i < n; i++, j += 4) { d[j] = ch[0][i]; d[j + 1] = ch[1][i]; d[j + 2] = ch[2][i]; d[j + 3] = 255; }
      ctx.putImageData(img, 0, y0);
    }
    const { X, Y } = geom(R.lay, w, h), M = Math.max(w, h);
    ctx.fillStyle = lum(R.board) < 110 ? '#bdbdbd' : '#8a8a8a';
    for (let i = 0; i < X.length; i++) { ctx.beginPath(); ctx.arc(X[i], Y[i], Math.max(1, M / 900), 0, Math.PI * 2); ctx.fill(); }
  }
  function redrawResult() { const R = S.result; if (!R || !R.finished) return; paintAll(octx, out.width, out.height, R); renderLegend(); }
  // Thread needed per color at the current frame size: the sum of the line lengths plus 10%.
  const SKEIN_M = 8;
  function threadMeters(R) {
    const W = fw(), H = fh(), u = R.lay.u, v = R.lay.v;
    return R.threads.map((t) => {
      let mm = 0; const o = t.order;
      for (let k = 0; k < t.count; k++) mm += Math.hypot((u[o[k]] - u[o[k + 1]]) * W, (v[o[k]] - v[o[k + 1]]) * H);
      return mm / 1000 * 1.1;
    });
  }
  // sa8: km above 1000 m
  const meters = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : fmt(Math.ceil(m)) + ' m');
  // sa8: winding time at 6 to 10 s per line
  const windTime = (L) => { const a = L * 6 / 3600, b = L * 10 / 3600; return b < 1.5 ? 'about ' + fmt(Math.round(L * 6 / 60)) + ' to ' + fmt(Math.round(L * 10 / 60)) + ' minutes' : 'about ' + fmt(Math.round(a)) + ' to ' + fmt(Math.round(b)) + ' hours'; };
  // what to buy: 8 m skeins, or a cone or spool when more than 10 skeins would be needed
  const skeins = (m) => { const k = Math.ceil(m / SKEIN_M); return k > 10 ? 'a cone or spool of at least ' + meters(m) : fmt(k) + (k === 1 ? ' skein' : ' skeins'); };
  function renderLegend() {
    const R = S.result, sl = $('shoplist');
    if (!R || !R.finished) { sl.hidden = true; return; }
    const m = threadMeters(R);
    sl.innerHTML = '<h3>Shopping list</h3><table><thead><tr><th scope="col">Thread</th><th scope="col">Lines</th><th scope="col">Length</th><th scope="col">Buy</th></tr></thead><tbody>' +
      R.threads.map((t, i) => '<tr><td><i style="background:' + t.color + '"></i>' + (R.threads.length > 1 ? (i + 1) + '. ' : '') + dmcLabel(t.code) + '</td><td>' + fmt(t.count) +
        '</td><td>' + meters(m[i]) + '</td><td class="buy">' + skeins(m[i]).replace(/^a/, 'A') + '</td></tr>').join('') +
      '</tbody></table><p class="hint">Frame: ' + frameText() + '. Board: ' + BOARDS[R.boardKey].name.toLowerCase() + '. Nails: ' + fmt(R.nails) + '. Thread: ' + meters(m.reduce((a, b) => a + b, 0)) + ' in all. Winding: ' + windTime(R.lines) + ', at 6 to 10 s per line. Length: all lines plus 10% for knots and winding. Skeins hold 8 m.</p>';
    sl.hidden = false;
  }

  // ---------- Focus on subject ----------
  // The subject mask comes from focus/focus.js (U^2-Net in the browser), loaded only when the option is on.
  // It is made from the crop as the frame shows it and kept until the photo or crop changes. The worker
  // turns it into weights: the background's error counts SA.FOCUS_BG times (core.js SA.importance).
  const FOCUS = { mask: null, sig: '' };
  const focusSig = () => [S.imgId, S.zoom.toFixed(4), S.cx.toFixed(2), S.cy.toFixed(2), frameAspect().toFixed(4)].join('|');
  const loadFocus = () => (window.SAFocus ? Promise.resolve() : new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'focus/focus.js'; sc.onload = res; sc.onerror = () => rej(new Error('focus')); document.head.appendChild(sc);
  }));
  async function ensureMask() {
    const sig = focusSig(); if (FOCUS.mask && FOCUS.sig === sig) return FOCUS.mask;
    await loadFocus();
    const N = SAFocus.SIZE, t0 = performance.now(), m = await SAFocus.mask(photoPixels(N, N));
    const c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d'), img = x.createImageData(N, N); let k = 0;
    for (let i = 0; i < N * N; i++) { const v = m[i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; if (v > 127) k++; }
    x.putImageData(img, 0, 0);
    FOCUS.mask = { canvas: c, share: k / (N * N), ms: performance.now() - t0 }; FOCUS.sig = sig;
    return FOCUS.mask;
  }
  // a subject is used only if it covers 3% to 97% of the frame; otherwise the whole photo counts as before
  const focusUsable = (fm) => fm && typeof fm === 'object' && fm.share > 0.03 && fm.share < 0.97;
  function maskPixels(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(FOCUS.mask.canvas, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4];
    return m;
  }
  // null when the option is off; 'error' when the model could not load
  const focusPrep = (on) => (on ? ensureMask().catch(() => 'error') : Promise.resolve(null));
  const focusNote = (fm) => (fm === 'error' ? ' The subject finder could not load, so the whole photo was used.' : fm && !focusUsable(fm) ? ' No clear subject was found, so the whole photo was used.' : '');
  $('focus').addEventListener('change', () => { if ($('focus').checked) loadFocus().then(() => SAFocus.load()).catch(() => {}); });

  // ---------- run ----------
  let raf = 0, timing = null;
  function setStatus(t) { $('status').textContent = t; }
  function setBar(f) { $('bar').style.width = (f * 100).toFixed(1) + '%'; }
  function setOutputsEnabled(on) { ['dl-png', 'dl-txt', 'print'].forEach((id) => ($(id).disabled = !on)); $('guide-note').hidden = on; }

  // All threads are placed together (core.js, SA.solveJoint): at each step the best next line of
  // any thread, from that thread's current nail, drawn on top of all earlier lines. Threads take
  // turns of at least 60 lines, so the thread changes stay few.
  const STRENGTH = 0.24;   // only used by the old single-thread render path; kept for scoreResult
  function start() {
    if (!S.img || S.running) return;
    if (S.worker) S.worker.terminate();
    cancelAnimationFrame(raf);
    const n = +$('nails').value, L = +$('lines').value, frameMM = Math.max(fw(), fh());
    const A = frameAspect(), lay = nailLayout(F.shape, n, A), [w, h] = SA.workSize(A, SA.auto.jointRes(frameMM)), c = cur();
    const mode = modeOf(c.threads.length), light = mode === 'one' && lightOnDark(c.threads[0], c.board);
    setOutputsEnabled(false); setBar(0); $('shoplist').hidden = true;
    if (!S.onFinish) $('auto-note').hidden = true;
    setStatus('Placing lines…');
    $('run').textContent = 'Making string art…'; $('run').disabled = true; $('auto').disabled = true;
    S.running = true;
    // examples always reproduce their stored result, so they never use Focus on subject
    const useFocus = $('focus').checked && !S.noFocus; S.noFocus = false;
    if (useFocus) setStatus('Finding the subject…');
    focusPrep(useFocus).then((fm) => setTimeout(() => {
      if (!S.running) return;
      if (useFocus) setStatus('Placing lines…');
      const d = photoPixels(w, h), [ew, eh] = SA.workSize(A, SA.auto.EVAL), ed = photoPixels(ew, eh);
      const wm = focusUsable(fm) ? maskPixels(w, h) : null;
      const R = S.result = { key: frameKey(), shape: F.shape, A, lay, frameMM, nails: n, lines: L, strength: STRENGTH, mode, light, board: c.board, boardKey: C.board, finished: false, focus: !!wm, focusNote: focusNote(fm),
        threads: c.threads.map((col, i) => ({ color: col, code: C.threads[i], order: null, count: 0 })), blocks: null, switches: 0 };
      resizeOut(); paintBoard(octx, out.width, out.height, R);
      timing = null;
      const NX = new Int32Array(n), NY = new Int32Array(n);
      for (let i = 0; i < n; i++) { NX[i] = Math.round((w - 1) / 2 + (lay.u[i] - 0.5) * (w - 2)); NY[i] = Math.round((h - 1) / 2 + (lay.v[i] - 0.5) * (h - 2)); }
      // streamed lines are drawn at the next animation frame (several batches at once if they come fast)
      const pend = [];
      const flushLines = () => { raf = 0; for (const sg of pend) drawRaw(octx, out.width, out.height, R, sg); pend.length = 0; };
      const wk = SAOffline.worker(); S.worker = wk;
      wk.onmessage = (e) => {
        const m = e.data;
        // sa8: the lines are drawn as the worker places them; there is no separate animation afterwards
        if (m.type === 'lines') {
          if ($('animate').checked) { pend.push(m.segs); if (!raf) raf = requestAnimationFrame(flushLines); }
          setStatus('Placing lines: ' + fmt(m.total) + ' of at most ' + fmt(L)); setBar(0.95 * m.total / L);
        } else if (m.type === 'progress') {
          // a second winding without the detail term (palette guard): the first stays visible meanwhile
          setStatus(m.phase === 'check' ? 'Checking a winding that uses every thread color…' : 'Placing lines: ' + fmt(m.total) + ' of at most ' + fmt(L));
        } else if (m.type === 'done') {
          timing = m; wk.terminate(); S.worker = null;
          // lines not drawn yet are skipped: the finished picture below covers them
          cancelAnimationFrame(raf); raf = 0; pend.length = 0;
          R.threads.forEach((t, i) => { t.order = Uint16Array.from(m.orders[i]); t.count = m.counts[i]; });
          R.blocks = m.blocks; R.switches = m.switches;
          finish();
        }
      };
      wk.onerror = () => { setStatus('The calculation stopped because of an error. Try fewer nails or lines.'); cancelAnimationFrame(raf); stop(); };
      wk.postMessage({ type: 'joint', w, h, nails: n, nx: NX, ny: NY, edge: lay.edge, skip: SA.skipFor(n), d: d.buffer, shape: F.shape,
        threads: c.threads, board: c.board, maxLines: L, frameMM, A, ed: ed.buffer, ew, eh,
        // the solver setting the search chose for these threads (sa7 palette guard); undefined = default
        detailW: S.detailFor === threadSig() ? S.detailW : undefined, tableMB: LOWMEM ? 64 : 256, wm: wm ? wm.buffer : undefined, bgW: wm ? SA.FOCUS_BG : undefined }, [d.buffer, ed.buffer].concat(wm ? [wm.buffer] : []));
      if (window.matchMedia('(max-width: 860px)').matches) $('h-res').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30));
  }
  function stop() { S.running = false; $('run').textContent = 'Make string art'; $('run').disabled = !S.img; $('auto').disabled = !S.img; }
  // threads under 3% of the lines are left out; their turns are removed and the others renumbered
  function dropSmall(R) {
    const tot = R.threads.reduce((p, t) => p + t.count, 0);
    const keep = R.threads.map((t) => R.threads.length === 1 || t.count >= SA.auto.MIN_SHARE * tot);
    const drop = R.threads.filter((_, i) => !keep[i]);
    if (!drop.length) return drop;
    const idx = []; let k = 0; keep.forEach((x, i) => { idx[i] = x ? k++ : -1; });
    R.threads = R.threads.filter((_, i) => keep[i]);
    const bl = [];
    R.blocks.filter((b) => keep[b[0]]).forEach((b) => { const t = idx[b[0]], p = bl[bl.length - 1]; if (p && p[0] === t && p[2] === b[1]) p[2] = b[2]; else bl.push([t, b[1], b[2]]); });
    R.blocks = bl; R.switches = Math.max(0, bl.length - 1);
    C.threads = C.threads.filter((c) => !drop.some((t) => t.code === c)); $('palette').value = 'custom'; renderThreads();
    return drop;
  }
  // sa8: the lines were drawn while they were solved (streamed); the finished picture is painted once here
  function finish() {
    const R = S.result, asked = R.lines, drop = dropSmall(R);
    paintAll(octx, out.width, out.height, R);
    R.finished = true; R.lines = R.threads.reduce((p, t) => p + t.count, 0);
    setBar(1); stop(); setOutputsEnabled(R.key === frameKey()); renderLegend();
    const multi = R.threads.length > 1;
    setStatus('Finished: ' + fmt(R.lines) + ' lines on ' + fmt(R.nails) + ' nails' + (multi ? ', ' + R.threads.length + ' threads in ' + fmt(R.blocks.length) + ' turns' : '') +
      '. Calculated in ' + (timing.totalMs / 1000).toFixed(1) + ' s.' +
      (timing.cut ? ' It stopped at ' + fmt(timing.cut.to) + ' of ' + fmt(timing.cut.from) + ' lines: more lines did not look closer to the photo from a distance.'
        : R.lines + drop.reduce((p, t) => p + t.count, 0) < asked ? ' It stopped before ' + fmt(asked) + ' lines: no further line brings the image closer to the photo.' : '') +
      (drop.length ? ' Removed ' + drop.map((t) => dmcLabel(t.code)).join(' and ') + ': under 3% of the lines.' : '') + (R.focusNote || ''));
    if (S.onFinish) { const f = S.onFinish; S.onFinish = null; f(R); }
    document.body.dataset.state = 'done';
  }
  $('run').addEventListener('click', () => { document.body.dataset.state = 'running'; start(); });

  // ---------- Find best settings ----------
  // The search plan and the choice are in core.js (SACore.auto); this part runs the tests in
  // several workers, shows progress, and writes the chosen settings into the controls.
  const AU = SA.auto;
  const PRESET_KEYS = ['black', 'bw', 'rgb', 'cmy'];
  const PRESETS = [{ board: 'white', threads: ['310'] }, { board: 'black', threads: ['B5200'] }]
    .concat(PRESET_KEYS.slice(1).map((k) => PALETTES[k]));
  const presetName = (p) => Object.keys(PALETTES).find((k) => PALETTES[k].board === p.board && PALETTES[k].threads.join() === p.threads.join());
  const viewSig = () => [S.imgId, S.zoom.toFixed(4), S.cx.toFixed(2), S.cy.toFixed(2), frameKey(), fw().toFixed(1), fh().toFixed(1)].join('|');
  function setRange(id, v) { const el = $(id); el.value = v; el.dispatchEvent(new Event('input')); }
  function autoUI(on) {
    $('auto').textContent = on ? 'Cancel search' : 'Find best settings';
    $('run').disabled = on || !S.img; $('auto-colors').disabled = on;
  }
  function autoEnd(msg) {
    const st = S.auto; if (!st) return;
    st.workers.forEach((h) => h.w.terminate()); st.workers = [];
    S.auto = null; S.running = false; autoUI(false); setBar(0);
    if (msg) setStatus(msg);
  }
  // With a `deadline` (a Date.now() time, 0 for none), a task is not started if it would likely
  // end after it (judged by the tasks done so far); a skipped task's result is null.
  function runTasks(st, pool, tasks, onDone, deadline) {
    return new Promise((resolve, reject) => {
      const out = new Array(tasks.length), pending = tasks.map((t, i) => ({ t, i }));
      let left = tasks.length, took = 0, done = 0;
      if (!left) { resolve(out); return; }
      const feed = (h) => {
        if (st.cancelled || !pending.length) return;
        if (deadline && Date.now() + (done ? 0.7 * took / done : 0) > deadline) { left -= pending.length; pending.length = 0; if (!left) resolve(out); return; }
        // prefer a test that reuses this worker's pixel lists
        let k = pending.findIndex((p) => p.t.key === h.cache); if (k < 0) k = 0;
        const p = pending.splice(k, 1)[0], t0 = Date.now();
        h.w.onmessage = (e) => {
          const m = e.data; if (m.type === 'ready') return;
          took += Date.now() - t0; done++;
          if (m.cache !== undefined) h.cache = m.cache;
          out[p.i] = m; left--;
          if (onDone) onDone(tasks.length - left, tasks.length);
          if (!left) resolve(out); else feed(h);
        };
        h.w.onerror = (e) => { e.preventDefault(); reject(new Error('worker')); };
        h.w.postMessage(p.t.msg);
      };
      pool.forEach(feed);
    });
  }
  async function autoStart() {
    if (!S.img || S.running) return;
    const t0 = performance.now(), A = frameAspect(), colors = $('auto-colors').checked;
    const st = S.auto = { cancelled: false, workers: [], sig: viewSig() };
    S.running = true; autoUI(true); setOutputsEnabled(false); $('auto-note').hidden = true; $('shoplist').hidden = true;
    document.body.dataset.state = 'searching';
    setStatus('Finding best settings…'); setBar(0);
    await new Promise((r) => setTimeout(r, 30));
    if (st.cancelled) return;
    // with Focus on subject, every test uses the subject mask too
    const fm = await focusPrep($('focus').checked);
    if (st.cancelled) return;
    const photos = [...new Set([AU.FIRST, AU.COARSE, AU.EVAL])].map((res) => { const [w, h] = SA.workSize(A, res); return Object.assign({ res, w, h, d: photoPixels(w, h).buffer }, focusUsable(fm) ? { m: maskPixels(w, h).buffer } : {}); });
    // fewer workers on devices with few cores
    const NW = AU.workers(navigator.hardwareConcurrency);
    for (let i = 0; i < NW; i++) st.workers.push({ w: SAOffline.worker(), cache: null });
    const init = (msg) => Promise.all(st.workers.map((h) => new Promise((res, rej) => {
      h.w.onmessage = (e) => { if (e.data.type === 'ready') res(e.data); };
      h.w.onerror = (e) => { e.preventDefault(); rej(new Error('worker')); };
      h.w.postMessage(msg);
    }))).then((r) => r[0]);
    const run = (msgs, label, a, b, deadline) => runTasks(st, st.workers, msgs.map((m) => ({ key: m.job ? m.job.n + '|' + m.job.res : null, msg: m })), (d, n) => {
      setBar(a + (b - a) * d / n); setStatus('Finding best settings · ' + label + ' · test ' + d + ' of ' + n);
    }, deadline);
    try {
      // without colors, the search uses black thread on a white board
      const cur = colors ? { board: C.board, threads: C.threads.slice() } : { board: 'white', threads: ['310'] };
      const r = await AU.search({ shape: F.shape, A, frameMM: [fw(), fh()], photos, dmc: [...DMC.values()].map((d) => [d.code, d.name, d.hex]), boards: BOARDS,
        presets: PRESETS, current: cur, colors, init, run, now: () => performance.now(), nailCap: nailCap() });
      if (st.cancelled) return;
      const secs = (performance.now() - t0) / 1000, changed = st.sig !== viewSig(), p = r.settings;
      autoEnd();
      if (changed) { setStatus('The photo or frame changed during the search. Select Find best settings again.'); return; }
      setRange('nails', p.nails); setRange('lines', p.lines);
      C.threads = p.threads.slice(); C.board = p.board;
      S.detailW = p.detailW; S.detailFor = threadSig();
      $('palette').value = presetName({ board: p.board, threads: p.threads }) || 'custom'; renderThreads();
      const sp = r.spacingMM;
      const note = 'Find best settings tested ' + fmt(r.tested) + ' combinations in ' + secs.toFixed(1) + ' s and chose ' + fmt(p.nails) + ' nails (' +
        (F.unit === 'in' ? (sp / 25.4).toFixed(2) + ' in' : sp.toFixed(1) + ' mm') + ' apart), at most ' + fmt(p.lines) + ' lines, and ' +
        p.threads.map((c) => dmcLabel(c)).join(', ') + ' on a ' + BOARDS[p.board].name.toLowerCase() + ' board. You can change any setting and select Make string art again.';
      window.__stringArt.lastAuto = { secs, tested: r.tested, workers: NW, stages: r.stages, pick: Object.assign({ score: r.pick.score, de: r.pick.de, dab: r.pick.dab, detail: r.pick.detail }, p), chroma: r.chroma, palettes: r.palettes, bestScore: r.bestScore, first: r.first };
      S.onFinish = () => { $('auto-note').textContent = note; $('auto-note').hidden = false; };
      document.body.dataset.state = 'running';
      start();
    } catch (e) {
      if (!st.cancelled) autoEnd('The search stopped because of an error. Try a smaller photo or fewer browser tabs.');
    }
  }
  $('auto').addEventListener('click', () => {
    if (S.auto) { S.auto.cancelled = true; autoEnd('Search cancelled. The settings were not changed.'); document.body.dataset.state = 'cancelled'; return; }
    autoStart();
  });

  // ---------- downloads ----------
  function save(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const baseName = () => { const R = S.result; return 'string-art-' + R.shape + '-' + R.nails + '-nails-' + R.lines + '-lines-dmc-' + R.threads.map((t) => t.code.toLowerCase()).join('-'); };
  // The PNG is drawn at its own size, not scaled up: each line at the real thread width.
  // Phones and devices with little memory get at most 1,600 px.
  const pngMax = () => ((navigator.deviceMemory && navigator.deviceMemory <= 4) || window.matchMedia('(pointer: coarse)').matches ? 1600 : 2400);
  function renderPNG(max) {
    const R = S.result, [w, h] = fitSize(R.A, max), c = document.createElement('canvas'); c.width = w; c.height = h;
    paintAll(c.getContext('2d'), w, h, R);
    return c;
  }
  const NUMBERING = 'Nail 0 is at the middle of the right side; the numbers increase counter-clockwise.';
  // turns in winding order: [thread, first line, end line, step number of the first line]
  function turns(R) { let k = 1; return R.blocks.map((b) => { const r = [b[0], b[1], b[2], k]; k += b[2] - b[1]; return r; }); }
  function nailOrderText() {
    const R = S.result, multi = R.threads.length > 1, m = threadMeters(R), T = turns(R);
    const head = ['# String art nail order',
      '# Frame: ' + frameText() + '. Board: ' + BOARDS[R.boardKey].name.toLowerCase() + '.',
      '# ' + R.nails + ' nails, numbered 0 to ' + (R.nails - 1) + '. ' + NUMBERING,
      '# Thread: DMC six-strand embroidery floss, ' + meters(m.reduce((a, b) => a + b, 0)) + ' in all. Skeins hold 8 m. Lengths include 10% for knots and winding.',
      '# Winding: ' + windTime(R.lines) + ', at 6 to 10 s per line.'];
    R.threads.forEach((t, i) => head.push('#   ' + (multi ? (i + 1) + '. ' : '') + dmcLabel(t.code) + ': ' + fmt(t.count) + ' lines, ' + meters(m[i]) + ', ' + skeins(m[i])));
    if (multi) {
      head.push('# ' + fmt(R.lines) + ' steps in ' + T.length + ' turns (' + R.switches + ' thread changes). Wind the steps in order; each line lies on top of the earlier ones.',
        '# Tie each thread to its first nail when its first turn starts. Between turns, leave it hooked at its last nail and continue from there.',
        '# Each row: step, thread, from nail, to nail.');
    } else head.push('# One nail number per row, in winding order, starting with the first nail.');
    let s = head.join('\n') + '\n';
    if (!multi) return s + Array.from(R.threads[0].order.subarray(0, R.threads[0].count + 1)).join('\n') + '\n';
    T.forEach(([t, a, b, k0], i) => {
      const th = R.threads[t], o = th.order;
      s += '\n# Turn ' + (i + 1) + ' of ' + T.length + ': ' + (t + 1) + '. ' + dmcLabel(th.code) + ', steps ' + k0 + ' to ' + (k0 + b - a - 1) + (a ? ', from nail ' + o[a] : ', tie on at nail ' + o[0]) + '\n';
      for (let k = a; k < b; k++) s += 'Step ' + (k0 + k - a) + ': ' + dmcLabel(th.code) + ', nail ' + o[k] + ' to ' + o[k + 1] + '\n';
    });
    return s;
  }
  $('dl-png').addEventListener('click', () => renderPNG(pngMax()).toBlob((b) => save(b, baseName() + '.png'), 'image/png'));
  $('dl-txt').addEventListener('click', () => save(new Blob([nailOrderText()], { type: 'text/plain' }), baseName() + '-nail-order.txt'));

  // ---------- build guide ----------
  const PAPER = { letter: { w: 215.9, h: 279.4, css: 'letter' }, a4: { w: 210, h: 297, css: 'A4' } };
  const MARGIN = 10, BAND = 14;

  // SVG group of the nail template in millimetres: frame outline, centre mark, numbered nails.
  function templateGroup(W, H, R, labelEvery, fsMin) {
    const lay = R.lay, n = lay.u.length, Tw = W + 2 * BAND, Th = H + 2 * BAND, sp = lay.P * H / n;
    // fsMin (sa8): label size at least this (the reduced template of a large frame needs larger labels)
    const fs = labelEvery > 1 ? Math.min(Math.max(4.5, fsMin || 0), sp * labelEvery * 0.5) : Math.min(3.2, Math.max(1.4, sp * 0.72));
    const X = (i) => BAND + lay.u[i] * W, Y = (i) => BAND + lay.v[i] * H, cx = Tw / 2, cy = Th / 2;
    let s = '<g font-family="Inter,Helvetica,Arial,sans-serif" fill="#000">';
    s += R.shape === 'circle' || R.shape === 'ellipse'
      ? '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + W / 2 + '" ry="' + H / 2 + '" fill="none" stroke="#bbb" stroke-width="0.2"/>'
      : '<rect x="' + BAND + '" y="' + BAND + '" width="' + W + '" height="' + H + '" fill="none" stroke="#bbb" stroke-width="0.2"/>';
    s += '<path d="M' + (cx - 4) + ' ' + cy + 'h8M' + cx + ' ' + (cy - 4) + 'v8" stroke="#000" stroke-width="0.25"/>';
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = X(i), y = Y(i), t = lay.dir[i], co = Math.cos(t), si = Math.sin(t);
      pts.push([x, y]);
      s += '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="0.55"/>';
      if (i % labelEvery) continue;
      const lx = x + 1.6 * co, ly = y - 1.6 * si, deg = -t * 180 / Math.PI;
      const left = co < -1e-9, rot = left ? deg + 180 : deg;
      s += '<text x="' + lx.toFixed(2) + '" y="' + ly.toFixed(2) + '" font-size="' + fs.toFixed(2) + '" dominant-baseline="central"' +
        (left ? ' text-anchor="end"' : '') + (i % 10 === 0 ? ' font-weight="700"' : '') +
        ' transform="rotate(' + rot.toFixed(2) + ' ' + lx.toFixed(2) + ' ' + ly.toFixed(2) + ')">' + i + '</text>';
    }
    return { g: s + '</g>', w: Tw, h: Th, cx, cy, pts, sp };
  }
  function scaleBar(unit) {
    const mm = '<svg class="scale" xmlns="http://www.w3.org/2000/svg" width="106mm" height="7mm" viewBox="-3 -3 106 7" font-family="Inter,Helvetica,Arial,sans-serif" font-size="2.6">' +
      '<path d="M0 0h100M0 -1.8v1.8M50 -1.2v1.2M100 -1.8v1.8" stroke="#000" stroke-width="0.3" fill="none"/>' +
      '<text x="0" y="3">0</text><text x="100" y="3" text-anchor="end">100 mm: check with a ruler</text></svg>';
    if (unit !== 'in') return mm;
    return mm + '<svg class="scale" xmlns="http://www.w3.org/2000/svg" width="108mm" height="7mm" viewBox="-3 -3 108 7" font-family="Inter,Helvetica,Arial,sans-serif" font-size="2.6">' +
      '<path d="M0 0h101.6M0 -1.8v1.8M25.4 -1.2v1.2M50.8 -1.2v1.2M76.2 -1.2v1.2M101.6 -1.8v1.8" stroke="#000" stroke-width="0.3" fill="none"/>' +
      '<text x="0" y="3">0</text><text x="101.6" y="3" text-anchor="end">4 in: check with a ruler</text></svg>';
  }
  function buildGuide() {
    const R = S.result, W = fw(), H = fh(), paper = PAPER[$('paper').value], mode = $('mode').value, n = R.nails, L = R.lines;
    const cw = paper.w - 2 * MARGIN, ch = paper.h - 2 * MARGIN, multi = R.threads.length > 1;
    const pages = [], tplPages = [];
    if (mode === 'tiled') {
      const T = templateGroup(W, H, R, 1), tw = Math.floor(cw) - 1, th = Math.floor(ch) - (F.unit === 'in' ? 26 : 18);
      const cols = Math.ceil(T.w / tw), rows = Math.ceil(T.h / th);
      const ox = (cols * tw - T.w) / 2, oy = (rows * th - T.h) / 2;
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const x = q * tw - ox, y = r * th - oy;
        // keep tiles that hold a nail or its number, or the centre mark
        const hasCentre = T.cx >= x && T.cx <= x + tw && T.cy >= y && T.cy <= y + th;
        const hasNail = T.pts.some(([px, py]) => px >= x - BAND && px <= x + tw + BAND && py >= y - BAND && py <= y + th + BAND);
        if (!hasCentre && !hasNail) continue;
        tplPages.push('<p class="tlabel">Template · row ' + (r + 1) + ' of ' + rows + ', column ' + (q + 1) + ' of ' + cols + '</p>' +
          '<div class="tile"><svg xmlns="http://www.w3.org/2000/svg" width="' + tw + 'mm" height="' + th + 'mm" viewBox="' + x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + tw + ' ' + th + '">' +
          '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + tw + '" height="' + th + '" fill="none" stroke="#000" stroke-width="0.3"/>' +
          T.g + '</svg></div>' + scaleBar(F.unit));
      }
    } else {
      const T0 = templateGroup(W, H, R, 1), k = Math.min(cw / T0.w, (ch - 30) / T0.h);
      // sa8: printed labels at least 1.8 mm: every 5th, 10th, 20th or 50th nail numbered as the reduction needs
      const need = 1.8 / k, every = Math.min(3.2, Math.max(1.4, T0.sp * 0.72)) * k >= 1.8 ? 1 : [5, 10, 20, 50].find((e) => T0.sp * e * 0.5 >= need) || 50;
      const T = every === 1 ? T0 : templateGroup(W, H, R, every, need);
      tplPages.push('<p class="tlabel">Template · reduced to fit the page, not to scale' + (every > 1 ? ' · every ' + every + 'th nail numbered' : '') + '</p>' +
        '<div class="tile"><svg xmlns="http://www.w3.org/2000/svg" width="' + (T.w * k).toFixed(1) + 'mm" height="' + (T.h * k).toFixed(1) + 'mm" viewBox="0 0 ' + T.w + ' ' + T.h + '">' + T.g + '</svg></div>');
    }
    // cover page
    const spacing = R.lay.P * H / n, img = renderPNG(1200).toDataURL('image/png');
    const iw = R.A >= 1 ? 80 : 80 * R.A, ih = R.A >= 1 ? 80 / R.A : 80;
    const steps = mode === 'tiled'
      ? ['Print this guide at 100% scale. In the print dialog, choose “Actual size” or a scale of 100%. Check the scale bar on each template page with a ruler.',
         'Trim each template page along its border. Tape the pages together edge to edge, in the order given by the row and column labels.']
      : ['The template on the next page is reduced to fit the paper. Use it to see the nail numbering. For a full-size template, choose “Full size, tiled”.'];
    steps.push('Fix the template to the board. Put a nail at each dot. ' + NUMBERING.replace(';', ', and'));
    if (multi) steps.push('Wind the steps in order, keeping the thread taut. The threads take turns (' + fmt(R.blocks.length) + ' turns, ' + fmt(R.switches) + ' thread changes). At the start of a thread’s first turn, tie it to the nail given. Between turns, leave it hooked at its last nail; its next turn starts there. Each line lies on top of the earlier ones.', 'Tie off each thread after its last step.');
    else steps.push('Tie the thread to nail ' + R.threads[0].order[0] + '. Wind it to each nail in the winding sequence, in order, keeping the thread taut.', 'Tie off the thread at the last nail.');
    const sw = (c) => '<span class="gsw" style="background:' + c + '"></span>', tm = threadMeters(R);
    const threadRows = '<dt>' + (multi ? 'Threads' : 'Thread') + '</dt><dd>' + R.threads.map((t, i) => sw(t.color) + (multi ? (i + 1) + '. ' : '') + dmcLabel(t.code) + ', ' + fmt(t.count) + ' lines').join('<br>') + '</dd>';
    const shop = '<dt>Shopping list</dt><dd>' + R.threads.map((t, i) => dmcLabel(t.code) + ': ' + meters(tm[i]) + ', ' + skeins(tm[i]) + ' of six-strand floss').join('<br>') +
      (multi ? '<br>Thread in all: ' + meters(tm.reduce((a, b) => a + b, 0)) : '') +
      '<br><span class="gnote">Line lengths at this frame size plus 10% for knots and winding.</span></dd>';
    pages.push('<div class="gpage ghead"><h1>String art build guide</h1><dl>' +
      '<dt>Frame</dt><dd>' + frameText() + '</dd><dt>Nails</dt><dd>' + fmt(n) + '</dd><dt>Nail spacing</dt><dd>' +
      (F.unit === 'in' ? (spacing / 25.4).toFixed(2) + ' in' : spacing.toFixed(1) + ' mm') + ' along the edge</dd>' +
      '<dt>Lines</dt><dd>' + fmt(L) + '</dd><dt>Winding time</dt><dd>' + windTime(L) + ', at 6 to 10 s per line</dd>' + threadRows + '<dt>Board</dt><dd>' + sw(R.board) + BOARDS[R.boardKey].name + '</dd>' + shop +
      '<dt>Template</dt><dd>' + (mode === 'tiled' ? 'Full size, ' + tplPages.length + ' pages' : 'Reduced to fit one page') + '</dd></dl>' +
      '<ol>' + steps.map((t) => '<li>' + t + '</li>').join('') + '</ol>' +
      '<img src="' + img + '" alt="" style="width:' + iw.toFixed(1) + 'mm;height:' + ih.toFixed(1) + 'mm;display:block;margin-top:4mm"></div>');
    tplPages.forEach((t) => pages.push('<div class="gpage">' + t + '</div>'));
    // winding sequence: one list in winding order; with several threads a header marks each turn
    const COLS = 8, ROWS = Math.floor((ch - 24) / 3.73), per = COLS * ROWS, cells = [];
    if (!multi) { const t = R.threads[0]; for (let k = 1; k <= t.count; k++) cells.push('<div' + (k % 100 === 1 && k > 1 ? ' class="hund"' : '') + '><span class="s">' + k + '</span><span class="n">' + t.order[k] + '</span></div>'); }
    else turns(R).forEach(([t, a, b, k0]) => {
      const th = R.threads[t];
      cells.push('<div class="turn">' + sw(th.color) + 'DMC ' + th.code + '</div>', '<div><span class="s">' + (a ? 'from' : 'tie on') + '</span><span class="n">' + th.order[a] + '</span></div>');
      for (let k = a + 1; k <= b; k++) cells.push('<div><span class="s">' + (k0 + k - a - 1) + '</span><span class="n">' + th.order[k] + '</span></div>');
    });
    for (let p = 0; p * per < cells.length; p++)
      pages.push('<div class="gpage seq"><h2>Winding sequence' + (p ? ' (continued)' : '') + '</h2>' +
        (p ? '' : '<p style="margin:0 0 3mm">' + (multi ? 'Each row gives the step number and the nail to wind to. A header with the thread color starts each turn; “from” is the nail where that thread was left.'
          : 'Start at nail ' + R.threads[0].order[0] + '. Each row gives the step number and the nail to wind to. A line marks every 100 steps.') + '</p>') +
        '<div class="cols" style="column-count:' + COLS + '">' + cells.slice(p * per, (p + 1) * per).join('') + '</div></div>');
    $('guide').innerHTML = pages.join('');
    let st = $('page-style');
    if (!st) { st = document.createElement('style'); st.id = 'page-style'; document.head.appendChild(st); }
    st.textContent = '@page{size:' + paper.css + ';margin:' + MARGIN + 'mm}';
    return pages.length;
  }
  $('print').addEventListener('click', () => { buildGuide(); window.print(); });


  // ---------- paste ----------
  // Ctrl+V or Cmd+V anywhere on the page (not in a text field), the Paste image button, or a long press on
  // the empty photo area (#crop-empty is editable so phones offer Paste there; typing into it is blocked).
  const URL_MSG = 'That site blocks loading its images here. Save the image, then upload it.';
  async function loadURL(u) {
    setStatus('Opening photo…');
    let r;
    try { r = await fetch(u, { mode: 'cors', credentials: 'omit' }); } catch (e) { setStatus(URL_MSG); return; }
    if (!r.ok) { setStatus('The image at that address could not be loaded.'); return; }
    const b = await r.blob();
    if (b.type && !/^image\//.test(b.type)) { setStatus('That address is not an image. Copy the image itself, or save it and upload it.'); return; }
    loadBlob(b, false, u.split('?')[0]);
  }
  const textTarget = (el) => el && el.id !== 'crop-empty' && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener('paste', (e) => {
    if (textTarget(e.target) || S.running) return;
    const cd = e.clipboardData; if (!cd) return;
    const item = [...(cd.items || [])].find((it) => it.kind === 'file' && /^image\//.test(it.type));
    const file = item ? item.getAsFile() : [...(cd.files || [])].find((f) => /^image\//.test(f.type));
    if (file) { e.preventDefault(); loadBlob(file, false, file.name || 'pasted.png'); return; }
    const t = (cd.getData('text/plain') || '').trim();
    if (/^https?:\/\/\S+$/i.test(t)) { e.preventDefault(); loadURL(t); return; }
    if (e.target && e.target.id === 'crop-empty') { e.preventDefault(); setStatus('The clipboard has no image. Copy an image first.'); }
  });
  const pasteZone = $('crop-empty');
  pasteZone.addEventListener('beforeinput', (e) => e.preventDefault());
  pasteZone.addEventListener('drop', (e) => e.preventDefault());
  const pasteBtn = $('paste');
  if (navigator.clipboard && navigator.clipboard.read && window.ClipboardItem) {
    pasteBtn.hidden = false;
    pasteBtn.addEventListener('click', async () => {
      if (S.running) return;
      let items;
      try { items = await navigator.clipboard.read(); } catch (e) {
        setStatus('The browser did not allow reading the clipboard. Press Ctrl+V, or Cmd+V on a Mac, to paste instead.'); return;
      }
      for (const it of items) {
        const type = it.types.find((t) => /^image\//.test(t));
        if (type) { loadBlob(await it.getType(type), false, 'pasted.' + type.split('/')[1]); return; }
      }
      for (const it of items) {
        if (it.types.includes('text/plain')) {
          const t = (await (await it.getType('text/plain')).text()).trim();
          if (/^https?:\/\/\S+$/i.test(t)) { loadURL(t); return; }
        }
      }
      setStatus('The clipboard has no image. Copy an image first.');
    });
  }

  // ---------- examples ----------
  // Each example is examples/<id>.json (embedded in offline.js): the photo file, its crop (zoom, centre as a share of the photo)
  // and every setting used for the gallery picture. Try this one ([data-example] buttons) loads them and
  // makes the string art; the result is the gallery picture (the solver is deterministic).
  async function tryExample(id) {
    if (S.running || S.auto) return;
    setStatus('Opening example…');
    let x, blob;
    try {
      ({ x, blob } = await SAOffline.example(id));
    } catch (e) { setStatus('The example could not be loaded.'); return; }
    const fr = x.frame;
    F.unit = 'cm'; $('unit').value = 'cm';
    F.shape = fr.shape; radios('shape').forEach((r) => { r.checked = r.value === fr.shape; });
    if (fr.aspect) F.aspect[fr.shape] = fr.aspect;
    F.size[fr.shape] = [fr.w, fr.h];
    syncFrameInputs(); frameChanged();
    C.threads = x.threads.slice(); C.board = x.board;
    $('palette').value = presetName({ board: x.board, threads: x.threads }) || 'custom'; renderThreads();
    S.detailW = x.detailW; S.detailFor = threadSig();
    const id0 = S.imgId;
    await loadBlob(blob, false, x.photo);
    if (S.imgId === id0) return;
    $('credit').textContent = 'Example photo: ' + x.credit + '.'; $('credit').hidden = false;
    setZoom(x.crop.zoom); S.cx = x.crop.cx * S.img.width; S.cy = x.crop.cy * S.img.height; drawCrop();
    setRange('nails', x.nails); setRange('lines', x.lines);
    S.onFinish = null; document.body.dataset.state = 'running';
    S.noFocus = true; start();
  }
  document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); tryExample(b.dataset.example);
    const t = $('h-photo'); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // the result canvas follows the size it is shown at (a window resize or rotation), drawn sharp again
  if (window.ResizeObserver) {
    let rt = 0, lastW = out.clientWidth;
    new ResizeObserver(() => {
      if (out.clientWidth === lastW) return; lastW = out.clientWidth;
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (S.running) return;   // a running result is painted in full when it finishes
        if (S.result && S.result.finished) { resizeOut(); redrawResult(); } else if (!S.result) resizeOut(true);
      }, 150);
    }).observe($('stage'));
  }

  // ---------- init ----------
  renderThreads(); syncFrameInputs(); frameChanged();
  // match score of the current result (see core.js), for testing
  function scoreResult() {
    const R = S.result; if (!R || !R.finished) return null;
    return SA.scoreResult({ photo: photoPixels, shape: R.shape, A: R.A, lay: R.lay, orders: R.threads.map((t) => t.order), counts: R.threads.map((t) => t.count),
      threads: R.threads.map((t) => t.color), board: R.board, strength: R.strength, frameMM: R.frameMM, blocks: R.blocks });
  }
  // for the examples build and tests: the finished picture at a given size and its caption facts
  function resultInfo() {
    const R = S.result; if (!R || !R.finished) return null;
    return { nails: R.nails, lines: R.lines, threads: R.threads.map((t) => t.code), board: R.boardKey, meters: threadMeters(R).reduce((a, b) => a + b, 0), shape: R.shape, frameMM: [fw(), fh()],
      hash: R.threads.map((t) => Array.from(t.order.subarray(0, t.count + 1)).join(',')).join('|') };
  }
  window.__stringArt = { focus: FOCUS, buildGuide, nailOrderText, nailLayout, state: S, frame: F, colors: C, dmc: DMC, nearestDMC, core: SA, scoreResult, renderPNG, resultInfo };
})();
