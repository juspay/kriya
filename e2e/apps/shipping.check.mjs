// Self-check for the "shipping" controlled app family. Plain scripted Playwright (NOT the agent):
// drives every variant through the main flow, asserts BACKEND state, every fault flag, reset()
// and that close() frees the port. Prints PASS/FAIL per check and exits non-zero on any failure.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { describe, family, startApp, variants } from './shipping.mjs';

const { chromium } = createRequire('/tmp/amazon-guide/package.json')('playwright');

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

// ---------------------------------------------------------------------------------------------
// What the scripted driver knows about each variant (the app itself offers no hints)
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

const NAMES = {
  A: {
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    phone: 'phone',
    line1: 'address1',
    line2: 'address2',
    city: 'city',
    country: 'country',
    region: 'state',
    postalCode: 'zip',
    delivery: 'delivery_method',
    giftWrap: 'gift_wrap',
    saveAddress: 'save_address',
  },
  B: {
    firstName: 'given',
    lastName: 'family',
    email: 'mail',
    phone: 'mobile',
    line1: 'street',
    line2: 'unit',
    city: 'town',
    country: 'ctry',
    region: 'province',
    postalCode: 'postcode',
    delivery: 'speed',
    giftWrap: 'gift',
    saveAddress: 'remember',
  },
  C: {
    firstName: 'forename',
    lastName: 'surname',
    email: 'contactEmail',
    phone: 'telephone',
    line1: 'streetLine',
    line2: 'unitLine',
    city: 'locality',
    country: 'countryCode',
    region: 'regionCode',
    postalCode: 'postal',
    delivery: 'shippingService',
    giftWrap: 'giftPackaging',
    saveAddress: 'keepAddress',
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
const COUNTRY_NAME = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  IN: 'India',
};
const SUBMIT = { A: 'Review order', B: 'Confirm and review', C: 'Save and continue' };
const EMPTY_CART = { A: 'Empty cart', B: 'Remove everything from my cart', C: 'Remove all items' };
const SAVED_BANNER = {
  A: /Your shipping details have been saved\./,
  B: /Saved\. We have your delivery details\./,
  C: /Address and delivery options saved\./,
};
const FAILURE_TEXT = {
  A: /Nothing was saved/,
  B: /were not stored/,
  C: /Your changes were not kept/,
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

const PERSON = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada.lovelace@example.test',
  phone: '+1 415 555 0132',
  line1: '1 Market Street',
  line2: 'Suite 400',
  city: 'San Francisco',
  country: 'US',
  region: 'CA',
  postalCode: '94105',
  delivery: 'express',
  giftWrap: true,
  saveAddress: true,
};

const BLANK = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  giftWrap: false,
  saveAddress: false,
};
const BLANK_DEFAULTS = {
  A: { ...BLANK, country: 'US', delivery: 'standard' },
  B: { ...BLANK, country: 'US', delivery: '' },
  C: { ...BLANK, country: '', delivery: 'standard' },
};

const sections = v => (v === 'C' ? [CONTACT_KEYS, ADDRESS_KEYS] : [ALL_KEYS]);

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

let passed = 0;
let total = 0;
const failures = [];

async function check(name, fn) {
  total += 1;
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    const first = String(error?.message ?? error).split('\n')[0];
    console.log(`FAIL ${name}: ${first}`);
  }
}

let browser;

async function withApp(options, fn) {
  const app = await startApp(options);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    return await fn({ app, page, context });
  } finally {
    await context.close().catch(() => undefined);
    await app.close();
  }
}

async function withServer(options, fn) {
  const app = await startApp(options);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

// --- plain HTTP session client (cookie jar) ---------------------------------------------------

function httpSession(app) {
  let cookie = '';
  const send = async (method, path, fields) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (fields) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(fields).toString();
    }
    const res = await fetch(app.origin + path, { method, headers, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  return { get: path => send('GET', path), post: (path, fields) => send('POST', path, fields) };
}

function formPayload(v, data, keys) {
  const out = {};
  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (typeof value === 'boolean') {
      if (value) out[NAMES[v][key]] = 'on';
    } else out[NAMES[v][key]] = value;
  }
  return out;
}

async function submitAll(app, v, session, data) {
  const before = app.state().submissions.length;
  const posts =
    v === 'C'
      ? [
          [ROUTES.C.entry, CONTACT_KEYS],
          [ROUTES.C.address, ADDRESS_KEYS],
        ]
      : [[ROUTES[v].entry, ALL_KEYS]];
  for (const [path, keys] of posts) {
    await session.post(path, formPayload(v, data, keys));
    if (!app.state().submissions.at(-1).accepted) break;
  }
  return app.state().submissions.slice(before);
}

const errorCodes = submissionsList =>
  submissionsList.flatMap(s => s.errors.map(e => `${e.field}:${e.code}`)).sort();

// --- browser driver ----------------------------------------------------------------------------

async function fillKeys(page, v, data, keys) {
  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (key === 'country' && v === 'B') {
      await page.getByRole('radio', { name: COUNTRY_NAME[value], exact: true }).check();
    } else if (key === 'country' || key === 'region') {
      await page.getByLabel(LABELS[v][key], { exact: true }).selectOption(value);
    } else if (key === 'delivery') {
      await page.getByRole('radio', { name: DELIVERY_NAME[v][value] }).check();
    } else if (key === 'giftWrap' || key === 'saveAddress') {
      await page.getByLabel(LABELS[v][key], { exact: true }).setChecked(value);
    } else {
      await page.getByLabel(LABELS[v][key], { exact: true }).fill(value);
    }
  }
}

async function clickAndLoad(page, locator) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), locator.click()]);
}

const submitButton = (page, v) => page.getByRole('button', { name: SUBMIT[v], exact: true });
const pathOf = page => new URL(page.url()).pathname;

async function enterAll(page, v, data) {
  const [first, second] = sections(v);
  await fillKeys(page, v, data, first);
  await clickAndLoad(page, submitButton(page, v));
  if (second) {
    assert.equal(pathOf(page), ROUTES.C.address, 'wizard moved to the address step');
    await fillKeys(page, v, data, second);
    await clickAndLoad(page, submitButton(page, v));
  }
}

