// Text layout helpers for the Chat Screenshot Anonymizer. Pure functions, no
// imports, so the same file runs in the browser and in Node tests.
//
// OCR gives words with boxes. These helpers join the words of two OCR passes,
// group them into lines, make one text for the detectors, and turn detected
// character spans back into boxes on the image.

// Make light text black on a white page. Chat apps put light text on dark
// or colored bubbles, which OCR reads badly. `rgba` is RGBA pixel data.
// Returns one byte per pixel (0 = text, 255 = page).
export function lightTextMask(rgba, threshold = 140) {
  const out = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    out[j] = l > threshold ? 0 : 255;
  }
  return out;
}

// Make colored text (links, sender names) black on a white page.
export function colorTextMask(rgba) {
  const out = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    out[j] = Math.max(r, g, b) - Math.min(r, g, b) > 60 && l > 90 ? 0 : 255;
  }
  return out;
}

// Website addresses without https://, such as example.com/page.
export function domainSpans(text) {
  const re = /(?<![\w@.-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|dev|co|ai|me|to|xyz|info|biz|uk|de|fr|es|it|nl|ca|au|in|us|gg|tv|ly|sh|so|link|site|online|store|tech|cloud)(?:\/[^\s]*)?(?![\w])/gi;
  return [...text.matchAll(re)].map((m) => ({ tag: "URL", start: m.index, end: m.index + m[0].length }));
}

const area = (b) => b.w * b.h;

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Join the words of several OCR passes. Where two words cover the same
// place, keep the one OCR is more sure of.
// words: { text, x, y, w, h, conf }
export function mergeWords(...passes) {
  const all = passes.flat().filter((w) => w.text.trim() && w.conf >= 50 && /[\p{L}\p{N}@]/u.test(w.text));
  all.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const w of all) {
    const dup = kept.some((k) => overlap(w, k) / Math.min(area(w), area(k)) > 0.5);
    if (!dup) kept.push(w);
  }
  return kept;
}

