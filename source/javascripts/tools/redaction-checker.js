// Redaction Checker: test a redacted PDF for leaks. Everything happens in
// this tab. The PDF is never uploaded.
import "./polyfills.js";
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { pageText, spanToRects } from "./pdf-core.js";
import { busy, idle, note, downloadName } from "./busy.js";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";

const SAMPLE = "/samples/bad-redaction.pdf";
const SCALE = 2; // Pixel checks run on pages drawn at twice the PDF size.

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const editor = $("editor");
const pagesEl = $("pages");
const status = $("status");
const findingsEl = $("findings");
const download = $("download");
const downloadNote = $("download-note");

const state = { doc: null, name: "document", findings: [], runId: 0 };

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

// Opening a PDF

async function openFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus("This file is not a PDF. Choose a .pdf file.", "error");
    return;
  }
  const runId = ++state.runId;
  setStatus("Reading the PDF…", "busy");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    // PDF.js takes the buffer, so give it a copy and keep the bytes.
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    setStatus(
      err && err.name === "PasswordException"
        ? "This PDF is protected with a password. Remove the password in your PDF app, then try again."
        : "This file could not be read as a PDF.",
      "error"
    );
    return;
  }
  if (state.doc) state.doc.destroy();
  state.doc = doc;
  state.name = file.name.replace(/\.pdf$/i, "") || "document";
  drop.hidden = true;
  editor.hidden = false;
  pagesEl.replaceChildren();
  findingsEl.replaceChildren();
  note(downloadNote);

  const findings = [];
  try {
    await checkPages(doc, findings, runId);
    if (runId !== state.runId) return;
    await checkDocument(doc, bytes, findings);
  } catch (err) {
    if (runId !== state.runId) return;
    setStatus(`Could not check the PDF. ${(err && err.message) || err}`, "error");
    return;
  }
  state.findings = findings;
  renderFindings();
}

// Page checks: text that cannot be seen, and redactions not applied

async function checkPages(doc, findings, runId) {
  const measure = makeMeasure();
  const covered = [];
  const hidden = [];
  const outside = [];
  const comments = [];
  const fields = [];
  const pending = [];

  for (let n = 1; n <= doc.numPages; n++) {
    if (runId !== state.runId) return;
    setStatus(`Checking page ${n} of ${doc.numPages}…`, "busy");
    const page = await doc.getPage(n);
    const view1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Draw without annotations, so a comment icon does not hide text.
    await page.render({ canvas, viewport, background: "#fff", annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const content = await page.getTextContent();
    const { parts } = pageText(content.items);
    const marks = [];

    for (const part of parts) {
      const item = content.items[part.index];
      if (!item.str.trim()) continue;
      const style = content.styles[item.fontName];
      const measureItem = (str) => measure(str, style);

      // Check each word, because a bar often covers only part of a line.
      // Words in a row with the same result join into one phrase.
      let run = null;
      const flush = () => {
        if (!run) return;
        const list = run.kind === "covered" ? covered : run.kind === "hidden" ? hidden : outside;
        list.push({ page: n, text: item.str.slice(run.start, run.end) });
        if (run.box) marks.push({ ...scaleBox(run.box), kind: "leak", text: item.str.slice(run.start, run.end) });
        run = null;
      };

      for (const word of item.str.matchAll(/\S+/g)) {
        const span = { start: part.start + word.index, end: part.start + word.index + word[0].length };
        const [rect] = spanToRects(span, content.items, [part], measureItem);
        if (!rect) continue;
        const [x0, y0] = viewport.convertToViewportPoint(rect.x0, rect.y0);
        const [x1, y1] = viewport.convertToViewportPoint(rect.x1, rect.y1);
        const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };

        let kind = null;
        if (box.x + box.w < 0 || box.y + box.h < 0 || box.x > canvas.width || box.y > canvas.height) {
          kind = "outside";
        } else {
          const look = inspect(pixels, box);
          if (look && look.flat) kind = look.dark ? "covered" : "hidden";
        }

        if (run && run.kind === kind) {
          run.end = word.index + word[0].length;
          if (run.box) run.box = union(run.box, box);
        } else {
          flush();
          if (kind) run = { kind, start: word.index, end: word.index + word[0].length, box: kind === "outside" ? null : box };
        }
      }
      flush();
    }

    for (const a of await page.getAnnotations()) {
      const text = (a.contentsObj && a.contentsObj.str) || a.contents || "";
      const [ax0, ay0, ax1, ay1] = a.rect || [0, 0, 0, 0];
      const [bx0, by0] = view1.convertToViewportPoint(ax0, ay0);
      const [bx1, by1] = view1.convertToViewportPoint(ax1, ay1);
      const box = { x: Math.min(bx0, bx1), y: Math.min(by0, by1), w: Math.abs(bx1 - bx0), h: Math.abs(by1 - by0) };
      if (a.subtype === "Redact") {
        pending.push({ page: n, text: text || "(no label)" });
        marks.push({ ...box, kind: "leak", text: "Redaction marked but not applied" });
      } else if (a.subtype === "Widget") {
        const value = Array.isArray(a.fieldValue) ? a.fieldValue.join(", ") : a.fieldValue;
        if (value && String(value).trim() && value !== "Off") fields.push({ page: n, text: `${a.fieldName || "Field"}: ${value}` });
      } else if (text.trim() && a.subtype !== "Link") {
        const who = (a.titleObj && a.titleObj.str) || a.title || "";
        comments.push({ page: n, text: who ? `${who}: ${text}` : text });
        marks.push({ ...box, kind: "check", text: `Comment: ${text}` });
      }
    }

    addPageElement(n, view1, canvas, marks);
  }

  if (covered.length)
    findings.push({
      level: "leak",
      title: "Text under black bars",
      detail: "These words are covered on the page, but anyone can copy them from the file.",
      items: covered,
    });
  if (hidden.length)
    findings.push({
      level: "leak",
      title: "Hidden text",
      detail: "This text is in the file but cannot be seen on the page, for example white text or text under a white box.",
      items: hidden,
    });
  if (pending.length)
    findings.push({
      level: "leak",
      title: "Redactions marked but not applied",
      detail: "Someone marked these areas for redaction, but the text under them is still in the file.",
      items: pending,
    });
  if (outside.length)
    findings.push({ level: "check", title: "Text outside the page", detail: "This text is in the file, outside the visible page area.", items: outside });
  if (comments.length) findings.push({ level: "check", title: "Comments and notes", detail: "Comments are saved in the file and often contain names.", items: comments });
  if (fields.length) findings.push({ level: "check", title: "Form fields with values", detail: "Filled form fields are saved in the file.", items: fields });
}

// Look at the pixels behind a piece of text. Returns flat when the area is
// one color (so the text cannot be seen) and dark when that color is dark.
function inspect(img, box) {
  // The middle of the word only. Word boxes have extra room at the ends,
  // and a bar often stops right at the first or last letter.
  const x0 = Math.max(0, Math.floor(box.x + box.w * 0.2));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w * 0.8));
  const y0 = Math.max(0, Math.floor(box.y + box.h * 0.3));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h * 0.7));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  const step = Math.max(1, Math.floor((x1 - x0) / 120));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * 4;
      const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { flat: sd < 6, dark: mean < 60 };
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const scaleBox = (b) => ({ x: b.x / SCALE, y: b.y / SCALE, w: b.w / SCALE, h: b.h / SCALE });

