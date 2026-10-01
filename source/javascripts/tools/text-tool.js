// The shared page logic for the text tools (Text Redactor, Secrets Scrubber,
// Chat Text Anonymizer): categories, the optional AI model, the two panes, the
// replacement styles, copy and download. Each tool calls startTextTool()
// with its own settings.
import { CATEGORIES, TAG_CATEGORY, MODEL_PREF, collectSpans, parseTerms } from "./pii-spans.js";
import { pseudonymizer } from "./fake-names.js";
import { downloadName } from "./busy.js";

// options:
//   example       text for "Paste an example"
//   categories    category chips: { id, label, on }
//   tagCategory   tag -> category id
//   detect(text)  extra spans from the tool's own rules
//   useModel      true to offer the PII model
//   fileName      name of the downloaded file
export function startTextTool({
  example,
  categories = CATEGORIES,
  tagCategory = TAG_CATEGORY,
  detect = () => [],
  useModel = true,
  fileName = "redacted.txt",
}) {
  const $ = (id) => document.getElementById(id);
  const input = $("input");
  const output = $("output");
  const count = $("count");
  const styleSelect = $("style");
  const customInput = $("custom");
  const chips = $("categories");

  const state = {
    enabled: new Set(categories.filter((c) => c.on).map((c) => c.id)),
    modelSpans: [],
    modelReady: false,
    modelText: null,
    kept: new Set(),
    spans: [],
  };

  // Categories

  for (const c of categories) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = c.label;
    b.setAttribute("aria-pressed", String(state.enabled.has(c.id)));
    b.addEventListener("click", () => {
      if (state.enabled.has(c.id)) state.enabled.delete(c.id);
      else state.enabled.add(c.id);
      b.setAttribute("aria-pressed", String(state.enabled.has(c.id)));
      render();
    });
    chips.appendChild(b);
  }

  // Model worker (optional)

  let runModel = () => {};
  const modelBar = $("model");

  if (useModel) {
    const loadButton = $("load");
    const modelStatus = $("model-status");
    const progressBar = $("progress-bar");
    const worker = new Worker(new URL("./text-redactor-worker.js", import.meta.url), { type: "module" });
    let requestId = 0;

    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        const pct = Math.round((data.loaded / data.total) * 100);
        progressBar.style.width = `${pct}%`;
        modelStatus.textContent = `Downloading model… ${pct}%`;
      } else if (data.type === "ready") {
        state.modelReady = true;
        modelBar.dataset.state = "ready";
        modelStatus.textContent = "The model runs on this device.";
        try {
          localStorage.setItem(MODEL_PREF, "1");
        } catch {}
      } else if (data.type === "result") {
        if (data.id !== requestId) return;
        state.modelSpans = data.spans;
        state.modelText = input.value;
        render();
      } else if (data.type === "error") {
        modelBar.dataset.state = "error";
        modelStatus.textContent = `Could not load the model. ${data.message}`;
        loadButton.disabled = false;
        loadButton.textContent = "Try again";
      }
    };

    runModel = () => {
      requestId++;
      if (!input.value.trim()) {
        state.modelSpans = [];
        state.modelText = input.value;
        render();
        return;
      }
      worker.postMessage({ type: "detect", id: requestId, text: input.value });
    };

    const loadModel = () => {
      modelBar.dataset.state = "loading";
      loadButton.disabled = true;
      modelStatus.textContent = "Starting…";
      worker.postMessage({ type: "load" });
      runModel();
    };

    loadButton.addEventListener("click", loadModel);
    try {
      if (localStorage.getItem(MODEL_PREF) === "1") loadModel();
    } catch {}
  }

  // Detection

  function spansFor(text) {
    return collectSpans(text, {
      // Use model results only when they belong to the current text.
      modelSpans: state.modelText === text ? state.modelSpans : [],
      terms: parseTerms(customInput.value),
      enabled: state.enabled,
      extra: detect(text),
      tagCategory,
    });
  }

  // Output

  function replacements(text, spans) {
    const style = styleSelect.value;
    const numbers = {};
    const next = {};
    const fake = pseudonymizer();
    return spans.map((s) => {
      const value = text.slice(s.start, s.end);
      if (style === "blocks") return "█".repeat(Math.max(3, [...value].length));
      if (style === "redacted") return "[REDACTED]";
      if (style === "fake" && s.tag === "NAME") return fake(value);
      if (style === "numbered" || style === "fake") {
        const key = `${s.tag}|${value.toLowerCase()}`;
        if (!numbers[key]) numbers[key] = next[s.tag] = (next[s.tag] || 0) + 1;
        return `[${s.tag}_${numbers[key]}]`;
      }
      return `[${s.tag}]`;
    });
  }

  const keyOf = (s) => `${s.start}:${s.end}`;

  function render() {
    const text = input.value;
    const spans = spansFor(text);
    const subs = replacements(text, spans);
    state.spans = spans.map((s, i) => ({ ...s, sub: subs[i] }));

    const frag = document.createDocumentFragment();
    let pos = 0;
    let hidden = 0;
    for (const s of state.spans) {
      if (s.start > pos) frag.append(text.slice(pos, s.start));
      const kept = state.kept.has(keyOf(s));
      const mark = document.createElement("mark");
      mark.dataset.key = keyOf(s);
      mark.className = kept ? "kept" : styleSelect.value === "blocks" ? "block" : "";
      mark.title = kept ? `Kept (${s.tag}). Click to hide.` : `${s.tag}. Click to keep.`;
      mark.textContent = kept ? text.slice(s.start, s.end) : s.sub;
      frag.append(mark);
      pos = s.end;
      if (!kept) hidden++;
    }
    if (pos < text.length) frag.append(text.slice(pos));

    output.replaceChildren(frag);
    output.classList.toggle("is-empty", !text);
    const keptCount = state.spans.length - hidden;
    count.textContent = text ? `${hidden} hidden${keptCount ? ` · ${keptCount} kept` : ""}` : "";
  }

  function plainOutput() {
    const text = input.value;
    let out = "";
    let pos = 0;
    for (const s of state.spans) {
      out += text.slice(pos, s.start);
      out += state.kept.has(keyOf(s)) ? text.slice(s.start, s.end) : s.sub;
      pos = s.end;
    }
    return out + text.slice(pos);
  }

  output.addEventListener("click", (e) => {
    const mark = e.target.closest("mark");
    if (!mark) return;
    const key = mark.dataset.key;
    if (state.kept.has(key)) state.kept.delete(key);
    else state.kept.add(key);
    render();
  });

  // Input

  let timer;
  input.addEventListener("input", () => {
    state.kept.clear();
    render();
    if (state.modelReady || (modelBar && modelBar.dataset.state === "loading")) {
      clearTimeout(timer);
      timer = setTimeout(runModel, 250);
    }
  });

  styleSelect.addEventListener("change", render);
  customInput.addEventListener("input", render);

  $("example").addEventListener("click", () => {
    input.value = example;
    input.dispatchEvent(new Event("input"));
  });

  $("clear").addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });

  $("copy").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    try {
      await navigator.clipboard.writeText(plainOutput());
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });

  $("download").addEventListener("click", () => {
    const blob = new Blob([plainOutput()], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = downloadName(fileName);
    a.click();
    URL.revokeObjectURL(a.href);
  });

  render();
}
