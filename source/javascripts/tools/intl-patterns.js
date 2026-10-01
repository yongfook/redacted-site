// Pattern rules for Spanish, French, German, Chinese, Japanese and Thai:
// dates, times and national ID numbers. Pure functions, no imports, so the
// same file runs in the browser and in Node tests.
// Each rule returns spans: { tag, start, end }.

// Dates and times

const ES_MONTH = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|sept?iembre|octubre|noviembre|diciembre";
const ES_DAY = "lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo";
const FR_MONTH = "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";
const FR_DAY = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";
const DE_MONTH = "Januar|Jänner|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember";
const DE_DAY = "Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonnabend|Sonntag";
const TH_MONTH = "มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม";
const TH_DAY = "วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัสบดี|วันพฤหัส|วันศุกร์|วันเสาร์|วันอาทิตย์";
const UNITS_ES = "segundos?|minutos?|horas?|días?|dias?|semanas?|mes(?:es)?|años?";
const UNITS_FR = "secondes?|minutes?|heures?|jours?|semaines?|mois|ans?|années?";
const UNITS_DE = "Sekunden?|Minuten?|Stunden?|Tag(?:en)?|Wochen?|Monat(?:en)?|Jahr(?:en)?";

// Word boundaries that also work next to accented letters.
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

const DATE_RULES = [
  // Spanish: martes 14 de marzo de 2025, 14 de marzo, hace 3 días, ayer
  `${B}(?:(?:${ES_DAY}),? )?\\d{1,2} de (?:${ES_MONTH})(?: de \\d{4})?${E}`,
  `${B}hace \\d+ (?:${UNITS_ES})${E}`,
  `${B}(?:${ES_DAY}|hoy|ayer|anteayer)${E}`,
  // French: mardi 14 mars 2025, 14 mars, il y a 3 jours, hier, 8 h 30
  `${B}(?:(?:${FR_DAY}) )?\\d{1,2}(?:er)? (?:${FR_MONTH})(?: \\d{4})?${E}`,
  `${B}il y a \\d+ (?:${UNITS_FR})${E}`,
  `${B}(?:${FR_DAY}|aujourd['’]hui|hier|avant-hier)${E}`,
  `${B}\\d{1,2} ?h(?: ?\\d{2})?${E}`,
  // German: Dienstag, 14. März 2025, 14. März, vor 3 Tagen, gestern, 8 Uhr
  `${B}(?:(?:${DE_DAY}),? )?\\d{1,2}\\. ?(?:${DE_MONTH})(?: \\d{4})?${E}`,
  `${B}vor \\d+ (?:${UNITS_DE})${E}`,
  `${B}(?:${DE_DAY}|heute|gestern|vorgestern)${E}`,
  `${B}\\d{1,2}(?:[:.]\\d{2})? Uhr${E}`,
  // Chinese and Japanese: 2025年3月14日, 3月14日, 下午3:45, 8点, 午後3時, 3日前
  `(?:\\d{2,4}年)?\\d{1,2}月\\d{1,2}[日号]`,
  `\\d{2,4}年\\d{1,2}月`,
  `(?:星期|周|週)[一二三四五六日天]`,
  `[月火水木金土日]曜日?`,
  `(?:今天|昨天|前天|今日|昨日|一昨日|おととい)`,
  `(?:上午|下午|中午|晚上|早上|凌晨|午前|午後)\\s?\\d{1,2}(?:[:：]\\d{2}|[点點時](?:\\d{1,2}分)?)?`,
  `\\d{1,2}[点點時](?:\\d{1,2}分|半)?`,
  `\\d+\\s?(?:分钟|分鐘|小时|小時|分|時間|天|日|周|週間|个月|個月|か月|ヶ月|年)前`,
  // Thai: วันที่ 14 มีนาคม 2568, 14 มีนาคม, วันนี้, เมื่อวาน, 8 โมง, 14:05 น.
  `(?:วันที่ ?)?\\d{1,2} ?(?:${TH_MONTH})(?: ?\\d{4})?`,
  `(?:${TH_DAY}|วันนี้|เมื่อวาน|เมื่อวานนี้)`,
  `\\d{1,2} ?โมง(?:เช้า|เย็น)?`,
  `\\d{1,2}[:.]\\d{2} ?น\\.`,
];

const DATE_RE = new RegExp(DATE_RULES.join("|"), "giu");

export function intlDateSpans(text) {
  return [...text.matchAll(DATE_RE)].map((m) => ({ tag: "DATE", start: m.index, end: m.index + m[0].length }));
}

// National ID numbers, each with its check digit, so other long numbers do
// not match.

const digits = (s) => s.replace(/\D/g, "");

const ID_RULES = [
  {
    // Spain: DNI 12345678Z and NIE X1234567L.
    re: /(?<![\p{L}\p{N}])([XYZ]?)(\d{7,8})-?([A-Z])(?![\p{L}\p{N}])/giu,
    test: (m) => {
      const prefix = { X: "0", Y: "1", Z: "2" }[m[1].toUpperCase()] || "";
      const number = prefix + m[2];
      if (number.length !== 8) return false;
      return "TRWAGMYFPDXBNJZSQVHLCKE"[Number(number) % 23] === m[3].toUpperCase();
    },
  },
  {
    // France: numéro de sécurité sociale, 1 85 05 78 006 084 36.
    re: /(?<![\p{N}])([12]) ?(\d{2}) ?(\d{2}) ?(\d{2}|2[AB]) ?(\d{3}) ?(\d{3}) ?(\d{2})(?![\p{N}])/giu,
    test: (m) => {
      const dept = m[4].toUpperCase().replace("2A", "19").replace("2B", "18");
      const body = BigInt(m[1] + m[2] + m[3] + dept + m[5] + m[6]);
      return 97n - (body % 97n) === BigInt(m[7]);
    },
  },
  {
    // China: resident identity card, 18 characters.
    re: /(?<![\p{N}])(\d{17}[\dX])(?![\p{N}])/giu,
    test: (m) => {
      const id = m[1].toUpperCase();
      const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
      const sum = w.reduce((a, x, i) => a + x * Number(id[i]), 0);
      return "10X98765432"[sum % 11] === id[17];
    },
  },
  {
    // Japan: My Number, 12 digits, often 1234 5678 9012.
    re: /(?<![\p{N}])(\d{4}[ -]?\d{4}[ -]?\d{4})(?![\p{N}])/gu,
    test: (m) => {
      const d = digits(m[1]);
      let sum = 0;
      for (let n = 1; n <= 11; n++) sum += Number(d[11 - n]) * (n <= 6 ? n + 1 : n - 5);
      const r = sum % 11;
      return (r <= 1 ? 0 : 11 - r) === Number(d[11]);
    },
  },
  {
    // Thailand: national ID, 13 digits, often 1-2345-67890-12-3.
    re: /(?<![\p{N}])(\d[ -]?\d{4}[ -]?\d{5}[ -]?\d{2}[ -]?\d)(?![\p{N}])/gu,
    test: (m) => {
      const d = digits(m[1]);
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
      return (11 - (sum % 11)) % 10 === Number(d[12]);
    },
  },
];

export function intlIdSpans(text) {
  const spans = [];
  for (const rule of ID_RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      if (!rule.test(m)) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ tag: "ID", start, end });
    }
  }
  return spans;
}
