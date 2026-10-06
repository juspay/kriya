import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { preflight } from '../harness/env.mjs';
import { launchBrowser, newScenarioContext } from '../harness/browser.mjs';
import { createPlaywrightTransport } from '../harness/host.mjs';
import { checkDist } from '../harness/dist.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const source = process.argv.includes('--source');
const outputIndex = process.argv.indexOf('--output');
const output =
  outputIndex === -1
    ? path.join(root, `e2e/salvage/chromium-${source ? 'source' : 'dist'}-proof.json`)
    : path.resolve(process.argv[outputIndex + 1]);
const dist = source ? undefined : checkDist({ root });
if (!source) assert.equal(dist.ok, true);
let api;
let umd;
if (source) {
  const esbuild = createRequire(path.join(root, 'package.json'))('esbuild');
  const cache = path.join(root, 'e2e/.cache');
  await fs.mkdir(cache, { recursive: true });
  const shared = {
    absWorkingDir: root,
    entryPoints: ['src/index.ts'],
    bundle: true,
    target: 'es2020',
    logLevel: 'silent',
  };
  await esbuild.build({
    ...shared,
    platform: 'node',
    format: 'esm',
    outfile: path.join(cache, 'source.mjs'),
    external: ['html2canvas'],
  });
  const browser = await esbuild.build({
    ...shared,
    platform: 'browser',
    format: 'iife',
    globalName: 'WebAutomata',
    write: false,
  });
  umd = `${browser.outputFiles[0].text}\nglobalThis.WebAutomata = WebAutomata;`;
  api = await import(pathToFileURL(path.join(cache, 'source.mjs')).href);
} else {
  api = await import('../../dist/index.esm.js');
  umd = await fs.readFile(path.join(root, 'dist/index.umd.js'), 'utf8');
}
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(
    request.url === '/second'
      ? '<!doctype html><title>Second document</title><main><h1>Destination reached</h1><label>Address <input name="address"></label></main>'
      : '<!doctype html><title>First document</title><main><h1>Start</h1><label>Name <input name="name" value="old"></label><a href="/second">Continue</a></main>'
  );
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const environment = preflight({ requireKey: false });
assert.equal(environment.ok, true);
const browser = await launchBrowser(environment);
let context;
let host;
const proof = {
  kind: source ? 'source-bundle integration; no model' : 'dist integration; no model',
  passed: false,
  checks: [],
};
try {
  context = await newScenarioContext(browser, { umd });
  await context.page.goto(origin);
  const transport = createPlaywrightTransport({
    page: context.page,
    redactEnvelope: api.redactEnvelope,
  });
  host = api.createRemoteTaskHost({ transport });
  const capabilities = await host.capabilities();
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.value.persistsAcrossNavigation, true);
  assert.equal(capabilities.value.authoritativeLocation, true);
  proof.checks.push('persistent host capabilities and authoritative location');
  const observe = () =>
    host.observe({ sessionId: 'ses_chromium', options: { settle: { quietMs: 20, maxMs: 200 } } });
  const initial = await observe();
  assert.equal(initial.ok, true);
  const fill = initial.value.elements.find(element => element.operations.includes('FILL'));
  assert.ok(fill);
  const request = (snapshot, command) => ({
    requestId: 'req_chromium',
    scope: {
      sessionId: snapshot.sessionId,
      snapshotId: snapshot.snapshotId,
      documentId: snapshot.documentId,
    },
    command,
    allowedOrigins: [origin],
    timeoutMs: 1000,
    settle: { quietMs: 20, maxMs: 200 },
  });
  const ref = (snapshot, element) => ({
    sessionId: snapshot.sessionId,
    snapshotId: snapshot.snapshotId,
    targetId: element.id,
    signature: element.signature,
  });
  const filled = await host.execute(
    request(initial.value, {
      operation: 'FILL',
      target: ref(initial.value, fill),
      value: 'Jordan',
      sensitive: false,
    })
  );
  assert.equal(filled.status, 'applied');
  assert.equal(await context.page.locator('input').inputValue(), 'Jordan');
  proof.checks.push('strict fill through real engine');
  const newer = await observe();
  assert.equal(newer.ok, true);
  const stale = await host.execute(
    request(initial.value, {
      operation: 'FILL',
      target: ref(initial.value, fill),
      value: 'Wrong',
      sensitive: false,
    })
  );
  assert.equal(stale.status, 'rejected_stale');
  assert.equal(await context.page.locator('input').inputValue(), 'Jordan');
  proof.checks.push('superseded snapshot rejects without mutation');
  const link = newer.value.elements.find(element => element.operations.includes('NAVIGATE'));
  assert.ok(link);
  const navigated = await host.execute(
    request(newer.value, { operation: 'NAVIGATE', target: ref(newer.value, link) })
  );
  const second = await observe();
  assert.equal(second.ok, true);
  assert.notEqual(second.value.documentId, initial.value.documentId);
  assert.ok(second.value.text.includes('Destination reached'));
  assert.equal(context.page.url(), `${origin}/second`);
  proof.checks.push('full document navigation and fresh bridge reinjection');
  proof.navigation = { status: navigated.status, effect: navigated.effect };
  assert.equal(context.diagnostics().pageErrors.length, 0);
  proof.checks.push('no browser page errors');
  proof.passed = true;
  if (dist) proof.sha256 = dist.sha256;
} finally {
  await host?.dispose();
  await context?.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(output, `${JSON.stringify(proof, null, 2)}\n`);
}
process.stdout.write(JSON.stringify(proof) + '\n');
