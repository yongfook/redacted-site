// Secrets Scrubber: remove keys, tokens, passwords and internal hosts from
// logs, config files and code. Pattern rules only, no AI model.
import { startTextTool } from "./text-tool.js";
import { detectSecrets } from "./secret-patterns.js";

// The fake keys are joined from parts, so this file does not look like it
// holds real keys to secret scanners.
const k = (...parts) => parts.join("");

const EXAMPLE = `2026-10-01T09:14:22Z INFO  api-7f9c connecting to ${k("postgres://", "app_user:S3cr3t-pass", "@db-primary.prod.internal:5432/orders")}
2026-10-01T09:14:23Z DEBUG GET /v1/orders headers={"Authorization": "Bearer ${k("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")}"}
2026-10-01T09:14:25Z WARN  retrying payment call with ${k("sk_", "live_", "51HqLyjWDarjtT1zdp7dcXyzExample")} (attempt 2)
2026-10-01T09:14:26Z ERROR upload failed for sarah.oconnor@acme-legal.com from 10.0.4.17 to ${k("https://admin:", "hunter2", "@backup.corp/upload")}

# .env
OPENAI_API_KEY=${k("sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")}
AWS_ACCESS_KEY_ID=${k("AKIA", "IOSFODNN7EXAMPLE")}
AWS_SECRET_ACCESS_KEY=${k("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY")}
GITHUB_TOKEN=${k("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a")}
DATABASE_PASSWORD=\${DB_PASSWORD}
REDIS_URL=${k("rediss://:", "p4ssw0rd", "@cache.svc.cluster.local:6380/0")}
TIMEOUT_SECONDS=30

# config.json
{ "client_id": "web-app", "client_secret": "${k("9f86d081884c", "7d659a2feaa0c55ad015")}", "password": "correct-horse-battery" }

${k("-----BEGIN RSA ", "PRIVATE KEY-----")}
MIIEpAIBAAKCAQEA1c7example0example1example2example3example4
${k("-----END RSA ", "PRIVATE KEY-----")}`;

const CATEGORIES = [
  { id: "keys", label: "API keys & tokens", on: true },
  { id: "password", label: "Passwords", on: true },
  { id: "private", label: "Private keys", on: true },
  { id: "conn", label: "Connection strings", on: true },
  { id: "host", label: "Internal hostnames", on: true },
  { id: "ip", label: "IP & MAC addresses", on: true },
  { id: "email", label: "Emails", on: true },
  { id: "url", label: "All URLs", on: false },
];

const TAG_CATEGORY = {
  API_KEY: "keys",
  TOKEN: "keys",
  SECRET: "keys",
  PASSWORD: "password",
  PRIVATE_KEY: "private",
  CONNECTION: "conn",
  HOST: "host",
  IP: "ip",
  MAC: "ip",
  EMAIL: "email",
  URL: "url",
};

startTextTool({
  example: EXAMPLE,
  categories: CATEGORIES,
  tagCategory: TAG_CATEGORY,
  detect: detectSecrets,
  useModel: false,
  fileName: "scrubbed.txt",
});