async function bodyText(page) {
  return page.locator('body').innerText();
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

async function checksGlobal() {
  await check('contract: exports family, >=3 variants, describe() shape', async () => {
    assert.equal(family, 'shipping');
    assert.deepEqual(variants, ['A', 'B', 'C']);
    const d = describe();
    assert.equal(d.family, 'shipping');
    assert.deepEqual(
      d.variants.map(x => x.id),
      ['A', 'B', 'C']
    );
    for (const x of d.variants) assert.ok(typeof x.summary === 'string' && x.summary.length > 20);
    assert.deepEqual(d.faults.map(f => f.name).sort(), [
      'failWrites',
      'misleadingSuccess',
      'rerenderEveryMs',
      'slowResponseMs',
    ]);
    for (const f of d.faults) assert.ok(f.summary.length > 10);
    const names = d.initialOptions.map(o => o.name);
    for (const key of ALL_KEYS) assert.ok(names.includes(key), `initial option ${key}`);
  });

  await check('contract: AppHandle shape and url/origin format', async () => {
    await withServer({ variant: 'B' }, async app => {
      assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.equal(app.origin + '/', app.url);
      assert.equal(app.family, 'shipping');
      assert.equal(app.variant, 'B');
      for (const fn of ['state', 'requests', 'reset', 'close'])
        assert.equal(typeof app[fn], 'function');
    });
  });

  await check('contract: invalid options are rejected', async () => {
    await assert.rejects(startApp({ variant: 'Z' }), /unknown variant/);
    await assert.rejects(startApp({ initial: { nonsense: 1 } }), /unknown initial option/);
    await assert.rejects(startApp({ initial: { delivery: 'teleport' } }), /initial\.delivery/);
    await assert.rejects(startApp({ initial: { giftWrap: 'yes' } }), /boolean/);
    await assert.rejects(startApp({ faults: { explode: true } }), /unknown fault/);
  });

  await check('/__test/state mirrors state() and /__test endpoints are never linked', async () => {
    for (const v of variants) {
      await withServer({ variant: v }, async app => {
        const session = httpSession(app);
        await submitAll(app, v, session, PERSON);
        const res = await fetch(`${app.origin}/__test/state`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), app.state());
        const pages = [ROUTES[v].entry, ROUTES[v].review, ROUTES[v].payment, '/cart', '/p/help'];
        for (const path of pages) {
          const { text } = await session.get(path);
          assert.ok(!text.includes('__test'), `${path} links to __test`);
        }
        const log = app.requests();
        assert.ok(
          log.every(r => !r.path.startsWith('/__test')),
          '__test calls are not logged'
        );
      });
    }
  });

  await check(
    'pages carry no testids, automation hooks, script tags or product names',
    async () => {
      for (const v of variants) {
        await withServer({ variant: v }, async app => {
          const session = httpSession(app);
          const paths = ['/cart', '/p/help', '/p/shop', '/subscribed', '/search?q=lamp', '/nope'];
          const htmls = [];
          for (const path of paths) htmls.push((await session.get(path)).text);
          htmls.push((await session.get(ROUTES[v].entry)).text);
          await submitAll(app, v, session, PERSON);
          if (v === 'C') htmls.push((await session.get(ROUTES.C.address)).text);
          htmls.push((await session.get(ROUTES[v].review)).text);
          htmls.push((await session.get(ROUTES[v].payment)).text);
          const bad = await session.post(ROUTES[v].entry, formPayload(v, { email: 'x' }, ALL_KEYS));
          htmls.push(bad.text);
          for (const html of htmls) {
            assert.ok(
              !/data-testid|data-agent|data-kriya|data-test\b/i.test(html),
              'test attribute'
            );
            assert.ok(!/breeze|nimble|juspay/i.test(html), 'product name');
            assert.ok(!/<script/i.test(html), 'script tag with faults off');
            assert.ok(html.includes('<html lang="en">'));
          }
        });
      }
    }
  );

  await check('state() and requests() mask card numbers and credential-like fields', async () => {
    for (const v of variants) {
      await withServer({ variant: v }, async app => {
        const session = httpSession(app);
        await session.post('/promo', {
          code: '4242 4242 4242 4242',
          password: 'hunter2-test',
          cardNumber: '5555555555554444',
          cvv: '123',
          back: '/cart',
        });
        await session.get('/search?q=4111111111111111&token=abc123');
        await submitAll(app, v, session, PERSON);
        const dump = JSON.stringify([app.state(), app.requests()]);
        for (const secret of ['4242 4242 4242 4242', '4242424242424242', 'hunter2-test']) {
          assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 4)}...`);
        }
        for (const secret of ['5555555555554444', '4111111111111111', 'abc123']) {
          assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 4)}...`);
        }
        assert.ok(dump.includes('****4242'), 'card shows last four digits only');
        assert.ok(dump.includes('****4444'));
        assert.ok(dump.includes('[masked]'), 'credential-like keys are masked');
        assert.ok(dump.includes(PERSON.phone), 'ordinary phone numbers are not masked');
        assert.ok(dump.includes(PERSON.email), 'ordinary form values are not masked');
        const body = app.requests().find(r => r.path === '/promo').bodySummary;
        assert.equal(body.password, '[masked]');
        assert.equal(body.cvv, '[masked]');
        assert.equal(body.back, '/cart');
      });
    }
  });

  await check('initial options that the UI cannot show are rejected up front', async () => {
    await assert.rejects(startApp({ variant: 'B', initial: { country: 'AU' } }), /variant B/);
    await assert.rejects(startApp({ variant: 'A', initial: { region: 'ZZ' } }), /initial\.region/);
    const a = await startApp({ variant: 'A', initial: { country: 'AU', region: '' } });
    assert.equal(a.state().draft.country, 'AU');
    await a.close();
    const b = await startApp({ variant: 'B' });
    assert.throws(() => b.reset({ country: 'DE' }), /variant B/);
    await b.close();
  });

  await check('review pages use valid definition lists and named sections', async () => {
    for (const v of variants) {
      await withServer({ variant: v }, async app => {
        const session = httpSession(app);
        await submitAll(app, v, session, PERSON);
        const { text } = await session.get(ROUTES[v].review);
        const lists = [...text.matchAll(/<dl\b[^>]*>(.*?)<\/dl>/gs)];
        assert.ok(lists.length >= 1);
        for (const [, inner] of lists) {
          const rest = inner.replace(/<dt>.*?<\/dt>/gs, '').replace(/<dd>.*?<\/dd>/gs, '');
          assert.equal(rest.trim(), '', `${v}: only dt/dd inside dl, found ${rest.slice(0, 40)}`);
        }
        const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
        assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
        for (const [, ref] of text.matchAll(/aria-labelledby="([^"]+)"/g)) {
          assert.ok(ids.includes(ref), `aria-labelledby target ${ref} exists`);
        }
      });
    }
  });

  await check('variants differ in wording, not just styling', async () => {
    const labelSets = {};
    for (const v of variants) {
      await withServer({ variant: v }, async app => {
        const session = httpSession(app);
        let html = (await session.get(ROUTES[v].entry)).text;
        if (v === 'C')
          html +=
            (await session.post(ROUTES.C.entry, formPayload(v, PERSON, CONTACT_KEYS)),
            (await session.get(ROUTES.C.address)).text);
        const texts = [...html.matchAll(/<(?:label|legend)[^>]*>(.*?)<\/(?:label|legend)>/gs)].map(
          m => m[1].replace(/<[^>]*>/g, '').trim()
        );
        labelSets[v] = new Set(texts);
      });
    }
    for (const [a, b] of [
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'C'],
    ]) {
      const shared = [...labelSets[a]].filter(t => labelSets[b].has(t));
      assert.ok(shared.length <= 2, `${a} and ${b} share too many labels: ${shared.join(' | ')}`);
    }
  });
}

