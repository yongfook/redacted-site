// Languages the tools support: the OCR language data and the name model for
// each one. Each name model downloads once, only when it is needed.

export const NAME_MODELS = {
  en: { id: "onnx-community/bert-small-pii-detection-ONNX", size: 29 },
  multi: { id: "Xenova/distilbert-base-multilingual-cased-ner-hrl", size: 135 },
  th: { id: "Xenova/thainer-corpus-v2-base-model", size: 105 },
};

// English is always read too by OCR, because apps mix it in (times,
// buttons, links). Each extra OCR language is a 1–2 MB download.
export const LANGUAGES = {
  en: { label: "English", tesseract: ["eng"], model: "en" },
  es: { label: "Español", tesseract: ["eng", "spa"], model: "multi" },
  fr: { label: "Français", tesseract: ["eng", "fra"], model: "multi" },
  de: { label: "Deutsch", tesseract: ["eng", "deu"], model: "multi" },
  "zh-Hans": { label: "中文（简体）", tesseract: ["eng", "chi_sim"], model: "multi" },
  "zh-Hant": { label: "中文（繁體）", tesseract: ["eng", "chi_tra"], model: "multi" },
  ja: { label: "日本語", tesseract: ["eng", "jpn"], model: "multi" },
  th: { label: "ไทย", tesseract: ["eng", "tha"], model: "th" },
};

const PREF = "redacted:language";

// The saved choice, or the first browser language that the tools support.
export function startLanguage() {
  try {
    const saved = localStorage.getItem(PREF);
    if (saved && LANGUAGES[saved]) return saved;
  } catch {}
  for (const tag of navigator.languages || [navigator.language || "en"]) {
    const t = tag.toLowerCase();
    if (t.startsWith("zh")) return /hant|tw|hk|mo/.test(t) ? "zh-Hant" : "zh-Hans";
    const base = t.split("-")[0];
    if (LANGUAGES[base]) return base;
  }
  return "en";
}

export function saveLanguage(code) {
  try {
    localStorage.setItem(PREF, code);
  } catch {}
}

export const modelFor = (lang) => NAME_MODELS[LANGUAGES[lang].model];

// Fill a <select> with the languages.
export function fillLanguageSelect(select, value) {
  for (const [code, { label }] of Object.entries(LANGUAGES)) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = label;
    select.appendChild(o);
  }
  select.value = value;
}

// Remember, for each model, that the user turned it on. Such a model is in
// the browser cache, so it can start on its own next time without a new
// download. A model that was never turned on waits for a click.
const onKey = (model) => `redacted:ai-on:${model.id}`;

export function rememberModel(model) {
  try {
    localStorage.setItem(onKey(model), "1");
  } catch {}
}

export function modelWasOn(model) {
  try {
    if (localStorage.getItem(onKey(model)) === "1") return true;
    // Before models were remembered one by one, one setting covered the
    // English model.
    return model.id === NAME_MODELS.en.id && localStorage.getItem("redacted:text-redactor:model") === "1";
  } catch {
    return false;
  }
}
