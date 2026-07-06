/**
 * Best-effort credential filter (spec section 7).
 *
 * Before saving memory content we scan for common credential patterns and
 * reject the save if anything matches. NOTE: this is a heuristic safety net,
 * NOT a guarantee — novel or obfuscated secret formats will slip through.
 * Never rely on this instead of caller-side judgment.
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI / Anthropic style keys (sk-..., sk-ant-...)
  { name: "API key (sk-...)", regex: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  // AWS access key id
  { name: "AWS access key (AKIA...)", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  // AWS-style secret assignment
  {
    name: "AWS secret key assignment",
    regex: /aws_?secret[^\n]{0,20}[:=]\s*['"]?[A-Za-z0-9/+=]{30,}/i,
  },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  { name: "GitHub token (gh*_...)", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  // Slack tokens
  { name: "Slack token (xox...)", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // Google API key
  { name: "Google API key (AIza...)", regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  // Generic password assignment: password: xxx / password=xxx / passwd / pwd
  {
    name: "password assignment",
    regex: /\b(password|passwd|pwd)\s*[:=]\s*\S+/i,
  },
  // Generic secret/token/api-key assignment with a long opaque value
  {
    name: "secret/token assignment",
    regex: /\b(api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}/i,
  },
  // Bearer tokens in headers
  { name: "Bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  // PEM private key blocks
  {
    name: "private key block",
    regex: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
  },
];

/**
 * Returns the human-readable name of the first credential-like pattern found
 * in `content`, or null if nothing suspicious was detected.
 */
export function detectSecret(content: string): string | null {
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(content)) return name;
  }
  return null;
}
