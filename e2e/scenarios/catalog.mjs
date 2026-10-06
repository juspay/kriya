import { isDeepStrictEqual } from 'node:util';

/** @typedef {import('../../dist/index').TaskResult} TaskResult */

const FAMILY = 'catalog';
const SETTLE_TIMEOUT_MS = 5000;
const STABLE_MS = 700;
const POLL_MS = 100;

// Independent oracle: titles and labels are copied from the fixed seed data, never read from the app.
const TITLES = Object.freeze({
  p01: 'Northwave Aria Wireless Headphones',
  p03: 'Sonique Studio Monitor Headphones',
  p04: 'Sonique Pocket Bluetooth Speaker',
  p06: 'Sonique Turntable One',
  p09: 'Hearthly Cast Iron Skillet',
  p10: 'Hearthly Stainless Steel Saucepan Set',
  p11: 'Lumio Smart Kitchen Scale',
  p12: 'Hearthly Silicone Utensil Pack',
  p15: 'Pinecrest Cork Yoga Mat',
  p16: 'Pinecrest Insulated Water Bottle',
  p17: 'Aerodyne Wireless Fitness Tracker',
  p18: 'Aerodyne Speed Jump Rope',
  p20: 'Deskly Ergonomic Wireless Mouse',
  p21: 'Lumio Wireless Mechanical Keyboard',
  p22: 'Northwave Quiet Office Headset',
  p24: 'Lumio LED Desk Lamp',
  p26: 'Trailmark Carbon Trekking Poles',
  p28: 'Pinecrest Steel Vacuum Thermos',
  p29: 'Aerodyne Wireless Camping Lantern',
});

const CATEGORY_LABELS = Object.freeze({
  A: Object.freeze({
    audio: 'Audio',
    kitchen: 'Kitchen',
    fitness: 'Fitness',
    office: 'Office',
    outdoor: 'Outdoor',
  }),
  B: Object.freeze({
    audio: 'Headphones & Audio',
    kitchen: 'Kitchen & Dining',
    fitness: 'Fitness & Training',
    office: 'Office & Desk',
    outdoor: 'Outdoors & Camping',
  }),
  C: Object.freeze({
    audio: 'Sound',
    kitchen: 'Cooking',
    fitness: 'Training',
    office: 'Workspace',
    outdoor: 'Adventure',
  }),
});

const BRAND_LABELS = Object.freeze({
  aerodyne: 'Aerodyne',
  deskly: 'Deskly',
  hearthly: 'Hearthly',
  kettlebrook: 'Kettlebrook',
  lumio: 'Lumio',
  northwave: 'Northwave',
  pinecrest: 'Pinecrest',
  sonique: 'Sonique',
  torque: 'Torque',
  trailmark: 'Trailmark',
});

const B_SORT_LABELS = Object.freeze({
  relevance: 'Most relevant',
  price_asc: 'Lowest price first',
  price_desc: 'Highest price first',
  rating: 'Best rated',
});

const titleOf = id => {
  const title = TITLES[id];
  if (title === undefined) throw new Error(`no oracle title for product ${id}`);
  return title;
};
const norm = value =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const show = value => JSON.stringify(value) ?? String(value);
const firstLine = error => String(error?.message ?? error).split('\n')[0];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The name lets the control proofs tell a rejected expectation from a harness or browser failure.
const fail = message => {
  const error = new Error(message);
  error.name = 'CatalogExpectation';
  throw error;
};

