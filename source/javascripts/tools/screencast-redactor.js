// Screencast Redactor: read the text in a screen recording, find emails,
// keys, names and faces, then make a copy with them hidden. Text reading,
// face detection and name detection all run in this tab. The video is never
// uploaded.
//
// A screen recording is mostly still. The tool checks CHECK_FPS frames a
// second and reads the text again only where the screen changed: the whole
// frame after a scroll, a thin strip after typing. Each result stays on screen
// from just before the change that showed it until the next change, so no
// frame between two checks is left uncovered.
import "./polyfills.js";
import {
  Input,
  Output,
  Conversion,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  CanvasSink,
  ALL_FORMATS,
} from "https://cdn.jsdelivr.net/npm/mediabunny@1.61.0/dist/bundles/mediabunny.min.mjs";
import { TAG_CATEGORY, collectSpans, parseTerms } from "./pii-spans.js";
import {
  lightTextMask,
  domainSpans,
  mergeWords,
  groupLines,
  linesText,
  spanBoxes,
  splitAtLines,
  usernameSpans,
  dateTimeSpans,
} from "./screenshot-core.js";
import { detectSecrets } from "./secret-patterns.js";
import { padBox, cover } from "./blur-core.js";
import { Tracker, coverAt, keepTracks, groupTracks } from "./video-core.js";
import { busy, idle, note, downloadName } from "./busy.js";
import { LANGUAGES, startLanguage, saveLanguage, modelFor, fillLanguageSelect, rememberModel, modelWasOn } from "./languages.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js";
const SAMPLE = "/samples/app-demo.mp4";
const MAX_SECONDS = 10 * 60;
const MAX_SIDE = 1920; // Larger videos are made smaller to 1080p.
const CHECK_FPS = 4; // Frames a second to check for changes.
const STEP = 1 / CHECK_FPS;
// Frames are read at this width. Text in a 720p or 1080p recording is too
// small to read well, so those frames are made larger first.
const OCR_WIDTH = 2560;
const DIFF_WIDTH = 320; // Frames are compared at this width.
const FACE_EVERY = 2; // Look for faces on every 2nd checked frame.
const FACE_WIDTH = 1280;
const FACE_TIMING = { lead: (1.5 * FACE_EVERY) / CHECK_FPS, hold: 1.0 };
const MOTION_PAD = 0.12;
// Text found in one check but missed in the one before or after it (a bad
// read) is carried to it, moved with the scroll, at most this many times.
const CARRY = 8;

const CATEGORIES = [
  { id: "name", label: "Names", on: true },
  { id: "contact", label: "Emails & phones", on: true },
  { id: "secrets", label: "Keys, tokens & passwords", on: true },
  { id: "tech", label: "Links & usernames", on: true },
  { id: "finance", label: "Card & bank numbers", on: true },
  { id: "id", label: "ID numbers", on: true },
  { id: "place", label: "Places & addresses", on: true },
  { id: "org", label: "Organizations", on: true },
  { id: "faces", label: "Faces", on: true },
  { id: "date", label: "Dates & times", on: false },
];
const TAGS = {
  ...TAG_CATEGORY,
  FACE: "faces",
  USERNAME: "tech",
  HOST: "tech",
  API_KEY: "secrets",
  TOKEN: "secrets",
  PASSWORD: "secrets",
  PRIVATE_KEY: "secrets",
  CONNECTION: "secrets",
  SECRET: "secrets",
};
// Detection finds every kind of item. The chips only choose what is hidden,
// so a chip works at once, without reading the video again.
const ALL = new Set([...CATEGORIES.map((c) => c.id), ...Object.values(TAGS)]);
const PERSON = new Set(["PERSON", "PER"]);
const PLACE = new Set(["LOCATION", "LOC", "FACILITY"]);
const ORG = new Set(["ORGANIZATION", "ORG"]);

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const editor = $("editor");
const status = $("status");
const modelBar = $("model");
const langSelect = $("ocr-lang");
const chips = $("categories");
const customInput = $("custom");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const boxesEl = $("boxes");
const video = $("video");
const playButton = $("play");
const scrubber = $("scrubber");
const timeLabel = $("time");
const itemsEl = $("items");
const strength = $("strength");
const strengthControl = $("strength-control");
const keepAudio = $("keep-audio");
const download = $("download");
const original = $("original");
const downloadNote = $("download-note");

