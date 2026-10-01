// Pattern rules for the Secrets Scrubber: API keys, tokens, passwords,
// private keys, connection strings and internal hostnames in logs, config
// files and code. Each rule returns spans: { tag, start, end }.

// Values that are clearly not real secrets: empty, masked or a variable.
const PLACEHOLDER = /^(?:null|none|nil|true|false|\*+|x+|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|\{\{[^}]*\}\}|%[A-Z_]+%)$/i;

// Order matters: when two rules overlap, the one listed first wins.
const RULES = [
  {
    tag: "PRIVATE_KEY",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    // postgres://user:pass@host:5432/db and similar.
    tag: "CONNECTION",
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|oracle|clickhouse|kafka|nats|ldaps?|ftp|sftp|smtps?):\/\/[^\s"'`<>]+/gi,
  },
  {
    // Server=...;Password=...; style connection strings.
    tag: "CONNECTION",
    re: /\b(?:Server|Data Source|Host)=[^;"'\n]+;(?:[^;"'\n]+;)*\s*(?:Password|Pwd)=[^;"'\n]+;?/gi,
  },
  {
    // https://user:password@host
    tag: "PASSWORD",
    re: /\bhttps?:\/\/[^\s:@/"'`]+:([^\s@/"'`]+)@/gi,
    group: 1,
  },
  { tag: "TOKEN", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { tag: "API_KEY", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { tag: "API_KEY", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { tag: "API_KEY", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { tag: "API_KEY", re: /\b(?:sk|pk|rk)-(?:live|test)-[A-Za-z0-9]{8,}\b/g },
  { tag: "API_KEY", re: /\bwhsec_[A-Za-z0-9+/=]{20,}/g },
  { tag: "API_KEY", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { tag: "API_KEY", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { tag: "API_KEY", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { tag: "API_KEY", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { tag: "API_KEY", re: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g },
  { tag: "API_KEY", re: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { tag: "API_KEY", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { tag: "API_KEY", re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { tag: "API_KEY", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { tag: "API_KEY", re: /\b(?:AC|SK)[0-9a-f]{32}\b/g },
  { tag: "API_KEY", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { tag: "API_KEY", re: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  { tag: "API_KEY", re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { tag: "API_KEY", re: /\bdop_v1_[a-f0-9]{64}\b/g },
  { tag: "API_KEY", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  {
    // Authorization: Bearer <token>, Authorization: Basic <token>
    tag: "TOKEN",
    re: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g,
    group: 1,
  },
  {
    // AWS secret access key after its name.
    tag: "API_KEY",
    re: /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    group: 1,
  },
  {
    // password = "...", "password": "...", PASSWORD=...
    tag: "PASSWORD",
    re: /\b(?:[a-z0-9_]*_)?(?:password|passwd|pwd|pass|passphrase)\b["']?\s*[:=]\s*["']?([^\s"',;}{)]{3,})/gi,
    group: 1,
    test: (v) => !PLACEHOLDER.test(v),
  },
  {
    // Command line flags: --password secret, -p=secret is too common to guess.
    tag: "PASSWORD",
    re: /(?:^|\s)--?(?:password|passwd|pass)(?:=|\s+)["']?([^\s"']{3,})/gim,
    group: 1,
    test: (v) => !PLACEHOLDER.test(v) && !v.startsWith("-"),
  },
  {
    // api_key = "...", secret: "...", token=..., client_secret ...
    tag: "API_KEY",
    re: /\b(?:[a-z0-9_.-]*(?:secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key|encryption[_-]?key))\b["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/gi,
    group: 1,
    test: (v) => /\d/.test(v) && /[A-Za-z]/.test(v) && !PLACEHOLDER.test(v),
  },
  {
    // Hostnames that only exist inside a company network.
    tag: "HOST",
    // A space after the last dot is allowed when there is an earlier dot:
    // text read from screenshots often has one there ("db.prod. internal").
    re: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\. )?(?:internal|local|localdomain|corp|lan|intranet|private|home\.arpa|svc\.cluster\.local|ec2\.internal|compute\.internal)\b/gi,
  },
];

export function detectSecrets(text) {
  const spans = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      let value = m[0];
      let start = m.index;
      if (rule.group) {
        value = m[rule.group];
        if (!value) continue;
        start = m.index + m[0].lastIndexOf(value);
      }
      if (rule.test && !rule.test(value)) continue;
      const end = start + value.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ tag: rule.tag, start, end });
    }
  }
  return spans;
}
