// The shared page logic for the screenshot tools (Screenshot Redactor, Chat
// Screenshot Anonymizer): OCR, face and avatar detection, name detection,
// boxes, styles and download. OCR, face detection and name detection all run
// in this tab. The screenshot is never uploaded. Each tool calls
// startScreenshotTool() with its own settings.
import { TAG_CATEGORY, collectSpans, parseTerms } from "./pii-spans.js";
import {
  lightTextMask,
  colorTextMask,
  domainSpans,
  mergeWords,
  groupLines,
  linesText,
  spanBoxes,
  headerSpans,
  colorNameSpans,
  splitAtLines,
  findCircles,
  usernameSpans,
  dateTimeSpans,
  notOnText,
} from "./screenshot-core.js";
import { padBox, cover } from "./blur-core.js";
import { pseudonymizer } from "./fake-names.js";
import { busy, idle, note, downloadName } from "./busy.js";
import { LANGUAGES, startLanguage, saveLanguage, modelFor, fillLanguageSelect, rememberModel, modelWasOn } from "./languages.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js";
const MAX_PIXELS = 16_000_000;

export const SCREENSHOT_CATEGORIES = [
  { id: "name", label: "Names", on: true },
  { id: "faces", label: "Faces & profile pictures", on: true },
  { id: "contact", label: "Emails & phones", on: true },
  { id: "tech", label: "Links & usernames", on: true },
  { id: "place", label: "Places & addresses", on: true },
  { id: "org", label: "Organizations", on: true },
  { id: "finance", label: "Card & bank numbers", on: true },
  { id: "id", label: "ID numbers", on: true },
  { id: "date", label: "Dates & times", on: false },
];

