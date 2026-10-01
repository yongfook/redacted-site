// Video Face Blur: find and track faces in a video, then make a copy with
// the faces blurred. Everything happens in this tab. The video is never
// uploaded.
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
import { padBox, cover } from "./blur-core.js";
import { Tracker, coverAt, keepTracks, groupTracks } from "./video-core.js";
import { busy, idle, note, downloadName } from "./busy.js";

const SAMPLE = "/samples/team-meeting.mp4";
const READY = "The face model runs on this device. Choose a video to start.";
const MAX_SECONDS = 10 * 60;
const MAX_SIDE = 1920; // Larger videos are made smaller to 1080p.
const DETECT_FPS = 8; // Frames per second to run face detection on.
const DETECT_WIDTH = 1280; // Detection frames are made this wide or smaller.
const MOTION_PAD = 0.12; // Extra box size, for movement between detections.
// A lower threshold than for photos: in a video, a false detection only
// adds a short track that can be switched off, but a missed face is a leak.
// Faces turned to the side or partly covered often score 0.5 to 0.75.
const THRESHOLD = 0.5;
const TIMING = { lead: 1.5 / DETECT_FPS, hold: 1.0 };

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const editor = $("editor");
const status = $("status");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const video = $("video");
const playButton = $("play");
const scrubber = $("scrubber");
const timeLabel = $("time");
const people = $("people");
const strength = $("strength");
const strengthControl = $("strength-control");
const keepAudio = $("keep-audio");
const download = $("download");
const original = $("original");
const downloadNote = $("download-note");
const modelBar = $("model");

const state = {
  file: null,
  input: null,
  width: 0, // video display size
  height: 0,
  duration: 0,
  tracks: [],
  style: "blur",
  shape: "oval",
  showOriginal: false,
  runId: 0,
  busy: false,
};

// Face detection worker (the same one as Face Blur)

const worker = new Worker(new URL("./face-blur-worker.js", import.meta.url), { type: "module" });
const waiting = new Map();
let requestId = 0;

worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    modelBar.dataset.state = "ready";
    if (!state.input) setStatus(READY);
    return;
  }
  if (data.type === "error" && data.id === undefined) {
    modelBar.dataset.state = "error";
    setStatus(`Could not load the face model. ${data.message} Reload the page to try again.`, "error");
    return;
  }
  const done = waiting.get(data.id);
  if (!done) return;
  if (data.type === "result") {
    waiting.delete(data.id);
    done.resolve(data.faces);
  } else if (data.type === "error") {
    waiting.delete(data.id);
    done.reject(new Error(data.message));
  }
};

function detectFaces(bitmap) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ type: "detect", id, bitmap, tile: 960, threshold: THRESHOLD }, [bitmap]);
  });
}

worker.postMessage({ type: "load" });

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
  state.width = track.displayWidth;
  state.height = track.displayHeight;
  state.duration = duration;
  state.tracks = [];

  // The preview is drawn at up to 1280 pixels wide.
  const k = Math.min(1, 1280 / state.width);
  canvas.width = Math.round(state.width * k);
  canvas.height = Math.round(state.height * k);

  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  scrubber.max = duration;
  scrubber.value = 0;
  people.replaceChildren();
  download.disabled = true;
  note(downloadNote);
  drop.hidden = true;
  editor.hidden = false;

  await analyze(track, runId);
}

// Pass 1: find and track faces