// Group words into lines: words that share most of their height and sit
// near each other in a row.
export function groupLines(words) {
  const sorted = [...words].sort((a, b) => a.x - b.x);
  const lines = [];
  for (const w of sorted) {
    let best = null;
    let bestGap = Infinity;
    for (const line of lines) {
      const vOverlap = Math.min(w.y + w.h, line.y + line.h) - Math.max(w.y, line.y);
      if (vOverlap < Math.min(w.h, line.h) * 0.5) continue;
      // Distance from the word to the line, on either side.
      const gap = w.x >= line.x + line.w ? w.x - (line.x + line.w) : w.x + w.w <= line.x ? line.x - (w.x + w.w) : 0;
      if (gap < Math.max(w.h, line.h) * 1.6 && gap < bestGap) {
        best = line;
        bestGap = gap;
      }
    }
    if (best) {
      best.words.push(w);
      const x2 = Math.max(best.x + best.w, w.x + w.w);
      const y2 = Math.max(best.y + best.h, w.y + w.h);
      best.x = Math.min(best.x, w.x);
      best.y = Math.min(best.y, w.y);
      best.w = x2 - best.x;
      best.h = y2 - best.y;
    } else {
      lines.push({ words: [w], x: w.x, y: w.y, w: w.w, h: w.h });
    }
  }
  for (const line of lines) line.words.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

// Scripts written without spaces between words.
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

// Letters of scripts without capital letters, where a name can start with
// any letter.
const CASELESS = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/u;

// One text for the detectors, one line per OCR line. `parts` records where
// each word sits in the text.
export function linesText(lines) {
  let text = "";
  const parts = [];
  lines.forEach((line, li) => {
    line.words.forEach((w, wi) => {
      // OCR often splits "prod.internal" at the dot. Join a word to the one
      // before when there is almost no gap and the first ends with a dot.
      const prev = line.words[wi - 1];
      const tight = prev && /\.$/.test(prev.text) && /^[a-z0-9]/.test(w.text) && w.x - (prev.x + prev.w) < w.h * 0.35;
      // Chinese, Japanese and Thai do not put spaces between words, but OCR
      // does. Join them again: "3 月 14 日" becomes "3月14日".
      const before = prev ? prev.text.slice(-1) : "";
      const after = w.text[0];
      const noSpace = prev && ((NO_SPACE.test(before) && (NO_SPACE.test(after) || /\d/.test(after))) || (/\d/.test(before) && NO_SPACE.test(after)));
      if (wi && !tight && !noSpace) text += " ";
      parts.push({ line: li, word: w, start: text.length, end: text.length + w.text.length });
      text += w.text;
    });
    text += "\n";
  });
  return { text, parts };
}

// The boxes for a character span: one box per line it touches. A word that
// is only partly in the span is hidden whole.
export function spanBoxes(span, parts) {
  const byLine = new Map();
  for (const p of parts) {
    if (p.end <= span.start || p.start >= span.end) continue;
    const b = byLine.get(p.line);
    const w = p.word;
    if (!b) byLine.set(p.line, { x: w.x, y: w.y, w: w.w, h: w.h });
    else {
      const x2 = Math.max(b.x + b.w, w.x + w.w);
      const y2 = Math.max(b.y + b.h, w.y + w.h);
      b.x = Math.min(b.x, w.x);
      b.y = Math.min(b.y, w.y);
      b.w = x2 - b.x;
      b.h = y2 - b.y;
    }
  }
  return [...byLine.values()];
}

// Header lines that are not names, in the supported languages.
const HEADER_INFO = new RegExp(
  [
    "\\b(?:members?|online|last seen|typing|subscribers?|participants?|active|recently)\\b",
    "\\b(?:miembros?|en línea|escribiendo|últ\\. vez|participantes)\\b",
    "\\b(?:membres?|en ligne|écrit|vu(?:e)? (?:à|hier|il y a)|participants)\\b",
    "\\b(?:Mitglieder|online|schreibt|zuletzt|Teilnehmer)\\b",
    "成员|成員|在线|在線|正在输入|最后上线|メンバー|オンライン|入力中|最終ログイン|สมาชิก|ออนไลน์|กำลังพิมพ์|ใช้งานล่าสุด",
  ].join("|"),
  "iu"
);

// The chat or contact name in the app header: lines near the top, below
// the phone's status bar, between the back button and the profile picture.
// Lines such as "6 members" or "last seen…" are not names.
export function headerSpans(lines, parts, width, height) {
  const spans = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const cy = line.y + line.h / 2;
    if (cy < height * 0.045 || cy > height * 0.095) continue;
    if (line.x < width * 0.15 || line.x + line.w > width * 0.85) continue;
    const text = line.words.map((w) => w.text).join(" ");
    if (HEADER_INFO.test(text)) continue;
    if (!/\p{L}{2}/u.test(text) && !CASELESS.test(text)) continue;
    spans.push(lineSpan(parts, li, "NAME"));
  }
  return spans;
}

// Sender names in group chats. Chat apps show them in color above the
// message, while message text is white or black. A short colored line that
// starts with a capital letter is taken as a name.
export function colorNameSpans(lines, parts, rgba, width) {
  const spans = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const text = line.words.map((w) => w.text).join(" ");
    // OCR splits Thai and Chinese into many short words, so count letters,
    // not words, for those.
    const caselessLine = CASELESS.test(text);
    if ((!caselessLine && line.words.length > 4) || text.length > 30) continue;
    const caseless = CASELESS.test(text);
    if ((!/^\p{Lu}/u.test(text) && !caseless) || /[\d/@:]|\.\w/u.test(text)) continue;
    // Each word has two letters or more. A capital initial at the end, as in
    // "Dmitry V", is fine. In Chinese and Japanese one character can be a
    // whole word.
    const words = line.words.map((w) => w.text);
    if (!caseless && words.some((w, i) => !/\p{L}{2}/u.test(w) && !(i === words.length - 1 && i > 0 && /^\p{Lu}\.?$/u.test(w)))) continue;
    if (textSaturation(rgba, width, line) < 70) continue;
    // OCR can miss part of a name, for example one character of a Chinese
    // name. Cover all the colored text on this line.
    spans.push({ ...lineSpan(parts, li, "NAME"), box: coloredExtent(rgba, width, line) });
  }
  return spans;
}

