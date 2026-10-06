import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { checkDist } from '../harness/dist.mjs';
const tag = process.argv[2];
if (!tag || !/^[a-z0-9-]+$/.test(tag)) throw new Error('Provide a new receipt tag');
const root = process.cwd();
const base = `e2e/salvage/finish-${tag}`;
if (fs.existsSync(`${base}-quality.json`)) throw new Error('Receipt exists');
const hash = value => createHash('sha256').update(value).digest('hex');
const files = dir =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sourceHash = () =>
  hash(
    files('src')
      .filter(p => p.endsWith('.ts'))
      .sort()
      .map(p => `${p}\0${hash(fs.readFileSync(p))}`)
      .join('\n')
  );
const startingSource = sourceHash();
const run = (check, bin, args) =>
  new Promise(resolve => {
    const fd = fs.openSync(`${base}-${check}.log`, 'wx');
    const child = spawn(bin, args, { cwd: root, stdio: ['ignore', fd, fd] });
    child.on('error', () => {
      fs.closeSync(fd);
      resolve({ check, exitCode: -1 });
    });
    child.on('close', code => {
      try {
        fs.closeSync(fd);
      } catch {}
      resolve({ check, exitCode: code });
    });
  });
const checks = await Promise.all([
  run('tsc', './node_modules/.bin/tsc', ['--noEmit', '--incremental', 'false']),
  run('test-types', './node_modules/.bin/tsc', [
    '-p',
    'e2e/salvage/tsconfig-tests.json',
    '--noEmit',
    '--incremental',
    'false',
  ]),
  run('eslint', './node_modules/.bin/eslint', ['src', '--max-warnings', '0']),
  run('jest', './node_modules/.bin/jest', [
    '--runInBand',
    '--json',
    `--outputFile=${base}-jest.json`,
  ]),
  run('prettier', './node_modules/.bin/prettier', [
    '--check',
    'src/agent',
    'src/types/agent.ts',
    'tests/agent-request.test.ts',
    'tests/agent-typesafe.test.ts',
    'tests/task-agent-requirements.test.ts',
    'tests/task-observe.test.ts',
    'tests/resolver.test.ts',
    'tests/commands.test.ts',
    'tests/verify.test.ts',
    'docs/task-agent.md',
    'docs/task-agent-contract.md',
    'docs/task-agent-status.md',
  ]),
]);
const protectedFiles = JSON.parse(
  fs.readFileSync(process.env.PROTECTED_FILES ?? 'e2e/salvage/protected-files.json', 'utf8')
);
checks.push({
  check: 'protected',
  count: Object.keys(protectedFiles).length,
  mismatches: Object.entries(protectedFiles)
    .filter(([p, h]) => hash(fs.readFileSync(p)) !== h)
    .map(([p]) => p),
});
const jest = JSON.parse(fs.readFileSync(`${base}-jest.json`, 'utf8'));
Object.assign(
  checks.find(c => c.check === 'jest'),
  { success: jest.success, suites: jest.numPassedTestSuites, tests: jest.numPassedTests }
);
let passed =
  checks.every(c => (c.check === 'protected' ? c.mismatches.length === 0 : c.exitCode === 0)) &&
  startingSource === sourceHash();
let build;
if (passed) {
  build = await run('build', './node_modules/.bin/rollup', ['-c']);
  passed = build.exitCode === 0 && startingSource === sourceHash();
}
const dist = checkDist({ root });
const sourceSha256 = sourceHash();
const quality = {
  sourceSha256,
  distSha256: dist.sha256,
  checks,
  frozen: startingSource === sourceSha256,
  passed,
};
fs.writeFileSync(`${base}-quality.json`, JSON.stringify(quality, null, 2) + '\n');
if (build)
  fs.writeFileSync(
    `${base}-build.json`,
    JSON.stringify(
      {
        sourceSha256,
        distSha256: dist.sha256,
        dist,
        exitCode: build.exitCode,
        at: new Date().toISOString(),
        liveAcceptance: false,
      },
      null,
      2
    ) + '\n'
  );
process.stdout.write(
  JSON.stringify({ passed, checks, sourceSha256, distSha256: dist.sha256 }) + '\n'
);
process.exitCode = passed && dist.ok ? 0 : 1;
