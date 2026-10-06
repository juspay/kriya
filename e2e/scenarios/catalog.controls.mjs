import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, startApp } from '../apps/catalog.mjs';
import { findTextProblems, validateScenario } from '../harness/scenario.mjs';
import { scenarios } from './catalog.mjs';

// Control proof for e2e/scenarios/catalog.mjs: plain scripted Playwright drives the real catalog apps (never
// the agent) to an end state, and every scenario's expect() must accept the achieved state and reject the
// untouched start, plausible wrong end states, wrong result fields, and each single facet of the real page
// and backend when it alone is wrong (so no check can be deleted without a control noticing).

const TOOLS_DIR = process.env.BREEZE_GUIDE_TOOLS_DIR ?? '/tmp/amazon-guide';
const PINNED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const VIEWPORT = { width: 1280, height: 800 };
const EXPECTATION_ERROR = 'CatalogExpectation';
const MIN_RERENDER_PERIOD_MS = 3000;
const MIN_STALE_RETRIES = 5;
const MIN_PASS_CONTROLS = 1;
const MIN_FAIL_CONTROLS = 8;

const findChromium = () => {
  if (existsSync(PINNED_CHROMIUM)) return PINNED_CHROMIUM;
  const root = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = readdirSync(root)
    .filter(dir => /^chromium-\d+$/.test(dir))
    .sort();
  for (const dir of dirs) {
    const candidate = join(
      root,
      dir,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const firstLine = error => String(error?.message ?? error).split('\n')[0];

/* ------------------------------------------------------------------ */
/* Synthetic results of the right shape (TaskResult)                   */
/* ------------------------------------------------------------------ */

const SCOPE = {
  sessionId: 'ses_0123456789ab',
  snapshotId: 'snap_0123456789ab',
  documentId: 'doc_0123456789ab',
};

const ledgerEntry = (seq, operation, extra = {}) => ({
  seq,
  step: seq,
  command: {
    command: {
      operation,
      target: { ...SCOPE, targetId: `t${seq}`, signature: `sig-${seq}` },
      ...(operation === 'SET_CHECKED' ? { checked: true } : {}),
    },
  },
  digest: `dg_${String(seq).padStart(12, '0')}`,
  effects: ['interact'],
  status: 'applied',
  effect: 'applied',
  postconditions: [],
  scope: SCOPE,
  observationSequence: seq,
  observationOrdinal: seq,
  url: 'http://127.0.0.1/',
  startedAt: 1000 + seq,
  finishedAt: 1010 + seq,
  navigated: false,
  ...extra,
});

const USAGE = {
  steps: 3,
  modelCalls: 9,
  staleRetries: 0,
  noProgress: 0,
  uncertainEffects: 0,
  prematureDone: 0,
  invalidDecisions: 0,
  rejectedCommands: 0,
  deciderFailures: 0,
  hostFailures: 0,
  elapsedMs: 1000,
};

const baseResult = (goal, over = {}) => ({
  runId: 'run_0123456789ab',
  sessionId: SCOPE.sessionId,
  goal,
  steps: 3,
  stats: {
    usage: USAGE,
    modelLatencyMs: 900,
    actions: { applied: 3, noop: 0, rejected: 0, failed: 0, uncertain: 0, navigated: 0 },
  },
  ledger: [ledgerEntry(1, 'CLICK'), ledgerEntry(2, 'SET_CHECKED'), ledgerEntry(3, 'CLICK')],
  exchanges: [],
  warnings: [],
  startedAt: 1000,
  finishedAt: 2000,
  lastEffect: 'applied',
  unresolvedUncertain: [],
  ...over,
});

const completion = (over = {}) => ({
  mode: 'effected',
  effected: true,
  answered: false,
  basis: 'postconditions',
  evidence: [],
  actionsExecuted: 3,
  verifierConfidence: 0.9,
  verifiedAt: 2000,
  verifiedSnapshot: {
    ...SCOPE,
    sequence: 4,
    observedAt: 2000,
    url: 'http://127.0.0.1/',
    title: 'results',
    fingerprint: 'fp',
    elementCount: 40,
  },
  postconditions: [],
  resolvedUncertain: [],
  unresolvedUncertain: [],
  unobserved: {
    iframes: 0,
    shadowRoots: 0,
    canvases: 0,
    contentEditable: 0,
    multiSelects: 0,
    externalTargets: 0,
  },
  ...over,
});

const completedResult = (goal, over = {}) =>
  baseResult(goal, { status: 'completed', completion: completion(), ...over });

const blockedResult = goal =>
  baseResult(goal, {
    status: 'blocked',
    reason: 'NO_PROGRESS',
    message: 'The run made no progress.',
  });

const REQUIREMENT = {
  id: 'req_0123456789ab',
  kind: 'argument',
  slot: 'value',
  operation: 'FILL',
  description: 'The text to type into the search field is not in the goal or the inputs.',
  reason: 'none_appropriate',
};

const needsInputResult = (goal, over = {}) =>
  baseResult(goal, {
    status: 'needs_input',
    requirements: [REQUIREMENT],
    ledger: [],
    steps: 1,
    lastEffect: 'none',
    checkpoint: {
      version: 1,
      id: 'ck_0123456789ab',
      runId: 'run_0123456789ab',
      sessionId: SCOPE.sessionId,
      createdAt: 1500,
      step: 1,
      usage: USAGE,
      ledger: [],
      history: [],
      startOrigin: 'http://127.0.0.1',
      locationTrust: 'authoritative',
      consumedApprovalIds: [],
      integrity: 'sha256:00',
      pending: { kind: 'needs_input', requirements: [REQUIREMENT] },
    },
    ...over,
  });

/* ------------------------------------------------------------------ */
/* Scripted drivers (independent of the scenario's own page reader)    */
/* ------------------------------------------------------------------ */

const CATEGORY_NAME = {
  A: {
    audio: 'Audio',
    kitchen: 'Kitchen',
    fitness: 'Fitness',
    office: 'Office',
    outdoor: 'Outdoor',
  },
  B: {
    audio: 'Headphones & Audio',
    kitchen: 'Kitchen & Dining',
    fitness: 'Fitness & Training',
    office: 'Office & Desk',
    outdoor: 'Outdoors & Camping',
  },
  C: {
    audio: 'Sound',
    kitchen: 'Cooking',
    fitness: 'Training',
    office: 'Workspace',
    outdoor: 'Adventure',
  },
};
const BRAND_NAME = slug => slug.charAt(0).toUpperCase() + slug.slice(1);
const SORT_NAME = {
  B: {
    relevance: 'Most relevant',
    price_asc: 'Lowest price first',
    price_desc: 'Highest price first',
    rating: 'Best rated',
  },
  C: {
    relevance: 'Recommended',
    price_asc: 'Cheapest first',
    price_desc: 'Most expensive first',
    rating: 'Top reviewed',
  },
};

const isSettled = variant => {
  const text = selector =>
    (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (variant === 'A') return /^Showing \d+ results?/.test(text('#results p.count'));
  if (variant === 'B') return /^\d+ products? found/.test(text('p.found'));
  return /^\d+ items?$/.test(text('#results p.count'));
};
const settle = (page, variant) => page.waitForFunction(isSettled, variant);

// Playwright's fill is a focus followed by a separate insertText call, so a remount in between drops the
// text without an error (measured: 5 of 60 at a 40 ms period). Verify the field and type again.
const fillVerified = async (locator, value) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await locator.fill(value);
    if ((await locator.inputValue()) === value) return;
  }
  throw new Error(`the field never kept the text ${JSON.stringify(value)}`);
};

// A remount between the press and the release of a click loses the click without an error. The URL is the
// page's own record of the filter, so toggle until it says the box is in the wanted state.
const toggleVerified = async (page, name, key, slug, wanted) => {
  const urlHas = () => new URL(page.url()).searchParams.getAll(key).includes(slug);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (urlHas() === wanted) return;
    await page
      .getByRole('checkbox', { name })
      .setChecked(wanted, { timeout: 2500 })
      .catch(() => undefined);
    await page.waitForTimeout(150);
  }
  if (urlHas() !== wanted) {
    throw new Error(`the ${slug} checkbox never reached the state ${String(wanted)}`);
  }
};

// A click that lands during a repaint can be lost without an error, and a response event can be missed. The
// backend request log is the authority: click again until it shows a write, never after one was seen.
const afterWrite = async (page, app, click) => {
  const writes = () => app.requests().filter(request => request.method !== 'GET').length;
  const before = writes();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await click().catch(() => undefined);
    const deadline = Date.now() + 2000;
    while (writes() === before && Date.now() < deadline) await page.waitForTimeout(50);
    if (writes() > before) {
      await page.waitForLoadState('load').catch(() => undefined);
      await page.waitForTimeout(250);
      return;
    }
  }
  throw new Error('no write request ever reached the backend');
};

const driverA = (page, app) => ({
  open: async () => {
    await page.goto(app.url);
    await settle(page, 'A');
  },
  apply: async plan => {
    if (plan.q) {
      const box = page.getByLabel('Search products');
      await fillVerified(box, plan.q);
      await box.press('Enter');
      await page.waitForFunction(
        term => new URLSearchParams(location.search).get('q') === term,
        plan.q
      );
      await settle(page, 'A');
    }
    for (const slug of plan.category ?? []) {
      await toggleVerified(page, new RegExp(`^${CATEGORY_NAME.A[slug]}`), 'category', slug, true);
      await settle(page, 'A');
    }
    for (const slug of plan.brand ?? []) {
      await toggleVerified(page, new RegExp(`^${BRAND_NAME(slug)}`), 'brand', slug, true);
      await settle(page, 'A');
    }
    if (plan.maxPrice !== undefined) {
      await page.getByLabel('Price', { exact: true }).selectOption(String(plan.maxPrice));
      await settle(page, 'A');
    }
    if (plan.sort) {
      await page.getByLabel('Sort by').selectOption(plan.sort);
      await settle(page, 'A');
    }
  },
  addToCart: () =>
    afterWrite(page, app, () =>
      page
        .getByRole('button', { name: /^Add .* to cart$/ })
        .first()
        .click({ timeout: 3000 })
    ),
});

const driverB = (page, app) => ({
  open: async () => {
    await page.goto(app.url);
    await page.getByLabel('What are you looking for?').waitFor();
  },
  apply: async plan => {
    await fillVerified(page.getByLabel('What are you looking for?'), plan.q ?? '');
    if (plan.category?.[0]) {
      await page
        .getByLabel('Department')
        .selectOption({ label: CATEGORY_NAME.B[plan.category[0]] });
    }
    if (plan.brand?.[0]) {
      await page.getByLabel('Manufacturer').selectOption({ label: BRAND_NAME(plan.brand[0]) });
    }
    if (plan.maxPrice !== undefined) {
      await page.getByLabel('Highest price you will pay (USD)').fill(String(plan.maxPrice));
    }
    if (plan.sort) await page.getByLabel(SORT_NAME.B[plan.sort]).check();
    await Promise.all([
      page.waitForURL(/\/search\?/),
      page.getByRole('button', { name: 'Search', exact: true }).click(),
    ]);
    await settle(page, 'B');
  },
  typeOnly: async text => {
    await fillVerified(page.getByLabel('What are you looking for?'), text);
  },
  addToCart: () =>
    afterWrite(page, app, () =>
      page
        .getByRole('button', { name: /^Add .* to basket$/ })
        .first()
        .click({ timeout: 3000 })
    ),
});

