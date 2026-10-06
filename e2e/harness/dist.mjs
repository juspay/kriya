import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EXIT_CODES } from './env.mjs';

/** Exports the harness drives (contract 2.16: a bundle missing any of them is exit 3). */
export const REQUIRED_EXPORTS = Object.freeze([
  'createTaskAgent',
  'installTaskBridge',
  'createRemoteTaskHost',
  'createTypeSafeTaskDecider',
  'redactEnvelope',
]);

/**
 * The whole source tree the bundles are built from: the dist must be newer than every file in it, so an
 * edit to src/index.ts (the export block), src/forms, src/context or src/guide cannot hide behind a
 * bundle that predates it.
 */
export const SOURCE_DIRS = Object.freeze(['src']);

export const BUNDLE_FILES = Object.freeze({ esm: 'index.esm.js', umd: 'index.umd.js' });

const IGNORED_FILES = new Set(['.DS_Store']);

function newestFile(dir) {
  let newest = null;
  if (!fs.existsSync(dir)) {
    return newest;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const candidate = entry.isDirectory()
      ? newestFile(full)
      : entry.isFile() && !IGNORED_FILES.has(entry.name)
        ? { file: full, mtimeMs: fs.statSync(full).mtimeMs }
        : null;
    if (candidate !== null && (newest === null || candidate.mtimeMs > newest.mtimeMs)) {
      newest = candidate;
    }
  }
  return newest;
}

/** Names exported by a bundled ES module: `export { a, b as c }` clauses and `export function|const|class`. */
export function exportedNames(esmText) {
  const names = new Set();
  for (const match of esmText.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) {
        names.add(name);
      }
    }
  }
  for (const match of esmText.matchAll(
    /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  )) {
    names.add(match[1]);
  }
  return names;
}

const sha256Of = buffer => createHash('sha256').update(buffer).digest('hex');

/**
 * Verifies the built bundles without ever building: both exist, export what the harness drives, and are
 * newer than every source file they were built from. `sha256` identifies the pair (sha256 of the two
 * file hashes, ESM first); `files` carries each hash. Exit code 3 on any problem.
 *
 * @param {{ root: string, requiredExports?: readonly string[], sourceDirs?: readonly string[] }} options
 */
export function checkDist({ root, requiredExports = REQUIRED_EXPORTS, sourceDirs = SOURCE_DIRS }) {
  const reasons = [];
  const distDir = path.join(root, 'dist');
  const paths = {
    esm: path.join(distDir, BUNDLE_FILES.esm),
    umd: path.join(distDir, BUNDLE_FILES.umd),
  };
  for (const [kind, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) {
      reasons.push(`missing dist/${BUNDLE_FILES[kind]}`);
    }
  }
  if (reasons.length > 0) {
    return { ok: false, exitCode: EXIT_CODES.DIST, sha256: null, reasons, files: {} };
  }

  const buffers = { esm: fs.readFileSync(paths.esm), umd: fs.readFileSync(paths.umd) };
  const texts = { esm: buffers.esm.toString('utf8'), umd: buffers.umd.toString('utf8') };
  const exported = exportedNames(texts.esm);
  for (const name of requiredExports) {
    if (!exported.has(name)) {
      reasons.push(`dist/${BUNDLE_FILES.esm} does not export ${name}`);
    }
    if (!texts.umd.includes(name)) {
      reasons.push(`dist/${BUNDLE_FILES.umd} does not contain ${name}`);
    }
  }

  const oldest = Math.min(fs.statSync(paths.esm).mtimeMs, fs.statSync(paths.umd).mtimeMs);
  let newestSource = null;
  for (const dir of sourceDirs) {
    const candidate = newestFile(path.join(root, dir));
    if (candidate !== null && (newestSource === null || candidate.mtimeMs > newestSource.mtimeMs)) {
      newestSource = candidate;
    }
  }
  if (newestSource !== null && newestSource.mtimeMs > oldest) {
    reasons.push(
      `stale dist: ${path.relative(root, newestSource.file)} is newer than the bundles (rebuild required)`
    );
  }

  const files = {
    esm: { sha256: sha256Of(buffers.esm), bytes: buffers.esm.length },
    umd: { sha256: sha256Of(buffers.umd), bytes: buffers.umd.length },
  };
  return {
    ok: reasons.length === 0,
    exitCode: reasons.length === 0 ? EXIT_CODES.PASS : EXIT_CODES.DIST,
    sha256: sha256Of(Buffer.from(`${files.esm.sha256}\n${files.umd.sha256}`)),
    reasons,
    files,
    newestSource:
      newestSource === null
        ? null
        : { file: path.relative(root, newestSource.file), mtimeMs: newestSource.mtimeMs },
  };
}

/** UMD text for the init script and the file URL of the ESM bundle (imported once by the runner). */
export function readBundles(root) {
  const esmPath = path.join(root, 'dist', BUNDLE_FILES.esm);
  const umdPath = path.join(root, 'dist', BUNDLE_FILES.umd);
  if (!fs.existsSync(esmPath) || !fs.existsSync(umdPath)) {
    throw new Error('dist bundles are missing: run the package build before the e2e harness');
  }
  const umdBuffer = fs.readFileSync(umdPath);
  const esmSha = sha256Of(fs.readFileSync(esmPath));
  return {
    umd: umdBuffer.toString('utf8'),
    esmUrl: pathToFileURL(esmPath).href,
    esmPath,
    umdPath,
    sha256: sha256Of(Buffer.from(`${esmSha}\n${sha256Of(umdBuffer)}`)),
  };
}
