import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCommand } from './npm-command.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kriya-consumer-'));
/** Execute npm with literal arguments, forcing shell-free execution regardless of caller options. */
function runNpm(args, options) {
  const command = npmCommand(args);
  return execFileSync(command.file, command.args, { ...options, shell: false });
}
const required = [
  'createAutomationEngine',
  'createTaskAgent',
  'createRemoteTaskHost',
  'createAutomationTaskHost',
  'installTaskBridge',
  'createTypeSafeTaskDecider',
  'createTaskPolicy',
  'redactEnvelope',
  'createResearchRequest',
  'toResearchResult',
];
try {
  const packed = JSON.parse(
    runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
    })
  )[0];
  const paths = packed.files.map(file => file.path);
  for (const path of paths) {
    assert(!/(^|\/)(?:rescript|\.env[^/]*|node_modules|api-generated)(\/|$)/.test(path), path);
    assert(!/\.(?:mp4|webm|tsbuildinfo|map|tgz)$/.test(path), path);
  }
  for (const path of [
    'dist/index.cjs',
    'dist/index.esm.js',
    'dist/index.umd.js',
    'dist/index.d.ts',
  ]) {
    assert(paths.includes(path), `missing ${path}`);
  }
  for (const name of ['index.cjs', 'index.esm.js', 'index.umd.js']) {
    const source = await readFile(`dist/${name}`, 'utf8');
    assert(!/\/\/[#@] sourceMappingURL=/.test(source), `dangling source map in ${name}`);
  }
  assert(paths.includes('docs/integration/index.md'));
  assert(paths.includes('docs/examples/task-agent-node.mjs'));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  runNpm(
    ['install', join(directory, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: directory,
      stdio: 'pipe',
    }
  );
  const consumer = `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as esm from '@juspay/kriya';
const cjs = createRequire(import.meta.url)('@juspay/kriya');
assert.equal(typeof globalThis.document, 'undefined');
for (const name of ${JSON.stringify(required)}) {
  assert.equal(typeof esm[name], 'function', name);
  assert.equal(typeof cjs[name], 'function', name);
}
`;
  await writeFile(join(directory, 'consumer.mjs'), consumer);
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: directory, stdio: 'pipe' });
  await writeFile(
    join(directory, 'consumer.ts'),
    `import {createTaskAgent, createRemoteTaskHost} from '@juspay/kriya';
import type {TaskHost, TaskDecider, TaskAgent, TaskResult, TaskTransport, FormRegistryLike} from '@juspay/kriya';
export function integrate(host: TaskHost, decider: TaskDecider): TaskAgent { return createTaskAgent({host, decider}); }
export function remote(transport: TaskTransport): TaskHost { return createRemoteTaskHost({transport}); }
export function status(result: TaskResult): string { return result.status; }
export const registry: FormRegistryLike = {};
`
  );
  execFileSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--incremental',
      'false',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      join(directory, 'consumer.ts'),
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  );
  const installed = JSON.parse(
    await readFile(join(directory, 'node_modules/@juspay/kriya/package.json'), 'utf8')
  );
  assert.deepEqual(Object.keys(installed.dependencies), ['html2canvas']);
  assert.equal(installed.peerDependencies, undefined);
  process.stdout.write(
    JSON.stringify({
      gate: 'consumer-package',
      files: paths.length,
      esm: true,
      cjs: true,
      types: true,
      domFreeImport: true,
      forbiddenArtifacts: 0,
    }) + '\n'
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
