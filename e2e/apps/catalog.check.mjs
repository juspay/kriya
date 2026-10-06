import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as catalog from './catalog.mjs';

const require = createRequire('/tmp/amazon-guide/package.json');
const { chromium } = require('playwright');

const PINNED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

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

const VIEWPORT = { width: 1280, height: 800 };
const VARIANTS = ['A', 'B', 'C'];
const EARBUDS = 'Northwave Aria Mini Earbuds';

/* Hand-verified expectations over the fixed 30-product catalog. */
const WIRELESS = ['p01', 'p02', 'p04', 'p11', 'p17', 'p20', 'p21', 'p22', 'p29'];
const WIRELESS_PRICE_ASC = ['p29', 'p11', 'p20', 'p04', 'p02', 'p17', 'p21', 'p01', 'p22'];
const WIRELESS_BY_RATING = ['p21', 'p01', 'p22', 'p04', 'p20', 'p02', 'p29', 'p11', 'p17'];
const STEEL_RELEVANCE = ['p10', 'p28', 'p16', 'p18'];
const STEEL_PRICE_ASC = ['p18', 'p16', 'p28', 'p10'];
const KITCHEN_OUTDOOR_50_DESC = ['p26', 'p09', 'p28', 'p11', 'p29', 'p12'];
const EMPTY_FILTERS = { category: [], brand: [], maxPrice: null };

let passed = 0;
let failed = 0;
const failures = [];

const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    const detail = String(error && error.message ? error.message : error)
      .split('\n')
      .slice(0, 8)
      .join('\n     ');
    console.log(`FAIL ${name}\n     ${detail}`);
  }
};

const eq = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const sameSet = (actual, expected, message) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
const params = page => new URL(page.url()).searchParams;
const lastSearch = app => app.state().searches.at(-1);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser;

const session = async (options, fn) => {
  const app = await catalog.startApp(options);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  try {
    await fn({ app, page, pageErrors, context });
  } finally {
    await context.close().catch(() => undefined);
    await app.close();
  }
};

const suite = async (name, options, fn) => {
  try {
    await session(options, fn);
  } catch (error) {
    failed += 1;
    failures.push(`${name} (suite setup/teardown)`);
    console.log(
      `FAIL ${name} (suite setup/teardown)\n     ${String(error && error.message ? error.message : error)}`
    );
  }
};

const TITLE_SELECTOR = { A: '.card h3 a', B: '.row h3 a', C: '.tile h3 a' };
const renderedTitles = (page, variant) => page.locator(TITLE_SELECTOR[variant]).allTextContents();

const COUNT_TEXT = {
  A: n => `Showing ${n} result${n === 1 ? '' : 's'}`,
  B: n => `${n} product${n === 1 ? '' : 's'} found`,
  C: n => `${n} item${n === 1 ? '' : 's'}`,
};
const COUNT_SELECTOR = { A: 'p.count', B: 'p.found', C: 'p.count' };

const waitCount = async (page, variant, n) => {
  const text = COUNT_TEXT[variant](n);
  await page
    .locator(COUNT_SELECTOR[variant])
    .filter({ hasText: new RegExp(`^${text}(\\s|$)`) })
    .first()
    .waitFor({ timeout: 6000 });
};

const loadTitles = async () => {
  const app = await catalog.startApp({ variant: 'A' });
  try {
    const response = await fetch(`${app.origin}/api/products`);
    const body = await response.json();
    return Object.fromEntries(body.products.map(p => [p.id, p.title]));
  } finally {
    await app.close();
  }
};

const portIsFree = port =>
  new Promise(resolve => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

const canConnect = port =>
  new Promise(resolve => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const UI = {
  A: {
    listing: app => `${app.url}?q=earbuds`,
    ready: page => waitCount(page, 'A', 1),
    add: (page, title) => page.getByRole('button', { name: `Add ${title} to cart` }),
    save: (page, title) => page.getByRole('button', { name: `Save ${title} to wishlist` }),
    isSaved: async (page, title) =>
      (await UI.A.save(page, title).getAttribute('aria-pressed')) === 'true',
    cartCount: async page => Number((await page.locator('#cart-badge').innerText()).trim()),
    cartPath: '/api/cart',
    wishPath: '/api/wishlist',
    okText: 'Added to your cart',
    errText: 'We could not add that item to your cart',
    okSave: 'Saved to your wishlist',
    errSave: 'We could not update your wishlist',
    nlInput: page => page.getByLabel('Email address'),
    nlButton: page => page.getByRole('button', { name: 'Subscribe', exact: true }),
    nlOk: 'Thanks for subscribing.',
    nlErr: 'Subscription failed',
    nlInvalid: 'Enter a valid email address.',
  },
  B: {
    listing: app => `${app.url}search?q=earbuds`,
    ready: page => waitCount(page, 'B', 1),
    add: (page, title) => page.getByRole('button', { name: `Add ${title} to basket` }),
    save: (page, title) =>
      page.getByRole('button', {
        name: new RegExp(`^(Save ${title} for later|Remove ${title} from saved items)$`),
      }),
    isSaved: async (page, title) =>
      (await page.getByRole('button', { name: `Remove ${title} from saved items` }).count()) > 0,
    cartCount: async page => {
      const text = await page.getByRole('link', { name: /^Basket \(\d+\)$/ }).innerText();
      return Number(/\((\d+)\)/.exec(text)[1]);
    },
    cartPath: '/basket/add',
    wishPath: '/wishlist/toggle',
    okText: 'Item added to your basket.',
    errText: 'Sorry, your basket could not be updated',
    okSave: 'Your saved items were updated.',
    errSave: 'Sorry, your saved items could not be updated.',
    nlInput: page => page.getByLabel('Join our mailing list'),
    nlButton: page => page.getByRole('button', { name: 'Join', exact: true }),
    nlOk: 'Thanks, you are on the mailing list.',
    nlErr: 'Sorry, we could not sign you up right now.',
    nlInvalid: 'Please enter a valid email address.',
  },
  C: {
    listing: app => `${app.url}?q=earbuds`,
    ready: page => waitCount(page, 'C', 1),
    add: (page, title) => page.getByRole('button', { name: `Add ${title} to bag` }),
    save: (page, title) => page.getByRole('button', { name: `Keep ${title} for later` }),
    isSaved: async (page, title) =>
      (await UI.C.save(page, title).getAttribute('aria-pressed')) === 'true',
    cartCount: async page => Number((await page.locator('#bag-count').innerText()).trim()),
    cartPath: '/api/cart',
    wishPath: '/api/wishlist',
    okText: 'Added to your bag.',
    errText: 'That did not go through. Your bag is unchanged.',
    okSave: 'Kept for later.',
    errSave: 'That did not go through. Your keep list is unchanged.',
    nlInput: page => page.getByLabel('Where should we send it?'),
    nlButton: page => page.getByRole('button', { name: 'Sign me up', exact: true }),
    nlOk: 'You are on the list.',
    nlErr: 'Sign-up failed',
    nlInvalid: 'That email address does not look right.',
  },
};

const clickAndStatus = async (page, locator, pathPart) => {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(pathPart)),
    locator.click(),
  ]);
  return response.status();
};

const statusText = (page, text) => page.getByRole('status').filter({ hasText: text }).first();
const alertText = (page, text) => page.getByRole('alert').filter({ hasText: text }).first();

const FRESH_STATE = {
  searches: [],
  lastResultIds: [],
  cart: [],
  wishlist: [],
  newsletterSignups: 0,
  productViews: [],
};

/* ------------------------------------------------------------------ */
/* Contract checks                                                     */
/* ------------------------------------------------------------------ */