const driverC = (page, app) => {
  const chip = name => page.getByRole('button', { name, exact: true });
  return {
    open: async () => {
      await page.goto(app.url);
      await settle(page, 'C');
    },
    apply: async plan => {
      if (plan.q) {
        await chip('Search').click();
        const dialog = page.getByRole('dialog');
        await fillVerified(dialog.getByLabel('Search catalog'), plan.q);
        await dialog.getByRole('button', { name: 'Show results' }).click();
        await dialog.waitFor({ state: 'detached' });
        await settle(page, 'C');
      }
      const chips = [
        ...(plan.category ?? []).map(slug => CATEGORY_NAME.C[slug]),
        ...(plan.brand ?? []).map(BRAND_NAME),
        ...(plan.maxPrice === undefined ? [] : [`$${plan.maxPrice} or less`]),
        ...(plan.sort ? [SORT_NAME.C[plan.sort]] : []),
      ];
      for (const name of chips) {
        await chip(name).click();
        await settle(page, 'C');
      }
    },
    addToCart: () =>
      afterWrite(page, app, () =>
        page
          .getByRole('button', { name: /^Add .* to bag$/ })
          .first()
          .click({ timeout: 3000 })
      ),
    toggleSaved: () =>
      afterWrite(page, app, () =>
        page
          .getByRole('button', { name: /^Keep .* for later$/ })
          .first()
          .click({ timeout: 3000 })
      ),
  };
};

const DRIVERS = { A: driverA, B: driverB, C: driverC };

/* ------------------------------------------------------------------ */
/* Direct backend effects (plain HTTP, bypassing the page)             */
/* ------------------------------------------------------------------ */

const send = async (app, path, { method = 'POST', json, form } = {}) => {
  const init = { method };
  if (json !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams(form).toString();
  }
  const response = await fetch(`${app.origin}${path}`, init);
  await response.arrayBuffer();
  return response.status;
};

// Each effect leaves a distinct trace: a request, a state change, or both.
const RAW_EFFECTS = {
  cart: (app, variant) =>
    variant === 'B'
      ? send(app, '/basket/add', { form: { productId: 'p01', back: '/' } })
      : send(app, '/api/cart', { json: { productId: 'p01' } }),
  wishlist: (app, variant) =>
    variant === 'B'
      ? send(app, '/wishlist/toggle', { form: { productId: 'p02', back: '/' } })
      : send(app, '/api/wishlist', { json: { productId: 'p02', saved: true } }),
  newsletter: (app, variant) =>
    variant === 'B'
      ? send(app, '/newsletter/join', { form: { email: 'shopper@example.com', back: '/' } })
      : send(app, '/api/newsletter', { json: { email: 'shopper@example.com' } }),
  rejectedNewsletter: (app, variant) =>
    variant === 'B'
      ? send(app, '/newsletter/join', { form: { email: 'nope', back: '/' } })
      : send(app, '/api/newsletter', { json: { email: 'nope' } }),
  productPage: app => send(app, '/product/p01', { method: 'GET' }),
  infoPage: app => send(app, '/info/help', { method: 'GET' }),
  unknownPage: app => send(app, '/cart', { method: 'GET' }),
};

/* ------------------------------------------------------------------ */
/* Lenses: what expect() sees of the backend (one facet at a time)     */
/* ------------------------------------------------------------------ */

const isWrite = request => request.method !== 'GET' && request.method !== 'HEAD';
const RESULT_PATHS = new Set(['/', '/search', '/api/products']);
const isDetour = request => !isWrite(request) && !RESULT_PATHS.has(request.path);

const baselineOf = (initial = {}) => ({
  cart: (initial.cart ?? []).map(productId => ({ productId, qty: 1 })),
  wishlist: [...(initial.wishlist ?? [])],
  newsletterSignups: 0,
  productViews: [],
});

// The real app, except that every collateral trace is hidden unless it is the one named. The page, the search
// facts and the origin stay real, so exactly one backend check can be the one that sees the damage.
const collateralLens =
  (initial, { keepState = [], keepRequests = () => false }) =>
  app => ({
    origin: app.origin,
    state: () => {
      const real = app.state();
      return {
        ...real,
        ...baselineOf(initial),
        ...Object.fromEntries(keepState.map(key => [key, real[key]])),
      };
    },
    requests: () =>
      app
        .requests()
        .filter(request => (!isWrite(request) && !isDetour(request)) || keepRequests(request)),
  });

const stateLens = patch => app => ({
  origin: app.origin,
  state: () => patch(app.state()),
  requests: () => app.requests(),
});

const requestsLens = patch => app => ({
  origin: app.origin,
  state: () => app.state(),
  requests: () => patch(app.requests()),
});

const bothLens = (patchState, patchRequests) => app => ({
  origin: app.origin,
  state: () => patchState(app.state()),
  requests: () => patchRequests(app.requests()),
});

/* ------------------------------------------------------------------ */
/* Tampering with the real page (one facet at a time)                  */
/* ------------------------------------------------------------------ */

const COUNT_SELECTOR = { A: '#results p.count', B: 'p.found', C: '#results p.count' };
const TITLE_SELECTOR = { A: '#results .card h3 a', B: '.rows .row h3 a', C: '#results .tile h3 a' };

const tamper = (name, reason, run) => ({ name, reason, run });

const urlTamper = (name, reason, key, mode, value) =>
  tamper(name, reason, page =>
    page.evaluate(
      ([paramKey, paramMode, paramValue]) => {
        const url = new URL(location.href);
        if (paramMode === 'append') url.searchParams.append(paramKey, paramValue);
        else url.searchParams.set(paramKey, paramValue);
        history.replaceState(null, '', url.pathname + url.search);
      },
      [key, mode, value]
    )
  );

const sharedTampers = variant => [
  urlTamper('url-q', /URL query q/, 'q', 'set', 'zzz'),
  urlTamper('url-category', /URL category filter/, 'category', 'append', 'kitchen'),
  urlTamper('url-brand', /URL brand filter/, 'brand', 'append', 'torque'),
  urlTamper('url-maxPrice', /URL maxPrice/, 'maxPrice', 'set', '25'),
  urlTamper('url-sort', /URL sort/, 'sort', 'set', 'price_desc'),
  tamper('url-path', /page path/, page =>
    page.evaluate(() => history.replaceState(null, '', `/elsewhere${location.search}`))
  ),
  tamper('origin', /page origin/, page =>
    page.goto('data:text/html,<title>elsewhere</title><p>elsewhere</p>')
  ),
  tamper('count', /visible result count/, page =>
    page.evaluate(selector => {
      const element = document.querySelector(selector);
      element.textContent = element.textContent.replace(/\d+/, digits =>
        String(Number(digits) + 1)
      );
    }, COUNT_SELECTOR[variant])
  ),
  tamper('title-renamed', /rendered product titles/, page =>
    page.evaluate(selector => {
      const link = document.querySelector(selector);
      link.textContent = `${link.textContent} Deluxe`;
    }, TITLE_SELECTOR[variant])
  ),
  tamper('title-order', /rendered product titles/, page =>
    page.evaluate(selector => {
      const [first, second] = document.querySelectorAll(selector);
      const keep = first.textContent;
      first.textContent = second.textContent;
      second.textContent = keep;
    }, TITLE_SELECTOR[variant])
  ),
];

const TAMPERS = {
  A: [
    tamper('a-pill-removed', /active-filter pills/, page =>
      page.evaluate(() => document.querySelector('#results ul.pills li').remove())
    ),
    tamper('a-box-unticked', /ticked sidebar checkboxes/, page =>
      page.evaluate(() => {
        document.querySelector('#sidebar input[type="checkbox"]:checked').checked = false;
      })
    ),
    tamper('a-box-extra', /ticked sidebar checkboxes/, page =>
      page.evaluate(() => {
        document.querySelector('#sidebar input[type="checkbox"]:not(:checked)').checked = true;
      })
    ),
    tamper('a-price', /price select/, page =>
      page.evaluate(() => {
        const select = document.querySelector('#price');
        select.value = [...select.options].find(option => option.value !== select.value).value;
      })
    ),
    tamper('a-sort', /sort select/, page =>
      page.evaluate(() => {
        const select = document.querySelector('#sort');
        select.value = [...select.options].find(option => option.value !== select.value).value;
      })
    ),
    tamper('a-search-box', /search box text/, page =>
      page.evaluate(() => {
        document.querySelector('#site-search').value = 'zzz';
      })
    ),
    tamper('a-line-no-term', /does not mention the search term/, page =>
      page.evaluate(() => {
        const line = document.querySelector('#results p.count');
        line.textContent = line.textContent.replace(/(results?).*/, '$1');
      })
    ),
    tamper('a-line-extra-term', /mentions a search term that was not asked for/, page =>
      page.evaluate(() => {
        const line = document.querySelector('#results p.count');
        line.textContent = `${line.textContent} for “zzz”`;
      })
    ),
  ],
  B: [
    tamper('b-applied-replaced', /applied-options summary/, page =>
      page.evaluate(() => {
        document.querySelector('p.applied').textContent = 'Applied options: none';
      })
    ),
    tamper('b-q', /search field text/, page =>
      page.evaluate(() => {
        document.querySelector('#q').value = 'zzz';
      })
    ),
    tamper('b-dept', /department select/, page =>
      page.evaluate(() => {
        const select = document.querySelector('#dept');
        select.value = [...select.options].find(option => option.value !== select.value).value;
      })
    ),
    tamper('b-make', /manufacturer select/, page =>
      page.evaluate(() => {
        const select = document.querySelector('#make');
        select.value = [...select.options].find(option => option.value !== select.value).value;
      })
    ),
    tamper('b-cap', /highest-price field/, page =>
      page.evaluate(() => {
        document.querySelector('#cap').value = '999';
      })
    ),
    tamper('b-sort-radio', /checked sort radio/, page =>
      page.evaluate(() => {
        const other = [...document.querySelectorAll('input[name="sort"]')].find(
          input => !input.checked
        );
        other.checked = true;
      })
    ),
    ...[
      ['b-applied-extra-search', /names a search term nobody asked for/, ' search: “zzz”'],
      [
        'b-applied-extra-dept',
        /names a department nobody asked for/,
        ' department: kitchen & dining',
      ],
      ['b-applied-extra-make', /names a manufacturer nobody asked for/, ' manufacturer: torque'],
      ['b-applied-extra-cap', /names a price cap nobody asked for/, ' up to $99'],
    ].map(([name, reason, suffix]) =>
      tamper(name, reason, page =>
        page.evaluate(text => {
          const line = document.querySelector('p.applied');
          line.textContent = `${line.textContent}${text}`;
        }, suffix)
      )
    ),
  ],
  C: [
    tamper('c-chip-extra', /pressed filter chips/, page =>
      page.evaluate(() => {
        document
          .querySelector('#filters button.chip[aria-pressed="false"]:not([name="sort"])')
          .setAttribute('aria-pressed', 'true');
      })
    ),
    tamper('c-chip-released', /pressed filter chips/, page =>
      page.evaluate(() => {
        document
          .querySelector('#filters button.chip[aria-pressed="true"]:not([name="sort"])')
          .setAttribute('aria-pressed', 'false');
      })
    ),
    tamper('c-sort-chip-moved', /pressed order chip/, page =>
      page.evaluate(() => {
        const chips = [...document.querySelectorAll('#filters button.chip[name="sort"]')];
        const pressed = chips.find(chip => chip.getAttribute('aria-pressed') === 'true');
        const other = chips.find(chip => chip !== pressed);
        pressed.setAttribute('aria-pressed', 'false');
        other.setAttribute('aria-pressed', 'true');
      })
    ),
    tamper('c-sort-chip-released', /pressed order chip/, page =>
      page.evaluate(() => {
        document
          .querySelector('#filters button.chip[name="sort"][aria-pressed="true"]')
          .setAttribute('aria-pressed', 'false');
      })
    ),
    tamper('c-active-counter', /active-filter counter/, page =>
      page.evaluate(() => {
        document.querySelector('#filters .factive span').textContent = '9 filters on';
      })
    ),
    tamper('c-query-text', /search-term chip/, page =>
      page.evaluate(() => {
        document.querySelector('#results button.query-chip').textContent = 'Search: zzz';
      })
    ),
    tamper('c-query-removed', /search-term chip/, page =>
      page.evaluate(() => document.querySelector('#results button.query-chip').remove())
    ),
    tamper('c-query-added', /search-term chip/, page =>
      page.evaluate(() => {
        const chip = document.createElement('button');
        chip.className = 'query-chip';
        chip.textContent = 'Search: zzz';
        document.querySelector('#results .status-line').append(chip);
      })
    ),
  ],
};

