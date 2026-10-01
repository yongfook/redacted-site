// Chat Anonymizer: give every person in a chat export a consistent fake
// name, so the conversation still reads correctly.
import { startTextTool } from "./text-tool.js";
import { detectChat } from "./chat-patterns.js";
import { CATEGORIES } from "./pii-spans.js";

const EXAMPLE = `[12/03/2025, 14:05:12] Sarah O'Connor: Hi Miguel, did you get the signed contract?
[12/03/2025, 14:06:40] Miguel Ángel Fernández: Yes! I sent a copy to Emma Lindqvist at Northwind too.
[12/03/2025, 14:07:02] Sarah O'Connor: Great. If the bank asks, my number is +44 20 7946 0958.
[12/03/2025, 14:09:31] Rajesh Kumar: Sarah, I booked the train to Toronto for Friday. @miguel can you join?
[12/03/2025, 14:10:15] Miguel Ángel Fernández: Sure. Send the tickets to miguel.fernandez@example.com
[12/03/2025, 14:11:48] Sarah O'Connor: Thanks Rajesh 👍`;

// The same categories as the Text Redactor, but chat timestamps are dates,
// so dates are shown by default.
const DEFAULT_ON = new Set(["name", "contact", "place", "finance", "id"]);
const categories = CATEGORIES.map((c) => ({ ...c, on: DEFAULT_ON.has(c.id) }));

startTextTool({
  example: EXAMPLE,
  categories,
  detect: detectChat,
  fileName: "anonymized-chat.txt",
});
