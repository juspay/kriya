import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 0 all pass, 1 a scenario failed, 2 preflight or usage, 3 dist, 4 evidence scan hit. */
export const EXIT_CODES = Object.freeze({
  PASS: 0,
  FAILED: 1,
  PREFLIGHT: 2,
  DIST: 3,
  EVIDENCE: 4,
});

export const MIN_NODE_VERSION = '20.8.1';
export const DEFAULT_TOOLS_DIR = '/tmp/amazon-guide';

const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CHROMIUM_EXECUTABLE =
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

/** -1, 0 or 1 comparing dotted numeric versions. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * BREEZE_CHROME_PATH, then the preferred build used by e2e/apps/*.check.mjs, then the first installed
 * chromium-N under the Playwright cache. Returns undefined when none exists.
 */
export function findChromium({
  env = process.env,
  exists = fs.existsSync,
  readdir = dir => fs.readdirSync(dir),
  cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright'),
} = {}) {
  const override = env.BREEZE_CHROME_PATH;
  if (typeof override === 'string' && override.length > 0 && exists(override)) {
    return override;
  }
  if (exists(PREFERRED_CHROMIUM)) {
    return PREFERRED_CHROMIUM;
  }
  const dirs = exists(cacheRoot)
    ? readdir(cacheRoot)
        .filter(dir => /^chromium-\d+$/.test(dir))
        .sort()
    : [];
  for (const dir of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const candidate = path.join(cacheRoot, dir, arch, CHROMIUM_EXECUTABLE);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function defaultLoadPlaywright(toolsDir) {
  return createRequire(path.join(toolsDir, 'package.json'))('playwright');
}

/**
 * Checks what a run needs before anything starts: Node version, Playwright (from BREEZE_GUIDE_TOOLS_DIR,
 * default /tmp/amazon-guide, exactly like the app self-checks), a Chromium executable (mandatory: the
 * Playwright revision there is not installed) and, unless `requireKey` is false, that TYPESAFE_API_KEY is
 * set. The key is reported as a boolean only; its value is never read into the result.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   nodeVersion?: string,
 *   loadPlaywright?: (toolsDir: string) => unknown,
 *   findChromium?: () => string | undefined,
 *   exists?: (file: string) => boolean,
 *   requireKey?: boolean,
 * }} [options]
 */
export function preflight(options = {}) {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const toolsDir = env.BREEZE_GUIDE_TOOLS_DIR || DEFAULT_TOOLS_DIR;
  const problems = [];

  const nodeOk = compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
  if (!nodeOk) {
    problems.push(`Node ${nodeVersion} is older than ${MIN_NODE_VERSION}`);
  }

  let playwright = null;
  try {
    playwright = (options.loadPlaywright ?? defaultLoadPlaywright)(toolsDir);
    if (playwright === null || typeof playwright?.chromium?.launch !== 'function') {
      playwright = null;
      problems.push(`Playwright loaded from ${toolsDir} has no chromium.launch`);
    }
  } catch {
    problems.push(`Playwright could not be loaded from ${toolsDir} (set BREEZE_GUIDE_TOOLS_DIR)`);
  }

  const chromePath = (options.findChromium ?? (() => findChromium({ env })))() ?? null;
  if (chromePath === null) {
    problems.push('no Chromium executable found (set BREEZE_CHROME_PATH)');
  }
  const override = env.BREEZE_CHROME_PATH;
  if (
    typeof override === 'string' &&
    override.length > 0 &&
    !(options.exists ?? fs.existsSync)(override)
  ) {
    // a mistyped override must not quietly run the tests in a different browser
    problems.push('BREEZE_CHROME_PATH is set but no file exists there');
  }

  const rawKey = env.TYPESAFE_API_KEY;
  const keyPresent = typeof rawKey === 'string' && rawKey.trim().length > 0;
  if (options.requireKey !== false && !keyPresent) {
    problems.push('TYPESAFE_API_KEY is not set (load it with node --env-file=<file>)');
  }

  const ok = problems.length === 0;
  return {
    ok,
    exitCode: ok ? EXIT_CODES.PASS : EXIT_CODES.PREFLIGHT,
    playwright,
    chromePath,
    node: nodeVersion,
    nodeOk,
    keyPresent,
    toolsDir,
    problems,
  };
}
