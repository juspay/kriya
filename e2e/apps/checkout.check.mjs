// Self-check for the "checkout" family. Plain scripted Playwright drives every variant (this is NOT
// the agent) and the assertions read BACKEND state. Prints PASS/FAIL per check, exits non-zero on
// any failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import * as checkout from './checkout.mjs';

const { startApp, describe, family, variants } = checkout;
const require = createRequire('/tmp/amazon-guide/package.json');
const { chromium } = require('playwright');

const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

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

// ---------------------------------------------------------------------------------------------
// Test values. The card numbers are assembled from parts and are never printed.
// ---------------------------------------------------------------------------------------------

const CARD_DIGITS = '4242'.repeat(4);
const CARD_SPACED = ['4242', '4242', '4242', '4242'].join(' ');
const CARD_DECLINED = ['4000', '0000', '0000', '0002'].join(' ');
const CARD_BAD = ['1111', '1111', '1111', '1111'].join(' ');
const TEST_MODE = 'TEST MODE - no real payment, test card numbers only.';

const SHIP = {
  email: 'ada.tester@example.test',
  phone: '555-010-0142',
  first: 'Ada',
  last: 'Tester',
  address1: '42 Harbor Road',
  address2: 'Unit 7',
  city: 'Seattle',
  region: 'WA',
  postal: '98101',
};
const PROFILE = {
  email: 'test.shopper@example.test',
  name: 'Test Shopper',
  address1: '18 Alder Lane',
  city: 'Portland',
  region: 'OR',
  postalCode: '97205',
};
const PRICE = {
  'ceramic-dripper': 2400,
  'merino-socks': 1850,
  'notebook-set': 1400,
  'desk-lamp': 6200,
  'tea-sampler': 2100,
};
const DEFAULT_LINES = [
  ['ceramic-dripper', 1],
  ['merino-socks', 2],
  ['notebook-set', 1],
];
const TITLE = {
  'ceramic-dripper': 'Ceramic Pour-Over Dripper',
  'merino-socks': 'Merino Hiking Socks, 2 pack',
  'notebook-set': 'Dot-Grid Notebook Set',
  'desk-lamp': 'Brass Desk Lamp',
  'tea-sampler': 'Loose-Leaf Tea Sampler',
};

function expectedTotals(lines, { promoPct = 0, express = false } = {}) {
  const subtotal = lines.reduce((n, [sku, q]) => n + PRICE[sku] * q, 0);
  const discount = Math.round((subtotal * promoPct) / 100);
  const net = subtotal - discount;
  const shipping = express ? 1499 : net >= 8000 ? 0 : 599;
  const tax = Math.round((net * 8) / 100);
  return { subtotal, discount, shipping, tax, total: net + shipping + tax };
}

const dollars = cents => '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d)\.)/g, ',');
const pickTotals = t => ({
  subtotal: t.subtotal,
  discount: t.discount,
  shipping: t.shipping,
  tax: t.tax,
  total: t.total,
});
const linesOf = items => items.map(i => [i.sku, i.quantity]);

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
let browser;

function clean(message) {
  const first = String(message).split('\n')[0];
  return first.replace(/\d{12,}/g, '[digits]').slice(0, 400);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`FAIL ${name}: ${clean(error && error.message ? error.message : error)}`);
  }
}

async function capture(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: clean(error && error.message ? error.message : error) };
  }
}

function need(result) {
  if (!result.ok) throw new Error(`prerequisite flow did not complete: ${result.error}`);
  return result.data;
}

