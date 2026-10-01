// Drawing for the face tools: grow a face box, then blur, pixelate or
// black out that area of a canvas.

// Grow the detected face box to also cover hair, ears and chin.
export const PAD = { x: 0.18, top: 0.35, bottom: 0.12 };

// `extra` grows the box on every side, as a share of its size. Video uses
// it to allow for movement between detections.
export function padBox(f, width, height, extra = 0) {
  const x = Math.max(0, f.x - f.w * (PAD.x + extra));
  const y = Math.max(0, f.y - f.h * (PAD.top + extra));
  const right = Math.min(width, f.x + f.w * (1 + PAD.x + extra));
  const bottom = Math.min(height, f.y + f.h * (1 + PAD.bottom + extra));
  return { x, y, w: right - x, h: bottom - y };
}

const small = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(2, 2) : document.createElement("canvas");
const smallCtx = small.getContext("2d");

// Hide box `f` on `ctx`, reading pixels from `source`.
// options: style "blur" | "pixelate" | "box", strength 1 to 10, shape "oval" | "rect".
export function cover(ctx, source, f, { style, strength, shape }) {
  const x = Math.round(f.x);
  const y = Math.round(f.y);
  const w = Math.max(1, Math.round(f.w));
  const h = Math.max(1, Math.round(f.h));

  ctx.save();
  ctx.beginPath();
  if (shape === "oval") ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(x, y, w, h);
  ctx.clip();

  if (style === "box") {
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
  } else {
    // Shrink the face to a few pixels, then stretch it back. The detail is
    // gone for good, so the result cannot be sharpened back.
    const across = style === "pixelate" ? 22 - strength * 1.6 : 13 - strength;
    const sw = Math.max(2, Math.round(across));
    const sh = Math.max(2, Math.round((across * h) / w));
    small.width = sw;
    small.height = sh;
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.drawImage(source, x, y, w, h, 0, 0, sw, sh);

    if (style === "pixelate") {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
    } else {
      if ("filter" in ctx) ctx.filter = `blur(${Math.round(w / sw / 2.5)}px)`;
      // Draw a little larger so the blur has no soft edge inside the shape.
      const m = w / sw;
      ctx.drawImage(small, 0, 0, sw, sh, x - m, y - m, w + 2 * m, h + 2 * m);
      ctx.filter = "none";
    }
  }
  ctx.restore();
}
