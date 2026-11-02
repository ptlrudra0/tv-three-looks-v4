// Background subject cutout worker. Runs RMBG-1.4 (briaai, non-commercial license) via transformers.js + onnxruntime-web WASM.
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
env.allowLocalModels = false;
let segPromise = null;
function getSeg() {
  if (!segPromise) segPromise = pipeline('background-removal', 'briaai/RMBG-1.4', { dtype: 'q8' });
  return segPromise;
}
self.onmessage = async (e) => {
  const { id, blob } = e.data;
  try {
    if (e.data.warmup) { await getSeg(); self.postMessage({ id, ok: true, warmed: true }); return; }
    const seg = await getSeg();
    const img = await RawImage.fromBlob(blob);
    const [rgba] = await seg(img);
    const { data, width: w, height: h } = rgba;
    // alpha stats: coverage, bbox, central-band subject top
    let fg = 0, minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
    const x0 = Math.floor(w * 0.32), x1 = Math.ceil(w * 0.68);
    let bandFg = 0, bandTop = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > 140) {
          fg++;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          if (x >= x0 && x <= x1) { bandFg++; if (bandTop < 0) bandTop = y; }
        }
      }
    }
    const stats = { coverage: fg / (w * h), bbox: [minx, miny, maxx, maxy], bandCov: bandFg / ((x1 - x0) * h), bandTop, w, h };
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    const out = await oc.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, ok: true, blob: out, stats });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