const contractChecks = async titleOf => {
  await check('contract: exports family and variants', () => {
    eq(catalog.family, 'catalog');
    eq(catalog.variants, ['A', 'B', 'C']);
    assert.equal(typeof catalog.startApp, 'function');
    assert.equal(typeof catalog.describe, 'function');
  });

  await check('contract: describe() has variants, the four faults and initial options', () => {
    const d = catalog.describe();
    eq(d.family, 'catalog');
    eq(
      d.variants.map(v => v.id),
      ['A', 'B', 'C']
    );
    d.variants.forEach(v => assert.ok(typeof v.summary === 'string' && v.summary.length > 20));
    eq(d.faults.map(f => f.name).sort(), [
      'failWrites',
      'misleadingSuccess',
      'rerenderEveryMs',
      'slowResponseMs',
    ]);
    d.faults.forEach(f => assert.ok(typeof f.summary === 'string' && f.summary.length > 10));
    assert.ok(Array.isArray(d.initialOptions) && d.initialOptions.length >= 1);
    d.initialOptions.forEach(o =>
      assert.ok(typeof o.name === 'string' && typeof o.summary === 'string')
    );
    JSON.stringify(d);
  });

  await check(
    'contract: startApp() defaults to variant A on 127.0.0.1 port 0 with the full handle',
    async () => {
      const app = await catalog.startApp();
      try {
        assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        assert.equal(app.origin, app.url.slice(0, -1));
        assert.notEqual(new URL(app.url).port, '0');
        eq([app.family, app.variant], ['catalog', 'A']);
        for (const key of ['state', 'requests', 'reset', 'close'])
          assert.equal(typeof app[key], 'function', key);
        eq(app.state(), FRESH_STATE);
        eq(app.requests(), []);
      } finally {
        await app.close();
      }
    }
  );

  await check(
    'contract: unknown variant, fault, initial option or product id is rejected',
    async () => {
      await assert.rejects(() => catalog.startApp({ variant: 'Z' }), /Unknown variant/);
      await assert.rejects(() => catalog.startApp({ faults: { explode: true } }), /Unknown fault/);
      await assert.rejects(
        () => catalog.startApp({ initial: { colour: 'red' } }),
        /Unknown initial/
      );
      await assert.rejects(
        () => catalog.startApp({ initial: { cart: ['p99'] } }),
        /unknown product id/
      );
      await assert.rejects(
        () => catalog.startApp({ faults: { slowResponseMs: -5 } }),
        /non-negative/
      );
    }
  );

  for (const variant of VARIANTS) {
    await check(
      `contract ${variant}: /__test/state mirrors state(), /__test/reset works, neither is linked or logged`,
      async () => {
        const app = await catalog.startApp({ variant, initial: { cart: ['p03'] } });
        try {
          const html = await (await fetch(app.url)).text();
          assert.ok(!html.includes('__test'), 'page mentions /__test');
          const live = await (await fetch(`${app.origin}/__test/state`)).json();
          eq(live, app.state());
          eq(live.cart, [{ productId: 'p03', qty: 1 }]);
          const reply = await fetch(`${app.origin}/__test/reset`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initial: { wishlist: ['p04'] } }),
          });
          eq(await reply.json(), { ok: true });
          eq(app.state().cart, []);
          eq(app.state().wishlist, ['p04']);
          assert.ok(
            app.requests().every(r => !r.path.startsWith('/__test')),
            '/__test must not be logged'
          );
          eq(app.requests(), []);
        } finally {
          await app.close();
        }
      }
    );

    await check(
      `contract ${variant}: served HTML is deterministic and free of automation hooks`,
      async () => {
        const first = await catalog.startApp({ variant });
        const second = await catalog.startApp({ variant });
        try {
          const [a, b] = await Promise.all([fetch(first.url), fetch(second.url)]).then(rs =>
            Promise.all(rs.map(r => r.text()))
          );
          assert.equal(a, b);
          assert.ok(!/data-(testid|agent|kriya|test|qa)/i.test(a));
          const [p, q] = await Promise.all([
            fetch(`${first.origin}/api/products?q=wireless&sort=price_asc`),
            fetch(`${second.origin}/api/products?q=wireless&sort=price_asc`),
          ]).then(rs => Promise.all(rs.map(r => r.json())));
          eq(p, q);
        } finally {
          await first.close();
          await second.close();
        }
      }
    );

    await check(
      `contract ${variant}: /api/products implements q, category, brand, maxPrice and sort`,
      async () => {
        const app = await catalog.startApp({ variant });
        try {
          const ids = async qs =>
            (await (await fetch(`${app.origin}/api/products?${qs}`)).json()).products.map(
              p => p.id
            );
          eq((await ids('')).length, 30);
          sameSet(await ids('q=wireless'), WIRELESS);
          sameSet(await ids('q=wireless&category=audio'), ['p01', 'p02', 'p04']);
          eq(await ids('q=wireless&category=audio&brand=northwave&maxPrice=100'), ['p02']);
          eq(await ids('q=headphones&sort=price_asc'), ['p03', 'p01']);
          eq(await ids('category=audio&category=kitchen&maxPrice=30&sort=price_desc'), [
            'p11',
            'p12',
          ]);
          eq(await ids('q=wireless&sort=price_asc'), WIRELESS_PRICE_ASC);
          eq(await ids('q=wireless&sort=rating'), WIRELESS_BY_RATING);
          eq(await ids('q=steel'), STEEL_RELEVANCE);
          eq(await ids('q=zzzz'), []);
          eq(await ids('brand=northwave&brand=lumio&category=office&sort=price_asc'), [
            'p24',
            'p21',
            'p22',
          ]);
          const shape = lastSearch(app);
          eq(Object.keys(shape).sort(), ['count', 'filters', 'q', 'sort']);
          eq(Object.keys(shape.filters).sort(), ['brand', 'category', 'maxPrice']);
          const first = (await (await fetch(`${app.origin}/api/products`)).json()).products[0];
          eq(Object.keys(first).sort(), [
            'blurb',
            'brand',
            'category',
            'featured',
            'id',
            'price',
            'rating',
            'reviews',
            'title',
          ]);
          assert.equal(titleOf[first.id], first.title);
        } finally {
          await app.close();
        }
      }
    );

    await check(
      `contract ${variant}: initial cart/wishlist options seed backend state and reset() honours them`,
      async () => {
        const app = await catalog.startApp({
          variant,
          initial: { cart: ['p01', 'p02'], wishlist: ['p03'] },
        });
        try {
          eq(app.state().cart, [
            { productId: 'p01', qty: 1 },
            { productId: 'p02', qty: 1 },
          ]);
          eq(app.state().wishlist, ['p03']);
          await fetch(`${app.origin}/api/cart`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ productId: 'p05' }),
          });
          eq(app.state().cart.length, 3);
          app.reset();
          eq(app.state().cart.length, 2);
          eq(app.requests(), []);
          app.reset({});
          eq(app.state(), FRESH_STATE);
          app.reset({ cart: ['p05'] });
          eq(app.state().cart, [{ productId: 'p05', qty: 1 }]);
          app.reset();
          eq(app.state().cart.length, 2);
          assert.throws(() => app.reset({ cart: ['nope'] }), /unknown product id/);
        } finally {
          await app.close();
        }
      }
    );
  }
};

/* ------------------------------------------------------------------ */
/* Variant A                                                           */
/* ------------------------------------------------------------------ */

