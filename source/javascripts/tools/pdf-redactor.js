// PDF Redactor: find personal data in a PDF and export a copy with black
// bars. The export draws every page as an image, so no hidden text stays
// under a bar. Everything happens in this tab. The PDF is never uploaded.
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { CATEGORIES, collectSpans, parseTerms } from "./pii-spans.js";
import { pageText, spanToRects, mergeRects } from "./pdf-core.js";
import { busy, idle, note, downloadName } from "./busy.js";
import { startLanguage, saveLanguage, modelFor, fillLanguageSelect, rememberModel, modelWasOn } from "./languages.js";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";
const PDF_LIB = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";

const SAMPLE = "/samples/example-letter.pdf";
const EXPORT_DPI = 200;
const MAX_EXPORT_PIXELS = 16_000_000;

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const editor = $("editor");
const pagesEl = $("pages");
const status = $("status");
const chips = $("categories");
const customInput = $("custom");
const download = $("download");
const original = $("original");
const downloadNote = $("download-note");
const loadButton = $("load");
const modelStatus = $("model-status");
const modelBar = $("model");
const progressBar = $("progress-bar");

const state = {
  doc: null,
  name: "document",
  pages: [], // see openPdf()
  enabled: new Set(CATEGORIES.filter((c) => c.on).map((c) => c.id)),
  off: new Set(), // keys of detected boxes the user chose to show
  modelReady: false,
  docId: 0,
  busy: false,
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
    refresh();
  });
  chips.appendChild(b);
}

customInput.addEventListener("input", refresh);

// Name model (the same worker as the Text Redactor)

const worker = new Worker(new URL("./text-redactor-worker.js", import.meta.url), { type: "module" });
const pending = new Map(); // request id -> page
const langSelect = $("ai-lang");
let lang = startLanguage();
const model = () => modelFor(lang).id;

worker.onmessage = ({ data }) => {
  // Ignore messages for a model of a language that is no longer chosen.
  if (data.model && data.model !== model()) return;
  if (data.type === "progress") {
    const pct = Math.round((data.loaded / data.total) * 100);
    progressBar.style.width = `${pct}%`;
    modelStatus.textContent = `Downloading model… ${pct}%`;
  } else if (data.type === "ready") {
    state.modelReady = true;
    modelBar.dataset.state = "ready";
    modelStatus.textContent = "Runs on this device.";
    rememberModel(modelFor(lang));
  } else if (data.type === "result") {
    const page = pending.get(data.id);
    pending.delete(data.id);
    if (!page || page.docId !== state.docId) return;
    page.modelSpans = data.spans;
    refresh();
  } else if (data.type === "error") {
    modelBar.dataset.state = "error";
    modelStatus.textContent = `Could not load the model. ${data.message}`;
    loadButton.disabled = false;
    loadButton.textContent = "Try again";
  }
};

let requestId = 0;

function runModel() {
  for (const page of state.pages) {
    if (!page.text.trim() || page.modelSpans) continue;
    const id = ++requestId;
    pending.set(id, page);
    worker.postMessage({ type: "detect", id, model: model(), text: page.text });
  }
}

const startText = modelStatus.textContent;
function turnOff() {
  state.modelReady = false;
  modelBar.dataset.state = "off";
  loadButton.disabled = false;
  modelStatus.textContent = startText;
}

function loadModel() {
  state.modelReady = false;
  modelBar.dataset.state = "loading";
  progressBar.style.width = "0";
  loadButton.disabled = true;
  modelStatus.textContent = "Starting…";
  worker.postMessage({ type: "load", model: model() });
  runModel();
}

const showButton = () => {
  loadButton.textContent = `Turn on AI (${modelFor(lang).size} MB)`;
};

// The language decides which model finds names.
fillLanguageSelect(langSelect, lang);
langSelect.addEventListener("change", () => {
  lang = langSelect.value;
  saveLanguage(lang);
  showButton();
  for (const page of state.pages) page.modelSpans = null;
  pending.clear();
  refresh();
  // A model that was turned on before starts again on its own. Any other
  // model waits for a click on the button, because it is a new download.
  if (modelWasOn(modelFor(lang))) loadModel();
  else turnOff();
});
showButton();

loadButton.addEventListener("click", loadModel);

try {
  if (modelWasOn(modelFor(lang))) loadModel();
} catch {}

// Opening a PDF

async function openFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus("This file is not a PDF. Choose a .pdf file.", "error");
    return;
  }
  setStatus("Reading the PDF…", "busy");
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (err) {
    const message =
      err && err.name === "PasswordException"
        ? "This PDF is protected with a password. Remove the password in your PDF app, then try again."
        : "This file could not be read as a PDF.";
    setStatus(message, "error");
    return;
  }

  if (state.doc) state.doc.destroy();
  state.doc = doc;
  state.docId++;
  state.name = file.name.replace(/\.pdf$/i, "") || "document";
  state.off.clear();
  state.pages = [];
  note(downloadNote);
  pagesEl.replaceChildren();
  showEditor();

  const measure = makeMeasure();
  for (let n = 1; n <= doc.numPages; n++) {
    setStatus(`Reading page ${n} of ${doc.numPages}…`, "busy");
    const pdfPage = await doc.getPage(n);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const content = await pdfPage.getTextContent();
    const { text, parts } = pageText(content.items);
    const page = {
      n,
      docId: state.docId,
      pdfPage,
      viewport,
      items: content.items,
      styles: content.styles,
      text,
      parts,
      modelSpans: null,
      auto: [],
      manual: [],
      el: null,
    };
    page.measure = (str, item) => measure(str, content.styles[item.fontName]);
    state.pages.push(page);
    addPageElement(page);
  }

  refresh();
  if (state.modelReady || modelBar.dataset.state === "loading") runModel();
}