const state = {
  file: null,
  input: null,
  track: null,
  width: 0, // video display size
  height: 0,
  duration: 0,
  ocrScale: 1,
  checks: [], // every checked frame: [{ t, y }], y = how far the screen has scrolled
  snapshots: [], // [{ t, y, scroll, bands, text, parts, rules, modelSpans, entries }]
  faceTracks: [],
  items: [], // text and faces found: [{ key, kind, tag, text, cat, first, last }]
  manual: [], // boxes the user drew, for the whole video
  off: new Set(), // keys of items the user chose to show
  enabled: new Set(CATEGORIES.filter((c) => c.on).map((c) => c.id)),
  style: "box",
  lang: startLanguage(),
  done: false,
  showOriginal: false,
  runId: 0,
  busy: false,
};

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

// Models: text reading (Tesseract), faces (YuNet) and names (the text
// redactor's model). They download once, when the first video is opened.

const faceWorker = new Worker(new URL("./face-blur-worker.js", import.meta.url), { type: "module" });
const nerWorker = new Worker(new URL("./text-redactor-worker.js", import.meta.url), { type: "module" });
const waiting = new Map();
let requestId = 0;

function ask(worker, message, transfer = []) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

const progress = { ner: 0, ocr: 0 };
for (const worker of [faceWorker, nerWorker]) {
  worker.onmessage = ({ data }) => {
    if (worker === nerWorker && data.model && data.model !== modelFor(state.lang).id) {
      const stale = waiting.get(data.id);
      if (stale) {
        waiting.delete(data.id);
        stale.resolve([]);
      }
      return;
    }
    if (data.type === "progress" && worker === nerWorker && data.total) {
      progress.ner = data.loaded / data.total;
      showLoading();
      return;
    }
    const wait = waiting.get(data.id);
    if (!wait) return;
    if (data.type === "result") {
      waiting.delete(data.id);
      wait.resolve(data.faces || data.spans);
    } else if (data.type === "error") {
      waiting.delete(data.id);
      wait.reject(new Error(data.message));
    }
  };
}

let ocrWorker = null;
let modelsReady = null;

function loadModels() {
  if (!modelsReady) {
    modelBar.dataset.state = "loading";
    showLoading();
    const ocr = import(TESSERACT).then((mod) =>
      (mod.createWorker || mod.default.createWorker)(LANGUAGES[state.lang].tesseract, 1, {
        logger: (m) => {
          if (/loading|initializ/.test(m.status) && typeof m.progress === "number") {
            progress.ocr = m.progress;
            showLoading();
          }
        },
      })
    );
    faceWorker.postMessage({ type: "load" });
    nerWorker.postMessage({ type: "load", model: modelFor(state.lang).id });
    modelsReady = ocr.then(
      async (w) => {
        // "Sparse text": a screen has short pieces of text all over it.
        await w.setParameters({ tessedit_pageseg_mode: "11" });
        ocrWorker = w;
        modelBar.dataset.state = "ready";
        if (!state.input) setStatus("Runs on this device. Choose a screen recording.");
        try {
          localStorage.setItem("redacted:screencast:models", "1");
        } catch {}
      },
      (err) => {
        modelBar.dataset.state = "error";
        modelsReady = null;
        throw err;
      }
    );
  }
  return modelsReady;
}

function showLoading() {
  if (modelBar.dataset.state !== "loading") return;
  const pct = Math.round(((progress.ocr + progress.ner) / 2) * 100);
  if (pct >= 100) setStatus("Starting…", "busy");
  else setStatus(`Downloading AI (${modelFor(state.lang).size + 8} MB, once)… ${pct}%`, "busy");
}

try {
  // Start the models on their own only when they are already in the browser
  // cache, so no download happens before a video is opened.
  if (localStorage.getItem("redacted:screencast:models") === "1" && modelWasOn(modelFor(state.lang))) loadModels().catch(() => {});
} catch {}

// Names in the text, from the AI model. The same text is not read twice.
const nameCache = new Map();

async function nerSpans(text) {
  const model = modelFor(state.lang).id;
  const key = `${model}\n${text}`;
  if (!nameCache.has(key)) {
    let spans = [];
    try {
      spans = await ask(nerWorker, { type: "detect", model, text });
      rememberModel(modelFor(state.lang));
    } catch {}
    nameCache.set(key, spans);
  }
  return nameCache.get(key);
}