const flowA = async titleOf => {
  await suite('A main flow', { variant: 'A' }, async ({ app, page, pageErrors }) => {
    const ids = () => app.state().lastResultIds;
    const titlesMatchBackend = async () =>
      eq(
        await renderedTitles(page, 'A'),
        ids().map(id => titleOf[id])
      );

    await check(
      'A main: first load lists all 30 products and the backend logs the browse query',
      async () => {
        await page.goto(app.url);
        await waitCount(page, 'A', 30);
        eq(await page.locator('.card').count(), 30);
        eq(app.state().searches, [{ q: '', filters: EMPTY_FILTERS, sort: 'relevance', count: 30 }]);
        eq(ids().length, 30);
        eq(new URL(page.url()).search, '');
        await page.evaluate(() => {
          window.__spaMarker = 'alive';
        });
      }
    );

    await check(
      'A main: header search (type + Enter) filters live, updates URL and backend',
      async () => {
        const box = page.getByLabel('Search products');
        await box.fill('wireless');
        await box.press('Enter');
        await waitCount(page, 'A', 9);
        eq(params(page).get('q'), 'wireless');
        assert.ok(await page.getByText(/Showing 9 results for/).isVisible());
        eq(lastSearch(app), { q: 'wireless', filters: EMPTY_FILTERS, sort: 'relevance', count: 9 });
        sameSet(ids(), WIRELESS);
        await titlesMatchBackend();
      }
    );

    await check(
      'A main: ticking the Audio category narrows to 3 and shows the active-filter pill',
      async () => {
        await page.getByRole('checkbox', { name: /^Audio/ }).check();
        await waitCount(page, 'A', 3);
        eq(params(page).getAll('category'), ['audio']);
        assert.ok(await page.getByRole('button', { name: 'Remove filter: Audio' }).isVisible());
        eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: null });
        sameSet(ids(), ['p01', 'p02', 'p04']);
        await titlesMatchBackend();
      }
    );

    await check('A main: ticking the Northwave brand narrows to 2', async () => {
      await page.getByRole('checkbox', { name: /^Northwave/ }).check();
      await waitCount(page, 'A', 2);
      eq(params(page).getAll('brand'), ['northwave']);
      eq(lastSearch(app).filters, { category: ['audio'], brand: ['northwave'], maxPrice: null });
      sameSet(ids(), ['p01', 'p02']);
    });

    await check('A main: price select "Up to $100" leaves only the earbuds', async () => {
      await page.getByLabel('Price', { exact: true }).selectOption('100');
      await waitCount(page, 'A', 1);
      eq(params(page).get('maxPrice'), '100');
      eq(ids(), ['p02']);
      eq(await renderedTitles(page, 'A'), [EARBUDS]);
      assert.ok(await page.getByRole('button', { name: 'Remove filter: Up to $100' }).isVisible());
    });

    await check(
      'A main: sort select updates the URL; final backend search is exactly the composed query',
      async () => {
        await page.getByLabel('Sort by').selectOption('price_asc');
        await page.waitForFunction(
          () => new URLSearchParams(location.search).get('sort') === 'price_asc'
        );
        await waitCount(page, 'A', 1);
        eq(lastSearch(app), {
          q: 'wireless',
          filters: { category: ['audio'], brand: ['northwave'], maxPrice: 100 },
          sort: 'price_asc',
          count: 1,
        });
        const lastReq = app.requests().at(-1);
        eq([lastReq.method, lastReq.path], ['GET', '/api/products']);
        eq(lastReq.query, {
          q: 'wireless',
          category: 'audio',
          brand: 'northwave',
          maxPrice: '100',
          sort: 'price_asc',
        });
        eq(await page.evaluate(() => window.__spaMarker), 'alive', 'page must not have navigated');
      }
    );

    await check('A main: removing the Northwave pill widens to 2 and unticks the box', async () => {
      await page.getByRole('button', { name: 'Remove filter: Northwave' }).click();
      await waitCount(page, 'A', 2);
      eq(ids(), ['p04', 'p02']);
      eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: 100 });
      assert.equal(await page.getByRole('checkbox', { name: /^Northwave/ }).isChecked(), false);
    });

    await check(
      'A main: Clear all drops every filter but keeps the search term and sort',
      async () => {
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        await waitCount(page, 'A', 9);
        eq(ids(), WIRELESS_PRICE_ASC);
        eq(lastSearch(app), { q: 'wireless', filters: EMPTY_FILTERS, sort: 'price_asc', count: 9 });
        eq(await page.getByLabel('Price', { exact: true }).inputValue(), '');
        eq(await page.getByRole('button', { name: /^Remove filter/ }).count(), 0);
        assert.equal(await page.getByRole('checkbox', { name: /^Audio/ }).isChecked(), false);
      }
    );

    await check(
      'A main: browser Back restores the earlier filters through the URL, Forward returns',
      async () => {
        await page.goBack();
        await waitCount(page, 'A', 2);
        assert.equal(await page.getByRole('checkbox', { name: /^Audio/ }).isChecked(), true);
        eq(await page.getByLabel('Price', { exact: true }).inputValue(), '100');
        eq(ids(), ['p04', 'p02']);
        eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: 100 });
        await page.goForward();
        await waitCount(page, 'A', 9);
        eq(lastSearch(app).filters, EMPTY_FILTERS);
      }
    );

    await check(
      'A main: typing without Enter updates results after the debounce (live search)',
      async () => {
        await page.getByLabel('Search products').fill('steel');
        await waitCount(page, 'A', 4);
        eq(lastSearch(app), { q: 'steel', filters: EMPTY_FILTERS, sort: 'price_asc', count: 4 });
        eq(ids(), STEEL_PRICE_ASC);
      }
    );

    await check(
      'A main: a search with no matches shows the empty state; Reset search restores the catalog',
      async () => {
        const box = page.getByLabel('Search products');
        await box.fill('zzzz');
        await box.press('Enter');
        await page.getByText('No results match your filters').waitFor();
        eq(lastSearch(app).count, 0);
        eq(ids(), []);
        await page.getByRole('button', { name: 'Reset search' }).click();
        await waitCount(page, 'A', 30);
        eq(lastSearch(app), { q: '', filters: EMPTY_FILTERS, sort: 'relevance', count: 30 });
        eq(await box.inputValue(), '');
      }
    );

    await check(
      'A main: "Avg. customer review" sort orders by rating then review count',
      async () => {
        const box = page.getByLabel('Search products');
        await box.fill('wireless');
        await box.press('Enter');
        await waitCount(page, 'A', 9);
        await page.getByLabel('Sort by').selectOption({ label: 'Avg. customer review' });
        await page.waitForFunction(
          () => new URLSearchParams(location.search).get('sort') === 'rating'
        );
        await waitCount(page, 'A', 9);
        eq(ids(), WIRELESS_BY_RATING);
        await titlesMatchBackend();
      }
    );

    await check(
      'A main: loading a URL with a query reflects it in controls, results and backend',
      async () => {
        await page.goto(`${app.url}?category=kitchen&category=outdoor&sort=price_desc&maxPrice=50`);
        await waitCount(page, 'A', 6);
        assert.equal(await page.getByRole('checkbox', { name: /^Kitchen/ }).isChecked(), true);
        assert.equal(await page.getByRole('checkbox', { name: /^Outdoor/ }).isChecked(), true);
        assert.equal(await page.getByRole('checkbox', { name: /^Audio/ }).isChecked(), false);
        eq(await page.getByLabel('Price', { exact: true }).inputValue(), '50');
        eq(await page.getByLabel('Sort by').inputValue(), 'price_desc');
        eq(lastSearch(app), {
          q: '',
          filters: { category: ['kitchen', 'outdoor'], brand: [], maxPrice: 50 },
          sort: 'price_desc',
          count: 6,
        });
        eq(ids(), KITCHEN_OUTDOOR_50_DESC);
        await titlesMatchBackend();
      }
    );

    await check(
      'A main: wrong-choice controls (Clear filters with none active) send nothing and show no banner',
      async () => {
        await page.goto(`${app.url}?q=earbuds`);
        await waitCount(page, 'A', 1);
        const before = app.requests().length;
        await page.getByRole('button', { name: 'Clear filters' }).click();
        await sleep(500);
        eq(app.requests().length, before);
        eq(await page.getByRole('status').filter({ hasText: 'Filters applied' }).count(), 0);
      }
    );

    await check(
      'A writes: add to cart increments the backend cart and the visible badge',
      async () => {
        await UI.A.add(page, EARBUDS).click();
        await statusText(page, 'Added to your cart').waitFor();
        eq(app.state().cart, [{ productId: 'p02', qty: 1 }]);
        eq(await UI.A.cartCount(page), 1);
        await UI.A.add(page, EARBUDS).click();
        await page.waitForFunction(
          () => document.querySelector('#cart-badge')?.textContent === '2'
        );
        eq(app.state().cart, [{ productId: 'p02', qty: 2 }]);
      }
    );

    await check(
      'A writes: wishlist heart toggles aria-pressed and the backend wishlist',
      async () => {
        await UI.A.save(page, EARBUDS).click();
        await page.waitForFunction(
          t =>
            document
              .querySelector(`button[aria-label="Save ${t} to wishlist"]`)
              ?.getAttribute('aria-pressed') === 'true',
          EARBUDS
        );
        eq(app.state().wishlist, ['p02']);
        await UI.A.save(page, EARBUDS).click();
        await page.waitForFunction(
          t =>
            document
              .querySelector(`button[aria-label="Save ${t} to wishlist"]`)
              ?.getAttribute('aria-pressed') === 'false',
          EARBUDS
        );
        eq(app.state().wishlist, []);
      }
    );

    await check(
      'A writes: newsletter rejects a bad address, accepts a good one, backend never keeps the raw email',
      async () => {
        await UI.A.nlInput(page).fill('shopper@localhost');
        await UI.A.nlButton(page).click();
        await alertText(page, UI.A.nlInvalid).waitFor();
        eq(app.state().newsletterSignups, 0);
        await UI.A.nlInput(page).fill('shopper@example.com');
        await UI.A.nlButton(page).click();
        await statusText(page, UI.A.nlOk).waitFor();
        eq(app.state().newsletterSignups, 1);
        const posts = app.requests().filter(r => r.path === '/api/newsletter');
        eq(posts.at(-1).bodySummary, 'email=s***@example.com');
        assert.ok(!JSON.stringify(app.requests()).includes('shopper@example.com'));
        assert.ok(!JSON.stringify(app.state()).includes('shopper@example.com'));
      }
    );

    await check(
      'A main: a product title link is a real navigation that the backend records as a view',
      async () => {
        await page.goto(`${app.url}?q=earbuds`);
        await waitCount(page, 'A', 1);
        await page.getByRole('link', { name: EARBUDS }).click();
        await page.waitForURL(/\/product\/p02$/);
        assert.ok(await page.getByRole('heading', { name: EARBUDS }).isVisible());
        eq(app.state().productViews, ['p02']);
      }
    );

    await check('A contract: request log is ordered, masked and omits /__test', async () => {
      const log = app.requests();
      assert.ok(log.length > 10);
      log.forEach((entry, i) => {
        eq(Object.keys(entry).sort(), ['bodySummary', 'method', 'path', 'query', 'seq']);
        eq(entry.seq, i + 1);
        assert.ok(!entry.path.startsWith('/__test'));
      });
      const cartPost = log.find(r => r.method === 'POST' && r.path === '/api/cart');
      eq(cartPost.bodySummary, 'productId=p02 qty=1');
    });

    await check(
      'A reset(): backend state and request log return to the start and the page works again',
      async () => {
        app.reset();
        eq(app.state(), FRESH_STATE);
        eq(app.requests(), []);
        await page.goto(app.url);
        await waitCount(page, 'A', 30);
        eq(app.state().searches.length, 1);
        eq(app.state().cart, []);
        eq(await UI.A.cartCount(page), 0);
        app.reset({ cart: ['p01', 'p02'], wishlist: ['p03'] });
        await page.goto(app.url);
        await waitCount(page, 'A', 30);
        eq(await UI.A.cartCount(page), 2);
        assert.equal(
          await UI.A.save(page, 'Sonique Studio Monitor Headphones').getAttribute('aria-pressed'),
          'true'
        );
      }
    );

    await check('A: no uncaught page errors and no automation hooks in the live DOM', async () => {
      eq(pageErrors, []);
      assert.ok(!/data-(testid|agent|kriya|test|qa)/i.test(await page.content()));
    });
  });
};