async function analyze(track, runId) {
  const scale = Math.min(1, DETECT_WIDTH / state.width);
  const dw = Math.round(state.width * scale);
  const dh = Math.round(state.height * scale);
  const sink = new CanvasSink(track, { width: dw, height: dh, fit: "fill", poolSize: 2 });

  const start = await track.getFirstTimestamp();
  const times = [];
  for (let t = start; t < start + state.duration; t += 1 / DETECT_FPS) times.push(t);

  const tracker = new Tracker({ maxGap: 2 });
  const thumbs = new Map(); // track id -> best score so far
  let n = 0;
  const started = performance.now();

  try {
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (runId !== state.runId) return;
      n++;
      if (!frame) continue;
      const bitmap = await createImageBitmap(frame.canvas);
      const found = (await detectFaces(bitmap)).map((f) => ({
        x: f.x / scale,
        y: f.y / scale,
        w: f.w / scale,
        h: f.h / scale,
        score: f.score,
      }));
      const assigned = tracker.update(frame.timestamp, found);

      // Keep a picture of each person from their clearest detection.
      assigned.forEach((tr, i) => {
        const f = found[i];
        if ((thumbs.get(tr.id) || 0) >= f.score) return;
        thumbs.set(tr.id, f.score);
        tr.thumb = thumbnail(frame.canvas, f, scale);
      });

      if (n % 4 === 0) {
        const left = ((performance.now() - started) / n) * (times.length - n);
        setStatus(
          `Looking for faces… ${Math.round((n / times.length) * 100)}%` +
            (n > 8 ? ` · about ${formatTime(left / 1000)} left` : ""),
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
  state.tracks = groupTracks(keepTracks(tracker.tracks), { timing: TIMING });
  renderPeople();
  updateStatus();
  download.disabled = false;
  drawFrame();
}

function thumbnail(source, f, scale) {
  const box = padBox({ x: f.x * scale, y: f.y * scale, w: f.w * scale, h: f.h * scale }, source.width, source.height);
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const side = Math.max(box.w, box.h);
  c.getContext("2d").drawImage(
    source,
    box.x + box.w / 2 - side / 2,
    box.y + box.h / 2 - side / 2,
    side,
    side,
    0,
    0,
    64,
    64
  );
  return c;
}

// People list

const persons = () => state.tracks.filter((tr) => !tr.parent);

function renderPeople() {
  people.replaceChildren();
  // Short extra tracks that belong to a person follow that person.
  persons().forEach((tr, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "person";
    b.setAttribute("aria-pressed", String(tr.on));
    const first = tr.keys[0].t;
    const end = tr.keys[tr.keys.length - 1].t;
    if (tr.thumb) b.appendChild(tr.thumb);
    const label = document.createElement("span");
    label.innerHTML = `<strong>Person ${i + 1}</strong><small>${formatTime(first)}–${formatTime(end)}</small><em></em>`;
    b.appendChild(label);
    const update = () => {
      b.setAttribute("aria-pressed", String(tr.on));
      label.querySelector("em").textContent = tr.on ? "Hidden" : "Shown";
    };
    update();
    b.addEventListener("click", () => {
      tr.on = !tr.on;
      update();
      updateStatus();
      drawFrame();
    });
    people.appendChild(b);
  });
}

function updateStatus() {
  const total = persons().length;
  const on = persons().filter((t) => t.on).length;
  if (!total) {
    setStatus("No faces found in this video.");
  } else {
    setStatus(
      `${total} ${total === 1 ? "person" : "people"} found · ${on} hidden. ` +
        "Click a person to show or hide their face in the whole video."
    );
  }
}

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

// Boxes to hide at time t, in the given frame size.
function boxesAt(t, width, height) {
  const k = width / state.width;
  const out = [];
  for (const tr of state.tracks) {
    if (!(tr.parent || tr).on) continue;
    const b = coverAt(tr, t, TIMING);
    if (!b) continue;
    out.push(padBox({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }, width, height, MOTION_PAD));
  }
  return out;
}

const options = () => ({ style: state.style, strength: +strength.value, shape: state.shape });

// Preview

function drawFrame() {
  if (video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (!state.showOriginal) {
    const o = options();
    for (const box of boxesAt(video.currentTime, canvas.width, canvas.height)) cover(ctx, canvas, box, o);
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

// Controls

function chipGroup(id, key) {
  const group = $(id);
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    state[key] = b.dataset.value;
    group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    strengthControl.hidden = state.style === "box";
    drawFrame();
  });
}

chipGroup("style", "style");
chipGroup("shape", "shape");
strength.addEventListener("input", drawFrame);

const showOriginal = (on) => {
  state.showOriginal = on;
  drawFrame();
};
original.addEventListener("pointerdown", () => showOriginal(true));
["pointerup", "pointerleave", "pointercancel"].forEach((t) => original.addEventListener(t, () => showOriginal(false)));
original.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && showOriginal(true));
original.addEventListener("keyup", () => showOriginal(false));

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
  const o = options();

  try {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input: state.input,
      output,
      showWarnings: false,
      // Do not copy metadata such as the location where the video was filmed.
      tags: {},
      video: {
        codec: "avc",
        allowTransformationMetadata: false,
        ...(big ? { width: outWidth, height: outHeight, fit: "fill" } : {}),
        processedWidth: outWidth,
        processedHeight: outHeight,
        process: (sample) => {
          sample.draw(fctx, 0, 0, outWidth, outHeight);
          for (const box of boxesAt(sample.timestamp, outWidth, outHeight)) cover(fctx, frame, box, o);
          return frame;
        },
      },
      audio: { discard: !keepAudio.checked },
    });

    if (!conversion.isValid) {
      const video = conversion.discardedTracks.find((d) => d.track.type === "video");
      throw new Error(video ? `The video track cannot be converted (${video.reason}).` : "The video cannot be converted.");
    }
    const lostAudio = keepAudio.checked && conversion.discardedTracks.some((d) => d.track.type === "audio");

    conversion.onProgress = (p) => busy(download, `Making video… ${Math.round(p * 100)}%`);
    await conversion.execute();

    const blob = new Blob([output.target.buffer], { type: "video/mp4" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = downloadName(`${state.file.name.replace(/\.[^.]+$/, "") || "video"}-blurred.mp4`);
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
  state.tracks = [];
  video.pause();
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute("src");
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
$("new").addEventListener("click", reset);
$("sample").addEventListener("click", async () => {
  setStatus("Loading the example video…", "busy");
  const blob = await (await fetch(SAMPLE)).blob();
  await openFile(new File([blob], "team-meeting.mp4", { type: "video/mp4" }));
});

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
