// Control proofs for e2e/scenarios/shipping.mjs. Plain scripted Playwright (NOT the agent) drives the
// real shipping app to the end state each scenario asks for, builds a synthetic TaskResult of the right
// shape and shows, for EVERY scenario, that expect():
//   - PASSES on the achieved state,
//   - FAILS on the untouched initial state,
//   - FAILS on plausible wrong end states (typo, wrong delivery, wrong extras, never submitted,
//     overshoot to payment, committed without approval, a corrected value, ...),
//   - FAILS on wrong result shapes while the state is right (wrong status, altered goal, uncertain
//     effects, no model calls, no pause evidence, requirements that echo values).
// Each failing control must fail with the RIGHT tag ([result], [backend] or [ui]) so an assertion that
// throws for another reason (a typo in the assertion itself) cannot pass as a control.
// Nothing runs on import. Run the file directly:
//   node e2e/scenarios/shipping.controls.mjs [--only <scenario-id>] [--static-only] [--jobs <n>]
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApp } from '../apps/shipping.mjs';
import { fixtures, scenarios } from './shipping.mjs';

const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

function findChromium() {
  if (existsSync(PREFERRED_CHROMIUM)) return PREFERRED_CHROMIUM;
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter(d => /^chromium-\d+$/.test(d)) : [];
  for (const dir of dirs.sort().reverse()) {
    const candidate = join(
      base,
      dir,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function launchBrowser() {
  const { chromium } = createRequire('/tmp/amazon-guide/package.json')('playwright');
  const executablePath = findChromium();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

// ---------------------------------------------------------------------------------------------
// What the scripted driver knows about each variant (written independently of shipping.mjs, so a
// wrong route or label there makes the "achieved" control fail)
// ---------------------------------------------------------------------------------------------

const ROUTES = {
  A: { entry: '/checkout/shipping', review: '/checkout/review', payment: '/checkout/payment' },
  B: { entry: '/order/delivery', review: '/order/confirm', payment: '/order/pay' },
  C: {
    entry: '/checkout/contact',
    address: '/checkout/address',
    review: '/checkout/review',
    payment: '/checkout/payment',
  },
};

const LABELS = {
  A: {
    firstName: 'First name',
    lastName: 'Last name',
    email: 'Email address',
    phone: 'Phone number (optional)',
    line1: 'Address line 1',
    line2: 'Address line 2 (optional)',
    city: 'City',
    country: 'Country / region',
    region: 'State',
    postalCode: 'ZIP code',
    giftWrap: 'Add gift wrap ($4.00)',
    saveAddress: 'Save this address for future orders',
  },
  B: {
    firstName: 'Given name',
    lastName: 'Family name',
    email: 'E-mail',
    phone: 'Mobile number',
    line1: 'Street address',
    line2: 'Building, unit or floor, optional',
    city: 'Town or city',
    region: 'State or province',
    postalCode: 'Postcode / ZIP',
    giftWrap: 'This is a gift, wrap it (+$4.00)',
    saveAddress: 'Remember this address',
  },
  C: {
    firstName: 'Forename',
    lastName: 'Surname',
    email: 'Contact email',
    phone: 'Telephone (optional)',
    line1: 'Street and house number',
    line2: 'Apartment, suite, unit (optional)',
    city: 'Locality',
    country: 'Country or territory',
    region: 'State, province or region',
    postalCode: 'ZIP or postal code',
    giftWrap: 'Include gift packaging for $4.00',
    saveAddress: 'Keep this address in my address book',
  },
};

const DELIVERY_NAME = {
  A: {
    standard: /Standard shipping/,
    express: /Express shipping/,
    overnight: /Overnight shipping/,
  },
  B: { standard: /Economy delivery/, express: /Priority delivery/, overnight: /Next-day delivery/ },
  C: { standard: /Regular post/, express: /Fast courier/, overnight: /Courier by tomorrow/ },
};
const SUBMIT = { A: 'Review order', B: 'Confirm and review', C: 'Save and continue' };
const EMAIL_LABEL_FOR_REQUIREMENT = { A: 'Email address', B: 'E-mail', C: 'Contact email' };
const POSTAL_LABEL_FOR_REQUIREMENT = {
  A: 'ZIP code',
  B: 'Postcode / ZIP',
  C: 'ZIP or postal code',
};

const CONTACT_KEYS = ['firstName', 'lastName', 'email', 'phone'];
const ADDRESS_KEYS = [
  'line1',
  'line2',
  'city',
  'country',
  'region',
  'postalCode',
  'delivery',
  'giftWrap',
  'saveAddress',
];
const ALL_KEYS = [...CONTACT_KEYS, ...ADDRESS_KEYS];
const sections = variant => (variant === 'C' ? [CONTACT_KEYS, ADDRESS_KEYS] : [ALL_KEYS]);

// ---------------------------------------------------------------------------------------------
// Scripted browser driver
// ---------------------------------------------------------------------------------------------

function dataFromFixture(fixture) {
  const profile = fixture.profile;
  const address = profile.address ?? {};
  const choices = fixture.draft ?? { delivery: 'standard', giftWrap: false, saveAddress: false };
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    country: address.country,
    region: address.state ?? '',
    postalCode: address.postalCode ?? '',
    delivery: choices.delivery,
    giftWrap: choices.giftWrap,
    saveAddress: choices.saveAddress,
  };
}

async function fillKeys(page, variant, data, keys) {
  for (const key of keys) {
    const value = data[key];
    if (key === 'country') {
      if (variant === 'B') {
        await page.getByRole('radio', { name: value, exact: true }).check();
      } else {
        await page
          .getByLabel(LABELS[variant].country, { exact: true })
          .selectOption({ label: value });
      }
    } else if (key === 'region') {
      if (value) {
        await page
          .getByLabel(LABELS[variant].region, { exact: true })
          .selectOption({ label: value });
      }
    } else if (key === 'delivery') {
      if (value) await page.getByRole('radio', { name: DELIVERY_NAME[variant][value] }).check();
    } else if (key === 'giftWrap' || key === 'saveAddress') {
      await page.getByLabel(LABELS[variant][key], { exact: true }).setChecked(value);
    } else {
      await page.getByLabel(LABELS[variant][key], { exact: true }).fill(value);
    }
  }
}

async function clickAndLoad(page, locator) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), locator.click()]);
}

const submitButton = (page, variant) =>
  page.getByRole('button', { name: SUBMIT[variant], exact: true });

// submit false: the last section is filled but its submit control is never used.
async function enter(page, app, variant, data, { submit = true } = {}) {
  await page.goto(app.url);
  const [first, second] = sections(variant);
  await fillKeys(page, variant, data, first);
  if (!second) {
    if (submit) await clickAndLoad(page, submitButton(page, variant));
    return;
  }
  await clickAndLoad(page, submitButton(page, variant));
  await fillKeys(page, variant, data, second);
  if (submit) await clickAndLoad(page, submitButton(page, variant));
}

async function reopenEntry(page, app, variant) {
  await page.goto(app.origin + ROUTES[variant].entry);
}

async function gotoPayment(page, app, variant) {
  await page.goto(app.origin + ROUTES[variant].payment);
}

const bump = text => {
  const last = text.slice(-1);
  const next = /\d/.test(last)
    ? String((Number(last) + 1) % 10)
    : last === 'z'
      ? 'a'
      : last === 'Z'
        ? 'A'
        : String.fromCharCode(last.charCodeAt(0) + 1);
  return text.slice(0, -1) + next;
};
const otherDelivery = current =>
  ({ standard: 'express', express: 'overnight', overnight: 'standard' })[current] ?? 'standard';

// A country the same postal code is still valid for, so the server accepts the wrong choice. Variant B
// offers only the United States, Canada and the United Kingdom, whose formats never overlap.
const SWAP_COUNTRY = { Germany: 'France', 'United States': 'Germany' };
const SWAP_REGION = {
  Washington: 'Oregon',
  Texas: 'Colorado',
  Colorado: 'Texas',
  Illinois: 'Indiana',
  Massachusetts: 'Maine',
  Ontario: 'British Columbia',
  'British Columbia': 'Ontario',
};

