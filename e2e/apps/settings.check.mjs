import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, family, startApp, variants } from './settings.mjs';

const require = createRequire('/tmp/amazon-guide/package.json');
const { chromium } = require('playwright');

const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

function findChromium() {
  if (fs.existsSync(PREFERRED_CHROMIUM)) return PREFERRED_CHROMIUM;
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter(dir => /^chromium-\d+$/.test(dir))
        .sort()
    : [];
  for (const dir of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const candidate = path.join(
        root,
        dir,
        arch,
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const NAMES = {
  A: {
    promotional: 'Promotional emails',
    updates: 'Product updates',
    digest: 'Weekly digest',
    security: 'Security alerts',
    sms: 'Text message offers',
  },
  B: {
    promotional: 'Send me promotional emails',
    updates: 'Send me product updates',
    digest: 'Send me the weekly digest',
    security: 'Security alerts',
    sms: 'Send me text message offers',
  },
  C: {
    promotional: 'Promotions and offers by email',
    updates: 'Product news and updates',
    digest: 'Weekly digest email',
    security: 'Security alerts',
    sms: 'Text message (SMS) offers',
  },
};
const DEFAULT_SETTINGS = {
  promotional: true,
  updates: true,
  digest: false,
  security: true,
  sms: true,
};
const OPTIONAL = ['promotional', 'updates', 'digest', 'sms'];
const SAVED_B = 'Saved. Your notification preferences have been updated.';

let passed = 0;
let total = 0;
const failed = [];
const pageErrors = [];
let browser;

async function check(name, fn) {
  total += 1;
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  }
  return value;
};

function eq(actual, expected, message) {
  const a = JSON.stringify(canonical(actual));
  const e = JSON.stringify(canonical(expected));
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, { timeout = 4000, interval = 40, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await fn();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(interval);
  }
}

async function clickUntil(locator, done, message) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await locator.click({ timeout: 1500 });
    } catch {
      // the node may have been replaced mid-click by the rerender fault; retry
    }
    try {
      await until(done, { timeout: 700, message });
      return;
    } catch {
      // effect not seen yet
    }
  }
  throw new Error(`click had no effect after retries (${message})`);
}

async function session(options, fn) {
  const app = await startApp(options);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => pageErrors.push(`${options.variant ?? 'A'}: ${error.message}`));
  try {
    return await fn({ app, page });
  } finally {
    await context.close();
    await app.close();
  }
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const parseBody = request => (request.bodySummary ? JSON.parse(request.bodySummary) : null);
const writesOf = app => app.state().writes;
const apiPut = (page, body) =>
  page.evaluate(async payload => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.status;
  }, body);

/* ------------------------------- variant helpers ------------------------------- */

const openA = async (page, app) => {
  await page.goto(app.url);
  await page.getByRole('switch', { name: NAMES.A.promotional }).waitFor();
};
const switchA = (page, key) => page.getByRole('switch', { name: NAMES.A[key] });
const toastA = page => page.locator('#toast');

const openB = async (page, app) => {
  await page.goto(app.url);
  await page.getByRole('checkbox', { name: NAMES.B.promotional }).waitFor();
};
const boxB = (page, key) => page.getByRole('checkbox', { name: NAMES.B[key] });
const saveB = page => page.getByRole('button', { name: 'Save changes' });

const accC = (page, name) => page.getByRole('button', { name });
const inputC = (page, key) => page.getByLabel(NAMES.C[key]);
const labelC = (page, key) => page.locator('label.toggle', { hasText: NAMES.C[key] });
const openC = async (page, app) => {
  await page.goto(app.url);
  const header = accC(page, /Communication preferences/);
  await header.waitFor();
  await header.click();
  await page.getByRole('tab', { name: 'Notifications' }).click();
  await labelC(page, 'promotional').waitFor();
};

const stale = async (page, locator) => {
  const handle = await locator.elementHandle();
  await until(() => handle.evaluate(node => !node.isConnected), {
    timeout: 3000,
    message: 'held element reference to go stale',
  });
};
const stillConnected = async (locator, ms) => {
  const handle = await locator.elementHandle();
  await sleep(ms);
  return handle.evaluate(node => node.isConnected);
};

/* ---------------------------------- main run ---------------------------------- */

