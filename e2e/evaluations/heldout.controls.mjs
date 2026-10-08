/** Scripted Chromium proves fixture graders; this never invokes TaskAgent or a model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, VIEWPORT } from '../harness/browser.mjs';
import { fixtureFacts, scenarios } from './heldout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const firstLine = error => String(error?.message ?? error).split('\n')[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Control state did not settle within 20000 ms');
    await delay(25);
  }
}

async function navigateBySubmit(page, button) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), button.click()]);
}

const drive = {
  async catalog({ page }, alteration) {
    await page.getByLabel('Department').selectOption('kitchen');
    await page.getByLabel('Manufacturer').selectOption('kettlebrook');
    await page.getByLabel('Highest price you will pay (USD)').fill('100');
    await page
      .getByRole('radio', {
        name: alteration === 'wrong-desired' ? 'Lowest price first' : 'Highest price first',
        exact: true,
      })
      .check();
    await navigateBySubmit(page, page.getByRole('button', { name: 'Search', exact: true }));
    if (alteration === 'collateral') {
      await navigateBySubmit(
        page,
        page.getByRole('button', {
          name: 'Add Kettlebrook Burr Coffee Grinder to basket',
          exact: true,
        })
      );
    }
  },
  async settings({ page, app }, alteration) {
    await page.getByRole('checkbox', { name: 'Send me product updates', exact: true }).check();
    if (alteration !== 'wrong-desired')
      await page
        .getByRole('checkbox', { name: 'Send me the weekly digest', exact: true })
        .uncheck();
    if (alteration === 'collateral')
      await page
        .getByRole('checkbox', { name: 'Send me text message offers', exact: true })
        .check();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await until(() => app.state().settings.updates === true);
  },
  async shipping({ page }, alteration) {
    const values = fixtureFacts.shipping.final;
    await page.getByLabel('Forename', { exact: true }).fill(values.firstName);
    await page.getByLabel('Surname', { exact: true }).fill(values.lastName);
    await page.getByLabel('Contact email', { exact: true }).fill(values.email);
    await page
      .getByLabel('Telephone (optional)', { exact: true })
      .fill(alteration === 'wrong-desired' ? fixtureFacts.shipping.initial.phone : '');
    await navigateBySubmit(
      page,
      page.getByRole('button', { name: 'Save and continue', exact: true })
    );
    await page.getByLabel('Street and house number', { exact: true }).fill(values.line1);
    await page.getByLabel('Apartment, suite, unit (optional)', { exact: true }).fill('');
    await page.getByLabel('Locality', { exact: true }).fill(values.city);
    await page.getByLabel('Country or territory', { exact: true }).selectOption('CA');
    await page.getByLabel('State, province or region', { exact: true }).selectOption('BC');
    await page.getByLabel('ZIP or postal code', { exact: true }).fill(values.postalCode);
    await page.getByRole('radio', { name: /^Regular post/ }).check();
    await page.getByLabel('Include gift packaging for $4.00', { exact: true }).check();
    await page
      .getByLabel('Keep this address in my address book', { exact: true })
      .setChecked(alteration === 'collateral');
    await navigateBySubmit(
      page,
      page.getByRole('button', { name: 'Save and continue', exact: true })
    );
  },
  async checkout({ page, app }, alteration) {
    if (alteration === 'wrong-desired') {
      await page
        .getByLabel('Quantity for Loose-Leaf Tea Sampler', { exact: true })
        .selectOption('1');
      await until(
        () => app.state().carts[0]?.items.find(item => item.sku === 'tea-sampler')?.quantity === 1
      );
    }
    if (alteration === 'collateral') {
      await page.getByRole('button', { name: 'Delete Linen Work Apron', exact: true }).click();
      await until(() => app.state().carts[0]?.saved.length === 0);
    }
    await page.getByRole('button', { name: 'Buy now', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, place test order', exact: true }).click();
    await page.waitForURL(/\/thanks\/ORD-\d+$/);
    await page.getByRole('heading', { name: 'Order placed', exact: true }).waitFor();
  },
};

function syntheticCompleted(scenario, page) {
  return {
    status: 'completed',
    goal: scenario.goal,
    unresolvedUncertain: [],
    ledger: [
      {
        seq: 1,
        effect: 'applied',
        effects: scenario.family === 'checkout' ? ['purchase'] : ['form_submit'],
      },
    ],
    completion: {
      mode: 'effected',
      effected: true,
      actionsExecuted: 1,
      verifiedAt: 2000,
      verifiedSnapshot: { url: page.url() },
      unresolvedUncertain: [],
    },
  };
}

const corruptUi = {
  catalog: page =>
    page
      .locator('main .rows h3')
      .first()
      .evaluate(node => {
        node.textContent = 'Wrong product';
      }),
  settings: page =>
    page.getByRole('checkbox', { name: 'Send me product updates', exact: true }).evaluate(node => {
      node.checked = false;
    }),
  shipping: page =>
    page.locator('main address').evaluate(node => {
      node.textContent = 'Wrong destination';
    }),
  checkout: page =>
    page.locator('main h1').evaluate(node => {
      node.textContent = 'Order not confirmed';
    }),
};

const CASES = [
  { name: 'achieved state accepted', accepts: true },
  { name: 'initial state with completed claim rejected', initial: true, source: 'backend' },
  {
    name: 'plausible wrong desired state rejected',
    alteration: 'wrong-desired',
    source: 'backend',
  },
  { name: 'collateral value changed rejected', alteration: 'collateral', source: 'backend' },
  { name: 'false no-op completion claim rejected', result: 'noop', source: 'result' },
  { name: 'unresolved uncertain effect rejected', result: 'uncertain', source: 'result' },
  { name: 'wrong visible UI with correct backend rejected', ui: true, source: 'ui' },
];

async function judge(scenario, test, env) {
  if (test.initial) {
    await env.page.locator('main').evaluate(node => {
      const claim = document.createElement('h2');
      claim.textContent = 'Your request is complete';
      node.append(claim);
    });
  } else {
    await drive[scenario.family](env, test.alteration);
  }
  const result = syntheticCompleted(scenario, env.page);
  if (test.result === 'noop') {
    result.completion.effected = false;
    result.completion.mode = 'noop';
    result.completion.actionsExecuted = 0;
  }
  if (test.result === 'uncertain') result.unresolvedUncertain = [1];
  if (test.ui) await corruptUi[scenario.family](env.page);
  if (test.accepts) {
    await scenario.expect(env.app, result, env.page);
    return;
  }
  await assert.rejects(
    () => scenario.expect(env.app, result, env.page),
    new RegExp(`^Error: \\[${test.source}\\] `),
    'Grader accepted a forbidden state/result or rejected for an unintended reason'
  );
}

async function executeControl(browser, scenario, test) {
  let app;
  let context;
  try {
    const { startApp } = await import(`../apps/${scenario.family}.mjs`);
    app = await startApp({ variant: scenario.variant, initial: scenario.initial });
    context = await browser.newContext({ viewport: { ...VIEWPORT } });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(app.url, { waitUntil: 'load' });
    await judge(scenario, test, { app, page });
    return { passed: true };
  } catch (error) {
    return { passed: false, error: firstLine(error) };
  } finally {
    await context?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
  }
}

export function frozenHashes() {
  return Object.fromEntries(
    ['heldout.mjs', 'heldout.controls.mjs'].map(name => [
      path.join(HERE, name),
      createHash('sha256')
        .update(fs.readFileSync(path.join(HERE, name)))
        .digest('hex'),
    ])
  );
}

export async function runControls({ log = line => process.stdout.write(`${line}\n`) } = {}) {
  const hashesBefore = frozenHashes();
  const startedAt = new Date().toISOString();
  const browser = await launchBrowser();
  const checks = [];
  try {
    for (const scenario of scenarios) {
      for (const test of CASES) {
        const outcome = await executeControl(browser, scenario, test);
        const check = { id: `${scenario.id}: ${test.name}`, scenarioId: scenario.id, ...outcome };
        checks.push(check);
        log(
          `${check.passed ? 'PASS' : 'FAIL'} ${check.id}${check.error ? `: ${check.error}` : ''}`
        );
      }
    }
    // Independent canary: the grader must reject a completed claim over an untouched state. This
    // checks the positive runner path cannot quietly turn every rejection into success.
    const canary = await executeControl(browser, scenarios[0], {
      name: 'throwing canary',
      accepts: true,
      alteration: 'wrong-desired',
    });
    checks.push({
      id: 'runner rejects a failing positive control',
      passed: canary.passed === false,
    });
    log(`${canary.passed === false ? 'PASS' : 'FAIL'} runner rejects a failing positive control`);
  } finally {
    await browser.close();
  }
  assert.deepEqual(frozenHashes(), hashesBefore, 'Fixture or grader changed while controls ran');
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    fixtureAndGraderHashes: hashesBefore,
    browser: 'real Chromium',
    execution: 'scripted fixture/grader controls, synthetic TaskResult only',
    taskAgentRuns: 0,
    modelCalls: 0,
    total: checks.length,
    passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed),
    checks,
  };
}

if (
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const reportIndex = process.argv.indexOf('--report');
  runControls()
    .then(summary => {
      if (reportIndex !== -1) {
        const destination = process.argv[reportIndex + 1];
        if (!destination) throw new Error('--report requires a destination');
        fs.writeFileSync(destination, `${JSON.stringify(summary, null, 2)}\n`);
      }
      process.stdout.write(`heldout controls: ${summary.passed}/${summary.total} passed\n`);
      process.exitCode = summary.failed.length === 0 ? 0 : 1;
    })
    .catch(error => {
      process.stderr.write(`FAIL ${firstLine(error)}\n`);
      process.exitCode = 1;
    });
}