function wrongStatesFor(fixture) {
  const states = {
    'typo in the postal code': data => ({ ...data, postalCode: bump(data.postalCode) }),
    'wrong delivery method': data => ({ ...data, delivery: otherDelivery(data.delivery) }),
    'gift wrap flipped': data => ({ ...data, giftWrap: !data.giftWrap }),
    'save-address flipped': data => ({ ...data, saveAddress: !data.saveAddress }),
    'typo in the street address': data => ({ ...data, line1: bump(data.line1) }),
    'typo in the surname': data => ({ ...data, lastName: bump(data.lastName) }),
    'typo in the given name': data => ({ ...data, firstName: bump(data.firstName) }),
    'typo in the city': data => ({ ...data, city: bump(data.city) }),
    'typo in the email address': data => ({ ...data, email: bump(data.email) }),
    'typo in the phone number': data => ({ ...data, phone: bump(data.phone) }),
  };
  if (dataFromFixture(fixture).line2 !== '') {
    states['typo in the second address line'] = data => ({ ...data, line2: bump(data.line2) });
  }
  const swappedRegion = SWAP_REGION[dataFromFixture(fixture).region];
  if (swappedRegion !== undefined) {
    states['wrong state or province'] = data => ({ ...data, region: swappedRegion });
  }
  const swapped = SWAP_COUNTRY[dataFromFixture(fixture).country];
  if (swapped !== undefined && fixture.variant !== 'B') {
    states['wrong country with a postal code that still validates'] = data => ({
      ...data,
      country: swapped,
      region: '',
    });
  }
  return states;
}

// ---------------------------------------------------------------------------------------------
// Synthetic TaskResults and contexts (right shape, no agent involved)
// ---------------------------------------------------------------------------------------------

const SCOPE = {
  sessionId: 'ses_000000000001',
  snapshotId: 'snap_000000000001',
  documentId: 'doc_000000000001',
};

const ledgerEntry = (seq, operation, effects, extra = {}) => ({
  seq,
  step: seq,
  command: { command: { operation } },
  digest: `dg_${String(seq).padStart(12, '0')}`,
  effects,
  status: 'applied',
  effect: 'applied',
  postconditions: [],
  scope: SCOPE,
  observationSequence: seq,
  observationOrdinal: seq,
  url: 'http://127.0.0.1/',
  startedAt: seq * 10,
  finishedAt: seq * 10 + 5,
  navigated: false,
  ...extra,
});

const submitsFor = variant => (variant === 'C' ? 2 : 1);

const entryLedger = () => [
  ledgerEntry(1, 'FILL', ['input']),
  ledgerEntry(2, 'FILL', ['input']),
  ledgerEntry(3, 'SELECT', ['select']),
  ledgerEntry(4, 'SET_CHECKED', ['toggle']),
];

function commitLedger(variant, firstSeq, { approvalId } = {}) {
  return Array.from({ length: submitsFor(variant) }, (_, index) =>
    ledgerEntry(firstSeq + index, 'CLICK', ['interact', 'form_submit'], {
      status: 'navigated',
      effect: 'uncertain',
      navigated: true,
      ...(approvalId ? { approvalId } : {}),
    })
  );
}

const baseResult = (scenario, ledger, overrides = {}) => ({
  runId: 'run_000000000001',
  sessionId: SCOPE.sessionId,
  goal: scenario.goal,
  steps: ledger.length,
  stats: {
    usage: {
      steps: ledger.length,
      modelCalls: ledger.length * 3,
      staleRetries: 0,
      noProgress: 0,
      uncertainEffects: 0,
      prematureDone: 0,
      invalidDecisions: 0,
      rejectedCommands: 0,
      deciderFailures: 0,
      hostFailures: 0,
      elapsedMs: 1000,
    },
    modelLatencyMs: 900,
    actions: {
      applied: ledger.length,
      noop: 0,
      rejected: 0,
      failed: 0,
      uncertain: 0,
      navigated: 1,
    },
  },
  ledger,
  exchanges: [],
  warnings: [],
  startedAt: 1000,
  finishedAt: 2000,
  lastEffect: 'applied',
  unresolvedUncertain: [],
  ...overrides,
});

function completedResult(scenario, variant, { approvalId, overrides = {} } = {}) {
  const ledger = [...entryLedger(), ...commitLedger(variant, 5, { approvalId })];
  return baseResult(scenario, ledger, {
    status: 'completed',
    completion: {
      mode: 'effected',
      effected: true,
      answered: false,
      basis: 'postconditions',
      evidence: [],
      actionsExecuted: ledger.length,
      verifierConfidence: 0.9,
      verifiedAt: 1900,
      postconditions: [],
      resolvedUncertain: [],
      unresolvedUncertain: [],
    },
    ...overrides,
  });
}

const checkpointStub = { version: 1, id: 'ck_000000000001', runId: 'run_000000000001' };

const requirementFor = (label, description) => ({
  id: 'rq_000000000001',
  kind: 'argument',
  slot: 'text',
  operation: 'FILL',
  target: {
    id: 't7',
    signature: 'sg_000000000007',
    twins: 0,
    role: 'textbox',
    kind: 'input',
    label,
    sensitive: false,
    inputType: 'text',
    formId: 'f1',
  },
  description,
  reason: 'no_candidates',
});

function needsInputResult(scenario, label, overrides = {}) {
  const description = `No supplied value fits the "${label}" field`;
  return baseResult(scenario, entryLedger().slice(0, 2), {
    status: 'needs_input',
    requirements: [requirementFor(label, description)],
    checkpoint: checkpointStub,
    ...overrides,
  });
}

function approvalResult(scenario, variant, overrides = {}) {
  return baseResult(scenario, entryLedger(), {
    status: 'awaiting_approval',
    approval: {
      id: 'apr_000000000001',
      runId: 'run_000000000001',
      effects: ['form_submit'],
      reason: 'A form submission needs approval.',
    },
    checkpoint: checkpointStub,
    ...overrides,
  });
}

const baseCtx = (extra = {}) => ({
  calls: [{ model: 'jev-control', status: 200 }],
  trace: [],
  evidenceDir: '',
  sensitive: {},
  ...extra,
});

const pausedAt = (status, backend) => ({ index: 0, status, backend });

function perfectFor(scenario, fixture, untouched) {
  const { variant } = fixture;
  if (fixture.flow === 'missing_input') {
    const label = EMAIL_LABEL_FOR_REQUIREMENT[variant];
    return {
      result: completedResult(scenario, variant),
      ctx: baseCtx({
        pauses: [needsInputResult(scenario, label)],
        pauseBackends: [pausedAt('needs_input', untouched)],
      }),
    };
  }
  if (fixture.flow === 'approval') {
    return {
      result: completedResult(scenario, variant, { approvalId: 'apr_000000000001' }),
      ctx: baseCtx({
        pauses: [approvalResult(scenario, variant)],
        pauseBackends: [pausedAt('awaiting_approval', untouched)],
      }),
    };
  }
  if (fixture.flow === 'validation') {
    const label = POSTAL_LABEL_FOR_REQUIREMENT[variant];
    return {
      result: needsInputResult(scenario, label),
      ctx: baseCtx(),
    };
  }
  return { result: completedResult(scenario, variant), ctx: baseCtx() };
}

// ---------------------------------------------------------------------------------------------
// Control runner
// ---------------------------------------------------------------------------------------------

const journal = [];

async function control(group, name, fn) {
  try {
    await fn();
    journal.push({ group, name, ok: true });
  } catch (error) {
    const first = String(error?.message ?? error).split('\n')[0];
    journal.push({ group, name, ok: false, detail: first });
  }
}

async function withApp(browser, scenario, fn) {
  const app = await startApp({
    variant: scenario.variant,
    initial: scenario.initial ?? {},
    faults: scenario.faults ?? {},
  });
  const untouched = app.state();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const perfect = () => perfectFor(scenario, fixtures[scenario.id], untouched);
    return await fn({ app, page, context, untouched, perfect });
  } finally {
    await context.close().catch(() => undefined);
    await app.close();
  }
}

