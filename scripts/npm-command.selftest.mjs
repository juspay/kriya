import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCommand } from './npm-command.mjs';

const windowsNode = String.raw`C:\Program Files\Node & Tools (x64)\node.exe`;
const lifecycleCli = String.raw`C:\Users\Example User\npm & tools ^ 50%\node_modules\npm\bin\npm-cli.js`;
const adjacentCli = String.raw`C:\Program Files\Node & Tools (x64)\node_modules\npm\bin\npm-cli.js`;
const args = [
  'install',
  String.raw`C:\Temp\consumer & tools ^ 50% (test)\package.tgz`,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
];
const windowsOptions = { platform: 'win32', execPath: windowsNode };

for (const npmExecPath of [
  lifecycleCli,
  String.raw`\\server\npm tools & 50%\node_modules\npm\bin\npm-cli.js`,
]) {
  assert.deepEqual(
    npmCommand(args, {
      ...windowsOptions,
      npmExecPath,
      fileExists: candidate => candidate === npmExecPath || candidate === adjacentCli,
    }),
    { file: windowsNode, args: [npmExecPath, ...args] }
  );
}
for (const npmExecPath of [undefined, String.raw`C:\npm\npm.cmd`, lifecycleCli]) {
  assert.deepEqual(
    npmCommand(args, {
      ...windowsOptions,
      npmExecPath,
      fileExists: candidate => candidate === adjacentCli,
    }),
    { file: windowsNode, args: [adjacentCli, ...args] }
  );
}
assert.throws(
  () =>
    npmCommand(args, {
      ...windowsOptions,
      npmExecPath: undefined,
      fileExists: () => false,
    }),
  /Run "npm run verify:package".*npm_execpath/
);
assert.deepEqual(
  npmCommand(args, {
    platform: 'linux',
    execPath: '/usr/local/bin/node',
    npmExecPath: undefined,
    fileExists: () => false,
  }),
  { file: 'npm', args }
);

const directory = await mkdtemp(join(tmpdir(), 'npm-command-'));
try {
  const cliDirectory = join(directory, 'npm & tools ^ 50% (test)');
  await mkdir(cliDirectory);
  const cli = join(cliDirectory, 'npm-cli.js');
  await writeFile(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const literalArgs = [
    'pack',
    '--pack-destination',
    join(directory, 'consumer & tools ^ 50% (test)'),
    '$(touch npm-command-injected)',
    '"quoted" and \'single quoted\'',
    '%TEMP%',
  ];
  const command = npmCommand(literalArgs, { npmExecPath: cli });
  const received = JSON.parse(
    execFileSync(command.file, command.args, {
      cwd: directory,
      encoding: 'utf8',
      shell: false,
    })
  );
  assert.deepEqual(received, literalArgs);
  assert.equal(existsSync(join(directory, 'npm-command-injected')), false);
  process.stdout.write(
    JSON.stringify({
      gate: 'npm-command',
      windowsLifecycleSelection: true,
      windowsAdjacentFallback: true,
      windowsActionableFailure: true,
      posixDirectFallback: true,
      literalArgumentExecution: true,
      actualWindowsExecution: process.platform === 'win32',
    }) + '\n'
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