const SAVED_TAMPER = {
  A: tamper('saved-off', /saved indicator of/, page =>
    page.evaluate(() =>
      document
        .querySelector('button.heart[aria-pressed="true"]')
        .setAttribute('aria-pressed', 'false')
    )
  ),
  B: tamper('saved-off', /saved indicator of/, page =>
    page.evaluate(() => {
      const button = [...document.querySelectorAll('button.later-btn')].find(
        candidate => candidate.textContent.trim() === 'Saved for later'
      );
      button.textContent = 'Save for later';
    })
  ),
  C: tamper('saved-off', /saved indicator of/, page =>
    page.evaluate(() =>
      document
        .querySelector('button.keep[aria-pressed="true"]')
        .setAttribute('aria-pressed', 'false')
    )
  ),
};

const tampersFor = scenario => {
  const { variant } = scenario;
  const byName = new Map(
    [...sharedTampers(variant), ...TAMPERS[variant], SAVED_TAMPER[variant]].map(item => [
      item.name,
      item,
    ])
  );
  const names = TAMPER_PLAN[scenario.id] ?? [];
  return names.map(name => {
    const found = byName.get(name);
    if (!found) throw new Error(`tamper ${name} does not exist for variant ${variant}`);
    return found;
  });
};

const SHARED_NAMES = [
  'url-q',
  'url-category',
  'url-brand',
  'url-maxPrice',
  'url-sort',
  'url-path',
  'origin',
  'count',
  'title-renamed',
  'title-order',
];

const TAMPER_PLAN = {
  'catalog-a-quoted-search-category': [
    ...SHARED_NAMES,
    'a-pill-removed',
    'a-box-unticked',
    'a-box-extra',
    'a-price',
    'a-sort',
    'a-search-box',
    'a-line-no-term',
  ],
  'catalog-a-brand-budget': ['a-line-extra-term'],
  'catalog-b-phrase-category-rating': [
    ...SHARED_NAMES,
    'b-applied-replaced',
    'b-q',
    'b-dept',
    'b-make',
    'b-cap',
    'b-sort-radio',
    'b-applied-extra-make',
    'b-applied-extra-cap',
  ],
  'catalog-b-inputs-brand-budget': ['b-applied-extra-search', 'b-applied-extra-dept'],
  'catalog-c-dialog-search-brands': [
    ...SHARED_NAMES,
    'c-chip-extra',
    'c-chip-released',
    'c-sort-chip-moved',
    'c-sort-chip-released',
    'c-active-counter',
    'c-query-text',
    'c-query-removed',
  ],
  'catalog-c-outdoor-budget-cheapest': ['c-query-added'],
  'catalog-c-already-saved-keyboard': ['saved-off'],
  'catalog-a-brand-priciest-first-with-cart': ['saved-off'],
  'catalog-b-kitchen-under-forty-saved': ['saved-off'],
};

/* ------------------------------------------------------------------ */
/* Control plans: the correct end state and plausible wrong ones       */
/* ------------------------------------------------------------------ */

