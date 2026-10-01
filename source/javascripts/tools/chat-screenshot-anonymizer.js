// Chat Screenshot Anonymizer: hide names, profile pictures, faces, numbers
// and links in chat screenshots, and give people consistent fake names.
import { startScreenshotTool } from "./screenshot-tool.js";

startScreenshotTool({
  sample: "/samples/chat-screenshot.png",
  sampleName: "chat-screenshot.png",
  chatRules: true,
  fileSuffix: "anonymized",
});
