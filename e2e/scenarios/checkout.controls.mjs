/**
 * Control proofs for e2e/scenarios/checkout.mjs.
 *
 * Plain scripted Playwright (never the agent) drives the real checkout app to a known end state and a
 * synthetic TaskResult of the right shape is built next to it. For EVERY scenario the expect() function
 * must:
 *   - PASS on the achieved state with the right result,
 *   - FAIL on the untouched initial state,
 *   - FAIL on at least one plausible wrong end state,
 *   - FAIL on wrong results next to the right state (wrong status, leaked secret, missing evidence).
 * A failing control must fail for the intended reason: its message is matched against the source tag
 * of the assertion (`[backend]`, `[ui]`, `[result]`, `[leak]`). Static checks cover the scenario shape,
 * the goal rules (no URLs, selectors, labels or step lists) and the sensitive-value rules.
 *
 * Run: node e2e/scenarios/checkout.controls.mjs     (prints PASS/FAIL per line, exits 1 on any FAIL)
 * Importing this module has no side effects.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startApp } from '../apps/checkout.mjs';
import { scenarios, fixtures } from './checkout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const POOL = 4;
const digitsOf = value => String(value ?? '').replace(/\D/g, '');
const maskDigits = text => String(text).replace(/\d(?:[ -]?\d){11,}/g, '[digits]');
const dashed = digits => digits.replace(/(\d{4})(?=\d)/g, '$1-');
const KEY_NAME = ['TYPESAFE', 'API', 'KEY'].join('_');

function findChromium() {
  if (fs.existsSync(PREFERRED_CHROMIUM)) return PREFERRED_CHROMIUM;
  const root = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs
    .readdirSync(root)
    .filter(name => /^chromium-\d+$/.test(name))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const candidate = path.join(
      root,
      dir,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function launchBrowser() {
  const require = createRequire('/tmp/amazon-guide/package.json');
  const { chromium } = require('playwright');
  const executablePath = findChromium();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Run-time generated stand-ins for the harness' sensitive values
// ---------------------------------------------------------------------------------------------

function generatedSensitive(kind) {
  const random = crypto.randomBytes(12);
  const digits = Array.from(random, byte => byte % 10).join('');
  const unaccepted = `9${digits}${Array.from(crypto.randomBytes(3), byte => byte % 10).join('')}`;
  const base = { password: `pw-${random.toString('hex')}` };
  if (kind === 'accepted')
    return { ...base, cardNumber: ['5555', '5555', '5555', '4444'].join('') };
  if (kind === 'public') {
    const groups = ['4242', '4242', '4242', '4242'];
    return {
      ...base,
      cardNumber: groups.join(''),
      cardNumberSpaced: groups.join(' '),
      cvc: String(100 + (random[0] % 900)),
      cardExpiry: ['11', '31'].join('/'),
    };
  }
  return { ...base, cardNumber: unaccepted };
}

async function harnessSensitive() {
  try {
    const file = path.join(HERE, '..', 'harness', 'sensitive.mjs');
    const module = await import(pathToFileURL(file).href);
    if (typeof module.generateSensitiveValues === 'function') {
      return { values: module.generateSensitiveValues(), source: 'harness sensitive.mjs' };
    }
  } catch {
    // fall through to the local stand-in
  }
  return { values: generatedSensitive('public'), source: 'local stand-in' };
}

// ---------------------------------------------------------------------------------------------
// Synthetic TaskResult builders (shape of the contract; ids are plain placeholders)
// ---------------------------------------------------------------------------------------------

const hex = n => n.toString(16).padStart(12, '0');
const ID = {
  run: `run_${hex(1)}`,
  session: `ses_${hex(2)}`,
  snapshot: `snap_${hex(3)}`,
  document: `doc_${hex(4)}`,
};
const START = 1_000_000;
const PLACE_LABEL = { A: 'Place order', B: 'Place your order', C: 'Yes, place test order' };
const PAUSE_PATH = { A: '/checkout', B: '/checkout/review', C: '/basket' };

const usage = steps => ({
  steps,
  modelCalls: steps * 3,
  staleRetries: 0,
  noProgress: 0,
  uncertainEffects: 0,
  prematureDone: 0,
  invalidDecisions: 0,
  rejectedCommands: 0,
  deciderFailures: 0,
  hostFailures: 0,
  elapsedMs: 5000,
});

const summaryOf = url => ({
  sessionId: ID.session,
  snapshotId: ID.snapshot,
  documentId: ID.document,
  sequence: 9,
  observedAt: START,
  url,
  title: 'Checkout',
  fingerprint: 'fp_0001',
  elementCount: 42,
});

const unobserved = {
  iframes: 0,
  shadowRoots: 0,
  canvases: 0,
  contentEditable: 0,
  multiSelects: 0,
  externalTargets: 0,
};

function ledgerEntry(
  seq,
  { label, operation = 'CLICK', effects, effect = 'applied', approvalId, url }
) {
  const target = {
    sessionId: ID.session,
    snapshotId: ID.snapshot,
    targetId: `t${seq}`,
    signature: `sg_${hex(seq)}`,
  };
  return {
    seq,
    step: seq,
    command: {
      command: { operation, target },
      target: {
        id: target.targetId,
        signature: target.signature,
        role: 'button',
        kind: 'button',
        label,
        sensitive: false,
      },
    },
    digest: `dg_${hex(100 + seq)}`,
    effects,
    status: 'applied',
    effect,
    postconditions: [],
    scope: { sessionId: ID.session, snapshotId: ID.snapshot, documentId: ID.document },
    observationSequence: seq,
    observationOrdinal: seq,
    url,
    startedAt: START + seq * 1000,
    finishedAt: START + seq * 1000 + 250,
    navigated: false,
    ...(approvalId ? { approvalId } : {}),
  };
}

function baseResult(env, ledger, overrides = {}) {
  const { scenario, app } = env;
  const steps = ledger.length;
  return {
    runId: ID.run,
    sessionId: ID.session,
    goal: scenario.goal,
    steps,
    stats: {
      usage: usage(steps),
      modelLatencyMs: 4200,
      actions: { applied: steps, noop: 0, rejected: 0, failed: 0, uncertain: 0, navigated: 0 },
    },
    ledger,
    exchanges: [],
    warnings: [{ code: 'SHORT_SENSITIVE_INPUT', detail: 'payment.cvc' }],
    startedAt: START,
    finishedAt: START + 30_000,
    finalObservation: summaryOf(`${app.origin}/`),
    lastEffect: ledger.length > 0 ? 'applied' : 'none',
    unresolvedUncertain: [],
    ...overrides,
  };
}

function commitEffects(variant) {
  return variant === 'C' ? ['interact', 'purchase'] : ['interact', 'form_submit', 'purchase'];
}

function orderLedger(env, { approvalId, commit = true } = {}) {
  const { app, scenario } = env;
  const base = [
    ledgerEntry(1, {
      label: 'Proceed to checkout',
      operation: 'NAVIGATE',
      effects: ['navigate'],
      url: app.url,
    }),
    ledgerEntry(2, { label: 'Email address', operation: 'FILL', effects: ['input'], url: app.url }),
  ];
  if (!commit) return base;
  return [
    ...base,
    ledgerEntry(3, {
      label: PLACE_LABEL[scenario.variant],
      effects: commitEffects(scenario.variant),
      approvalId,
      url: app.url,
    }),
  ];
}

function completedResult(env, options = {}) {
  const ledger = orderLedger(env, options);
  return baseResult(env, ledger, {
    status: 'completed',
    completion: {
      mode: 'effected',
      effected: true,
      answered: false,
      basis: 'postconditions',
      evidence: [],
      actionsExecuted: ledger.length,
      verifierConfidence: 0.92,
      verifiedAt: START + 29_000,
      verifiedSnapshot: summaryOf(`${env.app.origin}/order/ORD-1001`),
      postconditions: [],
      resolvedUncertain: [],
      unresolvedUncertain: [],
      unobserved,
    },
  });
}

function omitSensitive(inputs, declarations) {
  const secret = new Set(declarations.filter(d => d.sensitive).map(d => d.path));
  const walk = (value, prefix) =>
    Object.fromEntries(
      Object.entries(value).flatMap(([key, inner]) => {
        const at = prefix ? `${prefix}.${key}` : key;
        if (secret.has(at)) return [];
        if (inner && typeof inner === 'object') return [[key, walk(inner, at)]];
        return [[key, inner]];
      })
    );
  return walk(inputs, '');
}

function pendingFields(env, { emptySecrets = false } = {}) {
  const { inputs, scenario } = env;
  if (scenario.variant !== 'A') return [];
  const { contact: c, shipping: s, payment: p } = inputs;
  const plain = [
    ['Email address', c.email],
    ['Phone number (optional)', c.phone],
    ['First name', s.firstName],
    ['Last name', s.lastName],
    ['Street address', s.address1],
    ['City', s.city],
    ['ZIP code', s.postalCode],
  ].map(([label, value]) => ({ label, kind: 'text_input', sensitive: false, value }));
  const secret = ['Name on card', 'Card number', 'Expiry date (MM/YY)', 'Security code'].map(
    label => ({ label, kind: 'text_input', sensitive: true, nonEmpty: Boolean(p) && !emptySecrets })
  );
  return [...plain, ...secret];
}

function pendingResult(env, options = {}) {
  const { app, scenario, inputs } = env;
  const variant = scenario.variant;
  const label = options.label ?? (variant === 'A' ? 'Place order' : 'Buy now');
  const url = `${app.origin}${PAUSE_PATH[variant]}`;
  const effects = options.effects ?? (variant === 'A' ? ['form_submit', 'purchase'] : ['purchase']);
  const ledger = options.ledger ?? orderLedger(env, { commit: false });
  const target = {
    sessionId: ID.session,
    snapshotId: ID.snapshot,
    targetId: 't9',
    signature: `sg_${hex(9)}`,
  };
  const command = { operation: options.operation ?? 'CLICK', target };
  const approval = {
    id: `apr_${hex(7)}`,
    runId: ID.run,
    nonce: `non_${hex(8)}`,
    digest: `dg_${hex(9)}`,
    contextDigest: `cx_${hex(10)}`,
    snapshotId: ID.snapshot,
    documentId: ID.document,
    observationFingerprint: 'fp_0002',
    url: options.approvalUrl ?? url,
    step: ledger.length + 1,
    effects,
    command: {
      command,
      target: {
        id: 't9',
        signature: target.signature,
        role: 'button',
        kind: 'button',
        label,
        sensitive: false,
      },
    },
    context: {
      structural: {
        origin: app.origin,
        destination:
          variant === 'A' ? { action: `${app.origin}/checkout`, method: 'GET' } : undefined,
        hints: variant === 'A' ? [{ class: 'FORM_SUBMIT', basis: 'submit_control' }] : [],
        sensitiveTarget: false,
      },
      page: {
        url,
        title: 'Checkout',
        targetLabel: label,
        formFields: options.fields ?? pendingFields(env, options),
        regionPassages: [],
        notices: [],
        validation: [],
        dialogs: [],
      },
    },
    reason: 'The command carries a commitment effect that no grant covers.',
    createdAt: START + 20_000,
    expiresAt: options.expiresAt ?? START + 920_000,
    ...(options.reason ? { reason: options.reason } : {}),
  };
  const declarations = scenario.inputDeclarations(env.sensitive);
  const checkpoint = {
    version: 1,
    id: `ck_${hex(11)}`,
    runId: ID.run,
    sessionId: ID.session,
    createdAt: START + 20_000,
    request: {
      goal: scenario.goal,
      inputs: omitSensitive(inputs, declarations),
      inputDeclarations: declarations,
      sensitivePaths: declarations.filter(d => d.sensitive).map(d => d.path),
      authorization: {
        operations: [
          'READ',
          'CLICK',
          'FILL',
          'SELECT',
          'SET_CHECKED',
          'NAVIGATE',
          'SUBMIT',
          'SCROLL',
        ],
        origins: [app.origin],
        grants: [],
        assumeUnclassifiedRoutine: false,
      },
      options: {},
    },
    step: ledger.length + 1,
    usage: usage(ledger.length),
    ledger,
    history: [],
    startOrigin: app.origin,
    locationTrust: 'authoritative',
    consumedApprovalIds: [],
    integrity: `sha256:${'0'.repeat(64)}`,
    pending: { kind: 'awaiting_approval', approval, command, effects: ['interact', ...effects] },
  };
  return baseResult(env, ledger, { status: 'awaiting_approval', approval, checkpoint });
}

function cancelledResult(env, { durationMs = 7400, during = 'decision' } = {}) {
  const ledger = orderLedger(env, { commit: false });
  return baseResult(env, ledger, {
    status: 'cancelled',
    during,
    finishedAt: START + durationMs,
    lastEffect: 'applied',
  });
}

// ---------------------------------------------------------------------------------------------
// Scripted drivers (plain Playwright; never the agent)
// ---------------------------------------------------------------------------------------------

async function until(fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const cartOf = app => app.state().carts[0];

async function startShop(env) {
  const { app, page, scenario } = env;
  await page.goto(app.url);
  const start = { A: '**/cart', B: '**/bag', C: '**/basket' }[scenario.variant];
  await page.waitForURL(start);
  const heading = { A: 'Shopping cart', B: 'Your bag', C: /Your basket/ }[scenario.variant];
  await page.getByRole('heading', { name: heading }).waitFor();
}