async function findNames(text) {
  if (!text.trim()) return [];
  const found = await nerSpans(text);
  // The model depends on the text around a name, and screen lines are short
  // ("Signed in as Maya Patel"). The small English model also reads each line
  // alone, and keeps clear people and places that start with a capital. Lines
  // that stay on screen come from the cache.
  const perLine = [];
  if (LANGUAGES[state.lang].model === "en") {
    let start = 0;
    for (const line of text.split("\n")) {
      if (/\p{L}{2}/u.test(line)) {
        const clear = (await nerSpans(line)).filter(
          (m) =>
            ((PERSON.has(m.label) && m.score >= 0.85) || (PLACE.has(m.label) && m.score >= 0.7)) &&
            /^\p{Lu}/u.test(line.slice(m.start, m.end))
        );
        perLine.push(...clear.map((m) => ({ ...m, start: m.start + start, end: m.end + start })));
      }
      start += line.length + 1;
    }
  }
  return splitAtLines(
    text,
    [...found, ...perLine].filter((m) => PERSON.has(m.label) || PLACE.has(m.label) || ORG.has(m.label))
  );
}

// Categories and controls

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
    renderItems();
    drawFrame();
  });
  chips.appendChild(b);
}

let customTimer = 0;
customInput.addEventListener("input", () => {
  clearTimeout(customTimer);
  customTimer = setTimeout(refresh, 300);
});

$("style").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-value]");
  if (!b) return;
  state.style = b.dataset.value;
  $("style").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  strengthControl.hidden = state.style === "box";
  drawFrame();
});
strength.addEventListener("input", drawFrame);

fillLanguageSelect(langSelect, state.lang);
langSelect.addEventListener("change", async () => {
  state.lang = langSelect.value;
  saveLanguage(state.lang);
  if (!ocrWorker) return;
  const runId = ++state.runId;
  setStatus(`Loading ${LANGUAGES[state.lang].label}…`, "busy");
  try {
    await ocrWorker.reinitialize(LANGUAGES[state.lang].tesseract);
  } catch (err) {
    setStatus(`Could not load this language. ${(err && err.message) || err}`, "error");
    return;
  }
  if (runId !== state.runId) return;
  // Read the open video again in the new language.
  if (state.track) await analyze(state.track, runId);
  else setStatus("Runs on this device. Choose a screen recording.");
});

// Opening a video

async function openFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) {
    setStatus("This file is not a video. Choose an MP4, MOV or WebM file.", "error");
    return;
  }
  if (!("VideoEncoder" in window)) {
    setStatus("Your browser cannot make videos. Use a recent version of Chrome, Edge, Safari or Firefox.", "error");
    return;
  }

  const runId = ++state.runId;
  setStatus("Reading the video…", "busy");
  let input;
  let track;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video");
  } catch {
    setStatus("This file could not be read as a video. Try an MP4, MOV or WebM file.", "error");
    return;
  }
  if (!(await track.canDecode())) {
    setStatus(`Your browser cannot read this video's format (${track.codec || "unknown"}). Try an MP4 file.`, "error");
    return;
  }
  const duration = await input.computeDuration();
  if (duration > MAX_SECONDS) {
    setStatus(`This video is ${formatTime(duration)} long. The limit is ${MAX_SECONDS / 60} minutes. Trim the video, then try again.`, "error");
    return;
  }

  state.file = file;
  state.input = input;
  state.track = track;
  state.width = track.displayWidth;
  state.height = track.displayHeight;
  state.duration = duration;
  state.manual = [];
  state.off.clear();

  // The preview is drawn at up to 1280 pixels wide.
  const k = Math.min(1, 1280 / state.width);
  canvas.width = Math.round(state.width * k);
  canvas.height = Math.round(state.height * k);

  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  scrubber.max = duration;
  scrubber.value = 0;
  download.disabled = true;
  note(downloadNote);
  drop.hidden = true;
  editor.hidden = false;

  try {
    await loadModels();
  } catch (err) {
    if (runId === state.runId) setStatus(`Could not load the AI models. ${(err && err.message) || err} Reload the page to try again.`, "error");
    return;
  }
  if (runId !== state.runId) return;
  await analyze(track, runId);
}

// Pass 1: read the screen where it changes, and find faces

