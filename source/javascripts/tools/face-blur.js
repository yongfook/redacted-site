// Face Blur: find faces in a photo and blur, pixelate or cover them.
// Everything happens in this tab. The photo is never uploaded.
import "./polyfills.js";
import { padBox, cover } from "./blur-core.js";
import { busy, idle, note, downloadName } from "./busy.js";

const MAX_PIXELS = 16_000_000; // iOS Safari cannot draw larger canvases.
const SAMPLE = "/samples/solvay-1927.jpg";
const READY = "Runs on this device. Choose a photo.";

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const editor = $("editor");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const boxes = $("boxes");
const status = $("status");
const strength = $("strength");
const strengthControl = $("strength-control");
const download = $("download");
const original = $("original");
const downloadNote = $("download-note");
const modelBar = $("model");

const state = {
  image: null, // ImageBitmap or canvas with the photo at working size
  name: "photo",
  type: "image/jpeg",
  faces: [], // { x, y, w, h, on, manual } in image pixels, already padded
  style: "blur",
  shape: "oval",
  requestId: 0,
  showOriginal: false,
};

// Worker

const worker = new Worker(new URL("./face-blur-worker.js", import.meta.url), { type: "module" });

worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    modelBar.dataset.state = "ready";
    if (!state.image) setStatus(READY);
    return;
  }
  if (data.id !== undefined && data.id !== state.requestId) return;
  if (data.type === "error" && data.id === undefined) {
    modelBar.dataset.state = "error";
    setStatus(`Could not load the face model. ${data.message} Reload the page to try again.`, "error");
    return;
  }
  if (data.type === "progress") {
    setStatus(`Looking for faces… ${Math.round((data.done / data.total) * 100)}%`, "busy");
  } else if (data.type === "result") {
    state.faces = data.faces.map(padFace);
    render();
    updateStatus();
    download.disabled = false;
  } else if (data.type === "error") {
    setStatus(`Could not run face detection. ${data.message} Drag to add boxes.`, "error");
    download.disabled = false;
  }
};

function padFace(f) {
  return { ...padBox(f, canvas.width, canvas.height), on: true, manual: false };
}

// Loading a photo

async function openFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("This file is not an image. Choose a JPG, PNG or WebP photo.", "error");
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    setStatus("Your browser cannot read this image. Try a JPG, PNG or WebP photo.", "error");
    return;
  }
  state.name = file.name.replace(/\.[^.]+$/, "") || "photo";
  state.type = ["image/jpeg", "image/webp", "image/png"].includes(file.type) ? file.type : "image/png";
  await useBitmap(bitmap);
}

async function useBitmap(bitmap) {
  let { width, height } = bitmap;
  let sizeNote = "";
  if (width * height > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (width * height));
    width = Math.floor(width * k);
    height = Math.floor(height * k);
    sizeNote = ` The photo was reduced to ${width} × ${height} pixels.`;
  }
  canvas.width = width;
  canvas.height = height;

  const work = document.createElement("canvas");
  work.width = width;
  work.height = height;
  work.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  state.image = work;
  state.faces = [];
  state.sizeNote = sizeNote;
  note(downloadNote);
  showEditor();
  render();

  download.disabled = true;
  setStatus("Looking for faces…", "busy");
  state.requestId++;
  const copy = await createImageBitmap(work);
  worker.postMessage({ type: "detect", id: state.requestId, bitmap: copy }, [copy]);
}

function showEditor() {
  drop.hidden = true;
  editor.hidden = false;
}

