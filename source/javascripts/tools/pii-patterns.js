// Pattern-based detectors for structured personal data. These run
// instantly and catch formats that the model can miss.
// Each detector returns spans: { tag, start, end }.
import { intlDateSpans, intlIdSpans } from "./intl-patterns.js";

const digits = (s) => s.replace(/\D/g, "");

function luhn(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = +num[i];
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

// Order matters: when two patterns overlap, the one listed first wins.
const PATTERNS = [
  {
    tag: "SECRET",
    re: /\b(?:sk|pk|rk)[-_](?:live|test)[-_][A-Za-z0-9]{8,}\b|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    // The value after "password:", "token=" and similar.
    tag: "SECRET",
    re: /\b(?:password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',;]{4,})/gi,
    group: 1,
  },
  { tag: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { tag: "URL", re: /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi },
  {
    tag: "IBAN",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    test: (m) => digits(m).length >= 8,
  },
  {
    tag: "CARD",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    test: (m) => luhn(digits(m)),
  },
  { tag: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    // UK National Insurance number
    tag: "ID",
    re: /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  {
    tag: "IP",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi,
  },
  {
    tag: "DATE",
    re: new RegExp(
      `\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})\\.?,? \\d{4}\\b|\\b(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`,
      "gi"
    ),
  },
  {
    tag: "PHONE",
    // After a country code the first group can be one digit (+33 6 12 34 56
    // 78), and groups can be up to 8 digits (+49 151 23456789). "- " is
    // allowed between groups: OCR adds a space where a number wraps.
    re: /(?<![\w+])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,8}|(?:\(\d{1,4}\)[ .-]?)?\d{2,8})(?:(?:[ .-]|- )\d{2,8}){1,4}(?![\w])/g,
    test: (m) => {
      const n = digits(m).length;
      const intl = /^[+(]/.test(m);
      return n <= 15 && (n >= 9 || (intl && n >= 7));
    },
  },
  {
    // UK postcode
    tag: "ADDRESS",
    re: /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/g,
  },
  {
    tag: "ADDRESS",
    re: /\b\d{1,5}[A-Z]?,? (?:[A-Z][a-z]+ ){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Close|Crescent|Square|Sq)\b/g,
  },
];

export function detectPatterns(text) {
  const spans = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      let value = m[0];
      let start = m.index;
      if (p.group) {
        value = m[p.group];
        start = m.index + m[0].lastIndexOf(value);
      }
      if (p.test && !p.test(value)) continue;
      const end = start + value.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ tag: p.tag, start, end });
    }
  }
  // Dates and ID numbers in Spanish, French, German, Chinese, Japanese and Thai.
  for (const x of [...intlIdSpans(text), ...intlDateSpans(text)]) {
    if (!spans.some((s) => x.start < s.end && x.end > s.start)) spans.push(x);
  }
  return spans;
}

// Spans for words the user always wants hidden.
export function detectCustom(text, terms) {
  const spans = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) {
      spans.push({ tag: "CUSTOM", start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}