async function checksVariant(v) {
  const p = name => `${v}: ${name}`;
  const [firstKeys, secondKeys] = sections(v);

  await check(p('starts empty: default draft, no submissions, no views'), async () => {
    await withApp({ variant: v }, async ({ app, page }) => {
      const before = app.state();
      assert.equal(before.family, 'shipping');
      assert.equal(before.variant, v);
      assert.deepEqual(before.draft, BLANK_DEFAULTS[v]);
      assert.deepEqual(before.submissions, []);
      assert.equal(before.reviewViews, 0);
      assert.equal(before.paymentViews, 0);
      await page.goto(app.url);
      assert.equal(pathOf(page), ROUTES[v].entry);
      assert.deepEqual(app.state().draft, BLANK_DEFAULTS[v]);
      const log = app.requests();
      assert.deepEqual(
        log.map(r => [r.seq, r.method, r.path]),
        [
          [1, 'GET', '/'],
          [2, 'GET', ROUTES[v].entry],
        ]
      );
      assert.deepEqual(Object.keys(log[0]).sort(), [
        'bodySummary',
        'method',
        'path',
        'query',
        'seq',
      ]);
    });
  });

  await check(
    p('validation: visible associated errors, values kept, backend rejects'),
    async () => {
      await withApp({ variant: v }, async ({ app, page }) => {
        await page.goto(app.url);
        const expected =
          v === 'A'
            ? ['email:invalid', 'postalCode:invalid', 'region:required']
            : v === 'B'
              ? [
                  'delivery:required',
                  'email:invalid',
                  'phone:required',
                  'postalCode:invalid',
                  'region:required',
                ]
              : ['email:invalid'];
        const bad = {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'not-an-email',
          line1: '1 Market Street',
          city: 'San Francisco',
          postalCode: '9410',
        };
        let alertFields;
        if (v === 'C') {
          await fillKeys(page, v, bad, CONTACT_KEYS);
          await clickAndLoad(page, submitButton(page, v));
          alertFields = ['email'];
        } else {
          await fillKeys(page, v, bad, ALL_KEYS);
          await clickAndLoad(page, submitButton(page, v));
          alertFields =
            v === 'A'
              ? ['email', 'region', 'postalCode']
              : ['email', 'phone', 'region', 'postalCode', 'delivery'];
        }
        const state = app.state();
        assert.equal(state.submissions.length, 1);
        assert.equal(state.submissions[0].accepted, false);
        assert.equal(state.submissions[0].outcome, 'rejected');
        assert.deepEqual(errorCodes(state.submissions), expected);
        assert.equal(state.draft.firstName, '', 'rejected input must not reach the draft');
        assert.equal(state.reviewViews, 0);
        assert.notEqual(pathOf(page), ROUTES[v].review);

        const described = await page.evaluate(
          ({ names }) =>
            names.map(name => {
              const el = document.querySelector(`[name="${name}"]`);
              const holder = el.type === 'radio' ? el.closest('fieldset,[role=radiogroup]') : el;
              const id = holder.getAttribute('aria-describedby');
              const msg = id ? document.getElementById(id) : null;
              const box = msg ? msg.getBoundingClientRect() : null;
              return {
                invalid: el.getAttribute('aria-invalid'),
                id,
                text: msg ? msg.textContent.trim() : '',
                visible: Boolean(box && box.width > 0 && box.height > 0),
                role: msg ? msg.getAttribute('role') : null,
              };
            }),
          { names: alertFields.map(f => NAMES[v][f]) }
        );
        for (const d of described) {
          assert.equal(d.invalid, 'true');
          assert.ok(
            d.id && d.text.length > 5 && d.visible,
            `error message associated: ${JSON.stringify(d)}`
          );
        }
        if (v !== 'C')
          assert.ok(
            described.every(d => d.role === 'alert'),
            'inline errors use role=alert'
          );
        assert.ok(
          await page.getByRole('alert').first().isVisible(),
          'a role=alert region is visible'
        );

        assert.equal(
          await page.getByLabel(LABELS[v].email, { exact: true }).inputValue(),
          'not-an-email'
        );
        assert.equal(
          await page.getByLabel(LABELS[v].firstName, { exact: true }).inputValue(),
          'Ada'
        );
        if (v !== 'C') {
          assert.equal(
            await page.getByLabel(LABELS[v].postalCode, { exact: true }).inputValue(),
            '9410'
          );
          assert.equal(
            await page.getByLabel(LABELS[v].city, { exact: true }).inputValue(),
            'San Francisco'
          );
        }
      });
    }
  );

  await check(
    p('main flow to the review page and payment placeholder (backend asserted)'),
    async () => {
      await withApp({ variant: v }, async ({ app, page }) => {
        await page.goto(app.url);
        if (v === 'C') {
          await page.evaluate(() => {
            window.__marker = 'step-1';
          });
          await fillKeys(page, v, PERSON, firstKeys);
          await clickAndLoad(page, submitButton(page, v));
          assert.equal(
            await page.evaluate(() => window.__marker ?? null),
            null,
            'full navigation, not SPA'
          );
          assert.equal(pathOf(page), ROUTES.C.address);
          const mid = app.state();
          assert.equal(mid.steps.contact, true);
          assert.equal(mid.steps.address, false);
          assert.equal(mid.draft.firstName, 'Ada');
          assert.equal(mid.draft.line1, '', 'address not stored until its step is accepted');
          assert.equal(mid.reviewViews, 0);
          await page.evaluate(() => {
            window.__marker = 'step-2';
          });
          await fillKeys(page, v, PERSON, secondKeys);
          await clickAndLoad(page, submitButton(page, v));
          assert.equal(
            await page.evaluate(() => window.__marker ?? null),
            null,
            'full navigation, not SPA'
          );
        } else {
          await fillKeys(page, v, PERSON, firstKeys);
          await clickAndLoad(page, submitButton(page, v));
        }
        assert.equal(pathOf(page), ROUTES[v].review);
        const text = await bodyText(page);
        for (const part of [
          'Ada Lovelace',
          'ada.lovelace@example.test',
          '1 Market Street',
          'Suite 400',
          'San Francisco',
          'California',
          '94105',
          'United States',
          '+1 415 555 0132',
        ]) {
          assert.ok(text.includes(part), `review prints ${part}`);
        }
        assert.match(text, DELIVERY_NAME[v].express);
        assert.ok(text.includes('$12.00'));
        await page.getByRole('status').filter({ hasText: SAVED_BANNER[v] }).waitFor();

        const state = app.state();
        assert.deepEqual(state.draft, PERSON);
        assert.deepEqual(state.steps, { contact: true, address: true });
        assert.equal(state.reviewViews, 1);
        assert.equal(state.paymentViews, 0);
        const accepted = state.submissions.filter(s => s.accepted);
        assert.equal(accepted.length, v === 'C' ? 2 : 1);
        assert.ok(state.submissions.every(s => s.accepted && s.errors.length === 0));
        assert.equal(state.savedAddresses.length, 1);
        assert.equal(state.savedAddresses[0].postalCode, '94105');
        assert.equal(state.newsletter.length, 0);
        assert.equal(state.cartEmptied, 0);

        await clickAndLoad(
          page,
          page.getByRole('link', { name: 'Continue to payment', exact: true })
        );
        assert.equal(pathOf(page), ROUTES[v].payment);
        assert.match(await bodyText(page), /No order has been created/);
        const after = app.state();
        assert.equal(after.paymentViews, 1);
        assert.equal(after.orders, undefined, 'no order exists in this family');

        const log = app.requests();
        assert.deepEqual(
          log.map(r => r.seq),
          log.map((_, i) => i + 1),
          'seq is 1..n'
        );
        const posts = log.filter(r => r.method === 'POST');
        assert.equal(posts.length, v === 'C' ? 2 : 1);
        assert.equal(posts[0].bodySummary[NAMES[v].email], PERSON.email);
        assert.ok(log.some(r => r.method === 'GET' && r.path === ROUTES[v].review));
        assert.ok(
          state.submissions.every(s => log.some(r => r.seq === s.seq && r.method === 'POST'))
        );
      });
    }
  );

  await check(p('review and wizard gates redirect when nothing was accepted'), async () => {
    await withServer({ variant: v }, async app => {
      const session = httpSession(app);
      const review = await session.get(ROUTES[v].review);
      assert.equal(review.status, 303);
      assert.equal(review.location, ROUTES[v].entry);
      assert.equal(app.state().reviewViews, 0);
      if (v === 'C') {
        const addr = await session.get(ROUTES.C.address);
        assert.equal(addr.status, 303);
        assert.equal(addr.location, ROUTES.C.entry);
        await session.post(ROUTES.C.entry, formPayload(v, PERSON, CONTACT_KEYS));
        const incomplete = await session.get(ROUTES.C.review);
        assert.equal(incomplete.location, ROUTES.C.address);
        assert.equal((await session.get(ROUTES.C.address)).status, 200);
      }
      const unknown = await session.get('/definitely-missing');
      assert.equal(unknown.status, 404);
    });
  });

  await check(
    p('postal code, region, phone, email and delivery rules (backend validation)'),
    async () => {
      await withServer({ variant: v }, async app => {
        const run = async data => {
          const session = httpSession(app);
          return submitAll(app, v, session, { ...PERSON, ...data });
        };
        const codes = async data => errorCodes(await run(data));
        assert.deepEqual(await codes({}), []);
        assert.deepEqual(await codes({ postalCode: '1234' }), ['postalCode:invalid']);
        assert.deepEqual(await codes({ postalCode: '12345-6789' }), ['postalCode:invalid']);
        assert.deepEqual(await codes({ postalCode: 'ABCDE' }), ['postalCode:invalid']);
        assert.deepEqual(await codes({ postalCode: '' }), ['postalCode:required']);
        assert.deepEqual(await codes({ region: '' }), ['region:required']);
        assert.deepEqual(await codes({ region: 'ON' }), ['region:invalid']);
        assert.deepEqual(await codes({ email: 'a@b' }), ['email:invalid']);
        assert.deepEqual(await codes({ email: 'a@b.co' }), []);
        assert.deepEqual(await codes({ email: '' }), ['email:required']);
        assert.deepEqual(await codes({ firstName: '   ' }), ['firstName:required']);
        assert.deepEqual(await codes({ delivery: 'teleport' }), ['delivery:required']);
        assert.deepEqual(await codes({ phone: '12ab' }), ['phone:invalid']);
        assert.deepEqual(await codes({ phone: '123' }), ['phone:invalid']);
        assert.deepEqual(await codes({ phone: '(415) 555-0132' }), []);
        assert.deepEqual(await codes({ phone: '' }), v === 'B' ? ['phone:required'] : []);
        assert.deepEqual(await codes({ country: 'CA', region: '', postalCode: 'K1A 0B1' }), []);
        assert.deepEqual(await codes({ country: 'CA', region: 'XX', postalCode: 'K1A 0B1' }), [
          'region:invalid',
        ]);
        assert.deepEqual(await codes({ country: 'CA', region: 'ON', postalCode: '12345' }), [
          'postalCode:invalid',
        ]);
        const gb = await run({ country: 'GB', region: 'TX', postalCode: 'SW1A 1AA' });
        assert.deepEqual(errorCodes(gb), []);
        assert.equal(app.state().draft.region, '', 'region is dropped outside the US and Canada');
        assert.deepEqual(await codes({ country: 'GB', postalCode: '12345' }), [
          'postalCode:invalid',
        ]);
        if (v === 'B') {
          assert.deepEqual(await codes({ country: 'DE', postalCode: '10115' }), [
            'country:required',
          ]);
        } else {
          assert.deepEqual(await codes({ country: 'DE', region: '', postalCode: '10115' }), []);
          assert.deepEqual(await codes({ country: 'AU', region: '', postalCode: '2000' }), []);
          assert.deepEqual(await codes({ country: 'IN', region: '', postalCode: '110001' }), []);
          assert.deepEqual(await codes({ country: 'FR', region: '', postalCode: '7500' }), [
            'postalCode:invalid',
          ]);
        }
        for (const s of app.state().submissions) {
          assert.equal(s.accepted, s.errors.length === 0 && s.outcome === 'accepted');
        }
      });
    }
  );

  await check(
    p('wrong-choice controls have isolated effects and change nothing else'),
    async () => {
      await withApp({ variant: v }, async ({ app, page }) => {
        await page.goto(app.url);
        const footerLabel = {
          A: 'Your email',
          B: 'Join the Tidewater list',
          C: 'Email for our weekly newsletter',
        }[v];
        await page.getByLabel(footerLabel, { exact: true }).fill('reader@example.test');
        await clickAndLoad(
          page,
          page.getByRole('button', {
            name: { A: 'Sign up', B: 'Subscribe', C: 'Join' }[v],
            exact: true,
          })
        );
        assert.equal(pathOf(page), '/subscribed');
        let state = app.state();
        assert.deepEqual(
          state.newsletter.map(n => n.email),
          ['reader@example.test']
        );
        assert.deepEqual(state.submissions, []);
        assert.equal(state.draft.email, '');

        await page.goto(app.origin + ROUTES[v].entry);
        await page.getByLabel(LABELS[v].firstName, { exact: true }).fill('Typed');
        const promoLabel = { A: 'Discount code', B: 'Promo code', C: 'Gift card or voucher code' }[
          v
        ];
        if (v === 'B') await page.getByText('Have a promo code?').click();
        await page.getByLabel(promoLabel, { exact: true }).fill('SAVE10');
        await clickAndLoad(
          page,
          page.getByRole('button', {
            name: { A: 'Apply', B: 'Redeem', C: 'Redeem' }[v],
            exact: true,
          })
        );
        state = app.state();
        assert.deepEqual(
          state.promoAttempts.map(x => x.code),
          ['SAVE10']
        );
        assert.deepEqual(state.submissions, []);
        assert.equal(state.draft.firstName, '');
        assert.equal(
          await page.getByLabel(LABELS[v].firstName, { exact: true }).inputValue(),
          '',
          'unsaved typing is lost'
        );
        assert.match(await bodyText(page), /not valid or has expired/);

        await clickAndLoad(page, page.getByRole('button', { name: EMPTY_CART[v], exact: true }));
        assert.equal(pathOf(page), '/cart');
        assert.match(await bodyText(page), /Your cart is empty/);
        state = app.state();
        assert.equal(state.cartEmptied, 1);
        assert.equal(state.cart.emptied, true);
        assert.deepEqual(
          [state.cart.lines, state.cart.units],
          [0, 0],
          'backend cart agrees with the Cart (0) badge'
        );
        const res = await page.goto(app.origin + ROUTES[v].entry);
        assert.equal(
          new URL(res.url()).pathname,
          '/cart',
          'checkout redirects while the cart is empty'
        );
        assert.equal(app.state().reviewViews, 0);
      });
    }
  );

  await check(
    p('draft survives distractors: discard/clear/search behave as labelled'),
    async () => {
      await withApp({ variant: v }, async ({ app, page }) => {
        await page.goto(app.url);
        await enterAll(page, v, PERSON);
        assert.equal(pathOf(page), ROUTES[v].review);
        if (v === 'A') {
          await page.goto(app.origin + ROUTES.A.entry);
          assert.equal(
            await page.getByLabel(LABELS.A.firstName, { exact: true }).inputValue(),
            'Ada'
          );
          await clickAndLoad(page, page.getByRole('link', { name: 'Clear form', exact: true }));
          assert.equal(await page.getByLabel(LABELS.A.firstName, { exact: true }).inputValue(), '');
          const state = app.state();
          assert.equal(state.draft.firstName, 'Ada', 'Clear form is a view-only action');
          assert.equal(state.discards, 0);
          await page.getByRole('searchbox', { name: 'Search products' }).fill('lamp');
          await clickAndLoad(page, page.getByRole('button', { name: 'Search', exact: true }));
          assert.match(await bodyText(page), /No products matched/);
          assert.ok(app.requests().some(r => r.path === '/search' && r.query.q === 'lamp'));
          assert.equal(app.state().draft.firstName, 'Ada');
        } else {
          const label = v === 'B' ? 'Discard changes' : 'Start over';
          await clickAndLoad(page, page.getByRole('button', { name: label, exact: true }));
          const state = app.state();
          assert.equal(state.discards, 1);
          assert.deepEqual(state.draft, BLANK_DEFAULTS[v]);
          assert.deepEqual(state.steps, { contact: false, address: false });
          assert.equal(pathOf(page), ROUTES[v].entry);
          assert.match(await bodyText(page), /entries were discarded/);
          const session = httpSession(app);
          assert.equal((await session.get(ROUTES[v].review)).status, 303);
        }
      });
    }
  );

  await check(p('initial options prefill the server draft and the rendered form'), async () => {
    const initial = {
      firstName: 'Preset',
      lastName: 'Person',
      email: 'preset@example.test',
      phone: '613 555 0100',
      line1: '5 Elm Road',
      city: 'Ottawa',
      country: 'CA',
      region: 'ON',
      postalCode: 'K1A 0B1',
      delivery: 'overnight',
      giftWrap: true,
      saveAddress: true,
    };
    await withApp({ variant: v, initial }, async ({ app, page }) => {
      const draft = app.state().draft;
      for (const [key, value] of Object.entries(initial)) assert.equal(draft[key], value, key);
      await page.goto(app.url);
      assert.equal(
        await page.getByLabel(LABELS[v].firstName, { exact: true }).inputValue(),
        'Preset'
      );
      if (v === 'C') {
        assert.equal(app.state().steps.contact, false, 'a prefilled draft is not an accepted step');
        await clickAndLoad(page, submitButton(page, v));
        assert.equal(pathOf(page), ROUTES.C.address);
      }
      assert.equal(await page.getByLabel(LABELS[v].city, { exact: true }).inputValue(), 'Ottawa');
      assert.equal(await page.getByLabel(LABELS[v].region, { exact: true }).inputValue(), 'ON');
      assert.equal(await page.getByLabel(LABELS[v].giftWrap, { exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel(LABELS[v].saveAddress, { exact: true }).isChecked(), true);
      assert.equal(
        await page.getByRole('radio', { name: DELIVERY_NAME[v].overnight }).isChecked(),
        true
      );
      if (v === 'B')
        assert.equal(
          await page.getByRole('radio', { name: 'Canada', exact: true }).isChecked(),
          true
        );
      else
        assert.equal(await page.getByLabel(LABELS[v].country, { exact: true }).inputValue(), 'CA');
      assert.equal(app.state().reviewViews, 0, 'prefill alone never reaches the review page');
      await clickAndLoad(page, submitButton(page, v));
      assert.equal(pathOf(page), ROUTES[v].review);
      const state = app.state();
      assert.deepEqual({ ...state.draft }, { ...BLANK_DEFAULTS[v], ...initial });
      assert.equal(state.reviewViews, 1);
      assert.match(await bodyText(page), /Ontario/);
    });
  });

  await check(p('fault failWrites: HTTP 500, visible error, nothing persisted'), async () => {
    await withApp({ variant: v, faults: { failWrites: true } }, async ({ app, page }) => {
      await page.goto(app.url);
      await fillKeys(page, v, PERSON, firstKeys);
      const [response] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST'),
        submitButton(page, v).click(),
      ]);
      assert.equal(response.status(), 500);
      await page.getByRole('alert').filter({ hasText: FAILURE_TEXT[v] }).waitFor();
      assert.equal(await page.getByLabel(LABELS[v].firstName, { exact: true }).inputValue(), 'Ada');
      assert.equal(await page.getByRole('status').count(), 0, 'no saved banner');
      const state = app.state();
      assert.deepEqual(state.draft, BLANK_DEFAULTS[v]);
      assert.deepEqual(state.steps, { contact: false, address: false });
      assert.equal(state.submissions.length, 1);
      assert.equal(state.submissions[0].outcome, 'failed');
      assert.equal(state.submissions[0].accepted, false);
      assert.equal(state.reviewViews, 0);
      assert.equal(state.savedAddresses.length, 0);
      const session = httpSession(app);
      const news = await session.post('/newsletter', { email: 'x@example.test' });
      assert.equal(news.status, 500);
      assert.equal(app.state().newsletter.length, 0);
      const empty = await session.post('/cart/empty', {});
      assert.equal(empty.status, 500);
      assert.equal(app.state().cartEmptied, 0);
    });
  });

  await check(p('fault misleadingSuccess: saved banner, but nothing persisted'), async () => {
    const banner = async faults =>
      withApp({ variant: v, faults }, async ({ app, page }) => {
        await page.goto(app.url);
        await enterAll(page, v, PERSON);
        assert.equal(pathOf(page), ROUTES[v].review);
        const text = await page
          .getByRole('status')
          .filter({ hasText: SAVED_BANNER[v] })
          .innerText();
        return { text, state: app.state(), page: await bodyText(page) };
      });
    const honest = await banner({});
    const lying = await banner({ misleadingSuccess: true });
    assert.equal(lying.text, honest.text, 'banner is identical with and without the fault');
    assert.deepEqual(honest.state.draft, PERSON);
    assert.deepEqual(lying.state.draft, BLANK_DEFAULTS[v], 'backend draft is unchanged');
    assert.deepEqual(lying.state.steps, { contact: false, address: false });
    assert.ok(lying.state.submissions.length >= 1);
    assert.ok(lying.state.submissions.every(s => s.outcome === 'dropped' && s.accepted === false));
    assert.equal(lying.state.savedAddresses.length, 0);
    assert.equal(lying.state.reviewViews, 1);
    assert.ok(
      !lying.page.includes('Lovelace'),
      'review page prints the stale draft, not the submission'
    );
    assert.ok(honest.page.includes('Lovelace'));
  });

  await check(p('fault slowResponseMs: every response delayed, processing immediate'), async () => {
    await withServer({ variant: v, faults: { slowResponseMs: 450 } }, async app => {
      const t0 = Date.now();
      await fetch(app.origin + ROUTES[v].entry);
      assert.ok(Date.now() - t0 >= 420, `page delayed (${Date.now() - t0}ms)`);
      const t1 = Date.now();
      await fetch(`${app.origin}/__test/state`);
      assert.ok(Date.now() - t1 < 300, '/__test endpoints are not delayed');
      const t2 = Date.now();
      const pending = fetch(app.origin + '/newsletter', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=slow%40example.test',
        redirect: 'manual',
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(
        app.state().newsletter.length,
        1,
        'write is applied before the delayed response'
      );
      await pending;
      assert.ok(Date.now() - t2 >= 420, 'write response delayed');
    });
    await withApp({ variant: v, faults: { slowResponseMs: 350 } }, async ({ app, page }) => {
      const t = Date.now();
      await page.goto(app.url);
      assert.ok(Date.now() - t >= 600, 'redirect plus page, two delayed responses');
      await enterAll(page, v, PERSON);
      assert.deepEqual(app.state().draft, PERSON);
    });
  });

  await check(
    p('fault rerenderEveryMs: held nodes go stale, values and flow survive'),
    async () => {
      await withApp({ variant: v, faults: { rerenderEveryMs: 300 } }, async ({ app, page }) => {
        await page.goto(app.url);
        const firstLabel = LABELS[v].firstName;
        await page.getByLabel(firstLabel, { exact: true }).fill('Persist');
        const held = await page.evaluateHandle(() =>
          document.querySelector('main input[type=text]')
        );
        await page.evaluate(() => {
          window.__main = document.querySelector('main');
        });
        await page.waitForFunction(() => window.__main !== document.querySelector('main'), null, {
          timeout: 3000,
        });
        assert.equal(
          await held.evaluate(el => el.isConnected),
          false,
          'old element reference is detached'
        );
        assert.equal(await page.getByLabel(firstLabel, { exact: true }).inputValue(), 'Persist');
        assert.equal(await page.locator('main').count(), 1);
        await page.getByLabel(firstLabel, { exact: true }).fill('');
        await page.goto(app.url);
        let attempts = 0;
        for (;;) {
          attempts += 1;
          try {
            await enterAll(page, v, PERSON);
            break;
          } catch (error) {
            if (attempts >= 4) throw error;
            await page.goto(app.origin + ROUTES[v].entry);
          }
        }
        assert.equal(pathOf(page), ROUTES[v].review);
        assert.deepEqual(app.state().draft, PERSON);
      });
    }
  );

  await check(
    p('reset() restores initial state, clears logs and invalidates sessions'),
    async () => {
      await withApp({ variant: v, initial: { lastName: 'Oslo' } }, async ({ app, page }) => {
        const fresh = app.state();
        assert.equal(fresh.draft.lastName, 'Oslo');
        await page.goto(app.url);
        await enterAll(page, v, PERSON);
        assert.equal(app.state().reviewViews, 1);
        assert.ok(app.requests().length > 3);
        assert.equal(app.reset(), undefined);
        assert.deepEqual(app.state(), fresh);
        assert.deepEqual(app.requests(), []);
        await page.goto(app.origin + ROUTES[v].entry);
        assert.equal(pathOf(page), ROUTES[v].entry, 'stale cookie gets a fresh session');
        assert.equal(await page.getByLabel(LABELS[v].firstName, { exact: true }).inputValue(), '');
        assert.equal(
          await page.getByLabel(LABELS[v].lastName, { exact: true }).inputValue(),
          'Oslo'
        );
        assert.equal(app.requests()[0].seq, 1, 'seq restarts after reset');

        app.reset({ firstName: 'Zed', giftWrap: true });
        assert.equal(app.state().draft.firstName, 'Zed');
        assert.equal(
          app.state().draft.lastName,
          '',
          'reset(initial) replaces the starting options'
        );
        await page.goto(app.origin + ROUTES[v].entry);
        assert.equal(
          await page.getByLabel(LABELS[v].firstName, { exact: true }).inputValue(),
          'Zed'
        );
        app.reset();
        assert.equal(
          app.state().draft.lastName,
          'Oslo',
          'reset() returns to the options given to startApp'
        );

        await enterAll(page, v, PERSON);
        const res = await fetch(`${app.origin}/__test/reset`, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
        assert.deepEqual(app.state(), fresh);
        const withInitial = await fetch(`${app.origin}/__test/reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initial: { lastName: 'Quux' } }),
        });
        assert.equal(withInitial.status, 200);
        assert.equal(app.state().draft.lastName, 'Quux');
        const bad = await fetch(`${app.origin}/__test/reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initial: { nonsense: 1 } }),
        });
        assert.equal(bad.status, 400);
      });
    }
  );

  await check(
    p('close() frees the port (connection refused, port reusable, idempotent)'),
    async () => {
      const app = await startApp({ variant: v });
      const port = Number(new URL(app.url).port);
      const alive = await fetch(app.url, { redirect: 'manual' });
      assert.equal(alive.status, 302);
      await app.close();
      await app.close();
      const refused = await new Promise(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', error => resolve(error.code));
      });
      assert.equal(refused, 'ECONNREFUSED');
      await assert.rejects(fetch(app.url));
      const again = await startApp({ variant: v, port });
      assert.equal(new URL(again.url).port, String(port));
      assert.equal((await fetch(again.url, { redirect: 'manual' })).status, 302);
      await again.close();
    }
  );
}

