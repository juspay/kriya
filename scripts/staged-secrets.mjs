const SECRET_PATTERNS = [
  { category: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { category: 'OpenAI key', pattern: /\bsk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}\b/ },
  { category: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    category: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  { category: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    category: 'Private key block',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    category: 'Generic assigned secret',
    pattern:
      /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|(?:access|auth|client)?[_-]?(?:secret|token)|password|passwd)\b['"]?\s*[:=]\s*(['"])[a-z0-9_+/.=-]{16,}\1/i,
  },
];

/**
 * Return a fixed category for plaintext token signatures, private-key headers, or long secret literals.
 * Matches stay private so callers can report the category without exposing credential values.
 * @param {string} content
 * @returns {string | undefined}
 */
export function findStagedSecretCategory(content) {
  return SECRET_PATTERNS.find(({ pattern }) => pattern.test(content))?.category;
}
