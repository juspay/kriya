#!/usr/bin/env node

/**
 * Security Check Script
 * Scans source code and config for leaked secrets, unsafe DOM patterns,
 * and runs npm audit. Designed for CI and pre-commit use.
 *
 * Usage:
 *   node scripts/security-check.cjs          # full scan
 *   node scripts/security-check.cjs --quick  # source-only, skip npm audit
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const QUICK = process.argv.includes('--quick');

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// Named directories we always skip — including the few dot-prefixed ones that
// exist only as build/cache artefacts. Every other dot-prefixed dir (notably
// `.github/` and `.husky/`) SHOULD be scanned because workflow YAML and shell
// hooks are prime places for leaked PATs and tokens.
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.rollup.cache',
  '.svelte-kit',
  '.venv',
  '.next',
  '.nuxt',
]);

const SECRET_PATTERNS = [
  { name: 'OpenAI key', re: /sk-(?:proj-|admin-)?[A-Za-z0-9]{20,}/g },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub PAT', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |DSA |EC )?PRIVATE KEY-----/g },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    name: 'Generic assigned secret',
    re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
  },
];

const UNSAFE_DOM_PATTERNS = [
  { name: 'innerHTML assignment', re: /\.innerHTML\s*=/g },
  { name: 'outerHTML assignment', re: /\.outerHTML\s*=/g },
  { name: 'document.write', re: /document\.write\s*\(/g },
  { name: 'eval()', re: /\beval\s*\(/g },
  { name: 'new Function()', re: /new\s+Function\s*\(/g },
];

const FALSE_POSITIVE_HINTS = [
  'process.env',
  'import.meta.env',
  '${',
  'example',
  'placeholder',
  'your-',
  'xxx',
  'changeme',
];

function color(str, c) {
  return `${COLORS[c] || ''}${str}${COLORS.reset}`;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Skip named exclude dirs only. Do NOT blanket-skip dot-prefixed entries:
    // `.github/`, `.husky/`, `.gitleaks.toml`, `.coderabbit.yaml` etc. must
    // be scanned — workflow YAML is a prime spot for PAT / token leaks.
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else {
      // Scan source-like and config-like files. Cover typical dotfile configs
      // (`.env.example`, `.gitleaks.toml`, `.releaserc.json`, etc.) by matching
      // the trailing extension rather than a name prefix.
      const matchesExt = /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|md|sh)$/.test(e.name);
      const isDotfileConfig =
        /^\.(env\.example|nvmrc|gitattributes|editorconfig|npmrc|npmignore|prettierrc|prettierignore|markdownlint\.json)$/.test(
          e.name
        );
      if (!matchesExt && !isDotfileConfig) continue;
      // Skip this scanner — its SECRET_PATTERNS regex literals would self-match.
      if (path.relative(ROOT, full) === path.join('scripts', 'security-check.cjs')) {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function isLikelyFalsePositive(line) {
  const lower = line.toLowerCase();
  return FALSE_POSITIVE_HINTS.some(h => lower.includes(h));
}

const NON_PROD_PATH_RE = /^(examples|tests?|docs|\.env\.example)/;

function isNonProductionPath(relPath) {
  return NON_PROD_PATH_RE.test(relPath);
}

function scanSecrets(files) {
  const prod = [];
  const nonProd = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const rel = path.relative(ROOT, file);
    const bucket = isNonProductionPath(rel) ? nonProd : prod;
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      for (const { name, re } of SECRET_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line) && !isLikelyFalsePositive(line)) {
          bucket.push({ file: rel, line: idx + 1, kind: name });
        }
      }
    });
  }
  return { prod, nonProd };
}

function scanUnsafeDom(files) {
  const findings = [];
  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      for (const { name, re } of UNSAFE_DOM_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) {
          findings.push({
            file: path.relative(ROOT, file),
            line: idx + 1,
            kind: name,
          });
        }
      }
    });
  }
  return findings;
}

function runNpmAudit() {
  // Only audit production deps — dev deps like semantic-release bundle their
  // own npm, whose transitive vulns we can't override.
  try {
    const raw = execSync('npm audit --json --audit-level=high --omit=dev', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(raw);
    const vulns = data.metadata?.vulnerabilities || {};
    return {
      critical: vulns.critical || 0,
      high: vulns.high || 0,
      moderate: vulns.moderate || 0,
      low: vulns.low || 0,
    };
  } catch (err) {
    try {
      const data = JSON.parse(err.stdout || '{}');
      const vulns = data.metadata?.vulnerabilities || {};
      return {
        critical: vulns.critical || 0,
        high: vulns.high || 0,
        moderate: vulns.moderate || 0,
        low: vulns.low || 0,
      };
    } catch {
      return null;
    }
  }
}

function main() {
  console.log(color('\n🔒 Security Check', 'bold'));
  console.log(color('─'.repeat(60), 'dim'));

  const files = walk(ROOT);
  console.log(color(`Scanning ${files.length} file(s)...`, 'dim'));

  const { prod: prodSecrets, nonProd: nonProdSecrets } = scanSecrets(files);
  const unsafe = scanUnsafeDom(files);

  let failed = false;

  if (prodSecrets.length > 0) {
    failed = true;
    console.log(color(`\n✗ Secrets in production code: ${prodSecrets.length}`, 'red'));
    prodSecrets.slice(0, 10).forEach(f => {
      console.log(color(`  ${f.file}:${f.line} — ${f.kind}`, 'red'));
    });
    if (prodSecrets.length > 10) {
      console.log(color(`  ... and ${prodSecrets.length - 10} more`, 'dim'));
    }
  } else {
    console.log(color('\n✓ No secrets in production code', 'green'));
  }

  if (nonProdSecrets.length > 0) {
    console.log(
      color(`\n⚠ Secret-like strings in examples/tests/docs: ${nonProdSecrets.length}`, 'yellow')
    );
    nonProdSecrets.slice(0, 5).forEach(f => {
      console.log(color(`  ${f.file}:${f.line} — ${f.kind}`, 'yellow'));
    });
    if (nonProdSecrets.length > 5) {
      console.log(color(`  ... and ${nonProdSecrets.length - 5} more`, 'dim'));
    }
    console.log(color('  (non-blocking; verify these are fixtures)', 'dim'));
  }

  if (unsafe.length > 0) {
    console.log(color(`\n⚠ Unsafe DOM patterns: ${unsafe.length} (review carefully)`, 'yellow'));
    unsafe.slice(0, 10).forEach(f => {
      console.log(color(`  ${f.file}:${f.line} — ${f.kind}`, 'yellow'));
    });
    if (unsafe.length > 10) {
      console.log(color(`  ... and ${unsafe.length - 10} more`, 'dim'));
    }
    console.log(
      color('  (non-blocking; sanitize inputs if values come from untrusted sources)', 'dim')
    );
  } else {
    console.log(color('✓ No unsafe DOM patterns', 'green'));
  }

  if (!QUICK) {
    console.log(color('\nRunning npm audit...', 'dim'));
    const audit = runNpmAudit();
    if (!audit) {
      console.log(color('⚠ npm audit could not be parsed', 'yellow'));
    } else {
      console.log(
        `  critical=${audit.critical}  high=${audit.high}  moderate=${audit.moderate}  low=${audit.low}`
      );
      if (audit.critical > 0 || audit.high > 0) {
        failed = true;
        console.log(color('✗ High/critical vulnerabilities found', 'red'));
      } else {
        console.log(color('✓ No high/critical vulnerabilities', 'green'));
      }
    }
  }

  console.log(color('─'.repeat(60), 'dim'));
  if (failed) {
    console.log(color('Security check FAILED', 'red'));
    process.exit(1);
  }
  console.log(color('Security check passed', 'green'));
}

main();