function showEditor() {
  drop.hidden = true;
  editor.hidden = false;
}

function reset() {
  if (state.doc) state.doc.destroy();
  state.doc = null;
  state.pages = [];
  state.docId++;
  pagesEl.replaceChildren();
  editor.hidden = true;
  drop.hidden = false;
  fileInput.value = "";
  setStatus("");
}

// Width of a string in a PDF font, measured with the closest web font.
function makeMeasure() {
  const ctx = document.createElement("canvas").getContext("2d");
  // PDFs place each character by its own width. Browser kerning would move
  // the measured positions by several points over a long line.
  ctx.fontKerning = "none";
  return (str, style) => {
    ctx.font = `100px ${(style && style.fontFamily) || "sans-serif"}`;
    return ctx.measureText(str).width;
  };
}

fileInput.addEventListener("change", () => openFile(fileInput.files[0]));

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("is-over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("is-over");
  openFile(e.dataTransfer.files[0]);
});

$("sample").addEventListener("click", async () => {
  setStatus("Loading the example PDF…", "busy");
  const blob = await (await fetch(SAMPLE)).blob();
  await openFile(new File([blob], "example-letter.pdf", { type: "application/pdf" }));
});

$("new").addEventListener("click", reset);

// Boxes

// Detected boxes for each page, in page points from the top left.
function refresh() {
  const terms = parseTerms(customInput.value);
  for (const page of state.pages) {
    const spans = collectSpans(page.text, {
      modelSpans: page.modelSpans || [],
      terms,
      enabled: state.enabled,
    });
    page.auto = [];
    for (const span of spans) {
      const rects = mergeRects(spanToRects(span, page.items, page.parts, page.measure));
      rects.forEach((r, i) => {
        const [x0, y0] = page.viewport.convertToViewportPoint(r.x0, r.y0);
        const [x1, y1] = page.viewport.convertToViewportPoint(r.x1, r.y1);
        page.auto.push({
          key: `${page.n}:${span.start}:${span.end}:${i}`,
          tag: span.tag,
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          w: Math.abs(x1 - x0),
          h: Math.abs(y1 - y0),
        });
      });
    }
    drawBoxes(page);
  }
  updateStatus();
}

const isOn = (box) => (box.key ? !state.off.has(box.key) : box.on);

function drawBoxes(page) {
  const layer = page.el.querySelector(".boxes");
  layer.querySelectorAll(".bar").forEach((el) => el.remove());
  const { width: W, height: H } = page.viewport;
  const all = [...page.auto, ...page.manual];
  all.forEach((box, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `bar${isOn(box) ? "" : " is-off"}`;
    b.style.left = `${(box.x / W) * 100}%`;
    b.style.top = `${(box.y / H) * 100}%`;
    b.style.width = `${(box.w / W) * 100}%`;
    b.style.height = `${(box.h / H) * 100}%`;
    b.dataset.index = i;
    b.title = box.tag ? `${box.tag}. Click to ${isOn(box) ? "show" : "hide"} it.` : `Your box. Click to ${isOn(box) ? "remove" : "hide"} it.`;
    b.setAttribute("aria-pressed", String(isOn(box)));
    b.setAttribute("aria-label", b.title);
    layer.appendChild(b);
  });
}

function toggle(page, index) {
  const all = [...page.auto, ...page.manual];
  const box = all[index];
  if (box.key) {
    if (state.off.has(box.key)) state.off.delete(box.key);
    else state.off.add(box.key);
  } else {
    // A box the user drew: a click removes it.
    page.manual.splice(page.manual.indexOf(box), 1);
  }
  drawBoxes(page);
  updateStatus();
}

function updateStatus() {
  if (!state.pages.length) return;
  let on = 0;
  let total = 0;
  let textPages = 0;
  for (const page of state.pages) {
    if (page.text.trim()) textPages++;
    for (const box of [...page.auto, ...page.manual]) {
      total++;
      if (isOn(box)) on++;
    }
  }
  const pages = `${state.pages.length} ${state.pages.length === 1 ? "page" : "pages"}`;
  if (!textPages) {
    setStatus(`${pages}. This PDF has no text that can be read, so it is probably a scan. Drag on a page to add a black bar.`);
    return;
  }
  const shown = total - on;
  setStatus(
    `${pages} · ${on} ${on === 1 ? "bar" : "bars"}${shown ? ` · ${shown} shown` : ""}. ` +
      "Click a bar to show the text under it. Drag on a page to add a bar."
  );
}

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