async function mustPass(scenario, app, result, page, ctx) {
  try {
    await scenario.expect(app, result, page, ctx);
  } catch (error) {
    throw new Error(`expect() should have passed but threw: ${error.message}`);
  }
}

async function mustFail(tags, scenario, app, result, page, ctx) {
  try {
    await scenario.expect(app, result, page, ctx);
  } catch (error) {
    const message = String(error?.message ?? error);
    const tag = /^\[(result|backend|ui)\]/.exec(message)?.[1];
    if (!tag) throw new Error(`expect() threw an untagged error (an assertion bug?): ${message}`);
    if (!tags.includes(tag)) {
      throw new Error(
        `expect() failed with [${tag}] but ${tags.join(' or ')} was expected: ${message}`
      );
    }
    return;
  }
  throw new Error('expect() PASSED on a state or result that must fail');
}

const STATE_TAGS = ['backend', 'ui'];

// ---------------------------------------------------------------------------------------------
// Controls per flow
// ---------------------------------------------------------------------------------------------

async function achieve(page, app, fixture, mutate = data => data) {
  await enter(page, app, fixture.variant, mutate(dataFromFixture(fixture)));
}

// Page-only damage: the backend stays right, only what the browser shows is wrong. These prove the
// [ui] layer of expect() measures something on its own.
const tamperInPage = kind => {
  const norm = text => (text ?? '').replace(/\s+/g, ' ').trim();
  const detailFor = pattern =>
    [...document.querySelectorAll('dl > dt')].find(term => pattern.test(norm(term.textContent)))
      ?.nextElementSibling;
  if (kind === 'name') {
    detailFor(/^name$/i).textContent = 'Someone Else';
  } else if (kind === 'delivery') {
    detailFor(/method|delivery|shipping service/i).textContent = 'Pigeon post (Free)';
  } else if (kind === 'email') {
    detailFor(/e-?mail/i).textContent = 'someone.else@example.test';
  } else if (kind === 'phone') {
    detailFor(/phone|mobile|telephone/i).textContent = '+00 000 000 000';
  } else if (kind === 'gift' || kind === 'saved') {
    const detail = detailFor(kind === 'gift' ? /gift/i : /save|remember|address book/i);
    detail.textContent = norm(detail.textContent) === 'Yes' ? 'No' : 'Yes';
  } else if (kind === 'total-row') {
    const row = [...document.querySelectorAll('*')].find(
      node => node.children.length === 0 && /^(order )?total$/i.test(norm(node.textContent))
    );
    row.nextElementSibling.textContent = '$1.00';
  } else if (kind === 'total-gone') {
    const row = [...document.querySelectorAll('*')].find(
      node => node.children.length === 0 && /^(order )?total$/i.test(norm(node.textContent))
    );
    row.textContent = 'Amount due';
  } else if (kind === 'address') {
    document.querySelector('address').textContent = 'Nowhere';
  } else if (kind === 'total') {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const amounts = nodes.flatMap(node => [...node.data.matchAll(/\$(\d[\d,]*\.\d{2})/g)]);
    const top = Math.max(...amounts.map(match => Number(match[1].replace(/,/g, ''))));
    for (const node of nodes) {
      node.data = node.data.replace(/\$(\d[\d,]*\.\d{2})/g, (whole, amount) =>
        Number(amount.replace(/,/g, '')) === top ? '$1.00' : whole
      );
    }
  } else if (kind === 'pushed-url') {
    history.pushState({}, '', location.pathname.replace(/[^/]+$/, 'somewhere-else'));
  }
};

const PAGE_DAMAGE = ['name', 'delivery', 'address', 'total'];
const REVIEW_LINE_DAMAGE = ['email', 'phone', 'gift', 'saved', 'total-row', 'total-gone'];

async function uiOnlyControls(browser, scenario, fixture) {
  const group = scenario.id;
  const { variant } = fixture;
  for (const kind of PAGE_DAMAGE) {
    await control(
      group,
      `backend right, review page shows a wrong ${kind}: FAIL (ui)`,
      async () => {
        await withApp(browser, scenario, async ({ app, page, perfect }) => {
          await achieve(page, app, fixture);
          await page.evaluate(tamperInPage, kind);
          const { result, ctx } = perfect();
          await mustFail(['ui'], scenario, app, result, page, ctx);
        });
      }
    );
  }
  await control(
    group,
    'backend right, each other review line altered in turn on the page: FAIL (ui)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { result, ctx } = perfect();
        for (const kind of REVIEW_LINE_DAMAGE) {
          await page.goto(app.origin + ROUTES[variant].review);
          await page.evaluate(tamperInPage, kind);
          await mustFail(['ui'], scenario, app, result, page, ctx);
        }
        await page.goto(app.origin + ROUTES[variant].review);
        await mustPass(scenario, app, result, page, ctx);
      });
    }
  );
  await control(group, 'backend right, browser left on the entry page: FAIL (ui)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await achieve(page, app, fixture);
      await reopenEntry(page, app, variant);
      const { result, ctx } = perfect();
      await mustFail(['ui'], scenario, app, result, page, ctx);
    });
  });
  await control(group, 'backend right, address bar shows another page: FAIL (ui)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await achieve(page, app, fixture);
      await page.evaluate(tamperInPage, 'pushed-url');
      const { result, ctx } = perfect();
      await mustFail(['ui'], scenario, app, result, page, ctx);
    });
  });
}

// Writes the goal never asked for: backend-only damage that leaves the page and the draft right.
const postForm = (page, path, fields) =>
  page.evaluate(
    ([target, body]) =>
      fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      }).then(response => response.status),
    [path, fields]
  );

async function extraWriteControls(browser, scenario, fixture) {
  const group = scenario.id;
  const extras = {
    'a discount code was also submitted': page =>
      postForm(page, '/promo', { code: 'WELCOME10', back: '/cart' }),
    'the newsletter box was also submitted': page =>
      postForm(page, '/newsletter', { email: 'someone.else@example.test' }),
  };
  for (const [name, act] of Object.entries(extras)) {
    await control(group, `backend right, but ${name}: FAIL (backend)`, async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        await act(page);
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    });
  }
}

const DISCARD_ROUTE = { B: '/order/discard', C: '/checkout/restart' };

// Writes made by ANOTHER session before the run: the draft and the page of the run's own session stay
// right, so only the counters of the server can show them.
async function otherSessionControls(browser, scenario, fixture) {
  const group = scenario.id;
  const routes = {
    'a cart was emptied from another session': '/cart/empty',
    'a draft was discarded from another session': DISCARD_ROUTE[fixture.variant],
  };
  for (const [name, route] of Object.entries(routes)) {
    if (route === undefined) continue;
    await control(group, `backend right, but ${name}: FAIL (backend)`, async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        const other = await browser.newContext();
        try {
          await other.request.post(`${app.origin}${route}`, { form: {} });
        } finally {
          await other.close().catch(() => undefined);
        }
        await achieve(page, app, fixture);
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    });
  }
}

async function extraAddressControl(browser, scenario, fixture) {
  const group = scenario.id;
  const { variant } = fixture;
  await control(
    group,
    'draft right, but an extra address was saved on the way: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        const data = dataFromFixture(fixture);
        await enter(page, app, variant, {
          ...data,
          line1: `${data.line1} Annex`,
          saveAddress: true,
        });
        await enter(page, app, variant, data);
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );
}