// Wrong end states marked "same products" return exactly the right titles in the right order, so only the
// page's own filter indicators, the URL and the backend's record of the search can tell them apart.
const PLANS = {
  'catalog-a-quoted-search-category': {
    good: { q: 'bluetooth', category: ['audio'] },
    wrong: [
      {
        name: 'filters by the Sonique brand instead of the audio category',
        plan: { q: 'bluetooth', brand: ['sonique'] },
      },
      { name: 'searches but forgets the category filter', plan: { q: 'bluetooth' } },
      {
        name: 'adds a price cap nobody asked for (same products)',
        same: true,
        plan: { q: 'bluetooth', category: ['audio'], maxPrice: 200 },
      },
      {
        name: 'sorts by price although nobody asked (same products)',
        same: true,
        plan: { q: 'bluetooth', category: ['audio'], sort: 'price_asc' },
      },
    ],
  },
  'catalog-a-brand-budget': {
    good: { brand: ['lumio'], maxPrice: 50 },
    wrong: [
      { name: 'picks the brand but leaves the price cap off', plan: { brand: ['lumio'] } },
      {
        name: 'caps the price but picks the wrong brand',
        plan: { brand: ['hearthly'], maxPrice: 50 },
      },
      {
        name: 'sorts by price although nobody asked (same products)',
        same: true,
        plan: { brand: ['lumio'], maxPrice: 50, sort: 'price_asc' },
      },
      {
        name: 'also types the brand into the search box (same products)',
        same: true,
        plan: { q: 'lumio', brand: ['lumio'], maxPrice: 50 },
      },
    ],
  },
  'catalog-a-unquoted-phrase-sort': {
    good: { q: 'steel', sort: 'price_asc' },
    wrong: [
      { name: 'searches the right term but never sorts', plan: { q: 'steel' } },
      {
        name: 'sorts and also narrows to a category nobody asked for',
        plan: { q: 'steel', category: ['fitness'], sort: 'price_asc' },
      },
      {
        name: 'adds a price cap nobody asked for (same products)',
        same: true,
        plan: { q: 'steel', sort: 'price_asc', maxPrice: 200 },
      },
    ],
  },
  'catalog-a-stale-rerender': {
    good: { q: 'wireless', brand: ['aerodyne'], maxPrice: 100 },
    wrong: [
      { name: 'forgets the brand filter', plan: { q: 'wireless', maxPrice: 100 } },
      {
        name: 'forgets the price cap although the results look the same',
        same: true,
        plan: { q: 'wireless', brand: ['aerodyne'] },
      },
      {
        name: 'sorts by rating although nobody asked (same products)',
        same: true,
        plan: { q: 'wireless', brand: ['aerodyne'], maxPrice: 100, sort: 'rating' },
      },
    ],
  },
  'catalog-b-phrase-category-rating': {
    good: { q: 'wireless', category: ['office'], sort: 'rating' },
    wrong: [
      { name: 'keeps the default order', plan: { q: 'wireless', category: ['office'] } },
      { name: 'forgets the department select', plan: { q: 'wireless', sort: 'rating' } },
      {
        name: 'types a price ceiling nobody asked for (same products)',
        same: true,
        plan: { q: 'wireless', category: ['office'], sort: 'rating', maxPrice: 200 },
      },
    ],
  },
  'catalog-b-inputs-brand-budget': {
    good: { brand: ['pinecrest'], maxPrice: 30, sort: 'price_asc' },
    wrong: [
      { name: 'keeps the default order', plan: { brand: ['pinecrest'], maxPrice: 30 } },
      {
        name: 'picks another brand',
        plan: { brand: ['trailmark'], maxPrice: 30, sort: 'price_asc' },
      },
      {
        name: 'types a looser price cap that returns the same products',
        same: true,
        plan: { brand: ['pinecrest'], maxPrice: 50, sort: 'price_asc' },
      },
      {
        name: 'orders by rating, which happens to give the same order',
        same: true,
        plan: { brand: ['pinecrest'], maxPrice: 30, sort: 'rating' },
      },
      {
        name: 'also types the brand into the search box (same products)',
        same: true,
        plan: { q: 'pinecrest', brand: ['pinecrest'], maxPrice: 30, sort: 'price_asc' },
      },
    ],
  },
  'catalog-b-missing-search-term': { good: {}, wrong: [] },
  'catalog-c-dialog-search-brands': {
    good: { q: 'bluetooth', brand: ['lumio', 'sonique'] },
    wrong: [
      {
        name: 'presses only one of the two brand chips',
        plan: { q: 'bluetooth', brand: ['sonique'] },
      },
      {
        name: 'presses one brand chip too many',
        plan: { q: 'bluetooth', brand: ['lumio', 'sonique', 'northwave'] },
      },
      {
        name: 'also presses a price chip (same products)',
        same: true,
        plan: { q: 'bluetooth', brand: ['lumio', 'sonique'], maxPrice: 100 },
      },
      {
        name: 'also presses an order chip (same products)',
        same: true,
        plan: { q: 'bluetooth', brand: ['lumio', 'sonique'], sort: 'price_asc' },
      },
    ],
  },
  'catalog-c-outdoor-budget-cheapest': {
    good: { category: ['outdoor'], maxPrice: 50, sort: 'price_asc' },
    wrong: [
      { name: 'leaves the order on recommended', plan: { category: ['outdoor'], maxPrice: 50 } },
      {
        name: 'presses the wrong collection chip',
        plan: { category: ['fitness'], maxPrice: 50, sort: 'price_asc' },
      },
      {
        name: 'also searches for the word outdoor (same products)',
        same: true,
        plan: { q: 'outdoor', category: ['outdoor'], maxPrice: 50, sort: 'price_asc' },
      },
    ],
  },
  'catalog-c-already-saved-keyboard': {
    good: { q: 'mechanical keyboard' },
    wrong: [
      { name: 'searches a looser term that also lists a desk converter', plan: { q: 'keyboard' } },
      {
        name: 'filters the right search down to a brand nobody asked for (same products)',
        same: true,
        plan: { q: 'mechanical keyboard', brand: ['lumio'] },
      },
      {
        name: 'searches a shorter term that lists the same keyboard',
        same: true,
        plan: { q: 'mechanical' },
      },
      {
        name: 'also presses a collection chip (same products)',
        same: true,
        plan: { q: 'mechanical keyboard', category: ['office'] },
      },
      {
        name: 'also presses an order chip (same products)',
        same: true,
        plan: { q: 'mechanical keyboard', sort: 'rating' },
      },
    ],
  },
  'catalog-a-brand-priciest-first-with-cart': {
    good: { brand: ['sonique'], sort: 'price_desc' },
    wrong: [
      {
        name: 'picks the brand but orders cheapest first',
        plan: { brand: ['sonique'], sort: 'price_asc' },
      },
      { name: 'orders most expensive first but picks no brand', plan: { sort: 'price_desc' } },
      {
        name: 'also types the brand into the search box (same products)',
        same: true,
        plan: { q: 'sonique', brand: ['sonique'], sort: 'price_desc' },
      },
      {
        name: 'caps the price at $200, which drops the dearest product',
        plan: { brand: ['sonique'], sort: 'price_desc', maxPrice: 200 },
      },
    ],
  },
  'catalog-b-kitchen-under-forty-saved': {
    good: { category: ['kitchen'], brand: ['hearthly'], maxPrice: 40 },
    wrong: [
      {
        name: 'forgets the department (same products)',
        same: true,
        plan: { brand: ['hearthly'], maxPrice: 40 },
      },
      {
        name: 'types a looser ceiling that returns the same products',
        same: true,
        plan: { category: ['kitchen'], brand: ['hearthly'], maxPrice: 50 },
      },
      { name: 'forgets the ceiling', plan: { category: ['kitchen'], brand: ['hearthly'] } },
      { name: 'forgets the manufacturer', plan: { category: ['kitchen'], maxPrice: 40 } },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* Verdicts and groups: one browser session, several verdicts          */
/* ------------------------------------------------------------------ */

const accept = (name, result, view) => ({ name, kind: 'pass', result, view });
const reject = (name, result, reason, view) => ({ name, kind: 'fail', result, reason, view });

const resolvedNavigationResult = (goal, effect = 'applied') =>
  completedResult(goal, {
    ledger: [
      ledgerEntry(1, 'CLICK'),
      ledgerEntry(2, 'NAVIGATE', {
        status: 'navigated',
        effect: 'uncertain',
        navigated: true,
        afterDocumentId: 'doc_abcdefabcdef',
        afterUrl: 'http://127.0.0.1/results',
      }),
    ],
    lastEffect: 'uncertain',
    completion: completion({
      actionsExecuted: 2,
      resolvedUncertain: [{ seq: 2, by: effect === 'none' ? 'caller' : 'transition', effect }],
      verifiedSnapshot: { ...completion().verifiedSnapshot, documentId: 'doc_abcdefabcdef' },
    }),
  });

const completedVerdicts = scenario => {
  const { goal } = scenario;
  const withCompletion = over => completedResult(goal, { completion: completion(over) });
  return [
    accept('the achieved state with a correct completed result is accepted', completedResult(goal)),
    accept(
      'a stale rejection and a warning in an otherwise good run are accepted',
      completedResult(goal, {
        warnings: [{ code: 'LOCATION_UNVERIFIED', message: 'location not confirmed' }],
        ledger: [
          ledgerEntry(1, 'CLICK', { status: 'rejected_stale', effect: 'none' }),
          ledgerEntry(2, 'CLICK'),
          ledgerEntry(3, 'SET_CHECKED'),
        ],
        lastEffect: 'applied',
      })
    ),
    accept(
      'a confirmed navigation with raw uncertain effect and transition resolution is accepted',
      resolvedNavigationResult(goal)
    ),
    accept(
      'raw uncertainty resolved none is accepted when another action was applied',
      resolvedNavigationResult(goal, 'none')
    ),
    accept(
      'an uncertain-only write resolved by its observed postcondition is accepted',
      completedResult(goal, {
        ledger: [ledgerEntry(1, 'FILL', { status: 'uncertain', effect: 'uncertain' })],
        lastEffect: 'uncertain',
        completion: completion({
          actionsExecuted: 1,
          resolvedUncertain: [{ seq: 1, by: 'postcondition', effect: 'applied' }],
        }),
      })
    ),
    reject(
      'resolved navigation without resolution is rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.completion.resolvedUncertain = [];
        return wrong;
      })(),
      /uncertain entries require/
    ),
    reject(
      'resolution of another seq is rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.completion.resolvedUncertain[0].seq = 9;
        return wrong;
      })(),
      /uncertain entries require/
    ),
    reject(
      'duplicate resolutions are rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.completion.resolvedUncertain.push({ ...wrong.completion.resolvedUncertain[0] });
        return wrong;
      })(),
      /uncertain entries require/
    ),
    reject(
      'an uncertain resolution effect is rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.completion.resolvedUncertain[0].effect = 'uncertain';
        return wrong;
      })(),
      /uncertain entries require/
    ),
    reject(
      'an unsupported resolution basis is rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.completion.resolvedUncertain[0].by = 'model';
        return wrong;
      })(),
      /uncertain entries require/
    ),
    reject(
      'a resolved entry left in result unresolved is rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.unresolvedUncertain = [2];
        return wrong;
      })(),
      /result\.unresolvedUncertain/
    ),
    reject(
      'a resolved entry left in completion unresolved is rejected',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.completion.unresolvedUncertain = [2];
        return wrong;
      })(),
      /completion\.unresolvedUncertain/
    ),
    reject(
      'raw lastEffect must not be projected to applied after resolution',
      (() => {
        const wrong = resolvedNavigationResult(goal);
        wrong.lastEffect = 'applied';
        return wrong;
      })(),
      /result\.lastEffect differs/
    ),
    reject(
      'orphan resolution on an applied entry is rejected',
      completedResult(goal, {
        completion: completion({
          resolvedUncertain: [{ seq: 1, by: 'transition', effect: 'applied' }],
        }),
      }),
      /refers to an entry that was not uncertain/
    ),
    reject('a blocked result is rejected', blockedResult(goal), /result\.status/),
    reject(
      'an answer on a state-change goal is rejected',
      completedResult(goal, {
        answer: { value: 'YES', confidence: 0.9 },
        completion: completion({ mode: 'answered', answered: true }),
      }),
      /result\.answer/
    ),
    reject(
      'an answer alone is rejected even when the completion is clean',
      completedResult(goal, { answer: { value: 'YES', confidence: 0.9 } }),
      /result\.answer/
    ),
    reject(
      'completion mode noop is rejected',
      completedResult(goal, {
        completion: completion({ mode: 'noop', effected: false, actionsExecuted: 0 }),
      }),
      /completion\.mode/
    ),
    reject(
      'an altered goal is rejected',
      completedResult(`${goal} Also do something else.`),
      /result\.goal/
    ),
    reject('no result object at all is rejected', null, /no result object/),
    reject(
      'a ledger that is not a list is rejected',
      completedResult(goal, { ledger: 'none' }),
      /result\.ledger must be an array/
    ),
    reject(
      'a completed result without a completion record is rejected',
      baseResult(goal, { status: 'completed' }),
      /result\.completion/
    ),
    reject(
      'an unresolved uncertain effect is rejected',
      completedResult(goal, { lastEffect: 'uncertain', unresolvedUncertain: [2] }),
      /unresolvedUncertain/
    ),
    reject(
      'an unresolved uncertain list alone is rejected',
      completedResult(goal, { unresolvedUncertain: [2] }),
      /result\.unresolvedUncertain/
    ),
    reject(
      'an uncertain last effect alone is rejected',
      completedResult(goal, { lastEffect: 'uncertain' }),
      /result\.lastEffect differs from the newest ledger effect/
    ),
    reject(
      'a ledger entry whose status is uncertain is rejected',
      completedResult(goal, {
        ledger: [
          ledgerEntry(1, 'CLICK'),
          ledgerEntry(2, 'CLICK', { status: 'uncertain', effect: 'applied' }),
        ],
      }),
      /invalid status\/effect pair/
    ),
    reject(
      'a ledger entry whose effect is uncertain is rejected',
      completedResult(goal, {
        ledger: [
          ledgerEntry(1, 'CLICK'),
          ledgerEntry(2, 'CLICK', { status: 'applied', effect: 'uncertain' }),
        ],
      }),
      /invalid status\/effect pair/
    ),
    reject(
      'a completion that was not effected is rejected',
      withCompletion({ effected: false }),
      /completion\.effected/
    ),
    reject(
      'a completion that claims an answer is rejected',
      withCompletion({ answered: true }),
      /completion\.answered/
    ),
    reject(
      'a completion with unresolved uncertain entries is rejected',
      withCompletion({ unresolvedUncertain: [2] }),
      /completion\.unresolvedUncertain/
    ),
    reject(
      'a completion that executed no action is rejected',
      withCompletion({ actionsExecuted: 0 }),
      /actionsExecuted/
    ),
    reject(
      'a completion with no action count is rejected',
      withCompletion({ actionsExecuted: undefined }),
      /actionsExecuted/
    ),
    reject(
      'an empty ledger is rejected',
      completedResult(goal, { ledger: [], lastEffect: 'none' }),
      /no applied or navigated command/
    ),
    reject(
      'a ledger without any applied command is rejected',
      completedResult(goal, {
        ledger: [
          ledgerEntry(1, 'CLICK', { status: 'noop_already_satisfied', effect: 'none' }),
          ledgerEntry(2, 'CLICK', { status: 'rejected_stale', effect: 'none' }),
        ],
        lastEffect: 'none',
      }),
      /no applied or navigated command/
    ),
  ];
};

const COLLATERAL_STEPS = [
  'cart',
  'wishlist',
  'newsletter',
  'rejectedNewsletter',
  'productPage',
  'infoPage',
  'unknownPage',
];

