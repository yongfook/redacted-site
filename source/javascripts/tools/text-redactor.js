import { CATEGORIES, MODEL_PREF, collectSpans as collectSpans_, parseTerms } from "./pii-spans.js";

const EXAMPLE = `Hi team,

Please send the signed contract to Sarah O'Connor at sarah.oconnor@acme-legal.com, or call her on +44 20 7946 0958. She lives at 221B Baker Street, London NW1 6XE, and her date of birth is 14 March 1987.

Dr. Rajesh Kumar from Northwind Traders in Toronto approved the payment of $4,200 to IBAN GB29 NWBK 6016 1331 9268 19. The company card ending 4111 1111 1111 1111 was used for the deposit.

For the audit: SSN 123-45-6789, server 192.168.1.20, API key sk-live-9f8a7b6c5d4e3f2a1b0c.

Thanks,
Miguel Ángel Fernández`;

const $ = (id) => document.getElementById(id);
const input = $("input");
const output = $("output");
const count = $("count");
const styleSelect = $("style");
const customInput = $("custom");
const chips = $("categories");
const loadButton = $("load");
const modelStatus = $("model-status");
const modelBar = $("model");
const progressBar = $("progress-bar");

const state = {
  enabled: new Set(CATEGORIES.filter((c) => c.on).map((c) => c.id)),
  modelSpans: [],
  modelReady: false,
  modelText: null,
  kept: new Set(),
  spans: [],
};

// Categories

for (const c of CATEGORIES) {
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

// Model worker

const worker = new Worker(new URL("./text-redactor-worker.js", import.meta.url), {
  type: "module",
});
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

function loadModel() {
  modelBar.dataset.state = "loading";
  loadButton.disabled = true;
  modelStatus.textContent = "Starting…";
  worker.postMessage({ type: "load" });
  runModel();
}

function runModel() {
  requestId++;
  if (!input.value.trim()) {
    state.modelSpans = [];
    state.modelText = input.value;
    render();
    return;
  }
  worker.postMessage({ type: "detect", id: requestId, text: input.value });
}

loadButton.addEventListener("click", loadModel);

try {
  if (localStorage.getItem(MODEL_PREF) === "1") loadModel();
} catch {}

// Detection

function collectSpans(text) {
  return collectSpans_(text, {
    // Use model results only when they belong to the current text.
    modelSpans: state.modelText === text ? state.modelSpans : [],
    terms: parseTerms(customInput.value),
    enabled: state.enabled,
  });
}

// Output

function replacements(text, spans) {
  const style = styleSelect.value;
  const numbers = {};
  const next = {};
  return spans.map((s) => {
    if (style === "blocks") return "█".repeat(Math.max(3, [...text.slice(s.start, s.end)].length));
    if (style === "redacted") return "[REDACTED]";
    if (style === "numbered") {
      const key = `${s.tag}|${text.slice(s.start, s.end).toLowerCase()}`;
      if (!numbers[key]) numbers[key] = next[s.tag] = (next[s.tag] || 0) + 1;
      return `[${s.tag}_${numbers[key]}]`;
    }
    return `[${s.tag}]`;
  });
}

const keyOf = (s) => `${s.start}:${s.end}`;

function render() {
  const text = input.value;
  const spans = collectSpans(text);
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
  count.textContent = text
    ? `${hidden} hidden${keptCount ? ` · ${keptCount} kept` : ""}`
    : "";
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
  if (state.modelReady || modelBar.dataset.state === "loading") {
    clearTimeout(timer);
    timer = setTimeout(runModel, 250);
  }
});

styleSelect.addEventListener("change", render);
customInput.addEventListener("input", render);

$("example").addEventListener("click", () => {
  input.value = EXAMPLE;
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
  a.download = "redacted.txt";
  a.click();
  URL.revokeObjectURL(a.href);
});

render();