/* ------------------------------------------------------------------ */
/* Variant B                                                           */
/* ------------------------------------------------------------------ */

const flowB = async titleOf => {
  await suite('B main flow', { variant: 'B' }, async ({ app, page, pageErrors }) => {
    const ids = () => app.state().lastResultIds;
    const submit = () => page.getByRole('button', { name: 'Search', exact: true });
    const titlesMatchBackend = async () =>
      eq(
        await renderedTitles(page, 'B'),
        ids().map(id => titleOf[id])
      );

    await check(
      'B main: home page shows the search form and featured items without logging a search',
      async () => {
        await page.goto(app.url);
        await page.getByLabel('What are you looking for?').waitFor();
        eq(await page.locator('.row').count(), 6);
        eq(app.state().searches, []);
        eq(
          app.requests().map(r => `${r.method} ${r.path}`),
          ['GET /']
        );
      }
    );

    await check('B main: editing the form without pressing Search records nothing', async () => {
      await page.getByLabel('What are you looking for?').fill('wireless');
      await page.getByLabel('Department').selectOption({ label: 'Headphones & Audio' });
      await page.getByLabel('Manufacturer').selectOption({ label: 'Northwave' });
      await page.getByLabel('Highest price you will pay (USD)').fill('100');
      await page.getByLabel('Lowest price first').check();
      await sleep(600);
      eq(app.state().searches, []);
      assert.ok(!app.requests().some(r => r.path === '/search'));
    });

    await check(
      'B main: Search button performs a full navigation with every control in the query',
      async () => {
        await page.evaluate(() => {
          window.__navMarker = 'old-document';
        });
        await Promise.all([page.waitForURL(/\/search\?/), submit().click()]);
        eq(await page.evaluate(() => window.__navMarker), undefined, 'must be a new document');
        const p = params(page);
        eq(
          [p.get('q'), p.get('category'), p.get('brand'), p.get('maxPrice'), p.get('sort')],
          ['wireless', 'audio', 'northwave', '100', 'price_asc']
        );
        await waitCount(page, 'B', 1);
        eq(lastSearch(app), {
          q: 'wireless',
          filters: { category: ['audio'], brand: ['northwave'], maxPrice: 100 },
          sort: 'price_asc',
          count: 1,
        });
        eq(ids(), ['p02']);
        eq(await renderedTitles(page, 'B'), [EARBUDS]);
        eq(app.state().searches.length, 1);
      }
    );

    await check(
      'B main: the results page keeps the chosen values and describes the active filters',
      async () => {
        eq(await page.getByLabel('What are you looking for?').inputValue(), 'wireless');
        eq(await page.getByLabel('Department').inputValue(), 'audio');
        eq(await page.getByLabel('Manufacturer').inputValue(), 'northwave');
        eq(await page.getByLabel('Highest price you will pay (USD)').inputValue(), '100');
        assert.equal(await page.getByLabel('Lowest price first').isChecked(), true);
        const summary = await page.locator('p.applied').innerText();
        assert.match(summary, /Department: Headphones & Audio/);
        assert.match(summary, /Manufacturer: Northwave/);
        assert.match(summary, /Up to \$100/);
      }
    );

    await check(
      'B main: request log records the GET /search with the submitted query object',
      async () => {
        const req = app.requests().find(r => r.path === '/search');
        eq(req.method, 'GET');
        eq(req.query, {
          q: 'wireless',
          category: 'audio',
          brand: 'northwave',
          maxPrice: '100',
          sort: 'price_asc',
        });
      }
    );

    await check(
      'B main: Enter in the text box submits; clearing the selects widens the search',
      async () => {
        await page.getByLabel('Department').selectOption({ label: 'All departments' });
        await page.getByLabel('Manufacturer').selectOption({ label: 'Any manufacturer' });
        await page.getByLabel('Highest price you will pay (USD)').fill('');
        await page.getByLabel('Most relevant').check();
        const box = page.getByLabel('What are you looking for?');
        await box.fill('steel');
        await Promise.all([page.waitForURL(/q=steel/), box.press('Enter')]);
        await waitCount(page, 'B', 4);
        eq(lastSearch(app), { q: 'steel', filters: EMPTY_FILTERS, sort: 'relevance', count: 4 });
        eq(ids(), STEEL_RELEVANCE);
        await titlesMatchBackend();
      }
    );

    await check('B main: a department select alone narrows the steel search to 2', async () => {
      await page.getByLabel('Department').selectOption({ label: 'Fitness & Training' });
      await Promise.all([page.waitForURL(/category=fitness/), submit().click()]);
      await waitCount(page, 'B', 2);
      sameSet(ids(), ['p16', 'p18']);
      eq(lastSearch(app).filters, { category: ['fitness'], brand: [], maxPrice: null });
    });

    await check('B main: "Best rated" radio orders by rating then review count', async () => {
      await page.getByLabel('Department').selectOption({ label: 'All departments' });
      await page.getByLabel('What are you looking for?').fill('wireless');
      await page.getByLabel('Best rated').check();
      await Promise.all([page.waitForURL(/sort=rating/), submit().click()]);
      await waitCount(page, 'B', 9);
      eq(ids(), WIRELESS_BY_RATING);
      await titlesMatchBackend();
      eq(lastSearch(app).sort, 'rating');
    });

    await check(
      'B main: a search with no matches shows the empty message and logs count 0',
      async () => {
        await page.getByLabel('What are you looking for?').fill('zzzz');
        await Promise.all([page.waitForURL(/q=zzzz/), submit().click()]);
        await page.getByText('We could not find anything matching that search.').waitFor();
        eq(lastSearch(app).count, 0);
        eq(ids(), []);
      }
    );

    await check(
      'B main: browser Back returns to the previous server-rendered results',
      async () => {
        await page.goBack();
        await waitCount(page, 'B', 9);
        assert.ok(params(page).get('q') === 'wireless');
      }
    );

    await check(
      'B main: loading /search with a hand-written query is honoured by the form and backend',
      async () => {
        await page.goto(`${app.url}search?q=desk&category=office&maxPrice=50&sort=price_desc`);
        await waitCount(page, 'B', 3);
        eq(await page.getByLabel('Department').inputValue(), 'office');
        eq(lastSearch(app).filters, { category: ['office'], brand: [], maxPrice: 50 });
        eq(ids(), ['p23', 'p24', 'p20']);
      }
    );

    await check(
      'B writes: Add to basket posts a form, shows a flash, keeps the results and updates the backend',
      async () => {
        await page.goto(UI.B.listing(app));
        await UI.B.ready(page);
        const searchesBefore = app.state().searches.length;
        await UI.B.add(page, EARBUDS).click();
        await statusText(page, UI.B.okText).waitFor();
        eq(app.state().cart, [{ productId: 'p02', qty: 1 }]);
        eq(await UI.B.cartCount(page), 1);
        eq(new URL(page.url()).pathname + new URL(page.url()).search, '/search?q=earbuds');
        eq(await renderedTitles(page, 'B'), [EARBUDS]);
        eq(app.state().searches.length, searchesBefore, 'a write must not count as a search');
      }
    );

    await check(
      'B writes: Save for later toggles the backend wishlist and the button wording',
      async () => {
        await UI.B.save(page, EARBUDS).click();
        await statusText(page, UI.B.okSave).waitFor();
        eq(app.state().wishlist, ['p02']);
        assert.equal(await UI.B.isSaved(page, EARBUDS), true);
        await UI.B.save(page, EARBUDS).click();
        await statusText(page, UI.B.okSave).waitFor();
        eq(app.state().wishlist, []);
        assert.equal(await UI.B.isSaved(page, EARBUDS), false);
      }
    );

    await check('B writes: mailing list rejects a bad address and masks the good one', async () => {
      await UI.B.nlInput(page).fill('shopper@localhost');
      await UI.B.nlButton(page).click();
      await alertText(page, UI.B.nlInvalid).waitFor();
      eq(app.state().newsletterSignups, 0);
      await UI.B.nlInput(page).fill('shopper@example.com');
      await UI.B.nlButton(page).click();
      await statusText(page, UI.B.nlOk).waitFor();
      eq(app.state().newsletterSignups, 1);
      eq(
        app
          .requests()
          .filter(r => r.path === '/newsletter/join')
          .at(-1).bodySummary,
        'email=s***@example.com'
      );
      assert.ok(!JSON.stringify(app.requests()).includes('shopper@example.com'));
    });

    await check(
      'B main: a product title link opens the detail page and the backend records the view',
      async () => {
        await page.goto(UI.B.listing(app));
        await UI.B.ready(page);
        await page.getByRole('link', { name: EARBUDS }).click();
        await page.waitForURL(/\/product\/p02$/);
        assert.ok(await page.getByRole('heading', { name: EARBUDS }).isVisible());
        eq(app.state().productViews, ['p02']);
      }
    );

    await check(
      'B contract: request log is ordered and masked, POST bodies are summarised',
      async () => {
        const log = app.requests();
        log.forEach((entry, i) => {
          eq(Object.keys(entry).sort(), ['bodySummary', 'method', 'path', 'query', 'seq']);
          eq(entry.seq, i + 1);
        });
        eq(log.find(r => r.path === '/basket/add').bodySummary, 'productId=p02');
      }
    );

    await check(
      'B reset(): state and log return to the start and the seeded cart shows in the header',
      async () => {
        app.reset();
        eq(app.state(), FRESH_STATE);
        eq(app.requests(), []);
        app.reset({ cart: ['p01', 'p02'] });
        await page.goto(app.url);
        eq(await UI.B.cartCount(page), 2);
        eq(app.state().searches, []);
      }
    );

    await check('B: no uncaught page errors and no automation hooks in the live DOM', async () => {
      eq(pageErrors, []);
      assert.ok(!/data-(testid|agent|kriya|test|qa)/i.test(await page.content()));
    });
  });
};