function reset() {
  state.image = null;
  state.faces = [];
  state.requestId++;
  editor.hidden = true;
  drop.hidden = false;
  fileInput.value = "";
  setStatus(modelBar.dataset.state === "ready" ? READY : "");
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

document.addEventListener("paste", (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
  if (item) openFile(item.getAsFile());
});

$("sample").addEventListener("click", async () => {
  setStatus("Loading the example photo…", "busy");
  const blob = await (await fetch(SAMPLE)).blob();
  await openFile(new File([blob], "solvay-1927.jpg", { type: "image/jpeg" }));
});

$("new").addEventListener("click", reset);

// Rendering

function render() {
  if (!state.image) return;
  ctx.drawImage(state.image, 0, 0);
  if (!state.showOriginal) {
    const options = { style: state.style, strength: +strength.value, shape: state.shape };
    for (const f of state.faces) if (f.on) cover(ctx, state.image, f, options);
  }
  drawBoxes();
}

function drawBoxes() {
  const W = canvas.width;
  const H = canvas.height;
  boxes.querySelectorAll(".face").forEach((el) => el.remove());
  state.faces.forEach((f, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `face${f.on ? "" : " is-off"}${state.shape === "oval" ? " is-oval" : ""}`;
    b.style.left = `${(f.x / W) * 100}%`;
    b.style.top = `${(f.y / H) * 100}%`;
    b.style.width = `${(f.w / W) * 100}%`;
    b.style.height = `${(f.h / H) * 100}%`;
    b.dataset.index = i;
    b.setAttribute("aria-pressed", String(f.on));
    b.setAttribute("aria-label", f.on ? "Face hidden. Click to show it." : "Face shown. Click to hide it.");
    boxes.appendChild(b);
  });
}

function updateStatus() {
  const total = state.faces.length;
  const on = state.faces.filter((f) => f.on).length;
  const sizeNote = state.sizeNote || "";
  if (!total) {
    setStatus(`No faces found. Drag to add a box.${sizeNote}`);
  } else {
    const kept = total - on;
    setStatus(
      `${on} of ${total} hidden${kept ? ` · ${kept} shown` : ""}. Click a box to show it. Drag to add one.${sizeNote}`
    );
  }
}

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

// Toggle a face, or draw a new box

let drag = null;

boxes.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !state.image) return;
  const face = e.target.closest(".face");
  const p = toImage(e);
  drag = { start: p, face, moved: false, el: null };
  boxes.setPointerCapture(e.pointerId);
});

boxes.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = toImage(e);
  const dx = Math.abs(p.x - drag.start.x);
  const dy = Math.abs(p.y - drag.start.y);
  const min = canvas.width / boxes.clientWidth; // one screen pixel in image pixels
  if (!drag.moved && Math.max(dx, dy) < 6 * min) return;
  drag.moved = true;
  if (!drag.el) {
    drag.el = document.createElement("div");
    drag.el.className = "draft";
    boxes.appendChild(drag.el);
  }
  const r = rectFrom(drag.start, p);
  Object.assign(drag.el.style, {
    left: `${(r.x / canvas.width) * 100}%`,
    top: `${(r.y / canvas.height) * 100}%`,
    width: `${(r.w / canvas.width) * 100}%`,
    height: `${(r.h / canvas.height) * 100}%`,
  });
});

boxes.addEventListener("pointerup", (e) => {
  if (!drag) return;
  if (drag.moved) {
    const r = rectFrom(drag.start, toImage(e));
    drag.el.remove();
    if (r.w > 4 && r.h > 4) state.faces.push({ ...r, on: true, manual: true });
  } else if (drag.face) {
    const f = state.faces[+drag.face.dataset.index];
    f.on = !f.on;
  }
  drag = null;
  render();
  updateStatus();
});

boxes.addEventListener("pointercancel", () => {
  if (drag && drag.el) drag.el.remove();
  drag = null;
});

// Keyboard users toggle a face with Enter or Space on its button.
boxes.addEventListener("keydown", (e) => {
  const face = e.target.closest(".face");
  if (!face || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  const f = state.faces[+face.dataset.index];
  f.on = !f.on;
  render();
  updateStatus();
  boxes.querySelector(`[data-index="${face.dataset.index}"]`).focus();
});

function toImage(e) {
  const rect = boxes.getBoundingClientRect();
  return {
    x: Math.min(canvas.width, Math.max(0, ((e.clientX - rect.left) / rect.width) * canvas.width)),
    y: Math.min(canvas.height, Math.max(0, ((e.clientY - rect.top) / rect.height) * canvas.height)),
  };
}

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// Controls

function chipGroup(id, key) {
  const group = $(id);
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    state[key] = b.dataset.value;
    group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    strengthControl.hidden = state.style === "box";
    render();
  });
}

chipGroup("style", "style");
chipGroup("shape", "shape");
strength.addEventListener("input", render);

// Hold to compare with the original.
const showOriginal = (on) => {
  state.showOriginal = on;
  boxes.classList.toggle("is-hidden", on);
  render();
};
original.addEventListener("pointerdown", () => showOriginal(true));
["pointerup", "pointerleave", "pointercancel"].forEach((t) => original.addEventListener(t, () => showOriginal(false)));
original.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && showOriginal(true));
original.addEventListener("keyup", () => showOriginal(false));

download.addEventListener("click", () => {
  state.showOriginal = false;
  render();
  busy(download, "Saving photo…");
  note(downloadNote);
  const ext = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" }[state.type];
  canvas.toBlob(
    (blob) => {
      idle(download);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = downloadName(`${state.name}-blurred.${ext}`);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      note(downloadNote, "Done. Your photo is downloaded.");
    },
    state.type,
    0.92
  );
});

// Load the face model early. It is small.
worker.postMessage({ type: "load" });