// The colored text that starts at a line: from the line's left edge to
// the last column with colored pixels, allowing gaps between characters.
function coloredExtent(rgba, width, line) {
  const y0 = Math.max(0, Math.floor(line.y));
  const y1 = Math.floor(line.y + line.h);
  const colored = (x) => {
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60 && 0.299 * r + 0.587 * g + 0.114 * b > 70) return true;
    }
    return false;
  };
  let right = Math.ceil(line.x + line.w);
  const maxGap = Math.round(line.h * 1.2);
  let gap = 0;
  for (let x = right; x < Math.min(width, line.x + line.h * 20); x++) {
    if (colored(x)) {
      right = x + 1;
      gap = 0;
    } else if (++gap > maxGap) break;
  }
  return { x: line.x, y: line.y, w: right - line.x, h: line.h };
}

function lineSpan(parts, li, tag) {
  const own = parts.filter((p) => p.line === li);
  return { tag, start: own[0].start, end: own[own.length - 1].end };
}

// How colored the text of a line is: the color strength (max minus min of
// R, G, B) of the pixels that differ most from the line's background.
export function textSaturation(rgba, width, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.floor(box.x + box.w);
  const y0 = Math.max(0, Math.floor(box.y));
  const y1 = Math.floor(box.y + box.h);
  const px = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4;
      px.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    }
  }
  if (px.length < 20) return 0;
  // The background is the most common brightness; text is far from it.
  const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const sorted = px.map(lum).sort((a, b) => a - b);
  const bg = sorted[Math.floor(sorted.length / 2)];
  const far = px.filter((p) => Math.abs(lum(p) - bg) > 50);
  if (far.length < 10) return 0;
  const sat = far.map((p) => Math.max(...p) - Math.min(...p)).sort((a, b) => a - b);
  return sat[Math.floor(sat.length / 2)];
}

// Split spans at line ends: OCR lines are separate, so a name cannot go
// from one line to the next.
export function splitAtLines(text, spans) {
  const out = [];
  for (const s of spans) {
    let start = s.start;
    for (let i = s.start; i <= s.end; i++) {
      if (i === s.end || text[i] === "\n") {
        if (i > start) out.push({ ...s, start, end: i });
        start = i + 1;
      }
    }
  }
  return out;
}

// Avatars: profile pictures in chat apps are circles, or squares with
// rounded corners (Slack, some Teams and Google apps). A blurred face is not
// enough, because hair, clothes, a logo or initials can show who it is, so
// the whole avatar is hidden.
//
// Shapes are superellipses: |x|^n + |y|^n = r^n. n = 2 is a circle, n = 4
// is a square with well rounded corners and n = 8 a square with small
// rounded corners.
export const SHAPES = [2, 4, 8];