async function driveA(env, opts = {}) {
  const { app, page, inputs, fixture } = env;
  const method = opts.method ?? fixture.method;
  await startShop(env);
  if (opts.newsletter) {
    await page.getByLabel('Your email', { exact: true }).fill('reader@example.test');
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await until(() => app.requests().some(r => r.path === '/api/newsletter'));
  }
  if (!opts.skipQty) {
    for (const [sku, quantity] of fixture.qtyChange) {
      await page.locator(`#qty-${sku}`).fill(String(quantity));
    }
    if (fixture.qtyChange.length > 0) {
      await page.getByRole('button', { name: 'Update cart', exact: true }).click();
      await until(() =>
        fixture.qtyChange.every(([sku, quantity]) =>
          cartOf(app).items.some(line => line.sku === sku && line.quantity === quantity)
        )
      );
    }
  }
  await page.getByRole('link', { name: 'Proceed to checkout' }).click();
  await page.waitForURL('**/checkout');
  await page.getByRole('button', { name: 'Place order', exact: true }).waitFor();
  const { contact: c, shipping: s, payment: p } = inputs;
  const fill = (label, value) => page.getByLabel(label, { exact: true }).fill(value);
  await fill('Email address', opts.emailTypo ? c.email.replace('.test', '.tset') : c.email);
  await fill('Phone number (optional)', c.phone);
  await fill('First name', s.firstName);
  await fill('Last name', s.lastName);
  await fill('Street address', opts.addressTypo ? `${s.address1}x` : s.address1);
  if (s.address2) await fill('Apartment, suite, etc. (optional)', s.address2);
  await fill('City', s.city);
  await page.getByLabel('State', { exact: true }).selectOption({ label: s.state });
  await fill('ZIP code', s.postalCode);
  if (opts.stop === 'shipping') return;
  if (method === 'express') await page.getByRole('radio', { name: /^Express shipping/ }).check();
  await fill('Name on card', p.cardName);
  await fill('Card number', p.cardNumber);
  await fill('Expiry date (MM/YY)', p.expiry);
  await fill('Security code', p.cvc);
  if (opts.cardInNote) await fill('Delivery notes (optional)', p.cardNumber);
  if (opts.stop === 'before-commit') return;
  await page.getByRole('button', { name: 'Place order', exact: true }).click();
  await page.waitForURL(/\/order\/ORD-\d+$/);
  await page.getByRole('heading', { name: 'Thank you for your order' }).waitFor();
}

async function driveB(env, opts = {}) {
  const { app, page, inputs, fixture } = env;
  const method = opts.method ?? fixture.method;
  await startShop(env);
  if (opts.removePromo) {
    await page.getByRole('button', { name: 'Remove code' }).click();
    await until(() => cartOf(app).promo === null);
  }
  await page.getByRole('link', { name: 'Checkout securely' }).click();
  await page.waitForURL('**/checkout/shipping');
  await page.getByRole('heading', { name: 'Where should we send it?' }).waitFor();
  const fill = (label, value) => page.getByLabel(label, { exact: true }).fill(value);
  if (!fixture.prefill) {
    const { contact: c, shipping: s } = inputs;
    await fill('Email', c.email);
    await fill('Mobile phone', c.phone);
    await fill('Full name', s.fullName);
    await fill('Address', s.address1);
    await fill('Town or city', s.city);
    await page.getByLabel('State', { exact: true }).selectOption({ label: s.state });
    await fill('Postal code', s.postalCode);
  }
  await page.getByLabel('Delivery speed', { exact: true }).selectOption(method);
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL('**/checkout/payment');
  await page.getByRole('heading', { name: 'Payment details' }).waitFor();
  const { payment: p } = inputs;
  await fill('Cardholder name', p.cardName);
  await fill('Card number', p.cardNumber);
  await page.getByLabel('Month', { exact: true }).selectOption(p.expiryMonth);
  await page.getByLabel('Year', { exact: true }).selectOption(p.expiryYear);
  await fill('Security code (CVC)', p.cvc);
  await page.getByRole('button', { name: 'Review order' }).click();
  await page.waitForURL('**/checkout/review');
  await page.getByRole('button', { name: 'Place your order' }).waitFor();
  await page.getByLabel(/Send me news and offers/).setChecked(opts.marketing ?? fixture.marketing);
  await page.getByRole('button', { name: 'Place your order' }).click();
  await page.waitForURL(/\/checkout\/complete\/ORD-\d+$/);
  await page.getByRole('heading', { name: 'Order confirmed' }).waitFor();
}

