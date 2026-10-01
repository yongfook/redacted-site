// Consistent fake names for the chat anonymizers. The same person always
// gets the same fake name, also when the text uses only their first name.

const NAMES = [
  "Alex", "Sam", "Jordan", "Taylor", "Riley", "Casey", "Morgan", "Jamie",
  "Avery", "Quinn", "Rowan", "Charlie", "Robin", "Drew", "Sky", "Reese",
  "Kai", "Emerson", "Finley", "Harper", "Logan", "Parker", "Sage", "Blake",
];

// Compare names without case, accents or handle separators, so
// "@rajesh.kumar" and "Rajesh Kumar" are the same person.
const fold = (s) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[._]/g, " ")
    .replace(/[^\p{L}\p{N}' -]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// Returns a function: real name -> fake name. Make a new one for each
// render, so the names are given in the order people appear in the text.
export function pseudonymizer() {
  const byName = new Map(); // folded full name -> fake
  const byFirst = new Map(); // folded first name -> fake
  let next = 0;

  const fresh = () => {
    const base = NAMES[next % NAMES.length];
    const round = Math.floor(next / NAMES.length);
    next++;
    return round ? `${base} ${round + 1}` : base;
  };

  return (real) => {
    const key = fold(real);
    if (!key) return "[NAME]";
    if (byName.has(key)) return byName.get(key);
    const first = key.split(/\s+/)[0];
    // "Sarah" after "Sarah O'Connor", or the other way round. Never give a
    // person their own name.
    let fake = byFirst.get(first);
    if (!fake) {
      fake = fresh();
      if (fold(fake) === first) fake = fresh();
    }
    byName.set(key, fake);
    if (!byFirst.has(first)) byFirst.set(first, fake);
    return fake;
  };
}