async function analyze(track, runId) {
  state.snapshots = [];
  state.checks = [];
  state.faceTracks = [];
  state.items = [];
  state.done = false;
  renderItems();
  download.disabled = true;

  const scale = OCR_WIDTH / state.width;
  const ow = Math.round(state.width * scale);
  const oh = Math.round(state.height * scale);
  state.ocrScale = scale;
  const sink = new CanvasSink(track, { width: ow, height: oh, fit: "fill", poolSize: 2 });

  const dw = DIFF_WIDTH;
  const dh = Math.max(1, Math.round((oh * dw) / ow));
  const small = new OffscreenCanvas(dw, dh);
  const sctx = small.getContext("2d", { willReadFrequently: true });

  const start = await track.getFirstTimestamp();
  const times = [];
  for (let t = start; t < start + state.duration; t += STEP) times.push(t);

  const tracker = new Tracker({ maxGap: 2 });
  const faceScale = Math.min(1, FACE_WIDTH / ow);
  let prev = null;
  let words = [];
  let scrolled = 0;
  let n = 0;
  const started = performance.now();

  try {
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (runId !== state.runId) return;
      n++;
      if (!frame) continue;
      const t = frame.timestamp;

      // Where did the screen change since the last check?
      sctx.drawImage(frame.canvas, 0, 0, dw, dh);
      const gray = grayOf(sctx.getImageData(0, 0, dw, dh).data);
      const bands = prev ? changedBands(prev, gray, dw, dh) : [{ y0: 0, y1: dh }];
      const shift = prev && bands.length ? scrollShift(prev, gray, dw, dh) * (oh / dh) : 0;
      scrolled += shift;
      prev = gray;
      state.checks.push({ t, y: scrolled });

      if (bands.length) {
        const k = oh / dh;
        const changed = bands.reduce((sum, b) => sum + b.y1 - b.y0, 0) / dh;
        // A large change (a scroll, a new page) is read as one whole frame.
        const regions = changed > 0.4 || n === 1 ? [{ y0: 0, y1: oh }] : bands.map((b) => ({ y0: b.y0 * k, y1: b.y1 * k }));
        for (const r of regions) {
          if (runId !== state.runId) return;
          const found = await readRegion(frame.canvas, r);
          const touches = (w) => w.y < r.y1 && w.y + w.h > r.y0;
          words = [...words.filter((w) => !touches(w)), ...found.filter(touches)];
        }
        const lines = groupLines(words);
        const { text, parts } = linesText(lines);
        const rules = [...detectSecrets(text), ...domainSpans(text), ...usernameSpans(text), ...dateTimeSpans(text)];
        const modelSpans = await findNames(text);
        if (runId !== state.runId) return;
        state.snapshots.push({ t, y: scrolled, scroll: shift !== 0, bands: regions, text, parts, rules, modelSpans });
      }

      if ((n - 1) % FACE_EVERY === 0) {
        const bitmap = await createImageBitmap(frame.canvas, {
          resizeWidth: Math.round(ow * faceScale),
          resizeHeight: Math.round(oh * faceScale),
        });
        const k = 1 / (faceScale * scale);
        const found = (await ask(faceWorker, { type: "detect", bitmap, tile: 960, threshold: 0.6 }, [bitmap]).catch(() => [])).map(
          (f) => ({ x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k, score: f.score })
        );
        tracker.update(t, found);
      }

      if (n % 4 === 0) {
        const left = ((performance.now() - started) / n) * (times.length - n);
        setStatus(
          `Reading the screen… ${Math.round((n / times.length) * 100)}%` + (n > 8 ? ` · about ${formatTime(left / 1000)} left` : ""),
          "busy"
        );
      }
    }
  } catch (err) {
    if (runId !== state.runId) return;
    setStatus(`Could not scan the video. ${(err && err.message) || err}`, "error");
    return;
  }

  if (runId !== state.runId) return;
  state.faceTracks = groupTracks(keepTracks(tracker.tracks), { timing: FACE_TIMING });
  state.done = true;
  refresh();
  download.disabled = false;
}

// OCR one band of the frame, the full width of the screen, so that lines
// are not cut. Words are in frame pixels.
async function readRegion(source, r) {
  const pad = 12;
  const y0 = Math.max(0, Math.floor(r.y0) - pad);
  const y1 = Math.min(source.height, Math.ceil(r.y1) + pad);
  if (y1 - y0 < 8) return [];
  const crop = document.createElement("canvas");
  crop.width = source.width;
  crop.height = y1 - y0;
  const cctx = crop.getContext("2d", { willReadFrequently: true });
  cctx.drawImage(source, 0, y0, source.width, y1 - y0, 0, 0, source.width, y1 - y0);

  const passes = [crop];
  // Light text on a dark background (dark mode) reads better after it is
  // turned into dark text on white.
  const rgba = cctx.getImageData(0, 0, crop.width, crop.height).data;
  if (meanLuma(rgba) < 110) passes.push(maskCanvas(lightTextMask(rgba), crop.width, crop.height));

  const found = [];
  for (const pass of passes) {
    const { data } = await ocrWorker.recognize(pass, {}, { blocks: true });
    found.push(ocrWords(data).map((w) => ({ ...w, y: w.y + y0 })));
  }
  return mergeWords(...found);
}

