// Read-only source identity proof for the acceptance packages. Usage:
//   node e2e/acceptance/verify-source.mjs --quality <quality.json> --baseline <protected-files.json> --output <new-file> [--omit-head]
// Recomputes the source hash, compares it with the frozen quality receipt, re-hashes every protected file
// (all MP4s included) against the baseline, and records the git position. It writes only the output file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const qualityPath = option('--quality');
const baselinePath = option('--baseline');
const output = option('--output');
const omitHead = args.includes('--omit-head');
if (!qualityPath || !baselinePath || !output) {
  throw new Error('Usage: --quality <file> --baseline <file> --output <new-file>');
}

const hash = value => createHash('sha256').update(value).digest('hex');
const files = dir =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    );
const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();

const sourceSha256 = hash(
  files('src')
    .filter(file => file.endsWith('.ts'))
    .sort()
    .map(file => `${file}\0${hash(fs.readFileSync(file))}`)
    .join('\n')
);
const quality = JSON.parse(fs.readFileSync(qualityPath, 'utf8'));
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const protectedMismatches = Object.entries(baseline)
  .filter(([file, expected]) => !fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected)
  .map(([file]) => file);
const mp4 = Object.keys(baseline).filter(file => file.endsWith('.mp4'));

const report = {
  label: 'Source identity and protected-file proof (read-only)',
  at: new Date().toISOString(),
  ...(omitHead
    ? {}
    : {
        head: git('rev-parse', 'HEAD'),
        branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
        commitsAheadOfOriginMain: Number(git('rev-list', '--count', 'origin/main..HEAD')),
      }),
  originMain: git('rev-parse', 'origin/main'),
  sourceSha256,
  qualityReceiptSourceSha256: quality.sourceSha256,
  sourceMatchesQualityReceipt: sourceSha256 === quality.sourceSha256,
  qualityPassed: quality.passed === true,
  protectedFiles: { checked: Object.keys(baseline).length, mismatches: protectedMismatches },
  mp4: {
    checked: mp4.length,
    mismatches: protectedMismatches.filter(file => file.endsWith('.mp4')),
  },
  passed:
    sourceSha256 === quality.sourceSha256 &&
    quality.passed === true &&
    protectedMismatches.length === 0,
};
try {
  // 'wx' creates the file or fails if it exists; a separate existence check would race with it.
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
  throw error?.code === 'EEXIST' ? new Error('Output exists; choose a new path.') : error;
}
process.stdout.write(
  `${JSON.stringify({ passed: report.passed, sourceSha256, checked: report.protectedFiles.checked, mp4: report.mp4.checked, mismatches: protectedMismatches })}\n`
);
process.exitCode = report.passed ? 0 : 1;
