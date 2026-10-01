// Face tracking for the Video Face Blur tool. Pure functions, no imports,
// so the same file runs in the browser and in Node tests.
//
// Detection runs on some frames only. The tracker joins the detections
// into tracks (one per person), and boxAt() gives a track's box at any
// time, moving smoothly between detections.

export class Tracker {
  // maxGap: seconds a track can go without a detection and still continue.
  constructor({ maxGap = 1.2 } = {}) {
    this.tracks = [];
    this.nextId = 1;
    this.maxGap = maxGap;
  }

  // Add the faces found at time t. Returns the track for each face.
  update(t, faces) {
    const active = this.tracks.filter((tr) => t - last(tr).t <= this.maxGap);
    const pairs = [];
    faces.forEach((face, fi) => {
      active.forEach((track, ti) => {
        // Compare with the predicted box and with the last box, and use the
        // better match. A person who turns away often stops moving the way
        // the prediction expects.
        let best = null;
        for (const guess of [predict(track, t), last(track)]) {
          const overlap = iou(face, guess);
          const dist = centerDistance(face, guess) / Math.max(face.w, face.h, guess.w, guess.h);
          const score = overlap - dist * 0.5;
          if ((overlap > 0.1 || dist < 1) && (best === null || score > best)) best = score;
        }
        if (best !== null) pairs.push({ fi, ti, score: best });
      });
    });

    // Best matches first. Each face and each track is used once.
    pairs.sort((a, b) => b.score - a.score);
    const usedFaces = new Set();
    const usedTracks = new Set();
    const result = new Array(faces.length);
    for (const p of pairs) {
      if (usedFaces.has(p.fi) || usedTracks.has(p.ti)) continue;
      usedFaces.add(p.fi);
      usedTracks.add(p.ti);
      const track = active[p.ti];
      track.keys.push({ t, ...pick(faces[p.fi]) });
      result[p.fi] = track;
    }

    faces.forEach((face, fi) => {
      if (usedFaces.has(fi)) return;
      const track = { id: this.nextId++, keys: [{ t, ...pick(face) }], on: true };
      this.tracks.push(track);
      result[fi] = track;
    });
    return result;
  }
}

// Tracks to keep after a scan. A track made of one weak detection is
// almost always a hand or an object: real faces, also turned ones, give
// several detections in a row.
export function keepTracks(tracks, minScore = 0.7) {
  return tracks.filter((tr) => tr.keys.length > 1 || tr.keys[0].score >= minScore);
}

// Join short extra tracks to the person they belong to. A person who turns
// can give a second box at the same time, for example on the back of the
// head. A short track that stays next to a longer track gets `parent`, so
// the people list shows it as part of that person. It is still blurred.
export function groupTracks(tracks, { maxLength = 1.5, near = 1.2, timing = { lead: 0.5, hold: 1 } } = {}) {
  const span = (tr) => tr.keys[tr.keys.length - 1].t - tr.keys[0].t;
  const long = tracks.filter((tr) => span(tr) > maxLength);
  for (const tr of tracks) {
    if (span(tr) > maxLength) continue;
    let best = null;
    for (const other of long) {
      let total = 0;
      let ok = true;
      for (const k of tr.keys) {
        // Use the same timing as the blur, so a person who just turned away
        // still has a box to compare with.
        const b = boxAt(other, k.t, timing);
        const d = b && centerDistance(k, b) / Math.max(k.w, k.h, b.w, b.h);
        if (!b || d > near) {
          ok = false;
          break;
        }
        total += d;
      }
      if (ok && (!best || total < best.total)) best = { other, total };
    }
    if (best) tr.parent = best.other;
  }
  return tracks;
}

// A track's box at time t, or null when the track is not on screen.
// lead: seconds to start the box before the first detection.
// hold: seconds to keep the box after the last detection.
export function boxAt(track, t, { lead = 0.2, hold = 0.5 } = {}) {
  const keys = track.keys;
  const first = keys[0];
  const end = keys[keys.length - 1];
  if (t < first.t - lead || t > end.t + hold) return null;
  if (t <= first.t) return first;
  if (t >= end.t) return end;

  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    w: a.w + (b.w - a.w) * k,
    h: a.h + (b.h - a.h) * k,
  };
}

// The area to hide for a track at time t: its boxes from `trail` seconds
// before to `trail` seconds after, joined into one box. When a person turns
// away, detection can jump from the face to the back of the head. The trail
// keeps the old face position covered while that happens. A still person
// gets the same box as boxAt().
export function coverAt(track, t, timing, trail = 0.4) {
  let box = null;
  for (let dt = -trail; dt <= trail + 1e-9; dt += trail / 2) {
    const b = boxAt(track, t + dt, timing);
    if (!b) continue;
    if (!box) {
      box = { x: b.x, y: b.y, w: b.w, h: b.h };
      continue;
    }
    const right = Math.max(box.x + box.w, b.x + b.w);
    const bottom = Math.max(box.y + box.h, b.y + b.h);
    box.x = Math.min(box.x, b.x);
    box.y = Math.min(box.y, b.y);
    box.w = right - box.x;
    box.h = bottom - box.y;
  }
  return box;
}

const last = (track) => track.keys[track.keys.length - 1];
const pick = (f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, score: f.score });

// Where a track's box will probably be at time t, from its last movement.
function predict(track, t) {
  const keys = track.keys;
  const b = keys[keys.length - 1];
  if (keys.length < 2) return b;
  const a = keys[keys.length - 2];
  const k = Math.min(2, (t - b.t) / (b.t - a.t || 1));
  return {
    x: b.x + (b.x - a.x) * k,
    y: b.y + (b.y - a.y) * k,
    w: Math.max(1, b.w + (b.w - a.w) * k),
    h: Math.max(1, b.h + (b.h - a.h) * k),
  };
}

function iou(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const centerDistance = (a, b) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