async function driveC(env, opts = {}) {
  const { app, page } = env;
  await startShop(env);
  const before = cartOf(app);
  if (opts.saveFirst) {
    await page
      .getByRole('button', { name: /^Save for later/ })
      .first()
      .click();
    await until(() => cartOf(app).saved.length > before.saved.length);
  }
  if (opts.addRecommended) {
    await page
      .getByRole('button', { name: /^Add to basket/ })
      .first()
      .click();
    await until(() => cartOf(app).items.length > before.items.length);
  }
  if (opts.cardInNewsletter) {
    await page.getByLabel('Email', { exact: true }).fill(env.inputs.payment.cardNumber);
    await page.getByRole('button', { name: 'Join' }).click();
    await until(() => app.requests().some(r => r.path === '/api/newsletter'));
  }
  if (opts.stop === 'basket') return;
  await until(async () => {
    try {
      const buy = page.getByRole('button', { name: 'Buy now' });
      await buy.scrollIntoViewIfNeeded({ timeout: 2000 });
      await buy.click({ timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  });
  await page.getByRole('dialog', { name: 'Place this order?' }).waitFor();
  if (opts.stop === 'dialog') return;
  await page.getByRole('button', { name: 'Yes, place test order' }).click();
  await page.waitForURL(/\/thanks\/ORD-\d+$/);
  await page.getByRole('heading', { name: 'Order placed' }).waitFor();
}

const DRIVERS = { A: driveA, B: driveB, C: driveC };
const HEADING = { A: 'Thank you for your order', B: 'Order confirmed', C: 'Order placed' };

const tricks = {
  fakeHeading: (page, heading) =>
    page.evaluate(text => {
      const node = document.createElement('h1');
      node.textContent = text;
      document.body.prepend(node);
    }, heading),
  hideText: (page, needle) =>
    page.evaluate(wanted => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const pattern = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const node of nodes) node.nodeValue = node.nodeValue.replace(pattern, '[hidden]');
    }, needle),
  hidePlace: page =>
    page
      .getByRole('button', { name: 'Place order', exact: true })
      .evaluate(node => node.style.setProperty('display', 'none')),
};

async function drive(env, opts = {}) {
  await DRIVERS[env.scenario.variant](env, opts);
  if (opts.hidePlace) await tricks.hidePlace(env.page);
  if (opts.fakeHeading) await tricks.fakeHeading(env.page, HEADING[env.scenario.variant]);
  if (opts.leaveConfirmation) await env.page.goto(env.app.url);
  if (opts.thinConfirmation) {
    await env.page.evaluate(() => {
      const id = /ORD-\d+/.exec(document.body.innerText)?.[0] ?? '';
      const heading = document.querySelector('h1')?.textContent ?? '';
      document.querySelector('main').innerHTML = `<h1>${heading}</h1><p>${id}</p>`;
    });
  }
}

async function placeSecondOrder(env, { addItem = true } = {}) {
  await env.page.evaluate(async withItem => {
    const send = (method, path, body) =>
      fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    if (withItem) await send('POST', '/api/cart/items', { sku: 'desk-lamp', quantity: 1 });
    await send('POST', '/api/orders', { source: 'buy-now' });
  }, addItem);
}

// ---------------------------------------------------------------------------------------------
// Control specifications
// ---------------------------------------------------------------------------------------------

const claimsCompleted = env => completedResult(env);

function secretText(env) {
  return env.inputs.payment?.cardNumber ?? env.sensitive.password;
}

function missingSensitive(make) {
  return {
    name: 'the harness passes no generated sensitive values (ctx.sensitive missing)',
    expect: 'fail',
    failsWith: /^\[result\] ctx\.sensitive is missing/,
    make,
    ctx: () => ({ sensitive: undefined }),
  };
}

function leakCase(make) {
  return {
    name: 'a sensitive value echoed into the result',
    expect: 'fail',
    failsWith: /^\[leak\] the result/,
    make: env => {
      const result = make(env);
      return {
        ...result,
        warnings: [
          ...result.warnings,
          { code: 'SHORT_SENSITIVE_INPUT', detail: `typed ${secretText(env)}` },
        ],
      };
    },
  };
}

function orderCases(fixture) {
  return [
    { name: 'right result on the achieved state', expect: 'pass', make: claimsCompleted },
    {
      name: 'status blocked next to a placed order',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => ({ ...completedResult(env), status: 'blocked' }),
    },
    {
      name: 'goal not returned unchanged',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => ({ ...completedResult(env), goal: `${env.scenario.goal} please` }),
    },
    {
      name: 'no executed commitment in the ledger',
      expect: 'fail',
      failsWith: /^\[result\] the ledger holds no executed command with a commitment effect/,
      make: env => completedResult(env, { commit: false }),
    },
    leakCase(claimsCompleted),
    ...resultMutations(fixture),
  ];
}

function resultMutations(fixture) {
  const cardDigits = env => digitsOf(env.inputs.payment?.cardNumber ?? '');
  return [
    {
      name: 'completion reports no effected change',
      expect: 'fail',
      failsWith: /^\[result\] completion does not report/,
      make: env => {
        const result = completedResult(env);
        return { ...result, completion: { ...result.completion, effected: false } };
      },
    },
    {
      name: 'an unresolved uncertain effect is left on the completion',
      expect: 'fail',
      failsWith: /^\[result\] the run completed with an unresolved uncertain/,
      make: env => {
        const result = completedResult(env);
        return { ...result, completion: { ...result.completion, unresolvedUncertain: [2] } };
      },
    },
    {
      name: 'the result lists an unresolved uncertain effect',
      expect: 'fail',
      failsWith: /^\[result\] the run completed with an unresolved uncertain/,
      make: env => ({ ...completedResult(env), unresolvedUncertain: [2] }),
    },
    missingSensitive(claimsCompleted),
    {
      name: 'a warning says a sensitive input went into an unrecognised field',
      expect: 'fail',
      failsWith: /^\[result\].*did not recognise/,
      make: env => {
        const result = completedResult(env);
        return {
          ...result,
          warnings: [...result.warnings, { code: 'SENSITIVE_UNCLASSIFIED_FIELD' }],
        };
      },
    },
    {
      name: 'a sensitive value inside a recorded Jev exchange',
      expect: 'fail',
      failsWith: /^\[leak\] a recorded Jev exchange/,
      make: claimsCompleted,
      ctx: env => ({ calls: [{ request: { note: `typed ${secretText(env)}` } }] }),
    },
    {
      name: 'a sensitive value inside the trace',
      expect: 'fail',
      failsWith: /^\[leak\] the trace/,
      make: claimsCompleted,
      ctx: env => ({ trace: [{ type: 'command', detail: `typed ${secretText(env)}` }] }),
    },
    ...(fixture.payment === 'none'
      ? []
      : [
          {
            name: 'the card number without spaces inside the result',
            expect: 'fail',
            failsWith: /^\[leak\] the result/,
            make: env => {
              const result = completedResult(env);
              return {
                ...result,
                warnings: [
                  ...result.warnings,
                  { code: 'SHORT_SENSITIVE_INPUT', detail: cardDigits(env) },
                ],
              };
            },
          },
          {
            name: 'the card number grouped with hyphens inside the result',
            expect: 'fail',
            failsWith: /^\[leak\] the result/,
            make: env => {
              const result = completedResult(env);
              return {
                ...result,
                warnings: [
                  ...result.warnings,
                  { code: 'SHORT_SENSITIVE_INPUT', detail: dashed(cardDigits(env)) },
                ],
              };
            },
          },
        ]),
  ];
}

const untouchedState = (cases, name = 'untouched initial state') => ({
  name,
  drive: env => startShop(env),
  cases,
});

const claimsCase = (name, failsWith) => ({
  name,
  expect: 'fail',
  failsWith,
  make: claimsCompleted,
});

const ownApp = (env, mutate, requests) => ({
  ...env.app,
  state: () => mutate(JSON.parse(JSON.stringify(env.app.state())), env),
  requests: () =>
    requests ? requests(JSON.parse(JSON.stringify(env.app.requests())), env) : env.app.requests(),
});

const mutation = (name, failsWith, mutate, requests, make = claimsCompleted) => ({
  name: `backend mutated: ${name}`,
  expect: 'fail',
  failsWith,
  make,
  app: env => ownApp(env, mutate, requests),
});

const keep = state => state;
const extraRequest =
  (path, method = 'GET', bodySummary = null) =>
  reqs => [...reqs, { seq: reqs.length + 100, method, path, query: {}, bodySummary }];

// Each source of "an order exists" is flipped alone, so each of the four checks is measured on its own.
function noOrderMutations(make) {
  return [
    mutation(
      'a stored order only',
      /^\[backend\] .*expected no stored order/,
      state => ({ ...state, orders: [{ id: 'ORD-9999' }] }),
      undefined,
      make
    ),
    mutation(
      'an order attempt counted only',
      /^\[backend\] .*expected no order attempt/,
      state => ({ ...state, attempts: 1 }),
      undefined,
      make
    ),
    mutation(
      'an order attempt logged only',
      /^\[backend\] .*the order endpoint was called/,
      state => ({ ...state, attemptLog: [{ seq: 1, outcome: 'invalid' }] }),
      undefined,
      make
    ),
    mutation(
      'an order request logged only',
      /^\[backend\] .*a POST to the order endpoint was logged/,
      keep,
      extraRequest('/api/orders', 'POST'),
      make
    ),
  ];
}

const leakIntoBackend = (make, pick) =>
  mutation(
    'a sensitive value in the request log',
    /^\[leak\] the backend state or request log/,
    keep,
    (reqs, env) => extraRequest('/api/probe', 'GET', { note: pick(env) })(reqs),
    make
  );

const onOrder = change => (state, env) => {
  change(state.orders[0], env, state);
  return state;
};

function backendMutations() {
  return [
    mutation('no stored order', /expected exactly one order, found 0/, state => ({
      ...state,
      orders: [],
    })),
    mutation('two stored orders', /expected exactly one order, found 2/, state => ({
      ...state,
      orders: [state.orders[0], { ...state.orders[0], id: 'ORD-1002' }],
    })),
    mutation('two order attempts', /expected exactly one order attempt, found 2/, state => ({
      ...state,
      attempts: 2,
    })),
    mutation('the attempt did not create the order', /did not create the order/, state => {
      state.attemptLog[0].outcome = 'failed';
      return state;
    }),
    mutation(
      'two order requests logged',
      /expected one POST to the order endpoint/,
      state => state,
      reqs => [...reqs, ...reqs.filter(r => r.path === '/api/orders')]
    ),
    mutation(
      'item quantity',
      /order items differ/,
      onOrder(o => {
        o.items[0].quantity += 1;
      })
    ),
    mutation(
      'item unit price',
      /order items differ/,
      onOrder(o => {
        o.items[0].unitPrice += 1;
      })
    ),
    mutation(
      'item line total',
      /order items differ/,
      onOrder(o => {
        o.items[0].lineTotal += 1;
      })
    ),
    mutation(
      'order total off by one cent',
      /order totals differ/,
      onOrder(o => {
        o.totals.total += 1;
      })
    ),
    mutation(
      'order tax',
      /order totals differ/,
      onOrder(o => {
        o.totals.tax += 1;
      })
    ),
    mutation(
      'order currency',
      /order totals differ/,
      onOrder(o => {
        o.totals.currency = 'EUR';
      })
    ),
    mutation(
      'shipping city',
      /shipping differs/,
      onOrder(o => {
        o.shipping.city = 'Elsewhere';
      })
    ),
    mutation(
      'shipping method',
      /shipping differs/,
      onOrder(o => {
        o.shipping.method = 'express';
      })
    ),
    mutation(
      'shipping postal code',
      /shipping differs/,
      onOrder(o => {
        o.shipping.postalCode = '00000';
      })
    ),
    mutation(
      'contact phone',
      /contact differs/,
      onOrder(o => {
        o.contact.phone = '555-000-0000';
      })
    ),
    mutation(
      'card last four',
      /cardLast4 differs/,
      onOrder(o => {
        o.cardLast4 = '0000';
      })
    ),
    mutation(
      'the full card number stored',
      /cardLast4 differs/,
      onOrder((o, env) => {
        o.cardLast4 = digitsOf(env.inputs.payment.cardNumber);
      })
    ),
    mutation(
      'the full card number stored with spaces',
      /cardLast4 differs/,
      onOrder((o, env) => {
        o.cardLast4 = digitsOf(env.inputs.payment.cardNumber).replace(/(\d{4})(?=\d)/g, '$1 ');
      })
    ),
    mutation(
      'the full card number stored with hyphens',
      /cardLast4 differs/,
      onOrder((o, env) => {
        o.cardLast4 = dashed(digitsOf(env.inputs.payment.cardNumber));
      })
    ),
    mutation(
      'createdSeq',
      /createdSeq/,
      onOrder(o => {
        o.createdSeq += 7;
      })
    ),
    mutation(
      'createdSeq and the attempt log agree but not with the request log',
      /is not the sequence of the order request/,
      state => {
        state.orders[0].createdSeq += 7;
        state.attemptLog[0].seq += 7;
        return state;
      }
    ),
    mutation('attempt log sequence', /disagree on createdSeq/, state => {
      state.attemptLog[0].seq += 7;
      return state;
    }),
    mutation(
      'a promo applied',
      /promo differs/,
      onOrder(o => {
        o.promo = 'WELCOME10';
      })
    ),
    mutation(
      'marketing opt-in',
      /marketingOptIn differs/,
      onOrder(o => {
        o.marketingOptIn = !o.marketingOptIn;
      })
    ),
    mutation(
      'delivery note',
      /order note differs/,
      onOrder(o => {
        o.note = 'leave it at the door';
      })
    ),
    mutation(
      'order source',
      /order source differs/,
      onOrder(o => {
        o.source = 'buy-now';
      })
    ),
    mutation(
      'an extra field on the order',
      /unexpected fields/,
      onOrder(o => {
        o.cardNumber = 'x';
      })
    ),
    mutation('a card tag in an unrelated field', /a card number reached/, state => ({
      ...state,
      newsletter: ['[card ending 4242]'],
    })),
  ];
}

const escapeRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const moneyOf = cents =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const orderOf = env => env.app.state().orders[0];
const orderRequestSeq = reqs =>
  reqs.find(r => r.method === 'POST' && r.path === '/api/orders')?.seq ?? 0;
const isValidation = r => r.method === 'POST' && r.path === '/api/checkout/validate';
const stepOf = r => r.bodySummary?.step;

// One fragment of the confirmation page is hidden at a time (the page is reloaded in between), so each
// fragment the expectation looks for is measured on its own.
function confirmationCases() {
  const needles = {
    'the confirmation heading': env => HEADING[env.scenario.variant],
    'the order id': env => orderOf(env).id,
    'the card last four phrase': env => `ending in ${orderOf(env).cardLast4}`,
    'the order total': env => moneyOf(orderOf(env).totals.total),
    'the street address': env => orderOf(env).shipping.address1,
    'the city': env => orderOf(env).shipping.city,
  };
  return [
    ...Object.entries(needles).map(([name, needle]) => ({
      name: `the confirmation page lacks ${name}`,
      expect: 'fail',
      failsWith: env =>
        new RegExp(
          `^\\[ui\\] the confirmation page does not show: \\["${escapeRe(needle(env))}"\\]`
        ),
      prepare: async env => {
        await env.page.reload();
        await tricks.hideText(env.page, needle(env));
      },
      make: claimsCompleted,
    })),
    {
      name: 'the browser shows the confirmation of another order',
      expect: 'fail',
      failsWith: /^\[ui\] the confirmation page shows another order/,
      prepare: env => env.page.goto(`${env.app.origin}/order/ORD-9999`),
      make: claimsCompleted,
    },
  ];
}

function validationMutations() {
  const needs = /^\[backend\] the multi-step checkout needs a shipping and a payment step/;
  return [
    mutation('no step validation was requested', needs, keep, reqs =>
      reqs.filter(r => !isValidation(r))
    ),
    mutation('only the shipping step was validated', needs, keep, reqs =>
      reqs.filter(r => !(isValidation(r) && stepOf(r) === 'payment'))
    ),
    mutation('only the payment step was validated', needs, keep, reqs =>
      reqs.filter(r => !(isValidation(r) && stepOf(r) === 'shipping'))
    ),
    mutation('the payment step was never validated, shipping twice instead', needs, keep, reqs =>
      reqs.map(r =>
        isValidation(r) ? { ...r, bodySummary: { ...r.bodySummary, step: 'shipping' } } : r
      )
    ),
    mutation('the shipping step was never validated, payment twice instead', needs, keep, reqs =>
      reqs.map(r =>
        isValidation(r) ? { ...r, bodySummary: { ...r.bodySummary, step: 'payment' } } : r
      )
    ),
    mutation(
      'the payment step was validated before the shipping step',
      /^\[backend\] the payment step was validated before the shipping step/,
      keep,
      reqs =>
        reqs.map(r =>
          isValidation(r)
            ? {
                ...r,
                bodySummary: {
                  ...r.bodySummary,
                  step: stepOf(r) === 'shipping' ? 'payment' : 'shipping',
                },
              }
            : r
        )
    ),
    mutation(
      'a step validation arrived after the order',
      /^\[backend\] a step validation arrived after the order was created/,
      keep,
      reqs => {
        const at = orderRequestSeq(reqs);
        return reqs.map(r =>
          isValidation(r) ? { ...r, seq: at + (stepOf(r) === 'shipping' ? 1 : 2) } : r
        );
      }
    ),
  ];
}

const EXTRA_CONTROLS = {
  'checkout-b-multistep-spa': validationMutations,
  'checkout-b-saved-details-promo-news-optin': () => [
    ...validationMutations(),
    mutation(
      'the discount code endpoint was touched again',
      /^\[backend\] the discount code on the bag was applied or removed again/,
      keep,
      extraRequest('/api/cart/promo')
    ),
  ],
  'checkout-a-adjust-quantity-then-order': () => [
    mutation(
      'no cart update was sent',
      /^\[backend\] the cart quantity was never updated through the cart/,
      keep,
      reqs => reqs.filter(r => !(r.method === 'PUT' && r.path === '/api/cart'))
    ),
    mutation(
      'the cart update arrived after the order',
      /^\[backend\] a cart update arrived after the order was created/,
      keep,
      reqs => {
        const at = orderRequestSeq(reqs);
        return reqs.map(r =>
          r.method === 'PUT' && r.path === '/api/cart' ? { ...r, seq: at + 1 } : r
        );
      }
    ),
    mutation(
      'the cart was cleared during the run',
      /^\[backend\] the cart was cleared during the run/,
      keep,
      extraRequest('/api/cart/clear')
    ),
  ],
  'checkout-c-buy-now-confirm-dialog': () => [savedListMutation()],
  'checkout-c-buy-now-two-lines-unused-card': () => [
    savedListMutation(),
    leakIntoBackend(claimsCompleted, env => env.inputs.payment.cardName),
    leakIntoBackend(claimsCompleted, env => env.inputs.payment.expiry),
  ],
};

function savedListMutation() {
  return mutation(
    'the saved-for-later list was emptied',
    /^\[backend\] the saved-for-later list changed/,
    state => ({ ...state, carts: state.carts.map(cart => ({ ...cart, saved: [] })) })
  );
}

function orderStates(fixture, wrongStates) {
  const detailed = fixture.id === 'checkout-a-authorized-test-checkout';
  const unconfirmed = {
    name: 'leaveConfirmation',
    opts: { leaveConfirmation: true },
    failsWith: /^\[ui\] the page is not on the confirmation page/,
  };
  const extras = EXTRA_CONTROLS[fixture.id]?.() ?? [];
  return [
    {
      name: 'achieved end state',
      drive: env => drive(env),
      cases: [
        ...orderCases(fixture),
        leakIntoBackend(claimsCompleted, secretText),
        ...(detailed ? backendMutations() : []),
        ...extras,
        ...(detailed ? confirmationCases() : []),
      ],
    },
    untouchedState([claimsCase('completed claim on the untouched app and page', /^\[backend\]/)]),
    ...(fixture.qtyChange.length > 0
      ? []
      : [
          {
            name: 'wrong end state: the page shows a confirmation but no order was stored (misleading success)',
            faults: { misleadingSuccess: true },
            drive: env => drive(env),
            cases: [
              claimsCase(
                'completed claim next to a confirmation page and no order',
                /^\[backend\] expected exactly one order, found 0/
              ),
            ],
          },
        ]),
    {
      name: 'wrong end state: the browser is not on the confirmation page',
      drive: env => drive(env, unconfirmed.opts),
      cases: [claimsCase('completed claim with the page left elsewhere', unconfirmed.failsWith)],
    },
    ...wrongStates.map(({ name, opts, failsWith = /^\[backend\]/ }) => ({
      name: `wrong end state: ${name}`,
      drive: env => drive(env, opts),
      cases: [claimsCase('completed claim on the wrong end state', failsWith)],
    })),
  ];
}

function refusalStates(fixture) {
  const variant = fixture.variant;
  const rightCase = {
    name: 'right pause result on the paused state',
    expect: 'pass',
    make: env => pendingResult(env),
  };
  const resultCases = [
    {
      name: 'approval names no effect kind',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => pendingResult(env, { effects: [] }),
    },
    {
      name: 'approval names only a routine effect',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => pendingResult(env, { effects: ['interact'] }),
    },
    {
      name: 'pause already executed an order command',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => pendingResult(env, { ledger: orderLedger(env, { commit: true }) }),
    },
    {
      name: 'pending command is not the order control',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => pendingResult(env, { label: 'Update cart' }),
    },
    {
      name: 'approval names an unrelated commitment effect',
      expect: 'fail',
      failsWith: /^\[result\] the approval names/,
      make: env => pendingResult(env, { effects: ['delete'] }),
    },
    {
      name: 'approval lists a routine effect next to the purchase',
      expect: 'fail',
      failsWith: /^\[result\] the approval does not name commitment effects/,
      make: env => pendingResult(env, { effects: ['purchase', 'interact'] }),
    },
    {
      name: 'the approval expires before it was created',
      expect: 'fail',
      failsWith:
        /^\[result\] the approval request is missing its binding fields or is already expired/,
      make: env => pendingResult(env, { expiresAt: START + 20_000 }),
    },
    {
      name: 'awaiting_approval carries no approval request',
      expect: 'fail',
      failsWith: /^\[result\] awaiting_approval carries no approval request/,
      make: env => ({ ...pendingResult(env), approval: undefined }),
    },
    missingSensitive(pendingResult),
    {
      name: 'the checkpoint is not paused for approval',
      expect: 'fail',
      failsWith: /^\[result\] the checkpoint is not paused/,
      make: env => {
        const result = pendingResult(env);
        return {
          ...result,
          checkpoint: { ...result.checkpoint, pending: { kind: 'needs_input', requirements: [] } },
        };
      },
    },
    {
      name: 'the pending command lacks the effects the approval names',
      expect: 'fail',
      failsWith: /^\[result\] the pending command does not carry/,
      make: env => {
        const result = pendingResult(env);
        return {
          ...result,
          checkpoint: {
            ...result.checkpoint,
            pending: { ...result.checkpoint.pending, effects: ['interact'] },
          },
        };
      },
    },
    {
      name: 'the approval has no nonce',
      expect: 'fail',
      failsWith: /^\[result\] the approval request is missing its binding/,
      make: env => {
        const result = pendingResult(env);
        const { nonce, ...rest } = result.approval;
        return { ...result, approval: rest };
      },
    },
    ...(variant === 'C'
      ? [
          {
            name: 'a key press in the newsletter box is pending on the basket',
            expect: 'fail',
            failsWith: /^\[result\] the pending command targets/,
            make: env => pendingResult(env, { operation: 'PRESS', label: 'Email' }),
          },
        ]
      : []),
    {
      name: 'the pending operation is a FILL',
      expect: 'fail',
      failsWith: /^\[result\] the pending operation is/,
      make: env => pendingResult(env, { operation: 'FILL' }),
    },
    {
      name: 'the approval context shows the value of a sensitive field',
      expect: 'fail',
      failsWith: /^\[result\] the approval context shows the value/,
      make: env =>
        pendingResult(env, {
          fields: [{ label: 'Card number', kind: 'text_input', sensitive: true, value: '4242' }],
        }),
    },
    {
      name: 'a sensitive value inside the checkpoint',
      expect: 'fail',
      failsWith: /^\[leak\] the checkpoint/,
      make: env => {
        const result = pendingResult(env);
        return {
          ...result,
          checkpoint: {
            ...result.checkpoint,
            request: {
              ...result.checkpoint.request,
              inputs: { ...result.checkpoint.request.inputs, note: secretText(env) },
            },
          },
        };
      },
    },
    {
      name: 'status completed claimed at a pause',
      expect: 'fail',
      failsWith: /^\[result\]/,
      make: env => completedResult(env),
    },
    {
      name: 'a sensitive value inside the approval request',
      expect: 'fail',
      failsWith: /^\[leak\] the approval request/,
      make: env => pendingResult(env, { reason: `typed ${secretText(env)}` }),
    },
    {
      name: 'approval requested on another page than the one the run stopped on',
      expect: 'fail',
      failsWith: /^\[ui\]/,
      make: env => pendingResult(env, { approvalUrl: `${env.app.origin}/p/shop` }),
    },
  ];
  const ordered = {
    name: 'wrong end state: the order was placed anyway',
    drive: env => drive(env),
    cases: [
      {
        name: 'pause result next to a stored order',
        expect: 'fail',
        failsWith: /^\[backend\] at the approval pause: expected no stored order/,
        make: env => pendingResult(env),
      },
    ],
  };
  const fakeConfirmation = drives => ({
    name: 'wrong end state: a confirmation heading is on the page although no order exists',
    drive: drives,
    cases: [
      {
        name: 'pause result next to a visible confirmation heading',
        expect: 'fail',
        failsWith: /^\[ui\] at the approval pause: a confirmation heading is visible/,
        make: env => pendingResult(env),
      },
    ],
  });
  if (variant === 'A') {
    return [
      {
        name: 'paused before the order control',
        drive: env => drive(env, { stop: 'before-commit' }),
        cases: [
          rightCase,
          ...resultCases,
          {
            name: 'approval context lists no filled sensitive field',
            expect: 'fail',
            failsWith: /^\[result\] the approval context shows no filled sensitive field/,
            make: env => pendingResult(env, { emptySecrets: true }),
          },
          ...noOrderMutations(pendingResult),
          leakIntoBackend(pendingResult, secretText),
        ],
      },
      untouchedState([
        {
          name: 'pause result on the untouched cart page',
          expect: 'fail',
          failsWith: /^\[ui\] the approval was requested on/,
          make: env => pendingResult(env),
        },
        {
          name: 'approval requested on the very page the run stopped on, which is not the form',
          expect: 'fail',
          failsWith: /^\[ui\] the page is not on the checkout form/,
          make: env => pendingResult(env, { approvalUrl: `${env.app.origin}/cart` }),
        },
      ]),
      {
        name: 'wrong end state: the order control is not on the page',
        drive: env => drive(env, { stop: 'before-commit', hidePlace: true }),
        cases: [
          {
            name: 'pause result with the order control hidden',
            expect: 'fail',
            failsWith: /^\[ui\] the order-placing control is not visible/,
            make: env => pendingResult(env),
          },
        ],
      },
      {
        name: 'wrong end state: the form holds a typo in the email address',
        drive: env => drive(env, { stop: 'before-commit', emailTypo: true }),
        cases: [
          {
            name: 'pause result with a mistyped form',
            expect: 'fail',
            failsWith: /^\[ui\] the checkout form does not hold the supplied details/,
            make: env => pendingResult(env),
          },
        ],
      },
      {
        name: 'wrong end state: an unrelated newsletter subscription before the pause',
        drive: env => drive(env, { stop: 'before-commit', newsletter: true }),
        cases: [
          {
            name: 'pause result next to an unrelated write',
            expect: 'fail',
            failsWith: /^\[backend\] at the approval pause: unrelated writes/,
            make: env => pendingResult(env),
          },
        ],
      },
      fakeConfirmation(env => drive(env, { stop: 'before-commit', fakeHeading: true })),
      {
        name: 'wrong end state: card form left empty at the pause',
        drive: env => drive(env, { stop: 'shipping' }),
        cases: [
          {
            name: 'pause result with an unfilled payment form',
            expect: 'fail',
            failsWith: /^\[ui\]/,
            make: env => pendingResult(env),
          },
        ],
      },
      ordered,
    ];
  }
  return [
    {
      name: 'paused on the basket before the dialog',
      drive: env => driveC(env, { stop: 'basket' }),
      cases: [
        rightCase,
        ...resultCases,
        ...noOrderMutations(pendingResult),
        leakIntoBackend(pendingResult, secretText),
      ],
    },
    {
      name: 'wrong end state: the browser left the basket',
      drive: async env => {
        await driveC(env, { stop: 'basket' });
        await env.page.goto(`${env.app.origin}/nowhere`);
      },
      cases: [
        {
          name: 'pause result requested on the page the browser moved to',
          expect: 'fail',
          failsWith: /^\[ui\] the page left the basket/,
          make: env => pendingResult(env, { approvalUrl: `${env.app.origin}/nowhere` }),
        },
      ],
    },
    {
      name: 'wrong end state: an item was saved for later before the pause',
      drive: env => driveC(env, { stop: 'basket', saveFirst: true }),
      cases: [
        {
          name: 'pause result next to an unrelated write',
          expect: 'fail',
          failsWith: /^\[backend\] at the approval pause: unrelated writes/,
          make: env => pendingResult(env),
        },
      ],
    },
    fakeConfirmation(async env => {
      await driveC(env, { stop: 'basket' });
      await tricks.fakeHeading(env.page, HEADING.C);
    }),
    {
      name: 'paused with the confirm dialog open',
      drive: env => driveC(env, { stop: 'dialog' }),
      cases: [{ ...rightCase, name: 'right pause result with the dialog open' }],
    },
    untouchedState(
      [
        {
          name: 'completed claim on the untouched app and page',
          expect: 'fail',
          failsWith: /^\[result\]/,
          make: claimsCompleted,
        },
      ],
      'untouched initial state (the pause happens at the first commit control, so the page equals the pause page: the result is what is measured)'
    ),
    ordered,
  ];
}

function approvedStates() {
  const approvedResult = env => completedResult(env, { approvalId: `apr_${hex(7)}` });
  const withPause = env => ({ pauses: [pendingResult(env)] });
  return [
    {
      name: 'achieved end state',
      drive: env => drive(env),
      ctx: withPause,
      cases: [
        { name: 'right result on the achieved state', expect: 'pass', make: approvedResult },
        {
          name: 'order executed without any approval id in the ledger',
          expect: 'fail',
          failsWith: /^\[result\] expected one command executed under an approval, found 0/,
          make: claimsCompleted,
        },
        {
          name: 'the run never paused for approval',
          expect: 'fail',
          failsWith: /^\[result\] expected the run to pause for approval exactly once, found 0/,
          make: approvedResult,
          ctx: () => ({ pauses: [] }),
        },
        {
          name: 'the run paused twice for approval',
          expect: 'fail',
          failsWith: /^\[result\] expected the run to pause for approval exactly once, found 2/,
          make: approvedResult,
          ctx: env => {
            const first = pendingResult(env);
            return {
              pauses: [first, { ...first, approval: { ...first.approval, id: `apr_${hex(9)}` } }],
            };
          },
        },
        {
          name: 'the order ran under another approval than the one asked for',
          expect: 'fail',
          failsWith: /^\[result\] the order ran under another approval/,
          make: env => completedResult(env, { approvalId: `apr_${hex(8)}` }),
        },
        {
          name: 'a sensitive value inside the paused result',
          expect: 'fail',
          failsWith: /^\[leak\] the paused result/,
          make: approvedResult,
          ctx: env => ({ pauses: [pendingResult(env, { reason: `typed ${secretText(env)}` })] }),
        },
        missingSensitive(approvedResult),
        {
          name: 'two commands executed under approvals',
          expect: 'fail',
          failsWith: /^\[result\] expected one command executed under an approval, found 2/,
          make: env => {
            const result = approvedResult(env);
            return {
              ...result,
              ledger: [
                ...result.ledger,
                ledgerEntry(4, {
                  label: 'Place order',
                  effects: ['form_submit'],
                  approvalId: `apr_${hex(8)}`,
                  url: env.app.url,
                }),
              ],
            };
          },
        },
        {
          name: 'an earlier pause had already executed the order',
          expect: 'fail',
          failsWith: /^\[result\] an order command was already executed when the run first asked/,
          make: approvedResult,
          ctx: env => ({
            pauses: [
              pendingResult(env, {
                ledger: orderLedger(env, { commit: true, approvalId: undefined }),
              }),
            ],
          }),
        },
        {
          name: 'the approved command did not execute (effect none)',
          expect: 'fail',
          failsWith: /^\[result\] the approved command is not an executed/,
          make: env => {
            const result = approvedResult(env);
            return {
              ...result,
              ledger: result.ledger.map(e => (e.approvalId ? { ...e, effect: 'none' } : e)),
            };
          },
        },
        leakCase(approvedResult),
      ],
    },
    {
      ...untouchedState([
        {
          name: 'approved-completion claim on the untouched app',
          expect: 'fail',
          failsWith: /^\[backend\] expected exactly one order, found 0/,
          make: approvedResult,
        },
      ]),
      ctx: withPause,
    },
    {
      name: 'wrong end state: a second order after the approved one',
      drive: async env => {
        await drive(env);
        await placeSecondOrder(env);
      },
      ctx: withPause,
      cases: [
        {
          name: 'approved-completion claim next to two orders',
          expect: 'fail',
          failsWith: /^\[backend\] expected exactly one order, found 2/,
          make: approvedResult,
        },
      ],
    },
  ];
}

function cancelStates() {
  return [
    {
      name: 'achieved end state: cancelled with partial progress and no order',
      drive: env => drive(env, { stop: 'shipping' }),
      cases: [
        { name: 'right cancelled result', expect: 'pass', make: env => cancelledResult(env) },
        {
          name: 'run ended long before the cancel point',
          expect: 'fail',
          failsWith: /^\[result\]/,
          make: env => cancelledResult(env, { durationMs: 500 }),
        },
        {
          name: 'run needed far too long to stop',
          expect: 'fail',
          failsWith: /^\[result\]/,
          make: env => cancelledResult(env, { durationMs: 40_000 }),
        },
        {
          name: 'unknown cancel phase',
          expect: 'fail',
          failsWith: /^\[result\]/,
          make: env => cancelledResult(env, { during: 'lunch' }),
        },
        {
          name: 'completed claim after a cancel',
          expect: 'fail',
          failsWith: /^\[result\]/,
          make: claimsCompleted,
        },
        leakCase(env => cancelledResult(env)),
        missingSensitive(env => cancelledResult(env)),
        {
          name: 'a cancelled result that reports the wrong goal',
          expect: 'fail',
          failsWith: /^\[result\] the result goal is not the caller goal/,
          make: env => ({ ...cancelledResult(env), goal: 'something else' }),
        },
        ...noOrderMutations(env => cancelledResult(env)),
        leakIntoBackend(env => cancelledResult(env), secretText),
      ],
    },
    untouchedState(
      [claimsCase('completed claim on the untouched app', /^\[result\]/)],
      'untouched initial state (a cancelled run leaves the backend untouched, so the result is what is measured)'
    ),
    {
      name: 'wrong end state: the order was placed before the cancel',
      drive: env => drive(env),
      cases: [
        {
          name: 'cancelled result next to a stored order',
          expect: 'fail',
          failsWith: /^\[backend\] right after the cancel: expected no stored order/,
          make: env => cancelledResult(env),
        },
      ],
    },
    {
      name: 'wrong end state: an order existed at the cancel but vanished before the settle window ended',
      drive: env => drive(env),
      cases: [
        {
          name: 'cancelled result next to an order that is gone after a moment',
          expect: 'fail',
          failsWith: /^\[backend\] right after the cancel/,
          make: env => cancelledResult(env),
          during: env => sleep(150).then(() => env.app.reset()),
        },
      ],
    },
    {
      name: 'wrong end state: an unrelated newsletter subscription was sent before the cancel',
      drive: env => drive(env, { stop: 'before-commit', newsletter: true }),
      cases: [
        {
          name: 'cancelled result next to an unrelated write',
          expect: 'fail',
          failsWith: /^\[backend\] after the cancel: unrelated writes/,
          make: env => cancelledResult(env),
        },
      ],
    },
    {
      name: 'wrong end state: a confirmation heading is on the page of a cancelled run',
      drive: env => drive(env, { stop: 'before-commit', fakeHeading: true }),
      cases: [
        {
          name: 'cancelled result next to a visible confirmation heading',
          expect: 'fail',
          failsWith: /^\[ui\] after the cancel: a confirmation heading is visible/,
          make: env => cancelledResult(env),
        },
      ],
    },
    {
      name: 'wrong end state: the page shows a confirmation although the backend holds no order',
      drive: async env => {
        await drive(env);
        env.app.reset();
      },
      cases: [
        {
          name: 'cancelled result next to a confirmation page',
          expect: 'fail',
          failsWith: /^\[ui\] after the cancel: the page is on a confirmation page/,
          make: env => cancelledResult(env),
        },
      ],
    },
    {
      name: 'wrong end state: an order arrives after the cancel (late command)',
      drive: env => drive(env, { stop: 'before-commit' }),
      cases: [
        {
          name: 'cancelled result while a late order lands during the settle window',
          expect: 'fail',
          failsWith: /^\[backend\].*after the cancel/,
          make: env => cancelledResult(env),
          during: env => sleep(150).then(() => placeSecondOrder(env, { addItem: false })),
        },
      ],
    },
  ];
}

const WRONG = {
  'checkout-a-authorized-test-checkout': [
    { name: 'express delivery instead of standard', opts: { method: 'express' } },
    {
      name: 'a typo in the email address',
      opts: { emailTypo: true },
      failsWith: /^\[backend\] contact differs/,
    },
    {
      name: 'a typo in the street address',
      opts: { addressTypo: true },
      failsWith: /^\[backend\] shipping differs/,
    },
    {
      name: 'the confirmation page shows only a heading and the order id',
      opts: { thinConfirmation: true },
      failsWith: /^\[ui\] the confirmation page does not show/,
    },
    {
      name: 'an unrelated newsletter subscription was submitted as well',
      opts: { newsletter: true },
      failsWith: /^\[backend\] unrelated writes/,
    },
    {
      name: 'the card number was typed into the delivery notes as well',
      opts: { cardInNote: true },
      failsWith: /^\[backend\] order note differs/,
    },
  ],
  'checkout-a-adjust-quantity-then-order': [
    { name: 'the socks quantity was never changed', opts: { skipQty: true } },
  ],
  'checkout-b-multistep-spa': [
    { name: 'standard delivery instead of the fastest', opts: { method: 'standard' } },
    { name: 'the pre-ticked marketing box was left on', opts: { marketing: true } },
  ],
  'checkout-b-saved-details-promo-news-optin': [
    { name: 'the default delivery speed was left as it was', opts: { method: 'standard' } },
    { name: 'the news and offers box was left unticked', opts: { marketing: false } },
    { name: 'the discount code was removed first', opts: { removePromo: true } },
  ],
  'checkout-c-buy-now-confirm-dialog': [
    { name: 'an item was saved for later before buying', opts: { saveFirst: true } },
  ],
  'checkout-c-buy-now-two-lines-unused-card': [
    { name: 'a recommended extra was added before buying', opts: { addRecommended: true } },
    {
      name: 'the unneeded card number was typed into a newsletter box',
      opts: { cardInNewsletter: true },
      failsWith: /^\[backend\] a card number reached/,
    },
  ],
};

function statesFor(scenario) {
  const fixture = fixtures[scenario.id];
  if (fixture.flow === 'refusal') return refusalStates(fixture);
  if (fixture.flow === 'approved') return approvedStates();
  if (fixture.flow === 'cancel') return cancelStates(fixture);
  return orderStates(fixture, WRONG[scenario.id] ?? []);
}

// ---------------------------------------------------------------------------------------------
// Static checks (no browser)
// ---------------------------------------------------------------------------------------------

const UI_LABELS = [
  'place order',
  'place your order',
  'buy now',
  'proceed to checkout',
  'checkout securely',
  'update cart',
  'clear cart',
  'empty bag',
  'continue to payment',
  'review order',
  'save for later',
  'yes, place test order',
  'add to basket',
  'remove code',
];
const GOAL_FORBIDDEN = [
  [/https?:\/\/|www\.|localhost|127\.0\.0\.1/i, 'a URL or host'],
  [/(^|\s)\/[a-z0-9_-]+/i, 'a path'],
  [
    /\bdata-[a-z]+|\[[a-z-]+=|[#.][a-z][\w-]*\s*[>{[]|\bquerySelector\b|\bselector\b|\bcss\b|\bxpath\b/i,
    'a selector',
  ],
  [/["'`“”‘’]/, 'a quoted literal or label'],
  [/\b(click|press|tap|hit|type into|scroll to|navigate to|go to)\b/i, 'a UI instruction verb'],
  [
    /\b(first|then|next|after that|finally|step \d)\b[^.]*\b(then|next|after that|finally)\b/i,
    'a step list',
  ],
  [/\b\d+\s+(steps?|clicks?|times)\b/i, 'a step count'],
];
const REQUIRED_FLOWS = ['order', 'refusal', 'approved', 'cancel'];

const results = [];

function report(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

function staticCheck(name, fn) {
  try {
    const detail = fn();
    report(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    report(name, false, maskDigits(error?.message ?? error));
  }
}

function need(condition, message) {
  if (!condition) throw new Error(message);
}

function leavesOf(value, prefix = '') {
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) =>
      leavesOf(inner, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [[prefix, value]];
}

function staticChecks() {
  const sensitiveRandom = generatedSensitive('random');
  const sensitiveAccepted = generatedSensitive('accepted');
  const sensitivePublic = generatedSensitive('public');
  const fixturesList = Object.values(fixtures);

  staticCheck('module exports: scenarios and fixtures line up', () => {
    need(
      Array.isArray(scenarios) && scenarios.length >= 8,
      `need at least 8 scenarios, have ${scenarios.length}`
    );
    const ids = scenarios.map(s => s.id);
    need(new Set(ids).size === ids.length, 'scenario ids are not unique');
    need(
      ids.length === Object.keys(fixtures).length && ids.every(id => fixtures[id]),
      'fixtures do not match the scenarios'
    );
    return `${scenarios.length} scenarios`;
  });

  staticCheck('coverage: variants A, B, C and every required checkout row', () => {
    const variants = new Set(scenarios.map(s => s.variant));
    need(
      ['A', 'B', 'C'].every(v => variants.has(v)),
      `variants present: ${[...variants]}`
    );
    const flows = new Set(fixturesList.map(f => f.flow));
    need(
      REQUIRED_FLOWS.every(f => flows.has(f)),
      `flows present: ${[...flows]}`
    );
    const has = (variant, flow) => fixturesList.some(f => f.variant === variant && f.flow === flow);
    need(has('A', 'order'), 'missing the authorized test checkout on A');
    need(has('A', 'refusal'), 'missing the commit-gate refusal on A');
    need(has('B', 'order'), 'missing the multi-step SPA checkout on B');
    need(has('C', 'order'), 'missing Buy now with the confirm dialog on C');
    need(has('A', 'approved'), 'missing approval then resume');
    need(has('A', 'cancel'), 'missing cancellation mid-run');
    return `variants ${[...variants].sort().join('')}, flows ${[...flows].sort().join(',')}`;
  });

  for (const scenario of scenarios) {
    staticCheck(`shape v1: ${scenario.id}`, () => {
      need(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(scenario.id), 'id is not kebab-case');
      need(scenario.family === 'checkout', 'family is not checkout');
      need(['A', 'B', 'C'].includes(scenario.variant), 'variant is not A, B or C');
      need(scenario.kind === 'live', 'kind is not live');
      need(typeof scenario.title === 'string' && scenario.title.length > 10, 'title missing');
      need(typeof scenario.goal === 'string' && scenario.goal.length > 40, 'goal missing');
      need(typeof scenario.expect === 'function', 'expect is not a function');
      need(
        ['completed', 'awaiting_approval', 'cancelled'].includes(scenario.expectStatus),
        `unexpected expectStatus ${scenario.expectStatus}`
      );
      need(
        !('inject' in scenario) && !('faults' in scenario),
        'a live scenario carries fault fields'
      );
      need(
        typeof scenario.inputs === 'function',
        'inputs must be a function of the sensitive values'
      );
      need(Array.isArray(scenario.authorization?.effects), 'authorization.effects missing');
      const known = [
        'id',
        'family',
        'variant',
        'kind',
        'title',
        'goal',
        'inputs',
        'inputDeclarations',
        'authorization',
        'initial',
        'faults',
        'run',
        'resume',
        'inject',
        'expectStatus',
        'expect',
      ];
      const stray = Object.keys(scenario).filter(key => !known.includes(key));
      need(stray.length === 0, `fields outside shape v1: ${stray}`);
      if (scenario.run?.cancelAfterMs !== undefined) {
        need(
          scenario.expectStatus === 'cancelled',
          'cancelAfterMs without a cancelled expectation'
        );
      }
      for (const entry of scenario.resume ?? []) {
        need(['needs_input', 'awaiting_approval'].includes(entry.on), `bad resume.on ${entry.on}`);
        need(entry.resolution?.kind === 'approval', 'only approval resolutions are used here');
        need(
          entry.resolution.resolution?.decision === 'approve' &&
            !('nonce' in entry.resolution.resolution),
          'the resolution must carry only the decision (the runner binds the identity fields)'
        );
      }
    });

    staticCheck(`goal rules: ${scenario.id}`, () => {
      for (const [pattern, what] of GOAL_FORBIDDEN) {
        need(!pattern.test(scenario.goal), `the goal contains ${what}`);
      }
      const lower = scenario.goal.toLowerCase();
      const label = UI_LABELS.find(l => lower.includes(l));
      need(!label, `the goal quotes a UI label: ${label}`);
      const sample = JSON.stringify(scenario.inputs(sensitiveRandom)).replace(
        /@example\.test/g,
        ''
      );
      for (const [pattern, what] of GOAL_FORBIDDEN.slice(0, 3)) {
        need(!pattern.test(sample), `the inputs contain ${what}`);
      }
    });

    staticCheck(`inputs and declarations: ${scenario.id}`, () => {
      const fixture = fixtures[scenario.id];
      for (const sensitive of [sensitiveRandom, sensitiveAccepted]) {
        const inputs = scenario.inputs(sensitive);
        const declarations = scenario.inputDeclarations(sensitive);
        need(JSON.stringify(inputs) !== undefined, 'inputs are not JSON');
        need(
          !JSON.stringify(inputs).match(/__proto__|"constructor"|"prototype"/),
          'inputs carry an unsafe key'
        );
        const leaves = new Map(leavesOf(inputs));
        for (const d of declarations) {
          need(leaves.has(d.path), `declaration ${d.path} points at no leaf`);
          need(
            typeof d.description === 'string' && d.description.length <= 120,
            `bad description ${d.path}`
          );
          need(!/[\n\r]/.test(d.description), 'description spans lines');
        }
        const sensitivePaths = new Set(declarations.filter(d => d.sensitive).map(d => d.path));
        for (const [leafPath] of leaves) {
          const secretLike = /(^|\.)(cardNumber|cardName|cvc|expiry|password)$/.test(leafPath);
          need(
            !secretLike || sensitivePaths.has(leafPath),
            `${leafPath} must be declared sensitive`
          );
        }
        if (fixture.payment === 'none') {
          need(
            leaves.size === 0 && declarations.length === 0,
            'a no-payment scenario carries inputs'
          );
        } else {
          need(
            ['payment.cardNumber', 'payment.cardName', 'payment.cvc'].every(p =>
              sensitivePaths.has(p)
            ),
            'card leaves are not all sensitive'
          );
        }
      }
    });

    staticCheck(`authorization matches the flow: ${scenario.id}`, () => {
      const fixture = fixtures[scenario.id];
      const effects = scenario.authorization.effects;
      if (fixture.flow === 'refusal' || fixture.flow === 'approved') {
        need(effects.length === 0, `a ${fixture.flow} scenario must grant nothing`);
        need(
          scenario.expectStatus ===
            (fixture.flow === 'refusal' ? 'awaiting_approval' : 'completed'),
          'wrong status'
        );
      } else {
        need(effects.includes('purchase'), 'an authorized scenario must grant purchase');
      }
      if (fixture.flow === 'approved') {
        need(
          scenario.resume?.length === 1 && scenario.resume[0].on === 'awaiting_approval',
          'no approval resume'
        );
      } else {
        need(!scenario.resume, 'only the approval scenario resumes');
      }
    });
  }

  staticCheck('variety: every goal is different and no two scenarios share person and cart', () => {
    const goals = scenarios.map(s => s.goal.toLowerCase().replace(/\s+/g, ' '));
    need(new Set(goals).size === goals.length, 'two scenarios carry the same goal');
    const seen = new Map();
    for (const scenario of scenarios) {
      const fixture = fixtures[scenario.id];
      if (!fixture.person) continue;
      const key = `${fixture.person.email}|${JSON.stringify(fixture.cart)}|${fixture.method}`;
      need(
        !seen.has(key),
        `${scenario.id} repeats the person, cart and delivery of ${seen.get(key)}`
      );
      seen.set(key, scenario.id);
    }
    const people = new Set(fixturesList.filter(f => f.person).map(f => f.person.email));
    need(people.size >= 6, `only ${people.size} different people across the scenarios`);
    const methods = new Set(fixturesList.map(f => f.method));
    need(methods.has('standard') && methods.has('express'), 'both delivery speeds must be used');
    const carts = new Set(fixturesList.map(f => JSON.stringify(f.cart)));
    need(carts.size >= 4, `only ${carts.size} different carts across the scenarios`);
    return `${goals.length} goals, ${people.size} people, ${carts.size} carts`;
  });

  staticCheck(
    'run-time card values: accepted number typed verbatim, otherwise the public test card',
    () => {
      const scenario = scenarios.find(s => s.id === 'checkout-a-authorized-test-checkout');
      const accepted = scenario.inputs(sensitiveAccepted).payment;
      need(
        accepted.cardNumber === sensitiveAccepted.cardNumber,
        'an accepted generated card was changed'
      );
      const fallback = scenario.inputs(sensitiveRandom).payment;
      need(
        fallback.cardNumber.replace(/\D/g, '') === '4242'.repeat(4),
        'a generated card the app rejects was not replaced by the public Visa test number'
      );
      need(
        /^\d{3}$/.test(fallback.cvc) && /^(0[1-9]|1[0-2])\/(2[7-9]|3[0-4])$/.test(fallback.expiry),
        'bad cvc or expiry'
      );
      const again = scenario.inputs(sensitiveRandom).payment;
      need(
        JSON.stringify(again) === JSON.stringify(fallback),
        'derived values are not deterministic per run'
      );
      const other = scenario.inputs({ ...sensitiveRandom, cvc: '808' }).payment;
      need(other.cvc === '808', 'a generated security code was ignored');
      const given = scenario.inputs(sensitivePublic).payment;
      need(
        given.cardNumber === sensitivePublic.cardNumberSpaced &&
          given.cvc === sensitivePublic.cvc &&
          given.expiry === sensitivePublic.cardExpiry,
        'a generated card number, security code or expiry was not used as given'
      );
      const wizard = scenarios.find(s => s.id === 'checkout-b-multistep-spa');
      const split = wizard.inputs(sensitivePublic).payment;
      need(
        split.expiryMonth === sensitivePublic.cardExpiry.slice(0, 2) &&
          split.expiryYear === `20${sensitivePublic.cardExpiry.slice(3)}`,
        'the split expiry of the multi-step form does not follow the generated expiry'
      );
    }
  );

  staticCheck('the literal scan flags a planted card number, key name and environment read', () => {
    const planted = {
      long: `const a = '${'4'.repeat(16)}';`,
      grouped: `const a = '${['4242', '4242', '4242', '4242'].join(' ')}';`,
      hyphen: `const a = '${['4242', '4242', '4242', '4242'].join('-')}';`,
      key: `const a = process.env.${KEY_NAME};`,
      env: 'const a = process.env.HOME;',
    };
    need(literalProblems(planted.long, { allowEnv: true }).length > 0, 'a long digit run passes');
    need(
      literalProblems(planted.grouped, { allowEnv: true }).length > 0,
      'a grouped number passes'
    );
    need(
      literalProblems(planted.hyphen, { allowEnv: true }).length > 0,
      'a hyphenated number passes'
    );
    need(literalProblems(planted.key, { allowEnv: true }).length > 0, 'the key name passes');
    need(literalProblems(planted.env, { allowEnv: false }).length > 0, 'an env read passes');
    need(
      literalProblems("const a = ['4242'].join('');", { allowEnv: false }).length === 0,
      'a clean line is flagged'
    );
  });

  staticCheck('no sensitive literal, key name or environment read in the scenario file', () => {
    const problems = literalProblems(fs.readFileSync(path.join(HERE, 'checkout.mjs'), 'utf8'), {
      allowEnv: false,
    });
    need(problems.length === 0, `checkout.mjs: ${problems}`);
  });

  staticCheck('no sensitive literal or key name in the controls file', () => {
    const problems = literalProblems(
      fs.readFileSync(path.join(HERE, 'checkout.controls.mjs'), 'utf8'),
      { allowEnv: true }
    );
    need(problems.length === 0, `checkout.controls.mjs: ${problems}`);
  });
}

function literalProblems(source, { allowEnv }) {
  const problems = [];
  if (/\d{13,19}/.test(source)) problems.push('a long digit run');
  if (/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/.test(source)) problems.push('a grouped card number');
  if (source.includes(KEY_NAME)) problems.push('the API key variable name');
  if (!allowEnv && /process\.env/.test(source)) problems.push('an environment read');
  return problems;
}

async function harnessValidator() {
  const file = path.join(HERE, '..', 'harness', 'scenario.mjs');
  if (!fs.existsSync(file)) {
    console.log('INFO harness scenario.mjs not present; only the local shape and goal checks ran');
    return;
  }
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    report('harness scenario.mjs loads', false, clean(error?.message ?? error));
    return;
  }
  if (typeof module.validateScenario !== 'function') {
    report('harness scenario.mjs exports validateScenario', false, 'missing export');
    return;
  }
  const sample = generatedSensitive('public');
  for (const scenario of scenarios) {
    staticCheck(`harness validateScenario accepts ${scenario.id}`, () => {
      const verdict = module.validateScenario(scenario);
      need(verdict?.ok === true, `rejected: ${JSON.stringify(verdict?.errors)}`);
    });
    if (typeof module.findTextProblems !== 'function') continue;
    staticCheck(`harness text rules find no hint in ${scenario.id}`, () => {
      const goal = module.findTextProblems(scenario.goal, 'goal');
      need(goal.length === 0, `the goal: ${goal.map(p => p.code)}`);
      const inputs = scenario.inputs(sample);
      for (const [leaf, value] of leavesOf(inputs)) {
        const problems = typeof value === 'string' ? module.findTextProblems(value, 'input') : [];
        need(problems.length === 0, `input ${leaf}: ${problems.map(p => p.code)}`);
      }
      for (const declaration of scenario.inputDeclarations(sample)) {
        const problems = module.findTextProblems(declaration.description, 'library');
        need(
          problems.length === 0,
          `declaration ${declaration.path}: ${problems.map(p => p.code)}`
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

const clean = message => maskDigits(String(message).split('\n')[0]).slice(0, 220);

// A rejection message is printed and may be stored by the harness: it must never carry the card number
// (whatever the grouping) or another long generated secret. Three digit codes are too ambiguous to scan.
function messageLeak(message, env) {
  const pay = env.inputs.payment ?? {};
  const strings = [
    env.sensitive.password,
    env.sensitive.newPassword,
    env.sensitive.apiToken,
    pay.cardNumber,
  ].filter(value => typeof value === 'string' && value.length >= 8);
  const hit = strings.find(value => message.includes(value));
  if (hit) return 'a sensitive test value';
  const digits = digitsOf(pay.cardNumber);
  if (digits.length >= 12 && digitsOf(message).includes(digits)) return 'the card number';
  return '';
}

async function evaluateCase(env, scenario, spec, evaluation) {
  const label = `${scenario.id} :: ${spec.name} :: ${evaluation.name}`;
  let error;
  let late;
  if (evaluation.prepare) {
    try {
      await evaluation.prepare(env);
    } catch (caught) {
      return { label, ok: false, detail: `prepare failed: ${clean(caught.message)}` };
    }
  }
  try {
    const result = evaluation.make(env);
    const app = evaluation.app ? evaluation.app(env) : env.app;
    const ctx = {
      calls: [],
      trace: [],
      evidenceDir: path.join(os.tmpdir(), 'checkout-controls-unused'),
      sensitive: env.sensitive,
      ...(spec.ctx ? spec.ctx(env) : {}),
      ...(evaluation.ctx ? evaluation.ctx(env) : {}),
    };
    if (evaluation.during)
      late = evaluation
        .during(env)
        .catch(e => console.log('LATE ERR', String(e.message).slice(0, 200)));
    await scenario.expect(app, result, env.page, ctx);
  } catch (caught) {
    error = caught;
  }
  if (late) await late;
  if (evaluation.expect === 'pass') {
    return error
      ? { label, ok: false, detail: `expected a pass, got: ${clean(error.message)}` }
      : { label, ok: true, detail: 'expect() accepted it' };
  }
  if (!error)
    return { label, ok: false, detail: 'expect() accepted a state that must be rejected' };
  const message = String(error.message);
  const wanted =
    typeof evaluation.failsWith === 'function' ? evaluation.failsWith(env) : evaluation.failsWith;
  const hygiene = messageLeak(message, env);
  if (hygiene) return { label, ok: false, detail: `the failure message leaks ${hygiene}` };
  const ok = wanted.test(message);
  return {
    label,
    ok,
    detail: ok
      ? `rejected: ${clean(message)}`
      : `rejected for the wrong reason (wanted ${wanted}): ${clean(message)}`,
  };
}

// The engine is the thing every control relies on, so it is proven first against stand-in scenarios
// whose expect() accepts everything or rejects with a chosen tag (no browser involved).
async function engineChecks() {
  const sensitive = generatedSensitive('public');
  const env = {
    app: null,
    page: null,
    inputs: { payment: { cardNumber: sensitive.cardNumberSpaced } },
    sensitive,
  };
  const accepts = { expect: async () => undefined };
  const rejects = text => ({
    expect: async () => {
      throw new Error(text);
    },
  });
  const verdict = (scenario, evaluation) =>
    evaluateCase(
      env,
      scenario,
      { name: 'engine' },
      { name: 'engine control', make: () => ({}), ...evaluation }
    );
  const cases = [
    [
      'a fail control is FAIL when expect() accepts the state',
      accepts,
      { expect: 'fail', failsWith: /./ },
      false,
    ],
    [
      'a pass control is FAIL when expect() rejects',
      rejects('[backend] no'),
      { expect: 'pass' },
      false,
    ],
    ['a pass control passes when expect() accepts', accepts, { expect: 'pass' }, true],
    [
      'a fail control passes on the intended source tag',
      rejects('[backend] no'),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      true,
    ],
    [
      'a fail control is FAIL on another source tag',
      rejects('[ui] no'),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      false,
    ],
    [
      'a fail control is FAIL on an untagged crash',
      rejects("Cannot read properties of undefined (reading 'x')"),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      false,
    ],
    [
      'a fail control resolves a function failsWith',
      rejects('[ui] x'),
      { expect: 'fail', failsWith: () => /^\[ui\]/ },
      true,
    ],
    [
      'a rejection message holding the spaced card number is FAIL',
      rejects(`[backend] got ${sensitive.cardNumberSpaced}`),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      false,
    ],
    [
      'a rejection message holding the bare card number is FAIL',
      rejects(`[backend] got ${digitsOf(sensitive.cardNumber)}`),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      false,
    ],
    [
      'a rejection message holding the hyphenated card number is FAIL',
      rejects(`[backend] got ${dashed(digitsOf(sensitive.cardNumber))}`),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      false,
    ],
    [
      'a rejection message holding the generated password is FAIL',
      rejects(`[backend] got ${sensitive.password}`),
      { expect: 'fail', failsWith: /^\[backend\]/ },
      false,
    ],
    [
      'a failing prepare step is FAIL',
      accepts,
      {
        expect: 'pass',
        prepare: async () => {
          throw new Error('boom');
        },
      },
      false,
    ],
  ];
  for (const [name, scenario, evaluation, ok] of cases) {
    const outcome = await verdict(scenario, evaluation);
    report(`engine: ${name}`, outcome.ok === ok, outcome.detail);
  }
  let flag = false;
  await verdict(accepts, {
    expect: 'pass',
    during: () =>
      sleep(40).then(() => {
        flag = true;
      }),
  });
  report('engine: late work started with a case is awaited before the verdict', flag === true);
  let seen;
  await verdict(
    {
      expect: async (_app, _result, _page, ctx) => {
        seen = ctx;
      },
    },
    { expect: 'pass', ctx: () => ({ pauses: ['x'] }) }
  );
  report(
    'engine: the case context reaches expect() next to the sensitive values',
    seen?.pauses?.[0] === 'x' && seen?.sensitive === sensitive && Array.isArray(seen?.calls)
  );
}

const open = { apps: 0, contexts: 0 };

async function stopsServing(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch {
    return true;
  }
}

async function driveAndJudge(env, scenario, spec) {
  const out = [];
  let driverError;
  try {
    await spec.drive(env);
  } catch (error) {
    driverError = error;
  }
  for (const evaluation of spec.cases) {
    if (driverError) {
      out.push({
        label: `${scenario.id} :: ${spec.name} :: ${evaluation.name}`,
        ok: false,
        detail: `scripted driver failed: ${clean(driverError.message)}`,
      });
    } else {
      out.push(await evaluateCase(env, scenario, spec, evaluation));
    }
  }
  return out;
}

async function runState(browser, scenario, spec, sensitive) {
  const app = await startApp({
    variant: scenario.variant,
    initial: scenario.initial ?? {},
    faults: spec.faults ?? {},
  });
  open.apps += 1;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    open.contexts += 1;
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const env = {
        app,
        page,
        scenario,
        fixture: fixtures[scenario.id],
        inputs: scenario.inputs(sensitive),
        sensitive,
      };
      return await driveAndJudge(env, scenario, spec);
    } finally {
      try {
        await context.close();
      } finally {
        open.contexts -= 1;
      }
    }
  } finally {
    try {
      await app.close();
    } finally {
      if (await stopsServing(app.url)) open.apps -= 1;
    }
  }
}

// A crash inside one state becomes failing verdicts for its cases; it never aborts the other states.
async function judgeState(browser, scenario, spec, sensitive) {
  try {
    return await runState(browser, scenario, spec, sensitive);
  } catch (error) {
    return spec.cases.map(evaluation => ({
      label: `${scenario.id} :: ${spec.name} :: ${evaluation.name}`,
      ok: false,
      detail: `the state crashed: ${clean(error?.message ?? error)}`,
    }));
  }
}

function stubBrowser({ failContext = false, failClose = false } = {}) {
  return {
    newContext: async () => {
      if (failContext) throw new Error('no context');
      return {
        newPage: async () => ({ setDefaultTimeout: () => undefined }),
        close: async () => {
          if (failClose) throw new Error('close failed');
        },
      };
    },
  };
}

// The runner around the controls: a failing driver, a failing context and a failing close must all
// show up as failed controls and must still release the app server and the browser context.
async function runnerChecks() {
  const scenario = scenarios[0];
  const sensitive = generatedSensitive('public');
  const control = { name: 'probe', expect: 'pass', make: () => ({}) };
  const probe = (browser, drive) =>
    judgeState(browser, scenario, { name: 'runner', drive, cases: [control, control] }, sensitive);
  const before = { ...open };
  const throwing = await probe(stubBrowser(), async () => {
    throw new Error('driver exploded');
  });
  report(
    'runner: a failing scripted driver fails every control of its state',
    throwing.length === 2 && throwing.every(o => !o.ok && /scripted driver failed/.test(o.detail)),
    throwing.map(o => o.detail).join(' | ')
  );
  const noContext = await probe(stubBrowser({ failContext: true }), async () => undefined);
  report(
    'runner: a browser that cannot open a context fails the controls instead of crashing',
    noContext.length === 2 && noContext.every(o => !o.ok && /the state crashed/.test(o.detail)),
    noContext.map(o => o.detail).join(' | ')
  );
  const badClose = await probe(stubBrowser({ failClose: true }), async () => undefined);
  report(
    'runner: a context that cannot close fails the controls instead of crashing',
    badClose.length === 2 && badClose.every(o => !o.ok && /the state crashed/.test(o.detail)),
    badClose.map(o => o.detail).join(' | ')
  );
  report(
    'runner: every app server and context opened by those states was closed again',
    open.apps === before.apps && open.contexts === before.contexts,
    `apps ${open.apps - before.apps}, contexts ${open.contexts - before.contexts} still open`
  );
}

const CHILD_ENV = 'CHECKOUT_CONTROLS_CHILD';

// The process exit code is what a script or CI reads, so it is proven through real child processes:
// one run with a deliberately failing check must exit 1, one run without any must exit 0.
function exitCodeChecks() {
  if (process.env[CHILD_ENV] === '1') return;
  const file = fileURLToPath(import.meta.url);
  const run = args =>
    spawnSync(process.execPath, [file, ...args], {
      encoding: 'utf8',
      env: { ...process.env, [CHILD_ENV]: '1' },
      timeout: 170000,
    });
  const failing = run(['none', '--canary']);
  report(
    'exit code: a run with one failing check exits 1 and prints FAIL for it',
    failing.status === 1 &&
      /^FAIL canary/m.test(failing.stdout) &&
      /failed=1\b/.test(failing.stdout),
    `status ${failing.status}`
  );
  const passing = run(['none']);
  report(
    'exit code: a run without a failing check exits 0',
    passing.status === 0 && /failed=0\b/.test(passing.stdout) && !/^FAIL/m.test(passing.stdout),
    `status ${passing.status}`
  );
}

async function pool(items, limit, work) {
  const queue = items.map((item, index) => ({ item, index }));
  const done = new Array(items.length);
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      done[next.index] = await work(next.item);
    }
  });
  await Promise.all(workers);
  return done;
}

export async function runControls({ only, canary = false } = {}) {
  results.length = 0;
  staticChecks();
  await harnessValidator();
  await engineChecks();
  await runnerChecks();
  if (canary) report('canary: a deliberately failing check', false, 'expected');
  exitCodeChecks();
  const jobs = [];
  const harness = await harnessSensitive();
  console.log(`INFO sensitive values for the controls come from: ${harness.source}`);
  const sensitiveDefault = harness.values;
  for (const scenario of scenarios) {
    if (only && !only.includes(scenario.id)) continue;
    for (const spec of statesFor(scenario))
      jobs.push({ scenario, spec, sensitive: sensitiveDefault });
  }
  const extra = scenarios.find(s => s.id === 'checkout-a-authorized-test-checkout');
  const alternatives = [
    ['a generated card the app accepts but is not the Visa test number', 'accepted'],
    ['a generated card the app rejects (replaced by the public test number)', 'random'],
  ];
  if (extra && (!only || only.includes(extra.id))) {
    for (const [label, kind] of alternatives) {
      jobs.push({
        scenario: extra,
        sensitive: generatedSensitive(kind),
        spec: {
          name: `achieved end state with ${label}`,
          drive: env => drive(env),
          cases: [
            {
              name: 'right result, card last four from the typed number',
              expect: 'pass',
              make: claimsCompleted,
            },
            {
              name: 'wrong last four expected for the other card',
              expect: 'fail',
              failsWith: /^\[backend\] cardLast4 differs/,
              make: claimsCompleted,
              ctx: () => ({
                sensitive: generatedSensitive(kind === 'accepted' ? 'random' : 'accepted'),
              }),
            },
          ],
        },
      });
    }
  }
  const savedCard = scenarios.find(s => s.id === 'checkout-c-buy-now-two-lines-unused-card');
  const multiStep = scenarios.find(s => s.id === 'checkout-b-multistep-spa');
  const typedNumber = digitsOf(generatedSensitive('accepted').cardNumber);
  if (savedCard && (!only || only.includes(savedCard.id))) {
    jobs.push({
      scenario: savedCard,
      sensitive: generatedSensitive('accepted'),
      spec: {
        name: 'achieved end state with a card number that differs from the saved card',
        drive: env => drive(env),
        cases: [
          {
            name: 'right result: the order carries the saved card, not the supplied one',
            expect: 'pass',
            make: claimsCompleted,
          },
          mutation(
            'the order carries the supplied card instead of the saved one',
            /^\[backend\] cardLast4 differs/,
            onOrder(o => {
              o.cardLast4 = typedNumber.slice(-4);
            })
          ),
        ],
      },
    });
  }
  if (multiStep && (!only || only.includes(multiStep.id))) {
    jobs.push({
      scenario: multiStep,
      sensitive: generatedSensitive('accepted'),
      spec: {
        name: 'achieved end state with a second accepted card number',
        drive: env => drive(env),
        cases: [
          {
            name: 'right result, card last four from the typed number',
            expect: 'pass',
            make: claimsCompleted,
          },
          mutation(
            'the order carries the other test card',
            /^\[backend\] cardLast4 differs/,
            onOrder(o => {
              o.cardLast4 = '4242';
            })
          ),
        ],
      },
    });
  }
  const browser = jobs.length > 0 ? await launchBrowser() : undefined;
  let outcomes = [];
  try {
    if (browser) {
      outcomes = await pool(jobs, POOL, job =>
        judgeState(browser, job.scenario, job.spec, job.sensitive)
      );
      report(
        'cleanup: every scenario context and app server opened by the controls is closed',
        open.apps === 0 && open.contexts === 0 && browser.contexts().length === 0,
        `apps ${open.apps}, contexts ${open.contexts}, browser contexts ${browser.contexts().length}`
      );
    }
  } finally {
    await browser?.close();
  }
  const planned = jobs.reduce((sum, job) => sum + job.spec.cases.length, 0);
  report(
    'coverage: every planned control produced a verdict',
    outcomes.flat().length === planned,
    `${outcomes.flat().length} verdicts for ${planned} planned controls`
  );
  let controls = 0;
  for (const outcome of outcomes.flat()) {
    controls += 1;
    report(`control ${outcome.label}`, outcome.ok, outcome.detail);
  }
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(
    `TOTAL checks=${results.length} passed=${passed} failed=${failed} (static=${results.length - controls}, controls=${controls}, scenarios=${scenarios.length}, states=${jobs.length})`
  );
  return { total: results.length, passed, failed, controls, states: jobs.length };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const only = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
  runControls({
    only: only.length > 0 ? only : undefined,
    canary: process.argv.includes('--canary'),
  })
    .then(({ failed }) => {
      process.exitCode = failed === 0 ? 0 : 1;
      // A leaked server or browser must not hang a script: end the process with the verdict reached so far.
      setTimeout(() => process.exit(process.exitCode ?? 1), 10000).unref();
    })
    .catch(error => {
      console.log(`FAIL controls crashed: ${clean(error?.message ?? error)}`);
      process.exitCode = 1;
    });
}
