import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDist, readBundles } from '../harness/dist.mjs';
import { preflight } from '../harness/env.mjs';
import { launchBrowser, VIEWPORT } from '../harness/browser.mjs';
import { createPlaywrightTransport } from '../harness/host.mjs';
import { createRecordingHttp, createJevGate } from '../harness/jev.mjs';
import { scanForSecrets } from '../harness/evidence.mjs';
import * as built from '../../dist/index.esm.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) {
  throw new Error('Supply a fresh absolute evidence directory');
}
if (path.relative(root, output).split(path.sep)[0] !== '..') {
  throw new Error('Recordings must be outside the repository');
}
const environment = preflight();
const dist = checkDist({ root });
if (!environment.ok || !dist.ok) {
  throw new Error('Browser, credential or build preflight failed');
}
fs.mkdirSync(output, { recursive: true });
const bundles = readBundles(root);
const cases = [
  {
    id: 'selenium-native-form',
    url: 'https://www.selenium.dev/selenium/web/web-form.html',
    origins: ['https://www.selenium.dev'],
    goal: 'Fill "Kriya demo" into the Text input, choose "Two" from the Dropdown (select), and submit the form.',
    effects: ['form_submit'],
    grade: async page => ({
      submitted: new URL(page.url()).pathname.endsWith('/submitted-form.html'),
      textMatches: new URL(page.url()).searchParams.get('my-text') === 'Kriya demo',
      selectionMatches: new URL(page.url()).searchParams.get('my-select') === '2',
      receipt: (await page.locator('#message').textContent()) === 'Received!',
    }),
  },
  {
    id: 'wikipedia-search-navigation',
    url: 'https://www.wikipedia.org/',
    origins: ['https://www.wikipedia.org', 'https://en.wikipedia.org'],
    goal: 'Find the Wikipedia article for "TypeScript" and open it.',
    effects: ['form_submit'],
    grade: async page => ({
      correctArticle: new URL(page.url()).pathname === '/wiki/TypeScript',
      correctHeading: (await page.locator('#firstHeading').textContent())?.trim() === 'TypeScript',
    }),
  },
  {
    id: 'todomvc-add-complete-filter',
    url: 'https://demo.playwright.dev/todomvc/',
    origins: ['https://demo.playwright.dev'],
    goal: 'Add "Review Kriya demos" to my todo list, mark that task complete, and show only completed tasks.',
    effects: ['account_change', 'form_submit'],
    grade: async page => ({
      exactlyOneTask: (await page.locator('.todo-list li').count()) === 1,
      correctTask:
        (await page.locator('.todo-list li label').textContent()) === 'Review Kriya demos',
      complete: await page.locator('.todo-list li .toggle').isChecked(),
      completedFilter: new URL(page.url()).hash === '#/completed',
    }),
  },
];
const todo = cases.find(spec => spec.id === 'todomvc-add-complete-filter');
cases.push({
  ...todo,
  id: 'todomvc-visible-controls',
  presentationCss: '.todo-list .toggle { opacity: 1 !important; }',
  ariaAdapter: true,
});
const selectedIds = [];
for (const flag of process.argv.slice(3)) {
  if (!flag.startsWith('--case=')) {
    throw new Error('Unsupported public demo option; use --case=<id>');
  }
  const id = flag.slice(7);
  if (!cases.some(spec => spec.id === id)) {
    throw new Error('Unknown public demo case');
  }
  selectedIds.push(id);
}
const browser = await launchBrowser(environment);
const summaries = [];
try {
  for (const spec of cases) {
    if (selectedIds.length > 0 && !selectedIds.includes(spec.id)) {
      continue;
    }
    const dir = path.join(output, spec.id);
    fs.mkdirSync(dir);
    const calls = [];
    const events = [];
    const navigation = [];
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      serviceWorkers: 'block',
      recordVideo: { dir, size: { ...VIEWPORT } },
    });
    let page;
    let host;
    let summary;
    const started = performance.now();
    try {
      await context.addInitScript({ content: `${bundles.umd}\n;WebAutomata.installTaskBridge();` });
      if (spec.presentationCss) {
        await context.addInitScript(css => {
          const install = () => {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.append(style);
          };
          if (document.head) {
            install();
          } else {
            document.addEventListener('DOMContentLoaded', install, { once: true });
          }
        }, spec.presentationCss);
      }
      if (spec.ariaAdapter) {
        await context.addInitScript(() => {
          const install = () => {
            const update = () => {
              for (const row of document.querySelectorAll('.todo-list li')) {
                const control = row.querySelector('.toggle');
                const title = row.querySelector('label')?.textContent?.trim();
                if (control && title) {
                  const label = `Toggle completion of ${title}`;
                  if (control.getAttribute('aria-label') !== label) {
                    control.setAttribute('aria-label', label);
                  }
                }
              }
              for (const link of document.querySelectorAll('.filters a')) {
                const selected = String(link.classList.contains('selected'));
                if (link.getAttribute('role') !== 'tab') {
                  link.setAttribute('role', 'tab');
                }
                if (link.getAttribute('aria-selected') !== selected) {
                  link.setAttribute('aria-selected', selected);
                }
              }
            };
            new MutationObserver(update).observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeFilter: ['class'],
            });
            update();
          };
          if (document.body) {
            install();
          } else {
            document.addEventListener('DOMContentLoaded', install, { once: true });
          }
        });
      }
      page = await context.newPage();
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) {
          navigation.push({ url: frame.url(), ms: performance.now() - started });
        }
      });
      await page.goto(spec.url, { waitUntil: 'load', timeout: 30000 });
      await page.screenshot({ path: path.join(dir, 'before.png') });
      const transport = createPlaywrightTransport({ page, redactEnvelope: built.redactEnvelope });
      host = built.createRemoteTaskHost({ transport });
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 1 }),
        recorder: { record: exchange => calls.push(exchange) },
      });
      const agent = built.createTaskAgent({
        host: {
          ...host,
          observe: (request, signal) =>
            host.observe(
              { ...request, options: { ...request.options, includeOffscreen: true } },
              signal
            ),
        },
        decider: built.createTypeSafeTaskDecider({
          apiKey: () => process.env.TYPESAFE_API_KEY ?? '',
          http,
          captureProbabilities: true,
          confidenceProfile: { kind: 'vendor_reported', calibrated: false },
        }),
        options: {
          onEvent: event =>
            events.push({
              ms: Math.round(performance.now() - started),
              type: event.type,
              operation: event.operation ?? event.command?.operation,
              step: event.step,
            }),
        },
      });
      const signal = AbortSignal.timeout(310000);
      let result = await agent.run(
        {
          goal: spec.goal,
          expect: { answer: false },
          authorization: { origins: spec.origins, effects: spec.effects },
          options: {
            confidence: { action: 0.2, argument: 0.3, commitment: 0.5, completion: 0.4 },
            budgets: { maxSteps: 30, maxModelCalls: 150, maxWallTimeMs: 300000 },
            captureProgressDiagnostics: true,
          },
        },
        signal
      );
      const testApprovals = [];
      while (
        spec.id === 'todomvc-visible-controls' &&
        result.status === 'awaiting_approval' &&
        testApprovals.length < 3
      ) {
        const approval = result.approval;
        if (
          !approval.effects.every(effect =>
            ['other_commitment', 'account_change', 'form_submit'].includes(effect)
          )
        ) {
          break;
        }
        await page.screenshot({ path: path.join(dir, `approval-${testApprovals.length + 1}.png`) });
        testApprovals.push({
          operation: approval.command.command.operation,
          effects: approval.effects,
          scope: 'once',
          label: 'Explicit synthetic-demo caller approval',
        });
        result = await agent.resume(
          {
            checkpoint: result.checkpoint,
            resolution: {
              kind: 'approval',
              resolution: {
                approvalId: approval.id,
                nonce: approval.nonce,
                digest: approval.digest,
                contextDigest: approval.contextDigest,
                decision: 'approve',
                scope: 'once',
              },
            },
          },
          signal
        );
      }
      const grader = await spec.grade(page).catch(() => ({ finalUiAvailable: false }));
      const reportedModels = [
        ...new Set(calls.filter(c => c.status === 200).map(c => c.response?.model)),
      ];
      const goalMismatches = calls
        .flatMap(c => Object.values(c.request?.questions ?? {}))
        .filter(q => q.instructions?.goal !== spec.goal).length;
      summary = {
        id: spec.id,
        goal: spec.goal,
        startUrl: spec.url,
        finalUrl: page.url(),
        status: result.status,
        testApprovals,
        presentationCss: spec.presentationCss ?? null,
        ariaAdapter: spec.ariaAdapter ?? false,
        grader,
        events,
        navigation,
        calls: calls.length,
        reportedModels,
        goalMismatches,
        distPairSha256: dist.sha256,
        passed:
          result.status === 'completed' &&
          Object.values(grader).every(Boolean) &&
          calls.length > 0 &&
          goalMismatches === 0 &&
          reportedModels.length === 1 &&
          reportedModels[0] === 'jev-1.13.0',
      };
      fs.writeFileSync(
        path.join(dir, 'result.json'),
        JSON.stringify(built.redactEnvelope(result), null, 2)
      );
      await page.screenshot({ path: path.join(dir, 'after.png') });
    } catch {
      summary = {
        id: spec.id,
        goal: spec.goal,
        passed: false,
        status: 'setup_or_execution_error',
        calls: calls.length,
      };
    } finally {
      await host?.dispose();
      await context.close();
      const video = page?.video();
      if (video) {
        await video.saveAs(path.join(dir, 'raw.webm'));
      }
      fs.writeFileSync(path.join(dir, 'jev-calls.json'), JSON.stringify(calls, null, 2));
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    }
    summaries.push(summary);
    process.stdout.write(
      JSON.stringify({
        id: summary.id,
        passed: summary.passed,
        status: summary.status,
        calls: summary.calls,
      }) + '\n'
    );
  }
} finally {
  await browser.close();
}
const scan = scanForSecrets(output, [
  { label: 'TypeSafe credential', value: process.env.TYPESAFE_API_KEY ?? '' },
]);
const receipt = {
  summaries,
  credentialHits: scan.hits.length,
  filesScanned: scan.scanned,
  packageUnchanged: checkDist({ root }).sha256 === dist.sha256,
  limits: [
    'Public-site results apply to these tasks and page versions.',
    'Byte scans do not verify video pixels.',
  ],
};
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(receipt, null, 2));
process.exitCode =
  summaries.every(s => s.passed) && scan.hits.length === 0 && receipt.packageUnchanged ? 0 : 1;