/* ------------------------------------------------------------------ */
/* Variant C                                                           */
/* ------------------------------------------------------------------ */

const flowC = async titleOf => {
  await suite('C main flow', { variant: 'C' }, async ({ app, page, pageErrors }) => {
    const ids = () => app.state().lastResultIds;
    const chip = name => page.getByRole('button', { name, exact: true });
    const pressed = async name => (await chip(name).getAttribute('aria-pressed')) === 'true';
    const searchIcon = () => page.getByRole('button', { name: 'Search', exact: true });
    const titlesMatchBackend = async () =>
      eq(
        await renderedTitles(page, 'C'),
        ids().map(id => titleOf[id])
      );

    await check(
      'C main: first load has no dialog, logs the browse query, and the chips sit below the fold',
      async () => {
        await page.goto(app.url);
        await waitCount(page, 'C', 30);
        eq(await page.getByRole('dialog').count(), 0);
        eq(app.state().searches, [{ q: '', filters: EMPTY_FILTERS, sort: 'relevance', count: 30 }]);
        const top = await chip('Sound').evaluate(el => el.getBoundingClientRect().top);
        assert.ok(
          top > VIEWPORT.height,
          `chip top ${top} should be below the ${VIEWPORT.height}px fold`
        );
        eq(await page.evaluate(() => window.scrollY), 0);
        await page.evaluate(() => {
          window.__spaMarker = 'alive';
        });
      }
    );

    await check('C main: the search icon opens an overlay dialog that takes focus', async () => {
      await searchIcon().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      assert.ok(
        await dialog.getByLabel('Search catalog').evaluate(el => el === document.activeElement)
      );
    });

    await check('C main: Escape closes the dialog without searching', async () => {
      const before = app.requests().length;
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      eq(app.requests().length, before);
    });

    await check(
      'C main: typing in the dialog and pressing Show results closes it and runs the search',
      async () => {
        await searchIcon().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Search catalog').fill('wireless');
        await dialog.getByRole('button', { name: 'Show results' }).click();
        await dialog.waitFor({ state: 'detached' });
        await waitCount(page, 'C', 9);
        eq(params(page).get('q'), 'wireless');
        eq(lastSearch(app), { q: 'wireless', filters: EMPTY_FILTERS, sort: 'relevance', count: 9 });
        sameSet(ids(), WIRELESS);
        assert.ok(
          await page.getByRole('button', { name: 'Clear search term wireless' }).isVisible()
        );
        await titlesMatchBackend();
      }
    );

    await check(
      'C main: reaching a chip needs scrolling; pressing Sound sets aria-pressed and the backend filter',
      async () => {
        const top = await chip('Sound').evaluate(el => el.getBoundingClientRect().top);
        assert.ok(top > VIEWPORT.height);
        await chip('Sound').click();
        await waitCount(page, 'C', 3);
        assert.ok(
          (await page.evaluate(() => window.scrollY)) > 0,
          'the click must have scrolled the page'
        );
        assert.equal(await pressed('Sound'), true);
        eq(params(page).getAll('category'), ['audio']);
        eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: null });
        sameSet(ids(), ['p01', 'p02', 'p04']);
      }
    );

    await check('C main: the Northwave maker chip narrows to 2', async () => {
      await chip('Northwave').click();
      await waitCount(page, 'C', 2);
      assert.equal(await pressed('Northwave'), true);
      eq(params(page).getAll('brand'), ['northwave']);
      sameSet(ids(), ['p01', 'p02']);
    });

    await check(
      'C main: budget chips are exclusive; "$100 or less" leaves one product',
      async () => {
        await chip('$50 or less').click();
        await waitCount(page, 'C', 0);
        eq(lastSearch(app).filters.maxPrice, 50);
        await chip('$100 or less').click();
        await waitCount(page, 'C', 1);
        assert.equal(await pressed('$100 or less'), true);
        assert.equal(await pressed('$50 or less'), false);
        eq(lastSearch(app).filters.maxPrice, 100);
        eq(ids(), ['p02']);
      }
    );

    await check(
      'C main: order chip "Cheapest first" completes the composed backend query',
      async () => {
        await chip('Cheapest first').click();
        await page.waitForFunction(
          () => new URLSearchParams(location.search).get('sort') === 'price_asc'
        );
        await waitCount(page, 'C', 1);
        assert.equal(await pressed('Cheapest first'), true);
        assert.equal(await pressed('Recommended'), false);
        eq(lastSearch(app), {
          q: 'wireless',
          filters: { category: ['audio'], brand: ['northwave'], maxPrice: 100 },
          sort: 'price_asc',
          count: 1,
        });
        eq(await renderedTitles(page, 'C'), [EARBUDS]);
        assert.ok(await page.getByText('3 filters on').isVisible());
        eq(await page.evaluate(() => window.__spaMarker), 'alive', 'page must not have navigated');
      }
    );

    await check('C main: pressing a pressed chip again removes that filter', async () => {
      await chip('Northwave').click();
      await waitCount(page, 'C', 2);
      assert.equal(await pressed('Northwave'), false);
      eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: 100 });
      eq(ids(), ['p04', 'p02']);
    });

    await check('C main: Reset clears the chips but keeps the search term and order', async () => {
      await chip('Reset').click();
      await waitCount(page, 'C', 9);
      eq(lastSearch(app), { q: 'wireless', filters: EMPTY_FILTERS, sort: 'price_asc', count: 9 });
      eq(ids(), WIRELESS_PRICE_ASC);
      assert.equal(await pressed('Sound'), false);
      assert.ok(await page.getByText('0 filters on').isVisible());
    });

    await check('C main: browser Back restores the previous chips from the URL', async () => {
      await page.goBack();
      await waitCount(page, 'C', 2);
      assert.equal(await pressed('Sound'), true);
      assert.equal(await pressed('$100 or less'), true);
      eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: 100 });
    });

    await check(
      'C main: a "Popular right now" suggestion searches within the active chips and closes the dialog',
      async () => {
        await searchIcon().click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'yoga mat', exact: true })
          .click();
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        await waitCount(page, 'C', 0);
        eq(lastSearch(app), {
          q: 'yoga mat',
          filters: { category: ['audio'], brand: [], maxPrice: 100 },
          sort: 'price_asc',
          count: 0,
        });
        await chip('Reset').click();
        await waitCount(page, 'C', 1);
        eq(lastSearch(app).q, 'yoga mat');
        eq(ids(), ['p15']);
      }
    );

    await check(
      'C main: clicking the backdrop closes the dialog; clearing the search chip drops the term',
      async () => {
        await searchIcon().click();
        await page.getByRole('dialog').waitFor();
        await page.mouse.click(10, 400);
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Clear search term yoga mat' }).click();
        await page.waitForFunction(() => !location.search.includes('q='));
        assert.equal(lastSearch(app).q, '');
      }
    );

    await check('C main: a search with no matches shows the empty state', async () => {
      await searchIcon().click();
      await page.getByRole('dialog').getByLabel('Search catalog').fill('zzzz');
      await page.keyboard.press('Enter');
      await page.getByText('Nothing here yet').waitFor();
      eq(lastSearch(app).count, 0);
      eq(ids(), []);
    });

    await check('C main: static pages link to /?search=1, which opens the dialog', async () => {
      await page.goto(`${app.url}info/help`);
      await page.getByRole('link', { name: 'Search', exact: true }).click();
      await page.waitForURL(/\?search=1$/);
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
    });

    await check(
      'C main: loading a URL with a query reflects it in chips, results and backend',
      async () => {
        await page.goto(`${app.url}?category=kitchen&category=outdoor&sort=price_desc&maxPrice=50`);
        await waitCount(page, 'C', 6);
        assert.equal(await pressed('Cooking'), true);
        assert.equal(await pressed('Adventure'), true);
        assert.equal(await pressed('Sound'), false);
        assert.equal(await pressed('$50 or less'), true);
        assert.equal(await pressed('Most expensive first'), true);
        eq(ids(), KITCHEN_OUTDOOR_50_DESC);
        eq(lastSearch(app).filters, { category: ['kitchen', 'outdoor'], brand: [], maxPrice: 50 });
        await titlesMatchBackend();
      }
    );

    await check('C main: "Top reviewed" orders by rating then review count', async () => {
      await page.goto(`${app.url}?q=wireless`);
      await waitCount(page, 'C', 9);
      await chip('Top reviewed').click();
      await page.waitForFunction(
        () => new URLSearchParams(location.search).get('sort') === 'rating'
      );
      await waitCount(page, 'C', 9);
      eq(ids(), WIRELESS_BY_RATING);
    });

    await check(
      'C main: wrong-choice control (Reset with no filters) sends nothing and shows no banner',
      async () => {
        await page.goto(`${app.url}?q=earbuds`);
        await waitCount(page, 'C', 1);
        const before = app.requests().length;
        await chip('Reset').click();
        await sleep(500);
        eq(app.requests().length, before);
        eq(await page.getByRole('status').filter({ hasText: 'Filters updated' }).count(), 0);
      }
    );

    await check('C writes: Add to bag updates the backend and the visible bag count', async () => {
      await UI.C.add(page, EARBUDS).click();
      await statusText(page, UI.C.okText).waitFor();
      eq(app.state().cart, [{ productId: 'p02', qty: 1 }]);
      eq(await UI.C.cartCount(page), 1);
    });

    await check('C writes: Keep toggles aria-pressed and the backend wishlist', async () => {
      await UI.C.save(page, EARBUDS).click();
      await page.waitForFunction(
        t =>
          document
            .querySelector(`button[aria-label="Keep ${t} for later"]`)
            ?.getAttribute('aria-pressed') === 'true',
        EARBUDS
      );
      eq(app.state().wishlist, ['p02']);
      await UI.C.save(page, EARBUDS).click();
      await page.waitForFunction(
        t =>
          document
            .querySelector(`button[aria-label="Keep ${t} for later"]`)
            ?.getAttribute('aria-pressed') === 'false',
        EARBUDS
      );
      eq(app.state().wishlist, []);
    });

    await check('C writes: newsletter rejects a bad address and masks the good one', async () => {
      await UI.C.nlInput(page).fill('shopper@localhost');
      await UI.C.nlButton(page).click();
      await alertText(page, UI.C.nlInvalid).waitFor();
      eq(app.state().newsletterSignups, 0);
      await UI.C.nlInput(page).fill('shopper@example.com');
      await UI.C.nlButton(page).click();
      await statusText(page, UI.C.nlOk).waitFor();
      eq(app.state().newsletterSignups, 1);
      eq(
        app
          .requests()
          .filter(r => r.path === '/api/newsletter')
          .at(-1).bodySummary,
        'email=s***@example.com'
      );
      assert.ok(!JSON.stringify(app.requests()).includes('shopper@example.com'));
    });

    await check(
      'C main: a product title link opens the detail page and the backend records the view',
      async () => {
        await page.goto(`${app.url}?q=earbuds`);
        await waitCount(page, 'C', 1);
        await page.getByRole('link', { name: EARBUDS }).click();
        await page.waitForURL(/\/product\/p02$/);
        assert.ok(await page.getByRole('heading', { name: EARBUDS }).isVisible());
        eq(app.state().productViews, ['p02']);
      }
    );

    await check('C contract: request log is ordered and masked', async () => {
      const log = app.requests();
      log.forEach((entry, i) => {
        eq(Object.keys(entry).sort(), ['bodySummary', 'method', 'path', 'query', 'seq']);
        eq(entry.seq, i + 1);
      });
      eq(log.find(r => r.path === '/api/cart').bodySummary, 'productId=p02 qty=1');
    });

    await check(
      'C reset(): state and log return to the start; seeded cart shows in the bag count',
      async () => {
        app.reset();
        eq(app.state(), FRESH_STATE);
        eq(app.requests(), []);
        app.reset({ cart: ['p01', 'p02'], wishlist: ['p03'] });
        await page.goto(app.url);
        await waitCount(page, 'C', 30);
        eq(await UI.C.cartCount(page), 2);
        assert.equal(
          await UI.C.save(page, 'Sonique Studio Monitor Headphones').getAttribute('aria-pressed'),
          'true'
        );
      }
    );

    await check('C: no uncaught page errors and no automation hooks in the live DOM', async () => {
      eq(pageErrors, []);
      assert.ok(!/data-(testid|agent|kriya|test|qa)/i.test(await page.content()));
    });
  });
};

