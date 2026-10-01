// Face detection helpers for the YuNet model (OpenCV Zoo, MIT license).
// Pure functions, no imports, so the same file runs in the browser and in
// Node tests.

export const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32];

// Regions of the image to run the model on. The full image finds big
// faces. For a large photo, overlapping tiles also find small faces.
export function regionsFor(width, height, tile = 960) {
  const regions = [{ x: 0, y: 0, w: width, h: height }];
  if (Math.max(width, height) <= tile * 1.3) return regions;

  const step = Math.round(tile * 0.75);
  const xs = positions(width, tile, step);
  const ys = positions(height, tile, step);
  for (const y of ys) {
    for (const x of xs) {
      regions.push({ x, y, w: Math.min(tile, width - x), h: Math.min(tile, height - y) });
    }
  }
  return regions;
}

function positions(length, tile, step) {
  if (length <= tile) return [0];
  const out = [];
  for (let p = 0; p + tile < length; p += step) out.push(p);
  out.push(length - tile);
  return out;
}

// Scale that fits a region into the square model input.
export const scaleFor = (region) => INPUT_SIZE / Math.max(region.w, region.h);

// RGBA pixels of the 640 x 640 input (region drawn at the top left, the
// rest black) to the BGR planar float tensor that YuNet expects.
export function tensorFromRGBA(rgba) {
  const n = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4 + 2];
    out[n + i] = rgba[i * 4 + 1];
    out[2 * n + i] = rgba[i * 4];
  }
  return out;
}

// Model outputs to boxes in image coordinates.
export function decode(outputs, region, threshold = 0.75) {
  const scale = scaleFor(region);
  const faces = [];
  for (const s of STRIDES) {
    const cols = INPUT_SIZE / s;
    const cls = outputs[`cls_${s}`].data;
    const obj = outputs[`obj_${s}`].data;
    const bbox = outputs[`bbox_${s}`].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < threshold) continue;
      const c = i % cols;
      const r = Math.floor(i / cols);
      const cx = (c + bbox[i * 4]) * s;
      const cy = (r + bbox[i * 4 + 1]) * s;
      const w = Math.exp(bbox[i * 4 + 2]) * s;
      const h = Math.exp(bbox[i * 4 + 3]) * s;
      faces.push({
        x: region.x + (cx - w / 2) / scale,
        y: region.y + (cy - h / 2) / scale,
        w: w / scale,
        h: h / scale,
        score,
      });
    }
  }
  return faces;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Remove duplicate boxes. A box mostly inside a stronger box is also a
// duplicate, which happens when a tile edge cuts a face. So is a box whose
// center is inside a stronger box, which happens when two passes find the
// same face at different sizes.
export function nms(faces, iou = 0.3, contain = 0.5) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of sorted) {
    const dup = kept.some((k) => {
      const inter = overlap(f, k);
      if (!inter) return false;
      const union = f.w * f.h + k.w * k.h - inter;
      return (
        inter / union > iou ||
        inter / Math.min(f.w * f.h, k.w * k.h) > contain ||
        inside(center(f), k) ||
        inside(center(k), f)
      );
    });
    if (!dup) kept.push(f);
  }
  return kept;
}

const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p, b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
