import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { checkDist } from '../harness/dist.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'node package-receipt.mjs --build <receipt> --quality <receipt> --chromium <receipt> --output <new-file>\n'
  );
  process.exit(0);
}
const argument = flag => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const output = argument('--output') ?? 'e2e/salvage/build-receipt.json';
if (fs.existsSync(output)) {
  process.stderr.write('Receipt already exists; choose a new output path.\n');
  process.exit(1);
}
const required = [
  'createTaskAgent',
  'createRemoteTaskHost',
  'createAutomationTaskHost',
  'installTaskBridge',
  'createTypeSafeTaskDecider',
  'createTaskPolicy',
  'createRedactor',
  'redactEnvelope',
  'createResearchRequest',
  'toResearchResult',
];
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const files = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
const dist = checkDist({ root });
const esm = await import(pathToFileURL(path.join(root, 'dist/index.esm.js')).href);
const cjs = createRequire(import.meta.url)(path.join(root, 'dist/index.cjs'));
const context = vm.createContext({ html2canvas: () => undefined });
vm.runInContext(fs.readFileSync('dist/index.umd.js', 'utf8'), context);
const types = fs.readFileSync('dist/index.d.ts', 'utf8');
const exports = Object.fromEntries(
  required.map(name => [
    name,
    {
      esm: typeof esm[name] === 'function',
      cjs: typeof cjs[name] === 'function',
      umd: typeof context.WebAutomata?.[name] === 'function',
      types: types.includes(name),
    },
  ])
);
const sourceFiles = files('src')
  .filter(name => name.endsWith('.ts'))
  .sort();
const sourceSha256 = hash(
  sourceFiles.map(name => `${name}\0${hash(fs.readFileSync(name))}`).join('\n')
);
const build = read(argument('--build') ?? 'e2e/salvage/package-page-cap-status.json');
const chromiumDist = read(argument('--chromium') ?? 'e2e/salvage/chromium-dist-proof.json');
const qualityReceipt = read(argument('--quality') ?? 'e2e/salvage/quality-final.json');
const quality = Array.isArray(qualityReceipt) ? qualityReceipt : qualityReceipt.checks;
const verified =
  dist.ok &&
  build.sourceSha256 === sourceSha256 &&
  build.distSha256 === dist.sha256 &&
  qualityReceipt.sourceSha256 === sourceSha256 &&
  qualityReceipt.distSha256 === dist.sha256 &&
  chromiumDist.sha256 === dist.sha256 &&
  build.exitCode === 0 &&
  chromiumDist.passed === true &&
  Object.values(exports).every(entry => Object.values(entry).every(Boolean)) &&
  quality.every(entry =>
    entry.check === 'protected'
      ? entry.mismatches.length === 0
      : entry.check === 'jest'
        ? entry.success === true
        : entry.exitCode === 0
  );
fs.writeFileSync(
  output,
  `${JSON.stringify({ verified, branch: 'feat/click-guide', sourceSha256, dist, exports, quality, build, chromiumDist }, null, 2)}\n`
);
process.stdout.write(
  `${JSON.stringify({ verified, sha256: dist.sha256, exports: required.length })}\n`
);
process.exitCode = verified ? 0 : 1;