// Direct backend effects, then each backend check alone is shown the damage it exists to see.
const collateralViewGroup = (scenario, base, claim) => {
  const initial = scenario.initial ?? {};
  const lens = options => collateralLens(initial, options);
  return {
    ...base,
    id: `${scenario.id}:collateral-facets`,
    drive: async (driver, { app }) => {
      await driver.apply(PLANS[scenario.id].good);
      for (const step of COLLATERAL_STEPS) await RAW_EFFECTS[step](app, scenario.variant);
    },
    verdicts: [
      reject(
        'a write request with no state change (rejected signup) is rejected',
        claim,
        /write requests/,
        lens({ keepRequests: isWrite })
      ),
      reject(
        'a changed cart with a silent request log is rejected',
        claim,
        /backend cart/,
        lens({ keepState: ['cart'] })
      ),
      reject(
        'a changed wishlist with a silent request log is rejected',
        claim,
        /backend wishlist/,
        lens({ keepState: ['wishlist'] })
      ),
      reject(
        'a newsletter signup with a silent request log is rejected',
        claim,
        /newsletter signups/,
        lens({ keepState: ['newsletterSignups'] })
      ),
      reject(
        'a product page view with a silent request log is rejected',
        claim,
        /product detail views/,
        lens({ keepState: ['productViews'] })
      ),
      reject(
        'a product page request with no recorded view is rejected',
        claim,
        /visits to pages the goal never needs/,
        lens({ keepRequests: request => request.path.startsWith('/product/') })
      ),
      reject(
        'an info page request is rejected',
        claim,
        /visits to pages the goal never needs/,
        lens({ keepRequests: request => request.path.startsWith('/info/') })
      ),
      reject(
        'a request for a route the app does not have is rejected',
        claim,
        /visits to pages the goal never needs/,
        lens({ keepRequests: request => request.path === '/cart' })
      ),
      accept(
        'the same run with every collateral trace hidden is accepted (the lens itself hides nothing else)',
        completedResult(scenario.goal),
        lens({})
      ),
    ],
  };
};

// The page is right and every collateral trace is clean; only one fact of the backend's own record of the
// search is wrong at a time.
const backendViewGroup = (scenario, base, claim) => {
  const patchLast = patch =>
    stateLens(state => {
      const searches = [...state.searches];
      searches[searches.length - 1] = { ...searches.at(-1), ...patch(searches.at(-1)) };
      return { ...state, searches };
    });
  const tamperIds = patch =>
    stateLens(state => ({ ...state, lastResultIds: patch(state.lastResultIds) }));
  return {
    ...base,
    id: `${scenario.id}:backend-facets`,
    drive: driver => driver.apply(PLANS[scenario.id].good),
    verdicts: [
      reject(
        'a backend that recorded no search at all is rejected',
        claim,
        /recorded no search/,
        stateLens(state => ({ ...state, searches: [] }))
      ),
      reject(
        'a recorded search for another term is rejected',
        claim,
        /backend last search/,
        patchLast(() => ({ q: 'zzz' }))
      ),
      reject(
        'a recorded search with another category is rejected',
        claim,
        /backend last search/,
        patchLast(last => ({
          filters: { ...last.filters, category: [...last.filters.category, 'kitchen'] },
        }))
      ),
      reject(
        'a recorded search with another brand is rejected',
        claim,
        /backend last search/,
        patchLast(last => ({
          filters: { ...last.filters, brand: [...last.filters.brand, 'torque'] },
        }))
      ),
      reject(
        'a recorded search with another price cap is rejected',
        claim,
        /backend last search/,
        patchLast(last => ({
          filters: { ...last.filters, maxPrice: last.filters.maxPrice === 25 ? 50 : 25 },
        }))
      ),
      reject(
        'a recorded search with another order is rejected',
        claim,
        /backend last search/,
        patchLast(last => ({ sort: last.sort === 'rating' ? 'price_asc' : 'rating' }))
      ),
      reject(
        'a recorded search with another result count is rejected',
        claim,
        /backend last search/,
        patchLast(last => ({ count: last.count + 1 }))
      ),
      reject(
        'result ids in another order (or another product) are rejected',
        claim,
        /backend lastResultIds/,
        tamperIds(ids => (ids.length > 1 ? [...ids].reverse() : ['p99']))
      ),
      reject(
        'result ids with an extra product are rejected',
        claim,
        /backend lastResultIds/,
        tamperIds(ids => [...ids, 'p99'])
      ),
      reject(
        'result ids missing the last product are rejected',
        claim,
        /backend lastResultIds/,
        tamperIds(ids => ids.slice(0, -1))
      ),
      accept(
        'the same run seen through an untouched lens is accepted',
        completedResult(scenario.goal),
        stateLens(state => state)
      ),
    ],
  };
};

const SEARCH_BASE = { filters: { category: [], brand: [], maxPrice: null }, sort: 'relevance' };

// Under the stale fault every search the backend ever saw must be one the goal could have asked for.
const historyViewGroup = (scenario, base, claim) => {
  const prepend = entry => stateLens(state => ({ ...state, searches: [entry, ...state.searches] }));
  const wrongEntry = (name, patch, reason) =>
    reject(
      `an earlier search ${name} is rejected`,
      claim,
      reason,
      prepend({ ...SEARCH_BASE, q: 'wireless', count: 3, ...patch })
    );
  return {
    ...base,
    id: `${scenario.id}:history-facets`,
    drive: driver => driver.apply(PLANS[scenario.id].good),
    verdicts: [
      accept(
        'earlier partial searches that stay inside the goal are accepted',
        completedResult(scenario.goal),
        prepend({
          ...SEARCH_BASE,
          q: 'wire',
          filters: { category: [], brand: ['aerodyne'], maxPrice: 100 },
          count: 2,
        })
      ),
      accept(
        'an earlier empty search is accepted',
        completedResult(scenario.goal),
        prepend({ ...SEARCH_BASE, q: '', count: 30 })
      ),
      wrongEntry('for another term', { q: 'headphones' }, /backend search #1.*never named/),
      wrongEntry(
        'with a category nobody asked for',
        { filters: { category: ['office'], brand: [], maxPrice: null } },
        /backend search #1.*category office/
      ),
      wrongEntry(
        'with a brand nobody asked for',
        { filters: { category: [], brand: ['sonique'], maxPrice: null } },
        /backend search #1.*brand sonique/
      ),
      wrongEntry(
        'with a price cap nobody asked for',
        { filters: { category: [], brand: [], maxPrice: 25 } },
        /backend search #1.*capped the price at 25/
      ),
      wrongEntry(
        'with an order nobody asked for',
        { sort: 'rating' },
        /backend search #1.*sorted by rating/
      ),
    ],
  };
};

const completedGroups = (scenario, plan) => {
  const base = {
    scenario,
    variant: scenario.variant,
    initial: scenario.initial,
    faults: scenario.faults,
  };
  const claim = completedResult(scenario.goal);
  const groups = [
    {
      ...base,
      id: `${scenario.id}:achieved`,
      drive: driver => driver.apply(plan.good),
      verdicts: completedVerdicts(scenario),
    },
    {
      ...base,
      id: `${scenario.id}:initial`,
      verdicts: [
        reject('the untouched initial state with a success-claiming result is rejected', claim),
      ],
    },
    ...plan.wrong.map((wrong, index) => ({
      ...base,
      id: `${scenario.id}:wrong-${index + 1}`,
      drive: driver => driver.apply(wrong.plan),
      verdicts: [reject(`wrong end state is rejected: ${wrong.name}`, claim)],
    })),
    {
      ...base,
      id: `${scenario.id}:collateral`,
      drive: async driver => {
        await driver.apply(plan.good);
        await driver.addToCart();
      },
      verdicts: [
        reject(
          'right filters but a cart write on the way is rejected',
          claim,
          /write requests|backend cart/
        ),
      ],
    },
    collateralViewGroup(scenario, base, claim),
    backendViewGroup(scenario, base, claim),
    ...tampersFor(scenario).map(item => ({
      ...base,
      id: `${scenario.id}:tamper-${item.name}`,
      drive: async (driver, { page }) => {
        await driver.apply(plan.good);
        await item.run(page);
      },
      verdicts: [
        reject(
          `the right end state with only this facet wrong is rejected: ${item.name}`,
          claim,
          item.reason
        ),
      ],
    })),
  ];
  return groups.concat(extraGroups(scenario, plan, base, claim));
};

const extraGroups = (scenario, plan, base, claim) => {
  if (scenario.id === 'catalog-a-stale-rerender') {
    return [
      historyViewGroup(scenario, base, claim),
      {
        ...base,
        id: `${scenario.id}:history-polluted`,
        drive: async (driver, { page }) => {
          await toggleVerified(page, /^Office/, 'category', 'office', true);
          await settle(page, 'A');
          await toggleVerified(page, /^Office/, 'category', 'office', false);
          await settle(page, 'A');
          await driver.apply(plan.good);
        },
        verdicts: [
          reject(
            'a wrong filter touched and undone along the way is rejected under the stale fault',
            claim,
            /backend search #\d+/
          ),
        ],
      },
      {
        ...base,
        id: `${scenario.id}:fault-inactive`,
        faults: {},
        drive: driver => driver.apply(plan.good),
        verdicts: [
          reject(
            'the correct end state on a page that never re-renders is rejected: the fault must be active',
            claim,
            /stale re-render fault was not active/
          ),
        ],
      },
    ];
  }
  if (scenario.id === 'catalog-c-already-saved-keyboard') {
    return [
      {
        ...base,
        id: `${scenario.id}:saved-toggled-off`,
        drive: async driver => {
          await driver.apply(plan.good);
          await driver.toggleSaved();
        },
        verdicts: [
          reject(
            'toggling the saved keyboard off is rejected',
            claim,
            /write requests|backend wishlist/
          ),
        ],
      },
      {
        ...base,
        id: `${scenario.id}:saved-toggled-twice`,
        drive: async driver => {
          await driver.apply(plan.good);
          await driver.toggleSaved();
          await driver.toggleSaved();
        },
        verdicts: [
          reject(
            'toggling the saved keyboard off and on again ends in the same state but is rejected: a write happened',
            claim,
            /write requests/
          ),
        ],
      },
    ];
  }
  return [];
};

const needsInputVerdicts = (scenario, asked) => {
  const { goal } = scenario;
  const fakeSearch = { ...SEARCH_BASE, q: 'item', count: 1 };
  return [
    accept(
      'the untouched page with a needs_input result naming the missing value is accepted',
      asked
    ),
    accept(
      'a harmless read and a rejected typing attempt in the ledger are accepted',
      needsInputResult(goal, {
        ledger: [
          ledgerEntry(1, 'READ'),
          ledgerEntry(2, 'FILL', { status: 'rejected_stale', effect: 'none' }),
        ],
      })
    ),
    accept(
      'a requirement that names the missing input rather than a choice is accepted',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, reason: 'input_missing' }] })
    ),
    reject(
      'the untouched initial state with a success-claiming completed result is rejected',
      completedResult(goal),
      /result\.status/
    ),
    reject(
      'a needs_input result without requirements is rejected',
      needsInputResult(goal, { requirements: [] }),
      /requirements/
    ),
    reject(
      'a needs_input result whose requirements are not a list is rejected',
      needsInputResult(goal, { requirements: 'search term' }),
      /requirements/
    ),
    reject(
      'a requirement of the wrong kind is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, kind: 'sensitive_input' }] }),
      /kind argument/
    ),
    reject(
      'a requirement that blames a resolver is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, reason: 'resolver_refused' }] }),
      /reason/
    ),
    reject(
      'a requirement that blames the input binding is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, reason: 'input_not_bound' }] }),
      /reason/
    ),
    reject(
      'a requirement for another operation is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, operation: 'CLICK' }] }),
      /requirement\.operation/
    ),
    reject(
      'a requirement for another slot is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, slot: 'option' }] }),
      /requirement\.slot/
    ),
    reject(
      'a requirement without a description is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, description: '  ' }] }),
      /requirement\.description/
    ),
    reject(
      'a requirement whose description is not text is rejected',
      needsInputResult(goal, { requirements: [{ ...REQUIREMENT, description: undefined }] }),
      /requirement\.description/
    ),
    reject(
      'a checkpoint that is not paused for input is rejected',
      needsInputResult(goal, {
        checkpoint: { ...asked.checkpoint, pending: { kind: 'uncertain_effect', entries: [1] } },
      }),
      /checkpoint\.pending\.kind/
    ),
    reject(
      'a needs_input result without a checkpoint is rejected',
      needsInputResult(goal, { checkpoint: undefined }),
      /checkpoint\.pending\.kind/
    ),
    reject(
      'a ledger that typed a value is rejected',
      needsInputResult(goal, { ledger: [ledgerEntry(1, 'FILL')], lastEffect: 'applied' }),
      /typed value or a submit/
    ),
    reject(
      'a ledger that submitted something is rejected',
      needsInputResult(goal, { ledger: [ledgerEntry(1, 'SUBMIT')], lastEffect: 'applied' }),
      /typed value or a submit/
    ),
    reject(
      'a ledger whose typing may or may not have happened is rejected',
      needsInputResult(goal, {
        ledger: [ledgerEntry(1, 'FILL', { status: 'uncertain', effect: 'uncertain' })],
        lastEffect: 'uncertain',
      }),
      /uncertain entries|typed value or a submit/
    ),
    reject(
      'a paused result that also carries a completion is rejected',
      needsInputResult(goal, { completion: completion() }),
      /must not carry result\.completion/
    ),
    reject(
      'a paused result that also carries an answer is rejected',
      needsInputResult(goal, { answer: { value: 'YES', confidence: 0.9 } }),
      /must not carry result\.answer/
    ),
    reject(
      'a paused result with an altered goal is rejected',
      needsInputResult(`${goal} Also do something else.`),
      /result\.goal/
    ),
    reject(
      'a paused result with an unresolved uncertain list is rejected',
      needsInputResult(goal, { unresolvedUncertain: [1] }),
      /result\.unresolvedUncertain/
    ),
    reject('a blocked result is rejected', blockedResult(goal), /result\.status/),
    reject(
      'an awaiting_approval result is rejected',
      baseResult(goal, { status: 'awaiting_approval' }),
      /result\.status/
    ),
    reject(
      'a recorded search with a silent request log is rejected',
      asked,
      /backend searches/,
      stateLens(state => ({ ...state, searches: [fakeSearch] }))
    ),
    reject(
      'a search request with no recorded search is rejected',
      asked,
      /search requests/,
      requestsLens(requests => [
        ...requests,
        { seq: 99, method: 'GET', path: '/search', query: { q: 'item' }, bodySummary: null },
      ])
    ),
  ];
};

