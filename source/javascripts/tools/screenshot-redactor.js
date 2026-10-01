// Screenshot Redactor: hide emails, phone numbers, names, usernames, keys,
// tokens and faces in any screenshot.
import { startScreenshotTool, SCREENSHOT_CATEGORIES } from "./screenshot-tool.js";
import { detectSecrets } from "./secret-patterns.js";

// The same categories as the chat tool, with keys and tokens added.
const categories = [
  ...SCREENSHOT_CATEGORIES.slice(0, 4),
  { id: "secrets", label: "Keys, tokens & passwords", on: true },
  ...SCREENSHOT_CATEGORIES.slice(4),
];

startScreenshotTool({
  sample: "/samples/app-screenshot.png",
  sampleName: "app-screenshot.png",
  categories,
  tagCategory: {
    API_KEY: "secrets",
    TOKEN: "secrets",
    PASSWORD: "secrets",
    PRIVATE_KEY: "secrets",
    CONNECTION: "secrets",
    SECRET: "secrets",
    HOST: "tech",
  },
  detect: detectSecrets,
  fileSuffix: "redacted",
});