// shapeScorer() measures one possible avatar: how much of its outline is a
// clear change in brightness across the outline (text edges point in all
// directions), how plain the area just outside is (a bubble or the
// wallpaper), and how the inside compares with the outside.
// `gray` is one byte per pixel at `width` x `height`.
export function shapeScorer(gray, width, height) {
  const gxs = new Float32Array(width * height);
  const gys = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      gxs[i] = gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1] - gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1];
      gys[i] = gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1] - gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1];
    }
  }

  // Points on the unit outline, with the outward normal, for each shape.
  const POINTS = 40;
  const outlines = {};
  for (const n of SHAPES) {
    const pts = [];
    for (let a = 0; a < POINTS; a++) {
      const t = (a / POINTS) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const x = Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = Math.sign(s) * Math.abs(s) ** (2 / n);
      let nx = Math.sign(x) * Math.abs(x) ** (n - 1);
      let ny = Math.sign(y) * Math.abs(y) ** (n - 1);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      pts.push({ x, y, nx, ny });
    }
    outlines[n] = pts;
  }
  const at = (x, y) => gray[Math.round(y) * width + Math.round(x)];

  return (cx, cy, r, n = 2, edge = 60) => {
    if (cx - r - 6 < 0 || cy - r - 6 < 0 || cx + r + 6 >= width || cy + r + 6 >= height) return null;
    const pts = outlines[n];
    let strong = 0;
    let sum = 0;
    for (const p of pts) {
      let best = 0;
      for (let d = -1; d <= 1; d++) {
        const i = Math.round(cy + p.y * r + d * p.ny) * width + Math.round(cx + p.x * r + d * p.nx);
        const across = Math.abs(gxs[i] * p.nx + gys[i] * p.ny);
        if (across > best) best = across;
      }
      sum += best;
      if (best > edge) strong++;
    }
    // How often the color just inside the outline differs from just outside.
    // An avatar differs from the background all round. Letters do not: the
    // gaps between them have the background color on both sides.
    let differs = 0;
    for (const p of pts) {
      const inner = at(cx + p.x * r - 3 * p.nx, cy + p.y * r - 3 * p.ny);
      const outer = at(cx + p.x * r + 3 * p.nx, cy + p.y * r + 3 * p.ny);
      if (Math.abs(inner - outer) > 20) differs++;
    }
    let oSum = 0;
    let oSq = 0;
    for (const p of pts) {
      for (const d of [3, 5]) {
        const v = at(cx + p.x * r + d * p.nx, cy + p.y * r + d * p.ny);
        oSum += v;
        oSq += v * v;
      }
    }
    const no = pts.length * 2;
    const oMean = oSum / no;
    const oSd = Math.sqrt(Math.max(0, oSq / no - oMean * oMean));
    let inSum = 0;
    let inSq = 0;
    for (const p of pts) {
      for (const k of [0.25, 0.5, 0.75]) {
        const v = at(cx + p.x * r * k, cy + p.y * r * k);
        inSum += v;
        inSq += v * v;
      }
    }
    const ni = pts.length * 3;
    const inMean = inSum / ni;
    const inSd = Math.sqrt(Math.max(0, inSq / ni - inMean * inMean));
    return {
      edge: strong / pts.length,
      strength: sum / pts.length,
      contrast: differs / pts.length,
      plainOutside: oSd <= 22,
      picture: inSd >= 18 || Math.abs(inMean - oMean) >= 30,
    };
  };
}