const same = (actual, expected, label) => {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label}: expected ${show(expected)} but found ${show(actual)}`);
  }
};

/* ------------------------------------------------------------------ */
/* Reading the real page (runs inside the browser, must stay self-contained) */
/* ------------------------------------------------------------------ */

const readCatalogUi = variant => {
  const clean = value =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const text = selector => clean(document.querySelector(selector)?.textContent);
  const all = selector => [...document.querySelectorAll(selector)];
  const valueOf = selector => {
    const element = document.querySelector(selector);
    return element ? element.value : null;
  };
  const params = new URL(location.href).searchParams;
  const list = key =>
    params
      .getAll(key)
      .flatMap(value => value.split(','))
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
      .sort();
  const rawPrice = params.get('maxPrice');
  const url = {
    pathname: location.pathname,
    q: clean(params.get('q')),
    category: list('category'),
    brand: list('brand'),
    maxPrice:
      rawPrice !== null && rawPrice.trim() !== '' && Number.isFinite(Number(rawPrice))
        ? Number(rawPrice)
        : null,
    sort: ['price_asc', 'price_desc', 'rating'].includes(params.get('sort'))
      ? params.get('sort')
      : 'relevance',
  };
  const titleOfCard = card => clean(card.querySelector('h3 a')?.textContent);

  if (variant === 'A') {
    const countText = text('#results p.count');
    const match = /^Showing (\d+) results?/.exec(countText);
    return {
      variant,
      url,
      countText,
      count: match ? Number(match[1]) : null,
      loading: /^(Loading|Updating)/.test(countText),
      titles: all('#results .card h3 a').map(link => clean(link.textContent)),
      saved: Object.fromEntries(
        all('#results .card').map(card => [
          titleOfCard(card),
          card.querySelector('button.heart')?.getAttribute('aria-pressed') === 'true',
        ])
      ),
      indicators: {
        pills: all('#results ul.pills button.pill')
          .map(button => clean(button.getAttribute('aria-label')))
          .sort(),
        boxes: all('#sidebar input[type="checkbox"]:checked')
          .map(input => `${input.name}:${input.value}`)
          .sort(),
        price: valueOf('#price'),
        sort: valueOf('#sort'),
        searchBox: valueOf('#site-search'),
      },
    };
  }

  if (variant === 'B') {
    const countText = text('p.found');
    const match = /^(\d+) products? found/.exec(countText);
    return {
      variant,
      url,
      countText,
      count: match ? Number(match[1]) : null,
      loading: false,
      titles: all('.rows .row h3 a').map(link => clean(link.textContent)),
      saved: Object.fromEntries(
        all('.rows .row').map(row => [
          titleOfCard(row),
          clean(row.querySelector('button.later-btn')?.textContent) === 'Saved for later',
        ])
      ),
      indicators: {
        applied: text('p.applied'),
        q: valueOf('#q'),
        dept: valueOf('#dept'),
        make: valueOf('#make'),
        cap: valueOf('#cap'),
        sortRadio: document.querySelector('input[name="sort"]:checked')?.value ?? null,
      },
    };
  }

  const countText = text('#results p.count');
  const match = /^(\d+) items?$/.exec(countText);
  return {
    variant,
    url,
    countText,
    count: match ? Number(match[1]) : null,
    loading: /^(Refreshing|Fetching)/.test(countText),
    titles: all('#results .tile h3 a').map(link => clean(link.textContent)),
    saved: Object.fromEntries(
      all('#results .tile').map(tile => [
        titleOfCard(tile),
        tile.querySelector('button.keep')?.getAttribute('aria-pressed') === 'true',
      ])
    ),
    indicators: {
      chips: all('#filters button.chip[aria-pressed="true"]')
        .map(button => `${button.getAttribute('name')}:${button.value}`)
        .sort(),
      active: text('#filters .factive span'),
      queryChip: text('#results button.query-chip'),
    },
  };
};

const readStable = async (page, variant, wantCount) => {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last;
  let lastError;
  let key = '';
  let since = 0;
  for (;;) {
    try {
      const ui = await page.evaluate(readCatalogUi, variant);
      last = ui;
      lastError = undefined;
      if (!ui.loading && ui.count === wantCount) return ui;
      const nextKey = JSON.stringify([ui.loading, ui.count, ui.titles, ui.url]);
      if (nextKey !== key) {
        key = nextKey;
        since = Date.now();
      } else if (!ui.loading && Date.now() - since >= STABLE_MS) {
        return ui;
      }
    } catch (error) {
      lastError = error;
      key = '';
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  if (last === undefined) fail(`the page could not be read: ${firstLine(lastError)}`);
  return last;
};

/* ------------------------------------------------------------------ */
/* Result checks                                                       */
/* ------------------------------------------------------------------ */

const STATUS_EFFECTS = Object.freeze({
  applied: ['applied', 'none'],
  noop_already_satisfied: ['none'],
  rejected_stale: ['none'],
  rejected_invalid: ['none'],
  rejected_scope: ['none'],
  failed: ['none', 'applied'],
  uncertain: ['uncertain'],
  navigated: ['applied', 'uncertain'],
});
const checkEnvelope = (result, goal) => {
  if (result === null || typeof result !== 'object') fail('the run produced no result object');
  same(result.goal, goal, 'result.goal (the caller goal must come back unchanged)');
  if (!Array.isArray(result.ledger)) fail('result.ledger must be an array');
  same(result.unresolvedUncertain, [], 'result.unresolvedUncertain');
  for (const entry of result.ledger) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !Object.hasOwn(STATUS_EFFECTS, entry.status) ||
      !STATUS_EFFECTS[entry.status].includes(entry.effect)
    ) {
      fail('result.ledger contains an invalid status/effect pair');
    }
  }
  same(
    result.lastEffect,
    result.ledger.at(-1)?.effect ?? 'none',
    'result.lastEffect differs from the newest ledger effect'
  );
  const uncertain = result.ledger.filter(entry => entry.effect === 'uncertain');
  if (uncertain.length > 0 && result.status !== 'completed')
    fail('result.ledger holds unresolved uncertain entries');
  if (
    result.status === 'completed' &&
    result.completion !== null &&
    typeof result.completion === 'object'
  ) {
    const completion = result.completion;
    same(completion.unresolvedUncertain, [], 'completion.unresolvedUncertain');
    if (!Array.isArray(completion.resolvedUncertain))
      fail('completion.resolvedUncertain must be an array');
    for (const entry of uncertain) {
      const matching = completion.resolvedUncertain.filter(
        resolution => resolution?.seq === entry.seq
      );
      if (
        matching.length !== 1 ||
        !['applied', 'none'].includes(matching[0].effect) ||
        !['postcondition', 'transition', 'caller'].includes(matching[0].by)
      ) {
        fail(
          'result.ledger uncertain entries require one matching valid completion.resolvedUncertain resolution'
        );
      }
    }
    for (const resolution of completion.resolvedUncertain) {
      if (!uncertain.some(entry => entry.seq === resolution?.seq)) {
        fail('completion.resolvedUncertain refers to an entry that was not uncertain');
      }
    }
  } else if (uncertain.length > 0) {
    fail('result.ledger uncertain entries require a completion resolution record');
  }
};

/** @param {TaskResult} result */
const checkCompleted = (result, goal) => {
  if (result === null || typeof result !== 'object') fail('the run produced no result object');
  same(result.status, 'completed', 'result.status');
  checkEnvelope(result, goal);
  if (result.answer !== undefined) {
    fail(`result.answer must be absent for a state-change goal, found ${show(result.answer)}`);
  }
  const completion = result.completion;
  if (completion === null || typeof completion !== 'object') {
    fail('a completed result must carry result.completion');
  }
  same(completion.mode, 'effected', 'completion.mode');
  same(completion.effected, true, 'completion.effected');
  same(completion.answered, false, 'completion.answered');
  same(completion.unresolvedUncertain, [], 'completion.unresolvedUncertain');
  if (!(completion.actionsExecuted >= 1)) {
    fail(
      `completion.actionsExecuted must be at least 1, found ${show(completion.actionsExecuted)}`
    );
  }
  const worked = result.ledger.filter(
    entry =>
      entry?.status === 'applied' ||
      entry?.status === 'navigated' ||
      (entry?.effect === 'uncertain' &&
        completion.resolvedUncertain.some(
          resolution => resolution.seq === entry.seq && resolution.effect === 'applied'
        ))
  );
  if (worked.length === 0) fail('result.ledger shows no applied or navigated command');
};

/** @param {TaskResult} result */
const checkNeedsInput = (result, goal) => {
  if (result === null || typeof result !== 'object') fail('the run produced no result object');
  same(result.status, 'needs_input', 'result.status');
  checkEnvelope(result, goal);
  if ('completion' in result) fail('a paused run must not carry result.completion');
  if (result.answer !== undefined) fail('a paused run must not carry result.answer');
  if (!Array.isArray(result.requirements) || result.requirements.length === 0) {
    fail('result.requirements must name what is missing');
  }
  const wanted = result.requirements.find(requirement => requirement?.kind === 'argument');
  if (wanted === undefined) {
    fail(`no requirement of kind argument: ${show(result.requirements.map(r => r?.kind))}`);
  }
  if (!['no_candidates', 'none_appropriate', 'input_missing'].includes(wanted.reason)) {
    fail(`requirement reason ${show(wanted.reason)} does not describe a value nobody supplied`);
  }
  if (wanted.operation !== undefined) same(wanted.operation, 'FILL', 'requirement.operation');
  if (wanted.slot !== undefined) same(wanted.slot, 'value', 'requirement.slot');
  if (typeof wanted.description !== 'string' || wanted.description.trim() === '') {
    fail('requirement.description must explain what is missing');
  }
  same(result.checkpoint?.pending?.kind, 'needs_input', 'result.checkpoint.pending.kind');
  const typed = result.ledger.filter(
    entry =>
      ['FILL', 'SUBMIT'].includes(entry?.command?.command?.operation) &&
      ['applied', 'navigated', 'uncertain'].includes(entry?.status)
  );
  if (typed.length > 0)
    fail('result.ledger shows a typed value or a submit although nothing was supplied');
};

/* ------------------------------------------------------------------ */
/* UI and backend checks                                               */
/* ------------------------------------------------------------------ */

const checkUrl = (ui, spec) => {
  same(ui.url.pathname, ui.variant === 'B' ? '/search' : '/', 'page path (the results page)');
  same(norm(ui.url.q), norm(spec.q), 'URL query q');
  same(ui.url.category, [...spec.category].sort(), 'URL category filter');
  same(ui.url.brand, [...spec.brand].sort(), 'URL brand filter');
  same(ui.url.maxPrice, spec.maxPrice, 'URL maxPrice');
  same(ui.url.sort, spec.sort, 'URL sort');
};

const filterCount = spec =>
  spec.category.length + spec.brand.length + (spec.maxPrice === null ? 0 : 1);

const checkIndicatorsA = (ui, spec) => {
  const pills = [
    ...spec.category.map(slug => CATEGORY_LABELS.A[slug]),
    ...spec.brand.map(slug => BRAND_LABELS[slug]),
    ...(spec.maxPrice === null ? [] : [`Up to $${spec.maxPrice}`]),
  ].map(label => `Remove filter: ${label}`);
  const { indicators } = ui;
  same(indicators.pills, pills.sort(), 'active-filter pills');
  same(
    indicators.boxes,
    [...spec.category.map(s => `category:${s}`), ...spec.brand.map(s => `brand:${s}`)].sort(),
    'ticked sidebar checkboxes'
  );
  same(indicators.price, spec.maxPrice === null ? '' : String(spec.maxPrice), 'price select');
  same(indicators.sort, spec.sort, 'sort select');
  same(norm(indicators.searchBox), norm(spec.q), 'search box text');
  const line = norm(ui.countText);
  if (spec.q !== '' && !line.includes(norm(spec.q))) {
    fail(`results line ${show(ui.countText)} does not mention the search term`);
  }
  if (spec.q === '' && line.includes(' for ')) {
    fail(`results line ${show(ui.countText)} mentions a search term that was not asked for`);
  }
};

const checkIndicatorsB = (ui, spec) => {
  const { indicators } = ui;
  same(norm(indicators.q), norm(spec.q), 'search field text');
  same(indicators.dept, spec.category[0] ?? '', 'department select');
  same(indicators.make, spec.brand[0] ?? '', 'manufacturer select');
  same(indicators.cap === '' ? null : Number(indicators.cap), spec.maxPrice, 'highest-price field');
  same(indicators.sortRadio, spec.sort, 'checked sort radio');
  const applied = norm(indicators.applied);
  const parts = [
    ...(spec.q === '' ? [] : [`search: “${norm(spec.q)}”`]),
    ...spec.category.map(slug => `department: ${norm(CATEGORY_LABELS.B[slug])}`),
    ...spec.brand.map(slug => `manufacturer: ${norm(BRAND_LABELS[slug])}`),
    ...(spec.maxPrice === null ? [] : [`up to $${spec.maxPrice}`]),
    `ordered by ${norm(B_SORT_LABELS[spec.sort])}`,
  ];
  same(
    parts.filter(part => !applied.includes(part)),
    [],
    `applied-options summary ${show(indicators.applied)} is missing`
  );
  if (spec.q === '' && applied.includes('search:')) {
    fail(
      `applied-options summary ${show(indicators.applied)} names a search term nobody asked for`
    );
  }
  if (spec.category.length === 0 && applied.includes('department:')) {
    fail(`applied-options summary ${show(indicators.applied)} names a department nobody asked for`);
  }
  if (spec.brand.length === 0 && applied.includes('manufacturer:')) {
    fail(
      `applied-options summary ${show(indicators.applied)} names a manufacturer nobody asked for`
    );
  }
  if (spec.maxPrice === null && applied.includes('up to $')) {
    fail(`applied-options summary ${show(indicators.applied)} names a price cap nobody asked for`);
  }
};

const checkIndicatorsC = (ui, spec) => {
  const { indicators } = ui;
  const pressed = indicators.chips.filter(chip => !chip.startsWith('sort:'));
  same(
    pressed,
    [
      ...spec.category.map(slug => `category:${slug}`),
      ...spec.brand.map(slug => `brand:${slug}`),
      ...(spec.maxPrice === null ? [] : [`maxPrice:${spec.maxPrice}`]),
    ].sort(),
    'pressed filter chips'
  );
  same(
    indicators.chips.filter(chip => chip.startsWith('sort:')),
    [`sort:${spec.sort}`],
    'pressed order chip'
  );
  const n = filterCount(spec);
  same(indicators.active, `${n} filter${n === 1 ? '' : 's'} on`, 'active-filter counter');
  if (spec.q === '') {
    same(indicators.queryChip, '', 'search-term chip');
  } else if (!norm(indicators.queryChip).includes(`search: ${norm(spec.q)}`)) {
    fail(`search-term chip ${show(indicators.queryChip)} does not show the search term`);
  }
};

const checkIndicators = (ui, spec) => {
  if (ui.variant === 'A') checkIndicatorsA(ui, spec);
  else if (ui.variant === 'B') checkIndicatorsB(ui, spec);
  else checkIndicatorsC(ui, spec);
};

const checkSaved = (ui, spec) => {
  for (const id of spec.saved) {
    same(ui.saved[titleOf(id)], true, `saved indicator of ${titleOf(id)}`);
  }
};

const expectedSearch = spec => ({
  q: norm(spec.q),
  filters: {
    category: [...spec.category].sort(),
    brand: [...spec.brand].sort(),
    maxPrice: spec.maxPrice,
  },
  sort: spec.sort,
  count: spec.ids.length,
});

const checkBackend = (app, spec) => {
  const state = app.state();
  const last = state.searches.at(-1);
  if (last === undefined) fail('the backend recorded no search at all');
  same({ ...last, q: norm(last.q) }, expectedSearch(spec), 'backend last search');
  same(state.lastResultIds, spec.ids, 'backend lastResultIds');
};

// Under the stale re-render fault a wrong control that was touched and undone still leaves a trace here.
const checkHistory = (app, spec) => {
  app.state().searches.forEach((search, index) => {
    const label = `backend search #${index + 1} ${show(search)}`;
    if (!norm(spec.q).startsWith(norm(search.q)))
      fail(`${label} searched for something the goal never named`);
    for (const slug of search.filters.category) {
      if (!spec.category.includes(slug)) fail(`${label} filtered by category ${slug}`);
    }
    for (const slug of search.filters.brand) {
      if (!spec.brand.includes(slug)) fail(`${label} filtered by brand ${slug}`);
    }
    if (search.filters.maxPrice !== null && search.filters.maxPrice !== spec.maxPrice) {
      fail(`${label} capped the price at ${search.filters.maxPrice}`);
    }
    if (search.sort !== 'relevance' && search.sort !== spec.sort) {
      fail(`${label} sorted by ${search.sort}`);
    }
  });
};

