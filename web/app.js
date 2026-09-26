/* Label Printer - 4x6 thermal label composer.
   Everything renders at true physical size (CSS 1in = 96px), so the browser's
   print pipeline hands the Zebra driver an exact 4x6 page. No server rendering. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var DPI = 96, LW = 4 * DPI, LH = 6 * DPI;
  var MINPX = 6, MAXPX = 340;
  var PT2PX = 4 / 3;

  var FONTS = {
    sans:  '-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,"Segoe UI",Roboto,sans-serif',
    cond:  '"Arial Narrow","Helvetica Neue Condensed","Roboto Condensed","Liberation Sans Narrow",Arial,sans-serif',
    wide:  'Verdana,Tahoma,"DejaVu Sans",Geneva,sans-serif',
    serif: 'Georgia,"Times New Roman",Times,serif',
    mono:  'Consolas,"SF Mono",Menlo,"DejaVu Sans Mono",monospace'
  };

  var KEY = 'labelprinter.v1';
  var DEF = {
    mode: 'single', text: ['', '', ''], same: false,
    font: 'sans', align: 'center',
    bold: false, under: false, caps: false, wrap: true,
    auto: true, size: 36, match: true, pad: '0.14in'
  };

  var S = Object.assign({}, DEF);
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) S = Object.assign({}, DEF, JSON.parse(raw));
  } catch (e) { /* private mode / blocked storage */ }
  if (!Array.isArray(S.text) || S.text.length !== 3) S.text = ['', '', ''];

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
  }

  /* ---------- element refs ---------- */
  var label = $('#label');
  var cells = [0, 1, 2].map(function (i) { return label.querySelector('.cell[data-i="' + i + '"]'); });
  var txts = cells.map(function (c) { return c.querySelector('.txt'); });
  var inners = cells.map(function (c) { return c.querySelector('.inner'); });
  var areas = [$('#t0'), $('#t1'), $('#t2')];
  var sizeEl = $('#size'), sizeOut = $('#sizeOut');

  /* ---------- text -> DOM ----------
     Each whitespace-delimited token goes in its own nowrap span, so a line can
     only break at a space. Without this the fitter happily splits "BIN A-12"
     into "BIN A- / 12" (CSS breaks after hyphens by default) because that
     permits a larger font. A token too wide for the line now overflows instead,
     which the fitter detects and shrinks away. */
  function setText(el, str) {
    el.textContent = '';
    if (!str) return;
    var frag = document.createDocumentFragment();
    str.split(/(\s+)/).forEach(function (part) {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        var sp = document.createElement('span');
        sp.className = 'w';
        sp.textContent = part;
        frag.appendChild(sp);
      }
    });
    el.appendChild(frag);
  }

  /* ---------- fitting ----------
     Binary-search the font size until the text block fits its cell.
     Only layout metrics (scrollHeight / clientWidth) are read - those are
     immune to the preview's CSS scale transform, unlike getBoundingClientRect. */
  function fits(inner, availW, availH) {
    return inner.scrollHeight <= availH && inner.scrollWidth <= availW;
  }

  function fitCell(i) {
    var box = txts[i], inner = inners[i];
    if (!inner.textContent.trim()) return null;
    var availW = box.clientWidth, availH = box.clientHeight;
    if (availW <= 0 || availH <= 0) return null;    // hidden / not laid out yet

    var lo = MINPX, hi = MAXPX, best = MINPX, mid;
    for (var n = 0; n < 17; n++) {
      mid = (lo + hi) / 2;
      inner.style.fontSize = mid + 'px';
      if (fits(inner, availW, availH)) { best = mid; lo = mid; } else { hi = mid; }
    }
    return best;
  }

  function applySizes() {
    var active = S.mode === 'single' ? [0] : [0, 1, 2];

    if (!S.auto) {
      var px = S.size * PT2PX;
      active.forEach(function (i) { inners[i].style.fontSize = px + 'px'; });
      sizeOut.textContent = S.size + ' pt';
      return;
    }

    var found = {};
    active.forEach(function (i) { found[i] = fitCell(i); });
    var used = active.map(function (i) { return found[i]; })
                     .filter(function (v) { return v !== null; });

    if (S.mode === 'triple' && S.match && used.length > 1) {
      var min = Math.min.apply(null, used);
      active.forEach(function (i) {
        if (found[i] !== null) inners[i].style.fontSize = min + 'px';
      });
      used = [min];
    } else {
      active.forEach(function (i) {
        if (found[i] !== null) inners[i].style.fontSize = found[i] + 'px';
      });
    }

    sizeOut.textContent = used.length
      ? 'auto · ' + Math.round(Math.min.apply(null, used) / PT2PX) + ' pt'
      : 'auto';
  }

  /* ---------- render ---------- */
  function render() {
    document.body.dataset.mode = S.mode;
    label.dataset.mode = S.mode;
    label.dataset.wrap = S.wrap ? 'on' : 'off';
    label.dataset.fit = S.auto ? 'auto' : 'manual';
    label.style.setProperty('--pad', S.pad);

    var ff = FONTS[S.font] || FONTS.sans;
    var active = S.mode === 'single' ? [0] : [0, 1, 2];

    active.forEach(function (i) {
      var src = (S.mode === 'triple' && S.same) ? S.text[0] : S.text[i];
      setText(inners[i], src || '');
      var st = inners[i].style;
      st.fontFamily = ff;
      st.textAlign = S.align;
      st.fontWeight = S.bold ? '700' : '400';
      st.textDecoration = S.under ? 'underline' : 'none';
      st.textUnderlineOffset = S.under ? '0.1em' : '';
      st.textTransform = S.caps ? 'uppercase' : 'none';
    });

    applySizes();

    $('#lbl0').textContent = S.mode === 'triple' ? 'Section 1 (top)' : 'Label text';
    $('#cap').textContent = S.mode === 'triple'
      ? '3 × 2×4″ · cut at the tick marks'
      : '4×6″ label · actual size preview';

    areas[1].disabled = areas[2].disabled = !!S.same;
    areas[1].style.opacity = areas[2].style.opacity = S.same ? 0.45 : 1;

    save();
  }

  var pending = null;
  function renderSoon() {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(function () { pending = null; render(); });
  }

  /* ---------- preview scaling ---------- */
  function rescale() {
    var stage = $('#stage');
    var availW = stage.clientWidth || LW;
    var narrow = window.innerWidth <= 860;
    var availH = narrow ? window.innerHeight * 0.45 : Math.max(260, window.innerHeight - 230);
    var k = Math.min(availW / LW, availH / LH, 1);
    document.documentElement.style.setProperty('--scale', String(k));
  }

  /* ---------- wiring ---------- */
  areas.forEach(function (a, i) {
    a.value = S.text[i] || '';
    a.addEventListener('input', function () { S.text[i] = a.value; renderSoon(); });
  });

  $('#modes').addEventListener('click', function (e) {
    var b = e.target.closest('.mode'); if (!b) return;
    S.mode = b.dataset.mode;
    [].forEach.call(this.children, function (c) { c.classList.toggle('is-on', c === b); });
    rescale(); render();
  });

  $('#align').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.align = b.dataset.align;
    [].forEach.call(this.children, function (c) { c.classList.toggle('is-on', c === b); });
    render();
  });

  $('#pad').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.pad = b.dataset.pad;
    [].forEach.call(this.children, function (c) { c.classList.toggle('is-on', c === b); });
    render();
  });

  [['bold', 'bold'], ['under', 'under'], ['caps', 'caps'], ['wrap', 'wrap']].forEach(function (p) {
    var el = $('#' + p[0]);
    el.addEventListener('click', function () {
      S[p[1]] = !S[p[1]];
      el.classList.toggle('is-on', S[p[1]]);
      render();
    });
  });

  $('#font').addEventListener('change', function () { S.font = this.value; render(); });

  $('#auto').addEventListener('change', function () {
    S.auto = this.checked;
    sizeEl.disabled = S.auto;
    render();
  });
  sizeEl.addEventListener('input', function () {
    S.size = +this.value;
    if (S.auto) { S.auto = false; $('#auto').checked = false; sizeEl.disabled = false; }
    render();
  });

  $('#same').addEventListener('change', function () { S.same = this.checked; render(); });
  $('#match').addEventListener('change', function () { S.match = this.checked; render(); });

  $('#clear').addEventListener('click', function () {
    S.text = ['', '', ''];
    areas.forEach(function (a) { a.value = ''; });
    render();
  });

  /* ---------- direct print (optional, server-gated) ---------- */
  var CAP = { configured: false, directPrint: false, dpi: 203, tokenRequired: false };
  var TOKKEY = 'labelprinter.token';

  function setStatus(msg, kind) {
    var el = $('#status');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* Offset of an element relative to the label box, in layout px.
     Walks the offsetParent chain so it does not care which ancestor
     happens to be positioned. */
  function posInLabel(el) {
    var x = 0, y = 0, n = el;
    while (n && n !== label) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x: x, y: y };
  }

  /* Redraw the label onto a canvas at the printer's native dpi.
     Positions come from the DOM that is already on screen, so what gets
     rasterised is by construction the same layout the preview shows. */
  function rasterize(dpi) {
    var scale = dpi / 96;
    var c = document.createElement('canvas');
    c.width = Math.round(4 * dpi);
    c.height = Math.round(6 * dpi);
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000'; g.textBaseline = 'top';

    var ff = FONTS[S.font] || FONTS.sans;
    var weight = S.bold ? '700' : '400';
    var active = S.mode === 'single' ? [0] : [0, 1, 2];

    active.forEach(function (i) {
      var inner = inners[i];
      var fs = parseFloat(inner.style.fontSize || '0');
      var spans = [].slice.call(inner.querySelectorAll('.w'));
      if (!fs || !spans.length) return;

      g.font = weight + ' ' + (fs * scale) + 'px ' + ff;

      var lines = {};
      spans.forEach(function (sp) {
        var p = posInLabel(sp);
        g.fillText(S.caps ? sp.textContent.toUpperCase() : sp.textContent,
                   p.x * scale, p.y * scale);
        var key = Math.round(p.y);
        var L = lines[key] || (lines[key] = { y: p.y, h: sp.offsetHeight, x0: Infinity, x1: -Infinity });
        L.x0 = Math.min(L.x0, p.x);
        L.x1 = Math.max(L.x1, p.x + sp.offsetWidth);
      });

      if (S.under) {
        Object.keys(lines).forEach(function (k) {
          var L = lines[k];
          var thick = Math.max(1, Math.round(fs * 0.055 * scale));
          g.fillRect(L.x0 * scale, (L.y + L.h * 0.92) * scale,
                     (L.x1 - L.x0) * scale, thick);
        });
      }
    });

    if (S.mode === 'triple') {
      var mw = Math.round(0.18 * dpi);
      var mh = Math.max(2, Math.round(0.012 * dpi));
      [2, 4].forEach(function (inch) {
        var y = Math.round(inch * dpi - mh / 2);
        g.fillRect(0, y, mw, mh);
        g.fillRect(c.width - mw, y, mw, mh);
      });
    }
    return c;
  }

  function explain(j) {
    var code = (j && j.error) || 'unknown';
    if (code === 'off-network') return 'Refused: this device is not on the local network.';
    if (code === 'not-configured') return 'Direct print is not configured on the server.';
    if (code === 'bad-token') return 'Refused: missing or incorrect print token.';
    if (code === 'rate-limited') return 'Too many jobs just now. Wait a minute and retry.';
    if (code === 'cups-failed') return 'CUPS rejected the job: ' + (j.detail || 'no detail');
    if (code === 'expected-png' || code === 'bad-body-size') return 'The label image did not upload correctly.';
    return 'Print failed (' + code + ').';
  }

  function refreshCaps() {
    var btn = $('#direct');
    return fetch('/api/capabilities', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        CAP = j;
        if (!j.configured) { btn.hidden = true; return; }
        btn.hidden = false;
        btn.disabled = !j.directPrint;
        btn.title = j.directPrint
          ? 'Send straight to the label printer'
          : 'Available from the local network only';
        if (!j.directPrint && j.reason === 'off-network') {
          setStatus('Direct print is available on the local network only.', '');
        }
      })
      .catch(function () { btn.hidden = true; });   // static hosting / no backend
  }

  $('#direct').addEventListener('click', function () {
    var btn = this;
    if (btn.disabled) return;

    render();
    var canvas = rasterize(CAP.dpi || 203);

    function finish(ok, msg) {
      btn.classList.remove('busy');
      btn.disabled = false;
      setStatus(msg, ok ? 'ok' : 'err');
      if (!ok) refreshCaps();
    }

    btn.classList.add('busy');
    btn.disabled = true;
    setStatus('Sending to the printer…', '');

    canvas.toBlob(function (blob) {
      if (!blob) { finish(false, 'Could not rasterise the label.'); return; }

      var headers = { 'Content-Type': 'image/png' };
      if (CAP.tokenRequired) {
        var tok = '';
        try { tok = localStorage.getItem(TOKKEY) || ''; } catch (e) {}
        if (!tok) {
          tok = window.prompt('Print token') || '';
          try { localStorage.setItem(TOKKEY, tok); } catch (e) {}
        }
        headers['X-Print-Token'] = tok;
      }

      fetch('/api/print', { method: 'POST', headers: headers, body: blob })
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
    }, 'image/png');
  });

  $('#print').addEventListener('click', function () { render(); window.print(); });
  window.addEventListener('beforeprint', function () { render(); });

  /* ---------- restore control state ---------- */
  (function hydrate() {
    [].forEach.call($('#modes').children, function (c) { c.classList.toggle('is-on', c.dataset.mode === S.mode); });
    [].forEach.call($('#align').children, function (c) { c.classList.toggle('is-on', c.dataset.align === S.align); });
    [].forEach.call($('#pad').children, function (c) { c.classList.toggle('is-on', c.dataset.pad === S.pad); });
    $('#bold').classList.toggle('is-on', S.bold);
    $('#under').classList.toggle('is-on', S.under);
    $('#caps').classList.toggle('is-on', S.caps);
    $('#wrap').classList.toggle('is-on', S.wrap);
    $('#font').value = S.font;
    $('#auto').checked = S.auto;
    $('#same').checked = S.same;
    $('#match').checked = S.match;
    sizeEl.value = S.size;
    sizeEl.disabled = S.auto;
  })();

  window.addEventListener('resize', function () { rescale(); });
  if (window.ResizeObserver) new ResizeObserver(rescale).observe($('#stage'));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(render);

  rescale();
  render();
  refreshCaps();
})();
