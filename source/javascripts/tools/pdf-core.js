// Text layout helpers for the PDF Redactor. Pure functions, no imports, so
// the same file runs in the browser and in Node tests.
//
// PDF.js gives each page as text items: a string, a transform matrix and a
// width, in PDF points. These helpers join the items into one string for
// the detectors, then turn detected character spans back into boxes.

// Join a page's items into text. `parts` records where each item sits in
// the text, so a span of characters can be found again on the page.
export function pageText(items) {
  let text = "";
  const parts = [];
  let prev = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.str) {
      if (item.hasEOL && text && !text.endsWith("\n")) text += "\n";
      continue;
    }
    if (prev && !text.endsWith("\n") && !/\s$/.test(text) && !/^\s/.test(item.str)) {
      // Items on one line with a visible gap between them are separate words.
      const [, , , , px] = prev.transform;
      const [, , , , x, y] = item.transform;
      const gap = x - (px + prev.width);
      const size = fontSize(item);
      const sameLine = Math.abs(y - prev.transform[5]) < size * 0.5;
      if (!sameLine) text += "\n";
      else if (gap > size * 0.15) text += " ";
    }
    parts.push({ index: i, start: text.length, end: text.length + item.str.length });
    text += item.str;
    if (item.hasEOL) text += "\n";
    prev = item;
  }
  return { text, parts };
}

export const fontSize = (item) => Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;

// Turn a character span into one box per text item it touches, in PDF
// points with the origin at the bottom left. `measure(str, item)` returns
// the width of a string in the item's font, in any unit.
export function spanToRects(span, items, parts, measure) {
  const rects = [];
  for (const part of parts) {
    if (part.end <= span.start || part.start >= span.end) continue;
    const item = items[part.index];
    const from = Math.max(span.start, part.start) - part.start;
    const to = Math.min(span.end, part.end) - part.start;

    const full = measure(item.str, item) || 1;
    const x0 = (measure(item.str.slice(0, from), item) / full) * item.width;
    const x1 = (measure(item.str.slice(0, to), item) / full) * item.width;

    // Unit vectors along and across the text, so rotated text also works.
    const [a, b, c, d, e, f] = item.transform;
    const size = fontSize(item);
    const along = { x: a / (Math.hypot(a, b) || 1), y: b / (Math.hypot(a, b) || 1) };
    const up = { x: c / size, y: d / size };

    // Cover descenders and accents with a little room to spare. The web
    // font used to measure is not always the PDF's font, so character
    // positions can be off a little. Pad the ends: a bar that is slightly
    // too wide is safer than one that shows part of a character.
    const below = size * 0.28;
    const above = size * 0.95;
    const pad = size * 0.2;

    const corners = [
      [x0 - pad, -below],
      [x1 + pad, -below],
      [x1 + pad, above],
      [x0 - pad, above],
    ].map(([u, v]) => ({
      x: e + along.x * u + up.x * v,
      y: f + along.y * u + up.y * v,
    }));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  return rects;
}

// Join boxes that sit on the same line and touch, so one name gives one bar.
export function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const h = r.y1 - r.y0;
    if (
      last &&
      Math.abs(last.y0 - r.y0) < h * 0.3 &&
      Math.abs(last.y1 - r.y1) < h * 0.3 &&
      r.x0 <= last.x1 + h * 0.5 &&
      r.x1 >= last.x0
    ) {
      last.x0 = Math.min(last.x0, r.x0);
      last.x1 = Math.max(last.x1, r.x1);
      last.y0 = Math.min(last.y0, r.y0);
      last.y1 = Math.max(last.y1, r.y1);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