// Everything a run needs to read: the results page itself and the search endpoint behind it. Any other
// path (product pages, info pages, an unknown route) is a detour the goal never asked for.
const RESULT_PATHS = new Set(['/', '/search', '/api/products']);

const checkCollateral = (app, initial) => {
  const state = app.state();
  const requests = app.requests();
  same(
    requests.filter(request => request.method !== 'GET' && request.method !== 'HEAD'),
    [],
    'write requests (nothing in the goal asks for a cart, wishlist or newsletter write)'
  );
  same(
    state.cart,
    (initial.cart ?? []).map(productId => ({ productId, qty: 1 })),
    'backend cart'
  );
  same(state.wishlist, [...(initial.wishlist ?? [])], 'backend wishlist');
  same(state.newsletterSignups, 0, 'newsletter signups');
  same(state.productViews, [], 'product detail views');
  same(
    requests
      .filter(request => !RESULT_PATHS.has(request.path))
      .map(request => `${request.method} ${request.path}`),
    [],
    'visits to pages the goal never needs'
  );
};

const checkRerenderIsLive = async (page, everyMs) => {
  const detached = await page.evaluate(
    async waitMs => {
      const probe = document.querySelector('#site-search') ?? document.querySelector('main');
      if (!probe) return null;
      const deadline = Date.now() + waitMs;
      while (probe.isConnected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return !probe.isConnected;
    },
    everyMs * 2 + 400
  );
  if (detached !== true) {
    fail(
      'the page did not replace its nodes while the scenario ran: the stale re-render fault was not active'
    );
  }
};

/* ------------------------------------------------------------------ */
/* Scenario builders                                                   */
/* ------------------------------------------------------------------ */

// Searching is an ordinary form submission, so the caller grants exactly that, bounded.
const submitGrant = () => ({ effects: [{ effect: 'form_submit', maxUses: 8 }] });

const completedScenario = ({
  id,
  variant,
  title,
  goal,
  spec,
  inputs = {},
  inputDeclarations,
  initial = {},
  faults = {},
  run = {},
  strictHistory = false,
}) => {
  const full = {
    q: '',
    category: [],
    brand: [],
    maxPrice: null,
    sort: 'relevance',
    saved: [],
    ...spec,
  };
  [...full.ids, ...full.saved].forEach(titleOf);
  return {
    id,
    family: FAMILY,
    variant,
    kind: 'live',
    title,
    goal,
    inputs,
    ...(inputDeclarations === undefined ? {} : { inputDeclarations }),
    authorization: submitGrant(),
    initial,
    faults,
    run,
    resume: [],
    expectStatus: 'completed',
    async expect(app, result, page) {
      checkCompleted(result, goal);
      checkCollateral(app, initial);
      same(
        new URL(page.url()).origin,
        app.origin,
        'page origin (the run must end on the app it started on)'
      );
      const ui = await readStable(page, variant, full.ids.length);
      checkUrl(ui, full);
      same(ui.count, full.ids.length, 'visible result count');
      same(ui.titles, full.ids.map(titleOf), 'rendered product titles, in order');
      checkIndicators(ui, full);
      checkSaved(ui, full);
      checkBackend(app, full);
      if (strictHistory) checkHistory(app, full);
      if (faults.rerenderEveryMs) await checkRerenderIsLive(page, faults.rerenderEveryMs);
    },
  };
};

// Variant B only: its home page logs nothing, so "no search issued" is exact (no /search request, no record).
const missingTermScenario = ({ id, title, goal }) => ({
  id,
  family: FAMILY,
  variant: 'B',
  kind: 'live',
  title,
  goal,
  inputs: {},
  authorization: submitGrant(),
  initial: {},
  faults: {},
  run: { budgets: { maxSteps: 12 } },
  resume: [],
  expectStatus: 'needs_input',
  async expect(app, result, page) {
    checkNeedsInput(result, goal);
    checkCollateral(app, {});
    same(app.state().searches, [], 'backend searches (no search may be issued without a term)');
    same(
      app.requests().filter(request => request.path === '/search'),
      [],
      'search requests'
    );
    const ui = await page.evaluate(readCatalogUi, 'B');
    same(ui.url.pathname, '/', 'page path (still on the home page)');
    same(ui.indicators.q, '', 'search field text (nothing may be typed without a term)');
  },
});

export const scenarios = [
  completedScenario({
    id: 'catalog-a-quoted-search-category',
    variant: 'A',
    title: 'Live-search store: quoted search term plus one category filter',
    goal: 'Search the store for "bluetooth" and narrow the results to the audio category.',
    spec: { q: 'bluetooth', category: ['audio'], ids: ['p04', 'p01'] },
  }),
  completedScenario({
    id: 'catalog-a-brand-budget',
    variant: 'A',
    title: 'Live-search store: brand and price cap only, no search term to type',
    goal: "I'm shopping on a budget: show me only Lumio products that cost $50 or less.",
    spec: { brand: ['lumio'], maxPrice: 50, ids: ['p11', 'p24'] },
  }),
  completedScenario({
    id: 'catalog-a-unquoted-phrase-sort',
    variant: 'A',
    title:
      'Live-search store: unquoted phrase that has to be reduced to a search term, then a sort',
    goal: 'Find me anything made of steel and list the cheapest first.',
    spec: { q: 'steel', sort: 'price_asc', ids: ['p18', 'p16', 'p28', 'p10'] },
  }),
  completedScenario({
    id: 'catalog-a-stale-rerender',
    variant: 'A',
    title:
      'Live-search store whose nodes are replaced every 5 s: still the right filters, nothing else touched',
    goal: 'Look up "wireless" in the store and narrow it to Aerodyne products under $100.',
    spec: { q: 'wireless', brand: ['aerodyne'], maxPrice: 100, ids: ['p29', 'p17'] },
    // A step spans two to four sequential model calls (about 0.6 to 0.8 s each in the recorded Jev runs), so
    // a period near that span would detach the target of every single action and no run could finish.
    // Five seconds detaches some targets and lets others through; the larger stale budget tolerates a streak.
    faults: { rerenderEveryMs: 5000 },
    run: { budgets: { maxStaleRetries: 8 } },
    strictHistory: true,
  }),
  completedScenario({
    id: 'catalog-b-phrase-category-rating',
    variant: 'B',
    title: 'Form search with explicit submit: unquoted phrase, department select and a sort radio',
    goal: 'Find me anything wireless in the office category, best-reviewed first.',
    spec: { q: 'wireless', category: ['office'], sort: 'rating', ids: ['p21', 'p22', 'p20'] },
  }),
  completedScenario({
    id: 'catalog-b-inputs-brand-budget',
    variant: 'B',
    title: 'Form search: brand and price cap come from the caller inputs, not from the goal text',
    goal: 'Show me what my preferred brand sells within my budget, cheapest first.',
    inputs: { shopping: { preferredBrand: 'Pinecrest', budgetUsd: 30 } },
    inputDeclarations: [
      {
        path: 'shopping.preferredBrand',
        sensitive: false,
        description: 'Brand the caller prefers to buy',
      },
      {
        path: 'shopping.budgetUsd',
        sensitive: false,
        description: 'Highest price the caller will pay, in US dollars',
      },
    ],
    spec: { brand: ['pinecrest'], maxPrice: 30, sort: 'price_asc', ids: ['p16', 'p28', 'p15'] },
  }),
  missingTermScenario({
    id: 'catalog-b-missing-search-term',
    title:
      'Form search: the goal names no search term, so the run must ask for it and issue no search',
    goal: 'Search the store for the item I have in mind and list the results best-reviewed first.',
  }),
  completedScenario({
    id: 'catalog-c-dialog-search-brands',
    variant: 'C',
    title: 'Overlay search dialog, quoted term, then two brand chips below the fold',
    goal: 'Search the catalog for "bluetooth" and narrow it down to the Sonique and Lumio brands.',
    spec: { q: 'bluetooth', brand: ['lumio', 'sonique'], ids: ['p04', 'p21'] },
  }),
  completedScenario({
    id: 'catalog-c-outdoor-budget-cheapest',
    variant: 'C',
    title:
      'Chips only, with scrolling: a collection, a budget and an order whose labels differ from the goal words',
    goal: "I'm after outdoor gear that costs no more than $50, cheapest first.",
    spec: { category: ['outdoor'], maxPrice: 50, sort: 'price_asc', ids: ['p29', 'p28', 'p26'] },
  }),
  completedScenario({
    id: 'catalog-c-already-saved-keyboard',
    variant: 'C',
    title:
      'Partly satisfied start: the keyboard is already saved for later, so only the search is missing and the saved state must survive',
    goal: 'Search for "mechanical keyboard" and make sure the one that comes up is saved for later.',
    initial: { wishlist: ['p21'] },
    spec: { q: 'mechanical keyboard', ids: ['p21'], saved: ['p21'] },
  }),
  completedScenario({
    id: 'catalog-a-brand-priciest-first-with-cart',
    variant: 'A',
    title:
      'Live-search store that starts with a filled cart and a saved item: one brand, most expensive first, nothing else changes',
    goal: 'Show me everything from Sonique, most expensive first.',
    initial: { cart: ['p05'], wishlist: ['p03'] },
    spec: { brand: ['sonique'], sort: 'price_desc', ids: ['p06', 'p03', 'p04'], saved: ['p03'] },
  }),
  completedScenario({
    id: 'catalog-b-kitchen-under-forty-saved',
    variant: 'B',
    title:
      'Form search where one result is already saved: department, manufacturer and a price ceiling typed as a number',
    goal: "I'd like to see Hearthly kitchen products, nothing above $40.",
    initial: { wishlist: ['p09'] },
    spec: {
      category: ['kitchen'],
      brand: ['hearthly'],
      maxPrice: 40,
      ids: ['p12', 'p09'],
      saved: ['p09'],
    },
  }),
];