async function checksVariantA() {
  await check('A: single page, phone optional, country select, delivery preselected', async () => {
    await withApp({ variant: 'A' }, async ({ app, page }) => {
      await page.goto(app.url);
      assert.equal(await page.getByLabel('Country / region', { exact: true }).inputValue(), 'US');
      assert.equal(await page.getByRole('radio', { name: /Standard shipping/ }).isChecked(), true);
      assert.equal(await page.getByRole('radio', { name: /Express shipping/ }).isChecked(), false);
      assert.equal(
        await page.getByLabel('Add gift wrap ($4.00)', { exact: true }).isChecked(),
        false
      );
      const data = {
        ...PERSON,
        phone: '',
        delivery: 'standard',
        giftWrap: false,
        saveAddress: false,
      };
      await fillKeys(page, 'A', data, ALL_KEYS);
      await clickAndLoad(page, submitButton(page, 'A'));
      assert.equal(pathOf(page), ROUTES.A.review);
      assert.match(await bodyText(page), /Not provided/);
      const state = app.state();
      assert.equal(state.draft.phone, '');
      assert.equal(state.draft.delivery, 'standard');
      assert.equal(state.savedAddresses.length, 0);
      assert.equal(state.submissions.length, 1, 'one POST for the whole page');
    });
  });
}