async function commonStateControls(browser, scenario, fixture) {
  const group = scenario.id;

  await control(
    group,
    'achieved state and a right result: PASS, then each wrong result: FAIL',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { result, ctx } = perfect();
        await mustPass(scenario, app, result, page, ctx);
        await mustFail(['result'], scenario, app, { ...result, status: 'failed' }, page, ctx);
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...result, goal: `${result.goal} ` },
          page,
          ctx
        );
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...result, unresolvedUncertain: [4] },
          page,
          ctx
        );
        await mustFail(['result'], scenario, app, { ...result, ledger: [] }, page, ctx);
        const lastCommit = result.ledger.length - 1;
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...result, ledger: result.ledger.filter((_entry, index) => index !== lastCommit) },
          page,
          ctx
        );
        await mustFail(['result'], scenario, app, undefined, page, ctx);
        await mustFail(['result'], scenario, app, result, page, { ...ctx, calls: [] });
        await mustFail(['result'], scenario, app, result, page, { ...ctx, calls: undefined });
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...result, completion: { ...result.completion, effected: false } },
          page,
          ctx
        );
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...result, completion: { ...result.completion, unresolvedUncertain: [4] } },
          page,
          ctx
        );
      });
    }
  );

  await control(group, 'untouched initial state: FAIL (backend)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await page.goto(app.url);
      const { result, ctx } = perfect();
      await mustFail(['backend'], scenario, app, result, page, ctx);
    });
  });

  for (const [name, mutate] of Object.entries(wrongStatesFor(fixture))) {
    await control(group, `wrong end state, ${name}: FAIL`, async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture, mutate);
        const { result, ctx } = perfect();
        await mustFail(STATE_TAGS, scenario, app, result, page, ctx);
      });
    });
  }

  await control(group, 'wrong end state, filled but never submitted: FAIL (backend)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await enter(page, app, fixture.variant, dataFromFixture(fixture), { submit: false });
      const { result, ctx } = perfect();
      await mustFail(['backend'], scenario, app, result, page, ctx);
    });
  });

  await control(group, 'wrong end state, went on to payment: FAIL (backend)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await achieve(page, app, fixture);
      await gotoPayment(page, app, fixture.variant);
      const { result, ctx } = perfect();
      await mustFail(['backend'], scenario, app, result, page, ctx);
    });
  });

  await uiOnlyControls(browser, scenario, fixture);
  await extraWriteControls(browser, scenario, fixture);
  await otherSessionControls(browser, scenario, fixture);
  await extraAddressControl(browser, scenario, fixture);
  await behindThePageControls(browser, scenario, fixture);
  if (fixture.initial !== undefined) await prefilledControls(browser, scenario, fixture);
}

// The mirror image of the page-only damage: the browser still shows the right review page, but the
// server's draft was changed behind it (a second tab of the same session). These prove the [backend]
// draft checks measure something that the [ui] checks cannot see.
async function behindThePageControls(browser, scenario, fixture) {
  const group = scenario.id;
  for (const [name, mutate] of Object.entries(wrongStatesFor(fixture))) {
    await control(
      group,
      `page still shows the right review, server draft changed behind it (${name}): FAIL (backend)`,
      async () => {
        await withApp(browser, scenario, async ({ app, page, context, perfect }) => {
          await achieve(page, app, fixture);
          const other = await context.newPage();
          other.setDefaultTimeout(8000);
          try {
            await achieve(other, app, fixture, mutate);
          } finally {
            await other.close().catch(() => undefined);
          }
          const { result, ctx } = perfect();
          await mustFail(['backend'], scenario, app, result, page, ctx);
        });
      }
    );
  }
}

async function prefilledControls(browser, scenario, fixture) {
  await control(
    scenario.id,
    'wrong end state, the pre-filled draft was submitted as it was: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await page.goto(app.url);
        for (const _section of sections(fixture.variant)) {
          await clickAndLoad(page, submitButton(page, fixture.variant));
        }
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );
}

async function pauseEvidenceControls(browser, scenario, fixture, kind) {
  const group = scenario.id;
  const evidenceVariants = {
    'paused results kept in ctx.pauses': fine => fine.ctx,
    'paused results kept in ctx.results with the final one': fine => ({
      ...fine.ctx,
      pauses: undefined,
      results: [...fine.ctx.pauses, fine.result],
    }),
    'only a finished trace event of the paused leg': fine => ({
      ...fine.ctx,
      pauses: undefined,
      trace: [{ type: 'finished', status: kind }],
    }),
    'only a resumed run_started event': fine => ({
      ...fine.ctx,
      pauses: undefined,
      trace: { events: [{ type: 'run_started', resumed: true }] },
    }),
  };
  await control(
    group,
    'pause evidence in every supported place: PASS; in none: FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const fine = perfect();
        for (const build of Object.values(evidenceVariants)) {
          await mustPass(scenario, app, fine.result, page, build(fine));
        }
        await mustFail(['result'], scenario, app, fine.result, page, {
          ...fine.ctx,
          pauses: undefined,
        });
        await mustFail(['result'], scenario, app, fine.result, page, {
          ...fine.ctx,
          pauses: undefined,
          trace: [{ type: 'finished', status: 'completed' }],
        });
        await mustFail(['result'], scenario, app, fine.result, page, {
          ...fine.ctx,
          pauses: [{ status: 'blocked' }],
        });
      });
    }
  );
  await control(
    group,
    'the runner reports no pause, a trace claims one: FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const fine = perfect();
        const claims = {
          trace: [
            { type: 'finished', status: kind },
            { type: 'run_started', resumed: true },
          ],
        };
        await mustFail(['result'], scenario, app, fine.result, page, {
          ...fine.ctx,
          pauses: [],
          pauseBackends: [],
          ...claims,
        });
        await mustFail(['result'], scenario, app, fine.result, page, {
          ...fine.ctx,
          pauses: [{ status: 'blocked' }],
          ...claims,
        });
      });
    }
  );
  await control(
    group,
    'nothing known about what the server held at the pause: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const fine = perfect();
        const held = fine.ctx.pauseBackends[0].backend;
        const bad = {
          'pauseBackends missing': undefined,
          'pauseBackends empty': [],
          'only another status was captured': [pausedAt('blocked', held)],
          'the snapshot is an error marker': [pausedAt(kind, { snapshotError: 'boom' })],
          'the snapshot is not a state': [pausedAt(kind, 'oops')],
        };
        for (const pauseBackends of Object.values(bad)) {
          await mustFail(['backend'], scenario, app, fine.result, page, {
            ...fine.ctx,
            pauseBackends,
          });
        }
      });
    }
  );
  await control(
    group,
    'the server already held a saved submission at the pause: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const fine = perfect();
        const saved = app.state();
        await mustFail(['backend'], scenario, app, fine.result, page, {
          ...fine.ctx,
          pauseBackends: [pausedAt(kind, saved)],
        });
        if (kind === 'awaiting_approval') {
          const rejectedOnly = {
            ...fine.ctx.pauseBackends[0].backend,
            submissions: [
              { seq: 1, step: 'shipping', accepted: false, outcome: 'rejected', errors: [] },
            ],
          };
          await mustFail(['backend'], scenario, app, fine.result, page, {
            ...fine.ctx,
            pauseBackends: [pausedAt(kind, rejectedOnly)],
          });
        }
        for (const counter of ['reviewViews', 'paymentViews']) {
          const viewed = { ...fine.ctx.pauseBackends[0].backend, [counter]: 1 };
          await mustFail(['backend'], scenario, app, fine.result, page, {
            ...fine.ctx,
            pauseBackends: [pausedAt(kind, viewed)],
          });
        }
      });
    }
  );
}

