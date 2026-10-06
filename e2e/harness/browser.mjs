import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

const DEFAULT_TOOLS_DIR = '/tmp/amazon-guide';
const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CHROMIUM_EXECUTABLE =
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const DIAGNOSTIC_LIMIT = 200;
const DIAGNOSTIC_TEXT_LIMIT = 500;

/** Same lookup as e2e/apps/*.check.mjs: the preferred build, else the first installed chromium-N. */
export function findChromium({
  preferred = PREFERRED_CHROMIUM,
  root = path.join(os.homedir(), 'Library/Caches/ms-playwright'),
  exists = fs.existsSync,
  readdir = dir => fs.readdirSync(dir),
} = {}) {
  if (exists(preferred)) {
    return preferred;
  }
  const dirs = exists(root)
    ? readdir(root)
        .filter(dir => /^chromium-\d+$/.test(dir))
        .sort()
    : [];
  for (const dir of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const candidate = path.join(root, dir, arch, CHROMIUM_EXECUTABLE);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function loadPlaywright(env) {
  const supplied = env?.playwright;
  if (
    supplied !== undefined &&
    supplied !== null &&
    typeof supplied.chromium?.launch === 'function'
  ) {
    return supplied;
  }
  const toolsDir = process.env.BREEZE_GUIDE_TOOLS_DIR || DEFAULT_TOOLS_DIR;
  return createRequire(path.join(toolsDir, 'package.json'))('playwright');
}

export async function launchBrowser(env = {}) {
  const { chromium } = loadPlaywright(env);
  const requested = typeof env.chromePath === 'string' ? env.chromePath : undefined;
  const executablePath =
    requested !== undefined && fs.existsSync(requested) ? requested : findChromium();
  if (executablePath === undefined) {
    throw new Error('No Chromium executable found: set chromePath or install a chromium build');
  }
  return chromium.launch({ headless: env.headless !== false, executablePath });
}

function initScriptSource(umd) {
  return `${umd}\n;WebAutomata.installTaskBridge();\n`;
}

const trim = text =>
  text.length > DIAGNOSTIC_TEXT_LIMIT ? text.slice(0, DIAGNOSTIC_TEXT_LIMIT) : text;

/**
 * One isolated context per scenario. The init script evaluates the UMD bundle and installs the bridge in
 * every document (the bridge itself refuses non-top frames and never overwrites an existing global).
 * diagnostics() returns bounded console lines and page errors for failure evidence; they are raw page
 * text, so the caller redacts them before writing.
 */
export async function newScenarioContext(browser, { umd } = {}) {
  if (typeof umd !== 'string' || umd.trim().length === 0) {
    throw new TypeError('newScenarioContext requires the UMD bundle text');
  }
  const context = await browser.newContext({ viewport: { ...VIEWPORT } });
  let page;
  const consoleLines = [];
  const pageErrors = [];
  try {
    await context.addInitScript({ content: initScriptSource(umd) });
    page = await context.newPage();
    page.on('console', message => {
      if (consoleLines.length < DIAGNOSTIC_LIMIT) {
        consoleLines.push({ type: message.type(), text: trim(message.text()) });
      }
    });
    page.on('pageerror', error => {
      if (pageErrors.length < DIAGNOSTIC_LIMIT) {
        pageErrors.push(trim(String(error?.message ?? error)));
      }
    });
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  };
  return {
    context,
    page,
    close,
    diagnostics: () => ({ console: consoleLines.slice(), pageErrors: pageErrors.slice() }),
  };
}
