/* Fresh wallpapers: pulls new photos each visit from the feed endpoint, cuts the subject
   out locally (seg-worker.js), and adds them to the Current-mode wallpaper rotation.
   Falls back to the built-in photos on any failure. */
(function () {
  var FEED = 'https://tv-unsplash-proxy.inlab-ptl.workers.dev'; // replaced at deploy if different
  var TOKEN = 'tvfeed-e7c2f1a94b3d4c5a6b7c8d9e0f1a2b3c';
  var qs = new URLSearchParams(location.search);
  if (qs.get('wpfeed')) { FEED = qs.get('wpfeed'); TOKEN = qs.get('wptoken') || ''; }
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

  // clock placement from mask stats, converting image px -> 1280x720 stage px (object-fit: cover)
  function placement(stats, iw, ih) {
    var scale = Math.max(1280 / iw, 720 / ih);
    var sy = stats.bandTop * scale + (720 - ih * scale) / 2; // subject top in stage px
    var size = 12;
    if (sy > 470) size = 14;
    var digitH = size * 16 * 0.92;
    var top = Math.round(sy - 0.58 * digitH - 40);
    top = Math.max(-8, Math.min(top, 380));
    return { top: top, size: size, sy: sy };
  }

  function accept(stats) {
    if (!stats || stats.bandTop < 0) return false;
    if (stats.coverage < 0.06 || stats.coverage > 0.72) return false;
    var bw = (stats.bbox[2] - stats.bbox[0]) / stats.w;
    if (bw < 0.15) return false;
    if (stats.bandCov < 0.015) return false;
    var topFrac = stats.bandTop / stats.h;
    if (topFrac < 0.10 || topFrac > 0.75) return false;
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
        var pl = placement(res.stats, res.stats.w, res.stats.h);
        var cutUrl = URL.createObjectURL(res.blob);
        var i = WP.bg.length;
        WP.bg.push(p.url); WP.idle.push(p.url); WP.cut.push(cutUrl); WP.clk.push({ top: pl.top, size: pl.size });
        fresh.push(i);
        credits[p.url] = { author: p.author, link: p.authorLink };
        ping(p.dl);
        log('added', p.id, 'at index', i, 'clock', JSON.stringify({ top: pl.top, size: pl.size }));
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
  var creditEl = null, currentSrc = '';
  function creditFor(src) {
    var c = credits[src];
    return c ? ('Photo · ' + c.author + ' · Unsplash') : 'Photos · Unsplash';
  }
  function makeCredit(host) {
    if (creditEl) return;
    creditEl = document.createElement('a');
    creditEl.style.cssText = 'position:absolute;left:18px;bottom:14px;z-index:25;color:rgba(255,255,255,.55);font:500 11px Inter,system-ui,sans-serif;letter-spacing:.04em;text-decoration:none;pointer-events:auto;';
    creditEl.target = '_blank'; creditEl.rel = 'noopener';
    host.appendChild(creditEl);
  }
  function syncCredit() {
    if (!creditEl) return;
    var c = credits[currentSrc];
    creditEl.textContent = creditFor(currentSrc);
    creditEl.href = c ? c.link : 'https://unsplash.com/?utm_source=tvhome&utm_medium=referral';
  }
  var obs = new MutationObserver(function () {
    var idle = document.querySelector('.idle');
    if (idle && !idle.querySelector('.fresh-credit')) {
      makeCredit(idle); creditEl.className = 'fresh-credit';
      var img = idle.querySelector('img.idle-layer');
      if (img) { currentSrc = img.getAttribute('src') || ''; syncCredit(); }
    }
    if (!idle && creditEl) { creditEl = null; currentSrc = ''; }
    var layer = document.querySelector('.idle img.idle-layer');
    if (layer && layer.getAttribute('src') !== currentSrc) { currentSrc = layer.getAttribute('src') || ''; syncCredit(); }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // --- boot: wait for the Current mode component to expose the wallpaper arrays ---
  var bootT = setInterval(function () {
    if (window.__TVWP) {
      clearInterval(bootT);
      WP = window.__TVWP; curated = WP.bg.length;
      log('hooked, curated', curated);
      ensureWorker().postMessage({ id: ++wid, warmup: true });
      fetchBatch();
    }
  }, 700);
})();