function ocrWords(data) {
  return (data.blocks || []).flatMap((b) =>
    b.paragraphs.flatMap((p) =>
      p.lines.flatMap((l) =>
        l.words.map((w) => ({
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          conf: w.confidence,
        }))
      )
    )
  );
}

function maskCanvas(mask, width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const img = new ImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = mask[i];
    img.data[i * 4 + 3] = 255;
  }
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

function grayOf(rgba) {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return gray;
}

function meanLuma(rgba) {
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 16) sum += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  return sum / (rgba.length / 16);
}

// Rows of the small frame that changed, joined into bands. Video compression
// changes pixels a little, so only clear changes count.
function changedBands(prev, gray, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0, i = y * w; x < w; x++, i++) if (Math.abs(gray[i] - prev[i]) > 24) count++;
    if (count >= 2) rows.push(y);
  }
  const bands = [];
  for (const y of rows) {
    const last = bands[bands.length - 1];
    if (last && y - last.y1 <= 3) last.y1 = y + 1;
    else bands.push({ y0: y, y1: y + 1 });
  }
  return bands.map((b) => ({ y0: Math.max(0, b.y0 - 1), y1: Math.min(h, b.y1 + 1) }));
}

// How far the screen scrolled up between two frames, in rows of the small
// frame (0 when it did not scroll). It compares each row with the rows a few
// steps higher and lower, and keeps the best match.
function scrollShift(prev, gray, w, h) {
  const cost = (s) => {
    let sum = 0;
    let n = 0;
    for (let y = Math.max(0, -s); y < Math.min(h, h - s); y += 2) {
      for (let x = 0, i = y * w, j = (y + s) * w; x < w; x += 2) sum += Math.abs(gray[i + x] - prev[j + x]);
      n++;
    }
    return n > h / 6 ? sum / n : Infinity;
  };
  const still = cost(0);
  let best = 0;
  let bestCost = still;
  for (let s = 1; s < h / 2; s++) {
    for (const d of [s, -s]) {
      const c = cost(d);
      if (c < bestCost) {
        best = d;
        bestCost = c;
      }
    }
  }
  return bestCost < still * 0.6 ? best : 0;
}

// Items: the same text in the whole video is one item, so one click shows or
// hides it everywhere.