const needsInputGroups = scenario => {
  const { goal } = scenario;
  const base = {
    scenario,
    variant: scenario.variant,
    initial: scenario.initial,
    faults: scenario.faults,
  };
  const asked = needsInputResult(goal);
  const hideSearches = bothLens(
    state => ({ ...state, searches: [] }),
    requests => requests
  );
  return [
    {
      ...base,
      id: `${scenario.id}:achieved`,
      verdicts: needsInputVerdicts(scenario, asked),
    },
    {
      ...base,
      id: `${scenario.id}:wrong-search-issued`,
      drive: driver => driver.apply({ q: 'item', sort: 'rating' }),
      verdicts: [
        reject(
          'inventing a search term and running the search is rejected',
          asked,
          /backend searches/
        ),
        reject(
          'a search request is rejected even when the recorded searches are empty',
          asked,
          /search requests/,
          hideSearches
        ),
      ],
    },
    {
      ...base,
      id: `${scenario.id}:wrong-typed-not-submitted`,
      drive: driver => driver.typeOnly('item'),
      verdicts: [
        reject(
          'typing an invented term without submitting is rejected',
          asked,
          /search field text/
        ),
      ],
    },
    {
      ...base,
      id: `${scenario.id}:wrong-path`,
      drive: (_driver, { page }) =>
        page.evaluate(() => history.replaceState(null, '', '/search?q=')),
      verdicts: [
        reject(
          'a page that left the home page with no other trace is rejected',
          asked,
          /page path/
        ),
      ],
    },
    {
      ...base,
      id: `${scenario.id}:collateral`,
      drive: driver => driver.addToCart(),
      verdicts: [
        reject('a basket write while paused is rejected', asked, /write requests|backend cart/),
      ],
    },
    {
      ...base,
      id: `${scenario.id}:collateral-facets`,
      drive: async (_driver, { app }) => {
        for (const step of COLLATERAL_STEPS) await RAW_EFFECTS[step](app, scenario.variant);
      },
      verdicts: [
        reject(
          'a paused run that left a cart change behind is rejected',
          asked,
          /backend cart/,
          collateralLens({}, { keepState: ['cart'] })
        ),
        reject(
          'a paused run that visited a product page is rejected',
          asked,
          /visits to pages the goal never needs/,
          collateralLens({}, { keepRequests: request => request.path.startsWith('/product/') })
        ),
      ],
    },
  ];
};

export function buildGroups() {
  const groups = [];
  for (const scenario of scenarios) {
    const plan = PLANS[scenario.id];
    if (!plan) throw new Error(`no control plan for scenario ${scenario.id}`);
    groups.push(
      ...(scenario.expectStatus === 'needs_input'
        ? needsInputGroups(scenario)
        : completedGroups(scenario, plan))
    );
  }
  for (const id of [...Object.keys(PLANS), ...Object.keys(TAMPER_PLAN)]) {
    if (!scenarios.some(scenario => scenario.id === id)) {
      throw new Error(`control plan ${id} has no scenario`);
    }
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Structure checks: what the scenarios are, without a browser         */
/* ------------------------------------------------------------------ */

const quotedLiterals = text => [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]);

const leavesOf = (value, out = []) => {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(item => leavesOf(item, out));
  }
  return out;
};

export function structureChecks(list = scenarios, plans = PLANS) {
  const checks = [];
  const add = (name, ok, detail = '') =>
    checks.push({ id: `structure :: ${name}`, ok: Boolean(ok), message: detail });
  const apps = { catalog: describe() };
  const ids = list.map(scenario => scenario.id);
  add('scenario ids are unique', new Set(ids).size === ids.length);
  const goals = list.map(scenario => scenario.goal.trim().toLowerCase());
  add('every goal is different', new Set(goals).size === goals.length);
  add(
    'all three variants are covered',
    ['A', 'B', 'C'].every(variant => list.some(scenario => scenario.variant === variant))
  );
  add(
    'some scenario starts from a non-default state',
    list.some(scenario => Object.keys(scenario.initial ?? {}).length > 0)
  );
  add(
    'some scenario starts with a filled cart',
    list.some(scenario => (scenario.initial?.cart ?? []).length > 0)
  );
  add(
    'some scenario runs under a fault',
    list.some(scenario => Object.keys(scenario.faults ?? {}).length > 0)
  );
  add(
    'some scenario expects a pause for input',
    list.some(scenario => scenario.expectStatus === 'needs_input')
  );
  add(
    'some scenario takes its data from inputs',
    list.some(scenario => leavesOf(scenario.inputs).length > 0)
  );
  for (const scenario of list) {
    const verdict = validateScenario(scenario, { apps });
    add(`${scenario.id} passes validateScenario`, verdict.ok, verdict.errors.join('; '));
    add(
      `${scenario.id} names its variant in its id`,
      scenario.id.startsWith(`catalog-${scenario.variant.toLowerCase()}-`)
    );
    add(
      `${scenario.id} is a live catalog scenario`,
      scenario.kind === 'live' && scenario.family === 'catalog' && scenario.inject === undefined
    );
    add(
      `${scenario.id} has no hint in its goal`,
      findTextProblems(scenario.goal, 'goal').length === 0,
      findTextProblems(scenario.goal, 'goal')
        .map(problem => problem.code)
        .join(',')
    );
    const grants = scenario.authorization?.effects ?? [];
    add(
      `${scenario.id} authorizes only a bounded form_submit`,
      Object.keys(scenario.authorization ?? {}).join() === 'effects' &&
        grants.length === 1 &&
        grants[0].effect === 'form_submit' &&
        Number.isInteger(grants[0].maxUses) &&
        grants[0].maxUses <= 8
    );
    const period = scenario.faults?.rerenderEveryMs;
    if (period !== undefined) {
      // A decision spans one to three sequential model calls (0.6 to 0.8 s each in the recorded Jev runs): at
      // a period near that span every execute would meet a freshly replaced page and the run could only end
      // in STALE_LIMIT. The budget has to tolerate a streak of rejections as well.
      add(
        `${scenario.id} re-renders slowly enough for a decision to land`,
        Number.isFinite(period) &&
          period >= MIN_RERENDER_PERIOD_MS &&
          (scenario.run?.budgets?.maxStaleRetries ?? 0) >= MIN_STALE_RETRIES,
        `rerenderEveryMs ${String(period)} with maxStaleRetries ${String(scenario.run?.budgets?.maxStaleRetries)}`
      );
    }
    const plan = plans[scenario.id];
    if (scenario.expectStatus !== 'needs_input') {
      add(`${scenario.id} expects completed`, scenario.expectStatus === 'completed');
      add(
        `${scenario.id} has at least three wrong end states in its controls`,
        (plan?.wrong?.length ?? 0) >= 3
      );
      add(
        `${scenario.id} has a wrong end state that returns the same products`,
        (plan?.wrong ?? []).some(wrong => wrong.same === true),
        'every scenario needs a wrong end state that the result list alone cannot reject'
      );
      for (const literal of quotedLiterals(scenario.goal)) {
        add(
          `${scenario.id} quotes exactly the term the controls search for`,
          literal === plan?.good?.q,
          `quoted ${JSON.stringify(literal)} but the control searches ${JSON.stringify(plan?.good?.q)}`
        );
      }
    }
    const inputLeaves = leavesOf(scenario.inputs);
    if (inputLeaves.length > 0) {
      const goal = scenario.goal.toLowerCase();
      add(
        `${scenario.id} keeps its input values out of the goal text`,
        inputLeaves.every(leaf => !goal.includes(leaf.toLowerCase()))
      );
      const good = plan?.good ?? {};
      const wanted = [
        ...(good.brand ?? []),
        ...(good.maxPrice === undefined ? [] : [String(good.maxPrice)]),
        ...(good.q ? [good.q] : []),
      ];
      add(
        `${scenario.id} needs every input value to reach the expected end state`,
        inputLeaves.every(leaf => wanted.includes(leaf.toLowerCase())) &&
          wanted.every(item => inputLeaves.some(leaf => leaf.toLowerCase() === item)),
        `inputs ${JSON.stringify(inputLeaves)} versus expected ${JSON.stringify(wanted)}`
      );
    }
  }
  return checks;
}

