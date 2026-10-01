// Runs the name models off the main thread so typing stays smooth. Each
// request names its model, and each model loads once.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
import { detectEntities } from "./ner-core.js";

const DEFAULT_MODEL = "onnx-community/bert-small-pii-detection-ONNX";

env.allowLocalModels = false;

const loading = new Map();

function load(model = DEFAULT_MODEL) {
  if (!loading.has(model)) {
    const files = {};
    const ready = pipeline("token-classification", model, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (e) => {
        if (e.status !== "progress" || !e.total) return;
        files[e.file] = { loaded: e.loaded, total: e.total };
        let loaded = 0;
        let total = 0;
        for (const f of Object.values(files)) {
          loaded += f.loaded;
          total += f.total;
        }
        self.postMessage({ type: "progress", model, loaded, total });
      },
    }).then(
      (clf) => clf,
      (err) => {
        // Let the next request try again.
        loading.delete(model);
        throw err;
      }
    );
    loading.set(model, ready);
  }
  return loading.get(model);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      // Answer every load request, also for a model that is already loaded.
      await load(data.model);
      self.postMessage({ type: "ready", model: data.model || DEFAULT_MODEL });
    } else if (data.type === "detect") {
      const clf = await load(data.model);
      const spans = await detectEntities(clf, data.text);
      self.postMessage({ type: "result", id: data.id, model: data.model, spans });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: data.id, model: data.model, message: String((err && err.message) || err) });
  }
};