function makeMeasure() {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fontKerning = "none";
  return (str, style) => {
    ctx.font = `100px ${(style && style.fontFamily) || "sans-serif"}`;
    return ctx.measureText(str).width;
  };
}

// Document checks: metadata, earlier versions, attachments

async function checkDocument(doc, bytes, findings) {
  const { info } = await doc.getMetadata();
  const fields = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];
  const labels = { CreationDate: "Created", ModDate: "Changed" };
  const meta = [];
  for (const f of fields) {
    const v = info && info[f];
    if (v && String(v).trim()) meta.push({ text: `${labels[f] || f}: ${formatValue(f, v)}` });
  }

  // Earlier versions: a PDF saved over keeps the old content after it.
  const raw = latin1(bytes);
  const versions = (raw.match(/%%EOF/g) || []).length;
  if (versions > 1) {
    const old = new Set();
    // Strings can be (literal) or <hex>.
    for (const m of raw.matchAll(/\/(Title|Author|Subject|Keywords)\s*(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>)/g)) {
      const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : decodeHex(m[3]);
      const text = `${m[1]}: ${value}`;
      if (value.trim() && !meta.some((x) => x.text === text)) old.add(text);
    }
    findings.push({
      level: "leak",
      title: `${versions} saved versions in one file`,
      detail:
        "The file was saved over without being rebuilt, so earlier versions are still inside it." +
        (old.size ? " These details from an earlier version are still readable:" : " Text removed in a later version can still be read."),
      items: [...old].map((text) => ({ text })),
    });
  }

  const attachments = await doc.getAttachments();
  const files = attachments ? Object.values(attachments) : [];
  if (files.length)
    findings.push({
      level: "check",
      title: "Attached files",
      detail: "Files attached inside the PDF are shared with it.",
      items: files.map((f) => ({ text: f.filename || "Attachment" })),
    });

  if (meta.length)
    findings.push({
      level: "check",
      title: "Document details (metadata)",
      detail: "These details are saved in the file and show in PDF apps.",
      items: meta,
    });
}