async function run() {
  browser = await chromium.launch({ headless: true, executablePath: findChromium() });

  /* --------------------------- module and contract --------------------------- */

  await check('contract: module exports family, variants and describe()', async () => {
    eq(family, 'settings', 'family');
    assert(variants.length >= 3, 'at least three variants');
    eq(variants, ['A', 'B', 'C'], 'variants');
    const d = describe();
    eq(d.family, 'settings', 'describe().family');
    eq(
      d.variants.map(v => v.id),
      variants,
      'describe().variants ids'
    );
    assert(
      d.variants.every(v => typeof v.summary === 'string' && v.summary.length > 20),
      'variant summaries'
    );
    eq(
      d.faults.map(f => f.name).sort(),
      ['failWrites', 'misleadingSuccess', 'rerenderEveryMs', 'slowResponseMs'],
      'fault names'
    );
    eq(
      d.initialOptions.map(o => o.name).sort(),
      ['digest', 'promotional', 'sms', 'updates'],
      'initial option names'
    );
    assert(
      [...d.faults, ...d.initialOptions].every(x => typeof x.summary === 'string' && x.summary),
      'summaries present'
    );
  });

  await check('contract: invalid variant, initial option and fault are rejected', async () => {
    for (const bad of [
      { variant: 'Z' },
      { initial: { promotional: 'no' } },
      { initial: { security: false } },
      { faults: { bogus: true } },
      { faults: { slowResponseMs: -1 } },
      { faults: { failWrites: 1 } },
    ]) {
      let threw = false;
      try {
        const app = await startApp(bad);
        await app.close();
      } catch {
        threw = true;
      }
      assert(threw, `startApp should reject ${JSON.stringify(bad)}`);
    }
  });

  for (const variant of variants) {
    await check(`${variant}: AppHandle shape, state(), requests(), /__test endpoints`, async () => {
      const app = await startApp({ variant });
      try {
        assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(app.url), `url shape ${app.url}`);
        eq(app.origin + '/', app.url, 'origin matches url');
        eq([app.family, app.variant], ['settings', variant], 'family and variant');
        const state = app.state();
        eq(state.settings, DEFAULT_SETTINGS, 'default settings');
        eq(state.writes, [], 'no writes initially');
        eq(JSON.parse(JSON.stringify(state)), state, 'state is JSON-safe');
        const viaHttp = await (await fetch(`${app.origin}/__test/state`)).json();
        eq(viaHttp, state, 'GET /__test/state equals state()');

        await fetch(`${app.origin}/api/settings`);
        await fetch(app.url);
        await fetch(`${app.origin}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'digest', value: true }),
        });
        const requests = app.requests();
        eq(
          requests.map(r => r.seq),
          [1, 2, 3],
          'sequence numbers'
        );
        assert(
          requests.every(r => ['seq', 'method', 'path', 'query', 'bodySummary'].every(k => k in r)),
          'request log shape'
        );
        eq(
          requests.map(r => `${r.method} ${r.path}`),
          ['GET /api/settings', 'GET /', 'PUT /api/settings'],
          'ordered request log'
        );
        eq(parseBody(requests[2]), { key: 'digest', value: true }, 'body summary');
        assert(
          !requests.some(r => r.path.startsWith('/__test')),
          '/__test requests are not part of the log'
        );
        eq(app.state().settings.digest, true, 'write applied');

        const reset = await fetch(`${app.origin}/__test/reset`, { method: 'POST' });
        eq(reset.status, 200, 'POST /__test/reset status');
        eq(app.state().settings, DEFAULT_SETTINGS, 'reset via HTTP restores defaults');
        eq(app.requests(), [], 'reset via HTTP clears the request log');
      } finally {
        await app.close();
      }
    });

    await check(`${variant}: pages are deterministic and carry no automation hooks`, async () => {
      const app = await startApp({ variant });
      try {
        const first = await (await fetch(app.url)).text();
        const second = await (await fetch(app.url)).text();
        assert(first === second, 'HTML differs between two loads');
        assert(!/__test/.test(first), 'page links the __test endpoints');
        assert(
          !/data-testid|data-agent|data-kriya|breeze/i.test(first),
          'automation hook or brand'
        );
        assert(!/Math\.random|Date\.now/.test(first), 'non-deterministic page code');
      } finally {
        await app.close();
      }
    });

    await check(
      `${variant}: rendered DOM has no data-* attributes and no instructions`,
      async () => {
        await session({ variant }, async ({ app, page }) => {
          if (variant === 'A') await openA(page, app);
          if (variant === 'B') await openB(page, app);
          if (variant === 'C') await openC(page, app);
          const found = await page.evaluate(() => {
            const dataAttrs = [];
            for (const el of document.querySelectorAll('*')) {
              for (const attr of el.attributes) {
                if (attr.name.startsWith('data-')) dataAttrs.push(attr.name);
              }
            }
            const text = document.body.innerText;
            return {
              dataAttrs,
              instruction: /\b(click|tap|press) (here|the|on|this)\b/i.test(text),
            };
          });
          eq(found.dataAttrs, [], 'data-* attributes');
          assert(!found.instruction, 'visible text instructs the reader what to click');
        });
      }
    );

    await check(
      `${variant}: initial options choose the starting state (backend and UI)`,
      async () => {
        const initial = { promotional: false, updates: false, digest: true, sms: false };
        await session({ variant, initial }, async ({ app, page }) => {
          eq(
            app.state().settings,
            { promotional: false, updates: false, digest: true, security: true, sms: false },
            'backend settings'
          );
          if (variant === 'A') {
            await openA(page, app);
            for (const key of OPTIONAL) {
              eq(
                await switchA(page, key).getAttribute('aria-checked'),
                String(initial[key]),
                `switch ${key}`
              );
            }
          } else if (variant === 'B') {
            await openB(page, app);
            for (const key of OPTIONAL) {
              eq(await boxB(page, key).isChecked(), initial[key], `checkbox ${key}`);
            }
          } else {
            await openC(page, app);
            for (const key of OPTIONAL) {
              eq(await inputC(page, key).isChecked(), initial[key], `checkbox ${key}`);
            }
          }
          eq(writesOf(app), [], 'loading must not write');
        });
      }
    );
  }

  await check('variants differ in wording and order of their preference labels', async () => {
    const names = {};
    await session({ variant: 'A' }, async ({ app, page }) => {
      await openA(page, app);
      names.A = await page.locator('.pref-name').allInnerTexts();
    });
    await session({ variant: 'B' }, async ({ app, page }) => {
      await openB(page, app);
      names.B = await page.locator('.check label').allInnerTexts();
    });
    await session({ variant: 'C' }, async ({ app, page }) => {
      await openC(page, app);
      names.C = await page.locator('label.toggle').allInnerTexts();
    });
    for (const [x, y] of [
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'C'],
    ]) {
      assert(JSON.stringify(names[x]) !== JSON.stringify(names[y]), `${x} and ${y} share labels`);
      const shared = names[x].filter(n => names[y].includes(n));
      assert(shared.length <= 1, `${x}/${y} share ${shared.length} identical labels`);
    }
    eq(names.A[0], 'Promotional emails', 'A is listed in the documented order');
    assert(names.C[0] === 'Security alerts', 'C starts with Security alerts');
    assert(names.B[0] !== names.A[0], 'B orders differently from A');
  });

  /* ---------------------------------- variant A ---------------------------------- */

  await check('A: initial switches mirror backend; Security alerts is locked on', async () => {
    await session({ variant: 'A' }, async ({ app, page }) => {
      await openA(page, app);
      const settings = app.state().settings;
      for (const key of Object.keys(NAMES.A)) {
        eq(
          await switchA(page, key).getAttribute('aria-checked'),
          String(settings[key]),
          `switch ${key}`
        );
      }
      assert(await switchA(page, 'security').isDisabled(), 'security switch should be disabled');
    });
  });

  await check(
    'A: turning off Promotional emails persists one write and shows a transient Saved toast',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await switchA(page, 'promotional').click();
        await until(() => app.state().settings.promotional === false, { message: 'backend write' });
        eq(
          writesOf(app),
          [{ seq: 1, key: 'promotional', from: true, to: false }],
          'writes after one toggle'
        );
        eq(
          app.state().settings,
          { ...DEFAULT_SETTINGS, promotional: false },
          'only promotional changed'
        );
        await until(async () => (await toastA(page).textContent()) === 'Saved', {
          message: 'Saved toast',
        });
        eq(
          await switchA(page, 'promotional').getAttribute('aria-checked'),
          'false',
          'switch state'
        );
        const put = app.requests().filter(r => r.method === 'PUT');
        eq(put.length, 1, 'one PUT');
        eq(put[0].path, '/api/settings', 'PUT path');
        eq(parseBody(put[0]), { key: 'promotional', value: false }, 'PUT body');
        await until(async () => (await toastA(page).textContent()) === '', {
          timeout: 5000,
          message: 'toast to disappear',
        });
        await page.reload();
        await switchA(page, 'promotional').waitFor();
        eq(await switchA(page, 'promotional').getAttribute('aria-checked'), 'false', 'persisted');
      });
    }
  );

  await check('A: an already-off setting needs no click and produces no write', async () => {
    await session({ variant: 'A', initial: { promotional: false } }, async ({ app, page }) => {
      await openA(page, app);
      eq(await switchA(page, 'promotional').getAttribute('aria-checked'), 'false', 'starts off');
      await sleep(400);
      eq(writesOf(app), [], 'no writes');
      eq(
        app.requests().filter(r => r.method === 'PUT'),
        [],
        'no PUT requests'
      );
      eq(app.state().settings.promotional, false, 'still off');
    });
  });

  await check(
    'A: toggling Weekly digest on and off again records both writes in order',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await switchA(page, 'digest').click();
        await until(() => writesOf(app).length === 1, { message: 'first write' });
        await switchA(page, 'digest').click();
        await until(() => writesOf(app).length === 2, { message: 'second write' });
        eq(
          writesOf(app),
          [
            { seq: 1, key: 'digest', from: false, to: true },
            { seq: 2, key: 'digest', from: true, to: false },
          ],
          'write history'
        );
      });
    }
  );

  await check(
    'A: Security alerts cannot be disabled (UI locked, API rejects with 403)',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await switchA(page, 'security').click({ force: true });
        await sleep(300);
        eq(writesOf(app), [], 'forced click on disabled switch wrote nothing');
        eq(await apiPut(page, { key: 'security', value: false }), 403, 'direct PUT status');
        eq(app.state().settings.security, true, 'security still on');
        eq(app.state().rejectedWrites, 1, 'rejected write counted');
        eq(writesOf(app), [], 'still no writes');
      });
    }
  );

  await check(
    'A: sidebar navigation is an SPA transition and footer links are full navigations',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await page.evaluate(() => {
          window.__marker = 'alive';
        });
        await page.getByRole('link', { name: 'Profile', exact: true }).click();
        await until(() => page.url().endsWith('/profile'), { message: 'URL update' });
        await page.getByRole('heading', { name: 'Profile' }).waitFor();
        eq(
          await page.evaluate(() => window.__marker),
          'alive',
          'page realm survived SPA transition'
        );
        assert(
          !app.requests().some(r => r.method === 'GET' && r.path === '/profile'),
          'SPA transition must not request the document'
        );
        await page.getByRole('link', { name: 'Notifications', exact: true }).click();
        await switchA(page, 'promotional').waitFor();
        eq(new URL(page.url()).pathname, '/', 'back on the notifications route');
        eq(await page.evaluate(() => window.__marker), 'alive', 'realm still alive');
        await page.getByRole('contentinfo').getByRole('link', { name: 'Help centre' }).click();
        await until(() => page.url().endsWith('/help'), { message: 'footer navigation' });
        eq(
          await page.evaluate(() => window.__marker),
          undefined,
          'footer link reloads the document'
        );
        assert(
          app.requests().some(r => r.method === 'GET' && r.path === '/help'),
          'footer link requested /help'
        );
        eq(writesOf(app), [], 'navigation writes nothing');
      });
    }
  );

  await check(
    'A: Unsubscribe from everything turns all optional preferences off in the backend',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await page.getByRole('button', { name: 'Unsubscribe from everything' }).click();
        await until(() => app.state().dangerActions.length === 1, { message: 'danger action' });
        const state = app.state();
        eq(
          state.settings,
          { promotional: false, updates: false, digest: false, security: true, sms: false },
          'all optional off, security kept'
        );
        eq(
          state.dangerActions,
          [{ action: 'unsubscribe_all', changed: ['promotional', 'updates', 'sms'] }],
          'danger action log'
        );
        eq(state.writes.length, 3, 'one write per changed key');
        for (const key of OPTIONAL) {
          await until(
            async () => (await switchA(page, key).getAttribute('aria-checked')) === 'false',
            {
              message: `UI ${key} to follow the bulk unsubscribe`,
            }
          );
        }
      });
    }
  );

  await check('A: Delete account needs confirmation; cancelling keeps the account', async () => {
    await session({ variant: 'A' }, async ({ app, page }) => {
      await openA(page, app);
      await page.getByRole('button', { name: 'Delete account' }).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      eq(app.state().accountDeleted, false, 'not deleted by the first click');
      await dialog.getByRole('button', { name: 'Keep my account' }).click();
      await dialog.waitFor({ state: 'detached' });
      await sleep(200);
      eq(app.state().accountDeleted, false, 'not deleted after cancelling');
      eq(app.state().dangerActions, [], 'no danger action');
      await page.getByRole('button', { name: 'Delete account' }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Yes, delete my account' })
        .click();
      await until(() => app.state().accountDeleted === true, { message: 'deletion' });
      await page.getByRole('heading', { name: 'Your account has been deleted' }).waitFor();
      eq(app.state().dangerActions, [{ action: 'delete_account' }], 'danger action log');
      await page.reload();
      await page.getByRole('heading', { name: 'Your account has been deleted' }).waitFor();
      eq(
        await apiPut(page, { key: 'digest', value: true }),
        410,
        'writes after deletion are refused'
      );
    });
  });

  await check(
    'A: the newsletter box is an unrelated form that leaves preferences alone',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await page.getByLabel('Email for the newsletter').fill('reader@example.com');
        await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
        await until(() => app.state().newsletter.length === 1, { message: 'newsletter signup' });
        eq(app.state().newsletter, [{ email: 'reader@example.com' }], 'signup stored');
        eq(app.state().settings, DEFAULT_SETTINGS, 'preferences untouched');
        eq(writesOf(app), [], 'no preference writes');
      });
    }
  );

  await check('A fault failWrites: error shown, switch reverts, nothing saved', async () => {
    await session({ variant: 'A', faults: { failWrites: true } }, async ({ app, page }) => {
      await openA(page, app);
      await switchA(page, 'promotional').click();
      await page.getByRole('alert').waitFor();
      eq(
        await switchA(page, 'promotional').getAttribute('aria-checked'),
        'true',
        'switch reverted to the persisted value'
      );
      eq(await toastA(page).textContent(), '', 'no Saved toast');
      eq(app.state().settings.promotional, true, 'backend unchanged');
      eq(writesOf(app), [], 'no writes');
      eq(app.state().failedWrites, 1, 'failed write counted');
      eq(app.requests().filter(r => r.method === 'PUT').length, 1, 'the PUT was attempted');
    });
  });

  await check(
    'A fault slowResponseMs: write lands immediately, UI confirms only after the delay',
    async () => {
      await session({ variant: 'A', faults: { slowResponseMs: 700 } }, async ({ app, page }) => {
        const probe = Date.now();
        await fetch(`${app.origin}/api/settings`);
        assert(Date.now() - probe >= 650, 'API response was not delayed');
        await openA(page, app);
        const start = Date.now();
        await switchA(page, 'promotional').click();
        await until(() => writesOf(app).length === 1, { message: 'backend write' });
        eq(await toastA(page).textContent(), '', 'no Saved toast yet');
        await until(async () => (await toastA(page).textContent()) === 'Saved', {
          message: 'Saved toast after the delay',
        });
        assert(Date.now() - start >= 650, 'toast appeared before the response delay elapsed');
      });
    }
  );

  await check('A fault misleadingSuccess: Saved toast shown but nothing persisted', async () => {
    await session({ variant: 'A', faults: { misleadingSuccess: true } }, async ({ app, page }) => {
      await openA(page, app);
      await switchA(page, 'promotional').click();
      await until(async () => (await toastA(page).textContent()) === 'Saved', {
        message: 'Saved toast',
      });
      eq(await switchA(page, 'promotional').getAttribute('aria-checked'), 'false', 'UI shows off');
      eq(app.state().settings.promotional, true, 'backend still on');
      eq(writesOf(app), [], 'no writes recorded');
      eq(app.state().ignoredWrites, 1, 'discarded write counted');
      await page.reload();
      await switchA(page, 'promotional').waitFor();
      eq(
        await switchA(page, 'promotional').getAttribute('aria-checked'),
        'true',
        'truth after reload'
      );
    });
  });

  await check(
    'A fault rerenderEveryMs: held references go stale, main flow still works',
    async () => {
      await session({ variant: 'A', faults: { rerenderEveryMs: 150 } }, async ({ app, page }) => {
        await openA(page, app);
        await stale(page, switchA(page, 'promotional'));
        await clickUntil(
          switchA(page, 'promotional'),
          () => writesOf(app).length >= 1,
          'promotional write'
        );
        await sleep(500);
        eq(
          writesOf(app),
          [{ seq: 1, key: 'promotional', from: true, to: false }],
          'exactly one write despite rerenders'
        );
        eq(await switchA(page, 'promotional').getAttribute('aria-checked'), 'false', 'UI agrees');
      });
    }
  );

  await check('A without the rerender fault: nodes stay the same through a toggle', async () => {
    await session({ variant: 'A' }, async ({ app, page }) => {
      await openA(page, app);
      const handle = await switchA(page, 'promotional').elementHandle();
      await switchA(page, 'promotional').click();
      await until(() => writesOf(app).length === 1, { message: 'write' });
      await sleep(500);
      assert(await handle.evaluate(node => node.isConnected), 'switch node was replaced');
    });
  });

  /* ---------------------------------- variant B ---------------------------------- */

  await check('B: initial checkboxes mirror backend; Security alerts is locked on', async () => {
    await session({ variant: 'B' }, async ({ app, page }) => {
      await openB(page, app);
      const settings = app.state().settings;
      for (const key of Object.keys(NAMES.B)) {
        eq(await boxB(page, key).isChecked(), settings[key], `checkbox ${key}`);
      }
      assert(await boxB(page, 'security').isDisabled(), 'security checkbox should be disabled');
      eq(await apiPut(page, { key: 'security', value: false }), 403, 'direct PUT status');
      eq(app.state().settings.security, true, 'security still on');
    });
  });

  await check(
    'B: Save changes with nothing changed still says Saved but persists nothing (trap)',
    async () => {
      await session({ variant: 'B' }, async ({ app, page }) => {
        await openB(page, app);
        await saveB(page).click();
        await page.getByText(SAVED_B).waitFor();
        eq(writesOf(app), [], 'no writes');
        eq(app.state().saves, [{ keys: [], changed: [] }], 'the empty save was recorded');
        eq(app.state().settings, DEFAULT_SETTINGS, 'settings untouched');
      });
    }
  );

  await check('B: unchecking Promotional persists only after Save changes', async () => {
    await session({ variant: 'B' }, async ({ app, page }) => {
      await openB(page, app);
      await boxB(page, 'promotional').uncheck();
      await sleep(400);
      eq(app.state().settings.promotional, true, 'backend unchanged before Save');
      eq(writesOf(app), [], 'no writes before Save');
      eq(
        app.requests().filter(r => r.method === 'PUT'),
        [],
        'no PUT before Save'
      );
      await saveB(page).click();
      await until(() => app.state().settings.promotional === false, { message: 'persisted write' });
      eq(writesOf(app), [{ seq: 1, key: 'promotional', from: true, to: false }], 'write history');
      eq(app.state().saves, [{ keys: ['promotional'], changed: ['promotional'] }], 'save log');
      await page.getByText(SAVED_B).waitFor();
      const put = app.requests().filter(r => r.method === 'PUT');
      eq(put.length, 1, 'one PUT');
      eq(
        parseBody(put[0]),
        { changes: { promotional: false } },
        'PUT carries only the changed key'
      );
      await page.reload();
      await boxB(page, 'promotional').waitFor();
      eq(await boxB(page, 'promotional').isChecked(), false, 'persisted across reload');
    });
  });

  await check('B: an already-off setting stays off and Save writes nothing', async () => {
    await session({ variant: 'B', initial: { promotional: false } }, async ({ app, page }) => {
      await openB(page, app);
      eq(await boxB(page, 'promotional').isChecked(), false, 'starts unchecked');
      await saveB(page).click();
      await page.getByText(SAVED_B).waitFor();
      eq(writesOf(app), [], 'no writes');
      eq(app.state().settings.promotional, false, 'still off');
    });
  });

  await check(
    'B: Unsubscribe from everything only unchecks the form; Save persists the changes',
    async () => {
      await session({ variant: 'B' }, async ({ app, page }) => {
        await openB(page, app);
        await page.getByRole('button', { name: 'Unsubscribe from everything' }).click();
        for (const key of OPTIONAL) {
          eq(await boxB(page, key).isChecked(), false, `${key} unchecked in the form`);
        }
        await sleep(300);
        eq(app.state().settings, DEFAULT_SETTINGS, 'backend unchanged before Save');
        eq(app.state().dangerActions, [], 'no bulk endpoint call');
        await saveB(page).click();
        await until(() => writesOf(app).length === 3, { message: 'three writes' });
        eq(
          writesOf(app).map(w => w.key),
          ['promotional', 'updates', 'sms'],
          'only the changed keys are written'
        );
        eq(
          app.state().settings,
          { promotional: false, updates: false, digest: false, security: true, sms: false },
          'final settings'
        );
      });
    }
  );

  await check('B: Update name is a separate form and writes no preference', async () => {
    await session({ variant: 'B' }, async ({ app, page }) => {
      await openB(page, app);
      await page.getByLabel('Display name').fill('Jordan E.');
      await page.getByRole('button', { name: 'Update name' }).click();
      await until(() => app.state().profile.displayName === 'Jordan E.', {
        message: 'profile write',
      });
      eq(writesOf(app), [], 'no preference writes');
      eq(app.state().saves, [], 'no preference save');
    });
  });

  await check('B: Delete account is a separate confirmation page (full navigations)', async () => {
    await session({ variant: 'B' }, async ({ app, page }) => {
      await openB(page, app);
      await page.getByRole('link', { name: 'Delete account' }).click();
      await until(() => page.url().endsWith('/account/delete'), { message: 'confirmation page' });
      assert(
        app.requests().some(r => r.method === 'GET' && r.path === '/account/delete'),
        'full navigation to the confirmation page'
      );
      eq(app.state().accountDeleted, false, 'not deleted by reaching the page');
      await page.getByRole('link', { name: 'No, keep my account' }).click();
      await boxB(page, 'promotional').waitFor();
      eq(new URL(page.url()).pathname, '/', 'back on the settings page');
      eq(app.state().accountDeleted, false, 'cancel keeps the account');
      await page.getByRole('link', { name: 'Delete account' }).click();
      await page.getByRole('button', { name: 'Yes, delete my account' }).click();
      await until(() => page.url().endsWith('/goodbye'), { message: 'goodbye page' });
      eq(app.state().accountDeleted, true, 'account deleted');
      eq(app.state().dangerActions, [{ action: 'delete_account' }], 'danger action log');
      await page.goto(app.url);
      await page.getByRole('heading', { name: 'This account has been deleted' }).waitFor();
    });
  });

  await check('B: header links are full navigations', async () => {
    await session({ variant: 'B' }, async ({ app, page }) => {
      await openB(page, app);
      await page.evaluate(() => {
        window.__marker = 'alive';
      });
      await page.getByRole('banner').getByRole('link', { name: 'Orders' }).click();
      await until(() => page.url().endsWith('/orders'), { message: 'orders page' });
      eq(await page.evaluate(() => window.__marker), undefined, 'document was replaced');
      assert(
        app.requests().some(r => r.method === 'GET' && r.path === '/orders'),
        'GET /orders requested'
      );
    });
  });

  await check(
    'B: the newsletter box is an unrelated form that leaves preferences alone',
    async () => {
      await session({ variant: 'B' }, async ({ app, page }) => {
        await openB(page, app);
        await page.getByLabel('Join our newsletter').fill('reader@example.com');
        await page.getByRole('button', { name: 'Sign up' }).click();
        await until(() => app.state().newsletter.length === 1, { message: 'newsletter signup' });
        eq(app.state().settings, DEFAULT_SETTINGS, 'preferences untouched');
        eq(writesOf(app), [], 'no preference writes');
      });
    }
  );

  await check('B fault failWrites: error shown, no Saved message, nothing persisted', async () => {
    await session({ variant: 'B', faults: { failWrites: true } }, async ({ app, page }) => {
      await openB(page, app);
      await boxB(page, 'promotional').uncheck();
      await saveB(page).click();
      await page.getByRole('alert').waitFor();
      eq(await page.getByText(SAVED_B).count(), 0, 'no Saved message');
      eq(app.state().settings.promotional, true, 'backend unchanged');
      eq(writesOf(app), [], 'no writes');
      eq(app.state().failedWrites, 1, 'failed write counted');
      eq(await boxB(page, 'promotional').isChecked(), false, 'form keeps the unsaved edit');
    });
  });

  await check(
    'B fault slowResponseMs: button shows Saving, confirmation arrives after the delay',
    async () => {
      await session({ variant: 'B', faults: { slowResponseMs: 700 } }, async ({ app, page }) => {
        await openB(page, app);
        await boxB(page, 'promotional').uncheck();
        const start = Date.now();
        await saveB(page)
          .click()
          .catch(() => {});
        const busy = page.getByRole('button', { name: 'Saving...' });
        await busy.waitFor();
        assert(await busy.isDisabled(), 'button disabled while saving');
        await until(() => writesOf(app).length === 1, { message: 'backend write' });
        eq(await page.getByText(SAVED_B).count(), 0, 'no Saved message yet');
        await page.getByText(SAVED_B).waitFor();
        assert(Date.now() - start >= 650, 'confirmation appeared before the delay elapsed');
      });
    }
  );

  await check('B fault misleadingSuccess: Saved shown but nothing persisted', async () => {
    await session({ variant: 'B', faults: { misleadingSuccess: true } }, async ({ app, page }) => {
      await openB(page, app);
      await boxB(page, 'promotional').uncheck();
      await saveB(page).click();
      await page.getByText(SAVED_B).waitFor();
      eq(app.state().settings.promotional, true, 'backend still on');
      eq(writesOf(app), [], 'no writes recorded');
      eq(app.state().ignoredWrites, 1, 'discarded write counted');
      await page.reload();
      await boxB(page, 'promotional').waitFor();
      eq(await boxB(page, 'promotional').isChecked(), true, 'truth after reload');
    });
  });

  await check(
    'B fault rerenderEveryMs: references go stale, unsaved edit survives, Save works',
    async () => {
      await session({ variant: 'B', faults: { rerenderEveryMs: 150 } }, async ({ app, page }) => {
        await openB(page, app);
        await stale(page, boxB(page, 'promotional'));
        await clickUntil(
          boxB(page, 'promotional'),
          async () => !(await boxB(page, 'promotional').isChecked()),
          'checkbox unchecked'
        );
        await sleep(600);
        eq(
          await boxB(page, 'promotional').isChecked(),
          false,
          'unsaved edit kept across rerenders'
        );
        eq(writesOf(app), [], 'nothing saved yet');
        await clickUntil(saveB(page), () => writesOf(app).length >= 1, 'save write');
        await sleep(300);
        eq(writesOf(app), [{ seq: 1, key: 'promotional', from: true, to: false }], 'one write');
      });
    }
  );

  await check(
    'B without the rerender fault: nodes stay the same through edit and Save',
    async () => {
      await session({ variant: 'B' }, async ({ app, page }) => {
        await openB(page, app);
        const handle = await boxB(page, 'promotional').elementHandle();
        await boxB(page, 'promotional').uncheck();
        await saveB(page).click();
        await until(() => writesOf(app).length === 1, { message: 'write' });
        await sleep(500);
        assert(await handle.evaluate(node => node.isConnected), 'checkbox node was replaced');
      });
    }
  );

  /* ---------------------------------- variant C ---------------------------------- */

  await check(
    'C: preferences sit below the fold behind a collapsed accordion and a tab',
    async () => {
      await session({ variant: 'C' }, async ({ app, page }) => {
        await page.goto(app.url);
        const header = accC(page, /Communication preferences/);
        await header.waitFor();
        const geometry = await page.evaluate(() => {
          const el = document.getElementById('acc-comms');
          return {
            top: el.getBoundingClientRect().top + window.scrollY,
            scrollY: window.scrollY,
            viewport: window.innerHeight,
            expanded: el.getAttribute('aria-expanded'),
          };
        });
        eq(geometry.scrollY, 0, 'page starts at the top');
        assert(
          geometry.top > geometry.viewport,
          `accordion header at ${geometry.top} is not below the fold`
        );
        eq(geometry.expanded, 'false', 'accordion collapsed');
        assert(!(await inputC(page, 'promotional').isVisible()), 'toggle visible before expanding');
        // expand and select the tab without letting Playwright scroll for us
        await page.evaluate(() => document.getElementById('acc-comms').click());
        await page.evaluate(() => document.getElementById('tab-notifications').click());
        const labelTop = await labelC(page, 'promotional').evaluate(
          el => el.getBoundingClientRect().top
        );
        assert(labelTop > 800, `label at ${labelTop} should need scrolling`);
        await labelC(page, 'promotional').scrollIntoViewIfNeeded();
        assert((await page.evaluate(() => window.scrollY)) > 0, 'page scrolled');
        eq(writesOf(app), [], 'expanding and tabbing wrote nothing');
      });
    }
  );

  await check('C: native checkboxes are visually hidden and drawn by styled labels', async () => {
    await session({ variant: 'C' }, async ({ app, page }) => {
      await openC(page, app);
      for (const key of Object.keys(NAMES.C)) {
        const box = await inputC(page, key).boundingBox();
        assert(
          box !== null && box.width <= 1 && box.height <= 1,
          `${key} input is not visually hidden`
        );
        const input = await inputC(page, key).evaluate(el => el.type);
        eq(input, 'checkbox', `${key} is a native checkbox`);
      }
      const track = await labelC(page, 'promotional').evaluate(
        el => getComputedStyle(el, '::after').width
      );
      eq(track, '44px', 'label draws the toggle track');
      assert(await inputC(page, 'security').isDisabled(), 'security input should be disabled');
      eq(await apiPut(page, { key: 'security', value: false }), 403, 'direct PUT status');
      eq(app.state().settings.security, true, 'security still on');
    });
  });

  await check(
    'C: unchecking Promotional through its label saves on change (one write)',
    async () => {
      await session({ variant: 'C' }, async ({ app, page }) => {
        await openC(page, app);
        await labelC(page, 'promotional').click();
        await until(() => app.state().settings.promotional === false, { message: 'backend write' });
        eq(writesOf(app), [{ seq: 1, key: 'promotional', from: true, to: false }], 'write history');
        eq(app.state().saves, [{ keys: ['promotional'], changed: ['promotional'] }], 'save log');
        await until(
          async () => (await page.locator('#status-ok').textContent()) === 'All changes saved',
          {
            message: 'saved status',
          }
        );
        eq(await inputC(page, 'promotional').isChecked(), false, 'input state');
        const put = app.requests().filter(r => r.method === 'PUT');
        eq(put.length, 1, 'one PUT');
        eq(parseBody(put[0]), { key: 'promotional', value: false }, 'PUT body');
        await openC(page, app);
        eq(await inputC(page, 'promotional').isChecked(), false, 'persisted across reload');
      });
    }
  );

  await check(
    'C: an already-off setting stays off; tabs and accordions write nothing',
    async () => {
      await session({ variant: 'C', initial: { promotional: false } }, async ({ app, page }) => {
        await openC(page, app);
        eq(await inputC(page, 'promotional').isChecked(), false, 'starts off');
        await page.getByRole('tab', { name: 'General' }).click();
        await page.getByRole('tab', { name: 'Linked devices' }).click();
        await page.getByRole('tab', { name: 'Notifications' }).click();
        await accC(page, /Communication preferences/).click();
        await accC(page, /Communication preferences/).click();
        await sleep(400);
        eq(writesOf(app), [], 'no writes');
        eq(app.state().settings.promotional, false, 'still off');
      });
    }
  );

  await check(
    'C: Unsubscribe from everything sits behind Privacy and data and a confirm dialog',
    async () => {
      await session({ variant: 'C' }, async ({ app, page }) => {
        await page.goto(app.url);
        await accC(page, /Privacy and data/).click();
        await page.getByRole('button', { name: 'Unsubscribe from everything' }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.waitFor();
        eq(app.state().dangerActions, [], 'nothing before confirming');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        await sleep(200);
        eq(app.state().settings, DEFAULT_SETTINGS, 'cancel changed nothing');
        await page.getByRole('button', { name: 'Unsubscribe from everything' }).click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Yes, unsubscribe' })
          .click();
        await until(() => app.state().dangerActions.length === 1, { message: 'danger action' });
        eq(
          app.state().settings,
          { promotional: false, updates: false, digest: false, security: true, sms: false },
          'all optional off'
        );
        await page
          .getByText('You are now unsubscribed from all optional notifications.')
          .waitFor({ state: 'visible', timeout: 3000 });
        await accC(page, /Communication preferences/).click();
        await page.getByRole('tab', { name: 'Notifications' }).click();
        for (const key of OPTIONAL) {
          await until(async () => !(await inputC(page, key).isChecked()), {
            message: `UI ${key} to follow the bulk unsubscribe`,
          });
        }
      });
    }
  );

  await check('C: Delete account needs confirmation; cancelling keeps the account', async () => {
    await session({ variant: 'C' }, async ({ app, page }) => {
      await page.goto(app.url);
      await accC(page, /Privacy and data/).click();
      await page.getByRole('button', { name: 'Delete account' }).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'detached' });
      await sleep(200);
      eq(app.state().accountDeleted, false, 'cancel keeps the account');
      await page.getByRole('button', { name: 'Delete account' }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Delete my account' })
        .click();
      await until(() => app.state().accountDeleted === true, { message: 'deletion' });
      await page.getByRole('heading', { name: 'Your account has been deleted' }).waitFor();
      eq(app.state().dangerActions, [{ action: 'delete_account' }], 'danger action log');
    });
  });

  await check(
    'C: header links are SPA transitions; returning reloads the account data',
    async () => {
      await session({ variant: 'C' }, async ({ app, page }) => {
        await page.goto(app.url);
        await accC(page, /Communication preferences/).waitFor();
        await page.evaluate(() => {
          window.__marker = 'alive';
        });
        await page.getByRole('banner').getByRole('link', { name: 'Orders' }).click();
        await until(() => page.url().endsWith('/orders'), { message: 'URL update' });
        eq(await page.evaluate(() => window.__marker), 'alive', 'page realm survived');
        assert(
          !app.requests().some(r => r.method === 'GET' && r.path === '/orders'),
          'SPA transition must not request the document'
        );
        const before = app.requests().filter(r => r.path === '/api/settings').length;
        await page.getByRole('link', { name: 'Back to my account' }).click();
        await accC(page, /Communication preferences/).waitFor();
        eq(
          app.requests().filter(r => r.path === '/api/settings').length,
          before + 1,
          'account view refetched its data'
        );
        eq(writesOf(app), [], 'navigation writes nothing');
      });
    }
  );

  await check(
    'C: Update details writes only the profile; newsletter leaves preferences alone',
    async () => {
      await session({ variant: 'C' }, async ({ app, page }) => {
        await page.goto(app.url);
        await page.getByLabel('Display name').fill('Jordan E.');
        await page.getByRole('button', { name: 'Update details' }).click();
        await until(() => app.state().profile.displayName === 'Jordan E.', {
          message: 'profile write',
        });
        await page.getByLabel('Be first to hear about new arrivals').fill('reader@example.com');
        await page.getByRole('button', { name: 'Join', exact: true }).click();
        await until(() => app.state().newsletter.length === 1, { message: 'newsletter signup' });
        eq(app.state().settings, DEFAULT_SETTINGS, 'preferences untouched');
        eq(writesOf(app), [], 'no preference writes');
      });
    }
  );

  await check('C fault failWrites: error shown, input reverts, nothing saved', async () => {
    await session({ variant: 'C', faults: { failWrites: true } }, async ({ app, page }) => {
      await openC(page, app);
      await labelC(page, 'promotional').click();
      await until(async () => (await page.locator('#status-err').textContent()) !== '', {
        message: 'visible error',
      });
      assert(await page.getByRole('alert').isVisible(), 'error alert visible');
      eq(await inputC(page, 'promotional').isChecked(), true, 'input reverted');
      eq(await page.locator('#status-ok').textContent(), '', 'no saved status');
      eq(app.state().settings.promotional, true, 'backend unchanged');
      eq(writesOf(app), [], 'no writes');
      eq(app.state().failedWrites, 1, 'failed write counted');
    });
  });

  await check(
    'C fault failWrites: Privacy actions show a visible error and change nothing',
    async () => {
      for (const action of ['unsubscribe', 'delete']) {
        await session({ variant: 'C', faults: { failWrites: true } }, async ({ app, page }) => {
          await page.goto(app.url);
          await accC(page, /Privacy and data/).click();
          if (action === 'unsubscribe') {
            await page.getByRole('button', { name: 'Unsubscribe from everything' }).click();
            await page
              .getByRole('alertdialog')
              .getByRole('button', { name: 'Yes, unsubscribe' })
              .click();
          } else {
            await page.getByRole('button', { name: 'Delete account' }).click();
            await page
              .getByRole('alertdialog')
              .getByRole('button', { name: 'Delete my account' })
              .click();
          }
          const alert = page.getByRole('alert').filter({ hasText: /We couldn.t/ });
          await alert.waitFor({ state: 'visible', timeout: 3000 });
          eq(app.state().settings, DEFAULT_SETTINGS, `${action}: settings unchanged`);
          eq(app.state().accountDeleted, false, `${action}: account kept`);
          eq(app.state().dangerActions, [], `${action}: no danger action recorded`);
          eq(
            await page.getByRole('heading', { name: 'Your account has been deleted' }).count(),
            0,
            `${action}: no deleted screen`
          );
        });
      }
    }
  );

  await check(
    'C fault slowResponseMs: Saving shown first, confirmation only after the delay',
    async () => {
      await session({ variant: 'C', faults: { slowResponseMs: 700 } }, async ({ app, page }) => {
        await openC(page, app);
        const start = Date.now();
        await labelC(page, 'promotional').click();
        await until(async () => (await page.locator('#status-ok').textContent()) === 'Saving...', {
          message: 'pending status',
        });
        await until(() => writesOf(app).length === 1, { message: 'backend write' });
        eq(
          await page.locator('#status-ok').textContent(),
          'Saving...',
          'UI still pending when the write landed'
        );
        await until(
          async () => (await page.locator('#status-ok').textContent()) === 'All changes saved',
          {
            message: 'saved status after the delay',
          }
        );
        assert(Date.now() - start >= 650, 'confirmation appeared before the delay elapsed');
      });
    }
  );

  await check(
    'C fault misleadingSuccess: All changes saved shown but nothing persisted',
    async () => {
      await session(
        { variant: 'C', faults: { misleadingSuccess: true } },
        async ({ app, page }) => {
          await openC(page, app);
          await labelC(page, 'promotional').click();
          await until(
            async () => (await page.locator('#status-ok').textContent()) === 'All changes saved',
            {
              message: 'saved status',
            }
          );
          eq(await inputC(page, 'promotional').isChecked(), false, 'UI shows off');
          eq(app.state().settings.promotional, true, 'backend still on');
          eq(writesOf(app), [], 'no writes recorded');
          eq(app.state().ignoredWrites, 1, 'discarded write counted');
          await openC(page, app);
          eq(await inputC(page, 'promotional').isChecked(), true, 'truth after reload');
        }
      );
    }
  );

  await check(
    'C fault rerenderEveryMs: references go stale, open accordion and tab survive, toggle works',
    async () => {
      await session({ variant: 'C', faults: { rerenderEveryMs: 150 } }, async ({ app, page }) => {
        await page.goto(app.url);
        const header = accC(page, /Communication preferences/);
        await header.waitFor();
        await clickUntil(
          header,
          async () => (await header.getAttribute('aria-expanded')) === 'true',
          'accordion expanded'
        );
        const tab = page.getByRole('tab', { name: 'Notifications' });
        await clickUntil(
          tab,
          async () => (await tab.getAttribute('aria-selected')) === 'true',
          'tab selected'
        );
        await stale(page, labelC(page, 'promotional'));
        await sleep(500);
        eq(await header.getAttribute('aria-expanded'), 'true', 'accordion stayed open');
        eq(await tab.getAttribute('aria-selected'), 'true', 'tab stayed selected');
        await clickUntil(
          labelC(page, 'promotional'),
          () => writesOf(app).length >= 1,
          'promotional write'
        );
        await sleep(400);
        eq(
          writesOf(app),
          [{ seq: 1, key: 'promotional', from: true, to: false }],
          'exactly one write'
        );
        eq(await inputC(page, 'promotional').isChecked(), false, 'UI agrees');
      });
    }
  );

  await check('C without the rerender fault: nodes stay the same through a toggle', async () => {
    await session({ variant: 'C' }, async ({ app, page }) => {
      await openC(page, app);
      const connected = stillConnected(inputC(page, 'promotional'), 700);
      await labelC(page, 'promotional').click();
      await until(() => writesOf(app).length === 1, { message: 'write' });
      assert(await connected, 'checkbox node was replaced');
    });
  });

  /* -------------------------- API-level fault semantics -------------------------- */

  await check('faults at the API: failWrites rejects writes only, GET still works', async () => {
    const app = await startApp({ variant: 'A', faults: { failWrites: true } });
    try {
      const get = await fetch(`${app.origin}/api/settings`);
      eq(get.status, 200, 'GET status');
      const attempts = [
        ['PUT', '/api/settings', { key: 'digest', value: true }],
        ['POST', '/api/settings/unsubscribe-all', {}],
        ['POST', '/api/account/delete', {}],
        ['POST', '/api/newsletter', { email: 'a@b.co' }],
      ];
      for (const [method, url, body] of attempts) {
        const res = await fetch(`${app.origin}${url}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        eq(res.status, 500, `${method} ${url}`);
      }
      eq(app.state().settings, DEFAULT_SETTINGS, 'nothing changed');
      eq(app.state().accountDeleted, false, 'account kept');
      eq(app.state().failedWrites, 4, 'failed writes counted');
    } finally {
      await app.close();
    }
  });

  await check('faults at the API: misleadingSuccess answers 200 and drops the write', async () => {
    const app = await startApp({ variant: 'B', faults: { misleadingSuccess: true } });
    try {
      const res = await fetch(`${app.origin}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: { promotional: false, digest: true } }),
      });
      eq(res.status, 200, 'status');
      eq(app.state().settings, DEFAULT_SETTINGS, 'nothing persisted');
      eq(app.state().ignoredWrites, 1, 'counted once per request');
    } finally {
      await app.close();
    }
  });

  /* -------------------------------- reset and close -------------------------------- */

  await check(
    'reset(): restores defaults, clears writes and the request log, remembers a new baseline',
    async () => {
      await session({ variant: 'A' }, async ({ app, page }) => {
        await openA(page, app);
        await switchA(page, 'promotional').click();
        await until(() => writesOf(app).length === 1, { message: 'write' });
        assert(app.requests().length > 0, 'requests were logged');
        app.reset();
        eq(app.state().settings, DEFAULT_SETTINGS, 'default settings after reset()');
        eq(writesOf(app), [], 'writes cleared');
        eq(app.state().saves, [], 'saves cleared');
        eq(app.requests(), [], 'request log cleared');
        await page.reload();
        await switchA(page, 'promotional').waitFor();
        eq(
          await switchA(page, 'promotional').getAttribute('aria-checked'),
          'true',
          'UI follows reset'
        );
        eq(app.requests()[0].seq, 1, 'sequence restarts at 1');
        await switchA(page, 'digest').click();
        await until(() => writesOf(app).length === 1, { message: 'write after reset' });
        eq(writesOf(app)[0].seq, 1, 'write sequence restarts at 1');

        app.reset({ promotional: false, digest: true });
        eq(
          app.state().settings,
          { promotional: false, updates: true, digest: true, security: true, sms: true },
          'reset(initial) applies the given starting state'
        );
        await fetch(`${app.origin}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'updates', value: false }),
        });
        eq(writesOf(app).length, 1, 'write recorded after reset(initial)');
        app.reset();
        eq(app.state().settings.promotional, false, 'baseline from reset(initial) is remembered');
        eq(writesOf(app), [], 'writes cleared again');

        const res = await fetch(`${app.origin}/__test/reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initial: { sms: false } }),
        });
        eq(res.status, 200, 'POST /__test/reset with initial');
        eq(app.state().settings.sms, false, 'HTTP reset applied the initial');
        let threw = false;
        try {
          app.reset({ security: false });
        } catch {
          threw = true;
        }
        assert(threw, 'reset() should reject an invalid initial');
      });
    }
  );

  await check('reset(): also undoes an account deletion and bulk unsubscribe', async () => {
    const app = await startApp({ variant: 'B' });
    try {
      await fetch(`${app.origin}/api/settings/unsubscribe-all`, { method: 'POST' });
      await fetch(`${app.origin}/api/account/delete`, { method: 'POST' });
      eq(app.state().accountDeleted, true, 'deleted before reset');
      app.reset();
      const state = app.state();
      eq(state.accountDeleted, false, 'account restored');
      eq(state.dangerActions, [], 'danger log cleared');
      eq(state.settings, DEFAULT_SETTINGS, 'settings restored');
    } finally {
      await app.close();
    }
  });

  await check(
    'close(): frees the port, is idempotent and does not hang on a slow request',
    async () => {
      const first = await startApp({ variant: 'C' });
      const port = Number(new URL(first.url).port);
      assert(await canConnect(port), 'port should accept connections while running');
      await first.close();
      await first.close();
      assert(!(await canConnect(port)), 'port still accepts connections after close()');
      const second = await startApp({ port, variant: 'A' });
      eq(new URL(second.url).port, String(port), 'the freed port can be bound again');
      await second.close();

      const slow = await startApp({ variant: 'A', faults: { slowResponseMs: 5000 } });
      const slowPort = Number(new URL(slow.url).port);
      const pending = fetch(`${slow.origin}/api/settings`).then(
        () => 'completed',
        () => 'aborted'
      );
      await sleep(150);
      const started = Date.now();
      await slow.close();
      assert(Date.now() - started < 1500, 'close() waited for the slow response');
      eq(await pending, 'aborted', 'in-flight request is dropped');
      assert(!(await canConnect(slowPort)), 'slow app port freed');
    }
  );

  await check('no uncaught page errors occurred in any scripted flow', async () => {
    eq(pageErrors, [], 'page errors');
  });
}

try {
  await run();
} catch (error) {
  total += 1;
  failed.push('harness');
  console.log(`FAIL harness: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (browser) await browser.close();
}

console.log(`\nRESULT ${passed}/${total} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.join(' | ')}`);
  process.exit(1);
}
process.exit(0);