/* ------------------------------------------------------------------ */
/* Fault checks                                                        */
/* ------------------------------------------------------------------ */

const faultChecks = async () => {
  for (const variant of VARIANTS) {
    const ui = UI[variant];

    await suite(`${variant} rerenderEveryMs control`, { variant }, async ({ app, page }) => {
      await check(
        `${variant} rerender control: without the fault held nodes stay attached`,
        async () => {
          await page.goto(app.url);
          if (variant === 'B') await page.locator('.row').first().waitFor();
          else await waitCount(page, variant, 30);
          const held = await page.locator(TITLE_SELECTOR[variant]).first().elementHandle();
          await sleep(900);
          assert.equal(await held.evaluate(node => node.isConnected), true);
        }
      );
    });

    await suite(
      `${variant} rerenderEveryMs`,
      { variant, faults: { rerenderEveryMs: 300 } },
      async ({ app, page }) => {
        await check(
          `${variant} rerenderEveryMs: held element references go stale but equivalent nodes exist`,
          async () => {
            await page.goto(app.url);
            if (variant === 'B') await page.locator('.row').first().waitFor();
            else await waitCount(page, variant, 30);
            const held = await page.locator(TITLE_SELECTOR[variant]).first().elementHandle();
            const title = await held.evaluate(node => node.textContent);
            await sleep(900);
            assert.equal(await held.evaluate(node => node.isConnected), false);
            eq(await page.locator(TITLE_SELECTOR[variant]).first().textContent(), title);
          }
        );

        if (variant === 'A') {
          await check(
            'A rerenderEveryMs: filtering still works with fresh locators and ticked boxes survive remounts',
            async () => {
              await page.getByRole('checkbox', { name: /^Audio/ }).check();
              await waitCount(page, 'A', 6);
              await sleep(800);
              assert.equal(await page.getByRole('checkbox', { name: /^Audio/ }).isChecked(), true);
              eq(lastSearch(app).filters, { category: ['audio'], brand: [], maxPrice: null });
              const box = page.getByLabel('Search products');
              await box.fill('wireless');
              await page.getByRole('button', { name: 'Search', exact: true }).click();
              await waitCount(page, 'A', 3);
              eq(lastSearch(app).q, 'wireless');
              assert.equal(await page.getByLabel('Search products').inputValue(), 'wireless');
            }
          );
        }

        if (variant === 'B') {
          await check(
            'B rerenderEveryMs: typed but unsubmitted values survive remounts and the search still lands',
            async () => {
              await page.getByLabel('What are you looking for?').fill('wireless');
              await page.getByLabel('Department').selectOption({ label: 'Headphones & Audio' });
              await page.getByLabel('Best rated').check();
              await sleep(800);
              eq(await page.getByLabel('What are you looking for?').inputValue(), 'wireless');
              eq(await page.getByLabel('Department').inputValue(), 'audio');
              assert.equal(await page.getByLabel('Best rated').isChecked(), true);
              eq(app.state().searches, []);
              await Promise.all([
                page.waitForURL(/\/search\?/),
                page.getByRole('button', { name: 'Search', exact: true }).click(),
              ]);
              await waitCount(page, 'B', 3);
              eq(lastSearch(app), {
                q: 'wireless',
                filters: { category: ['audio'], brand: [], maxPrice: null },
                sort: 'rating',
                count: 3,
              });
            }
          );
        }

        if (variant === 'C') {
          await check(
            'C rerenderEveryMs: an open dialog and its typed draft survive remounts, then the search lands',
            async () => {
              await page.getByRole('button', { name: 'Search', exact: true }).click();
              await page.getByRole('dialog').getByLabel('Search catalog').fill('camping');
              await sleep(800);
              eq(
                await page.getByRole('dialog').getByLabel('Search catalog').inputValue(),
                'camping'
              );
              await page.getByRole('dialog').getByRole('button', { name: 'Show results' }).click();
              await waitCount(page, 'C', 1);
              eq(lastSearch(app).q, 'camping');
              eq(app.state().lastResultIds, ['p29']);
              await page.getByRole('button', { name: 'Sound', exact: true }).click();
              await waitCount(page, 'C', 0);
              eq(lastSearch(app).filters.category, ['audio']);
            }
          );
        }
      }
    );

    await suite(
      `${variant} slowResponseMs`,
      { variant, faults: { slowResponseMs: 600 } },
      async ({ app, page }) => {
        if (variant === 'B') {
          await check(
            'B slowResponseMs: the search response (a full page) is delayed by at least the configured time',
            async () => {
              await page.goto(app.url);
              await page.getByLabel('What are you looking for?').fill('wireless');
              const started = Date.now();
              await Promise.all([
                page.waitForResponse(r => r.url().includes('/search?')),
                page.getByRole('button', { name: 'Search', exact: true }).click(),
              ]);
              const took = Date.now() - started;
              assert.ok(took >= 550, `search answered after ${took}ms`);
              await waitCount(page, 'B', 9);
              eq(lastSearch(app).count, 9);
            }
          );
          await check('B slowResponseMs: write responses are delayed too', async () => {
            const started = Date.now();
            await clickAndStatus(page, ui.add(page, 'Northwave Aria Mini Earbuds'), ui.cartPath);
            assert.ok(Date.now() - started >= 550);
            eq(app.state().cart, [{ productId: 'p02', qty: 1 }]);
          });
        } else {
          await check(
            `${variant} slowResponseMs: an interaction waits for the delayed API; the UI shows busy state and keeps stale results`,
            async () => {
              await page.goto(app.url);
              await waitCount(page, variant, 30);
              const started = Date.now();
              const response = page.waitForResponse(
                r => r.url().includes('/api/products') && r.url().includes('category=audio')
              );
              if (variant === 'A') await page.getByRole('checkbox', { name: /^Audio/ }).check();
              else await page.getByRole('button', { name: 'Sound', exact: true }).click();
              await page.locator('[aria-busy="true"]').first().waitFor({ timeout: 400 });
              eq(
                await page.locator(TITLE_SELECTOR[variant]).count(),
                30,
                'stale results stay visible while loading'
              );
              await response;
              const took = Date.now() - started;
              assert.ok(took >= 550, `API answered after ${took}ms`);
              await waitCount(page, variant, 6);
              eq(lastSearch(app).filters.category, ['audio']);
            }
          );
          await check(
            `${variant} slowResponseMs: two quick changes settle on the last one (UI equals backend)`,
            async () => {
              if (variant === 'A') {
                await page.getByRole('checkbox', { name: /^Northwave/ }).check();
                await page.getByLabel('Price', { exact: true }).selectOption('100');
              } else {
                await page.getByRole('button', { name: 'Northwave', exact: true }).click();
                await page.getByRole('button', { name: '$100 or less', exact: true }).click();
              }
              await waitCount(page, variant, 1);
              await sleep(900);
              eq(lastSearch(app).filters, {
                category: ['audio'],
                brand: ['northwave'],
                maxPrice: 100,
              });
              eq(await renderedTitles(page, variant), ['Northwave Aria Mini Earbuds']);
            }
          );
          await check(`${variant} slowResponseMs: write responses are delayed too`, async () => {
            const started = Date.now();
            await clickAndStatus(page, ui.add(page, 'Northwave Aria Mini Earbuds'), ui.cartPath);
            assert.ok(Date.now() - started >= 550);
            await statusText(page, ui.okText).waitFor();
            eq(app.state().cart, [{ productId: 'p02', qty: 1 }]);
          });
        }
      }
    );

    await suite(
      `${variant} failWrites`,
      { variant, faults: { failWrites: true } },
      async ({ app, page }) => {
        await check(
          `${variant} failWrites: add-to-cart answers HTTP 500, shows an error and nothing is saved`,
          async () => {
            await page.goto(ui.listing(app));
            await ui.ready(page);
            const status = await clickAndStatus(page, ui.add(page, EARBUDS), ui.cartPath);
            eq(status, 500);
            await alertText(page, ui.errText).waitFor();
            eq(await ui.cartCount(page), 0);
            eq(await page.getByText(ui.okText).count(), 0, 'no success banner');
            eq(app.state().cart, []);
          }
        );
        await check(
          `${variant} failWrites: wishlist write fails visibly and the item is not shown as saved`,
          async () => {
            const status = await clickAndStatus(page, ui.save(page, EARBUDS), ui.wishPath);
            eq(status, 500);
            await alertText(page, ui.errSave).waitFor();
            assert.equal(await ui.isSaved(page, EARBUDS), false);
            eq(app.state().wishlist, []);
          }
        );
        await check(
          `${variant} failWrites: newsletter write fails visibly and nothing is stored`,
          async () => {
            await ui.nlInput(page).fill('shopper@example.com');
            await ui.nlButton(page).click();
            await alertText(page, ui.nlErr).waitFor();
            eq(app.state().newsletterSignups, 0);
          }
        );
        await check(`${variant} failWrites: reads (search and filter) still work`, async () => {
          await page.goto(
            variant === 'B' ? `${app.url}search?q=wireless` : `${app.url}?q=wireless`
          );
          await waitCount(page, variant, 9);
          eq(lastSearch(app).count, 9);
          sameSet(app.state().lastResultIds, WIRELESS);
        });
      }
    );

    await suite(
      `${variant} misleadingSuccess`,
      { variant, faults: { misleadingSuccess: true } },
      async ({ app, page }) => {
        await check(
          `${variant} misleadingSuccess: add-to-cart shows a success banner but the cart stays empty`,
          async () => {
            await page.goto(ui.listing(app));
            await ui.ready(page);
            const status = await clickAndStatus(page, ui.add(page, EARBUDS), ui.cartPath);
            eq(status, 200);
            await statusText(page, ui.okText).waitFor();
            eq(app.state().cart, []);
            eq(await ui.cartCount(page), 0);
          }
        );
        await check(
          `${variant} misleadingSuccess: wishlist shows success but nothing is persisted`,
          async () => {
            const status = await clickAndStatus(page, ui.save(page, EARBUDS), ui.wishPath);
            eq(status, 200);
            await statusText(page, ui.okSave).waitFor();
            eq(app.state().wishlist, []);
            assert.equal(await ui.isSaved(page, EARBUDS), false);
          }
        );
        await check(
          `${variant} misleadingSuccess: newsletter shows thanks but no signup is stored`,
          async () => {
            await ui.nlInput(page).fill('shopper@example.com');
            await ui.nlButton(page).click();
            await statusText(page, ui.nlOk).waitFor();
            eq(app.state().newsletterSignups, 0);
          }
        );
        if (variant !== 'B') {
          await check(
            `${variant} misleadingSuccess: clearing filters with none active shows a banner but sends no request`,
            async () => {
              const before = app.requests().length;
              if (variant === 'A')
                await page.getByRole('button', { name: 'Clear filters' }).click();
              else await page.getByRole('button', { name: 'Reset', exact: true }).click();
              await statusText(
                page,
                variant === 'A' ? 'Filters applied' : 'Filters updated'
              ).waitFor();
              eq(app.requests().length, before);
            }
          );
        }
        await check(
          `${variant} misleadingSuccess: searches stay truthful (backend equals what is shown)`,
          async () => {
            await page.goto(variant === 'B' ? `${app.url}search?q=steel` : `${app.url}?q=steel`);
            await waitCount(page, variant, 4);
            eq(lastSearch(app).count, 4);
          }
        );
      }
    );
  }
};