function refresh() {
  if (!state.done) return;
  const items = new Map();
  const terms = parseTerms(customInput.value);
  const k = 1 / state.ocrScale;

  for (const snap of state.snapshots) {
    snap.entries = [];
    const found = collectSpans(snap.text.replace(/\n/g, " "), {
      modelSpans: snap.modelSpans,
      terms,
      enabled: ALL,
      extra: snap.rules,
      tagCategory: TAGS,
    });
    // A misread letter before the "@" (such as "|" for "l") stops the email
    // rule, and only the domain is found. Cover the whole word.
    for (const f of found) {
      if (snap.text[f.start - 1] !== "@") continue;
      let start = f.start - 1;
      while (start > 0 && !/\s/.test(snap.text[start - 1])) start--;
      f.start = start;
      f.tag = "EMAIL";
    }
    const spans = splitAtLines(snap.text, found);
    const seen = new Map();
    for (const s of spans) {
      const value = snap.text.slice(s.start, s.end);
      if (s.tag === "NAME" && !/^\p{L}/u.test(value)) continue;
      if (s.tag === "NAME" && (value.match(/\p{L}/gu) || []).length < 2 && !/[\p{Script=Han}\p{Script=Hangul}]/u.test(value)) continue;
      const key = `${s.tag}:${value.toLowerCase().replace(/\s+/g, " ")}`;
      if (!items.has(key)) {
        items.set(key, { key, kind: "text", tag: s.tag, text: value, cat: s.tag === "CUSTOM" ? "custom" : TAGS[s.tag], first: snap.t, last: snap.t });
      }
      const item = items.get(key);
      item.last = snap.t;
      spanBoxes(s, snap.parts).forEach((b) => {
        // The same text can show more than once on a screen.
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        const pad = b.h * 0.25;
        snap.entries.push({
          item,
          n,
          box: { x: (b.x - pad) * k, y: (b.y - pad) * k, w: (b.w + 2 * pad) * k, h: (b.h + 2 * pad) * k },
        });
      });
    }
  }

  // Typing: before "jordan@example.com" is an email, the screen shows
  // "jord", "jordan@ex" and so on. When an item first shows, cover the same
  // place in the checks before it that show the start of the same text.
  state.snapshots.forEach((snap, i) => {
    for (const e of snap.entries) {
      if (e.item.first !== snap.t || e.item.text.length < 6) continue;
      const full = e.item.text.toLowerCase();
      for (let j = i - 1; j >= 0; j--) {
        const prev = state.snapshots[j];
        const typed = prev.text
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length >= 2 && full.startsWith(w) && w !== full);
        if (!typed || prev.y !== snap.y) break;
        prev.entries.push({ item: e.item, n: e.n, box: e.box, typed: true });
        e.item.first = Math.min(e.item.first, prev.t);
      }
    }
  });

  // The text reader can miss an item in one check and read it in the next.
  // If the screen only scrolled, or did not change around the item, between
  // two checks, the item was on screen in both: carry it to the check that
  // missed it, forward and backward, moved with the scroll.
  const snaps = state.snapshots;
  const carry = (from, to, change) => {
    const dy = (to.y - from.y) * k;
    for (const e of from.entries) {
      if ((e.carry || 0) >= CARRY) continue;
      if (to.entries.some((x) => x.item === e.item && x.n === e.n)) continue;
      const box = { ...e.box, y: e.box.y - dy };
      if (box.y + box.h < 0 || box.y > state.height) continue;
      if (!change.scroll && change.bands.some((r) => box.y < r.y1 * k && box.y + box.h > r.y0 * k)) continue;
      to.entries.push({ item: e.item, n: e.n, box, carry: (e.carry || 0) + 1 });
    }
  };
  for (let i = 1; i < snaps.length; i++) carry(snaps[i - 1], snaps[i], snaps[i]);
  for (let i = snaps.length - 1; i > 0; i--) carry(snaps[i], snaps[i - 1], snaps[i]);
  for (const snap of snaps) for (const e of snap.entries) e.item.first = Math.min(e.item.first, snap.t);

  // Each snapshot lasts until the next one.
  state.snapshots.forEach((snap, i) => {
    const next = state.snapshots[i + 1];
    if (next) for (const e of snap.entries) e.item.last = Math.max(e.item.last, next.t);
    else for (const e of snap.entries) e.item.last = Math.max(e.item.last, state.duration);
  });

  const faces = state.faceTracks
    .filter((tr) => !tr.parent)
    .map((tr, i) => ({ key: `face:${tr.id}`, kind: "face", tag: "FACE", text: `Face ${i + 1}`, cat: "faces", track: tr, first: tr.keys[0].t, last: tr.keys[tr.keys.length - 1].t }));

  state.items = [...items.values(), ...faces].sort((a, b) => a.first - b.first);
  renderItems();
  drawFrame();
}

const categoryOn = (cat) => cat === "custom" || state.enabled.has(cat);
const isOn = (item) => categoryOn(item.cat) && !state.off.has(item.key);

// Boxes to hide at time t, in the given frame size.
function boxesAt(t, width, height) {
  const k = width / state.width;
  const out = [];
  const scaled = (b, shape) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k, shape });

  // Text: the snapshot on screen at t, and the one before it while the
  // screen changes from one to the other. Text in both is covered along its
  // whole path, for a scroll.
  const snaps = state.snapshots;
  let i = -1;
  for (let lo = 0, hi = snaps.length - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid].t - STEP <= t) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i >= 0 && snaps[i].entries) {
    // Between two checks the screen can scroll: cover each box at both
    // checks' scroll positions and all the way between them.
    const [a, b] = checksAround(t);
    const ks = 1 / state.ocrScale;
    const moved = (snap, e) => {
      const at = (c) => ({ ...e.box, y: e.box.y - (c.y - snap.y) * ks });
      return hull(at(a), at(b));
    };
    const now = snaps[i].entries.filter((e) => isOn(e.item));
    const before = i > 0 && t <= snaps[i].t ? snaps[i - 1].entries.filter((e) => isOn(e.item)) : [];
    const used = new Set();
    for (const e of now) {
      const old = before.find((o) => o.item === e.item && o.n === e.n);
      if (old) used.add(old);
      out.push(scaled(old ? hull(moved(snaps[i - 1], old), moved(snaps[i], e)) : moved(snaps[i], e), "rect"));
    }
    for (const o of before) if (!used.has(o)) out.push(scaled(moved(snaps[i - 1], o), "rect"));
  }

  for (const item of state.items) {
    if (item.kind !== "face" || !isOn(item)) continue;
    for (const tr of [item.track, ...state.faceTracks.filter((x) => x.parent === item.track)]) {
      const b = coverAt(tr, t, FACE_TIMING);
      if (b) out.push({ ...padBox({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }, width, height, MOTION_PAD), shape: "oval" });
    }
  }

  for (const m of state.manual) out.push(scaled(m, "rect"));
  return out;
}