// options:
//   sample, sampleName   example screenshot for "Try an example"
//   categories           category chips: { id, label, on }
//   tagCategory          tag -> category id
//   chatRules            true to find chat names in the header and colored sender names
//   detect(text)         extra spans from the tool's own rules
//   fileSuffix           added to the downloaded file name
export function startScreenshotTool({
  sample,
  sampleName = "screenshot.png",
  categories = SCREENSHOT_CATEGORIES,
  tagCategory = {},
  chatRules = false,
  detect = () => [],
  fileSuffix = "redacted",
}) {
  const CATEGORIES = categories;
  const TAGS = { ...TAG_CATEGORY, FACE: "faces", USERNAME: "tech", ...tagCategory };

  const $ = (id) => document.getElementById(id);
  const drop = $("drop");
  const fileInput = $("file");
  const editor = $("editor");
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  const boxesEl = $("boxes");
  const status = $("status");
  const modelBar = $("model");
  const chips = $("categories");
  const customInput = $("custom");
  const langSelect = $("ocr-lang");
  const strength = $("strength");
  const strengthControl = $("strength-control");
  const download = $("download");
  const downloadNote = $("download-note");
  const original = $("original");

  const state = {
    image: null, // canvas with the screenshot
    name: "screenshot",
    enabled: new Set(CATEGORIES.filter((c) => c.on).map((c) => c.id)),
    style: document.querySelector('#style [aria-pressed="true"]').dataset.value,
    lang: startLanguage(),
    ocr: null, // { lines, text, parts }
    modelSpans: [],
    faces: [],
    manual: [],
    off: new Set(), // keys of boxes the user chose to show
    boxes: [],
    runId: 0,
    showOriginal: false,
  };

  function setStatus(text, kind = "") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  // Models

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
      // Ignore name model messages for a language that is no longer chosen.
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
        if (modelBar.dataset.state === "ready" && state.ocr && !state.namesDone) {
          setStatus(`Downloading the name model… ${Math.round(progress.ner * 100)}%`, "busy");
        } else if (modelBar.dataset.state === "ready") {
          idleStatus();
        }
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
        (w) => {
          ocrWorker = w;
          modelBar.dataset.state = "ready";
          idleStatus();
          try {
            localStorage.setItem("redacted:screenshot:models", "1");
          } catch {}
        },
        (err) => {
          modelBar.dataset.state = "error";
          modelsReady = null;
          if (!state.image) setStatus(`Could not load the AI models. ${(err && err.message) || err} Reload the page to try again.`, "error");
          throw err;
        }
      );
    }
    return modelsReady;
  }

  function showLoading() {
    if (modelBar.dataset.state !== "loading") return;
    const pct = Math.round(((progress.ocr + progress.ner) / 2) * 100);
    // After the download, the models still need a moment to start.
    if (pct >= 100) setStatus("Starting the AI models…", "busy");
    else setStatus(`Downloading the AI models (about ${modelFor(state.lang).size + 8} MB, one time)… ${pct}%`, "busy");
  }

  // The status when no screenshot is open.
  function idleStatus() {
    if (state.image) return;
    if (progress.ner > 0 && progress.ner < 1) {
      setStatus(`Downloading the name model… ${Math.round(progress.ner * 100)}%`, "busy");
    } else {
      setStatus("The AI models run on this device. Choose a screenshot to start.");
    }
  }

  try {
    // Start the models on their own only when they are already in the
    // browser cache, so no download happens before a screenshot is opened.
    if (localStorage.getItem("redacted:screenshot:models") === "1" && modelWasOn(modelFor(state.lang))) loadModels().catch(() => {});
  } catch {}

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
      refresh();
    });
    chips.appendChild(b);
  }

  $("style").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    state.style = b.dataset.value;
    $("style").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    strengthControl.hidden = state.style === "box";
    render();
  });
  strength.addEventListener("input", render);

  // Text language
  if (langSelect) {
    fillLanguageSelect(langSelect, state.lang);
    langSelect.addEventListener("change", async () => {
      state.lang = langSelect.value;
      saveLanguage(state.lang);
      if (!ocrWorker) return;
      const runId = ++state.runId;
      setStatus(`Loading ${LANGUAGES[state.lang].label}…`, "busy");
      // The name model for the new language loads when a screenshot needs
      // it, not now.
      progress.ner = 0;
      try {
        await ocrWorker.reinitialize(LANGUAGES[state.lang].tesseract);
      } catch (err) {
        setStatus(`Could not load this language. ${(err && err.message) || err}`, "error");
        return;
      }
      if (runId !== state.runId) return;
      // Read the open screenshot again in the new language.
      if (state.image) {
        state.ocr = null;
        state.modelSpans = [];
        state.off.clear();
        try {
          await analyze(state.image, runId);
        } catch (err) {
          if (runId === state.runId) setStatus(`Could not read the screenshot. ${(err && err.message) || err}`, "error");
        }
      } else {
        idleStatus();
      }
    });
  }

  // Opening a screenshot

  async function openFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("This file is not an image. Choose a PNG or JPG screenshot.", "error");
      return;
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      setStatus("Your browser cannot read this image. Try a PNG or JPG screenshot.", "error");
      return;
    }
    const runId = ++state.runId;
    state.name = file.name.replace(/\.[^.]+$/, "") || "screenshot";

    let { width, height } = bitmap;
    if (width * height > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / (width * height));
      width = Math.floor(width * k);
      height = Math.floor(height * k);
    }
    const work = document.createElement("canvas");
    work.width = width;
    work.height = height;
    work.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    canvas.width = width;
    canvas.height = height;

    state.image = work;
    state.ocr = null;
    state.modelSpans = [];
    state.faces = [];
    state.manual = [];
    state.off.clear();
    drop.hidden = true;
    editor.hidden = false;
    download.disabled = true;
    note(downloadNote);
    render();

    try {
      await loadModels();
      if (runId !== state.runId) return;
      await analyze(work, runId);
    } catch (err) {
      if (runId !== state.runId) return;
      setStatus(`Could not read the screenshot. ${(err && err.message) || err} You can still drag on it to add boxes.`, "error");
      download.disabled = false;
    }
  }

  async function analyze(image, runId) {
    const { width, height } = image;
    const rgba = image.getContext("2d").getImageData(0, 0, width, height).data;

    setStatus("Looking for faces…", "busy");
    const faceBitmap = await createImageBitmap(image);
    const facesDone = ask(faceWorker, { type: "detect", bitmap: faceBitmap, tile: 960 }, [faceBitmap]).catch(() => []);

    setStatus("Reading the text…", "busy");
    const passes = [image, maskCanvas(lightTextMask(rgba), width, height), maskCanvas(colorTextMask(rgba), width, height)];
    const words = [];
    for (const [i, pass] of passes.entries()) {
      if (runId !== state.runId) return;
      setStatus(`Reading the text… ${i + 1}/${passes.length}`, "busy");
      const { data } = await ocrWorker.recognize(pass, {}, { blocks: true });
      words.push(ocrWords(data));
    }
    // A phone's status bar (time, signal, battery) is not part of the screen.
    // Text read inside an avatar is noise from the picture.
    const top = isPhone(width, height) ? height * 0.045 : 0;
    const allWords = mergeWords(...words).filter((w) => w.y + w.h / 2 > top);
    // A shape found on text is a letter, not an avatar.
    const avatars = notOnText(findAvatars(image), allWords);
    const inAvatar = (w) => avatars.some((a) => w.x + w.w / 2 > a.x && w.x + w.w / 2 < a.x + a.w && w.y + w.h / 2 > a.y && w.y + w.h / 2 < a.y + a.h);
    const lines = groupLines(allWords.filter((w) => !inAvatar(w)));
    const { text, parts } = linesText(lines);
    const rules = [
      ...detect(text),
      ...(chatRules ? [...headerSpans(lines, parts, width, height), ...colorNameSpans(lines, parts, rgba, width)] : []),
      ...domainSpans(text),
      ...usernameSpans(text),
      ...dateTimeSpans(text),
    ];
    // The usual text height, to keep fake names at a normal size.
    const heights = lines.map((l) => l.h).sort((a, b) => a - b);
    state.ocr = { lines, text, parts, rules, textHeight: heights[Math.floor(heights.length / 2)] || 30 };

    // Avatars: circles, and small faces (shown as a whole circle).
    const faces = (await facesDone).map((f) => faceBox(f, width, height));
    const inside = (f, a) => f.x + f.w / 2 > a.x && f.x + f.w / 2 < a.x + a.w && f.y + f.h / 2 > a.y && f.y + f.h / 2 < a.y + a.h;
    state.faces = [...avatars, ...faces.filter((f) => !avatars.some((a) => inside(f, a)))];
    if (runId !== state.runId) return;
    refresh();
    download.disabled = false;

    state.namesDone = false;
    setStatus("Looking for names…", "busy");
    try {
      // The model depends a lot on the text around a name, and screenshot
      // lines are short. So it reads the full text and each line alone, and
      // the results are joined.
      const model = modelFor(state.lang).id;
      const found = text.trim() ? await ask(nerWorker, { type: "detect", model, text }) : [];
      const lineTexts = [];
      let start = 0;
      for (const line of text.split("\n")) {
        if (/\p{L}{2}/u.test(line)) lineTexts.push({ start, line });
        start += line.length + 1;
      }
      // One after the other: the model runs one text at a time. Only the
      // small English model needs this. The multilingual and Thai models
      // read short lines well, and alone they mark words such as "Moi" or
      // "Genial" at the start of a line as names.
      const perLine = [];
      for (const { start, line } of LANGUAGES[state.lang].model === "en" ? lineTexts : []) {
        if (runId !== state.runId) return;
        const spans = await ask(nerWorker, { type: "detect", model, text: line });
        // A line alone gives more false results, so keep only clear people
        // and places that start with a capital letter.
        const clear = spans.filter(
          (m) =>
            ((PERSON.has(m.label) && m.score >= 0.85) || (PLACE.has(m.label) && m.score >= 0.7)) &&
            /^\p{Lu}/u.test(line.slice(m.start, m.end))
        );
        perLine.push(clear.map((m) => ({ ...m, start: m.start + start, end: m.end + start })));
      }
      // On OCR text the model is reliable for names, organizations and places.
      // The pattern rules find numbers, emails and links.
      rememberModel(modelFor(state.lang));
      state.modelSpans = splitAtLines(
        text,
        [...found, ...perLine.flat()].filter((m) => PERSON.has(m.label) || PLACE.has(m.label) || ORG.has(m.label))
      );
    } catch {
      state.modelSpans = [];
    }
    state.namesDone = true;
    if (runId !== state.runId) return;
    refresh();
  }

  function ocrWords(data) {
    return data.blocks.flatMap((b) =>
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

  // Find avatar circles at screen size, then scale them back to the image.
  // A phone screenshot is drawn 390 points wide, where avatars have a radius
  // of about 9 to 28 points. A computer screenshot is drawn at most 1440
  // pixels wide, where avatars have a radius of about 10 to 48.
  function findAvatars(image) {
    const phone = isPhone(image.width, image.height);
    const W = phone ? 390 : Math.min(1440, image.width);
    const k = W / image.width;
    const H = Math.round(image.height * k);
    const small = document.createElement("canvas");
    small.width = W;
    small.height = H;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(image, 0, 0, W, H);
    const rgba = sctx.getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    // On a phone, skip the status bar and the message box at the bottom.
    const range = phone ? { minR: 9, maxR: 28, top: Math.round(H * 0.045), bottom: Math.round(H * 0.91) } : { minR: 10, maxR: 48 };
    const circles = findCircles(gray, W, H, range);
    // Round emojis are mostly yellow inside. They are not avatars.
    const yellow = (c) => {
      let n = 0;
      let y = 0;
      for (let j = Math.round(c.y + c.h * 0.2); j < c.y + c.h * 0.8; j++) {
        for (let i = Math.round(c.x + c.w * 0.2); i < c.x + c.w * 0.8; i++) {
          const p = (j * W + i) * 4;
          n++;
          if (rgba[p] > 190 && rgba[p + 1] > 140 && rgba[p + 2] < 110) y++;
        }
      }
      return n && y / n > 0.35;
    };
    return circles.filter((c) => !yellow(c)).map((c) => {
      // A little larger than the circle, so its edge is covered too.
      const pad = c.w * 0.08;
      // Circles are covered as ovals, rounded squares as squares.
      return { x: c.x / k - pad / k, y: c.y / k - pad / k, w: (c.w + 2 * pad) / k, h: (c.h + 2 * pad) / k, tag: "FACE", round: c.n === 2 };
    });
  }

  // A small face is usually a profile picture: cover the whole circle.
  function faceBox(f, width, height) {
    if (f.w < width * 0.08) {
      const side = f.w * 2;
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      return { x: Math.max(0, cx - side / 2), y: Math.max(0, cy - side / 2), w: side, h: side, tag: "FACE", round: true };
    }
    return { ...padBox(f, width, height, 0.05), tag: "FACE", round: true };
  }

  // Boxes

  function refresh() {
    const boxes = [];
    if (state.ocr) {
      const { text, parts, rules } = state.ocr;
      const spans = splitAtLines(
        text,
        // Lines in a chat bubble wrap, so a phone number or an email can
        // start on one line and end on the next. The rules read the text as
        // one long line (same length, so the positions do not change), and
        // splitAtLines() makes one box for each line again.
        collectSpans(text.replace(/\n/g, " "), {
          modelSpans: state.modelSpans,
          terms: parseTerms(customInput.value),
          enabled: state.enabled,
          extra: rules,
          tagCategory: TAGS,
        })
      );
      for (const s of spans) {
        const value = text.slice(s.start, s.end);
        // OCR noise such as "Z" or "4 v" is not a name.
        if (s.tag === "NAME" && !/^\p{L}/u.test(value)) continue;
        if (s.tag === "NAME" && (value.match(/\p{L}/gu) || []).length < 2 && !/[\p{Script=Han}\p{Script=Hangul}]/u.test(value)) continue;
        // A colored name brings its own box, which can be wider than the
        // words OCR read.
        const rule = rules.find((r) => r.box && r.start === s.start && r.end === s.end);
        (rule ? [rule.box] : spanBoxes(s, parts)).forEach((b, i) => {
          const pad = b.h * 0.18;
          boxes.push({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad, tag: s.tag, text: value, key: `${s.start}:${s.end}:${i}` });
        });
      }
    }
    if (state.enabled.has("faces")) state.faces.forEach((f, i) => boxes.push({ ...f, key: `face:${i}` }));
    state.boxes = boxes;
    render();
    updateStatus();
  }

  const isOn = (b) => (b.manual ? b.on : !state.off.has(b.key));
  const allBoxes = () => [...state.boxes, ...state.manual];

  function updateStatus() {
    if (!state.ocr) return;
    const all = allBoxes();
    const on = all.filter(isOn).length;
    const names = new Set(all.filter((b) => b.tag === "NAME" && isOn(b)).map((b) => b.text.toLowerCase())).size;
    const faces = all.filter((b) => b.tag === "FACE" && isOn(b)).length;
    setStatus(
      `${on} ${on === 1 ? "area" : "areas"} hidden: ${names} ${names === 1 ? "name" : "names"}, ${faces} ${faces === 1 ? "face" : "faces"}${on - faces > 0 ? " and other details" : ""}. Click a box to show it. Drag to add a box.`
    );
  }

  // Rendering

  function render() {
    if (!state.image) return;
    ctx.drawImage(state.image, 0, 0);
    if (!state.showOriginal) {
      const fake = pseudonymizer();
      const options = { style: state.style === "fake" ? "blur" : state.style, strength: +strength.value };
      for (const b of allBoxes()) {
        if (!isOn(b)) continue;
        if (state.style === "fake" && b.tag === "NAME") drawFakeName(b, fake(b.text));
        else cover(ctx, state.image, b, { ...options, shape: b.round ? "oval" : "rect" });
      }
    }
    drawBoxes();
  }

  // Paint over a name in the colors of the screenshot, and write a fake name.
  function drawFakeName(b, fakeName) {
    const sctx = state.image.getContext("2d");
    const x = Math.max(0, Math.floor(b.x));
    const y = Math.max(0, Math.floor(b.y));
    const w = Math.min(state.image.width - x, Math.ceil(b.w));
    const h = Math.min(state.image.height - y, Math.ceil(b.h));
    if (w < 2 || h < 2) return;
    const px = sctx.getImageData(x, y, w, h).data;

    // The background is the color of the box edge; the text is the color
    // farthest from it.
    const edge = [];
    for (let i = 0; i < w; i++) edge.push(pixel(px, w, i, 0), pixel(px, w, i, h - 1));
    for (let j = 0; j < h; j++) edge.push(pixel(px, w, 0, j), pixel(px, w, w - 1, j));
    const bg = median(edge);
    let fg = bg;
    let far = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const p = pixel(px, w, i, j);
        const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
        if (d > far) {
          far = d;
          fg = p;
        }
      }
    }

    ctx.fillStyle = `rgb(${bg.join(",")})`;
    ctx.fillRect(x, y, w, h);
    // The OCR box holds the letters only (no padding): about 0.72 of the font
    // size. Keep the size near the usual text size of the screenshot.
    const textHeight = (state.ocr && state.ocr.textHeight) || h;
    const size = Math.round(Math.min(h / 1.36, textHeight * 1.5) / 0.72);
    ctx.font = `500 ${size}px -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = `rgb(${fg.join(",")})`;
    ctx.textBaseline = "middle";
    // Squeeze a long fake name a little, so it does not cover the next word.
    ctx.fillText(fakeName, x + h * 0.18, y + h / 2, w * 1.1);
  }

  const pixel = (px, w, i, j) => {
    const k = (j * w + i) * 4;
    return [px[k], px[k + 1], px[k + 2]];
  };

  function median(list) {
    return [0, 1, 2].map((c) => {
      const v = list.map((p) => p[c]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    });
  }

  function drawBoxes() {
    const W = canvas.width;
    const H = canvas.height;
    boxesEl.querySelectorAll(".face").forEach((el) => el.remove());
    allBoxes().forEach((b, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `face${isOn(b) ? "" : " is-off"}${b.round ? " is-oval" : ""}`;
      el.style.left = `${(b.x / W) * 100}%`;
      el.style.top = `${(b.y / H) * 100}%`;
      el.style.width = `${(b.w / W) * 100}%`;
      el.style.height = `${(b.h / H) * 100}%`;
      el.dataset.index = i;
      el.title = `${b.tag === "FACE" ? "Face" : b.text || "Your box"}. Click to ${isOn(b) ? "show" : "hide"} it.`;
      el.setAttribute("aria-pressed", String(isOn(b)));
      el.setAttribute("aria-label", el.title);
      boxesEl.appendChild(el);
    });
  }

  function toggle(index) {
    const b = allBoxes()[index];
    if (!b) return;
    if (b.manual) state.manual.splice(state.manual.indexOf(b), 1);
    else if (state.off.has(b.key)) state.off.delete(b.key);
    else state.off.add(b.key);
    render();
    updateStatus();
  }

  // Drawing new boxes

  let drag = null;

  boxesEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !state.image) return;
    drag = { start: toImage(e), box: e.target.closest(".face"), moved: false, el: null };
    boxesEl.setPointerCapture(e.pointerId);
  });

  boxesEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toImage(e);
    const min = canvas.width / boxesEl.clientWidth;
    if (!drag.moved && Math.max(Math.abs(p.x - drag.start.x), Math.abs(p.y - drag.start.y)) < 6 * min) return;
    drag.moved = true;
    if (!drag.el) {
      drag.el = document.createElement("div");
      drag.el.className = "draft";
      boxesEl.appendChild(drag.el);
    }
    const r = rectFrom(drag.start, p);
    Object.assign(drag.el.style, {
      left: `${(r.x / canvas.width) * 100}%`,
      top: `${(r.y / canvas.height) * 100}%`,
      width: `${(r.w / canvas.width) * 100}%`,
      height: `${(r.h / canvas.height) * 100}%`,
    });
  });

  boxesEl.addEventListener("pointerup", (e) => {
    if (!drag) return;
    if (drag.moved) {
      const r = rectFrom(drag.start, toImage(e));
      drag.el.remove();
      if (r.w > 4 && r.h > 4) state.manual.push({ ...r, tag: "BOX", text: "", manual: true, on: true });
      render();
      updateStatus();
    } else if (drag.box) {
      toggle(+drag.box.dataset.index);
    }
    drag = null;
  });

  boxesEl.addEventListener("pointercancel", () => {
    if (drag && drag.el) drag.el.remove();
    drag = null;
  });

  boxesEl.addEventListener("keydown", (e) => {
    const el = e.target.closest(".face");
    if (!el || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    toggle(+el.dataset.index);
  });

  function toImage(e) {
    const rect = boxesEl.getBoundingClientRect();
    return {
      x: Math.min(canvas.width, Math.max(0, ((e.clientX - rect.left) / rect.width) * canvas.width)),
      y: Math.min(canvas.height, Math.max(0, ((e.clientY - rect.top) / rect.height) * canvas.height)),
    };
  }

  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  // Hold to compare with the original.
  const showOriginal = (on) => {
    state.showOriginal = on;
    boxesEl.classList.toggle("is-hidden", on);
    render();
  };
  original.addEventListener("pointerdown", () => showOriginal(true));
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => original.addEventListener(t, () => showOriginal(false)));
  original.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && showOriginal(true));
  original.addEventListener("keyup", () => showOriginal(false));

  // Download

  download.addEventListener("click", () => {
    state.showOriginal = false;
    render();
    busy(download, "Saving screenshot…");
    note(downloadNote);
    canvas.toBlob((blob) => {
      idle(download);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = downloadName(`${state.name}-${fileSuffix}.png`);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      note(downloadNote, "Done. Your screenshot is downloaded.");
    }, "image/png");
  });

  // Loading a file

  function reset() {
    state.runId++;
    state.image = null;
    state.ocr = null;
    editor.hidden = true;
    drop.hidden = false;
    fileInput.value = "";
    if (modelBar.dataset.state === "ready") idleStatus();
    else setStatus("");
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
  $("new").addEventListener("click", reset);
  $("sample").addEventListener("click", async () => {
    setStatus("Loading the example screenshot…", "busy");
    const blob = await (await fetch(sample)).blob();
    await openFile(new File([blob], sampleName, { type: "image/png" }));
  });
}

// Model labels for people, places and organizations (English, multilingual
// and Thai models).
const PERSON = new Set(["PERSON", "PER"]);
const PLACE = new Set(["LOCATION", "LOC", "FACILITY"]);
const ORG = new Set(["ORGANIZATION", "ORG"]);

// A tall screenshot comes from a phone.
const isPhone = (width, height) => height > width * 1.4;
