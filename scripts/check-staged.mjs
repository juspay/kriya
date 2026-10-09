import { execFileSync } from 'node:child_process';
import { findStagedSecretCategory } from './staged-secrets.mjs';

const MAX_BYTES = 1024 * 1024;

const files = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'],
  {
    encoding: 'utf8',
  }
)
  .split('\0')
  .filter(Boolean);
for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) {
    throw new Error(`Environment files cannot be committed: ${file}`);
  }
  if (/\.(?:mp4|webm)$/i.test(file)) {
    throw new Error(`Recordings belong in preserved evidence, not Git: ${file}`);
  }
  const size = Number(execFileSync('git', ['cat-file', '-s', `:${file}`], { encoding: 'utf8' }));
  if (size > MAX_BYTES) {
    throw new Error(`Staged file exceeds 1 MiB: ${file}`);
  }
}

for (const file of files) {
  let content;
  try {
    content = execFileSync('git', ['cat-file', 'blob', `:${file}`], {
      encoding: 'utf8',
      maxBuffer: MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Cannot inspect indexed content: ${file}`);
  }
  const category = findStagedSecretCategory(content);
  if (category) {
    throw new Error(`Staged secret detected (${category}): ${file}`);
  }
}
