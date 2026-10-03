// Metadata Stripper: show and remove hidden details such as location,
// camera and author from photos, PDFs and videos. Everything happens in this
// tab. The file is never uploaded.
import "./polyfills.js";
import { stripJpeg, stripPng, stripWebp, pngText, webpExif, sniff } from "./metadata-core.js";
import { busy, idle, note, downloadName } from "./busy.js";
import { scanLight } from "./scan.js";

const EXIFR = "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs";
const PDF_LIB = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";
const MEDIABUNNY = "https://cdn.jsdelivr.net/npm/mediabunny@1.61.0/dist/bundles/mediabunny.min.mjs";
const SAMPLE = "/samples/photo-with-location.jpg";

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const editor = $("editor");
const status = $("status");
const findingsEl = $("findings");
const preview = $("preview");
// The scan light: over the file while its hidden details are read.
const scanning = scanLight(preview);
const download = $("download");
const downloadNote = $("download-note");

const state = { file: null, bytes: null, kind: null, runId: 0 };

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

const KIND_NAMES = { jpeg: "JPEG photo", png: "PNG image", webp: "WebP image", pdf: "PDF", video: "video" };

// Opening a file

async function openFile(file) {
  if (!file) return;
  const runId = ++state.runId;
  setStatus("Reading the file…", "busy");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    setStatus("This file type is not supported. Choose a JPEG, PNG or WebP photo, a PDF, or an MP4, MOV or WebM video.", "error");
    return;
  }
  state.file = file;
  state.bytes = bytes;
  state.kind = kind;
  drop.hidden = true;
  editor.hidden = false;
  note(downloadNote);
  showPreview(file, kind);

  let found;
  scanning(true);
  try {
    found = await readMetadata(bytes, kind, file);
  } catch (err) {
    if (runId !== state.runId) return;
    setStatus(`Could not read this ${KIND_NAMES[kind]}. ${(err && err.message) || err}`, "error");
    return;
  } finally {
    if (runId === state.runId) scanning(false);
  }
  if (runId !== state.runId) return;
  renderFindings(found);
}

function showPreview(file, kind) {
  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
  preview.replaceChildren();
  const url = URL.createObjectURL(file);
  preview.dataset.url = url;
  let media = null;
  if (kind === "jpeg" || kind === "png" || kind === "webp") {
    media = document.createElement("img");
    media.alt = "";
  } else if (kind === "video") {
    media = document.createElement("video");
    media.muted = true;
    media.playsInline = true;
    media.preload = "metadata";
  }
  if (media) {
    media.src = url;
    preview.appendChild(media);
  }
  const info = document.createElement("div");
  info.className = "preview-info";
  info.innerHTML = "<strong></strong><span></span>";
  info.querySelector("strong").textContent = file.name;
  info.querySelector("span").textContent = `${KIND_NAMES[kind]} · ${formatSize(file.size)}`;
  preview.appendChild(info);
}

// Reading metadata. Returns groups: { location: [], other: [] } of "Label: value".

async function readMetadata(bytes, kind, file) {
  if (kind === "pdf") return readPdf(bytes);
  if (kind === "video") return readVideo(file);
  return readImage(bytes, kind);
}