// A wrong end state flagged `same` must really return the right products in the right order (otherwise the
// control would be rejected by the result list and prove nothing about the filter checks); every other wrong
// end state must differ.
const planQuery = plan => {
  const params = new URLSearchParams();
  if (plan.q) params.set('q', plan.q);
  if (plan.category?.length) params.set('category', plan.category.join(','));
  if (plan.brand?.length) params.set('brand', plan.brand.join(','));
  if (plan.maxPrice !== undefined) params.set('maxPrice', String(plan.maxPrice));
  if (plan.sort) params.set('sort', plan.sort);
  return params.toString();
};

export async function sameResultChecks(list = scenarios, plans = PLANS) {
  const outcomes = [];
  const app = await startApp({ variant: 'A' });
  try {
    const idsOf = async plan => {
      const response = await fetch(`${app.origin}/api/products?${planQuery(plan)}`);
      const body = await response.json();
      return body.products.map(product => product.id);
    };
    for (const scenario of list) {
      const plan = plans[scenario.id];
      if (scenario.expectStatus === 'needs_input' || !plan) continue;
      const good = await idsOf(plan.good);
      for (const wrong of plan.wrong) {
        const ids = await idsOf(wrong.plan);
        const identical = ids.join() === good.join();
        outcomes.push({
          id: `results :: ${scenario.id} :: ${wrong.name} is classified correctly`,
          ok: identical === (wrong.same === true) && good.length > 0,
          message: `good ${good.join()} versus wrong ${ids.join()}, same flag ${String(wrong.same === true)}`,
        });
      }
    }
  } finally {
    await app.close();
  }
  return outcomes;
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

const CONTEXT = { calls: [], trace: [], evidenceDir: '', sensitive: {} };

const judge = async (group, verdict, env) => {
  const id = `${group.id} :: ${verdict.name}`;
  const seen = verdict.view === undefined ? env.app : verdict.view(env.app);
  let thrown;
  try {
    await group.scenario.expect(seen, verdict.result, env.page, CONTEXT);
  } catch (error) {
    thrown = error;
  }
  if (verdict.kind === 'pass') {
    return thrown === undefined
      ? { id, ok: true }
      : { id, ok: false, message: `expect() rejected the achieved state: ${firstLine(thrown)}` };
  }
  if (thrown === undefined) {
    return { id, ok: false, message: 'expect() accepted a state or result it must reject' };
  }
  if (thrown?.name !== EXPECTATION_ERROR) {
    return {
      id,
      ok: false,
      message: `rejected for a harness reason, not a failed expectation: ${firstLine(thrown)}`,
    };
  }
  if (verdict.reason && !verdict.reason.test(thrown.message)) {
    return { id, ok: false, message: `rejected for the wrong reason: ${firstLine(thrown)}` };
  }
  return { id, ok: true };
};

const DRIVE_ATTEMPTS = 2;

// The machine may be loaded, so a scripted drive that times out is repeated once on a fresh app; a verdict
// is only ever judged on a completed drive, so a retry can never turn a rejection into an acceptance.
const runGroupOnce = async (browser, group) => {
  const outcomes = [];
  let app;
  let context;
  let driveError;
  try {
    app = await startApp({
      variant: group.variant,
      initial: group.initial,
      faults: group.faults,
    });
    context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const driver = DRIVERS[group.variant](page, app);
    try {
      await driver.open();
      if (group.drive) await group.drive(driver, { app, page });
    } catch (error) {
      driveError = error;
    }
    if (driveError === undefined) {
      for (const verdict of group.verdicts) {
        outcomes.push(await judge(group, verdict, { app, page }));
      }
    }
  } catch (error) {
    driveError = error;
  } finally {
    await context?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
  }
  return { outcomes, driveError };
};

const runGroup = async (browser, group) => {
  let last;
  for (let attempt = 1; attempt <= DRIVE_ATTEMPTS; attempt += 1) {
    last = await runGroupOnce(browser, group);
    if (last.driveError === undefined) return last.outcomes;
  }
  return group.verdicts.map(verdict => ({
    id: `${group.id} :: ${verdict.name}`,
    ok: false,
    message: `the scripted drive failed: ${firstLine(last.driveError)}`,
  }));
};

/* ------------------------------------------------------------------ */
/* Controls of the controls: judge() and runGroup() must be strict     */
/* ------------------------------------------------------------------ */

const expectationError = message => {
  const error = new Error(message);
  error.name = EXPECTATION_ERROR;
  return error;
};

const judgeChecks = async () => {
  const fakeGroup = expectImpl => ({ id: 'meta', scenario: { expect: expectImpl } });
  const env = { app: {}, page: {} };
  const rejects = async () => {
    throw expectationError('the backend recorded a banana');
  };
  const harnessBug = async () => {
    throw new TypeError('page.evaluate is not a function');
  };
  const accepts = async () => undefined;
  const cases = [
    [
      'a reject verdict is ok when expect() raises an expectation error',
      rejects,
      reject('x', {}),
      true,
    ],
    ['a reject verdict with the matching reason is ok', rejects, reject('x', {}, /banana/), true],
    [
      'a reject verdict with a different reason is not ok',
      rejects,
      reject('x', {}, /apple/),
      false,
    ],
    [
      'a reject verdict is not ok when expect() hit a harness error',
      harnessBug,
      reject('x', {}),
      false,
    ],
    ['a reject verdict is not ok when expect() accepted', accepts, reject('x', {}), false],
    ['an accept verdict is ok when expect() accepted', accepts, accept('x', {}), true],
    ['an accept verdict is not ok when expect() rejected', rejects, accept('x', {}), false],
    [
      'an accept verdict is not ok when expect() hit a harness error',
      harnessBug,
      accept('x', {}),
      false,
    ],
  ];
  const outcomes = [];
  for (const [name, expectImpl, verdict, wantOk] of cases) {
    const outcome = await judge(fakeGroup(expectImpl), verdict, env);
    outcomes.push({
      id: `judge :: ${name}`,
      ok: outcome.ok === wantOk,
      message: `judge answered ok=${String(outcome.ok)}, wanted ${String(wantOk)}`,
    });
  }
  let lensSeen;
  await judge(
    fakeGroup(async app => {
      lensSeen = app;
    }),
    accept('x', {}, () => ({ lens: true })),
    env
  );
  outcomes.push({
    id: 'judge :: a verdict lens replaces the app that expect() sees',
    ok: lensSeen?.lens === true,
    message: 'expect() was handed the real app instead of the lens',
  });
  return outcomes;
};

// The classifier of wrong end states must object to a misflagged plan: it is shown plans that lie about
// whether a wrong end state returns the right products.
const sameResultMetaChecks = async () => {
  const id = 'catalog-a-quoted-search-category';
  const one = scenarios.filter(scenario => scenario.id === id);
  const plan = PLANS[id];
  const flip = index => ({
    [id]: {
      ...plan,
      wrong: plan.wrong.map((wrong, at) =>
        at === index ? { ...wrong, same: wrong.same !== true } : wrong
      ),
    },
  });
  const different = plan.wrong.findIndex(wrong => wrong.same !== true);
  const identical = plan.wrong.findIndex(wrong => wrong.same === true);
  const emptyGood = {
    [id]: {
      ...plan,
      good: { q: 'zzzzzz' },
      wrong: plan.wrong.map(wrong => ({ ...wrong, same: false })),
    },
  };
  const cases = [
    ['the real plan is classified without a single failure', plan && { [id]: plan }, true],
    ['a different end state flagged as identical is caught', flip(different), false],
    ['an identical end state flagged as different is caught', flip(identical), false],
    ['a good plan that returns nothing is caught', emptyGood, false],
  ];
  const outcomes = [];
  for (const [name, plans, wantAllOk] of cases) {
    const results = await sameResultChecks(one, plans);
    const allOk = results.length > 0 && results.every(result => result.ok);
    outcomes.push({
      id: `results-meta :: ${name}`,
      ok: allOk === wantAllOk,
      message: `${results.filter(result => !result.ok).length} of ${results.length} classifications failed`,
    });
  }
  return outcomes;
};

// The structure rules must object to bad scenario sets: each case damages a copy of the real set (or its
// plans) in one way and the named rule has to fail while the untouched set passes it.
const structureMetaChecks = () => {
  const outcomes = [];
  const baseline = structureChecks();
  outcomes.push({
    id: 'structure-meta :: the untouched scenario set passes every structure rule',
    ok: baseline.every(check => check.ok),
    message: baseline
      .filter(check => !check.ok)
      .map(check => check.id)
      .join('; '),
  });
  const named = (list, plans) => structureChecks(list, plans).filter(check => !check.ok);
  const edit = (id, patch) =>
    scenarios.map(scenario =>
      scenario.id === id ? { ...scenario, ...patch(scenario) } : scenario
    );
  const first = scenarios.find(scenario => scenario.expectStatus !== 'needs_input');
  const stale = scenarios.find(scenario => scenario.faults?.rerenderEveryMs !== undefined);
  const withInputs = scenarios.find(scenario => leavesOf(scenario.inputs).length > 0);
  if (!first || !stale || !withInputs) {
    outcomes.push({
      id: 'structure-meta :: the set holds a completed, a re-rendering and an inputs scenario to damage',
      ok: false,
      message: `first ${String(first?.id)}, stale ${String(stale?.id)}, inputs ${String(withInputs?.id)}`,
    });
    return outcomes;
  }
  const grant = effects => ({ effects });
  const cases = [
    [
      'a duplicate id',
      /ids are unique/,
      [...scenarios, { ...scenarios[1], goal: 'A different wish for the store.' }],
    ],
    [
      'a duplicate goal',
      /every goal is different/,
      [...scenarios, { ...scenarios[1], id: 'catalog-a-copy' }],
    ],
    ['only variant A', /three variants/, scenarios.filter(scenario => scenario.variant === 'A')],
    [
      'no scenario with an initial state',
      /non-default state/,
      scenarios.map(scenario => ({ ...scenario, initial: {} })),
    ],
    [
      'no scenario with a cart',
      /filled cart/,
      scenarios.map(scenario => ({ ...scenario, initial: { wishlist: [] } })),
    ],
    [
      'no scenario with a fault',
      /runs under a fault/,
      scenarios.map(scenario => ({ ...scenario, faults: {} })),
    ],
    [
      'no scenario that pauses',
      /pause for input/,
      scenarios.map(scenario => ({ ...scenario, expectStatus: 'completed' })),
    ],
    [
      'no scenario with inputs',
      /data from inputs/,
      scenarios.map(scenario => ({ ...scenario, inputs: {} })),
    ],
    [
      'an unknown fault name',
      /passes validateScenario/,
      edit(stale.id, () => ({ faults: { flicker: true } })),
    ],
    [
      'a variant missing from the id',
      /names its variant/,
      edit(first.id, scenario => ({ id: scenario.id.replace(/^catalog-./, 'catalog-z') })),
    ],
    ['a fault kind', /live catalog scenario/, edit(first.id, () => ({ kind: 'fault' }))],
    [
      'a selector in the goal',
      /no hint in its goal/,
      edit(first.id, scenario => ({ goal: `${scenario.goal} Use #site-search.` })),
    ],
    [
      'a click instruction in the goal',
      /no hint in its goal/,
      edit(first.id, scenario => ({ goal: `${scenario.goal} Then click the first one.` })),
    ],
    [
      'a purchase grant',
      /authorizes only a bounded form_submit/,
      edit(first.id, () => ({
        authorization: grant([{ effect: 'form_submit', maxUses: 8 }, 'purchase']),
      })),
    ],
    [
      'an unbounded grant',
      /authorizes only a bounded form_submit/,
      edit(first.id, () => ({ authorization: grant(['form_submit']) })),
    ],
    [
      'a grant of nine uses',
      /authorizes only a bounded form_submit/,
      edit(first.id, () => ({ authorization: grant([{ effect: 'form_submit', maxUses: 9 }]) })),
    ],
    [
      'an extra authorization key',
      /authorizes only a bounded form_submit/,
      edit(first.id, scenario => ({
        authorization: { ...scenario.authorization, assumeUnclassifiedRoutine: true },
      })),
    ],
    [
      'a re-render period of 1.2 s',
      /re-renders slowly enough/,
      edit(stale.id, scenario => ({ faults: { rerenderEveryMs: 1200 }, run: scenario.run })),
    ],
    [
      'a stale budget of 2',
      /re-renders slowly enough/,
      edit(stale.id, () => ({ run: { budgets: { maxStaleRetries: 2 } } })),
    ],
    ['no stale budget', /re-renders slowly enough/, edit(stale.id, () => ({ run: {} }))],
    [
      'input values repeated in the goal',
      /keeps its input values out of the goal/,
      edit(withInputs.id, scenario => ({ goal: `${scenario.goal} Think Pinecrest.` })),
    ],
    [
      'an input nobody needs',
      /needs every input value/,
      edit(withInputs.id, () => ({
        inputs: { shopping: { preferredBrand: 'Pinecrest', budgetUsd: 30, colour: 'red' } },
      })),
    ],
    [
      'a missing input',
      /needs every input value/,
      edit(withInputs.id, () => ({ inputs: { shopping: { preferredBrand: 'Pinecrest' } } })),
    ],
    [
      'a status other than completed',
      /expects completed/,
      edit(first.id, () => ({ expectStatus: 'blocked' })),
    ],
    [
      'a quoted term the controls do not search',
      /quotes exactly the term/,
      edit(first.id, () => ({
        goal: 'Search the store for "zzz" and narrow the results to the audio category.',
      })),
    ],
  ];
  for (const [name, rule, list] of cases) {
    const failed = named(list, PLANS);
    outcomes.push({
      id: `structure-meta :: ${name} is rejected`,
      ok: failed.some(check => rule.test(check.id)),
      message: `failed rules: ${failed.map(check => check.id).join('; ') || 'none'}`,
    });
  }
  const planCases = [
    [
      'too few wrong end states',
      /at least three wrong end states/,
      plans => ({
        ...plans,
        [first.id]: { ...plans[first.id], wrong: plans[first.id].wrong.slice(0, 2) },
      }),
    ],
    [
      'no wrong end state that returns the same products',
      /returns the same products/,
      plans => ({
        ...plans,
        [first.id]: {
          ...plans[first.id],
          wrong: plans[first.id].wrong.map(wrong => ({ ...wrong, same: false })),
        },
      }),
    ],
    [
      'no plan at all',
      /at least three wrong end states/,
      plans => Object.fromEntries(Object.entries(plans).filter(([id]) => id !== first.id)),
    ],
  ];
  for (const [name, rule, patch] of planCases) {
    const failed = named(scenarios, patch(PLANS));
    outcomes.push({
      id: `structure-meta :: ${name} is rejected`,
      ok: failed.some(check => rule.test(check.id)),
      message: `failed rules: ${failed.map(check => check.id).join('; ') || 'none'}`,
    });
  }
  return outcomes;
};

// The coverage rule must object to a scenario whose controls are too thin, and a limited run must not fail it.
const coverageMetaChecks = () => {
  const list = [{ id: 'one' }, { id: 'two' }];
  const verdicts = (pass, fail) => [
    ...Array.from({ length: pass }, () => ({ kind: 'pass' })),
    ...Array.from({ length: fail }, () => ({ kind: 'fail' })),
  ];
  const group = (id, pass, fail) => ({ scenario: { id }, verdicts: verdicts(pass, fail) });
  const cases = [
    [
      'a scenario with enough controls is covered',
      [group('one', 1, 8), group('two', 2, 20)],
      undefined,
      [],
      true,
    ],
    [
      'a scenario without an accepting control is uncovered',
      [group('one', 0, 30), group('two', 1, 8)],
      undefined,
      ['one'],
      false,
    ],
    [
      'a scenario with seven rejecting controls is uncovered',
      [group('one', 1, 7), group('two', 1, 8)],
      undefined,
      ['one'],
      false,
    ],
    ['a scenario without any group is uncovered', [group('two', 1, 8)], undefined, ['one'], false],
    [
      'controls spread over several groups are added up',
      [group('one', 1, 4), group('one', 0, 4), group('two', 1, 8)],
      undefined,
      [],
      true,
    ],
    ['a limited run is not held to the thresholds', [group('one', 0, 1)], 'one', [], true],
  ];
  return cases.map(([name, groups, only, wantUncovered]) => {
    const { uncovered } = summarizeCoverage(list, groups, only);
    return {
      id: `coverage-meta :: ${name}`,
      ok: uncovered.join() === wantUncovered.join(),
      message: `uncovered ${JSON.stringify(uncovered)}, wanted ${JSON.stringify(wantUncovered)}`,
    };
  });
};

const driveFailureChecks = async browser => {
  const scenario = scenarios[0];
  const group = {
    scenario,
    variant: scenario.variant,
    initial: scenario.initial,
    faults: scenario.faults,
    id: 'meta-drive-failure',
    drive: () => {
      throw new Error('scripted drive blew up');
    },
    verdicts: [
      accept('first verdict', completedResult(scenario.goal)),
      reject('second verdict', completedResult(scenario.goal)),
    ],
  };
  const outcomes = await runGroup(browser, group);
  return [
    {
      id: 'runGroup :: a drive that throws fails every verdict of its group',
      ok:
        outcomes.length === 2 &&
        outcomes.every(
          outcome => outcome.ok === false && /scripted drive failed/.test(outcome.message ?? '')
        ),
      message: `outcomes: ${JSON.stringify(outcomes)}`,
    },
  ];
};

// A scenario is only trusted when its controls hold at least one accepting and several rejecting verdicts.
// A run limited with --only judges a slice, so the thresholds apply to complete runs only.
export const summarizeCoverage = (list, groups, only) => {
  const coverage = list
    .filter(scenario => !only || groups.some(group => group.scenario.id === scenario.id))
    .map(scenario => {
      const verdicts = groups
        .filter(group => group.scenario.id === scenario.id)
        .flatMap(group => group.verdicts);
      return {
        id: scenario.id,
        pass: verdicts.filter(verdict => verdict.kind === 'pass').length,
        fail: verdicts.filter(verdict => verdict.kind === 'fail').length,
      };
    });
  const uncovered = only
    ? []
    : coverage
        .filter(entry => entry.pass < MIN_PASS_CONTROLS || entry.fail < MIN_FAIL_CONTROLS)
        .map(entry => entry.id);
  return { coverage, uncovered };
};

export async function runControls({ concurrency = 4, log = console.log, only } = {}) {
  const groups = buildGroups().filter(group => !only || group.id.includes(only));
  const failures = [];
  let passed = 0;
  let total = 0;
  const record = outcome => {
    total += 1;
    if (outcome.ok) {
      passed += 1;
      log(`PASS ${outcome.id}`);
    } else {
      failures.push(outcome.id);
      log(`FAIL ${outcome.id}: ${outcome.message}`);
    }
  };

  const selected = outcome => !only || outcome.id.includes(only);
  const staticOutcomes = [
    ...structureChecks(),
    ...structureMetaChecks(),
    ...coverageMetaChecks(),
    ...(await sameResultChecks()),
    ...(await sameResultMetaChecks()),
    ...(await judgeChecks()),
  ].filter(selected);
  staticOutcomes.forEach(record);
  if (only && groups.length === 0 && staticOutcomes.length === 0) {
    record({
      id: `selection :: --only ${only}`,
      ok: false,
      message: 'no control group or check matches',
    });
  }

  const { chromium } = createRequire(join(TOOLS_DIR, 'package.json'))('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  let next = 0;
  try {
    (await driveFailureChecks(browser)).filter(selected).forEach(record);
    const worker = async () => {
      for (;;) {
        const group = groups[next];
        next += 1;
        if (!group) return;
        (await runGroup(browser, group)).forEach(record);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    await browser.close();
  }

  const { coverage, uncovered } = summarizeCoverage(scenarios, groups, only);
  for (const entry of coverage) {
    log(
      `${uncovered.includes(entry.id) ? 'FAIL' : 'PASS'} coverage ${entry.id}: ${entry.pass} pass controls, ${entry.fail} fail controls`
    );
  }
  log(
    `catalog controls: ${passed}/${total} passed, ${failures.length} failed; scenarios covered ${coverage.length - uncovered.length}/${coverage.length}`
  );
  return {
    total,
    passed,
    failed: failures,
    scenarios: coverage.length,
    uncovered,
  };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const flag = process.argv.indexOf('--only');
  const only = flag > -1 ? process.argv[flag + 1] : undefined;
  const jobsFlag = process.argv.indexOf('--jobs');
  const concurrency = jobsFlag > -1 ? Number(process.argv[jobsFlag + 1]) : undefined;
  runControls({ only, concurrency: Number.isInteger(concurrency) ? concurrency : undefined }).then(
    summary => {
      const healthy =
        summary.total > 0 && summary.failed.length === 0 && summary.uncovered.length === 0;
      process.exit(healthy ? 0 : 1);
    },
    error => {
      console.log(`FAIL catalog controls could not run: ${firstLine(error)}`);
      process.exit(1);
    }
  );
}
