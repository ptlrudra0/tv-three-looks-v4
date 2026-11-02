/* Fresh wallpapers: pulls new photos each visit from the feed endpoint, cuts the subject
   out locally (seg-worker.js), and adds them to the Current-mode wallpaper rotation.
   Falls back to the built-in photos on any failure. */
(function () {
  var FEED = 'https://tv-unsplash-proxy.inlab-ptl.workers.dev'; // replaced at deploy if different
  var TOKEN = 'tvfeed-e7c2f1a94b3d4c5a6b7c8d9e0f1a2b3c';
  var qs = new URLSearchParams(location.search);
  if (qs.get('wpfeed')) { FEED = qs.get('wpfeed'); TOKEN = qs.get('wptoken') || ''; }
  // FRESH PIPELINE TEMPORARILY DISABLED (2026-11-02): the RMBG-1.4 segmentation model's
  // actual license agreement (BRIA Hugging Face Model License Agreement, Dec 2023) is
  // evaluation-only and terminable at will, which does not cover this ongoing public demo.
  // The demo runs on the 5 curated photos (with their built-in depth cutouts) until the
  // segmentation model is replaced with a permissively licensed one.
  var FRESH_ENABLED = true;
  var QUERIES = ['cinematic car night', 'cricket stadium', 'cinematic city night', 'cinematic mountain landscape', 'film still moody', 'supercar dark', 'cinematic desert road', 'stadium lights'];
  var MAXFRESH = 12, ROUND_LIMIT = 3;
  var WP = null, curated = 0, fresh = [], credits = {}, worker = null, wid = 0, pend = {}, modelReady = false, rounds = 0;

  function log() { try { console.log('[fresh]', ...arguments); } catch (e) {} }

  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  window.__nwp = function (E, len) {
    try {
      if (WP && fresh.length) {
        var avail = fresh.filter(function (i) { return i !== E; });
        if (!avail.length) return fresh[0];
        return avail[Math.floor(Math.random() * avail.length)];
      }
    } catch (e) {}
    return (E + 1) % len;
  };

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('./seg-worker.js', { type: 'module' });
    worker.onmessage = function (e) {
      var m = e.data, cb = pend[m.id];
      if (m.warmed) { modelReady = true; log('model ready'); }
      if (cb) { delete pend[m.id]; cb(m); }
    };
    return worker;
  }

  function segment(blob) {
    return new Promise(function (resolve) {
      var id = ++wid;
      pend[id] = resolve;
      ensureWorker().postMessage({ id: id, blob: blob });
    });
  }

  // clock placement from mask profile, converting image px -> 1280x720 stage px (object-fit: cover).
  // Goal: the subject's sustained top edge crosses the lower ~30% of the digits, so the
  // foreground cutout visibly overlaps the clock (depth) while the time stays readable.
  var DATE_H = 40;                 // idle-date block above the digits (28px + leading)
  var DIGIT_H = 12 * 16 * 0.92;    // size 12em digits at root 16px, line-height .92
  function profileTop(stats) {     // first row of SUSTAINED center-band foreground (stray-pixel proof)
    var rows = stats.bandRows, h = stats.h, bw = Math.ceil(stats.w * 0.36);
    var win = Math.max(3, Math.round(h * 0.04)), run = 0;
    for (var y = 0; y < h; y++) {
      run += rows[y]; if (y >= win) run -= rows[y - win];
      if (y >= win - 1 && run / (win * bw) >= 0.2) return y - win + 1;
    }
    return -1;
  }
  function overlapCov(stats, st, ovRowsImg) { // mean band coverage inside the planned overlap zone
    var rows = stats.bandRows, bw = Math.ceil(stats.w * 0.36), s = 0, n = 0;
    for (var y = st; y < Math.min(stats.h, st + ovRowsImg); y++) { s += rows[y]; n++; }
    return n ? s / (n * bw) : 0;
  }
  function placement(stats) {
    var scale = Math.max(1280 / stats.w, 720 / stats.h);
    var offY = (720 - stats.h * scale) / 2;
    var st = profileTop(stats);
    if (st < 0) return null;
    var sy = st * scale + offY;                      // sustained subject top in stage px
    var top = Math.round(sy - 0.62 * DIGIT_H - DATE_H);
    top = Math.max(6, Math.min(top, Math.round(720 - DATE_H - DIGIT_H - 20)));
    var digitsBot = top + DATE_H + DIGIT_H;
    return { top: top, size: 12, sy: sy, st: st, scale: scale, ovPx: digitsBot - sy };
  }

  function accept(stats) {
    if (!stats || stats.bandTop < 0) return false;
    if (stats.coverage < 0.06 || stats.coverage > 0.72) return false;
    var bw = (stats.bbox[2] - stats.bbox[0]) / stats.w;
    if (bw < 0.15) return false;
    if (stats.bandCov < 0.015) return false;
    return true;
  }

  function ping(dl) {
    if (!dl || !FEED) return;
    try { fetch(FEED + '/dl?loc=' + encodeURIComponent(dl), { headers: { 'X-TV-Token': TOKEN } }).catch(function () {}); } catch (e) {}
  }

  function processPhoto(p) {
    return fetch(p.url, { mode: 'cors' })
      .then(function (r) { if (!r.ok) throw new Error('img ' + r.status); return r.blob(); })
      .then(function (blob) { return segment(blob).then(function (res) { return { res: res }; }); })
      .then(function (out) {
        var res = out.res;
        if (!res.ok) { log('seg fail', res.error); return false; }
        if (!accept(res.stats)) { log('gated out', p.id, JSON.stringify({ cov: +res.stats.coverage.toFixed(2), bandCov: +res.stats.bandCov.toFixed(3), top: res.stats.bandTop })); return false; }
        var pl = placement(res.stats);
        if (!pl) { log('gated out', p.id, 'no sustained subject'); return false; }
        var ovFrac = pl.ovPx / DIGIT_H;
        if (ovFrac < 0.10 || ovFrac > 0.60) { log('gated out', p.id, 'overlap ' + ovFrac.toFixed(2)); return false; }
        var ovC = overlapCov(res.stats, pl.st, Math.round(pl.ovPx / pl.scale));
        if (ovC < 0.25) { log('gated out', p.id, 'wispy overlap ' + ovC.toFixed(2)); return false; }
        var cutUrl = URL.createObjectURL(res.blob);
        var i = WP.bg.length;
        WP.bg.push(p.url); WP.idle.push(p.url); WP.cut.push(cutUrl); WP.clk.push({ top: pl.top, size: pl.size });
        fresh.push(i);
        credits[p.url] = { author: p.author, link: p.authorLink };
        ping(p.dl);
        log('added', p.id, 'at index', i, 'clock', JSON.stringify({ top: pl.top, size: pl.size, ov: +ovFrac.toFixed(2) }));
        return true;
      })
      .catch(function (e) { log('photo fail', e); return false; });
  }

  function fetchBatch() {
    if (!WP || fresh.length >= MAXFRESH || rounds >= ROUND_LIMIT) return;
    rounds++;
    var q = shuffle(QUERIES.slice()).slice(0, 2);
    var url = FEED + '/random?q=' + encodeURIComponent(q[0]) + '&n=8';
    log('fetch', q[0]);
    fetch(url, { headers: { 'X-TV-Token': TOKEN } })
      .then(function (r) { if (!r.ok) throw new Error('feed ' + r.status); return r.json(); })
      .then(function (data) {
        var arr = Array.isArray(data) ? data : (data.results || []); var list = arr.filter(function (p) { return p.w >= 1500 && p.w / p.h >= 1.45; });
        var chain = Promise.resolve();
        var added = 0;
        list.forEach(function (p) {
          chain = chain.then(function () {
            if (fresh.length >= MAXFRESH || added >= 6) return null;
            return processPhoto(p).then(function (ok) { if (ok) added++; });
          });
        });
        return chain.then(function () {
          log('round done, fresh total', fresh.length);
          if (fresh.length < 4 && rounds < ROUND_LIMIT) setTimeout(fetchBatch, 4000);
        });
      })
      .catch(function (e) { log('feed fail', e); setTimeout(fetchBatch, 20 * 60 * 1000); });
  }

  // --- photo credit overlay (Unsplash guideline: photographer + Unsplash, linked) ---
  var creditEl = null, currentSrc = null;
  function creditFor(src) {
    var c = src && credits[src];
    return c ? ('Photo · ' + c.author + ' · Unsplash') : 'Photos · Unsplash';
  }
  function linkFor(src) {
    var c = src && credits[src];
    return c ? c.link : 'https://unsplash.com/?utm_source=tvhome&utm_medium=referral';
  }
  function makeCredit(host) {
    if (creditEl && creditEl.isConnected && creditEl.parentNode === host) return;
    creditEl = document.createElement('a');
    creditEl.className = 'fresh-credit';
    creditEl.style.cssText = 'position:absolute;left:18px;bottom:14px;z-index:25;color:rgba(255,255,255,.55);font:500 11px Inter,system-ui,sans-serif;letter-spacing:.04em;text-decoration:none;pointer-events:auto;text-shadow:0 1px 6px rgba(0,0,0,.6);';
    creditEl.target = '_blank'; creditEl.rel = 'noopener';
    host.appendChild(creditEl);
  }
  function syncCredit() {
    if (!creditEl) return;
    creditEl.textContent = creditFor(currentSrc);
    creditEl.href = linkFor(currentSrc);
  }
  // shadow-DOM-aware query (the app renders modes inside shadow roots)
  function deepQ(sel, root) {
    root = root || document;
    var el = root.querySelector(sel);
    if (el) return el;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) { var r = deepQ(sel, all[i].shadowRoot); if (r) return r; }
    }
    return null;
  }
  function eachRoot(cb, root) {
    root = root || document;
    cb(root);
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) if (all[i].shadowRoot) eachRoot(cb, all[i].shadowRoot);
  }
  function currentSurface() {
    var idle = deepQ('.idle');
    if (idle) {
      var img = idle.querySelector('img.idle-layer');
      return { host: idle, src: img ? img.getAttribute('src') : null };
    }
    var bd = deepQ('.bd');
    if (bd && bd.parentNode) {
      var m = /url\(["']?([^"')]+)/.exec(bd.style.backgroundImage || '');
      return { host: bd.parentNode, src: m ? m[1] : null };
    }
    return null;
  }
  function refreshCredit() {
    var s = currentSurface();
    if (!s) return;
    if (s.src !== currentSrc || !creditEl || !creditEl.isConnected || creditEl.parentNode !== s.host) {
      currentSrc = s.src;
      makeCredit(s.host);
      syncCredit();
    }
  }
  var observed = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var obs = new MutationObserver(function () {
    eachRoot(function (r) {
      var target = r === document ? document.documentElement : r;
      if (observed && !observed.has(target)) { observed.add(target); obs.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] }); }
    });
    refreshCredit();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
  if (observed) observed.add(document.documentElement);
  var creditTick = setInterval(refreshCredit, 3000); // safety net for missed mutations

  // --- boot: wait for the Current mode component to expose the wallpaper arrays ---
  var bootT = setInterval(function () {
    if (window.__TVWP) {
      clearInterval(bootT);
      WP = window.__TVWP; curated = WP.bg.length;
      log('hooked, curated', curated);
      if (!FRESH_ENABLED) { log('fresh pipeline disabled: segmentation model license under repair; curated wallpapers only'); return; }
      ensureWorker().postMessage({ id: ++wid, warmup: true });
      fetchBatch();
    }
  }, 700);
})();