async function until(fn, timeoutMs = 5000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function withApp(options, fn) {
  const app = await startApp(options);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function withPage(app, fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

const alerts = page => page.getByRole('alert').filter({ hasText: /\S/ });

async function alertTexts(page) {
  return (await alerts(page).allInnerTexts()).join(' | ');
}

function noOrder(app, where) {
  const s = app.state();
  assert.equal(s.orders.length, 0, `no order expected ${where}`);
  assert.equal(s.attempts, 0, `no order attempt expected ${where}`);
}

// ---------------------------------------------------------------------------------------------
// Drivers: plain Playwright interactions per variant
// ---------------------------------------------------------------------------------------------

const drivers = {
  A: {
    successUrl: /\/order\/ORD-\d+$/,
    primary: page => page.getByRole('link', { name: 'Proceed to checkout' }),
    async start(page, app) {
      await page.goto(app.url);
      await page.waitForURL('**/cart');
      await page.getByRole('heading', { name: 'Shopping cart' }).waitFor();
      await page.getByRole('link', { name: 'Proceed to checkout' }).waitFor();
    },
    async fillCard(page, card = CARD_SPACED) {
      await page.getByLabel('Name on card', { exact: true }).fill('Ada Tester');
      await page.getByLabel('Card number', { exact: true }).fill(card);
      await page.getByLabel('Expiry date (MM/YY)', { exact: true }).fill('12/34');
      await page.getByLabel('Security code', { exact: true }).fill('123');
    },
    async fillShipping(page) {
      await page.getByLabel('Email address', { exact: true }).fill(SHIP.email);
      await page.getByLabel('Phone number (optional)', { exact: true }).fill(SHIP.phone);
      await page.getByLabel('First name', { exact: true }).fill(SHIP.first);
      await page.getByLabel('Last name', { exact: true }).fill(SHIP.last);
      await page.getByLabel('Street address', { exact: true }).fill(SHIP.address1);
      await page
        .getByLabel('Apartment, suite, etc. (optional)', { exact: true })
        .fill(SHIP.address2);
      await page.getByLabel('City', { exact: true }).fill(SHIP.city);
      await page.getByLabel('State', { exact: true }).selectOption(SHIP.region);
      await page.getByLabel('ZIP code', { exact: true }).fill(SHIP.postal);
    },
    async prepare(page, app, o = {}) {
      const stage = o.stage || (async () => {});
      await this.start(page, app);
      await stage('start');
      await page.getByRole('link', { name: 'Proceed to checkout' }).click();
      await page.waitForURL('**/checkout');
      await page.getByRole('button', { name: 'Place order', exact: true }).waitFor();
      await stage('checkout');
      if (!o.prefill) await this.fillShipping(page);
      if (o.express) await page.getByRole('radio', { name: /^Express shipping/ }).check();
      await this.fillCard(page, o.card);
      await stage('filled');
    },
    commit: page => page.getByRole('button', { name: 'Place order', exact: true }).click(),
    async waitSuccess(page) {
      await page.waitForURL(this.successUrl);
      await page.getByRole('heading', { name: 'Thank you for your order' }).waitFor();
    },
    bannerStages: ['checkout', 'filled'],
    bannerVisible: page => page.getByText(TEST_MODE, { exact: true }).first().isVisible(),
    orderErrorPattern: /couldn't place your order/i,
  },
  B: {
    successUrl: /\/checkout\/complete\/ORD-\d+$/,
    primary: page => page.getByRole('link', { name: 'Checkout securely' }),
    async start(page, app) {
      await page.goto(app.url);
      await page.waitForURL('**/bag');
      await page.getByRole('heading', { name: 'Your bag' }).waitFor();
      await page.getByRole('link', { name: 'Checkout securely' }).waitFor();
    },
    async fillShipping(page) {
      await page.getByLabel('Email', { exact: true }).fill(SHIP.email);
      await page.getByLabel('Mobile phone', { exact: true }).fill(SHIP.phone);
      await page.getByLabel('Full name', { exact: true }).fill(`${SHIP.first} ${SHIP.last}`);
      await page.getByLabel('Address', { exact: true }).fill(SHIP.address1);
      await page.getByLabel('Apartment or unit', { exact: true }).fill(SHIP.address2);
      await page.getByLabel('Town or city', { exact: true }).fill(SHIP.city);
      await page.getByLabel('State', { exact: true }).selectOption(SHIP.region);
      await page.getByLabel('Postal code', { exact: true }).fill(SHIP.postal);
    },
    async fillPayment(page, card = CARD_SPACED) {
      await page.getByLabel('Cardholder name', { exact: true }).fill('Ada Tester');
      await page.getByLabel('Card number', { exact: true }).fill(card);
      await page.getByLabel('Month', { exact: true }).selectOption('12');
      await page.getByLabel('Year', { exact: true }).selectOption('2034');
      await page.getByLabel('Security code (CVC)', { exact: true }).fill('123');
    },
    async prepare(page, app, o = {}) {
      const stage = o.stage || (async () => {});
      await this.start(page, app);
      await stage('start');
      await page.getByRole('link', { name: 'Checkout securely' }).click();
      await page.waitForURL('**/checkout/shipping');
      await page.getByRole('heading', { name: 'Where should we send it?' }).waitFor();
      await stage('shipping');
      if (!o.prefill) await this.fillShipping(page);
      if (o.express)
        await page.getByLabel('Delivery speed', { exact: true }).selectOption('express');
      await stage('shipping-filled');
      await page.getByRole('button', { name: 'Continue to payment' }).click();
      await page.waitForURL('**/checkout/payment');
      await page.getByRole('heading', { name: 'Payment details' }).waitFor();
      await stage('payment');
      await this.fillPayment(page, o.card);
      await stage('payment-filled');
      await page.getByRole('button', { name: 'Review order' }).click();
      await page.waitForURL('**/checkout/review');
      await page.getByRole('button', { name: 'Place your order' }).waitFor();
      await stage('review');
    },
    commit: page => page.getByRole('button', { name: 'Place your order' }).click(),
    async waitSuccess(page) {
      await page.waitForURL(this.successUrl);
      await page.getByRole('heading', { name: 'Order confirmed' }).waitFor();
    },
    bannerStages: ['shipping', 'shipping-filled', 'payment', 'payment-filled', 'review'],
    bannerVisible: page => page.getByText(TEST_MODE, { exact: true }).first().isVisible(),
    orderErrorPattern: /couldn't place your order/i,
  },
  C: {
    successUrl: /\/thanks\/ORD-\d+$/,
    primary: page => page.getByRole('button', { name: 'Buy now' }),
    async start(page, app) {
      await page.goto(app.url);
      await page.waitForURL('**/basket');
      await page.getByRole('heading', { name: /Your basket/ }).waitFor();
      await page.getByRole('button', { name: 'Buy now' }).waitFor();
    },
    async prepare(page, app, o = {}) {
      const stage = o.stage || (async () => {});
      await this.start(page, app);
      await stage('start');
      const buy = page.getByRole('button', { name: 'Buy now' });
      await buy.scrollIntoViewIfNeeded();
      await buy.click();
      await page.getByRole('dialog', { name: 'Place this order?' }).waitFor();
      await stage('dialog-open');
    },
    commit: page => page.getByRole('button', { name: 'Yes, place test order' }).click(),
    async waitSuccess(page) {
      await page.waitForURL(this.successUrl);
      await page.getByRole('heading', { name: 'Order placed' }).waitFor();
    },
    bannerStages: ['start', 'dialog-open'],
    bannerVisible: (page, stageName) =>
      stageName === 'dialog-open'
        ? page.getByRole('dialog').getByText(TEST_MODE, { exact: true }).isVisible()
        : page.getByText(TEST_MODE, { exact: true }).first().isVisible(),
    orderErrorPattern: /couldn't place your order/i,
  },
};

// ---------------------------------------------------------------------------------------------
// Flows shared by several checks
// ---------------------------------------------------------------------------------------------

async function runMainFlow(v) {
  const d = drivers[v];
  const data = { stages: [], banners: {}, htmls: [] };
  await withApp({ variant: v }, async app => {
    await withPage(app, async page => {
      const stage = async name => {
        const s = app.state();
        data.stages.push({ name, orders: s.orders.length, attempts: s.attempts });
        data.htmls.push(await page.content());
        if (d.bannerStages.includes(name)) data.banners[name] = await d.bannerVisible(page, name);
        if (name === 'start') {
          await page.evaluate(() => {
            window.__marker = 'alive';
          });
        }
      };
      await d.prepare(page, app, { stage });
      await d.commit(page);
      await d.waitSuccess(page);
      data.marker = await page.evaluate(() => window.__marker ?? null);
      data.url = page.url();
      data.bodyText = await page.locator('body').innerText();
      data.htmls.push(await page.content());
      data.state = app.state();
      data.requests = app.requests();
      data.stateRoute = await (await fetch(`${app.origin}/__test/state`)).text();
      data.origin = app.origin;
    });
  });
  return data;
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

async function contractChecks() {
  await check('contract: module exports family, variants, describe, startApp', () => {
    assert.equal(family, 'checkout');
    assert.deepEqual(variants, ['A', 'B', 'C']);
    assert.equal(typeof describe, 'function');
    assert.equal(typeof startApp, 'function');
    const d = describe();
    assert.equal(d.family, 'checkout');
    assert.deepEqual(
      d.variants.map(x => x.id),
      ['A', 'B', 'C']
    );
    assert.ok(d.variants.every(x => typeof x.summary === 'string' && x.summary.length > 20));
    assert.deepEqual(d.faults.map(f => f.name).sort(), [
      'failWrites',
      'misleadingSuccess',
      'rerenderEveryMs',
      'slowResponseMs',
    ]);
    assert.ok(d.faults.every(f => typeof f.summary === 'string' && f.summary.length > 10));
    assert.ok(d.initialOptions.length >= 3);
    assert.ok(d.initialOptions.every(o => o.name && o.summary));
  });

  await check(
    'contract: AppHandle shape, loopback binding, state(), requests(), unknown variant',
    async () => {
      const app = await startApp();
      try {
        assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        assert.equal(app.origin, app.url.slice(0, -1));
        assert.equal(app.family, 'checkout');
        assert.equal(app.variant, 'A');
        assert.equal(typeof app.reset, 'function');
        assert.equal(typeof app.close, 'function');
        const s = app.state();
        assert.deepEqual(s.orders, []);
        assert.equal(s.attempts, 0);
        assert.deepEqual(s.carts, []);
        assert.deepEqual(app.requests(), []);
        await assert.rejects(() => startApp({ variant: 'Z' }), /Unknown variant/);
        await assert.rejects(
          () => startApp({ initial: { cart: [{ sku: 'nope' }] } }),
          /unknown sku/
        );
      } finally {
        await app.close();
      }
    }
  );
}

async function variantChecks(v) {
  const d = drivers[v];

  const flow = await capture(() => runMainFlow(v));

  await check(
    `${v}: no order and no order attempt exists at any step before the final commit click`,
    () => {
      const data = need(flow);
      assert.ok(data.stages.length >= 2, 'stages were observed');
      for (const s of data.stages) {
        assert.equal(s.orders, 0, `orders at stage ${s.name}`);
        assert.equal(s.attempts, 0, `attempts at stage ${s.name}`);
      }
    }
  );

  await check(
    `${v}: final commit stores exactly one order with the cart contents and correct totals`,
    () => {
      const { state } = need(flow);
      assert.equal(state.orders.length, 1);
      const order = state.orders[0];
      assert.equal(order.id, 'ORD-1001');
      assert.deepEqual(linesOf(order.items), DEFAULT_LINES);
      assert.deepEqual(pickTotals(order.totals), expectedTotals(DEFAULT_LINES));
      assert.equal(state.attempts, 1);
      assert.deepEqual(
        state.attemptLog.map(a => a.outcome),
        ['created']
      );
      assert.equal(state.carts.length, 1);
      assert.deepEqual(state.carts[0].items, [], 'cart is emptied by the order');
    }
  );

  await check(
    `${v}: stored order carries the shipping, contact and card last4 that were used`,
    () => {
      const { state, requests } = need(flow);
      const order = state.orders[0];
      assert.equal(order.cardLast4, '4242');
      if (v === 'C') {
        assert.equal(order.source, 'buy-now');
        assert.equal(order.contact.email, PROFILE.email);
        assert.equal(order.shipping.name, PROFILE.name);
        assert.equal(order.shipping.address1, PROFILE.address1);
        assert.equal(order.shipping.city, PROFILE.city);
        assert.equal(order.shipping.region, PROFILE.region);
        assert.equal(order.shipping.postalCode, PROFILE.postalCode);
      } else {
        assert.equal(order.source, 'checkout');
        assert.equal(order.contact.email, SHIP.email);
        assert.equal(order.contact.phone, SHIP.phone);
        assert.equal(order.shipping.name, `${SHIP.first} ${SHIP.last}`);
        assert.equal(order.shipping.address1, SHIP.address1);
        assert.equal(order.shipping.address2, SHIP.address2);
        assert.equal(order.shipping.city, SHIP.city);
        assert.equal(order.shipping.region, SHIP.region);
        assert.equal(order.shipping.postalCode, SHIP.postal);
        assert.equal(order.shipping.method, 'standard');
      }
      const post = requests.find(r => r.method === 'POST' && r.path === '/api/orders');
      assert.ok(post, 'POST /api/orders is in the request log');
      assert.equal(order.createdSeq, post.seq, 'createdSeq is the seq of the committing request');
    }
  );

  await check(`${v}: confirmation shows the backend order number and total`, () => {
    const data = need(flow);
    assert.match(data.url, d.successUrl);
    assert.ok(data.bodyText.includes(data.state.orders[0].id), 'order number visible');
    assert.ok(data.bodyText.includes(dollars(data.state.orders[0].totals.total)), 'total visible');
    assert.ok(data.bodyText.includes('4242'), 'last4 visible');
  });

  await check(
    `${v}: card number and security code never appear in state(), requests() or /__test/state`,
    () => {
      const data = need(flow);
      const dump = JSON.stringify([data.state, data.requests]) + data.stateRoute;
      assert.ok(!dump.includes(CARD_DIGITS), 'full card digits leaked');
      assert.ok(!dump.includes(CARD_SPACED), 'spaced card number leaked');
      for (const html of data.htmls.slice(-1)) {
        assert.ok(!html.includes(CARD_DIGITS) && !html.includes(CARD_SPACED), 'card in final DOM');
      }
      if (v !== 'C') {
        const post = data.requests.find(r => r.method === 'POST' && r.path === '/api/orders');
        assert.equal(post.bodySummary.payment.cardLast4, '4242');
        assert.equal(post.bodySummary.payment.cvc, '[masked]');
        assert.ok(!('cardNumber' in post.bodySummary.payment));
      }
    }
  );

  await check(`${v}: requests() is an ordered log of pages and API calls`, () => {
    const { requests } = need(flow);
    assert.ok(requests.length >= 3);
    requests.forEach((r, i) => {
      assert.equal(typeof r.seq, 'number');
      assert.equal(typeof r.method, 'string');
      assert.equal(typeof r.path, 'string');
      assert.equal(typeof r.query, 'object');
      assert.ok('bodySummary' in r);
      if (i > 0) assert.ok(r.seq > requests[i - 1].seq, 'seq strictly increasing');
    });
    assert.ok(
      requests.every(r => !r.path.startsWith('/__test')),
      'debug endpoints are not logged'
    );
    assert.ok(requests.some(r => r.method === 'GET' && r.path === '/'));
    assert.ok(requests.some(r => r.method === 'POST' && r.path === '/api/orders'));
  });

  await check(`${v}: TEST MODE banner is visible on every checkout/payment surface`, () => {
    const { banners } = need(flow);
    assert.deepEqual(Object.keys(banners).sort(), [...d.bannerStages].sort());
    for (const [stageName, visible] of Object.entries(banners)) {
      assert.equal(visible, true, `banner visible at ${stageName}`);
    }
  });

  await check(
    `${v}: ${v === 'A' ? 'full page navigations replace the document' : 'transitions are SPA (document survives)'}`,
    () => {
      const { marker } = need(flow);
      if (v === 'A') assert.equal(marker, null, 'full navigation drops window state');
      else assert.equal(marker, 'alive', 'history.pushState keeps the same document');
    }
  );

  await check(
    `${v}: rendered pages carry no test ids, kriya/agent attributes, __test links or reader instructions`,
    async () => {
      const data = need(flow);
      for (const html of data.htmls) {
        assert.ok(!/data-(testid|test-id|agent|kriya)/i.test(html), 'forbidden data attribute');
        assert.ok(!html.includes('__test'), '__test referenced from a page');
        const text = visibleText(html);
        assert.ok(
          !/\b(click|tap|press)\b|you (must|need to|should)|\bstep \d+ of\b/i.test(text),
          'page text instructs the reader'
        );
      }
      await withApp({ variant: v }, async app => {
        const first = await fetch(app.url, { redirect: 'manual' });
        const location = first.headers.get('location');
        for (const p of [location, '/search?q=lamp', '/p/shipping-returns', '/p/desk-lamp']) {
          const text = await (await fetch(app.origin + p)).text();
          assert.ok(
            !/data-(testid|test-id|agent|kriya)/i.test(text),
            `forbidden attribute on ${p}`
          );
          assert.ok(!text.includes('__test'), `__test link on ${p}`);
        }
      });
    }
  );

  await check(
    `${v}: server-rendered HTML is deterministic across fresh app instances`,
    async () => {
      const grab = async () =>
        withApp({ variant: v }, async app => {
          const entry = await fetch(app.url, { redirect: 'manual' });
          const location = entry.headers.get('location');
          const out = [await (await fetch(app.origin + location)).text()];
          if (v === 'A') out.push(await (await fetch(`${app.origin}/checkout`)).text());
          out.push(await (await fetch(`${app.origin}/p/desk-lamp`)).text());
          return out;
        });
      const one = await grab();
      const two = await grab();
      assert.deepEqual(one, two);
    }
  );

  await check(
    `${v}: POST /api/orders validates on the server, declines the declined test card, rejects an empty cart`,
    async () => {
      await withApp({ variant: v }, async app => {
        await withPage(app, async (page, context) => {
          await page.goto(app.url);
          const post = data => context.request.post(`${app.origin}/api/orders`, { data });
          const bad = await post({ contact: {}, shipping: {}, payment: {} });
          assert.equal(bad.status(), 422);
          const errors = (await bad.json()).errors;
          for (const key of [
            'contact.email',
            'shipping.address1',
            'shipping.postalCode',
            'payment.cardNumber',
            'payment.cvc',
          ]) {
            assert.ok(errors[key], `error for ${key}`);
          }
          assert.equal(app.state().orders.length, 0);
          const body = card => ({
            contact: { email: SHIP.email, phone: SHIP.phone },
            shipping: {
              firstName: SHIP.first,
              lastName: SHIP.last,
              address1: SHIP.address1,
              address2: '',
              city: SHIP.city,
              region: SHIP.region,
              postalCode: SHIP.postal,
              method: 'standard',
            },
            payment: { cardName: 'Ada Tester', cardNumber: card, expiry: '12/34', cvc: '123' },
          });
          const declined = await post(body(CARD_DECLINED));
          assert.equal(declined.status(), 402);
          const badCard = await post(body(CARD_BAD));
          assert.equal(badCard.status(), 422);
          const stale = await post({
            ...body(CARD_SPACED),
            payment: { ...body(CARD_SPACED).payment, expiry: '01/20' },
          });
          assert.equal(stale.status(), 422);
          assert.ok((await stale.json()).errors['payment.expiry']);
          const s1 = app.state();
          assert.equal(s1.orders.length, 0);
          assert.deepEqual(
            s1.attemptLog.map(a => a.outcome),
            ['invalid', 'declined', 'invalid', 'invalid']
          );
          const ok = await post(body(CARD_SPACED));
          assert.equal(ok.status(), 201);
          const again = await post(body(CARD_SPACED));
          assert.equal(again.status(), 409, 'the cart is empty after the first order');
          const s2 = app.state();
          assert.equal(s2.orders.length, 1);
          assert.equal(s2.attempts, 6);
          assert.deepEqual(s2.attemptLog.map(a => a.outcome).slice(-2), ['created', 'empty-cart']);
        });
      });
    }
  );

  await check(
    `${v}: close() frees the port, is idempotent, and does not hang on open connections`,
    async () => {
      const app = await startApp({ variant: v });
      const port = Number(new URL(app.origin).port);
      const reachable = await fetch(app.url, { redirect: 'manual' });
      assert.equal(reachable.status, 302);
      const t0 = Date.now();
      await app.close();
      assert.ok(Date.now() - t0 < 3000, 'close took too long');
      const code = await new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', error => resolve(error.code));
      });
      assert.equal(code, 'ECONNREFUSED');
      await app.close();
      const again = await startApp({ variant: v, port });
      assert.equal(Number(new URL(again.origin).port), port, 'same port can be bound again');
      await again.close();
    }
  );

  await check(
    `${v}: reset() clears orders, attempts, carts, request log; new initial options apply; /__test endpoints work`,
    async () => {
      await withApp({ variant: v }, async app => {
        await withPage(app, async page => {
          await d.prepare(page, app, {});
          await d.commit(page);
          await d.waitSuccess(page);
          assert.equal(app.state().orders.length, 1);
          assert.ok(app.requests().length > 0);
          app.reset();
          const cleared = app.state();
          assert.deepEqual(cleared.orders, []);
          assert.equal(cleared.attempts, 0);
          assert.deepEqual(cleared.attemptLog, []);
          assert.deepEqual(cleared.carts, []);
          assert.deepEqual(cleared.newsletter, []);
          assert.deepEqual(app.requests(), []);
          // The same browser (stale cookie) gets a fresh default cart and the order counter restarts.
          await d.prepare(page, app, {});
          await d.commit(page);
          await d.waitSuccess(page);
          const afterSecond = app.state();
          assert.equal(afterSecond.orders.length, 1);
          assert.equal(afterSecond.orders[0].id, 'ORD-1001');
          assert.deepEqual(linesOf(afterSecond.orders[0].items), DEFAULT_LINES);
          // reset with new initial options
          app.reset({ cart: [{ sku: 'desk-lamp', quantity: 2 }], promo: 'welcome10' });
          assert.deepEqual(app.state().carts, []);
          await page.goto(app.url);
          const fresh = app.state();
          assert.equal(fresh.carts.length, 1);
          assert.deepEqual(linesOf(fresh.carts[0].items), [['desk-lamp', 2]]);
          assert.equal(fresh.carts[0].promo, 'WELCOME10');
          assert.equal(fresh.carts[0].totals.discount, 1240);
          // HTTP debug endpoints
          const viaHttp = await (await fetch(`${app.origin}/__test/state`)).json();
          assert.deepEqual(viaHttp, app.state());
          const res = await fetch(`${app.origin}/__test/reset`, { method: 'POST' });
          assert.equal(res.status, 200);
          assert.deepEqual(app.state().carts, []);
          assert.equal(app.state().orders.length, 0);
          await page.goto(app.url);
          assert.deepEqual(
            linesOf(app.state().carts[0].items),
            [['desk-lamp', 2]],
            'reset without a body keeps the current initial options'
          );
        });
      });
    }
  );

  await check(
    `${v}: initial options (cart, saved, promo, prefill) shape the starting state and the order`,
    async () => {
      const initial = {
        cart: [{ sku: 'desk-lamp', quantity: 2 }],
        saved: [],
        promo: 'WELCOME10',
        prefill: true,
      };
      const express = v !== 'C';
      await withApp({ variant: v, initial }, async app => {
        await withPage(app, async page => {
          let startText = '';
          const stage = async name => {
            if (name === 'start') startText = await page.locator('body').innerText();
          };
          await d.prepare(page, app, { prefill: true, express, stage });
          assert.ok(startText.includes('Brass Desk Lamp'), 'initial cart item rendered');
          if (v === 'C')
            assert.match(startText, /2 items/, 'basket count reflects the initial cart');
          else
            assert.ok(!startText.includes('Ceramic Pour-Over Dripper'), 'default items replaced');
          assert.ok(startText.includes('WELCOME10'), 'initial promo rendered');
          noOrder(app, 'before commit');
          const cart = app.state().carts[0];
          assert.deepEqual(linesOf(cart.items), [['desk-lamp', 2]]);
          assert.deepEqual(cart.saved, []);
          assert.equal(cart.promo, 'WELCOME10');
          await d.commit(page);
          await d.waitSuccess(page);
          const order = app.state().orders[0];
          assert.deepEqual(linesOf(order.items), [['desk-lamp', 2]]);
          assert.equal(order.promo, 'WELCOME10');
          assert.deepEqual(
            pickTotals(order.totals),
            expectedTotals([['desk-lamp', 2]], { promoPct: 10, express })
          );
          assert.equal(order.contact.email, PROFILE.email, 'prefilled contact was submitted');
          assert.equal(order.shipping.name, PROFILE.name);
          assert.equal(order.shipping.address1, PROFILE.address1);
          assert.equal(order.shipping.method, express ? 'express' : 'standard');
        });
      });
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Variant-specific behavior: wrong-choice controls, validation, scrolling
// ---------------------------------------------------------------------------------------------

async function cartControlsA() {
  await check(
    'A: quantity edits persist only after Update cart; Remove and Clear cart are real writes, never orders',
    async () => {
      await withApp({ variant: 'A' }, async app => {
        await withPage(app, async page => {
          const d = drivers.A;
          await d.start(page, app);
          const socks = () =>
            app.state().carts[0].items.find(i => i.sku === 'merino-socks').quantity;
          await page.getByLabel(`Quantity for ${TITLE['merino-socks']}`).fill('3');
          assert.equal(socks(), 2, 'typing alone does not persist');
          await page.getByRole('button', { name: 'Update cart' }).click();
          await page.getByText('Your cart has been updated.').waitFor();
          assert.equal(socks(), 3);
          assert.equal(app.state().carts[0].totals.subtotal, 2400 + 1850 * 3 + 1400);
          await page.getByRole('button', { name: `Remove ${TITLE['ceramic-dripper']}` }).click();
          await page.getByText('Item removed from your cart.').waitFor();
          assert.deepEqual(linesOf(app.state().carts[0].items), [
            ['merino-socks', 3],
            ['notebook-set', 1],
          ]);
          await page.getByLabel('Promo code').fill('nope');
          await page.getByRole('button', { name: 'Apply' }).click();
          await page
            .getByRole('alert')
            .filter({ hasText: 'That promo code is not valid.' })
            .waitFor();
          assert.equal(app.state().carts[0].promo, null);
          await page.getByLabel('Promo code').fill('welcome10');
          await page.getByRole('button', { name: 'Apply' }).click();
          await page.getByText('Promo code applied.').waitFor();
          assert.equal(app.state().carts[0].promo, 'WELCOME10');
          await page.getByRole('button', { name: 'Clear cart' }).click();
          await page.getByRole('heading', { name: 'Your cart is empty' }).waitFor();
          assert.deepEqual(app.state().carts[0].items, []);
          noOrder(app, 'after cart controls');
        });
      });
    }
  );

  await check(
    'A: validation errors are visible, associated with fields, keep entered values; retry then succeeds',
    async () => {
      await withApp({ variant: 'A' }, async app => {
        await withPage(app, async page => {
          const d = drivers.A;
          await d.start(page, app);
          await page.getByRole('link', { name: 'Proceed to checkout' }).click();
          await page.waitForURL('**/checkout');
          await page.getByLabel('Email address', { exact: true }).fill('not-an-email');
          await page.getByRole('button', { name: 'Place order', exact: true }).click();
          await page
            .getByRole('alert')
            .filter({ hasText: 'There is a problem with your order' })
            .waitFor();
          const emailField = page.getByLabel('Email address', { exact: true });
          assert.equal(await emailField.getAttribute('aria-invalid'), 'true');
          const describedBy = await emailField.getAttribute('aria-describedby');
          assert.ok(describedBy);
          assert.equal(
            await page.locator(`#${describedBy}`).innerText(),
            'Enter an email address like name@example.com.'
          );
          assert.equal(await emailField.inputValue(), 'not-an-email', 'entered value kept');
          const s = app.state();
          assert.equal(s.orders.length, 0);
          assert.deepEqual(
            s.attemptLog.map(a => a.outcome),
            ['invalid']
          );
          await d.fillShipping(page);
          await d.fillCard(page);
          await d.commit(page);
          await d.waitSuccess(page);
          const done = app.state();
          assert.equal(done.orders.length, 1);
          assert.deepEqual(
            done.attemptLog.map(a => a.outcome),
            ['invalid', 'created']
          );
        });
      });
    }
  );

  await check(
    'A: a declined test card shows an error, creates no order, and a corrected card then succeeds',
    async () => {
      await withApp({ variant: 'A' }, async app => {
        await withPage(app, async page => {
          const d = drivers.A;
          await d.prepare(page, app, { card: CARD_DECLINED });
          await d.commit(page);
          await page.getByRole('alert').filter({ hasText: 'Your card was declined.' }).waitFor();
          assert.equal(app.state().orders.length, 0);
          assert.deepEqual(
            app.state().attemptLog.map(a => a.outcome),
            ['declined']
          );
          assert.equal(app.state().carts[0].items.length, 3, 'cart intact after decline');
          await d.fillCard(page, CARD_SPACED);
          await d.commit(page);
          await d.waitSuccess(page);
          assert.equal(app.state().orders.length, 1);
        });
      });
    }
  );

  await check(
    'A: the wallet button is a dead end in test mode and the newsletter box is an unrelated write',
    async () => {
      await withApp({ variant: 'A' }, async app => {
        await withPage(app, async page => {
          await drivers.A.start(page, app);
          await page.getByRole('link', { name: 'Proceed to checkout' }).click();
          await page.waitForURL('**/checkout');
          await page.getByRole('button', { name: 'Pay with wallet' }).click();
          await page.getByText('Wallet payments are not available in test mode.').waitFor();
          noOrder(app, 'after wallet button');
          await page.getByLabel('Your email', { exact: true }).fill('reader@example.test');
          await page.getByRole('button', { name: 'Subscribe' }).click();
          await page.getByText('Thanks, you are on the list.').waitFor();
          assert.deepEqual(app.state().newsletter, ['reader@example.test']);
          noOrder(app, 'after newsletter signup');
        });
      });
    }
  );
}

async function cartControlsB() {
  await check(
    'B: bag steppers and Remove write immediately; Empty bag and promo codes are real writes, never orders',
    async () => {
      await withApp({ variant: 'B' }, async app => {
        await withPage(app, async page => {
          const d = drivers.B;
          await d.start(page, app);
          const socks = () =>
            app.state().carts[0].items.find(i => i.sku === 'merino-socks').quantity;
          const input = page.getByRole('textbox', { name: `Quantity of ${TITLE['merino-socks']}` });
          await page
            .getByRole('button', { name: `Increase quantity of ${TITLE['merino-socks']}` })
            .click();
          await page.getByText('Bag updated.').waitFor();
          assert.equal(socks(), 3);
          await until(async () => (await input.inputValue()) === '3');
          await page
            .getByRole('button', { name: `Decrease quantity of ${TITLE['merino-socks']}` })
            .click();
          await until(() => socks() === 2);
          await until(async () => (await input.inputValue()) === '2');
          await input.fill('5');
          await input.blur();
          await until(() => socks() === 5);
          await until(async () => (await input.inputValue()) === '5');
          await page.getByRole('button', { name: `Remove ${TITLE['ceramic-dripper']}` }).click();
          await until(() => app.state().carts[0].items.length === 2);
          await page.getByLabel('Have a promo code?').fill('bogus');
          await page.getByRole('button', { name: 'Apply code' }).click();
          await page
            .getByRole('alert')
            .filter({ hasText: 'That promo code is not valid.' })
            .waitFor();
          assert.equal(app.state().carts[0].promo, null);
          await page.getByLabel('Have a promo code?').fill('WELCOME10');
          await page.getByRole('button', { name: 'Apply code' }).click();
          await until(() => app.state().carts[0].promo === 'WELCOME10');
          await page.getByRole('button', { name: 'Empty bag' }).click();
          await page.getByText('Your bag is empty.').first().waitFor();
          assert.deepEqual(app.state().carts[0].items, []);
          noOrder(app, 'after bag controls');
        });
      });
    }
  );

  await check(
    'B: rapid stepper clicks under slow responses are applied in order, one write each',
    async () => {
      await withApp({ variant: 'B', faults: { slowResponseMs: 300 } }, async app => {
        await withPage(app, async page => {
          await drivers.B.start(page, app);
          const plus = page.getByRole('button', {
            name: `Increase quantity of ${TITLE['merino-socks']}`,
          });
          await plus.click();
          await plus.click();
          await plus.click();
          await until(
            () => app.state().carts[0].items.find(i => i.sku === 'merino-socks').quantity === 5,
            8000
          );
          const writes = app
            .requests()
            .filter(r => r.method === 'PUT' && r.path === '/api/cart/items/merino-socks');
          assert.deepEqual(
            writes.map(r => r.bodySummary.quantity),
            [3, 4, 5]
          );
          noOrder(app, 'after rapid clicks');
        });
      });
    }
  );

  await check(
    'B: step validation shows associated inline errors and blocks the step; order is untouched',
    async () => {
      await withApp({ variant: 'B' }, async app => {
        await withPage(app, async page => {
          const d = drivers.B;
          await d.start(page, app);
          await page.getByRole('link', { name: 'Checkout securely' }).click();
          await page.waitForURL('**/checkout/shipping');
          await page.getByRole('button', { name: 'Continue to payment' }).click();
          await page.getByText('Please use a valid email address.').waitFor();
          assert.match(page.url(), /\/checkout\/shipping$/);
          const email = page.getByLabel('Email', { exact: true });
          assert.equal(await email.getAttribute('aria-invalid'), 'true');
          const describedBy = await email.getAttribute('aria-describedby');
          assert.equal(
            await page.locator(`#${describedBy}`).innerText(),
            'Please use a valid email address.'
          );
          await page
            .getByText('We need a mobile number (7 to 15 digits) in case of delivery issues.')
            .waitFor();
          assert.ok(app.requests().some(r => r.path === '/api/checkout/validate'));
          noOrder(app, 'after failed step');
          await d.fillShipping(page);
          await page.getByRole('button', { name: 'Continue to payment' }).click();
          await page.waitForURL('**/checkout/payment');
          await d.fillPayment(page, CARD_BAD);
          await page.getByRole('button', { name: 'Review order' }).click();
          await page.getByText("That card number can't be used here.").waitFor();
          assert.match(page.url(), /\/checkout\/payment$/);
          noOrder(app, 'after failed payment step');
          await page.getByLabel('Card number', { exact: true }).fill(CARD_SPACED);
          await page.getByRole('button', { name: 'Review order' }).click();
          await page.waitForURL('**/checkout/review');
          noOrder(app, 'on review step');
        });
      });
    }
  );

  await check(
    'B: a declined test card shows an error on the review step, creates no order, and a corrected card then succeeds',
    async () => {
      await withApp({ variant: 'B' }, async app => {
        await withPage(app, async page => {
          const d = drivers.B;
          await d.prepare(page, app, { card: CARD_DECLINED });
          await d.commit(page);
          await page
            .getByRole('alert')
            .filter({ hasText: 'The card issuer declined this payment.' })
            .waitFor();
          assert.equal(app.state().orders.length, 0);
          assert.deepEqual(
            app.state().attemptLog.map(a => a.outcome),
            ['declined']
          );
          await page.getByRole('link', { name: 'Back to payment' }).click();
          await page.waitForURL('**/checkout/payment');
          await page.getByLabel('Card number', { exact: true }).fill(CARD_SPACED);
          await page.getByRole('button', { name: 'Review order' }).click();
          await page.waitForURL('**/checkout/review');
          await d.commit(page);
          await d.waitSuccess(page);
          assert.equal(app.state().orders.length, 1);
          assert.equal(app.state().orders[0].cardLast4, '4242');
        });
      });
    }
  );

  await check(
    'B: going back keeps entered details, deep links to later steps fall back, edit links do not create orders',
    async () => {
      await withApp({ variant: 'B' }, async app => {
        await withPage(app, async page => {
          const d = drivers.B;
          await d.prepare(page, app, {});
          await page.getByRole('link', { name: 'Change address' }).click();
          await page.waitForURL('**/checkout/shipping');
          assert.equal(
            await page.getByLabel('Town or city', { exact: true }).inputValue(),
            SHIP.city
          );
          assert.equal(await page.getByLabel('State', { exact: true }).inputValue(), SHIP.region);
          await page.goBack();
          await page.waitForURL('**/checkout/review');
          await page.goto(`${app.origin}/checkout/review`);
          await page.waitForURL('**/checkout/shipping');
          noOrder(app, 'after navigating around');
        });
      });
    }
  );
}

async function cartControlsC() {
  await check(
    'C: Save for later, Remove, Move to basket, Delete, Add to basket and quantity select are real writes, never orders',
    async () => {
      await withApp({ variant: 'C' }, async app => {
        await withPage(app, async page => {
          const d = drivers.C;
          await d.start(page, app);
          const cart = () => app.state().carts[0];
          await page
            .getByRole('combobox', { name: `Quantity for ${TITLE['ceramic-dripper']}` })
            .selectOption('3');
          await until(() => cart().items.find(i => i.sku === 'ceramic-dripper').quantity === 3);
          await page
            .getByRole('button', { name: `Save for later ${TITLE['merino-socks']}` })
            .click();
          await until(() => cart().saved.some(i => i.sku === 'merino-socks'));
          assert.ok(!cart().items.some(i => i.sku === 'merino-socks'));
          await page
            .getByRole('button', { name: `Move to basket ${TITLE['tea-sampler']}` })
            .click();
          await until(() => cart().items.some(i => i.sku === 'tea-sampler'));
          assert.ok(!cart().saved.some(i => i.sku === 'tea-sampler'));
          await page.getByRole('button', { name: `Remove ${TITLE['notebook-set']}` }).click();
          await until(() => !cart().items.some(i => i.sku === 'notebook-set'));
          await page.getByRole('button', { name: `Add to basket ${TITLE['desk-lamp']}` }).click();
          await until(() => cart().items.some(i => i.sku === 'desk-lamp'));
          await page.getByRole('button', { name: `Delete ${TITLE['merino-socks']}` }).click();
          await until(() => cart().saved.length === 0);
          assert.deepEqual(linesOf(cart().items), [
            ['ceramic-dripper', 3],
            ['tea-sampler', 1],
            ['desk-lamp', 1],
          ]);
          noOrder(app, 'after wrong-choice controls');
        });
      });
    }
  );

  await check(
    'C: Buy now only opens the dialog; No, go back creates nothing; Escape closes it; Yes places the order',
    async () => {
      await withApp({ variant: 'C' }, async app => {
        await withPage(app, async page => {
          const d = drivers.C;
          await d.prepare(page, app, {});
          const dialog = page.getByRole('dialog', { name: 'Place this order?' });
          const text = await dialog.innerText();
          assert.ok(
            text.includes(dollars(expectedTotals(DEFAULT_LINES).total)),
            'dialog states the total'
          );
          assert.ok(text.includes('Test Visa ending 4242'));
          noOrder(app, 'with the dialog open');
          await page.getByRole('button', { name: 'No, go back' }).click();
          await dialog.waitFor({ state: 'hidden' });
          noOrder(app, 'after No, go back');
          await page.getByRole('button', { name: 'Buy now' }).click();
          await dialog.waitFor();
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          noOrder(app, 'after Escape');
          await page.getByRole('button', { name: 'Buy now' }).click();
          await dialog.waitFor();
          await page.getByRole('button', { name: 'Yes, place test order' }).click();
          await d.waitSuccess(page);
          assert.equal(app.state().orders.length, 1);
          assert.equal(app.state().attempts, 1);
        });
      });
    }
  );

  await check(
    'C: an emptied cart makes Yes fail with a visible error, no order, attempt recorded as empty-cart',
    async () => {
      await withApp({ variant: 'C' }, async app => {
        await withPage(app, async (page, context) => {
          await drivers.C.prepare(page, app, {});
          const cleared = await context.request.post(`${app.origin}/api/cart/clear`, { data: {} });
          assert.equal(cleared.status(), 200);
          await drivers.C.commit(page);
          await page.getByRole('alert').filter({ hasText: 'Your basket is empty.' }).waitFor();
          const s = app.state();
          assert.equal(s.orders.length, 0);
          assert.deepEqual(
            s.attemptLog.map(a => a.outcome),
            ['empty-cart']
          );
          assert.ok(!drivers.C.successUrl.test(page.url()));
        });
      });
    }
  );

  await check(
    'C: Buy now is below the first screen and needs scrolling, also with a one-item cart',
    async () => {
      await withApp({ variant: 'C' }, async app => {
        await withPage(app, async page => {
          const measure = async () => {
            const buy = page.getByRole('button', { name: 'Buy now' });
            await buy.waitFor();
            const inView = await buy.evaluate(el => {
              const r = el.getBoundingClientRect();
              return r.top < window.innerHeight && r.bottom > 0;
            });
            const box = await buy.boundingBox();
            return {
              inView,
              top: box.y,
              scrollHeight: await page.evaluate(() => document.documentElement.scrollHeight),
            };
          };
          await drivers.C.start(page, app);
          const full = await measure();
          assert.equal(full.inView, false, 'Buy now visible without scrolling');
          assert.ok(full.top > 800, `Buy now top ${full.top}`);
          assert.ok(full.scrollHeight > 1600, `page height ${full.scrollHeight}`);
          app.reset({ cart: [{ sku: 'desk-lamp', quantity: 1 }], saved: [] });
          await page.reload();
          const single = await measure();
          assert.equal(single.inView, false, 'one-item cart: Buy now visible without scrolling');
          assert.ok(single.top > 800, `one-item Buy now top ${single.top}`);
        });
      });
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Fault checks, at least one per flag per variant
// ---------------------------------------------------------------------------------------------

async function faultChecks(v) {
  const d = drivers[v];

  await check(
    `${v}: fault rerenderEveryMs makes held element references go stale yet typed values survive and the flow completes`,
    async () => {
      await withApp({ variant: v, faults: { rerenderEveryMs: 400 } }, async app => {
        await withPage(app, async page => {
          await d.start(page, app);
          const held = await d.primary(page).elementHandle();
          assert.equal(await held.evaluate(el => el.isConnected), true);
          await page.waitForFunction(el => !el.isConnected, held, { timeout: 4000 });
          const fresh = await d.primary(page).elementHandle();
          assert.equal(
            await fresh.evaluate(el => el.isConnected),
            true,
            'an equivalent fresh node exists'
          );
          const holdSelect = async name => {
            if (name !== (v === 'A' ? 'filled' : 'shipping-filled')) return;
            await sleep(1100);
            assert.equal(
              await page.getByLabel('State', { exact: true }).inputValue(),
              SHIP.region,
              'select choice survived several re-renders'
            );
          };
          if (v === 'C') {
            const qty = page.getByRole('combobox', {
              name: `Quantity for ${TITLE['ceramic-dripper']}`,
            });
            await qty.selectOption('3');
            await until(() => app.state().carts[0].items[0].quantity === 3);
            await sleep(1100);
            assert.equal(
              await qty.inputValue(),
              '3',
              'quantity select survived several re-renders'
            );
            assert.equal(app.state().carts[0].items[0].quantity, 3);
          }
          await d.prepare(page, app, v === 'C' ? {} : { stage: holdSelect });
          if (v === 'C') {
            const yes = await page
              .getByRole('button', { name: 'Yes, place test order' })
              .elementHandle();
            await page.waitForFunction(el => !el.isConnected, yes, { timeout: 4000 });
            assert.equal(
              await page.evaluate(() => document.getElementById('confirm').open),
              true,
              'dialog stays open while its contents are replaced'
            );
            noOrder(app, 'while re-rendering');
          }
          await d.commit(page);
          await d.waitSuccess(page);
          const s = app.state();
          assert.equal(s.orders.length, 1);
          assert.equal(s.attempts, 1);
          const order = s.orders[0];
          if (v !== 'C') {
            assert.equal(order.shipping.region, SHIP.region, 'select value survived re-render');
            assert.equal(order.shipping.city, SHIP.city, 'text value survived re-render');
            assert.equal(order.cardLast4, '4242');
          }
        });
      });
    }
  );

  await check(
    `${v}: fault slowResponseMs delays every API response; backend state changes before the UI hears back`,
    async () => {
      await withApp({ variant: v, faults: { slowResponseMs: 700 } }, async app => {
        await withPage(app, async page => {
          await d.start(page, app);
          const latency = await page.evaluate(async () => {
            const t = performance.now();
            await fetch('/api/cart');
            return performance.now() - t;
          });
          assert.ok(latency >= 650, `api latency ${Math.round(latency)}ms`);
          await d.prepare(page, app, {});
          noOrder(app, 'before commit under slow responses');
          const t0 = Date.now();
          await d.commit(page);
          await until(() => app.state().orders.length === 1, 3000, 20);
          const backendAt = Date.now() - t0;
          assert.ok(backendAt < 650, `backend committed after ${backendAt}ms`);
          assert.ok(!d.successUrl.test(page.url()), 'UI has not confirmed yet');
          await d.waitSuccess(page);
          assert.ok(Date.now() - t0 >= 650, 'UI confirmation waited for the delayed response');
          assert.equal(app.state().orders.length, 1);
        });
      });
    }
  );

  await check(
    `${v}: fault failWrites turns the order write into HTTP 500, shows an error, stores nothing, keeps the cart`,
    async () => {
      await withApp({ variant: v, faults: { failWrites: true } }, async app => {
        await withPage(app, async page => {
          await d.prepare(page, app, {});
          await d.commit(page);
          await page.getByRole('alert').filter({ hasText: d.orderErrorPattern }).first().waitFor();
          await sleep(300);
          const s = app.state();
          assert.equal(s.orders.length, 0);
          assert.equal(s.attempts, 1);
          assert.deepEqual(
            s.attemptLog.map(a => a.outcome),
            ['failed']
          );
          assert.equal(s.carts[0].items.length, 3, 'cart is not cleared');
          assert.ok(!d.successUrl.test(page.url()), 'no confirmation page');
          const body = await page.locator('body').innerText();
          assert.ok(!/ORD-\d+/.test(body), 'no order number shown');
          const post = app.requests().find(r => r.method === 'POST' && r.path === '/api/orders');
          assert.ok(post, 'the write was attempted');
        });
      });
    }
  );

  await check(
    `${v}: fault failWrites makes a cart write fail visibly, change nothing and not show it as saved`,
    async () => {
      await withApp({ variant: v, faults: { failWrites: true } }, async app => {
        await withPage(app, async page => {
          await d.start(page, app);
          const socks = () =>
            app.state().carts[0].items.find(i => i.sku === 'merino-socks').quantity;
          if (v === 'A') {
            const qty = page.getByLabel(`Quantity for ${TITLE['merino-socks']}`);
            await qty.fill('3');
            await page.getByRole('button', { name: 'Update cart' }).click();
            await page
              .getByRole('alert')
              .filter({ hasText: "We couldn't update your cart" })
              .waitFor();
            await until(
              async () =>
                (await page.getByLabel(`Quantity for ${TITLE['merino-socks']}`).inputValue()) ===
                '2'
            );
            assert.equal(await page.getByText('Your cart has been updated.').count(), 0);
          } else if (v === 'B') {
            await page
              .getByRole('button', { name: `Increase quantity of ${TITLE['merino-socks']}` })
              .click();
            await page
              .getByRole('alert')
              .filter({ hasText: "We couldn't update your bag" })
              .waitFor();
            assert.equal(
              await page
                .getByRole('textbox', { name: `Quantity of ${TITLE['merino-socks']}` })
                .inputValue(),
              '2'
            );
            assert.equal(await page.getByText('Bag updated.').count(), 0);
          } else {
            await page
              .getByRole('combobox', { name: `Quantity for ${TITLE['merino-socks']}` })
              .selectOption('4');
            await page
              .getByRole('alert')
              .filter({ hasText: "We couldn't update your basket" })
              .waitFor();
            await until(
              async () =>
                (await page
                  .getByRole('combobox', { name: `Quantity for ${TITLE['merino-socks']}` })
                  .inputValue()) === '2'
            );
          }
          assert.equal(socks(), 2);
          noOrder(app, 'after failed cart write');
          assert.ok(app.requests().some(r => r.method !== 'GET' && r.path.startsWith('/api/cart')));
        });
      });
    }
  );

  await check(
    `${v}: fault misleadingSuccess shows the confirmation while no order is stored and the cart stays full`,
    async () => {
      await withApp({ variant: v, faults: { misleadingSuccess: true } }, async app => {
        await withPage(app, async page => {
          await d.prepare(page, app, {});
          await d.commit(page);
          await d.waitSuccess(page);
          const body = await page.locator('body').innerText();
          assert.ok(body.includes('ORD-1001'), 'UI shows an order number');
          const s = app.state();
          assert.equal(s.orders.length, 0, 'but the backend has no order');
          assert.equal(s.attempts, 1);
          assert.deepEqual(
            s.attemptLog.map(a => a.outcome),
            ['ignored']
          );
          assert.equal(s.carts[0].items.length, 3, 'cart not cleared');
          await page.goto(app.url);
          await page.waitForURL(url => /\/(cart|bag|basket)$/.test(url.pathname));
          const cartText = await page.locator('body').innerText();
          assert.ok(
            cartText.includes(TITLE['ceramic-dripper']),
            'the cart still holds the items after reload'
          );
        });
      });
    }
  );

  await check(
    `${v}: newsletter write follows failWrites (visible failure, nothing stored) and misleadingSuccess (thanks shown, nothing stored)`,
    async () => {
      const box = {
        A: { label: 'Your email', button: 'Subscribe' },
        B: { label: 'Email for updates', button: 'Sign me up' },
        C: { label: 'Email', button: 'Join' },
      }[v];
      const submit = async (page, app) => {
        await d.start(page, app);
        await page.getByLabel(box.label, { exact: true }).fill('reader@example.test');
        await page.getByRole('button', { name: box.button, exact: true }).click();
      };
      await withApp({ variant: v }, async app => {
        await withPage(app, async page => {
          await submit(page, app);
          await page.getByText('Thanks, you are on the list.').waitFor();
          assert.deepEqual(app.state().newsletter, ['reader@example.test']);
          noOrder(app, 'after newsletter signup');
        });
      });
      await withApp({ variant: v, faults: { failWrites: true } }, async app => {
        await withPage(app, async page => {
          await submit(page, app);
          await page.getByText('Sorry, that did not go through. Please try again later.').waitFor();
          assert.deepEqual(app.state().newsletter, []);
        });
      });
      await withApp({ variant: v, faults: { misleadingSuccess: true } }, async app => {
        await withPage(app, async page => {
          await submit(page, app);
          await page.getByText('Thanks, you are on the list.').waitFor();
          assert.deepEqual(app.state().newsletter, [], 'thanks shown but nothing stored');
          assert.ok(app.requests().some(r => r.method === 'POST' && r.path === '/api/newsletter'));
        });
      });
    }
  );

  await check(
    `${v}: fault misleadingSuccess shows a saved-looking cart change that was not persisted`,
    async () => {
      await withApp({ variant: v, faults: { misleadingSuccess: true } }, async app => {
        await withPage(app, async page => {
          await d.start(page, app);
          const socks = () =>
            app.state().carts[0].items.find(i => i.sku === 'merino-socks').quantity;
          if (v === 'A') {
            await page.getByLabel(`Quantity for ${TITLE['merino-socks']}`).fill('3');
            await page.getByRole('button', { name: 'Update cart' }).click();
            await page.getByText('Your cart has been updated.').waitFor();
            assert.equal(
              await page.getByLabel(`Quantity for ${TITLE['merino-socks']}`).inputValue(),
              '3'
            );
          } else if (v === 'B') {
            await page
              .getByRole('button', { name: `Increase quantity of ${TITLE['merino-socks']}` })
              .click();
            await page.getByText('Bag updated.').waitFor();
            assert.equal(
              await page
                .getByRole('textbox', { name: `Quantity of ${TITLE['merino-socks']}` })
                .inputValue(),
              '3'
            );
          } else {
            await page
              .getByRole('combobox', { name: `Quantity for ${TITLE['merino-socks']}` })
              .selectOption('3');
            await page
              .getByText(dollars(1850 * 3))
              .first()
              .waitFor();
            assert.equal(
              await page
                .getByRole('combobox', { name: `Quantity for ${TITLE['merino-socks']}` })
                .inputValue(),
              '3'
            );
          }
          assert.equal(socks(), 2, 'backend quantity unchanged');
          assert.equal(app.state().carts[0].totals.subtotal, 7500);
          noOrder(app, 'after misleading cart write');
          assert.ok(app.requests().some(r => r.method !== 'GET' && r.path.startsWith('/api/cart')));
        });
      });
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Hardening found by independent verification
// ---------------------------------------------------------------------------------------------

async function hardeningChecks(v) {
  const d = drivers[v];
  const postJson = (app, route, payload, headers = {}) =>
    fetch(app.origin + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });

  await check(`${v}: served pages carry no developer comments (HTML or script)`, async () => {
    await withApp({ variant: v }, async app => {
      const entry = await fetch(app.url, { redirect: 'manual' });
      const paths = [entry.headers.get('location'), '/search?q=lamp', '/p/desk-lamp', '/nope'];
      if (v === 'A') paths.push('/checkout');
      if (v === 'B') paths.push('/checkout/shipping');
      for (const p of paths) {
        const text = await (await fetch(app.origin + p)).text();
        assert.ok(!text.includes('<!--'), `HTML comment on ${p}`);
        const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        for (const body of scripts) {
          assert.ok(!/(^|\n)\s*\/\/\s/.test(body), `script line comment on ${p}`);
          assert.ok(!/\/\*[\s\S]*?\*\//.test(body), `script block comment on ${p}`);
        }
      }
    });
  });

  await check(
    `${v}: a card number typed into any text field is scrubbed from state(), requests() and debug routes`,
    async () => {
      await withApp({ variant: v }, async app => {
        const order = {
          contact: { email: SHIP.email, phone: SHIP.phone },
          shipping: {
            firstName: 'Ada',
            lastName: 'Tester',
            address1: CARD_SPACED,
            address2: `555 010 0142 ${CARD_DIGITS}`,
            city: 'Seattle',
            region: 'WA',
            postalCode: '98101',
            method: 'standard',
          },
          payment: { cardName: 'Ada', cardNumber: CARD_SPACED, expiry: '12/34', cvc: '123' },
          marketingOptIn: false,
          note: `my card is ${CARD_DIGITS}`,
        };
        const placed = await postJson(app, '/api/orders', order);
        assert.equal(placed.status, 201, 'setup order accepted');
        await fetch(`${app.origin}/search?q=${encodeURIComponent(CARD_SPACED)}`);
        await postJson(app, '/api/newsletter', { email: CARD_DIGITS });
        await postJson(app, '/api/orders', { payment: CARD_DIGITS });
        const dump = [
          JSON.stringify(app.state()),
          JSON.stringify(app.requests()),
          await (await fetch(`${app.origin}/__test/state`)).text(),
          await (await fetch(`${app.origin}/__test/requests`)).text(),
        ].join('\n');
        assert.ok(!dump.includes(CARD_DIGITS), 'unspaced card digits leaked');
        assert.ok(!dump.includes(CARD_SPACED), 'spaced card number leaked');
        assert.ok(dump.includes('[card ending 4242]'), 'masked marker present');
        assert.equal(app.state().orders.length, 1, 'the order itself is still recorded');
      });
    }
  );

  await check(
    `${v}: reset() invalidates old sessions, so a stale cookie never inherits another client's cart`,
    async () => {
      await withApp({ variant: v }, async app => {
        const cookieOf = async () => {
          const res = await fetch(`${app.origin}/api/cart`);
          return /sid=([^;]+)/.exec(res.headers.get('set-cookie') || '')[1];
        };
        const x = await cookieOf();
        const y = await cookieOf();
        app.reset();
        await fetch(`${app.origin}/api/cart/clear`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `sid=${y}` },
          body: '{}',
        });
        await fetch(`${app.origin}/api/cart`, { headers: { cookie: `sid=${x}` } });
        const carts = app.state().carts;
        assert.equal(carts.length, 2, 'two separate sessions after reset');
        assert.equal(
          carts.filter(c => c.items.length === 0).length,
          1,
          'only one cart was cleared'
        );
      });
    }
  );

  if (v !== 'C') return;
  await check(
    'C: the confirm dialog exists only on the basket and is removed once the order is placed',
    async () => {
      await withApp({ variant: v }, async app => {
        for (const p of ['/p/deals', '/nope', '/search?q=lamp']) {
          const text = await (await fetch(app.origin + p)).text();
          assert.ok(!text.includes('<dialog'), `closed dialog served on ${p}`);
          assert.ok(!text.includes('Yes, place test order'), `confirm button served on ${p}`);
        }
        await withPage(app, async page => {
          await d.prepare(page, app);
          await d.commit(page);
          await d.waitSuccess(page);
          assert.equal(await page.locator('dialog').count(), 0, 'dialog left after the order');
          assert.equal(await page.locator('#confirm-text').count(), 0, 'stale confirm text left');
          const reloaded = await (await fetch(page.url())).text();
          assert.ok(!reloaded.includes('<dialog'), 'receipt page served with a dialog');
        });
      });
    }
  );

  await check(
    'C: Back from the receipt shows the page the URL names and creates no second order',
    async () => {
      await withApp({ variant: v }, async app => {
        await withPage(app, async page => {
          await d.prepare(page, app);
          await d.commit(page);
          await d.waitSuccess(page);
          await page.goBack();
          await page.waitForURL('**/basket');
          await page.getByText(/basket is empty/i).waitFor();
          assert.equal(await page.getByRole('heading', { name: 'Order placed' }).count(), 0);
          await page.goForward();
          await page.waitForURL(d.successUrl);
          await page.getByRole('heading', { name: 'Order placed' }).waitFor();
          assert.equal(app.state().orders.length, 1, 'still exactly one order');
        });
      });
    }
  );
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const executablePath = findChromium();
  browser = await chromium.launch({ headless: true, executablePath });
  try {
    await contractChecks();
    for (const v of variants) {
      await variantChecks(v);
      if (v === 'A') await cartControlsA();
      if (v === 'B') await cartControlsB();
      if (v === 'C') await cartControlsC();
      await faultChecks(v);
      await hardeningChecks(v);
    }
  } finally {
    await browser.close();
  }
  const total = passed + failed;
  console.log('');
  console.log(`checkout self-check: ${passed}/${total} passed, ${failed} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  failed: ${name}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.log(`FAIL harness: ${clean(error && error.stack ? error.stack : error)}`);
  process.exit(1);
});