async function readImage(bytes, kind) {
  const { default: exifr } = await import(EXIFR);
  const source = kind === "webp" ? webpExif(bytes) : bytes;
  let data = {};
  if (source) {
    data =
      (await exifr
        .parse(source, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, ifd1: false, interop: false, mergeOutput: true })
        .catch(() => null)) || {};
  }
  const found = { location: [], other: [] };
  if (typeof data.latitude === "number" && typeof data.longitude === "number") {
    found.location.push(`GPS location: ${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (/^(latitude|longitude|GPS)/.test(key) || SKIP.has(key)) continue;
    const text = formatValue(value);
    if (text) found.other.push(`${LABELS[key] || splitWords(key)}: ${text}`);
  }
  if (kind === "png") for (const { key, value } of pngText(bytes)) found.other.push(`${key}: ${shorten(value)}`);
  return unique(found);
}

// Technical fields that say nothing about a person or a device.
const SKIP = new Set([
  "ImageWidth", "ImageHeight", "BitDepth", "ColorType", "Compression", "Filter", "Interlace",
  "XResolution", "YResolution", "ResolutionUnit", "ExifImageWidth", "ExifImageHeight",
  "PixelXDimension", "PixelYDimension", "ColorSpace", "Orientation", "YCbCrPositioning",
  "ComponentsConfiguration", "ExifVersion", "FlashpixVersion", "format", "ColorMode",
  "NativeDigest", "ExifIFDPointer", "GPSInfoIFDPointer", "SceneCaptureType", "CustomRendered",
]);

const LABELS = {
  Make: "Camera make",
  Model: "Camera model",
  LensModel: "Lens",
  LensMake: "Lens make",
  BodySerialNumber: "Camera serial number",
  SerialNumber: "Serial number",
  LensSerialNumber: "Lens serial number",
  Artist: "Author",
  Copyright: "Copyright",
  Software: "Software",
  CreatorTool: "Software",
  ImageDescription: "Description",
  DateTimeOriginal: "Date taken",
  CreateDate: "Date created",
  ModifyDate: "Date changed",
  MetadataDate: "Metadata date",
  OwnerName: "Owner",
  CameraOwnerName: "Camera owner",
  HostComputer: "Computer",
  DocumentID: "Document ID",
  InstanceID: "File ID",
  OriginalDocumentID: "Original document ID",
};

async function readPdf(bytes) {
  const { PDFDocument, PDFName } = await import(PDF_LIB);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const found = { location: [], other: [] };
  const add = (label, value) => {
    const text = formatValue(value);
    if (text) found.other.push(`${label}: ${text}`);
  };
  add("Title", doc.getTitle());
  add("Author", doc.getAuthor());
  add("Subject", doc.getSubject());
  add("Keywords", doc.getKeywords());
  add("Software", doc.getCreator());
  add("PDF software", doc.getProducer());
  add("Date created", doc.getCreationDate());
  add("Date changed", doc.getModificationDate());
  if (doc.catalog.get(PDFName.of("Metadata"))) found.other.push("XMP metadata: present");
  const versions = (latin1(bytes).match(/%%EOF/g) || []).length;
  if (versions > 1) found.other.push(`Saved versions in the file: ${versions}`);
  return found;
}

async function readVideo(file) {
  const mb = await import(MEDIABUNNY);
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const tags = await input.getMetadataTags();
  const found = { location: [], other: [] };
  const add = (label, value) => {
    const text = formatValue(value);
    if (text) found.other.push(`${label}: ${text}`);
  };
  add("Title", tags.title);
  add("Description", tags.description);
  add("Artist", tags.artist);
  add("Comment", tags.comment);
  add("Date", tags.date);
  for (const [key, value] of Object.entries(tags.raw || {})) {
    if (/^(major_brand|minor_version|compatible_brands)$/i.test(key)) continue;
    if (/^loci$/i.test(key)) {
      found.location.push("Location: saved in the file");
      continue;
    }
    const text = typeof value === "string" ? value : value instanceof Uint8Array ? readableText(value) : "";
    if (!text) continue;
    if (/location|©xyz|xyz/i.test(key)) {
      const loc = parseIso6709(text);
      found.location.push(loc ? `GPS location: ${loc}` : `Location: ${shorten(text)}`);
    } else if (!/^(title|desc|description|artist|comment|date|©nam|©ART|©cmt|©day)$/i.test(key)) {
      found.other.push(`${videoLabel(key)}: ${shorten(text)}`);
    }
  }
  return unique(found);
}

// "+50.8411+004.3828+020.000/" -> "50.84110, 4.38280"
function parseIso6709(s) {
  const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s);
  return m ? `${Number(m[1]).toFixed(5)}, ${Number(m[2]).toFixed(5)}` : null;
}

function videoLabel(key) {
  const k = key.replace(/^com\.apple\.quicktime\./, "").replace(/^©/, "");
  const names = { make: "Camera make", model: "Camera model", software: "Software", creationdate: "Date created", too: "Software", mak: "Camera make", mod: "Camera model", swr: "Software", encoder: "Software" };
  return names[k.toLowerCase()] || splitWords(k);
}

// Showing results

function renderFindings(found) {
  const total = found.location.length + found.other.length;
  const name = KIND_NAMES[state.kind];
  findingsEl.replaceChildren();
  if (!total) {
    setStatus(`No hidden details found in this ${name}.`);
    findingsEl.appendChild(
      finding("ok", "No metadata found", "This file has no location, camera, author or date details that the tool can read.", [])
    );
  } else {
    setStatus(`${total} hidden ${total === 1 ? "detail" : "details"} found in this ${name}. Download a clean copy without them.`);
    if (found.location.length)
      findingsEl.appendChild(finding("leak", "Location", "This file shows where it was made. Anyone who gets the file can see it.", found.location));
    if (found.other.length)
      findingsEl.appendChild(finding("check", "Other details", "Device, software, author and date details saved in the file.", found.other));
  }
  download.disabled = false;
}

function finding(level, title, detail, items) {
  const el = document.createElement("div");
  el.className = `finding is-${level}`;
  el.innerHTML = `<span class="finding-label"></span><div class="finding-body"><h3></h3><p></p><ul></ul></div>`;
  el.querySelector(".finding-label").textContent = { leak: "Leak", check: "Check", ok: "OK" }[level];
  el.querySelector("h3").textContent = title;
  el.querySelector("p").textContent = detail;
  const ul = el.querySelector("ul");
  for (const text of items.slice(0, 60)) {
    const li = document.createElement("li");
    const q = document.createElement("q");
    q.textContent = text;
    li.appendChild(q);
    ul.appendChild(li);
  }
  if (!items.length) ul.remove();
  return el;
}

// Cleaning

download.addEventListener("click", async () => {
  if (!state.bytes) return;
  busy(download, "Cleaning…");
  note(downloadNote);
  try {
    const { blob, ext } = await clean(state.bytes, state.kind, state.file);
    const base = state.file.name.replace(/\.[^.]+$/, "") || "file";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = downloadName(`${base}-clean.${ext}`);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    note(downloadNote, "Done. Your clean file is downloaded.");
  } catch (err) {
    note(downloadNote, `Could not clean the file. ${(err && err.message) || err}`, "error");
  } finally {
    idle(download);
  }
});

async function clean(bytes, kind, file) {
  if (kind === "jpeg") return { blob: new Blob([stripJpeg(bytes).bytes], { type: "image/jpeg" }), ext: "jpg" };
  if (kind === "png") return { blob: new Blob([stripPng(bytes).bytes], { type: "image/png" }), ext: "png" };
  if (kind === "webp") return { blob: new Blob([stripWebp(bytes).bytes], { type: "image/webp" }), ext: "webp" };
  if (kind === "pdf") return cleanPdf(bytes);
  return cleanVideo(file);
}

async function cleanPdf(bytes) {
  const lib = await import(PDF_LIB);
  const { PDFDocument, PDFName } = lib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef) {
    const info = doc.context.lookup(infoRef);
    for (const key of info.keys()) info.delete(key);
  }
  doc.catalog.delete(PDFName.of("Metadata"));
  removeUnusedObjects(doc, lib);
  // Saving writes a new file, so earlier saved versions are not copied.
  const out = await doc.save();
  return { blob: new Blob([out], { type: "application/pdf" }), ext: "pdf" };
}

// Delete objects that nothing in the document points to. Earlier saved
// versions leave such objects behind, for example the old document details
// with the author's name, and pdf-lib would otherwise save them again.
function removeUnusedObjects(doc, { PDFRef, PDFDict, PDFArray, PDFStream }) {
  const { context } = doc;
  const used = new Set();
  const visit = (obj) => {
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (used.has(key)) return;
      used.add(key);
      visit(context.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) visit(value);
    } else if (obj instanceof PDFArray) {
      for (const value of obj.asArray()) visit(value);
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  visit(context.trailerInfo.Root);
  visit(context.trailerInfo.Info);
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!used.has(ref.toString())) context.delete(ref);
  }
}

async function cleanVideo(file) {
  const mb = await import(MEDIABUNNY);
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const format = await input.getFormat();
  const [Format, ext, type] =
    format === mb.QTFF
      ? [mb.MovOutputFormat, "mov", "video/quicktime"]
      : format === mb.WEBM
        ? [mb.WebMOutputFormat, "webm", "video/webm"]
        : format === mb.MATROSKA
          ? [mb.MkvOutputFormat, "mkv", "video/x-matroska"]
          : [mb.Mp4OutputFormat, "mp4", "video/mp4"];
  const output = new mb.Output({ format: new Format(), target: new mb.BufferTarget() });
  // No video or audio options: the streams are copied, not encoded again.
  const conversion = await mb.Conversion.init({ input, output, tags: {}, showWarnings: false });
  if (!conversion.isValid) throw new Error("This video cannot be copied in this browser.");
  conversion.onProgress = (p) => busy(download, `Cleaning… ${Math.round(p * 100)}%`);
  await conversion.execute();
  return { blob: new Blob([output.target.buffer], { type }), ext };
}

// Helpers

// The same detail can come from two places, such as Exif and a PNG text field.
const unique = (found) => ({ location: [...new Set(found.location)], other: [...new Set(found.other)] });

function formatValue(v) {
  if (v === undefined || v === null || v === "") return "";
  if (v instanceof Date) {
    if (isNaN(v)) return "";
    // Local time, as the camera or app saved it.
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`;
  }
  if (Array.isArray(v)) return shorten(v.map(formatValue).filter(Boolean).join(", "));
  if (typeof v === "object") return "";
  return shorten(String(v).trim());
}

const shorten = (s) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
const splitWords = (k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ");

function readableText(bytes) {
  const s = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/[\u0000-\u001f�]/g, "").trim();
  return /[A-Za-z0-9]{2}/.test(s) ? s : "";
}

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

function formatSize(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Loading a file

function reset() {
  state.runId++;
  scanning(false, true);
  state.bytes = null;
  editor.hidden = true;
  drop.hidden = false;
  fileInput.value = "";
  findingsEl.replaceChildren();
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
  setStatus("Loading the example photo…", "busy");
  const blob = await (await fetch(SAMPLE)).blob();
  await openFile(new File([blob], "photo-with-location.jpg", { type: "image/jpeg" }));
});
