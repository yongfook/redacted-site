// Remove metadata from JPEG, PNG and WebP files by editing their bytes.
// The image data is copied as it is, so the quality does not change.
// Pure functions, no imports, so they run in the browser and in Node tests.
// Each strip function returns { bytes, removed }, where removed lists what
// was taken out.

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

// JPEG

// Keep only segments the image needs: JFIF (APP0), color profile (APP2
// ICC_PROFILE) and Adobe color data (APP14). Remove Exif and XMP (APP1),
// IPTC and Photoshop data (APP13), comments and other APP segments.
//
// The rotation of a phone photo is also Exif. When the photo has one, a new
// Exif block with only the rotation is added, so the photo still shows the
// right way up.
export function stripJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("Not a JPEG file");
  const orientation = jpegOrientation(b);
  const out = [b.subarray(0, 2)];
  if (orientation !== 1) out.push(orientationSegment(orientation));
  const removed = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("Damaged JPEG file");
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Start of scan: the rest is image data.
    if (marker === 0xda || marker === 0xd9) {
      out.push(b.subarray(i));
      break;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    const seg = b.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep =
      !isApp && marker !== 0xfe
        ? true
        : marker === 0xe0 || (marker === 0xe2 && ascii(seg, 4, 11) === "ICC_PROFILE") || (marker === 0xee && ascii(seg, 4, 5) === "Adobe");
    if (keep) out.push(seg);
    else removed.push(jpegSegmentName(marker, seg));
    i += 2 + len;
  }
  return { bytes: concat(out), removed };
}

function jpegSegmentName(marker, seg) {
  if (marker === 0xfe) return "Comment";
  if (marker === 0xe1) return ascii(seg, 4, 4) === "Exif" ? "Exif" : "XMP";
  if (marker === 0xed) return "IPTC / Photoshop";
  return `APP${marker - 0xe0}`;
}

// An APP1 Exif segment with one field: the orientation.
function orientationSegment(value) {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // little endian, first IFD at 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, value, 0x00, 0x00, 0x00, // Orientation, SHORT, 1, value
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

// The Exif orientation (1 to 8), or 1 when there is none.
export function jpegOrientation(b) {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && ascii(b, i + 4, 4) === "Exif") {
      const t = i + 10; // TIFF header
      const le = b[t] === 0x49;
      const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o) => (le ? u16(o) | (u16(o + 2) << 16) : (u16(o) << 16) | u16(o + 2)) >>> 0;
      const ifd = u32(4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
    }
    i += 2 + len;
  }
  return 1;
}

// PNG

// Chunks that hold metadata: text, Exif, the last change time.
const PNG_META = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

export function stripPng(b) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, k) => b[k] === v)) throw new Error("Not a PNG file");
  const out = [b.subarray(0, 8)];
  const removed = [];
  for (const c of pngChunks(b)) {
    if (PNG_META.has(c.type)) removed.push(c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt" ? `Text: ${c.key}` : c.type === "eXIf" ? "Exif" : "Last changed time");
    else out.push(b.subarray(c.at, c.at + 12 + c.len));
  }
  return { bytes: concat(out), removed };
}

// The text fields of a PNG: [{ key, value }]. Compressed text shows as "(compressed)".
export function pngText(b) {
  const fields = [];
  for (const c of pngChunks(b)) {
    if (c.type !== "tEXt" && c.type !== "iTXt" && c.type !== "zTXt") continue;
    const data = b.subarray(c.at + 8, c.at + 8 + c.len);
    const zero = data.indexOf(0);
    const key = ascii(data, 0, zero);
    let value = "(compressed)";
    if (c.type === "tEXt") value = latin1(data.subarray(zero + 1));
    if (c.type === "iTXt" && data[zero + 1] === 0) {
      // keyword, flag, method, language\0, translated keyword\0, text
      let p = zero + 3;
      p = data.indexOf(0, p) + 1;
      p = data.indexOf(0, p) + 1;
      value = new TextDecoder().decode(data.subarray(p));
    }
    fields.push({ key, value });
  }
  return fields;
}

function* pngChunks(b) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    const chunk = { at: i, len, type, key: "" };
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const data = b.subarray(i + 8, i + 8 + len);
      chunk.key = ascii(data, 0, data.indexOf(0));
    }
    yield chunk;
    i += 12 + len;
    if (type === "IEND") break;
  }
}

// WebP

export function stripWebp(b) {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") throw new Error("Not a WebP file");
  const out = [];
  const removed = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const size = 8 + len + (len & 1);
    let chunk = b.subarray(i, i + size);
    if (type === "EXIF" || type === "XMP ") {
      removed.push(type === "EXIF" ? "Exif" : "XMP");
    } else {
      if (type === "VP8X") {
        // Clear the Exif (0x08) and XMP (0x04) flags.
        chunk = chunk.slice();
        chunk[8] &= ~0x0c;
      }
      out.push(chunk);
    }
    i += size;
  }
  const body = concat(out);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  const riff = body.length + 4;
  head[4] = riff & 0xff;
  head[5] = (riff >> 8) & 0xff;
  head[6] = (riff >> 16) & 0xff;
  head[7] = (riff >>> 24) & 0xff;
  return { bytes: concat([head, body]), removed };
}

// The Exif data inside a WebP file, as TIFF bytes, or null.
export function webpExif(b) {
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    if (type === "EXIF") {
      let data = b.subarray(i + 8, i + 8 + len);
      if (ascii(data, 0, 6) === "Exif\0\0") data = data.subarray(6);
      return data;
    }
    i += 8 + len + (len & 1);
  }
  return null;
}

// Helpers

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function latin1(b) {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

// The file type from its first bytes: "jpeg", "png", "webp", "pdf", "video" or null.
export function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "png";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (ascii(b, 0, 5) === "%PDF-") return "pdf";
  if (ascii(b, 4, 4) === "ftyp" || ascii(b, 4, 4) === "moov" || ascii(b, 4, 4) === "mdat" || ascii(b, 4, 4) === "wide") return "video";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video";
  return null;
}
