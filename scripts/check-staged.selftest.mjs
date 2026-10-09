#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GUARD_PATH = fileURLToPath(new URL('./check-staged.mjs', import.meta.url));
const MAX_BYTES = 1024 * 1024;
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Staged guard fixture',
  GIT_AUTHOR_EMAIL: 'staged-guard@example.invalid',
  GIT_COMMITTER_NAME: 'Staged guard fixture',
  GIT_COMMITTER_EMAIL: 'staged-guard@example.invalid',
};

/** Run fixture Git with isolated configuration, literal arguments, and optional piped input. */
function runGit(repository, args, input) {
  return execFileSync('git', args, { cwd: repository, env: GIT_ENV, encoding: 'utf8', input });
}

/** Create a temporary Git repository and remove it even when a fixture assertion fails. */
function withRepository(check) {
  const repository = mkdtempSync(join(tmpdir(), 'check-staged-selftest-'));
  try {
    runGit(repository, ['init', '--quiet']);
    check(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

/** Establish a fixture baseline using temporary-repository Git plumbing, leaving the project untouched. */
function commitFixture(repository, filename, content) {
  writeFileSync(join(repository, filename), content);
  runGit(repository, ['add', '--', filename]);
  const tree = runGit(repository, ['write-tree']).trim();
  const commit = runGit(repository, ['commit-tree', '-m', 'Harmless fixture', tree]).trim();
  runGit(repository, ['update-ref', 'HEAD', commit]);
}

/** Stage an exact rename and confirm its indexed identity using NUL-delimited path metadata. */
function withStagedRename(destination, content, check) {
  withRepository(repository => {
    const source = 'harmless source.txt';
    commitFixture(repository, source, content);
    runGit(repository, ['mv', '--', source, destination]);

    const entries = runGit(repository, [
      'diff',
      '--cached',
      '--name-status',
      '--find-renames',
      '-z',
    ]).split('\0');
    assert.deepEqual(entries, ['R100', source, destination, '']);
    check(repository);
  });
}

/** Run the real guard against a fixture index, rejecting spawn errors and process signals. */
function runGuard(repository, nodeArgs = [], env = GIT_ENV) {
  const result = spawnSync(process.execPath, [...nodeArgs, GUARD_PATH], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

/** Require exit code 1 and the expected policy diagnostic rather than an arbitrary process failure. */
function assertRefused(result, message) {
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(message), result.stderr);
}

test('renamed environment filename is refused before any Git object lookup', () => {
  withStagedRename('.env.selftest', Buffer.alloc(32, 'x'), repository => {
    const probe = join(repository, 'object-access-probe.mjs');
    const trace = join(repository, 'git-commands.jsonl');
    writeFileSync(
      probe,
      `import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  appendFileSync(process.env.STAGED_GUARD_TRACE, JSON.stringify({ command, args }) + '\\n');
  if (command !== 'git' || args[0] !== 'diff') {
    throw new Error('Environment fixture reached Git object lookup');
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
`
    );

    const result = runGuard(repository, ['--import', pathToFileURL(probe).href], {
      ...GIT_ENV,
      STAGED_GUARD_TRACE: trace,
    });
    assertRefused(result, 'Environment files cannot be committed: .env.selftest');
    assert.ok(!result.stderr.includes('Environment fixture reached Git object lookup'));
    const commands = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, 'git');
    assert.equal(commands[0].args[0], 'diff');
  });
});

test('renamed recording filename is refused', () => {
  withStagedRename('renamed recording.webm', Buffer.alloc(32, 'x'), repository => {
    assertRefused(
      runGuard(repository),
      'Recordings belong in preserved evidence, not Git: renamed recording.webm'
    );
  });
});

test('renamed file larger than 1 MiB is refused', () => {
  withStagedRename('oversized renamed.txt', Buffer.alloc(MAX_BYTES + 1, 'x'), repository => {
    assertRefused(runGuard(repository), 'Staged file exceeds 1 MiB: oversized renamed.txt');
  });
});

test('ordinary rename with spaces and Unicode is allowed', () => {
  withStagedRename('renamed file with spaces 雪.txt', Buffer.alloc(32, 'x'), repository => {
    const result = runGuard(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('ordinary rename with a newline is allowed', { skip: process.platform === 'win32' }, () => {
  withStagedRename('renamed file\nwith spaces.txt', Buffer.alloc(32, 'x'), repository => {
    const result = runGuard(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('renamed file at the 1 MiB limit is allowed', () => {
  withStagedRename('limit renamed.txt', Buffer.alloc(MAX_BYTES, 'x'), repository => {
    const result = runGuard(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

const SECRET_FIXTURES = [
  { category: 'OpenAI key', create: () => ['sk', '-proj-', 'A'.repeat(32)].join('') },
  { category: 'Anthropic key', create: () => ['sk', '-ant-', 'A'.repeat(32)].join('') },
  { category: 'AWS access key', create: () => ['AK', 'IA', 'A'.repeat(16)].join('') },
  { category: 'GitHub token', create: () => ['gh', 'p_', 'A'.repeat(36)].join('') },
  { category: 'Slack token', create: () => ['xo', 'xb-', 'A'.repeat(24)].join('') },
  { category: 'Private key block', create: () => ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('') },
  {
    category: 'Generic assigned secret',
    create: () => `apiKey = "${['synthetic', 'A'.repeat(24)].join('')}"`,
  },
];

/** Require a path/category refusal with empty stdout and no synthetic value fragments in stderr. */
function assertSecretRefused(result, filename, category, content) {
  assertRefused(result, `Staged secret detected (${category}): ${filename}`);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes(content), 'Secret content must not appear in diagnostics');
  assert.ok(
    !result.stderr.includes('A'.repeat(16)),
    'Secret fragments must not appear in diagnostics'
  );
}

for (const { category, create } of SECRET_FIXTURES) {
  test(`indexed content containing ${category} is refused without printing the value`, () => {
    withRepository(repository => {
      const filename = 'indexed fixture.txt';
      const content = create();
      writeFileSync(join(repository, filename), content);
      runGit(repository, ['add', '--', filename]);
      assertSecretRefused(runGuard(repository), filename, category, content);
    });
  });
}

test('secret in the index is refused when the working copy is clean', () => {
  withRepository(repository => {
    const filename = 'divergent fixture.txt';
    const clean = 'Harmless checked-in fixture\n';
    const content = SECRET_FIXTURES[3].create();
    commitFixture(repository, filename, clean);
    writeFileSync(join(repository, filename), content);
    runGit(repository, ['add', '--', filename]);
    writeFileSync(join(repository, filename), clean);
    assertSecretRefused(runGuard(repository), filename, 'GitHub token', content);
  });
});

test('clean indexed content is allowed when the working copy contains a synthetic secret', () => {
  withRepository(repository => {
    const filename = 'divergent fixture.txt';
    commitFixture(repository, filename, 'Harmless original fixture\n');
    writeFileSync(join(repository, filename), 'Harmless changed fixture\n');
    runGit(repository, ['add', '--', filename]);
    writeFileSync(join(repository, filename), SECRET_FIXTURES[3].create());
    const result = runGuard(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('renamed indexed content containing a synthetic credential is refused', () => {
  const content = SECRET_FIXTURES[3].create();
  withStagedRename('renamed credential.txt', content, repository => {
    assertSecretRefused(runGuard(repository), 'renamed credential.txt', 'GitHub token', content);
  });
});

test('indexed type changes containing a synthetic credential are refused', () => {
  withRepository(repository => {
    const filename = 'type-change.txt';
    const content = SECRET_FIXTURES[3].create();
    commitFixture(repository, filename, 'Harmless original fixture\n');
    const object = runGit(repository, ['hash-object', '-w', '--stdin'], content).trim();
    runGit(repository, ['update-index', '--cacheinfo', `120000,${object},${filename}`]);
    const status = runGit(repository, ['diff', '--cached', '--name-status', '-z']).split('\0');
    assert.deepEqual(status, ['T', filename, '']);
    assertSecretRefused(runGuard(repository), filename, 'GitHub token', content);
  });
});

test('example labels do not suppress indexed credential detection', () => {
  withRepository(repository => {
    const filename = 'example fixture.txt';
    const content = `example: ${SECRET_FIXTURES[3].create()}`;
    writeFileSync(join(repository, filename), content);
    runGit(repository, ['add', '--', filename]);
    assertSecretRefused(runGuard(repository), filename, 'GitHub token', content);
  });
});

test('guard sources, split fixtures, and environment references are allowed', () => {
  withRepository(repository => {
    for (const filename of [
      'check-staged.mjs',
      'check-staged.selftest.mjs',
      'staged-secrets.mjs',
    ]) {
      const content = readFileSync(new URL(filename, import.meta.url));
      writeFileSync(join(repository, filename), content);
      runGit(repository, ['add', '--', filename]);
    }
    writeFileSync(
      join(repository, 'references.js'),
      'const token = process.env.API_TOKEN;\nconst apiKey = "<YOUR_API_KEY>";\n'
    );
    runGit(repository, ['add', '--', 'references.js']);
    const result = runGuard(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});
