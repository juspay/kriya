import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { launchBrowser, newScenarioContext } from '../harness/browser.mjs';
import { createPlaywrightTransport } from '../harness/host.mjs';

const requests = [];
let writes = 0;
let redirect = false;
let foreignHits = 0;
const foreign = http.createServer((_request, response) => {
  foreignHits += 1;
  response.end('Outside scope');
});
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
const server = http.createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  requests.push(request.method);
  if (request.method === 'POST') {
    writes += 1;
  }
  if (redirect) {
    response.writeHead(302, { Location: `http://127.0.0.1:${foreign.address().port}/outside` });
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<form method="post"><button>Write once</button></form>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
let scenario;
try {
  const umd = fs.readFileSync(new URL('../../dist/index.umd.js', import.meta.url), 'utf8');
  scenario = await newScenarioContext(browser, { umd });
  const { page } = scenario;
  await page.goto(`${origin}/state#/`);
  const transport = createPlaywrightTransport({ page });
  const id = () => page.evaluate(() => globalThis.__kriyaTaskBridge.documentId);
  const before = await id();
  const input = () => ({ url: page.url(), allowedOrigins: [origin] });
  const hashRefresh = await transport.refresh(input(), { timeoutMs: 3000 });
  assert.equal(hashRefresh.ok, true);
  assert.notEqual(await id(), before);
  assert.equal(page.url(), `${origin}/state#/`);
  assert.deepEqual(requests, ['GET', 'GET']);

  await page.locator('button').click();
  await page.waitForLoadState('load');
  assert.equal(writes, 1);
  const postDocument = await id();
  const postRefresh = await transport.refresh(input(), { timeoutMs: 3000 });
  assert.equal(postRefresh.ok, true);
  assert.notEqual(await id(), postDocument);
  assert.equal(writes, 1, 'Independent verification must never replay the POST');
  assert.equal(requests.at(-1), 'GET');

  const requestCount = requests.length;
  const mismatch = await transport.refresh({ ...input(), url: `${origin}/other` });
  assert.equal(mismatch.ok, false);
  const cancelled = await transport.refresh(input(), { signal: AbortSignal.abort() });
  assert.equal(cancelled.ok, false);
  assert.equal(requests.length, requestCount);

  // Exercise races at the awaited preparation boundaries with the real page.
  for (const boundary of ['evaluate', 'route']) {
    const controller = new AbortController();
    let reloads = 0;
    const racingPage = new Proxy(page, {
      get(target, key) {
        if (key === boundary) {
          return async (...args) => {
            const value = await target[key](...args);
            controller.abort();
            return value;
          };
        }
        if (key === 'reload') {
          return (...args) => {
            reloads += 1;
            return target.reload(...args);
          };
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await createPlaywrightTransport({ page: racingPage }).refresh(input(), {
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CANCELLED');
    assert.equal(reloads, 0, `Cancellation during ${boundary} must prevent dispatch`);
    assert.equal(requests.length, requestCount);
  }

  for (const boundary of ['evaluate', 'reload', 'hash']) {
    const scoped = input();
    const racingPage = new Proxy(page, {
      get(target, key) {
        if (key === boundary || (boundary === 'hash' && key === 'reload')) {
          return async (...args) => {
            if (boundary === 'evaluate') {
              const value = await target.evaluate(...args);
              await target.evaluate(() => history.replaceState(null, '', '/other#/'));
              return value;
            }
            await target.evaluate(
              url => history.replaceState(null, '', url),
              boundary === 'hash' ? '/state#/other' : '/other#/'
            );
            return target.reload(...args);
          };
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await createPlaywrightTransport({ page: racingPage }).refresh(scoped, {
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DOCUMENT_CHANGED');
    if (boundary === 'hash') {
      assert.equal(requests.length, requestCount + 1, 'Only the scoped network URL may be read');
      requests.pop();
    } else {
      assert.equal(requests.length, requestCount, 'A raced URL must never reach the server');
    }
    await page.goto(`${origin}/state#/`);
    requests.pop(); // The explicit restoration is outside the refresh under test.
  }

  redirect = true;
  const redirected = await transport.refresh(input(), { timeoutMs: 1000 });
  assert.equal(redirected.ok, false);
  assert.equal(foreignHits, 0, 'An independent read must block a redirect outside its origins');
  process.stdout.write(
    'PASS: hash refresh, new document, GET only, no POST replay, scope, cancellation races, URL races, redirect refusal\n'
  );
} finally {
  await scenario?.close();
  await browser.close();
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => foreign.close(resolve)),
  ]);
}