/* ------------------------------------------------------------------ */
/* Hardening: determinism, no reader instructions, masking, inputs     */
/* ------------------------------------------------------------------ */

const CLOCK_OR_RANDOM =
  /Math\.random|Date\.now|new Date|performance\.now|randomUUID|getRandomValues|hrtime/;

const INSTRUCTION_PATTERNS = [
  /\b(click|tap|press|hit)\s+(the|on|here|this|a|an|search|apply|show|add|save|submit|filter|reset|clear|to)\b/i,
  /\bplease\s+(click|tap|press|use|select|choose|enter|type)\b/i,
  /\b(first|then|next|finally),?\s+(click|tap|press|select|choose|enter|type|use)\b/i,
  /\bstep\s*\d\b/i,
  /\buse the (search|filter|filters|button|box|menu|form)\b/i,
  /\bto (apply|run|start|begin|continue) (your|the) (search|filters?|choices|selection)\b/i,
];

const readerCopy = page =>
  page.evaluate(() => {
    const attributes = [...document.querySelectorAll('[aria-label],[placeholder],[title],[alt]')]
      .flatMap(el =>
        ['aria-label', 'placeholder', 'title', 'alt'].map(name => el.getAttribute(name))
      )
      .filter(Boolean);
    const dataAttributes = [...document.querySelectorAll('*')].flatMap(el =>
      [...el.attributes].map(a => a.name).filter(name => name.startsWith('data-'))
    );
    return {
      copy: `${document.title}\n${document.body.innerText}\n${attributes.join('\n')}`,
      dataAttributes,
      hasComment: document.documentElement.outerHTML.includes('<!--'),
    };
  });

const CAP_49_99 = [
  'p04',
  'p09',
  'p11',
  'p12',
  'p14',
  'p15',
  'p16',
  'p18',
  'p20',
  'p23',
  'p24',
  'p26',
  'p28',
  'p29',
];