// The checked frames just before and just after t.
function checksAround(t) {
  const c = state.checks;
  if (!c.length) return [{ y: 0 }, { y: 0 }];
  let lo = 0;
  let hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return [c[lo], c[Math.min(c.length - 1, lo + (c[lo].t < t ? 1 : 0))]];
}

const hull = (a, b) => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

const options = (shape) => ({ style: state.style, strength: +strength.value, shape });

// Items list

const label = (cat) => (CATEGORIES.find((c) => c.id === cat) || { label: "Your words" }).label;

function renderItems() {
  itemsEl.replaceChildren();
  const shown = state.items.filter((item) => categoryOn(item.cat));
  for (const item of shown) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "person";
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = item.text.length > 42 ? `${item.text.slice(0, 40)}…` : item.text;
    const small = document.createElement("small");
    small.textContent = `${label(item.cat)} · ${formatTime(item.first)}–${formatTime(item.last)}`;
    const em = document.createElement("em");
    span.append(strong, small, em);
    b.appendChild(span);
    const update = () => {
      b.setAttribute("aria-pressed", String(isOn(item)));
      em.textContent = isOn(item) ? "Hidden" : "Shown";
    };
    update();
    b.addEventListener("click", () => {
      if (state.off.has(item.key)) state.off.delete(item.key);
      else state.off.add(item.key);
      update();
      updateStatus();
      drawFrame();
    });
    itemsEl.appendChild(b);
  }
  state.manual.forEach((m, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "person";
    b.setAttribute("aria-pressed", "true");
    b.innerHTML = `<span><strong>Your box ${i + 1}</strong><small>Whole video</small><em>Click to remove</em></span>`;
    b.addEventListener("click", () => {
      state.manual.splice(state.manual.indexOf(m), 1);
      renderItems();
      drawFrame();
    });
    itemsEl.appendChild(b);
  });
  updateStatus();
}

function updateStatus() {
  if (!state.done) return;
  const shown = state.items.filter((item) => categoryOn(item.cat));
  const on = shown.filter(isOn).length + state.manual.length;
  if (!shown.length && !state.manual.length) {
    setStatus("Nothing private found. Drag on the video to hide an area.");
  } else {
    setStatus(`${shown.length} found · ${on} hidden. Click an item below to show it. Drag on the video to hide an area.`);
  }
}

// Preview