// Pages

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const page = state.pages.find((p) => p.el === entry.target);
      if (page) renderPreview(page);
    }
  },
  { rootMargin: "800px 0px" }
);

function addPageElement(page) {
  const el = document.createElement("div");
  el.className = "pdf-page";
  el.style.aspectRatio = `${page.viewport.width} / ${page.viewport.height}`;
  el.innerHTML = `<canvas></canvas><div class="boxes" aria-label="Page ${page.n}"></div><span class="page-num">${page.n}</span>`;
  page.el = el;
  pagesEl.appendChild(el);
  bindDrawing(page);
  observer.observe(el);
}

async function renderPreview(page) {
  const canvas = page.el.querySelector("canvas");
  const scale = (page.el.clientWidth * Math.min(2, window.devicePixelRatio || 1)) / page.viewport.width;
  const viewport = page.pdfPage.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  try {
    await page.pdfPage.render({ canvas, viewport, background: "#fff" }).promise;
  } catch {
    // The PDF was closed while this page was drawing.
  }
}

// Drawing new bars

function bindDrawing(page) {
  const layer = page.el.querySelector(".boxes");
  let drag = null;

  const toPage = (e) => {
    const r = layer.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * page.viewport.width,
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * page.viewport.height,
    };
  };

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { start: toPage(e), bar: e.target.closest(".bar"), moved: false, el: null };
    layer.setPointerCapture(e.pointerId);
  });

  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toPage(e);
    const min = page.viewport.width / layer.clientWidth;
    if (!drag.moved && Math.max(Math.abs(p.x - drag.start.x), Math.abs(p.y - drag.start.y)) < 6 * min) return;
    drag.moved = true;
    if (!drag.el) {
      drag.el = document.createElement("div");
      drag.el.className = "draft";
      layer.appendChild(drag.el);
    }
    const r = rectFrom(drag.start, p);
    Object.assign(drag.el.style, {
      left: `${(r.x / page.viewport.width) * 100}%`,
      top: `${(r.y / page.viewport.height) * 100}%`,
      width: `${(r.w / page.viewport.width) * 100}%`,
      height: `${(r.h / page.viewport.height) * 100}%`,
    });
  });

  layer.addEventListener("pointerup", (e) => {
    if (!drag) return;
    if (drag.moved) {
      const r = rectFrom(drag.start, toPage(e));
      drag.el.remove();
      if (r.w > 2 && r.h > 2) page.manual.push({ ...r, on: true });
      drawBoxes(page);
      updateStatus();
    } else if (drag.bar) {
      toggle(page, +drag.bar.dataset.index);
    }
    drag = null;
  });

  layer.addEventListener("pointercancel", () => {
    if (drag && drag.el) drag.el.remove();
    drag = null;
  });

  layer.addEventListener("keydown", (e) => {
    const bar = e.target.closest(".bar");
    if (!bar || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    const index = bar.dataset.index;
    toggle(page, +index);
    const next = layer.querySelector(`[data-index="${index}"]`);
    if (next) next.focus();
  });
}

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// Hold to compare with the original.
const showOriginal = (on) => pagesEl.classList.toggle("show-original", on);
original.addEventListener("pointerdown", () => showOriginal(true));
["pointerup", "pointerleave", "pointercancel"].forEach((t) => original.addEventListener(t, () => showOriginal(false)));
original.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && showOriginal(true));
original.addEventListener("keyup", () => showOriginal(false));

// Export

download.addEventListener("click", async () => {
  if (state.busy || !state.doc) return;
  state.busy = true;
  busy(download, "Making PDF…");
  note(downloadNote);
  try {
    const { PDFDocument } = await import(PDF_LIB);
    const out = await PDFDocument.create();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    for (const page of state.pages) {
      busy(download, `Making PDF… ${page.n}/${state.pages.length}`);
      const { width, height } = page.viewport;
      let scale = EXPORT_DPI / 72;
      if (width * height * scale * scale > MAX_EXPORT_PIXELS) scale = Math.sqrt(MAX_EXPORT_PIXELS / (width * height));
      const viewport = page.pdfPage.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.pdfPage.render({ canvas, viewport, background: "#fff", intent: "print" }).promise;

      ctx.fillStyle = "#000";
      for (const box of [...page.auto, ...page.manual]) {
        if (!isOn(box)) continue;
        ctx.fillRect(
          Math.floor(box.x * scale),
          Math.floor(box.y * scale),
          Math.ceil(box.w * scale) + 1,
          Math.ceil(box.h * scale) + 1
        );
      }

      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      const image = await out.embedJpg(await blob.arrayBuffer());
      out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }

    out.setProducer("redacted.to");
    out.setCreator("redacted.to PDF Redactor");
    const bytes = await out.save();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    a.download = downloadName(`${state.name}-redacted.pdf`);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    note(downloadNote, "Done. Your redacted PDF is downloaded.");
  } catch (err) {
    note(downloadNote, `Could not make the PDF. ${(err && err.message) || err}`, "error");
  } finally {
    state.busy = false;
    idle(download);
  }
});