// Avatars: shapes with a clear outline, a plain area outside and a picture
// or color inside. Radii are in pixels. Returns boxes: { x, y, w, h, n, score }
// where n is the shape (2 = circle).
export function findCircles(gray, width, height, { minR, maxR, top = 0, bottom = height }) {
  const score = shapeScorer(gray, width, height);
  const found = [];
  for (const n of SHAPES) {
    for (let r = minR; r <= maxR; r += Math.max(1, Math.round(r / 10))) {
      const step = Math.max(1, Math.round(r / 6));
      for (let cy = Math.max(top, r + 7); cy < Math.min(bottom, height - r - 7); cy += step) {
        for (let cx = r + 7; cx < width - r - 7; cx += step) {
          const c = score(cx, cy, r, n);
          if (!c || c.edge < 0.85 || c.contrast < 0.7 || !c.plainOutside || !c.picture) continue;
          // Prefer a circle when a circle and a square fit about as well.
          found.push({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, n, score: c.strength * (n === 2 ? 1.1 : 1) });
        }
      }
    }
  }
  const kept = strongest(found);

  // Chats show avatars in one column on the left, all the same size and
  // shape. When one is found there, look down that column again
  // with a lower edge threshold: dark photos on a dark background have weak
  // edges.
  const left = kept.filter((c) => c.x + c.w / 2 < width * 0.12 && c.w >= 2 * minR + 4);
  if (left.length >= 1) {
    const mid = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const r = Math.round(mid(left.map((c) => c.w / 2)));
    const n = mid(left.map((c) => c.n));
    const cx0 = Math.round(mid(left.map((c) => c.x + c.w / 2)));
    const extra = [];
    for (let cy = Math.max(top, r + 7); cy < Math.min(bottom, height - r - 7); cy += 1) {
      for (let cx = cx0 - 2; cx <= cx0 + 2; cx++) {
        const c = score(cx, cy, r, n, 25);
        if (!c || c.edge < 0.6 || c.contrast < 0.5 || !c.plainOutside || !c.picture) continue;
        extra.push({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, n, score: c.strength });
      }
    }
    return strongest([...kept.map((c) => ({ ...c, score: c.score + 1000 })), ...extra]);
  }
  return kept;
}

// Shapes found on text are letters, not avatars. A shape is dropped when a
// word read by OCR overlaps it but sits mostly outside it, or when a long
// word sits inside it. Short words inside are fine: avatars can show
// initials, and OCR reads noise in photos.
export function notOnText(shapes, words) {
  return shapes.filter((c) => {
    return !words.some((w) => {
      const inter = overlap(w, c);
      if (inter < area(w) * 0.15) return false;
      const cx = w.x + w.w / 2;
      const cy = w.y + w.h / 2;
      const inside = cx > c.x && cx < c.x + c.w && cy > c.y && cy < c.y + c.h;
      return !inside || (w.text.match(/[\p{L}\p{N}]/gu) || []).length > 3;
    });
  });
}

// Keep the strongest shape where several overlap.
function strongest(found) {
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of found) {
    if (!kept.some((k) => overlap(c, k) / Math.min(area(c), area(k)) > 0.3)) kept.push(c);
  }
  return kept;
}

// Dates and times as chat apps and websites show them: 10:43 PM, 14:05,
// Tuesday, September 29th, Sep 29, Yesterday, 3 days ago.
const MONTH = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const DAY = "Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?";
const DATE_TIME = new RegExp(
  [
    `\\b(?:${DAY}),? (?:${MONTH})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`,
    `\\b(?:${MONTH})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)? (?:${MONTH})\\.?(?:,? \\d{4})?\\b`,
    `\\b\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?(?: ?[AaPp]\\.?[Mm]\\.?)?(?![\\d])`,
    `\\b\\d{1,2} ?[AaPp][Mm]\\b`,
    // OCR often drops the colon or joins the time to noise: "1043PM".
    `\\d{1,2}[:.]?\\d{2} ?[AaPp]\\.?[Mm]\\b`,
    `\\b(?:${DAY})\\b`,
    `\\b(?:Today|Yesterday|Tomorrow)\\b`,
    `\\b\\d+ (?:seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?) ago\\b`,
    `\\b(?:an?|one) (?:minute|hour|day|week|month|year) ago\\b`,
  ].join("|"),
  "gi"
);

export function dateTimeSpans(text) {
  return [...text.matchAll(DATE_TIME)].map((m) => ({ tag: "DATE", start: m.index, end: m.index + m[0].length }));
}
// @usernames and handles, such as @maya_chen. The @ stays visible.
export function usernameSpans(text) {
  return [...text.matchAll(/(?<![\w.])@([A-Za-z][\w.-]{1,30}[A-Za-z0-9])/g)].map((m) => ({ tag: "USERNAME", start: m.index + 1, end: m.index + m[0].length }));
}