function drawFrame() {
  if (video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (!state.showOriginal) {
    for (const box of boxesAt(video.currentTime, canvas.width, canvas.height)) cover(ctx, canvas, box, options(box.shape));
  }
  scrubber.value = video.currentTime;
  timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(state.duration)}`;
}

function loop() {
  drawFrame();
  if (video.paused || video.ended) return;
  if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

video.addEventListener("loadeddata", drawFrame);
video.addEventListener("seeked", drawFrame);
video.addEventListener("play", () => {
  playButton.textContent = "Pause";
  loop();
});
video.addEventListener("pause", () => (playButton.textContent = "Play"));
video.addEventListener("ended", () => (playButton.textContent = "Play"));

playButton.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
scrubber.addEventListener("input", () => (video.currentTime = +scrubber.value));

const showOriginal = (on) => {
  state.showOriginal = on;
  drawFrame();
};
original.addEventListener("pointerdown", () => showOriginal(true));
["pointerup", "pointerleave", "pointercancel"].forEach((t) => original.addEventListener(t, () => showOriginal(false)));
original.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && showOriginal(true));
original.addEventListener("keyup", () => showOriginal(false));

// Drawing a box that hides an area for the whole video (a sidebar with an
// account name, a browser tab, a notification corner).

let drag = null;

boxesEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !state.input) return;
  drag = { start: toVideo(e), el: null };
  boxesEl.setPointerCapture(e.pointerId);
});

boxesEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const r = rectFrom(drag.start, toVideo(e));
  if (!drag.el) {
    if (Math.max(r.w, r.h) < (6 * state.width) / boxesEl.clientWidth) return;
    drag.el = document.createElement("div");
    drag.el.className = "draft";
    boxesEl.appendChild(drag.el);
  }
  Object.assign(drag.el.style, {
    left: `${(r.x / state.width) * 100}%`,
    top: `${(r.y / state.height) * 100}%`,
    width: `${(r.w / state.width) * 100}%`,
    height: `${(r.h / state.height) * 100}%`,
  });
});

boxesEl.addEventListener("pointerup", (e) => {
  if (!drag) return;
  if (drag.el) {
    const r = rectFrom(drag.start, toVideo(e));
    drag.el.remove();
    if (r.w > 4 && r.h > 4) {
      state.manual.push(r);
      renderItems();
      drawFrame();
    }
  }
  drag = null;
});

boxesEl.addEventListener("pointercancel", () => {
  if (drag && drag.el) drag.el.remove();
  drag = null;
});

function toVideo(e) {
  const rect = boxesEl.getBoundingClientRect();
  return {
    x: Math.min(state.width, Math.max(0, ((e.clientX - rect.left) / rect.width) * state.width)),
    y: Math.min(state.height, Math.max(0, ((e.clientY - rect.top) / rect.height) * state.height)),
  };
}

const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

// Pass 2: make the new video

download.addEventListener("click", async () => {
  if (state.busy || !state.input) return;
  state.busy = true;
  busy(download, "Making video…");
  note(downloadNote);
  video.pause();

  const big = Math.max(state.width, state.height) > MAX_SIDE;
  const outWidth = big ? Math.round((state.width * MAX_SIDE) / Math.max(state.width, state.height) / 2) * 2 : state.width;
  const outHeight = big ? Math.round((state.height * MAX_SIDE) / Math.max(state.width, state.height) / 2) * 2 : state.height;
  const frame = new OffscreenCanvas(outWidth, outHeight);
  const fctx = frame.getContext("2d");

  try {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input: state.input,
      output,
      showWarnings: false,
      // Do not copy metadata such as the location or the device name.
      tags: {},
      video: {
        codec: "avc",
        allowTransformationMetadata: false,
        ...(big ? { width: outWidth, height: outHeight, fit: "fill" } : {}),
        processedWidth: outWidth,
        processedHeight: outHeight,
        process: (sample) => {
          sample.draw(fctx, 0, 0, outWidth, outHeight);
          for (const box of boxesAt(sample.timestamp, outWidth, outHeight)) cover(fctx, frame, box, options(box.shape));
          return frame;
        },
      },
      audio: { discard: !keepAudio.checked },
    });

    if (!conversion.isValid) {
      const v = conversion.discardedTracks.find((d) => d.track.type === "video");
      throw new Error(v ? `The video track cannot be converted (${v.reason}).` : "The video cannot be converted.");
    }
    const lostAudio = keepAudio.checked && conversion.discardedTracks.some((d) => d.track.type === "audio");

    conversion.onProgress = (p) => busy(download, `Making video… ${Math.round(p * 100)}%`);
    await conversion.execute();

    const blob = new Blob([output.target.buffer], { type: "video/mp4" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = downloadName(`${state.file.name.replace(/\.[^.]+$/, "") || "screencast"}-redacted.mp4`);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    note(
      downloadNote,
      `Done. Your video is downloaded.${lostAudio ? " The audio could not be converted in this browser, so the video has no sound." : ""}`
    );
  } catch (err) {
    note(downloadNote, `Could not make the video. ${(err && err.message) || err}`, "error");
  } finally {
    state.busy = false;
    idle(download);
  }
});

// Loading a file

function reset() {
  state.runId++;
  state.input = null;
  state.track = null;
  state.snapshots = [];
  state.items = [];
  state.manual = [];
  state.done = false;
  video.pause();
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute("src");
  itemsEl.replaceChildren();
  editor.hidden = true;
  drop.hidden = false;
  fileInput.value = "";
  setStatus(modelBar.dataset.state === "ready" ? "Runs on this device. Choose a screen recording." : "AI models download once when you open a video.");
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
  setStatus("Loading the example video…", "busy");
  const blob = await (await fetch(SAMPLE)).blob();
  await openFile(new File([blob], "app-demo.mp4", { type: "video/mp4" }));
});

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
