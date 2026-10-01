// Rules for the Chat Anonymizer: find who sent each message in a chat
// export, then find every other place their names appear, and @mentions.
// Returns spans: { tag: "NAME", start, end }.

// A person's name: one to four words that start with a letter.
const NAME = "[\\p{Lu}\\p{Ll}][\\p{L}'’.-]*(?: [\\p{Lu}\\p{Ll}][\\p{L}'’.-]*){0,3}";
const TIME = "\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?(?:\\s?[AaPp]\\.?[Mm]\\.?)?";
const DATE = "\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}";

// Each format finds the sender name in group "name".
const FORMATS = [
  // WhatsApp (iPhone): [12/03/2024, 14:05:12] Sarah O'Connor: Hi
  new RegExp(`^\\u200e?\\[${DATE},? ${TIME}\\] (?<name>${NAME}):`, "gmu"),
  // WhatsApp (Android): 12/03/2024, 14:05 - Sarah O'Connor: Hi
  new RegExp(`^${DATE},? ${TIME} [-–] (?<name>${NAME}):`, "gmu"),
  // Teams: [10:42 AM] Sarah O'Connor
  new RegExp(`^\\[${TIME}\\] (?<name>${NAME})\\s*$`, "gmu"),
  // Slack: Sarah O'Connor  10:42 AM   or   Sarah O'Connor [10:42 AM]
  new RegExp(`^(?<name>${NAME}) {1,3}\\[?${TIME}\\]?\\s*$`, "gmu"),
  // Discord: Sarah — Today at 10:42 AM
  new RegExp(`^(?<name>${NAME}) [—-] (?:Today|Yesterday|${DATE}) at ${TIME}\\s*$`, "gmu"),
];

// "Name: message" at the start of a line. Used only when at least two
// different people write this way, so a single "Note:" is not a person.
const SIMPLE = new RegExp(`^(?<name>${NAME}): \\S`, "gmu");

// Words that start lines with a colon but are not people.
const NOT_NAMES = new Set(
  "note notes re fw fwd subject date time to from cc bcc update edit edited ps p.s q a question answer summary agenda action actions todo warning error info tip example result status reminder update sent received meeting location address phone email url link file attachment"
    .split(" ")
);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isRealName = (n) => !NOT_NAMES.has(n.toLowerCase()) && !/^\d/.test(n);

export function detectChat(text) {
  const senders = new Set();

  for (const re of FORMATS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) if (isRealName(m.groups.name)) senders.add(m.groups.name.trim());
  }

  if (!senders.size) {
    const simple = new Map();
    SIMPLE.lastIndex = 0;
    for (const m of text.matchAll(SIMPLE)) {
      const n = m.groups.name.trim();
      if (isRealName(n)) simple.set(n, (simple.get(n) || 0) + 1);
    }
    if (simple.size >= 2) for (const n of simple.keys()) senders.add(n);
  }

  // Full names, and first names of three letters or more.
  const names = new Set();
  for (const s of senders) {
    names.add(s);
    const first = s.split(" ")[0];
    if (first.length >= 3 && first !== s) names.add(first);
  }

  const spans = [];
  const add = (start, end) => {
    if (!spans.some((s) => start < s.end && end > s.start)) spans.push({ tag: "NAME", start, end });
  };

  // Longest names first, so "Sarah O'Connor" wins over "Sarah".
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of text.matchAll(re)) add(m.index, m.index + m[0].length);
  }

  // @mentions: hide the handle, keep the @.
  for (const m of text.matchAll(/(?<![\w.])@([A-Za-z][\w.-]{1,30}[A-Za-z0-9])/g)) {
    add(m.index + 1, m.index + m[0].length);
  }

  return spans.sort((a, b) => a.start - b.start);
}
