import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { main } from '../run.mjs';
import { runScenario } from '../harness/runner.mjs';
import { checkDist } from '../harness/dist.mjs';
import { VIEWPORT } from '../harness/browser.mjs';
import * as built from '../../dist/index.esm.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const selected = new Set([
  'catalog-a-quoted-search-category',
  'catalog-a-brand-budget',
  'settings-a-disable-promotional',
  'settings-a-already-off',
  'settings-c-enable-digest',
  'shipping-a-fill-review',
  'checkout-a-approval-resume-one-order',
  'checkout-a-cancel-mid-run',
  'checkout-c-buy-now-commit-gate-refusal',
  'checkout-c-buy-now-two-lines-unused-card',
  'fault-context-destroyed',
]);
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) {
  throw new Error('Supply a fresh absolute evidence directory outside the repository');
}
if (path.relative(root, output).split(path.sep)[0] !== '..') {
  throw new Error('Recordings must be outside the repository');
}
fs.mkdirSync(output, { recursive: true });
const full = process.argv.includes('--full');
const only = process.argv
  .slice(3)
  .filter(flag => flag.startsWith('--only='))
  .flatMap(flag => flag.slice(7).split(','));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
const sourceHash = () =>
  sha(
    sourceFiles(path.join(root, 'src'))
      .sort()
      .map(file => `${path.relative(root, file)}\0${sha(fs.readFileSync(file))}`)
      .join('\n')
  );
const initialSource = sourceHash();
const initialDist = checkDist({ root });
if (!initialDist.ok) {
  throw new Error('Build is missing or stale');
}

// Presentation masking changes paint only. The input values, observations, goals and graders
// remain intact. Contact and payment values never need to appear in the recording.
function installPresentationMask() {
  const style = document.createElement('style');
  style.textContent = `
    input[type="email"], input[type="tel"], input[type="password"],
    input[autocomplete^="cc-"], input[name*="cardNumber"], input[name*="cvc"],
    input[name*="email"], input[name*="phone"], input[name*="mobile"] {
      color: transparent !important; caret-color: transparent !important;
      -webkit-text-fill-color: transparent !important;
    }
    [aria-labelledby="a-rc"] dd:nth-of-type(2),
    [aria-labelledby="a-rc"] dd:nth-of-type(3),
    [aria-labelledby="fh-rv-you"] dd:nth-of-type(2),
    [aria-labelledby="fh-rv-you"] dd:nth-of-type(3) {
      color: transparent !important; background: #475569 !important;
    }
  `;
  const install = () => (document.head ?? document.documentElement)?.append(style);
  if (document.documentElement) {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  }
}

function recordingContext(scenario, timeline, started) {
  return async (browser, { umd }) => {
    const videoDir = path.join(output, 'videos', scenario.id);
    fs.mkdirSync(videoDir, { recursive: true });
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      serviceWorkers: 'block',
      recordVideo: { dir: videoDir, size: { ...VIEWPORT } },
    });
    let page;
    try {
      await context.addInitScript({ content: `${umd}\n;WebAutomata.installTaskBridge();` });
      await context.addInitScript(installPresentationMask);
      page = await context.newPage();
    } catch (error) {
      await context.close();
      throw error;
    }
    timeline.push({ ms: Math.round(performance.now() - started), type: 'recording_start' });
    const consoleLines = [];
    const pageErrors = [];
    page.on('console', message => {
      if (consoleLines.length < 200) {
        consoleLines.push({ type: message.type(), text: message.text().slice(0, 500) });
      }
    });
    page.on('pageerror', error => {
      if (pageErrors.length < 200) {
        pageErrors.push(String(error?.message ?? error).slice(0, 500));
      }
    });
    let closed = false;
    return {
      context,
      page,
      diagnostics: () => ({ console: consoleLines.slice(), pageErrors: pageErrors.slice() }),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        timeline.push({ ms: Math.round(performance.now() - started), type: 'recording_end' });
        await context.close();
        const video = page.video();
        if (video) {
          await video.saveAs(path.join(videoDir, 'raw.webm'));
        }
        fs.writeFileSync(path.join(videoDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
      },
    };
  };
}

fs.writeFileSync(
  path.join(output, 'frozen-package.json'),
  JSON.stringify(
    {
      root,
      startedAt: new Date().toISOString(),
      sourceSha256: initialSource,
      distPairSha256: initialDist.sha256,
      wrapperSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
      fullCampaign: full,
      recordingScenarios: [...selected],
      confidence: { action: 0.2, argument: 0.3, commitment: 0.5, completion: 0.4 },
      confidenceProfile: { kind: 'vendor_reported', calibrated: false },
      completionClauseSplit: 'punctuation-default',
      explicitQuestions: false,
      presentation: 'Contact and payment values are masked; synthetic fixture data only.',
      approval:
        'Approval resumes use the existing explicit test-fixture approval, not real payment.',
    },
    null,
    2
  )
);

const model = {
  ...built,
  createTypeSafeTaskDecider: config =>
    built.createTypeSafeTaskDecider({
      ...config,
      captureProbabilities: true,
      confidenceProfile: { kind: 'vendor_reported', calibrated: false },
    }),
};
const selectedArgs = full
  ? []
  : (only.length > 0 ? only : [...selected]).flatMap(id => ['--scenario', id]);
const exitCode = await main({
  argv: [
    '--root',
    root,
    '--kind',
    'all',
    '--jobs',
    '2',
    '--jev-concurrency',
    '3',
    '--observe-offscreen',
    '--action-confidence',
    '0.2',
    '--argument-confidence',
    '0.3',
    '--completion-confidence',
    '0.4',
    '--run-id',
    'closeout-live',
    '--evidence-root',
    output,
    ...selectedArgs,
  ],
  deps: {
    runScenario: args => {
      const timeline = [];
      const started = performance.now();
      const dist = {
        ...model,
        createTaskAgent: config => {
          const onEvent = config.options?.onEvent;
          return built.createTaskAgent({
            ...config,
            options: {
              ...config.options,
              onEvent: event => {
                timeline.push({
                  ms: Math.round(performance.now() - started),
                  type: event.type,
                  step: event.step,
                });
                onEvent?.(event);
              },
            },
          });
        },
      };
      return runScenario({
        ...args,
        runOverrides: { ...args.runOverrides, captureProgressDiagnostics: true },
        deps: {
          ...args.deps,
          dist,
          ...(selected.has(args.scenario.id)
            ? { newScenarioContext: recordingContext(args.scenario, timeline, started) }
            : {}),
        },
      });
    },
  },
});
const unchanged =
  sourceHash() === initialSource && checkDist({ root }).sha256 === initialDist.sha256;
fs.writeFileSync(
  path.join(output, 'package-after.json'),
  JSON.stringify({ unchanged, exitCode, finishedAt: new Date().toISOString() }, null, 2)
);
process.exitCode = unchanged ? exitCode : 1;
