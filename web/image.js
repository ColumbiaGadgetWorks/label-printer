/* Image label - crop an image, convert it to 1-bit at the printer's own dot
   grid, and print it as ZPL.

   Why the dot grid matters: a Zebra prints every dot either black or white.
   Hand it anything else (greyscale, or a picture at some other resolution)
   and a driver has to resample and halftone it, which is what turns crisp
   barcode bars into speckled, uneven ones. Here the image is snapped to
   exactly one pixel per print-head dot and thresholded in the browser, and
   the preview shows those same dots, so what you see is what prints. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var KEY = 'labelprinter.image.v1';
  var TOKKEY = 'labelprinter.token';
  var DEF = {
    size: '4x6', cw: 4, ch: 6, rot: 0,
    fit: 'integer', pct: 100, smooth: true,
    bw: 'threshold', thr: 128, invert: false,
    margin: '0.05', align: 'center', copies: 1,
    dark: '', speed: '', dpi: 203, zoom: 'fit'
  };
  var S = Object.assign({}, DEF);
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) S = Object.assign({}, DEF, JSON.parse(raw));
  } catch (e) { /* private mode / blocked storage */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  var CAP = { configured: false, directPrint: false, dpi: 0, tokenRequired: false, maxWidthDots: 0 };

  var src = null;              // canvas holding the original image, composited on white
  var crop = null;             // {x, y, w, h} in source pixels
  var result = null;           // {w, h, bits: Uint8Array(w*h) 1 = black, k}

  /* ---------- label geometry ---------- */
  function dpi() { return CAP.dpi || +S.dpi || 203; }

  function labelInches() {
    if (S.size === 'custom') return { w: +S.cw || 4, h: +S.ch || 6 };
    var p = S.size.split('x');
    return { w: +p[0], h: +p[1] };
  }

  function labelDots() {
    var inch = labelInches(), d = dpi();
    var w = Math.round(inch.w * d), h = Math.round(inch.h * d);
    var maxW = CAP.maxWidthDots || Math.floor(4.1 * d);
    return { w: Math.max(8, Math.min(w, maxW)), h: Math.max(8, h), clipped: w > maxW };
  }

  /* ---------- loading ---------- */
  function load(blob) {
    if (!blob || !/^image\//.test(blob.type)) { setStatus('That is not an image.', 'err'); return; }
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // transparency prints as white
      g.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      src = c;
      crop = { x: 0, y: 0, w: c.width, h: c.height };
      $('#srcInfo').textContent = c.width + ' × ' + c.height + ' px';
      $('#cropGroup').hidden = false;
      setStatus('', '');
      drawCrop(); render();
    };
    img.onerror = function () { URL.revokeObjectURL(url); setStatus('Could not read that image.', 'err'); };
    img.src = url;
  }

  $('#file').addEventListener('change', function () { if (this.files[0]) load(this.files[0]); this.value = ''; });

  var drop = $('#drop');
  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) load(f);
  });
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        e.preventDefault(); load(items[i].getAsFile()); return;
      }
    }
  });

  /* ---------- crop UI ---------- */
  var view = $('#cropView'), vg = view.getContext('2d');
  var vk = 1;                  // view px per source px
  var HANDLE = 14;             // css px grab distance

  function drawCrop() {
    if (!src) return;
    var wrap = view.parentElement;
    var maxW = wrap.clientWidth || 600;
    var maxH = Math.max(220, window.innerHeight * 0.45);
    vk = Math.min(maxW / src.width, maxH / src.height);
    var ratio = window.devicePixelRatio || 1;
    var cw = Math.max(1, Math.round(src.width * vk)), ch = Math.max(1, Math.round(src.height * vk));
    view.style.width = cw + 'px'; view.style.height = ch + 'px';
    view.width = Math.round(cw * ratio); view.height = Math.round(ch * ratio);
    vg.setTransform(ratio, 0, 0, ratio, 0, 0);
    vg.imageSmoothingEnabled = vk < 1;
    vg.drawImage(src, 0, 0, cw, ch);

    var r = { x: crop.x * vk, y: crop.y * vk, w: crop.w * vk, h: crop.h * vk };
    vg.fillStyle = 'rgba(0,0,0,.45)';
    vg.fillRect(0, 0, cw, r.y);
    vg.fillRect(0, r.y + r.h, cw, ch - r.y - r.h);
    vg.fillRect(0, r.y, r.x, r.h);
    vg.fillRect(r.x + r.w, r.y, cw - r.x - r.w, r.h);
    vg.strokeStyle = '#2563eb'; vg.lineWidth = 2;
    vg.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
    vg.fillStyle = '#2563eb';
    [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].forEach(function (p) {
      vg.fillRect(p[0] - 5, p[1] - 5, 10, 10);
    });
  }

  function viewPoint(e) {
    var b = view.getBoundingClientRect();
    return { x: (e.clientX - b.left) / vk, y: (e.clientY - b.top) / vk };
  }

  function clampCrop(c) {
    var x0 = Math.max(0, Math.min(c.x, c.x + c.w)), x1 = Math.min(src.width, Math.max(c.x, c.x + c.w));
    var y0 = Math.max(0, Math.min(c.y, c.y + c.h)), y1 = Math.min(src.height, Math.max(c.y, c.y + c.h));
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  var drag = null;
  view.addEventListener('pointerdown', function (e) {
    if (!src) return;
    var p = viewPoint(e), t = HANDLE / vk;
    var c = crop;
    var nearL = Math.abs(p.x - c.x) < t, nearR = Math.abs(p.x - (c.x + c.w)) < t;
    var nearT = Math.abs(p.y - c.y) < t, nearB = Math.abs(p.y - (c.y + c.h)) < t;
    var inX = p.x > c.x - t && p.x < c.x + c.w + t, inY = p.y > c.y - t && p.y < c.y + c.h + t;
    var edges = {
      l: nearL && inY, r: nearR && inY && !nearL,
      t: nearT && inX, b: nearB && inX && !nearT
    };
    if (edges.l || edges.r || edges.t || edges.b) {
      drag = { kind: 'edge', edges: edges, start: p, orig: Object.assign({}, c) };
    } else if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h &&
               (c.w < src.width || c.h < src.height)) {
      drag = { kind: 'move', start: p, orig: Object.assign({}, c) };
    } else {
      drag = { kind: 'new', start: p };
    }
    view.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  view.addEventListener('pointermove', function (e) {
    if (!src) return;
    var p = viewPoint(e);
    if (!drag) {
      var c = crop, t = HANDLE / vk;
      var h = Math.abs(p.x - c.x) < t || Math.abs(p.x - (c.x + c.w)) < t;
      var v = Math.abs(p.y - c.y) < t || Math.abs(p.y - (c.y + c.h)) < t;
      var inside = p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h &&
                   (c.w < src.width || c.h < src.height);
      view.style.cursor = h && v ? 'nwse-resize' : h ? 'ew-resize' : v ? 'ns-resize' : inside ? 'move' : 'crosshair';
      return;
    }
    var dx = p.x - drag.start.x, dy = p.y - drag.start.y, o = drag.orig, n;
    if (drag.kind === 'new') {
      n = { x: drag.start.x, y: drag.start.y, w: dx, h: dy };
    } else if (drag.kind === 'move') {
      n = {
        x: Math.max(0, Math.min(src.width - o.w, o.x + dx)),
        y: Math.max(0, Math.min(src.height - o.h, o.y + dy)), w: o.w, h: o.h
      };
    } else {
      var x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (drag.edges.l) x0 += dx;
      if (drag.edges.r) x1 += dx;
      if (drag.edges.t) y0 += dy;
      if (drag.edges.b) y1 += dy;
      n = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    crop = clampCrop(n);
    drawCrop();
    renderSoon();
  });

  function endDrag() {
    if (!drag) return;
    if (drag.kind === 'new' && (crop.w < 3 || crop.h < 3)) crop = { x: 0, y: 0, w: src.width, h: src.height };
    drag = null;
    drawCrop(); render();
  }
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);

  $('#resetCrop').addEventListener('click', function () {
    if (!src) return;
    crop = { x: 0, y: 0, w: src.width, h: src.height };
    drawCrop(); render();
  });

  /* Shrink the crop to the bounding box of everything darker than the
     threshold. Screenshots nearly always carry white borders and UI chrome. */
  $('#trim').addEventListener('click', function () {
    if (!src) return;
    var d = src.getContext('2d').getImageData(crop.x, crop.y, crop.w, crop.h).data;
    var x0 = crop.w, y0 = crop.h, x1 = -1, y1 = -1, thr = S.thr;
    for (var y = 0; y < crop.h; y++) {
      for (var x = 0; x < crop.w; x++) {
        var i = (y * crop.w + x) * 4;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thr) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) { setStatus('Nothing dark enough to trim to.', 'err'); return; }
    crop = clampCrop({ x: crop.x + x0, y: crop.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    drawCrop(); render();
  });

  /* ---------- pipeline: crop -> rotate -> scale onto dot grid -> 1-bit ---------- */
  function rotated() {
    var c = document.createElement('canvas');
    var q = ((S.rot % 360) + 360) % 360;
    var swap = q === 90 || q === 270;
    c.width = swap ? crop.h : crop.w;
    c.height = swap ? crop.w : crop.h;
    var g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2);
    g.rotate(q * Math.PI / 180);
    g.drawImage(src, crop.x, crop.y, crop.w, crop.h, -crop.w / 2, -crop.h / 2, crop.w, crop.h);
    return c;
  }

  function chooseScale(rw, rh, aw, ah) {
    var fit = Math.min(aw / rw, ah / rh);
    if (S.fit === 'custom') return { k: S.pct / 100, exact: false };
    if (S.fit === 'fit') return { k: fit, exact: false };
    // integer: whole multiples up, whole fractions down
    if (fit >= 1) return { k: Math.floor(fit), exact: true };
    return { k: 1 / Math.ceil(1 / fit), exact: false };
  }

  function render() {
    save();
    var L = labelDots();
    var out = $('#out');
    out.width = L.w; out.height = L.h;
    var g = out.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, L.w, L.h);
    $('#pageSize').textContent = '@page{size:' + (L.w / dpi()) + 'in ' + (L.h / dpi()) + 'in;margin:0}';

    var warn = [];
    if (L.clipped) warn.push('Label is wider than the print head; clipped to ' + L.w + ' dots.');

    if (!src) {
      result = null;
      $('#empty').hidden = false;
      $('#cap').textContent = L.w + ' × ' + L.h + ' dots at ' + dpi() + ' dpi';
      showWarn(warn); fitPreview(); syncButtons();
      return;
    }
    $('#empty').hidden = true;

    var r = rotated();
    var m = Math.round((+S.margin || 0) * dpi());
    var aw = Math.max(1, L.w - 2 * m), ah = Math.max(1, L.h - 2 * m);
    var sc = chooseScale(r.width, r.height, aw, ah);
    var dw = Math.max(1, Math.round(r.width * sc.k)), dh = Math.max(1, Math.round(r.height * sc.k));
    var ox = S.align === 'topleft' ? m : Math.round((L.w - dw) / 2);
    var oy = S.align === 'center' ? Math.round((L.h - dh) / 2) : m;

    // A whole-number scale makes every source pixel exactly k dots, so bars
    // keep their width ratios. Smoothing then thresholding is identical to
    // nearest-neighbour on a clean screenshot, but on one taken at 125% / 150%
    // display scaling (grey, anti-aliased bar edges) it puts each edge where
    // the grey says it was instead of snapping it a whole source pixel.
    // Downscaling has to average or it drops whole bars, so it always smooths.
    g.imageSmoothingEnabled = sc.k < 1 || S.smooth;
    g.imageSmoothingQuality = 'high';
    g.drawImage(r, ox, oy, dw, dh);

    var img = g.getImageData(0, 0, L.w, L.h);
    var bits = toBits(img.data, L.w, L.h);
    var px = img.data;
    for (var i = 0, j = 0; i < bits.length; i++, j += 4) {
      var v = bits[i] ? 0 : 255;
      px[j] = px[j + 1] = px[j + 2] = v; px[j + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    result = { w: L.w, h: L.h, bits: bits, box: { x: ox, y: oy, w: dw, h: dh } };

    if (dw > aw || dh > ah) warn.push('Image is larger than the label and will be cut off.');
    if (S.bw === 'dither') warn.push('Dithering breaks barcodes up. Use Threshold for anything a scanner must read.');
    if (!sc.exact && sc.k > 1 && Math.abs(sc.k - Math.round(sc.k)) > 0.01) {
      warn.push('Non-whole scale ×' + sc.k.toFixed(2) + ': some bars will come out 1 dot wider than others. Barcode-safe avoids that.');
    }

    $('#cap').textContent = L.w + ' × ' + L.h + ' dots at ' + dpi() + ' dpi · '
      + (L.w / dpi()).toFixed(2) + ' × ' + (L.h / dpi()).toFixed(2) + ' in · image ×'
      + (sc.exact ? sc.k : sc.k.toFixed(2)) + ' → ' + dw + ' × ' + dh + ' dots';
    showWarn(warn);
    fitPreview();
    syncButtons();
  }

  var pending = null;
  function renderSoon() {
    if (pending) return;
    pending = requestAnimationFrame(function () { pending = null; render(); });
  }

  function toBits(px, w, h) {
    var n = w * h, lum = new Float32Array(n), bits = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      lum[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    }
    var thr = S.thr;
    if (S.bw === 'dither') {
      // Floyd-Steinberg, serpentine
      for (var y = 0; y < h; y++) {
        var ltr = (y & 1) === 0, x0 = ltr ? 0 : w - 1, x1 = ltr ? w : -1, s = ltr ? 1 : -1;
        for (var x = x0; x !== x1; x += s) {
          var k = y * w + x, old = lum[k], nw = old < thr ? 0 : 255, err = old - nw;
          bits[k] = nw === 0 ? 1 : 0;
          if (x + s >= 0 && x + s < w) lum[k + s] += err * 7 / 16;
          if (y + 1 < h) {
            if (x - s >= 0 && x - s < w) lum[k + w - s] += err * 3 / 16;
            lum[k + w] += err * 5 / 16;
            if (x + s >= 0 && x + s < w) lum[k + w + s] += err * 1 / 16;
          }
        }
      }
    } else {
      for (i = 0; i < n; i++) bits[i] = lum[i] < thr ? 1 : 0;
    }
    if (S.invert) for (i = 0; i < n; i++) bits[i] ^= 1;
    return bits;
  }

  /* MSB-first, rows padded to whole bytes, 1 = black: ZPL ^GF's layout. */
  function pack(r) {
    var stride = (r.w + 7) >> 3, out = new Uint8Array(stride * r.h);
    for (var y = 0; y < r.h; y++) {
      for (var x = 0; x < r.w; x++) {
        if (r.bits[y * r.w + x]) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return out;
  }

  /* ---------- ZPL (mirrors bitmap_to_zpl in server.py, for the download) ---------- */
  function zplRun(ch, n) {
    var out = '';
    while (n > 0) {
      var take = Math.min(n, 419), pre = '';
      if (take >= 20) pre += String.fromCharCode(103 + Math.floor(take / 20) - 1);   // g..z
      if (take % 20 && take > 1) pre += String.fromCharCode(71 + (take % 20) - 1);    // G..Y
      out += pre + ch;
      n -= take;
    }
    return out;
  }

  function zplRow(hex) {
    if (/^0*$/.test(hex)) return ',';
    if (/^F*$/.test(hex)) return '!';
    var body = hex.replace(/0+$/, ''), out = '', i = 0;
    while (i < body.length) {
      var j = i;
      while (j < body.length && body[j] === body[i]) j++;
      out += zplRun(body[i], j - i);
      i = j;
    }
    return out + (body.length < hex.length ? ',' : '');
  }

  function toZpl(r, opts) {
    var packed = pack(r), stride = (r.w + 7) >> 3, rows = [], prev = null;
    var HEX = '0123456789ABCDEF';
    for (var y = 0; y < r.h; y++) {
      var h = '';
      for (var b = 0; b < stride; b++) {
        var v = packed[y * stride + b];
        h += HEX[v >> 4] + HEX[v & 15];
      }
      rows.push(h === prev ? ':' : zplRow(h));
      prev = h;
    }
    var total = stride * r.h;
    var z = '^XA^PW' + r.w + '^LL' + r.h + '^LH0,0';
    if (opts.speed) z += '^PR' + opts.speed + ',' + opts.speed + ',' + opts.speed;
    if (opts.dark !== '' && opts.dark !== undefined) z += '^MD' + opts.dark;
    z += '^FO0,0^GFA,' + total + ',' + total + ',' + stride + ',' + rows.join('') + '^FS';
    z += '^PQ' + (opts.copies || 1) + '^XZ\n';
    return z;
  }

  /* ---------- preview sizing ---------- */
  function fitPreview() {
    var out = $('#out'), stage = $('#dotStage');
    var z = S.zoom, w, h;
    if (z === 'fit') {
      var availW = stage.clientWidth || 320;
      var availH = window.innerWidth <= 860 ? window.innerHeight * 0.5 : Math.max(260, window.innerHeight - 260);
      var k = Math.min(availW / out.width, availH / out.height);
      // whole device-pixel steps where possible so dots render evenly
      var ratio = window.devicePixelRatio || 1;
      if (k * ratio >= 1) k = Math.floor(k * ratio) / ratio;
      w = out.width * k; h = out.height * k;
    } else {
      var ratio2 = window.devicePixelRatio || 1;
      w = out.width * +z / ratio2; h = out.height * +z / ratio2;
    }
    out.style.width = w + 'px'; out.style.height = h + 'px';
    stage.classList.toggle('scroll', z !== 'fit');
  }

  function showWarn(list) {
    var el = $('#warn');
    el.hidden = !list.length;
    el.textContent = list.join(' ');
  }

  /* ---------- controls ---------- */
  function seg(id, key, attr, after) {
    var el = $(id);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S[key] = b.dataset[attr];
      mark(id, attr, S[key]);
      if (after) after();
      render();
    });
  }
  function mark(id, attr, val) {
    [].forEach.call($(id).querySelectorAll('button'), function (c) {
      c.classList.toggle('is-on', String(c.dataset[attr]) === String(val));
    });
  }

  seg('#fit', 'fit', 'fit', syncFitRows);
  seg('#bw', 'bw', 'bw');
  seg('#zoom', 'zoom', 'zoom', function () { requestAnimationFrame(centreZoom); });

  /* When zoomed in, scroll the image itself into view, not the label's
     (usually empty) top-left corner. */
  function centreZoom() {
    if (S.zoom === 'fit' || !result) return;
    var stage = $('#dotStage'), out = $('#out'), k = out.offsetWidth / out.width, b = result.box;
    stage.scrollLeft = (b.x + b.w / 2) * k - stage.clientWidth / 2;
    stage.scrollTop = (b.y + b.h / 2) * k - stage.clientHeight / 2;
  }

  function syncFitRows() {
    $('#pctRow').hidden = S.fit !== 'custom';
  }

  function bind(id, key, ev, conv, after) {
    var el = $(id);
    el.addEventListener(ev || 'change', function () {
      S[key] = conv ? conv(el.type === 'checkbox' ? el.checked : el.value) : (el.type === 'checkbox' ? el.checked : el.value);
      if (after) after();
      renderSoon();
    });
  }
  bind('#labelSize', 'size', 'change', null, function () { $('#customRow').hidden = S.size !== 'custom'; });
  bind('#cw', 'cw', 'input', Number);
  bind('#ch', 'ch', 'input', Number);
  bind('#pct', 'pct', 'input', Number, function () { $('#pctOut').textContent = S.pct + '%'; });
  bind('#smooth', 'smooth');
  bind('#thr', 'thr', 'input', Number, function () { $('#thrOut').textContent = S.thr; });
  bind('#invert', 'invert');
  bind('#margin', 'margin');
  bind('#align', 'align');
  bind('#copies', 'copies', 'change', function (v) { return Math.max(1, Math.min(20, parseInt(v, 10) || 1)); });
  bind('#dark', 'dark');
  bind('#speed', 'speed');
  bind('#dpi', 'dpi', 'change', Number);

  $('#rotL').addEventListener('click', function () { S.rot = (S.rot + 270) % 360; render(); });
  $('#rotR').addEventListener('click', function () { S.rot = (S.rot + 90) % 360; render(); });

  (function hydrate() {
    $('#labelSize').value = S.size; $('#customRow').hidden = S.size !== 'custom';
    $('#cw').value = S.cw; $('#ch').value = S.ch;
    $('#pct').value = S.pct; $('#pctOut').textContent = S.pct + '%';
    $('#smooth').checked = S.smooth;
    $('#thr').value = S.thr; $('#thrOut').textContent = S.thr;
    $('#invert').checked = S.invert;
    $('#margin').value = S.margin; $('#align').value = S.align;
    $('#copies').value = S.copies;
    $('#dark').value = S.dark; $('#speed').value = S.speed; $('#dpi').value = S.dpi;
    mark('#fit', 'fit', S.fit); mark('#bw', 'bw', S.bw); mark('#zoom', 'zoom', S.zoom);
    syncFitRows();
  })();

  /* ---------- output ---------- */
  function setStatus(msg, kind) {
    var el = $('#status');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function syncButtons() {
    var none = !result;
    $('#dlZpl').disabled = $('#dlPng').disabled = $('#print').disabled = none;
    var d = $('#direct');
    if (!d.hidden && !d.classList.contains('busy')) d.disabled = none || !CAP.directPrint;
  }

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  $('#dlZpl').addEventListener('click', function () {
    if (!result) return;
    download(new Blob([toZpl(result, { copies: S.copies, dark: S.dark, speed: S.speed })], { type: 'text/plain' }), 'label.zpl');
  });
  $('#dlPng').addEventListener('click', function () {
    if (!result) return;
    $('#out').toBlob(function (b) { if (b) download(b, 'label-' + dpi() + 'dpi.png'); }, 'image/png');
  });
  $('#print').addEventListener('click', function () {
    if (!result) return;
    var img = $('#printImg');
    img.onload = function () { img.onload = null; window.print(); };
    img.src = $('#out').toDataURL('image/png');
  });

  function explain(j) {
    var code = (j && j.error) || 'unknown';
    if (code === 'off-network') return 'Refused: this device is not on the local network.';
    if (code === 'not-configured') return 'Direct print is not configured on the server.';
    if (code === 'bad-token') return 'Refused: missing or incorrect print token.';
    if (code === 'rate-limited') return 'Too many jobs just now. Wait a minute and retry.';
    if (code === 'cups-failed') return 'CUPS rejected the job: ' + (j.detail || 'no detail');
    if (code === 'bad-param' || code === 'bad-bitmap-size') return 'The server refused the label size (' + (j.detail || code) + ').';
    return 'Print failed (' + code + ').';
  }

  function refreshCaps() {
    var btn = $('#direct');
    return fetch('/api/capabilities', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        CAP = j;
        if (j.dpi) { $('#dpi').value = String(j.dpi); $('#dpi').disabled = true; }
        if (!j.configured) { btn.hidden = true; render(); return; }
        btn.hidden = false;
        btn.title = j.directPrint
          ? 'Send straight to ' + (j.printer || 'the label printer')
          : 'Available from the local network only';
        if (!j.directPrint && j.reason === 'off-network') {
          setStatus('Direct print is available on the local network only. Download .zpl works anywhere.', '');
        }
        render();
      })
      .catch(function () { btn.hidden = true; });   // static hosting / no backend
  }

  $('#direct').addEventListener('click', function () {
    var btn = this;
    if (btn.disabled || !result) return;

    var headers = {
      'Content-Type': 'application/octet-stream',
      'X-Width': String(result.w), 'X-Height': String(result.h),
      'X-Copies': String(S.copies)
    };
    if (S.dark !== '') headers['X-Darkness'] = String(S.dark);
    if (S.speed !== '') headers['X-Speed'] = String(S.speed);
    if (CAP.tokenRequired) {
      var tok = '';
      try { tok = localStorage.getItem(TOKKEY) || ''; } catch (e) {}
      if (!tok) {
        tok = window.prompt('Print token') || '';
        try { localStorage.setItem(TOKKEY, tok); } catch (e) {}
      }
      headers['X-Print-Token'] = tok;
    }

    function finish(ok, msg) {
      btn.classList.remove('busy');
      btn.disabled = false;
      setStatus(msg, ok ? 'ok' : 'err');
      if (!ok) refreshCaps();
    }

    btn.classList.add('busy');
    btn.disabled = true;
    setStatus('Sending to the printer…', '');

    fetch('/api/print-bitmap', { method: 'POST', headers: headers, body: pack(result) })
      .then(function (r) {
        return r.json().catch(function () { return {}; })
                .then(function (j) { return { http: r.ok, body: j }; });
      })
      .then(function (res) {
        if (res.http && res.body && res.body.ok) {
          finish(true, 'Sent to the printer.');
        } else {
          if (res.body && res.body.error === 'bad-token') {
            try { localStorage.removeItem(TOKKEY); } catch (e) {}
          }
          finish(false, explain(res.body));
        }
      })
      .catch(function (err) { finish(false, 'Could not reach the server: ' + err.message); });
  });

  window.addEventListener('resize', function () { drawCrop(); fitPreview(); });

  render();
  refreshCaps();

  // test hook: lets an automated check drive the pipeline without a file picker
  window.__labelImage = { load: load, state: S, result: function () { return result; },
                          toZpl: toZpl, pack: pack, render: render,
                          setCrop: function (c) { crop = clampCrop(c); drawCrop(); render(); } };
})();
