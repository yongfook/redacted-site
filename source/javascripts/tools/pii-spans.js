// Shared detection for the text tools: categories, model labels, and the
// step that joins pattern, model and custom-word results into spans.
import { detectPatterns, detectCustom } from "./pii-patterns.js";

export const CATEGORIES = [
  { id: "name", label: "Names", on: true },
  { id: "org", label: "Organizations", on: true },
  { id: "place", label: "Places & addresses", on: true },
  { id: "contact", label: "Emails & phones", on: true },
  { id: "date", label: "Dates & ages", on: true },
  { id: "finance", label: "Card & bank numbers", on: true },
  { id: "id", label: "ID numbers", on: true },
  { id: "tech", label: "URLs, IPs & secrets", on: true },
  { id: "other", label: "Titles & groups", on: false },
];

// Model labels to our tags.
export const MODEL_TAGS = {
  PERSON: "NAME",
  ORGANIZATION: "ORG",
  LOCATION: "LOCATION",
  COORDINATE: "LOCATION",
  EMAIL_ADDRESS: "EMAIL",
  PHONE_NUMBER: "PHONE",
  URL: "URL",
  DATE_TIME: "DATE",
  AGE: "AGE",
  CREDIT_CARD: "CARD",
  FINANCIAL: "ACCOUNT",
  IBAN_CODE: "IBAN",
  US_BANK_NUMBER: "ACCOUNT",
  US_SSN: "SSN",
  US_ITIN: "ID",
  US_PASSPORT: "PASSPORT",
  US_DRIVER_LICENSE: "LICENSE",
  US_LICENSE_PLATE: "PLATE",
  IMEI: "ID",
  IP_ADDRESS: "IP",
  MAC_ADDRESS: "MAC",
  PASSWORD: "SECRET",
  NRP: "GROUP",
  TITLE: "TITLE",
};

export const TAG_CATEGORY = {
  NAME: "name",
  ORG: "org",
  LOCATION: "place",
  ADDRESS: "place",
  EMAIL: "contact",
  PHONE: "contact",
  DATE: "date",
  AGE: "date",
  CARD: "finance",
  IBAN: "finance",
  ACCOUNT: "finance",
  SSN: "id",
  ID: "id",
  PASSPORT: "id",
  LICENSE: "id",
  PLATE: "id",
  URL: "tech",
  IP: "tech",
  MAC: "tech",
  SECRET: "tech",
  GROUP: "other",
  TITLE: "other",
  CUSTOM: "custom",
};

export const MIN_MODEL_SCORE = 0.6;
export const MODEL_PREF = "redacted:text-redactor:model";

// All spans to hide in `text`. `modelSpans` are results from the PII model
// for this text, `terms` are words to always hide, and `enabled` is the set
// of category ids that are switched on.
export function collectSpans(text, { modelSpans = [], terms = [], enabled }) {
  const all = [];

  for (const s of detectPatterns(text)) all.push(s);

  for (const s of modelSpans) {
    const tag = MODEL_TAGS[s.label];
    if (tag && s.score >= MIN_MODEL_SCORE) all.push({ tag, start: s.start, end: s.end });
  }

  for (const s of detectCustom(text, terms)) all.push(s);

  const on = all.filter((s) => {
    const cat = TAG_CATEGORY[s.tag];
    return cat === "custom" || enabled.has(cat);
  });

  // Merge spans that overlap. The longer span gives the tag.
  on.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const s of on) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end - s.start > last.end - last.start) last.tag = s.tag;
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }

  // Trim spaces and trailing punctuation from each span.
  for (const s of merged) {
    while (s.start < s.end && /\s/.test(text[s.start])) s.start++;
    while (s.end > s.start && /[\s.,;:!?)]/.test(text[s.end - 1])) s.end--;
  }
  return merged.filter((s) => s.end > s.start);
}

// Words from a comma or line separated list.
export const parseTerms = (value) =>
  value
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