async function missingInputControls(browser, scenario, fixture) {
  const group = scenario.id;
  const { variant, supplied } = fixture;
  const label = EMAIL_LABEL_FOR_REQUIREMENT[variant];
  await pauseEvidenceControls(browser, scenario, fixture, 'needs_input');

  await control(
    group,
    'requirements that do not name the missing field: FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { result, ctx } = perfect();
        const wrong = needsInputResult(scenario, 'City', {
          requirements: [requirementFor('City', 'No supplied value fits the "City" field')],
        });
        await mustFail(['result'], scenario, app, result, page, { ...ctx, pauses: [wrong] });
      });
    }
  );

  await control(group, 'requirements that echo a supplied value: FAIL (result)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await achieve(page, app, fixture);
      const { result, ctx } = perfect();
      const echoing = needsInputResult(scenario, label, {
        requirements: [
          requirementFor(
            label,
            `No value for "${label}"; the profile only holds ${fixture.profile.address.line1}`
          ),
        ],
      });
      await mustFail(['result'], scenario, app, result, page, { ...ctx, pauses: [echoing] });
    });
  });

  await control(
    group,
    'an invented email accepted before the real one: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        const data = dataFromFixture(fixture);
        await enter(page, app, variant, { ...data, email: 'invented.address@example.test' });
        await reopenEntry(page, app, variant);
        await fillKeys(page, variant, data, ['email']);
        await clickAndLoad(page, submitButton(page, variant));
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'a second rejection (bad postal code) on the way, not only the email: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        const data = dataFromFixture(fixture);
        await enter(page, app, variant, {
          ...data,
          email: '',
          postalCode: data.postalCode.slice(0, -1),
        });
        await enter(page, app, variant, data);
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'a rejected submission (no email) before the pause, then the supplied email: PASS',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        const data = dataFromFixture(fixture);
        await enter(page, app, variant, { ...data, email: '' });
        const rejectedFirst = app.state();
        if (
          rejectedFirst.submissions.length === 0 ||
          rejectedFirst.submissions.some(s => s.accepted)
        )
          throw new Error('the scripted run did not produce exactly a rejection');
        await enter(page, app, variant, data);
        const { result, ctx } = perfect();
        await mustPass(scenario, app, result, page, {
          ...ctx,
          pauseBackends: [pausedAt('needs_input', rejectedFirst)],
        });
      });
    }
  );

  await control(
    group,
    'the supplied email exactly as given is what the server holds: PASS',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const state = app.state();
        if (state.draft.email !== supplied.value)
          throw new Error('the draft email is not the supplied value');
      });
    }
  );
}

async function approvalControls(browser, scenario, fixture) {
  const group = scenario.id;
  const { variant } = fixture;
  await pauseEvidenceControls(browser, scenario, fixture, 'awaiting_approval');

  await control(
    group,
    'saved without approval (no approvalId on the commit): FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { ctx } = perfect();
        const unapproved = completedResult(scenario, variant);
        await mustFail(['result'], scenario, app, unapproved, page, ctx);
      });
    }
  );

  await control(
    group,
    'the commit carries an approvalId that no request issued: FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { ctx } = perfect();
        const forged = completedResult(scenario, variant, { approvalId: 'apr_999999999999' });
        await mustFail(['result'], scenario, app, forged, page, ctx);
      });
    }
  );

  await control(
    group,
    'a submission was already committed when approval was asked: FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { result, ctx } = perfect();
        const early = approvalResult(scenario, variant, {
          ledger: [...entryLedger(), ...commitLedger(variant, 5)],
        });
        await mustFail(['result'], scenario, app, result, page, { ...ctx, pauses: [early] });
      });
    }
  );

  await control(
    group,
    'an approval request that does not name form_submit: FAIL (result)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        const { result, ctx } = perfect();
        const vague = approvalResult(scenario, variant, {
          approval: { id: 'apr_000000000001', effects: [] },
        });
        await mustFail(['result'], scenario, app, result, page, { ...ctx, pauses: [vague] });
      });
    }
  );

  await control(
    group,
    'two submissions accepted (one unapproved) before the end: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await achieve(page, app, fixture);
        await reopenEntry(page, app, variant);
        await clickAndLoad(page, submitButton(page, variant));
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );
}

async function validationControls(browser, scenario, fixture) {
  const group = scenario.id;
  const { variant } = fixture;
  const data = dataFromFixture(fixture);
  const label = POSTAL_LABEL_FOR_REQUIREMENT[variant];
  const rejectedRun = async ({ app, page }) => enter(page, app, variant, data);

  await control(
    group,
    'server rejects the typed ZIP, needs_input names it: PASS; wrong results: FAIL',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await rejectedRun({ app, page });
        const { result, ctx } = perfect();
        await mustPass(scenario, app, result, page, ctx);
        const blocked = baseResult(scenario, entryLedger(), {
          status: 'blocked',
          reason: 'MODEL_BLOCKED',
          message: 'The model could not continue.',
        });
        await mustPass(scenario, app, blocked, page, ctx);
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...blocked, reason: 'BUDGET_EXHAUSTED' },
          page,
          ctx
        );
        await mustFail(['result'], scenario, app, { ...blocked, message: '' }, page, ctx);
        await mustFail(['result'], scenario, app, { ...result, status: 'completed' }, page, ctx);
        await mustFail(['result'], scenario, app, { ...result, status: 'failed' }, page, ctx);
        await mustFail(
          ['result'],
          scenario,
          app,
          { ...result, goal: `${result.goal}!` },
          page,
          ctx
        );
        await mustFail(['result'], scenario, app, undefined, page, ctx);
        const wrongField = needsInputResult(scenario, 'City', {
          requirements: [requirementFor('City', 'No supplied value fits the "City" field')],
        });
        await mustFail(['result'], scenario, app, wrongField, page, ctx);
        const echoing = needsInputResult(scenario, label, {
          requirements: [
            requirementFor(label, `The value ${data.postalCode} for ${data.city} was refused`),
          ],
        });
        await mustFail(['result'], scenario, app, echoing, page, ctx);
        await mustFail(['result'], scenario, app, result, page, { ...ctx, calls: [] });
        await mustFail(['result'], scenario, app, result, page, { ...ctx, calls: undefined });
      });
    }
  );

  await control(
    group,
    'untouched initial state, no server error observed: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await page.goto(app.url);
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'wrong end state, the ZIP was corrected and the server accepted it: FAIL',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await enter(page, app, variant, { ...data, postalCode: '60614' });
        const { result, ctx } = perfect();
        await mustFail(STATE_TAGS, scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'wrong end state, a different invalid ZIP was typed (rejected but invented): FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await enter(page, app, variant, { ...data, postalCode: '606144' });
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'wrong end state, the supplied ZIP first, then another invalid ZIP on a retry: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await enter(page, app, variant, data);
        await reopenEntry(page, app, variant);
        await enter(page, app, variant, { ...data, postalCode: '606144' });
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'wrong end state, draft discarded after the error: FAIL (backend)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await enter(page, app, variant, data);
        await clickAndLoad(page, page.getByRole('button', { name: 'Discard changes' }));
        const { result, ctx } = perfect();
        await mustFail(['backend'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(group, 'backend right, address bar shows the review page: FAIL (ui)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await enter(page, app, variant, data);
      await page.evaluate(route => history.pushState({}, '', route), ROUTES[variant].review);
      const { result, ctx } = perfect();
      await mustFail(['ui'], scenario, app, result, page, ctx);
    });
  });

  await control(group, 'wrong end state, filled but never submitted: FAIL (backend)', async () => {
    await withApp(browser, scenario, async ({ app, page, perfect }) => {
      await enter(page, app, variant, data, { submit: false });
      const { result, ctx } = perfect();
      await mustFail(['backend'], scenario, app, result, page, ctx);
    });
  });

  await control(
    group,
    'backend right, but the browser wandered off to another page: FAIL (ui)',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await enter(page, app, variant, data);
        await page.goto(`${app.origin}/cart`);
        const { result, ctx } = perfect();
        await mustFail(['ui'], scenario, app, result, page, ctx);
      });
    }
  );

  await control(
    group,
    'backend right, the browser still shows the rejected form: PASS',
    async () => {
      await withApp(browser, scenario, async ({ app, page, perfect }) => {
        await enter(page, app, variant, data);
        const { result, ctx } = perfect();
        await mustPass(scenario, app, result, page, ctx);
      });
    }
  );

  await extraWriteControls(browser, scenario, fixture);
  await otherSessionControls(browser, scenario, fixture);
}

async function scenarioControls(browser, scenario) {
  const fixture = fixtures[scenario.id];
  if (fixture === undefined) {
    journal.push({ group: scenario.id, name: 'fixture exists', ok: false, detail: 'no fixture' });
    return;
  }
  if (fixture.flow === 'validation') {
    await validationControls(browser, scenario, fixture);
    return;
  }
  await commonStateControls(browser, scenario, fixture);
  if (fixture.flow === 'missing_input') await missingInputControls(browser, scenario, fixture);
  if (fixture.flow === 'approval') await approvalControls(browser, scenario, fixture);
}

