import {
  createTaskAgent,
  createRemoteTaskHost,
  createTypeSafeTaskDecider,
  redactEnvelope,
} from '../dist/index.esm.js';
import { startApp } from '../e2e/apps/settings.mjs';
import { preflight } from '../e2e/harness/env.mjs';
import { launchBrowser, newScenarioContext } from '../e2e/harness/browser.mjs';
import { createPlaywrightTransport } from '../e2e/harness/host.mjs';
import fs from 'node:fs/promises';

const environment = await preflight({ env: process.env });
if (!environment.ok) {
  process.stderr.write(
    'The example needs TYPESAFE_API_KEY loaded by node --env-file and the configured Chromium tools.\n'
  );
  process.exitCode = 2;
} else {
  const app = await startApp({ variant: 'A' });
  const browser = await launchBrowser(environment);
  let context;
  let host;
  try {
    const umd = await fs.readFile(new URL('../dist/index.umd.js', import.meta.url), 'utf8');
    context = await newScenarioContext(browser, { umd });
    await context.page.goto(app.url);
    const transport = createPlaywrightTransport({ page: context.page, redactEnvelope });
    host = createRemoteTaskHost({ transport });
    const agent = createTaskAgent({
      host: {
        ...host,
        observe: request =>
          host.observe({ ...request, options: { ...request.options, includeOffscreen: true } }),
      },
      decider: createTypeSafeTaskDecider({ apiKey: () => process.env.TYPESAFE_API_KEY ?? '' }),
    });
    const result = await agent.run({
      goal: 'Please turn off promotional emails for my account.',
      expect: { answer: false },
      options: { confidence: { action: 0.2, argument: 0.3, completion: 0.6 } },
      authorization: { origins: [app.origin], effects: ['account_change'] },
    });
    const persisted = app.state().settings.promotional === false;
    process.stdout.write(
      JSON.stringify({ status: result.status, persisted, steps: result.steps }) + '\n'
    );
    process.exitCode = result.status === 'completed' && persisted ? 0 : 1;
  } finally {
    await host?.dispose();
    await context?.close();
    await browser.close();
    await app.close();
  }
}
