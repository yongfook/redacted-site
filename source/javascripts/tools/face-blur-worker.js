// Finds faces off the main thread so the page stays responsive.
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs";
import { regionsFor, scaleFor, tensorFromRGBA, decode, nms, INPUT_SIZE } from "./face-core.js";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = 1;

const MODEL_URL = new URL("/models/yunet-2023mar.onnx", self.location.origin).href;

let loading = null;

function load() {
  if (!loading) {
    loading = ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] }).then(
      (session) => {
        self.postMessage({ type: "ready" });
        return session;
      },
      (err) => {
        // Let the next request try again.
        loading = null;
        throw err;
      }
    );
  }
  return loading;
}

const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
const ctx = canvas.getContext("2d", { willReadFrequently: true });
// The full-image pass shrinks the photo a lot. Low-quality scaling adds
// noise that gives false and doubled boxes.
ctx.imageSmoothingQuality = "high";

async function detect(bitmap, id, tile, threshold) {
  const session = await load();
  const regions = regionsFor(bitmap.width, bitmap.height, tile);
  const found = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const s = scaleFor(r);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, Math.round(r.w * s), Math.round(r.h * s));
    const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const input = new ort.Tensor("float32", tensorFromRGBA(pixels), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    found.push(...decode(await session.run({ input }), r, threshold));
    self.postMessage({ type: "progress", id, done: i + 1, total: regions.length });
  }
  bitmap.close();
  return nms(found);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      await load();
    } else if (data.type === "detect") {
      const faces = await detect(data.bitmap, data.id, data.tile, data.threshold);
      self.postMessage({ type: "result", id: data.id, faces });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: data.id, message: String((err && err.message) || err) });
  }
};
