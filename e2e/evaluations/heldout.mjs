/**
 * Frozen evaluation fixtures, separate from the original scenario/training corpus. Assertions use
 * authoritative app state and two UI reads; no assertion trusts the decider's completion claim.
 * heldout.controls.mjs proves acceptance/rejection with scripted Chromium, without a model.
 */

const check = (source, condition, message) => {
  if (!condition) throw new Error(`[${source}] ${message}`);
};
const same = (source, actual, expected, message) =>
  check(source, JSON.stringify(actual) === JSON.stringify(expected), message);

const DRAFT_KEYS = [
  'firstName',
  'lastName',
  'email',
  'phone',
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
const SETTINGS_KEYS = ['promotional', 'updates', 'digest', 'sms', 'security'];
const pick = (record, keys) => Object.fromEntries(keys.map(key => [key, record?.[key]]));

export const fixtureFacts = Object.freeze({
  catalog: {
    ids: ['p08', 'p07'],
    titles: ['Kettlebrook Burr Coffee Grinder', 'Kettlebrook Gooseneck Kettle'],
    prices: ['$79.99', '$54.00'],
    cart: [{ productId: 'p16', qty: 1 }],
    wishlist: ['p24', 'p29'],
  },
  settings: {
    initial: { promotional: false, updates: false, digest: true, sms: false },
    final: { promotional: false, updates: true, digest: false, sms: false, security: true },
  },
  shipping: {
    initial: {
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya.raman@example.test',
      phone: '+1 206 555 0162',
      line1: '83 Cedar Avenue',
      line2: 'Apartment 14',
      city: 'Seattle',
      country: 'US',
      region: 'WA',
      postalCode: '98104',
      delivery: 'overnight',
      giftWrap: true,
      saveAddress: false,
    },
    final: {
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya.raman@example.test',
      phone: '',
      line1: '276 Harbour Street',
      line2: '',
      city: 'Vancouver',
      country: 'CA',
      region: 'BC',
      postalCode: 'V6B 1A1',
      delivery: 'standard',
      giftWrap: true,
      saveAddress: false,
    },
  },
  checkout: {
    cart: [
      { sku: 'tea-sampler', quantity: 2 },
      { sku: 'canvas-tote', quantity: 1 },
    ],
    saved: [{ sku: 'linen-apron', quantity: 3 }],
    totals: { subtotal: 8100, discount: 810, shipping: 599, tax: 583, total: 8472 },
    titles: ['Loose-Leaf Tea Sampler', 'Waxed Canvas Tote'],
  },
});

function assertCompleted(result, goal, page) {
  check('result', result?.status === 'completed', 'expected completed status');
  check('result', result.goal === goal, 'caller goal changed');
  check('result', result.completion?.effected === true, 'change claim has no effected completion');
  check('result', result.completion.mode === 'effected', 'completion mode does not record effects');
  check('result', result.completion.actionsExecuted >= 1, 'no executed action recorded');
  check('result', Number.isFinite(result.completion.verifiedAt), 'no verification timestamp');
  check(
    'result',
    result.completion.verifiedSnapshot?.url === page.url(),
    'verification snapshot does not match the final page'
  );
  same('result', result.unresolvedUncertain, [], 'unresolved effects in result');
  same('result', result.completion.unresolvedUncertain, [], 'unresolved effects in completion');
  check(
    'result',
    Array.isArray(result.ledger) && result.ledger.some(entry => entry.effect === 'applied'),
    'no applied execution in ledger'
  );
}

async function assertFreshUi(page, read) {
  await read(page);
  const fresh = await page.context().newPage();
  fresh.setDefaultTimeout(20000);
  try {
    const response = await fresh.goto(page.url(), { waitUntil: 'load' });
    check('ui', response?.ok(), 'fresh UI could not load');
    await read(fresh);
  } finally {
    await fresh.close();
  }
}

const budgets = { maxSteps: 50, maxModelCalls: 320, maxWallTimeMs: 480000 };
const catalogGoal =
  'Show me Kettlebrook kitchen goods costing at most $100, with the most expensive first. Leave my basket and saved items as they are.';
const settingsGoal =
  'I want product announcements again, but not the weekly digest. Keep promotional emails and text message offers off and keep security notices as they are.';
const shippingGoal =
  'Send this gift to the Canadian address I supplied, by the cheapest delivery available. Remove my old apartment information and telephone number, keep the gift wrap, and do not save the address. Let me review it before payment and stop there.';
const checkoutGoal =
  'Buy the two tea samplers and the canvas tote already in my basket as one test order with my saved address and card. Keep the applied discount and leave the three aprons saved for later.';

const catalog = {
  id: 'heldout-catalog-b-kettlebrook-descending',
  family: 'catalog',
  variant: 'B',
  kind: 'live',
  title: 'New maker, department, price cap and reverse sort with cart and saved-item preservation',
  goal: catalogGoal,
  inputs: {},
  authorization: { origins: ['$app'], effects: [{ effect: 'form_submit', origins: ['$app'] }] },
  initial: { cart: ['p16'], wishlist: ['p24', 'p29'], inventoryProof: true },
  run: { budgets },
  expectStatus: 'completed',
  async expect(app, result, page) {
    assertCompleted(result, catalogGoal, page);
    const state = app.state();
    same(
      'backend',
      state.lastResultIds,
      fixtureFacts.catalog.ids,
      'wrong result order or coverage'
    );
    const last = state.searches.at(-1);
    same(
      'backend',
      last?.filters,
      { category: ['kitchen'], brand: ['kettlebrook'], maxPrice: 100 },
      'wrong filters'
    );
    check(
      'backend',
      last?.q === '' && last?.sort === 'price_desc' && last?.count === 2,
      'wrong search or sort'
    );
    same('backend', state.cart, fixtureFacts.catalog.cart, 'basket changed');
    same('backend', state.wishlist, fixtureFacts.catalog.wishlist, 'saved items changed');
    check('backend', state.newsletterSignups === 0, 'newsletter side effect');
    check(
      'backend',
      app.requests().every(request => request.method === 'GET'),
      'unexpected write'
    );
    await assertFreshUi(page, async probe => {
      check('ui', new URL(probe.url()).pathname === '/search', 'not on search results');
      same(
        'ui',
        await probe.locator('main .rows h3').allTextContents(),
        fixtureFacts.catalog.titles,
        'wrong visible product order'
      );
      same(
        'ui',
        await probe.locator('main .cost').allTextContents(),
        fixtureFacts.catalog.prices,
        'wrong visible prices'
      );
      check(
        'ui',
        (await probe.locator('main .found').innerText()) === '2 products found',
        'wrong visible count'
      );
      check(
        'ui',
        (await probe.getByLabel('Department').inputValue()) === 'kitchen',
        'wrong department'
      );
      check(
        'ui',
        (await probe.getByLabel('Manufacturer').inputValue()) === 'kettlebrook',
        'wrong manufacturer'
      );
      check(
        'ui',
        (await probe.getByLabel('Highest price you will pay (USD)').inputValue()) === '100',
        'wrong price cap'
      );
      check(
        'ui',
        await probe.getByRole('radio', { name: 'Highest price first', exact: true }).isChecked(),
        'wrong sort'
      );
    });
  },
};

const settings = {
  id: 'heldout-settings-b-reverse-two-preferences',
  family: 'settings',
  variant: 'B',
  kind: 'live',
  title:
    'Mixed on/off reversal with two already-off marketing preferences and mandatory security preserved',
  goal: settingsGoal,
  inputs: {},
  authorization: { origins: ['$app'], effects: ['account_change', 'form_submit'] },
  initial: fixtureFacts.settings.initial,
  run: { budgets },
  expectStatus: 'completed',
  async expect(app, result, page) {
    assertCompleted(result, settingsGoal, page);
    const state = app.state();
    same(
      'backend',
      pick(state.settings, SETTINGS_KEYS),
      fixtureFacts.settings.final,
      'wrong preferences'
    );
    same(
      'backend',
      state.writes
        .map(({ key, from, to }) => ({ key, from, to }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: 'digest', from: true, to: false },
        { key: 'updates', from: false, to: true },
      ],
      'wrong writes or no-op preferences toggled'
    );
    check(
      'backend',
      !state.accountDeleted && state.dangerActions.length === 0,
      'destructive side effect'
    );
    same('backend', state.profile, { displayName: 'Jordan Ellis' }, 'profile changed');
    same('backend', state.newsletter, [], 'newsletter side effect');
    const names = {
      promotional: 'Send me promotional emails',
      updates: 'Send me product updates',
      digest: 'Send me the weekly digest',
      sms: 'Send me text message offers',
      security: 'Security alerts',
    };
    await assertFreshUi(page, async probe => {
      for (const key of SETTINGS_KEYS) {
        same(
          'ui',
          await probe.getByRole('checkbox', { name: names[key], exact: true }).isChecked(),
          fixtureFacts.settings.final[key],
          `wrong visible ${key}`
        );
      }
    });
  },
};

const shipping = {
  id: 'heldout-shipping-c-canada-clear-optionals',
  family: 'shipping',
  variant: 'C',
  kind: 'live',
  title:
    'Cross-country wizard clears old optional values, retains gift wrap and stops before payment',
  goal: shippingGoal,
  inputs: {
    profile: {
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya.raman@example.test',
      phone: '',
      address: {
        line1: '276 Harbour Street',
        line2: '',
        city: 'Vancouver',
        state: 'British Columbia',
        country: 'Canada',
        postalCode: 'V6B 1A1',
      },
    },
  },
  inputDeclarations: {
    'profile.phone': {
      sensitive: false,
      description: 'Requested telephone value is empty; the old telephone must be removed.',
    },
    'profile.address.line2': {
      sensitive: false,
      description:
        'Requested secondary address value is empty; the old apartment information must be removed.',
    },
  },
  authorization: { origins: ['$app'], effects: [{ effect: 'form_submit', origins: ['$app'] }] },
  initial: fixtureFacts.shipping.initial,
  run: { budgets },
  expectStatus: 'completed',
  async expect(app, result, page) {
    assertCompleted(result, shippingGoal, page);
    const state = app.state();
    same(
      'backend',
      pick(state.draft, DRAFT_KEYS),
      fixtureFacts.shipping.final,
      'wrong persisted shipping draft'
    );
    check(
      'backend',
      state.submissions.some(entry => entry.accepted && entry.step === 'contact') &&
        state.submissions.some(entry => entry.accepted && entry.step === 'address'),
      'wizard submissions missing'
    );
    check('backend', state.reviewViews >= 1 && state.paymentViews === 0, 'did not stop at review');
    check('backend', state.steps.contact && state.steps.address, 'wizard incomplete');
    same('backend', state.savedAddresses, [], 'address was saved despite instruction');
    same('backend', state.newsletter, [], 'newsletter side effect');
    check(
      'backend',
      state.discards === 0 &&
        state.cartEmptied === 0 &&
        !state.cart.emptied &&
        state.cart.lines === 4 &&
        state.cart.units === 6,
      'cart or draft changed collaterally'
    );
    await assertFreshUi(page, async probe => {
      check('ui', new URL(probe.url()).pathname === '/checkout/review', 'not on review');
      check(
        'ui',
        await probe.getByRole('heading', { name: 'Review and finish', exact: true }).isVisible(),
        'review heading absent'
      );
      const text = await probe.locator('main').innerText();
      for (const expected of [
        'Priya Raman',
        'priya.raman@example.test',
        'Not provided',
        '276 Harbour Street',
        'Vancouver',
        'British Columbia',
        'V6B 1A1',
        'Canada',
        'Regular post',
        '$111.00',
      ])
        check('ui', text.includes(expected), `missing ${expected}`);
      check(
        'ui',
        !text.includes('Apartment 14') && !text.includes('+1 206 555 0162'),
        'old optional value still visible'
      );
      const rows = await probe
        .locator('main dl')
        .evaluateAll(lists =>
          Object.fromEntries(
            lists.flatMap(list =>
              Array.from(list.querySelectorAll('dt')).map(term => [
                term.textContent.trim(),
                term.nextElementSibling?.textContent.trim(),
              ])
            )
          )
        );
      same('ui', rows['Gift packaging'], 'Yes', 'gift wrapping changed');
      same('ui', rows['Address book'], 'No', 'address-save setting changed');
    });
  },
};

const checkout = {
  id: 'heldout-checkout-c-discount-and-saved-preservation',
  family: 'checkout',
  variant: 'C',
  kind: 'live',
  title:
    'New saved-account order crosses shipping-discount threshold while preserving three saved aprons',
  goal: checkoutGoal,
  inputs: {},
  authorization: {
    origins: ['$app'],
    // Two guarded commands plus three possible pre-input stale dispatches. This authorizes command
    // attempts, not five orders: the independent backend assertion still requires exactly one order.
    effects: [{ effect: 'purchase', origins: ['$app'], maxUses: 5 }],
  },
  initial: {
    cart: fixtureFacts.checkout.cart,
    saved: fixtureFacts.checkout.saved,
    promo: 'WELCOME10',
  },
  run: { budgets },
  expectStatus: 'completed',
  async expect(app, result, page) {
    assertCompleted(result, checkoutGoal, page);
    const state = app.state();
    check(
      'backend',
      state.orders.length === 1 && state.attempts === 1,
      'expected exactly one fake order attempt'
    );
    const order = state.orders[0];
    same(
      'backend',
      order.items.map(({ sku, quantity }) => ({ sku, quantity })),
      fixtureFacts.checkout.cart,
      'wrong order items'
    );
    same(
      'backend',
      pick(order.totals, Object.keys(fixtureFacts.checkout.totals)),
      fixtureFacts.checkout.totals,
      'wrong order totals'
    );
    same(
      'backend',
      order.shipping,
      {
        name: 'Test Shopper',
        address1: '18 Alder Lane',
        address2: '',
        city: 'Portland',
        region: 'OR',
        postalCode: '97205',
        country: 'US',
        method: 'standard',
      },
      'saved address changed'
    );
    same(
      'backend',
      order.contact,
      { email: 'test.shopper@example.test', phone: '555-010-0199' },
      'saved contact changed'
    );
    check(
      'backend',
      order.cardLast4 === '4242' &&
        order.promo === 'WELCOME10' &&
        order.source === 'buy-now' &&
        !order.marketingOptIn &&
        order.note === '',
      'payment or collateral order values changed'
    );
    check('backend', state.carts.length === 1, 'unexpected shopper session');
    same('backend', state.carts[0].items, [], 'purchased cart not cleared');
    same('backend', state.carts[0].saved, fixtureFacts.checkout.saved, 'saved aprons changed');
    check('backend', state.carts[0].promo === 'WELCOME10', 'applied discount changed');
    same('backend', state.newsletter, [], 'newsletter side effect');
    check(
      'backend',
      app
        .requests()
        .filter(request => request.method !== 'GET')
        .every(request => request.method === 'POST' && request.path === '/api/orders'),
      'unexpected write outside fake-order endpoint'
    );
    check(
      'result',
      result.ledger.some(
        entry => entry.effect === 'applied' && entry.effects?.includes('purchase')
      ),
      'purchase execution missing from ledger'
    );
    await assertFreshUi(page, async probe => {
      check(
        'ui',
        new URL(probe.url()).pathname === `/thanks/${order.id}`,
        'wrong confirmation location'
      );
      check(
        'ui',
        await probe.getByRole('heading', { name: 'Order placed', exact: true }).isVisible(),
        'confirmation absent'
      );
      const text = await probe.locator('main').innerText();
      for (const expected of [
        order.id,
        ...fixtureFacts.checkout.titles,
        '$84.72',
        '18 Alder Lane',
        '97205',
        'Card ending in 4242',
        'No payment was taken',
      ])
        check('ui', text.includes(expected), `missing ${expected}`);
      check(
        'ui',
        !text.includes('Linen Work Apron'),
        'saved apron incorrectly included in receipt'
      );
    });
  },
};

export const scenarios = Object.freeze([catalog, settings, shipping, checkout]);