function formatValue(field, value) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(value);
  if ((field === "CreationDate" || field === "ModDate") && m) return [m[1], m[2], m[3]].filter(Boolean).join("-");
  return String(value);
}

// A PDF hex string: UTF-16 when it starts with FEFF, else one byte a letter.
function decodeHex(hex) {
  const h = hex.replace(/\s+/g, "");
  const bytes = [];
  for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return String.fromCharCode(...bytes);
}

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

// Results

function renderFindings() {
  const leaks = state.findings.filter((f) => f.level === "leak");
  const checks = state.findings.filter((f) => f.level === "check");
  const pages = `${state.doc.numPages} ${state.doc.numPages === 1 ? "page" : "pages"}`;
  if (leaks.length) {
    setStatus(`${pages} checked · ${leaks.length} ${leaks.length === 1 ? "leak" : "leaks"} found. See the list below.`, "error");
  } else {
    setStatus(`${pages} checked · no leaks found.${checks.length ? " Look at the points to check below." : ""}`);
  }

  findingsEl.replaceChildren();
  if (!leaks.length) {
    findingsEl.appendChild(
      finding({
        level: "ok",
        title: "No text under bars, no hidden text, no pending redactions, one saved version",
        detail: "The checks that look for leaked text found nothing.",
        items: [],
      })
    );
  }
  for (const f of [...leaks, ...checks]) findingsEl.appendChild(finding(f));
}

function finding(f) {
  const el = document.createElement("div");
  el.className = `finding is-${f.level}`;
  const label = { leak: "Leak", check: "Check", ok: "OK" }[f.level];
  el.innerHTML = `<span class="finding-label"></span><div class="finding-body"><h3></h3><p></p><ul></ul></div>`;
  el.querySelector(".finding-label").textContent = label;
  el.querySelector("h3").textContent = f.title;
  el.querySelector("p").textContent = f.detail;
  const ul = el.querySelector("ul");
  for (const item of f.items.slice(0, 50)) {
    const li = document.createElement("li");
    if (item.page) {
      const a = document.createElement("a");
      a.href = `#page-${item.page}`;
      a.textContent = `Page ${item.page}`;
      li.append(a, " ");
    }
    const q = document.createElement("q");
    q.textContent = item.text;
    li.append(q);
    ul.appendChild(li);
  }
  if (f.items.length > 50) {
    const li = document.createElement("li");
    li.textContent = `…and ${f.items.length - 50} more`;
    ul.appendChild(li);
  }
  if (!f.items.length) ul.remove();
  return el;
}

function addPageElement(n, view, canvas, marks) {
  const el = document.createElement("div");
  el.className = "pdf-page";
  el.id = `page-${n}`;
  el.style.aspectRatio = `${view.width} / ${view.height}`;
  el.appendChild(canvas);
  const layer = document.createElement("div");
  layer.className = "boxes";
  for (const m of marks) {
    const b = document.createElement("span");
    b.className = `flag is-${m.kind}`;
    b.title = m.text;
    b.style.left = `${(m.x / view.width) * 100}%`;
    b.style.top = `${(m.y / view.height) * 100}%`;
    b.style.width = `${(m.w / view.width) * 100}%`;
    b.style.height = `${(m.h / view.height) * 100}%`;
    layer.appendChild(b);
  }
  el.appendChild(layer);
  const num = document.createElement("span");
  num.className = "page-num";
  num.textContent = n;
  el.appendChild(num);
  pagesEl.appendChild(el);
}

// Report

download.addEventListener("click", () => {
  busy(download, "Saving report…");
  const lines = [`Redaction check: ${state.name}.pdf`, `Checked on ${new Date().toISOString().slice(0, 10)} with redacted.to`, ""];
  if (!state.findings.some((f) => f.level === "leak")) lines.push("No leaks found.", "");
  for (const f of state.findings) {
    lines.push(`[${f.level.toUpperCase()}] ${f.title}`, f.detail);
    for (const i of f.items) lines.push(`  - ${i.page ? `Page ${i.page}: ` : ""}${i.text}`);
    lines.push("");
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
  a.download = downloadName(`${state.name}-redaction-check.txt`);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  idle(download);
  note(downloadNote, "Done. Your report is downloaded.");
});

// Loading a file

function reset() {
  state.runId++;
  if (state.doc) state.doc.destroy();
  state.doc = null;
  pagesEl.replaceChildren();
  findingsEl.replaceChildren();
  editor.hidden = true;
  drop.hidden = false;
  fileInput.value = "";
  setStatus("");
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
$("new").addEventListener("click", reset);
$("sample").addEventListener("click", async () => {
  setStatus("Loading the example PDF…", "busy");
  const blob = await (await fetch(SAMPLE)).blob();
  await openFile(new File([blob], "bad-redaction.pdf", { type: "application/pdf" }));
});
