// Runs the PII model off the main thread so typing stays smooth.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
import { detectEntities } from "./ner-core.js";

const MODEL = "onnx-community/bert-small-pii-detection-ONNX";

env.allowLocalModels = false;

let loading = null;

function load() {
  if (!loading) {
    const files = {};
    loading = pipeline("token-classification", MODEL, {
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
        self.postMessage({ type: "progress", loaded, total });
      },
    }).then(
      (clf) => {
        self.postMessage({ type: "ready" });
        return clf;
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

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      await load();
    } else if (data.type === "detect") {
      const clf = await load();
      const spans = await detectEntities(clf, data.text);
      self.postMessage({ type: "result", id: data.id, spans });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