const hardeningChecks = async () => {
  await check(
    'hardening: the instruction scanner flags a real instruction (positive control)',
    () => {
      for (const sample of [
        'Click Search to apply your choices.',
        'Please select a department first.',
        'First, press the Search button.',
        'Use the filters on the left.',
      ])
        assert.ok(
          INSTRUCTION_PATTERNS.some(pattern => pattern.test(sample)),
          sample
        );
      assert.ok(
        !INSTRUCTION_PATTERNS.some(pattern => pattern.test('Vertical mouse with silent clicks'))
      );
    }
  );

  await check(
    'hardening: the source has no clock or random calls that could reach the page',
    () => {
      const source = readFileSync(new URL('./catalog.mjs', import.meta.url), 'utf8');
      assert.equal(CLOCK_OR_RANDOM.test(source), false, String(CLOCK_OR_RANDOM.exec(source)));
    }
  );

  for (const variant of VARIANTS) {
    await check(
      `${variant} hardening: pages are byte-identical across spaced fetches and fresh instances, with no comments`,
      async () => {
        const paths = [
          '/',
          '/search?q=wireless&sort=price_asc',
          '/product/p07',
          '/info/deals',
          '/missing',
        ];
        const first = await catalog.startApp({ variant });
        const second = await catalog.startApp({ variant });
        try {
          const seen = new Map();
          for (let round = 0; round < 4; round += 1) {
            for (const app of [first, second]) {
              for (const path of paths) {
                const response = await fetch(`${app.origin}${path}`);
                const text = await response.text();
                const key = `${response.status} ${path}`;
                if (!seen.has(key)) seen.set(key, text);
                assert.equal(text, seen.get(key), `${key} changed between fetches`);
                assert.ok(!text.includes('<!--'), `${key} contains an HTML comment`);
                await sleep(3 + round);
              }
            }
          }
        } finally {
          await first.close();
          await second.close();
        }
      }
    );

    await check(
      `${variant} hardening: no instruction text, data-* attribute or comment on any page state`,
      async () => {
        await session({ variant }, async ({ app, page }) => {
          const empty = variant === 'B' ? 'search?q=zzzz' : '?q=zzzz';
          const filtered =
            variant === 'B'
              ? 'search?q=steel&category=kitchen&maxPrice=100&sort=rating'
              : '?q=steel&category=kitchen&maxPrice=100&sort=rating';
          const targets = [
            '',
            empty,
            filtered,
            'product/p07',
            'info/deals',
            ...(variant === 'C' ? ['?search=1'] : []),
          ];
          for (const target of targets) {
            await page.goto(`${app.url}${target}`);
            await page.waitForLoadState('load');
            await sleep(450);
            const { copy, dataAttributes, hasComment } = await readerCopy(page);
            for (const pattern of INSTRUCTION_PATTERNS)
              assert.ok(
                !pattern.test(copy),
                `"${target}" matches ${pattern}: ${pattern.exec(copy)}`
              );
            eq(dataAttributes, [], `"${target}" has data-* attributes`);
            assert.equal(hasComment, false, `"${target}" has an HTML comment`);
          }
        });
      }
    );

    await check(
      `${variant} hardening: an email in a GET query string is masked in requests()`,
      async () => {
        const app = await catalog.startApp({ variant });
        try {
          await fetch(`${app.origin}/info/newsletter?email=private.person%40example.com`);
          const dump = JSON.stringify([app.requests(), app.state()]);
          assert.ok(!dump.includes('private.person'), 'raw email leaked');
          eq(app.requests()[0].query, { email: 'p***@example.com' });
        } finally {
          await app.close();
        }
      }
    );
  }

  await check(
    'B hardening: an off-site or protocol-relative back value falls back to the home page',
    async () => {
      const app = await catalog.startApp({ variant: 'B' });
      try {
        for (const back of [
          '//evil.example/search?q=x',
          '/\\evil.example/search?q=x',
          'https://evil.example/search?q=x',
        ]) {
          const response = await fetch(`${app.origin}/basket/add`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ productId: 'p01', back }).toString(),
          });
          const html = await response.text();
          assert.ok(!html.includes('evil.example'), `${back} was echoed`);
          assert.ok(!html.includes('replaceState'), `${back} reached history.replaceState`);
          assert.ok(html.includes('Featured this week'), `${back} did not fall back to home`);
        }
        eq(app.state().cart.length, 1);
      } finally {
        await app.close();
      }
    }
  );

  await suite('B price cap with cents', { variant: 'B' }, async ({ app, page }) => {
    await check(
      'B main: the price cap accepts cents and keeps a product priced exactly at the cap',
      async () => {
        await page.goto(app.url);
        await page.getByLabel('Highest price you will pay (USD)').fill('49.99');
        await Promise.all([
          page.waitForURL(/\/search\?/),
          page.getByRole('button', { name: 'Search', exact: true }).click(),
        ]);
        await waitCount(page, 'B', CAP_49_99.length);
        eq(lastSearch(app).filters.maxPrice, 49.99);
        sameSet(app.state().lastResultIds, CAP_49_99);
        eq(await page.getByLabel('Highest price you will pay (USD)').inputValue(), '49.99');
      }
    );
  });
};

/* ------------------------------------------------------------------ */
/* Lifecycle: close() frees the port                                   */
/* ------------------------------------------------------------------ */

const lifecycleChecks = async () => {
  await check(
    'close(): returns promptly with a delayed response in flight and leaves no live timer behind',
    async () => {
      const app = await catalog.startApp({ variant: 'A', faults: { slowResponseMs: 6000 } });
      const port = Number(new URL(app.url).port);
      const pending = fetch(`${app.origin}/api/products`).then(
        () => 'answered',
        () => 'aborted'
      );
      await sleep(200);
      const outcome = await Promise.race([
        app.close().then(() => 'closed'),
        sleep(3000).then(() => 'hung'),
      ]);
      assert.equal(outcome, 'closed', 'close() hung on an in-flight response');
      assert.equal(await portIsFree(port), true, 'port must be free after close()');
      assert.equal(await pending, 'aborted');
    }
  );

  await check(
    'close(): the process can exit right after close() (no orphaned delay timer)',
    async () => {
      const script = `
      import(${JSON.stringify(new URL('./catalog.mjs', import.meta.url).href)}).then(async mod => {
        const app = await mod.startApp({ faults: { slowResponseMs: 5000 } });
        fetch(app.origin + '/api/products').catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 150));
        await app.close();
      });`;
      const started = Date.now();
      const outcome = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=commonjs', '-e', script], {
          stdio: 'ignore',
        });
        const killer = setTimeout(() => child.kill('SIGKILL'), 3500);
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          clearTimeout(killer);
          resolve({ code, signal });
        });
      });
      eq(outcome, { code: 0, signal: null });
      assert.ok(Date.now() - started < 3500, `process lingered ${Date.now() - started}ms`);
    }
  );

  for (const variant of VARIANTS) {
    await check(
      `${variant} close(): port is released even with a live browser connection, and close() is idempotent`,
      async () => {
        const app = await catalog.startApp({ variant });
        const port = Number(new URL(app.url).port);
        const context = await browser.newContext({ viewport: VIEWPORT });
        const page = await context.newPage();
        try {
          await page.goto(app.url);
          assert.equal(await canConnect(port), true);
          assert.equal(await portIsFree(port), false, 'port must be busy while the app runs');
          const started = Date.now();
          await app.close();
          assert.ok(Date.now() - started < 3000, 'close() should not hang on keep-alive sockets');
          await app.close();
          assert.equal(await canConnect(port), false);
          assert.equal(await portIsFree(port), true, 'port must be free after close()');
          await assert.rejects(() => fetch(app.url));
        } finally {
          await context.close().catch(() => undefined);
          await app.close();
        }
      }
    );
  }

  await check('close(): a fixed port can be reused immediately by a second app', async () => {
    const first = await catalog.startApp({ variant: 'A' });
    const port = Number(new URL(first.url).port);
    await first.close();
    const second = await catalog.startApp({ variant: 'B', port });
    try {
      eq(second.url, `http://127.0.0.1:${port}/`);
      assert.equal((await fetch(second.url)).status, 200);
    } finally {
      await second.close();
    }
  });
};

/* ------------------------------------------------------------------ */

const main = async () => {
  const watchdog = setTimeout(
    () => {
      console.log('FAIL watchdog: check run exceeded 8 minutes');
      process.exit(2);
    },
    8 * 60 * 1000
  );
  watchdog.unref();

  browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  try {
    const titleOf = await loadTitles();
    await contractChecks(titleOf);
    await flowA(titleOf);
    await flowB(titleOf);
    await flowC(titleOf);
    await faultChecks();
    await hardeningChecks();
    await lifecycleChecks();
  } finally {
    await browser.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log(`FAILED (${failed}):`);
    failures.forEach(name => console.log(`  - ${name}`));
    process.exit(1);
  }
};

main().catch(error => {
  console.log(`FAIL harness error: ${String(error && error.stack ? error.stack : error)}`);
  process.exit(1);
});