async function checksVariantB() {
  await check(
    'B: country radio list of three, state select, phone required, nothing preselected',
    async () => {
      await withApp({ variant: 'B' }, async ({ app, page }) => {
        await page.goto(app.url);
        const radios = page.locator('input[type=radio][name=ctry]');
        assert.equal(await radios.count(), 3);
        assert.equal(
          await page.getByRole('radio', { name: 'United States', exact: true }).isChecked(),
          true
        );
        assert.equal(await page.locator('input[name=speed]:checked').count(), 0);
        assert.equal(
          await page
            .locator('select')
            .filter({ has: page.locator('option[value=ON]') })
            .count(),
          1
        );
        assert.equal(await page.getByRole('radio', { name: 'Australia' }).count(), 0);
        const data = { ...PERSON, country: 'GB', region: '', postalCode: 'SW1A 1AA', phone: '' };
        await fillKeys(page, 'B', data, ALL_KEYS);
        await clickAndLoad(page, submitButton(page, 'B'));
        assert.equal(pathOf(page), ROUTES.B.entry, 'missing mobile number stays on the form');
        await page
          .getByRole('alert')
          .filter({ hasText: /courier can reach you/ })
          .waitFor();
        assert.deepEqual(errorCodes(app.state().submissions), ['phone:required']);
        assert.equal(
          await page.getByRole('radio', { name: 'United Kingdom', exact: true }).isChecked(),
          true
        );
        await page.getByLabel('Mobile number', { exact: true }).fill('+44 20 7946 0958');
        await clickAndLoad(page, submitButton(page, 'B'));
        assert.equal(pathOf(page), ROUTES.B.review);
        const state = app.state();
        assert.equal(state.draft.country, 'GB');
        assert.equal(state.draft.region, '');
        assert.equal(state.draft.phone, '+44 20 7946 0958');
        assert.deepEqual(
          state.submissions.map(s => s.outcome),
          ['rejected', 'accepted']
        );
      });
    }
  );
}

