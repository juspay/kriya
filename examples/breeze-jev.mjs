import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createBreezeChrome } from './breeze-chrome.mjs';

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = process.env.BREEZE_GUIDE_TOOLS_DIR ?? '/tmp/amazon-guide';
const apiKey = process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim();
if (!apiKey) {
  console.error(
    'Live Jev recording requires TYPESAFE_API_KEY (or JEV_API_KEY). No scripted fallback ran. Use node --env-file=/path/to/private.env examples/breeze-jev.mjs.'
  );
  process.exit(1);
}
const { chromium } = createRequire(join(toolsDir, 'package.json'))('playwright');
const esbuild = createRequire(join(worktree, 'package.json'))('esbuild');
const runDir = join(toolsDir, 'jev-verification', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(runDir, { recursive: true });
const src = join(worktree, 'src');
const aliases = {
  name: 'kriya-source',
  setup(build) {
    build.onResolve({ filter: /^@\// }, args => {
      const base = join(src, args.path.slice(2));
      return { path: existsSync(`${base}.ts`) ? `${base}.ts` : join(base, 'index.ts') };
    });
  },
};
await esbuild.build({
  entryPoints: [join(src, 'guide/index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'KriyaGuide',
  platform: 'browser',
  target: 'es2020',
  outfile: join(runDir, 'guide.js'),
  plugins: [aliases],
  footer: { js: 'globalThis.KriyaGuide = KriyaGuide;' },
});
await esbuild.build({
  entryPoints: [join(src, 'guide/typesafe.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: join(runDir, 'adapter.mjs'),
  plugins: [aliases],
});
const { createTypeSafeDecider } = await import(join(runDir, 'adapter.mjs'));
const endpoint = 'https://api.typesafe.ai/v1/systemone';
const calls = [];
const decisions = [];
const saveCalls = () =>
  writeFileSync(
    join(runDir, 'jev-calls.json'),
    JSON.stringify({ mode: 'live-jev', endpoint, calls, decisions }, null, 2).replaceAll(
      apiKey,
      '[REDACTED]'
    )
  );
const sleep = ms => new Promise(done => setTimeout(done, ms));
const decide = createTypeSafeDecider({
  apiKey,
  http: async (url, init) => {
    if (url !== endpoint) throw new Error('Unexpected Jev endpoint');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (calls.length >= 32) throw new Error('Jev request limit reached');
      const request = JSON.parse(init.body);
      const started = Date.now();
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      calls.push({
        at: new Date(started).toISOString(),
        attempt,
        status: response.status,
        latencyMs: Date.now() - started,
        request,
        response: payload,
      });
      saveCalls();
      console.info(
        `Jev HTTP ${response.status}: ${request.state.page.url}, ${Date.now() - started}ms, model ${payload?.model ?? 'unreported'}`
      );
      if ((response.status === 429 || response.status === 529) && attempt < 3) {
        await sleep(attempt * 500);
        continue;
      }
      return {
        ok: response.ok,
        status: response.status,
        json: async () => {
          if (payload === null || (response.ok && !/^jev-/.test(payload.model ?? '')))
            throw new Error('Missing Jev response model');
          return payload;
        },
      };
    }
    throw new Error('Jev retry limit reached');
  },
});

const defaultQuestion = 'Does breeze.in offer one-click checkout?';
const sentence = process.env.BREEZE_GUIDE_QUESTION ?? defaultQuestion;
const chromePath =
  process.env.BREEZE_CHROME_PATH ??
  '/Users/sachinsharma/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: process.argv.includes('--headless'),
  args: ['--disable-blink-features=AutomationControlled'],
});
let context;
let page;
let video;
let result;
let finalState;
let arrowAtSeconds;
let finalAtSeconds;
let previousHighlight;
const navigations = [];
const permittedUrl = url =>
  ['breeze.in', 'www.breeze.in'].includes(url.hostname) &&
  url.protocol === 'https:' &&
  !/^\/(?:shop|docs|directory|d2c-directory)(?:\/|$)/i.test(url.pathname);
try {
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: runDir, size: { width: 1440, height: 900 } },
    locale: 'en-US',
  });
  await context.addInitScript({ path: join(runDir, 'guide.js') });
  await context.addInitScript(() => {
    globalThis.__breezeRecording = { arrowClicks: 0 };
    document.addEventListener(
      'click',
      event => {
        if (event.target instanceof Element && event.target.closest('#nl-go'))
          globalThis.__breezeRecording.arrowClicks += 1;
      },
      true
    );
  });
  page = await context.newPage();
  video = page.video();
  const started = Date.now();
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      const url = new URL(request.url());
      if (request.frame() !== page.mainFrame() || !permittedUrl(url)) {
        await route.abort();
        return;
      }
    }
    await route.continue();
  });
  const logo =
    'data:image/webp;base64,' + readFileSync(join(toolsDir, 'brand/mark.webp')).toString('base64');
  const chrome = createBreezeChrome(page, logo);
  await page.exposeBinding('jevDecide', async (source, request) => {
    if (
      source.frame !== page.mainFrame() ||
      request.state.page.url !== page.url() ||
      request.model !== 'jev-latest'
    )
      throw new Error('Invalid research request context');
    const decision = await decide(request);
    decisions.push({ page: request.state.page.url, task: request.state.task, decision });
    saveCalls();
    return decision;
  });
  await page.exposeBinding('executeResearchStep', async (_source, step) => {
    if (step.operation === 'WAIT') {
      await page.waitForTimeout(850);
      return;
    }
    if (step.operation === 'SCROLL_UP' || step.operation === 'SCROLL_DOWN') {
      const top = await page.evaluate(
        op => Math.max(0, scrollY + innerHeight * (op === 'SCROLL_UP' ? -0.7 : 0.7)),
        step.operation
      );
      await chrome.smoothScroll(top);
      return;
    }
    if (step.operation === 'CLICK') {
      const point = await page.evaluate(index => {
        const control = globalThis.KriyaGuide.elementForGuideIndex(index);
        if (!control) throw new Error('The selected navigation disappeared');
        globalThis.KriyaGuide.paintHighlight(control, '');
        document
          .getElementById('kriya-click-guide-highlight')
          ?.style.setProperty('z-index', '2147483645');
        document
          .querySelector('#kriya-click-guide-highlight [data-kriya-guide="hand"]')
          ?.removeAttribute('style');
        document.getElementById('kriya-click-guide-status')?.remove();
        document.getElementById('nl-cursor')?.style.removeProperty('display');
        const rect = control.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.65, y: rect.top + rect.height * 0.65 };
      }, step.targetIndex);
      await chrome.moveCursorTo(point.x, point.y);
      await page.waitForTimeout(250);
      previousHighlight = await page.evaluate(() => {
        const box = document.getElementById('kriya-click-guide-highlight');
        return box
          ? Object.fromEntries(
              ['top', 'left', 'width', 'height', 'borderRadius'].map(key => [key, box.style[key]])
            )
          : null;
      });
      await page.evaluate(async index => {
        const control = globalThis.KriyaGuide.elementForGuideIndex(index);
        if (!control) throw new Error('Jev navigation target disappeared');
        const update = async () => {
          const before = location.href;
          control.click();
          const deadline = performance.now() + 15000;
          while (location.href === before) {
            if (performance.now() > deadline)
              throw new Error('The selected navigation did not change the page');
            await new Promise(done => setTimeout(done, 40));
          }
          await document.fonts.ready;
        };
        if (document.startViewTransition) {
          const transition = document.startViewTransition(update);
          await transition.updateCallbackDone;
          await transition.finished;
        } else {
          await update();
        }
      }, step.targetIndex);
      return;
    }
    if (step.operation !== 'HIGHLIGHT') throw new Error('Unsupported research action');
    await page.evaluate(async index => {
      const target = globalThis.KriyaGuide.elementForGuideIndex(index);
      if (!target) throw new Error('Jev evidence target disappeared');
      const images = [...document.images].filter(
        img =>
          img.getBoundingClientRect().top <= target.getBoundingClientRect().top && img.width > 0
      );
      for (const img of images) img.loading = 'eager';
      let timer;
      await Promise.race([
        Promise.all(images.map(img => img.decode().catch(() => {}))),
        new Promise(done => {
          timer = setTimeout(done, 10000);
        }),
      ]);
      clearTimeout(timer);
    }, step.targetIndex);
    const top = await page.evaluate(index => {
      const target = globalThis.KriyaGuide.elementForGuideIndex(index);
      if (!target) throw new Error('Jev evidence target disappeared');
      return Math.max(0, target.getBoundingClientRect().top + scrollY - 250);
    }, step.targetIndex);
    await chrome.smoothScroll(top);
    const endpoint = await page.evaluate(
      ({ index, from }) => {
        const target = globalThis.KriyaGuide.elementForGuideIndex(index);
        if (!target) throw new Error('Jev evidence target disappeared');
        const rect = target.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > innerHeight)
          throw new Error('Jev evidence is not fully visible');
        globalThis.KriyaGuide.paintHighlight(target, '');
        const box = document.getElementById('kriya-click-guide-highlight');
        box?.style.setProperty('z-index', '2147483645');
        if (from && box) {
          box.style.transition = 'none';
          for (const key of ['top', 'left', 'width', 'height', 'borderRadius'])
            box.style[key] = from[key];
          void box.offsetWidth;
          box.style.transition = '';
          globalThis.KriyaGuide.paintHighlight(target, '');
        }
        box?.querySelector('[data-kriya-guide="hand"]')?.removeAttribute('style');
        document.getElementById('nl-cursor')?.style.removeProperty('display');
        document.getElementById('kriya-click-guide-status')?.remove();
        return { x: rect.left + rect.width * 0.72, y: rect.top + rect.height * 0.62 };
      },
      { index: step.targetIndex, from: previousHighlight }
    );
    previousHighlight = null;
    await chrome.moveCursorTo(endpoint.x, endpoint.y);
    await page.waitForTimeout(820);
  });
  const evidenceFrames = [];
  await page.exposeBinding('showResearchStep', async (_source, step) => {
    if (step.operation === 'HIGHLIGHT') {
      await chrome.showAnswer(step.label, 'ok');
      await page.waitForTimeout(900);
      const atSeconds = (Date.now() - started) / 1000;
      evidenceFrames.push({ label: step.label, url: page.url(), atSeconds });
      await page.screenshot({
        path: join(runDir, `evidence-${evidenceFrames.length}-browser.png`),
      });
    }
  });
  await page.goto('https://breeze.in/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.trim().length > 160);
  await page.waitForTimeout(1200);
  await chrome.installChrome();
  await page.waitForTimeout(800);
  await chrome.typeInto('[data-nl="question"]', sentence);
  await page.evaluate(
    ({ sentence, defaultQuestion }) => {
      const isNavigationChrome = element =>
        element.closest('[data-pw^="top-nav-"]') !== null ||
        element.querySelector('[data-pw^="top-nav-"]') !== null;
      const navigation = new Set([
        'top-nav-merchants-tab',
        'top-nav-shoppers-tab',
        'top-nav-integrations-tab',
        'top-nav-blogs-tab',
      ]);
      const guide = globalThis.KriyaGuide.createResearchGuide({
        allowedOrigins: ['https://breeze.in', 'https://www.breeze.in'],
        allowElement: element =>
          element.getAttribute('data-pw')?.startsWith('top-nav-') || !isNavigationChrome(element),
        allowReading: element => !isNavigationChrome(element),
        allowNavigation: element => {
          if (element instanceof HTMLAnchorElement) {
            const url = new URL(element.href);
            return (
              ['breeze.in', 'www.breeze.in'].includes(url.hostname) &&
              url.protocol === 'https:' &&
              element.target !== '_blank' &&
              url.href !== location.href &&
              !/^\/(?:shop|docs|directory|d2c-directory)(?:\/|$)/i.test(url.pathname)
            );
          }
          return (
            navigation.has(element.getAttribute('data-pw')) && !element.classList.contains('active')
          );
        },
        execute: step => globalThis.executeResearchStep(step),
        onThinking: () => {
          document.getElementById('nl-entry').classList.add('is-sending');
          document.querySelector('[data-nl="answer"]').textContent = 'Checking…';
        },
        onStep: step => globalThis.showResearchStep(step),
      });
      const button = document.getElementById('nl-go');
      button.addEventListener(
        'click',
        () => {
          button.disabled = true;
          button.classList.add('is-loading');
          button.innerHTML =
            '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8" fill="none" stroke="#1d1d1f" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="30 18"/></svg>';
          globalThis.__researchPromise = guide
            .run(sentence, request => globalThis.jevDecide(request))
            .then(result => {
              const entry = document.getElementById('nl-entry');
              entry.classList.remove('is-sending');
              entry.classList.add(result.ok ? 'is-success' : 'is-failure');
              const answer = entry.querySelector('[data-nl="answer"]');
              answer.style.color = '#fff';
              answer.textContent = result.ok
                ? sentence === defaultQuestion
                  ? 'Success. breeze.in offers one-click checkout.'
                  : 'Yes.'
                : `Failure. ${result.error ?? 'Jev could not confirm one-click checkout.'}`;
              button.classList.remove('is-loading');
              button.style.background = '#fff';
              button.innerHTML = result.ok
                ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.2 4.2L19 7.5" fill="none" stroke="#0e7a32" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="#b42318" stroke-width="2.6" stroke-linecap="round"/></svg>';
              globalThis.KriyaGuide.clearHighlight();
              document.getElementById('nl-cursor').style.display = 'none';
              return result;
            });
        },
        { once: true }
      );
    },
    { sentence, defaultQuestion }
  );
  await chrome.highlightArrow();
  arrowAtSeconds = (Date.now() - started) / 1000;
  await page.screenshot({ path: join(runDir, 'arrow-browser.png') });
  await page.waitForTimeout(1400);
  await page.locator('#nl-go').click({ force: true });
  result = await page.evaluate(async () => globalThis.__researchPromise);
  finalAtSeconds = (Date.now() - started) / 1000;
  finalState = await page.evaluate(() => ({
    arrowClicks: globalThis.__breezeRecording.arrowClicks,
    background: getComputedStyle(document.getElementById('nl-entry')).backgroundColor,
    text: document.querySelector('[data-nl="answer"]').textContent,
    textColor: getComputedStyle(document.querySelector('[data-nl="answer"]')).color,
    font: getComputedStyle(document.getElementById('nl-entry')).fontFamily,
    washVisible: !!document.getElementById('kriya-click-guide-highlight'),
    spinnerActive: document.getElementById('nl-go').classList.contains('is-loading'),
  }));
  await page.waitForTimeout(2800);
  await page.screenshot({ path: join(runDir, 'end-browser.png') });
  writeFileSync(
    join(runDir, 'recording.json'),
    JSON.stringify(
      {
        mode: 'live-jev',
        result,
        calls: calls.length,
        decisions,
        navigations,
        arrowAtSeconds,
        finalAtSeconds,
        evidenceFrames,
        finalState,
      },
      null,
      2
    )
  );
} finally {
  await context?.close();
  await browser.close();
  saveCalls();
}
if (!result) throw new Error(`The live run did not finish; inspect ${runDir}`);
const artifact = join(runDir, result.ok ? 'breeze-jev.mp4' : 'breeze-jev-failure.mp4');
const conversion = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    await video.path(),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    artifact,
  ],
  { stdio: 'inherit' }
);
if (conversion.status !== 0) throw new Error('FFmpeg conversion failed');
const duration = Number(
  spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', artifact],
    { encoding: 'utf8' }
  ).stdout
);
for (const [name, seconds] of [
  ['arrow', arrowAtSeconds + 0.5],
  ['end', duration - 0.5],
]) {
  const extracted = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(seconds),
    '-i',
    artifact,
    '-frames:v',
    '1',
    join(runDir, `${name}-mp4.png`),
  ]);
  if (extracted.status !== 0) throw new Error('MP4 verification frame extraction failed');
}
if (
  !result.ok ||
  result.evidence.length === 0 ||
  finalState.arrowClicks !== 1 ||
  finalState.washVisible ||
  finalState.spinnerActive ||
  !calls.some(call => call.status === 200 && /^jev-/.test(call.response?.model ?? ''))
) {
  console.error(
    `Live Jev run did not pass: ${result.error ?? 'verification failed'}. Evidence and failure video: ${runDir}`
  );
  process.exit(1);
}
const mp4 = join(worktree, 'examples/breeze-automatic.mp4');
if (existsSync(mp4)) copyFileSync(mp4, join(runDir, 'previous-breeze-automatic.mp4'));
if (!process.argv.includes('--no-publish')) copyFileSync(artifact, mp4);
console.info(
  JSON.stringify(
    {
      mode: 'live-jev',
      mp4: process.argv.includes('--no-publish') ? artifact : mp4,
      duration,
      requests: calls.length,
      result,
      finalState,
      verification: runDir,
    },
    null,
    2
  )
);
