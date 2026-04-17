#!/usr/bin/env node

/**
 * Code Quality Metrics Reporter
 *
 * Emits a JSON quality snapshot at quality-metrics.json and a human-readable
 * summary to stdout. Designed to be non-blocking on CI (always exit 0), but
 * still provide a signal to reviewers / PR comments.
 *
 * Metrics:
 *   - ESLint violations (error + warning counts, top rules)
 *   - TypeScript compilation status
 *   - File count and LOC (excluding blanks/comments)
 *   - Largest files (potential refactoring candidates)
 *   - TODO/FIXME count
 *   - Test coverage % if coverage-summary.json exists
 *   - npm audit summary (high+critical)
 *
 * Usage:
 *   node scripts/quality-metrics.cjs [--json-only]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const JSON_ONLY = process.argv.includes('--json-only');
const OUTPUT_FILE = path.join(ROOT, 'quality-metrics.json');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.rollup.cache',
  '.svelte-kit',
]);

function color(str, c) {
  return JSON_ONLY ? str : `${COLORS[c] || ''}${str}${COLORS.reset}`;
}

function log(msg, c = 'reset') {
  if (JSON_ONLY) return;
  console.log(color(msg, c));
}

function header(title) {
  if (JSON_ONLY) return;
  console.log('');
  console.log(color(`▸ ${title}`, 'bold'));
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function countLines(content) {
  const lines = content.split('\n');
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlockComment = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      blank++;
      continue;
    }
    if (inBlockComment) {
      comment++;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//')) {
      comment++;
      continue;
    }
    code++;
  }
  return { code, comment, blank, total: lines.length };
}

function collectFileStats() {
  header('Source files & LOC');
  const files = walk(path.join(ROOT, 'src'));
  let totalCode = 0;
  let totalComment = 0;
  let totalBlank = 0;
  const byFile = [];
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const { code, comment, blank } = countLines(content);
    totalCode += code;
    totalComment += comment;
    totalBlank += blank;
    byFile.push({ file: path.relative(ROOT, f), code, comment, blank });
  }
  byFile.sort((a, b) => b.code - a.code);
  const largest = byFile.slice(0, 10);
  log(`  Files: ${files.length}`);
  log(`  LOC (code): ${totalCode}`);
  log(`  LOC (comment): ${totalComment}`);
  log(`  LOC (blank): ${totalBlank}`);
  if (largest.length > 0) {
    log('  Largest files:', 'dim');
    for (const f of largest.slice(0, 5)) {
      log(`    ${f.file} — ${f.code} lines`, 'dim');
    }
  }
  return {
    fileCount: files.length,
    loc: { code: totalCode, comment: totalComment, blank: totalBlank },
    largestFiles: largest,
  };
}

function collectEslintMetrics() {
  header('ESLint violations');
  try {
    const raw = execSync('npx eslint src --format json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return summarizeEslint(JSON.parse(raw));
  } catch (err) {
    try {
      return summarizeEslint(JSON.parse(err.stdout || '[]'));
    } catch {
      log('  ⚠️ Could not run eslint', 'yellow');
      return { errors: 0, warnings: 0, topRules: [], filesWithIssues: 0 };
    }
  }
}

function summarizeEslint(results) {
  let errors = 0;
  let warnings = 0;
  const ruleCounts = new Map();
  let filesWithIssues = 0;
  for (const r of results) {
    if (r.errorCount > 0 || r.warningCount > 0) filesWithIssues++;
    errors += r.errorCount || 0;
    warnings += r.warningCount || 0;
    for (const m of r.messages || []) {
      const rule = m.ruleId || '<parser>';
      ruleCounts.set(rule, (ruleCounts.get(rule) || 0) + 1);
    }
  }
  const topRules = [...ruleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));
  log(`  Errors: ${errors}`, errors > 0 ? 'red' : 'green');
  log(`  Warnings: ${warnings}`, warnings > 0 ? 'yellow' : 'green');
  log(`  Files with issues: ${filesWithIssues}`);
  if (topRules.length > 0) {
    log('  Top rules:', 'dim');
    for (const { rule, count } of topRules.slice(0, 5)) {
      log(`    ${rule}: ${count}`, 'dim');
    }
  }
  return { errors, warnings, filesWithIssues, topRules };
}

function collectTypeScriptMetrics() {
  header('TypeScript compilation');
  try {
    execSync('npx tsc --noEmit', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log('  ✓ Compiled cleanly', 'green');
    return { compilationSuccessful: true, errorCount: 0 };
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    const errorCount = (output.match(/error TS\d+/g) || []).length;
    log(`  ✗ ${errorCount} compilation error(s)`, 'red');
    return { compilationSuccessful: false, errorCount };
  }
}

function collectTodoCount() {
  header('TODO / FIXME markers');
  const files = walk(path.join(ROOT, 'src'));
  let total = 0;
  const hits = [];
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (/(TODO|FIXME|XXX|HACK|BUG)[\s:]/i.test(line)) {
        total++;
        hits.push({ file: path.relative(ROOT, f), line: idx + 1 });
      }
    });
  }
  log(`  Found: ${total}`, total > 0 ? 'yellow' : 'green');
  return { total, samples: hits.slice(0, 10) };
}

function collectCoverage() {
  header('Test coverage');
  const summaryPath = path.join(ROOT, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) {
    log('  ℹ Not available (run `npm run test:coverage` to generate)', 'dim');
    return { available: false };
  }
  try {
    const data = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    const total = data.total || {};
    const pct = {
      lines: total.lines?.pct ?? 0,
      statements: total.statements?.pct ?? 0,
      functions: total.functions?.pct ?? 0,
      branches: total.branches?.pct ?? 0,
    };
    log(`  Lines: ${pct.lines}%`);
    log(`  Statements: ${pct.statements}%`);
    log(`  Functions: ${pct.functions}%`);
    log(`  Branches: ${pct.branches}%`);
    return { available: true, ...pct };
  } catch {
    log('  ⚠ coverage-summary.json could not be parsed', 'yellow');
    return { available: false };
  }
}

function collectAudit() {
  header('Security audit');
  try {
    const raw = execSync('npm audit --json --audit-level=high', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return summarizeAudit(JSON.parse(raw));
  } catch (err) {
    try {
      return summarizeAudit(JSON.parse(err.stdout || '{}'));
    } catch {
      log('  ⚠ npm audit unavailable', 'yellow');
      return { available: false };
    }
  }
}

function summarizeAudit(data) {
  const v = (data && data.metadata && data.metadata.vulnerabilities) || {};
  const out = {
    available: true,
    critical: v.critical || 0,
    high: v.high || 0,
    moderate: v.moderate || 0,
    low: v.low || 0,
  };
  const bad = out.critical + out.high;
  log(
    `  critical=${out.critical} high=${out.high} moderate=${out.moderate} low=${out.low}`,
    bad > 0 ? 'red' : 'green'
  );
  return out;
}

function main() {
  if (!JSON_ONLY) {
    console.log(color('\n📊 Kriya Quality Metrics', 'bold'));
    console.log(color('─'.repeat(60), 'dim'));
  }

  const metrics = {
    generatedAt: new Date().toISOString(),
    repo: 'kriya',
    files: collectFileStats(),
    eslint: collectEslintMetrics(),
    typescript: collectTypeScriptMetrics(),
    todos: collectTodoCount(),
    coverage: collectCoverage(),
    audit: collectAudit(),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2));
  if (!JSON_ONLY) {
    console.log('');
    log(`Wrote ${path.relative(ROOT, OUTPUT_FILE)}`, 'cyan');
    console.log(color('─'.repeat(60), 'dim'));
  }

  process.exit(0);
}

main();