async function checksVariantC() {
  await check('C: three full navigations, scrolling needed, Back links keep values', async () => {
    await withApp({ variant: 'C' }, async ({ app, page }) => {
      const navigations = [];
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname);
      });
      await page.goto(app.url);
      const next = () => submitButton(page, 'C');
      const box1 = await next().boundingBox();
      assert.ok(box1 && box1.y > 800, `step 1 primary action below the fold (y=${box1?.y})`);
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      await fillKeys(page, 'C', PERSON, CONTACT_KEYS);
      await clickAndLoad(page, next());
      assert.equal(pathOf(page), ROUTES.C.address);
      const box2 = await next().boundingBox();
      assert.ok(box2 && box2.y > 800, `step 2 primary action below the fold (y=${box2?.y})`);
      await clickAndLoad(
        page,
        page.getByRole('link', { name: 'Back to your details', exact: true })
      );
      assert.equal(pathOf(page), ROUTES.C.entry);
      assert.equal(await page.getByLabel('Forename', { exact: true }).inputValue(), 'Ada');
      assert.equal(
        await page.getByLabel('Contact email', { exact: true }).inputValue(),
        PERSON.email
      );
      await clickAndLoad(page, next());
      await fillKeys(page, 'C', PERSON, ADDRESS_KEYS);
      assert.equal((await page.evaluate(() => window.scrollY)) >= 0, true);
      await clickAndLoad(page, next());
      assert.equal(pathOf(page), ROUTES.C.review);
      await clickAndLoad(page, page.getByRole('link', { name: 'Edit delivery', exact: true }));
      assert.equal(pathOf(page), ROUTES.C.address);
      assert.equal(
        await page.getByLabel('Locality', { exact: true }).inputValue(),
        'San Francisco'
      );
      assert.equal(await page.getByRole('radio', { name: /Fast courier/ }).isChecked(), true);
      await clickAndLoad(page, next());
      assert.equal(pathOf(page), ROUTES.C.review);
      assert.deepEqual(navigations, [
        '/checkout/contact',
        '/checkout/address',
        '/checkout/contact',
        '/checkout/address',
        '/checkout/review',
        '/checkout/address',
        '/checkout/review',
      ]);
      assert.deepEqual(app.state().draft, PERSON);
      assert.equal(app.state().reviewViews, 2);
      assert.equal(app.state().submissions.filter(s => s.accepted).length, 4);
      assert.equal(app.state().savedAddresses.length, 1, 'save-this-address is idempotent');
    });
  });

  await check('C: country is not preselected and a country error appears first', async () => {
    await withApp({ variant: 'C' }, async ({ app, page }) => {
      await page.goto(app.url);
      await fillKeys(page, 'C', PERSON, CONTACT_KEYS);
      await clickAndLoad(page, submitButton(page, 'C'));
      assert.equal(await page.getByLabel('Country or territory', { exact: true }).inputValue(), '');
      await fillKeys(
        page,
        'C',
        { line1: '2 Pine Road', city: 'Austin', postalCode: '7870' },
        ADDRESS_KEYS
      );
      await clickAndLoad(page, submitButton(page, 'C'));
      assert.equal(pathOf(page), ROUTES.C.address);
      assert.deepEqual(errorCodes(app.state().submissions.slice(-1)), ['country:required']);
      const summary = page
        .getByRole('alert')
        .filter({ hasText: 'There is a problem with this step' });
      await summary.waitFor();
      assert.ok(await summary.getByRole('link', { name: /choose a country/i }).isVisible());
      assert.equal(await page.getByLabel('Locality', { exact: true }).inputValue(), 'Austin');
      await fillKeys(page, 'C', { country: 'US' }, ADDRESS_KEYS);
      await clickAndLoad(page, submitButton(page, 'C'));
      assert.deepEqual(errorCodes(app.state().submissions.slice(-1)), [
        'postalCode:invalid',
        'region:required',
      ]);
      await fillKeys(page, 'C', { region: 'TX', postalCode: '78701' }, ADDRESS_KEYS);
      await clickAndLoad(page, submitButton(page, 'C'));
      assert.equal(pathOf(page), ROUTES.C.review);
      const draft = app.state().draft;
      assert.equal(draft.region, 'TX');
      assert.equal(draft.city, 'Austin');
      assert.equal(draft.delivery, 'standard');
    });
  });
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const executablePath = findChromium();
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    await checksGlobal();
    for (const v of variants) await checksVariant(v);
    await checksVariantA();
    await checksVariantB();
    await checksVariantC();
  } finally {
    await browser.close();
  }
  for (const { name, error } of failures) {
    console.error(`\n--- ${name}\n${error?.stack ?? error}`);
  }
  console.log(
    `\n${passed}/${total} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