// ---------------------------------------------------------------------------------------------
// Static controls: the scenario file itself (shape, goal hygiene), each with a positive control
// ---------------------------------------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const POLICY_EFFECTS = ['form_submit'];

function shapeErrors(scenario) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(typeof scenario.id === 'string' && KEBAB.test(scenario.id), 'id is not kebab-case');
  need(scenario.family === 'shipping', 'family is not shipping');
  need(['A', 'B', 'C'].includes(scenario.variant), 'variant is not A, B or C');
  need(scenario.kind === 'live', 'kind is not live');
  need(typeof scenario.title === 'string' && scenario.title.length > 10, 'title is missing');
  need(typeof scenario.goal === 'string' && scenario.goal.length > 40, 'goal is missing or tiny');
  need(typeof scenario.expect === 'function', 'expect is not a function');
  need(
    typeof scenario.inputs === 'object' && scenario.inputs !== null,
    'inputs is not an object or function'
  );
  const statuses = [].concat(scenario.expectStatus);
  need(
    statuses.length > 0 &&
      statuses.every(s =>
        [
          'completed',
          'blocked',
          'needs_input',
          'awaiting_approval',
          'failed',
          'cancelled',
        ].includes(s)
      ),
    'expectStatus is not a status or list of statuses'
  );
  const budgets = scenario.run?.budgets ?? {};
  need(
    Object.values(budgets).every(value => Number.isInteger(value) && value > 0),
    'a budget is not a positive integer'
  );
  for (const entry of scenario.resume ?? []) {
    need(['needs_input', 'awaiting_approval'].includes(entry.on), 'resume.on is not a pause kind');
    need(
      ['inputs', 'approval'].includes(entry.resolution?.kind),
      'resume resolution kind is not inputs or approval'
    );
  }
  const submitsNeeded = scenario.variant === 'C' ? 2 : 1;
  for (const entry of scenario.authorization?.effects ?? []) {
    const effect = typeof entry === 'string' ? entry : entry?.effect;
    need(POLICY_EFFECTS.includes(effect), `authorization grants ${effect}, more than form_submit`);
    const uses = typeof entry === 'object' && entry !== null ? entry.maxUses : undefined;
    need(
      Number.isInteger(uses) && uses >= submitsNeeded && uses <= submitsNeeded * 3,
      `the ${effect} grant has maxUses ${uses}: it must be bounded and fit a flow of ${submitsNeeded} submit(s)`
    );
  }
  for (const declaration of scenario.inputDeclarations ?? []) {
    const description = declaration.description ?? '';
    need(typeof declaration.path === 'string', 'a declaration has no path');
    need(
      declaration.sensitive === false,
      `${declaration.path} is declared sensitive in ordinary data`
    );
    need(
      description.length > 0 && description.length <= 120 && !/[\u0000-\u001f]/.test(description),
      `${declaration.path} has a bad description`
    );
    const reached =
      typeof declaration.path === 'string'
        ? declaration.path
            .split('.')
            .reduce(
              (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
              scenario.inputs
            )
        : undefined;
    need(typeof reached === 'string', `${declaration.path} does not reach a string leaf of inputs`);
  }
  return errors;
}

