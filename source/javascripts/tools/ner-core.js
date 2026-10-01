// Shared NER helpers for the text tools. Pure functions, no imports, so the
// same file runs in the browser worker and in Node tests.

// Split text into chunks that fit in the model context. Each chunk keeps
// its character offset in the original text.
export function chunkText(text, maxChars = 1000) {
  const chunks = [];
  const re = /[^\n]*\n*/g;
  let buf = "";
  let bufStart = 0;
  let m;

  const flush = () => {
    if (buf.trim()) chunks.push({ text: buf, offset: bufStart });
    buf = "";
  };

  while ((m = re.exec(text)) && m[0].length) {
    let line = m[0];
    let lineStart = m.index;

    // A very long line: split it on sentence ends, then on spaces.
    while (line.length > maxChars) {
      let cut = line.lastIndexOf(". ", maxChars);
      if (cut < maxChars / 2) cut = line.lastIndexOf(" ", maxChars);
      if (cut < maxChars / 2) cut = maxChars;
      else cut += 1;
      flush();
      chunks.push({ text: line.slice(0, cut), offset: lineStart });
      line = line.slice(cut);
      lineStart += cut;
    }

    if (buf.length + line.length > maxChars) flush();
    if (!buf) bufStart = lineStart;
    buf += line;
  }
  flush();
  return chunks;
}

// Find the character position of each token in the chunk. The pipeline
// gives only the decoded word, so walk forward through the text.
export function alignTokens(text, tokens) {
  // Compare without case or accents, because uncased models change both.
  // map[i] is the position in `text` of character i in `norm`.
  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  let norm = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    norm += f;
    for (let k = 0; k < f.length; k++) map.push(i);
  }

  let cursor = 0;
  const out = [];
  for (const t of tokens) {
    const word = fold(t.word.replace(/^##/, "").replace(/^▁/, "").trim());
    if (!word || word === "[unk]") continue;
    const at = norm.indexOf(word, cursor);
    // Skip a token we cannot place close to the cursor.
    if (at === -1 || at - cursor > 40) continue;
    const endAt = at + word.length;
    // Thai vowel and tone marks are removed when comparing. Include the
    // marks that follow the last letter.
    let end = map[endAt - 1] + 1;
    while (end < text.length && /\p{M}/u.test(text[end])) end++;
    out.push({ ...t, start: map[at], end });
    cursor = endAt;
  }
  return out;
}

// Join B-/I- tokens into entity spans and grow them to whole words.
export function groupSpans(text, tokens, minScore = 0.5) {
  const spans = [];
  let cur = null;

  for (const t of tokens) {
    if (t.entity === "O") {
      cur = null;
      continue;
    }
    const prefix = t.entity[1] === "-" ? t.entity[0] : "I";
    const label = t.entity[1] === "-" ? t.entity.slice(2) : t.entity;
    const gap = cur ? text.slice(cur.end, t.start) : "";
    // Join a sub-word of the same word, or an I- token after a short gap.
    const joins =
      cur &&
      cur.label === label &&
      (gap === "" || (prefix !== "B" && /^[\s\-.,'/]{1,3}$/.test(gap)));

    // A person's name does not continue on the next line. Text read from
    // screenshots puts the sender name on its own line, and the model often
    // marks the first word of the message as part of the name. Drop that
    // word. Addresses can continue on the next line.
    const newLine = gap.includes("\n") && /^(?:PER|PERSON)$/.test(label);
    if (cur && cur.label === label && prefix !== "B" && newLine) {
      cur = null;
      continue;
    }

    if (joins && !newLine) {
      cur.end = t.end;
      cur.scores.push(t.score);
    } else {
      cur = { label, start: t.start, end: t.end, scores: [t.score] };
      spans.push(cur);
    }
  }

  return spans
    .map((s) => {
      let { start, end } = s;
      // Not for scripts without spaces, where a "word" can be a whole line.
      const grow = (ch) => /[\p{L}\p{N}]/u.test(ch) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(ch);
      while (start > 0 && grow(text[start - 1])) start--;
      while (end < text.length && grow(text[end])) end++;
      const score = s.scores.reduce((a, b) => a + b, 0) / s.scores.length;
      return { label: s.label, start, end, score };
    })
    .filter((s) => s.score >= minScore);
}

// Run the classifier on the full text and return spans with global offsets.
export async function detectEntities(classifier, text, onProgress) {
  const chunks = chunkText(text);
  const spans = [];
  for (let i = 0; i < chunks.length; i++) {
    const { text: chunk, offset } = chunks[i];
    const tokens = await classifier(chunk, { ignore_labels: [] });
    for (const s of groupSpans(chunk, alignTokens(chunk, tokens))) {
      spans.push({ ...s, start: s.start + offset, end: s.end + offset });
    }
    if (onProgress) onProgress((i + 1) / chunks.length);
  }
  return spans;
}
