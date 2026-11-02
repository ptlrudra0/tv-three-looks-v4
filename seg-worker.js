// Foreground cutout worker. Runs Depth Anything V2 Small (Apache-2.0, code and weights:
// github.com/DepthAnything/Depth-Anything-V2, HF card depth-anything/Depth-Anything-V2-Small-hf)
// via transformers.js + onnxruntime-web WASM, model onnx-community/depth-anything-v2-small (q8).
// Foreground = nearer scene (relative disparity above adaptive percentile window), which gives
// the skyline/subject silhouette used for the clock-depth effect. Sky always maps to background.
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
env.allowLocalModels = false;
let depPromise = null;
function getDep() {
  if (!depPromise) depPromise = pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', { dtype: 'q8' });
  return depPromise;
}
self.onmessage = async (e) => {
  const { id, blob } = e.data;
  try {
    if (e.data.warmup) { await getDep(); self.postMessage({ id, ok: true, warmed: true }); return; }
    const dep = await getDep();
    const img = await RawImage.fromBlob(blob);
    const { predicted_depth } = await dep(img);
    const data = predicted_depth.data, h = predicted_depth.dims[0], w = predicted_depth.dims[1];
    const rgb = await img.resize(w, h);
    // adaptive alpha: map the p45..p75 disparity window to 0..255 (nearer = more opaque)
    const vals = Float32Array.from(data).sort();
    const pct = q => vals[Math.floor(q * (vals.length - 1))];
    const lo = pct(0.45), hi = pct(0.75), mn = vals[0], mx = vals[vals.length - 1];
    const contrast = (hi - lo) / (mx - mn + 1e-9); // low = flat gradient, no real near/far split
    const n = w * h;
    const alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = (data[i] - lo) / (hi - lo + 1e-9);
      alpha[i] = d <= 0 ? 0 : d >= 1 ? 255 : Math.round(d * 255);
    }
    // stats: coverage, bbox, center-band rows (same contract as before)
    let fg = 0, minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
    const x0 = Math.floor(w * 0.32), x1 = Math.ceil(w * 0.68);
    const bandRows = new Uint16Array(h);
    let bandFg = 0, bandTop = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > 140) {
          fg++;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          if (x >= x0 && x <= x1) { bandFg++; bandRows[y]++; if (bandTop < 0) bandTop = y; }
        }
      }
    }
    const stats = { coverage: fg / n, bbox: [minx, miny, maxx, maxy], bandCov: bandFg / ((x1 - x0) * h), bandTop, w, h, bandRows, contrast: +contrast.toFixed(3) };
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d');
    const out = new ImageData(new Uint8ClampedArray(n * 4), w, h);
    for (let i = 0; i < n; i++) {
      out.data[i * 4] = rgb.data[i * 3]; out.data[i * 4 + 1] = rgb.data[i * 3 + 1]; out.data[i * 4 + 2] = rgb.data[i * 3 + 2];
      out.data[i * 4 + 3] = alpha[i];
    }
    ctx.putImageData(out, 0, 0);
    const outBlob = await oc.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, ok: true, blob: outBlob, stats });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