const GOAL_RULES = [
  ['url', /https?:|www\.|\.com\b|\.test\b/i],
  ['path or slash', /\//],
  [
    'selector',
    /(^|\s)#[a-z][\w-]*|\.[a-z][\w-]*\s*[>{[]|\[[a-z-]+=|\binput\[|\bxpath\b|\bcss\b|\bselector\b|\baria-|\bdiv\b/i,
  ],
  ['click-style instruction', /\b(click|press|tap|hit|push)\b/i],
  ['ui noun as instruction', /\b(button|link|tab|dropdown|checkbox|radio|menu|icon)\b/i],
  ['step list', /\bstep\s*\d|\bthen\b|^\s*[-*\d]+[.)]?\s/im],
  ['step count', /\b(in|within|after)\s+(one|two|three|four|five|\d+)\s+steps?\b/i],
  [
    'expected phrase',
    /\b(should (say|show|read)|must (say|show|read)|until (you see|it says)|look for)\b/i,
  ],
  ['quoted label', /["“][^"”]{3,}["”]/],
];

const lintGoal = goal =>
  GOAL_RULES.filter(([, pattern]) => pattern.test(goal)).map(([name]) => name);

const APP_STRINGS = [
  ...Object.values(SUBMIT),
  'Continue to payment',
  'Empty cart',
  'Start over',
  'Discard changes',
  'Clear form',
  'Proceed to checkout',
  'Edit shipping details',
  'Change delivery details',
  'Back to delivery',
  'Back to review',
  ...Object.values(DELIVERY_NAME).flatMap(names => Object.values(names).map(name => name.source)),
  ...Object.values(LABELS).flatMap(labels => Object.values(labels)),
].filter(label => label.length >= 10);

// A goal is the caller's wish, not a reading of the screen: it must not repeat a label, a link text
// or a delivery option name of the app (a prohibition such as "do not continue to payment" echoes the link).
function goalLeaks(goal) {
  const text = goal.toLowerCase();
  return APP_STRINGS.filter(label => text.includes(label.toLowerCase()));
}

function inputLeaks(inputs) {
  const text = JSON.stringify(inputs).toLowerCase();
  const leaks = APP_STRINGS.filter(label => text.includes(label.toLowerCase()));
  if (/https?:|\/(checkout|order|cart)\b/i.test(text)) leaks.push('route');
  return leaks;
}

const withProblems = (list, find) =>
  list.flatMap(item => find(item).map(problem => `${item.id}: ${problem}`));
const shapeProblems = list => withProblems(list, shapeErrors);
const goalLintProblems = list => withProblems(list, item => lintGoal(item.goal));
const goalEchoProblems = list => withProblems(list, item => goalLeaks(item.goal));
const inputProblems = list =>
  withProblems(list, item => [
    ...inputLeaks([item.inputs, item.inputDeclarations]),
    ...(item.resume ?? []).flatMap(entry => inputLeaks(entry.resolution)),
  ]);

// Finders applied to the real scenario list itself (not to a damaged copy). The coverage check reads it,
// so a real check that was deleted or skipped is reported even though its positive control still passes.
const appliedToReal = new Set();

function assertClean(finder, list) {
  if (list === scenarios) appliedToReal.add(finder);
  const problems = finder(list);
  if (problems.length > 0) throw new Error(problems.join('; '));
}

// The real checks and their positive controls both go through assertClean, so a check that is
// switched off makes its own proof fail. A finder must flag EVERY damaged item by id.
function flagsEach(name, finder, damaged) {
  let message = '';
  try {
    assertClean(finder, damaged);
  } catch (error) {
    message = String(error?.message ?? error);
  }
  if (message === '') throw new Error(`${name} flagged nothing`);
  for (const item of damaged) {
    if (!message.includes(`${item.id}:`)) throw new Error(`${name} did not flag ${item.id}`);
  }
}

async function staticControls() {
  const group = '(static)';
  await control(
    group,
    'at least 8 scenarios, ids unique, variants A, B and C all used',
    async () => {
      if (scenarios.length < 8) throw new Error(`only ${scenarios.length} scenarios`);
      const ids = scenarios.map(s => s.id);
      if (new Set(ids).size !== ids.length) throw new Error('duplicate ids');
      const variants = new Set(scenarios.map(s => s.variant));
      for (const v of ['A', 'B', 'C']) if (!variants.has(v)) throw new Error(`variant ${v} unused`);
    }
  );
  await control(
    group,
    'every scenario has a fixture and the required catalog rows exist',
    async () => {
      for (const scenario of scenarios) {
        if (!fixtures[scenario.id]) throw new Error(`no fixture for ${scenario.id}`);
      }
      const flows = new Set(Object.values(fixtures).map(f => f.flow));
      for (const flow of ['fill', 'validation', 'missing_input', 'approval']) {
        if (!flows.has(flow)) throw new Error(`no ${flow} scenario`);
      }
      const deliveries = new Set(
        Object.values(fixtures)
          .map(f => f.draft?.delivery)
          .filter(Boolean)
      );
      const hasGift = Object.values(fixtures).some(f => f.draft?.giftWrap === true);
      if (!hasGift || deliveries.size < 3)
        throw new Error('gift wrap and varied delivery are not covered');
    }
  );
  await control(group, 'every scenario passes the shape checks', async () => {
    assertClean(shapeProblems, scenarios);
  });
  await control(group, 'shape check flags a malformed scenario (positive control)', async () => {
    const broken = {
      ...scenarios[0],
      id: 'Bad_Id',
      goal: 'short',
      kind: 'fault',
      expect: undefined,
    };
    const errors = shapeErrors(broken);
    if (errors.length < 4)
      throw new Error(`only ${errors.length} problems found in a broken scenario`);
    const sensitive = {
      ...scenarios[0],
      inputDeclarations: [
        { path: 'profile.firstName', sensitive: true, description: 'Recipient personal name' },
      ],
    };
    if (shapeErrors(sensitive).length === 0)
      throw new Error('a sensitive declaration went unflagged');
    flagsEach(
      'the shape check',
      shapeProblems,
      scenarios.map(s => ({ ...s, kind: 'fault' }))
    );
    const wizard = scenarios.find(s => s.variant === 'C');
    const grants = {
      'a bare effect name (unlimited)': ['form_submit'],
      'a grant without maxUses (unlimited)': [{ effect: 'form_submit' }],
      'a grant too small for the wizard': [{ effect: 'form_submit', maxUses: 1 }],
      'a grant far larger than the flow': [{ effect: 'form_submit', maxUses: 50 }],
      'a grant for another effect': [{ effect: 'purchase', maxUses: 3 }],
    };
    for (const [name, effects] of Object.entries(grants)) {
      if (shapeErrors({ ...wizard, authorization: { effects } }).length === 0)
        throw new Error(`${name} went unflagged`);
    }
    if (
      shapeErrors({
        ...wizard,
        authorization: { effects: [{ effect: 'form_submit', maxUses: 4 }] },
      }).length > 0
    )
      throw new Error('a bounded grant that fits the wizard was flagged');
  });
  await control(
    group,
    'shape check flags each kind of damage on its own (positive control)',
    async () => {
      const base = scenarios.find(
        item => item.variant === 'A' && fixtures[item.id].flow === 'fill'
      );
      if (shapeErrors(base).length > 0) throw new Error('the undamaged base scenario is flagged');
      const declared = (change = {}) => [
        {
          path: 'profile.firstName',
          sensitive: false,
          description: 'Recipient personal name',
          ...change,
        },
      ];
      const damages = {
        'a bad id': { id: 'Bad_Id' },
        'another family': { family: 'checkout' },
        'a fourth variant': { variant: 'D' },
        'a fault kind': { kind: 'fault' },
        'no title': { title: '' },
        'a tiny goal': { goal: 'short' },
        'expect is not a function': { expect: undefined },
        'no inputs': { inputs: undefined },
        'an unknown status': { expectStatus: 'done' },
        'an empty status list': { expectStatus: [] },
        'a zero budget': { run: { budgets: { maxSteps: 0 } } },
        'a fractional budget': { run: { budgets: { maxSteps: 1.5 } } },
        'a resume for no pause kind': {
          resume: [{ on: 'blocked', resolution: { kind: 'inputs' } }],
        },
        'a resume with an unknown kind': {
          resume: [{ on: 'needs_input', resolution: { kind: 'effect' } }],
        },
        'a declaration without a path': { inputDeclarations: declared({ path: undefined }) },
        'a declaration that reaches nothing': {
          inputDeclarations: declared({ path: 'profile.nothing' }),
        },
        'a declaration that reaches an object': {
          inputDeclarations: declared({ path: 'profile.address' }),
        },
        'a sensitive declaration': { inputDeclarations: declared({ sensitive: true }) },
        'an empty description': { inputDeclarations: declared({ description: '' }) },
        'no description': { inputDeclarations: declared({ description: undefined }) },
        'a description over 120 characters': {
          inputDeclarations: declared({ description: 'x'.repeat(121) }),
        },
        'a control character in a description': {
          inputDeclarations: declared({ description: `bell${String.fromCharCode(7)}ring` }),
        },
      };
      for (const [name, damage] of Object.entries(damages)) {
        if (shapeErrors({ ...base, ...damage }).length === 0)
          throw new Error(`${name} went unflagged`);
      }
      if (shapeErrors({ ...base, inputDeclarations: declared() }).length > 0) {
        throw new Error('a well-formed declaration was flagged');
      }
    }
  );
  await control(group, 'flagsEach measures what it claims (positive control)', async () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const flagAll = list => list.map(item => `${item.id}: bad`);
    const refuses = (label, run) => {
      try {
        run();
      } catch {
        return;
      }
      throw new Error(`${label} did not throw`);
    };
    flagsEach('flag all', flagAll, items);
    refuses('a finder that flags only the first item', () =>
      flagsEach('flag first', list => flagAll(list.slice(0, 1)), items)
    );
    refuses('a finder that flags nothing', () => flagsEach('flag none', () => [], items));
    refuses('assertClean on a flagged list', () => assertClean(flagAll, items));
    assertClean(() => [], items);
  });
  await control(
    group,
    'goals carry no URLs, paths, selectors, click instructions, steps or expected text',
    async () => {
      assertClean(goalLintProblems, scenarios);
    }
  );
  await control(group, 'goal lint flags bad goals (positive control)', async () => {
    const bad = [
      'Open https://shop.example.test/checkout and fill the form',
      'Go to /order/delivery and finish',
      'Type the name into the #email field',
      'Click Review order when you are ready',
      'Use the Continue button at the bottom',
      'Fill the form, then submit it',
      'Finish in three steps',
      'Stop when the page should show "Order confirmed"',
    ];
    for (const goal of bad) {
      if (lintGoal(goal).length === 0) throw new Error(`not flagged: ${goal}`);
    }
    flagsEach(
      'the goal lint',
      goalLintProblems,
      scenarios.map(s => ({ ...s, goal: bad[0] }))
    );
  });
  await control(group, 'goals repeat no label, link text or option name of the app', async () => {
    assertClean(goalEchoProblems, scenarios);
  });
  await control(
    group,
    'goal echo check flags every kind of app text (positive control)',
    async () => {
      // Written out by hand: a phrase deleted from APP_STRINGS must not delete its own proof.
      const phrases = [
        'Continue to payment',
        'Edit shipping details',
        'Change delivery details',
        'Back to delivery',
        'Back to review',
        'Proceed to checkout',
        'Review order',
        'Confirm and review',
        'Save and continue',
        'Express shipping',
        'Priority delivery',
        'Fast courier',
        'Courier by tomorrow',
        'Next-day delivery',
        'Save this address for future orders',
        'Keep this address in my address book',
      ];
      for (const phrase of phrases) {
        flagsEach('the goal echo check', goalEchoProblems, [
          { id: 'probe', goal: `Please sort out my order, then ${phrase.toUpperCase()} for me` },
        ]);
      }
      flagsEach(
        'the goal echo check',
        goalEchoProblems,
        scenarios.map(s => ({ ...s, goal: 'Take me on with Continue to payment' }))
      );
    }
  );
  await control(group, 'inputs carry no routes and no label of the app', async () => {
    assertClean(inputProblems, scenarios);
  });
  await control(
    group,
    'input leak check flags a route and a label (positive control)',
    async () => {
      if (inputLeaks({ note: 'go to /checkout/shipping' }).length === 0)
        throw new Error('route not flagged');
      if (inputLeaks({ note: 'press Review order' }).length === 0)
        throw new Error('label not flagged');
      flagsEach(
        'the input check (inputs)',
        inputProblems,
        scenarios.map(s => ({ ...s, inputs: { note: 'press Review order' } }))
      );
      flagsEach(
        'the input check (declarations)',
        inputProblems,
        scenarios.map(s => ({ ...s, inputDeclarations: [{ description: 'see /checkout/review' }] }))
      );
      const resuming = scenarios.filter(s => (s.resume ?? []).length > 0);
      flagsEach(
        'the input check (resume)',
        inputProblems,
        resuming.map(s => ({
          ...s,
          resume: [
            {
              on: 'needs_input',
              resolution: { kind: 'inputs', inputs: { note: 'go to /order/delivery' } },
            },
          ],
        }))
      );
    }
  );
  await control(
    group,
    'a scenario with a resume entry grants no more than the goal needs',
    async () => {
      const problems = policyProblems(scenarios);
      if (problems.length > 0) throw new Error(problems.join('; '));
    }
  );
  await control(
    group,
    'resume and grant policy flags each violation (positive control)',
    async () => {
      const swap = (flow, change) =>
        scenarios.map(item =>
          fixtures[item.id].flow === flow ? { ...item, ...change(item) } : item
        );
      const violations = {
        'the approval scenario carries a grant': swap('approval', () => ({
          authorization: { effects: [{ effect: 'form_submit', maxUses: 3 }] },
        })),
        'the approval is not once': swap('approval', item => ({
          resume: [
            {
              on: 'awaiting_approval',
              resolution: { kind: 'approval', resolution: { decision: 'approve', scope: 'run' } },
            },
          ],
        })),
        'the approval is a denial': swap('approval', () => ({
          resume: [
            {
              on: 'awaiting_approval',
              resolution: { kind: 'approval', resolution: { decision: 'deny', scope: 'once' } },
            },
          ],
        })),
        'the missing value is already in the inputs': swap('missing_input', item => ({
          inputs: {
            profile: {
              ...item.inputs.profile,
              email: item.resume[0].resolution.inputs.profile.email,
            },
          },
        })),
        'the missing-input scenario resumes without a value': swap('missing_input', () => ({
          resume: [],
        })),
      };
      for (const [name, list] of Object.entries(violations)) {
        if (policyProblems(list).length === 0) throw new Error(`${name} went unflagged`);
      }
    }
  );
  await control(
    group,
    'mustPass and mustFail measure what they claim (positive control)',
    async () => {
      const fake = body => ({
        expect: async () => {
          body();
        },
      });
      const passes = fake(() => undefined);
      const uiFail = fake(() => {
        throw new Error('[ui] the page is wrong');
      });
      const untagged = fake(() => {
        throw new TypeError('x is not a function');
      });
      const refuses = async (label, pattern, run) => {
        try {
          await run();
        } catch (error) {
          if (pattern.test(String(error?.message))) return;
          throw new Error(`${label} threw the wrong error: ${error?.message}`);
        }
        throw new Error(`${label} did not throw`);
      };
      await refuses('mustFail on a passing expect', /PASSED/, () => mustFail(['ui'], passes));
      await refuses('mustFail on the wrong tag', /but backend or result was expected/, () =>
        mustFail(['backend', 'result'], uiFail)
      );
      await refuses('mustFail on an untagged error', /untagged/, () => mustFail(['ui'], untagged));
      await refuses('mustPass on a failing expect', /should have passed/, () => mustPass(uiFail));
      await mustFail(['ui'], uiFail);
      await mustFail(['backend', 'ui'], uiFail);
      await mustPass(passes);
    }
  );
}

function policyProblems(list) {
  const problems = [];
  const flow = name => list.filter(item => fixtures[item.id]?.flow === name);
  const approvals = flow('approval');
  const missing = flow('missing_input');
  if (approvals.length === 0) problems.push('there is no approval scenario');
  if (missing.length === 0) problems.push('there is no missing-input scenario');
  for (const item of approvals) {
    if (item.authorization !== undefined) problems.push(`${item.id} carries a grant`);
    const approve = item.resume?.[0]?.resolution?.resolution;
    if (approve?.decision !== 'approve' || approve?.scope !== 'once') {
      problems.push(`${item.id} does not approve once`);
    }
  }
  for (const item of missing) {
    const supplied = item.resume?.[0]?.resolution?.inputs?.profile?.email;
    if (typeof supplied !== 'string') problems.push(`${item.id} does not resume with a value`);
    else if (JSON.stringify(item.inputs).includes(supplied)) {
      problems.push(`${item.id} already holds the value in its inputs`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { only: [], jobs: 3, staticOnly: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--static-only') out.staticOnly = true;
    else if (argv[i] === '--only' && argv[i + 1]) out.only.push(argv[(i += 1)]);
    else if (argv[i] === '--jobs' && argv[i + 1])
      out.jobs = Math.max(1, Number(argv[(i += 1)]) || 3);
    else out.unknown.push(argv[i]);
  }
  return out;
}

async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(runners);
}

const REAL_CHECKS = {
  shapeProblems,
  goalLintProblems,
  goalEchoProblems,
  inputProblems,
};

function coverageProblems(selected, { staticRan }) {
  const problems = [];
  if (staticRan) {
    for (const [name, finder] of Object.entries(REAL_CHECKS)) {
      if (!appliedToReal.has(finder)) {
        problems.push(`the ${name} check never ran on the real scenarios`);
      }
    }
  }
  for (const scenario of selected) {
    const mine = journal.filter(entry => entry.group === scenario.id);
    const wrongStates = mine.filter(entry =>
      /wrong end state|initial state/.test(entry.name)
    ).length;
    if (mine.length < 5) problems.push(`${scenario.id}: only ${mine.length} controls ran`);
    if (!mine.some(entry => /PASS/.test(entry.name)))
      problems.push(`${scenario.id}: no PASS control`);
    if (wrongStates < 3) problems.push(`${scenario.id}: only ${wrongStates} FAIL-state controls`);
  }
  return problems;
}

export async function runControls({ only = [], jobs = 3, print = true, staticOnly = false } = {}) {
  journal.length = 0;
  appliedToReal.clear();
  const selected = staticOnly
    ? []
    : only.length > 0
      ? scenarios.filter(s => only.includes(s.id))
      : scenarios;
  for (const id of only.filter(id => !scenarios.some(s => s.id === id))) {
    journal.push({
      group: '(args)',
      name: `--only ${id} names no scenario`,
      ok: false,
      detail: id,
    });
  }
  if (only.length === 0) await staticControls();
  if (selected.length > 0) {
    const browser = await launchBrowser();
    try {
      await pool(selected, jobs, scenario => scenarioControls(browser, scenario));
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
  for (const problem of coverageProblems(selected, { staticRan: only.length === 0 })) {
    journal.push({ group: '(coverage)', name: problem, ok: false, detail: problem });
  }
  if (selected.length > 0 && only.length === 0) {
    journal.push({
      group: '(coverage)',
      name: `every one of the ${selected.length} scenarios has controls`,
      ok: selected.every(s => journal.some(entry => entry.group === s.id)),
    });
  }
  const order = ['(args)', '(static)', ...selected.map(s => s.id), '(coverage)'];
  const sorted = [...journal].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  if (print) {
    for (const entry of sorted) {
      const suffix = entry.ok ? '' : `: ${entry.detail}`;
      console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.group} :: ${entry.name}${suffix}`);
    }
  }
  const passed = journal.filter(entry => entry.ok).length;
  const total = journal.length;
  if (print)
    console.log(`\nshipping controls: ${passed} passed, ${total - passed} failed, ${total} total`);
  return { passed, total, failed: total - passed, journal: sorted };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { only, jobs, staticOnly, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.log(`FAIL unknown or incomplete argument: ${unknown.join(' ')}`);
    process.exit(1);
  }
  runControls({ only, jobs, staticOnly })
    .then(({ failed }) => {
      process.exitCode = failed > 0 ? 1 : 0;
    })
    .catch(error => {
      console.log(`FAIL controls crashed: ${String(error?.message ?? error)}`);
      process.exitCode = 1;
    });
}
