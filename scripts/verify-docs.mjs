import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';
import { createBrowserTaskAgent } from '../docs/examples/task-agent-node.mjs';

await mkdir('.local', { recursive: true });
const temporary = await mkdtemp(join(resolve('.local'), 'docs-'));
const examples = ['browser-engine', 'in-page-task', 'approval'];
let server;
let browser;
let integration;
try {
  const markdown = [
    'README.md',
    ...(await readdir('docs/integration'))
      .filter(name => name.endsWith('.md'))
      .map(name => `docs/integration/${name}`),
  ];
  const snippets = [];
  for (const path of markdown) {
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/```(?:typescript|ts)\n([\s\S]*?)\n```/g)) {
      snippets.push(match[1]);
    }
  }
  // Resolve the real package self-reference; never compile examples against private src aliases.
  for (const [index, source] of snippets.entries()) {
    await writeFile(join(temporary, `snippet-${index}.ts`), source);
  }
  execFileSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--incremental',
      'false',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      ...examples.map(name => `docs/examples/${name}.ts`),
      ...snippets.map((_, index) => join(temporary, `snippet-${index}.ts`)),
    ],
    { stdio: 'inherit' }
  );
  const emailBuilderSource = snippets.find(source =>
    source.includes('export function emailUpdateRequest(')
  );
  assert(emailBuilderSource, 'the private-input builder must be part of the checked documentation');
  const emailBuilderModule = ts.transpileModule(emailBuilderSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const { emailUpdateRequest } = await import(
    `data:text/javascript,${encodeURIComponent(emailBuilderModule)}`
  );
  const configuredOrigin = 'https://account.example.test';
  const emailRequest = emailUpdateRequest(`${configuredOrigin}/settings`, 'guide@example.test');
  assert.deepEqual(emailRequest.authorization.origins, [configuredOrigin]);
  assert.deepEqual(emailRequest.inputDeclarations[0].bind.origins, [configuredOrigin]);
  for (const untrustedUrl of [
    'https://attacker.example.test/settings',
    'https://account.example.test.attacker.example.test/settings',
    'https://account.example.test@attacker.example.test/settings',
    'http://account.example.test/settings',
    'https://account.example.test:444/settings',
  ]) {
    assert.throws(
      () => emailUpdateRequest(untrustedUrl, 'guide@example.test'),
      /outside the configured account origin/
    );
  }
  const compiled = {};
  for (const name of examples) {
    const source = await readFile(`docs/examples/${name}.ts`, 'utf8');
    compiled[name] = ts.transpileModule(source.replaceAll("'@juspay/kriya'", "'/kriya.js'"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
  }
  const bundle = await readFile('dist/index.esm.js', 'utf8');
  server = createServer((request, response) => {
    const path = request.url;
    if (path === '/kriya.js' || examples.some(name => path === `/${name}.js`)) {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        path === '/kriya.js'
          ? bundle
              .replaceAll('from"html2canvas"', 'from"/canvas.js"')
              .replaceAll("from 'html2canvas'", "from '/canvas.js'")
          : compiled[path.slice(1, -3)]
      );
      return;
    }
    if (path === '/canvas.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        'export default function(){throw new Error("screenshots are excluded from this check")}'
      );
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><title>Kriya integration</title></head><body>
<h1>${path === '/complete' ? 'Delivery available' : 'Integration start'}</h1>
<label>Name<input id="name" value="Before"></label>
<button type="button" id="save" onclick="window.activationCount=(window.activationCount||0)+1">Save preference</button>
<a href="/complete">Delivery details</a><p>Delivery available from this application.</p>
</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.KRIYA_CHROMIUM_EXECUTABLE || undefined,
    headless: true,
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const exchange = stage => ({
    stage,
    provider: 'scripted-doc-verification',
    attempts: 0,
    attemptLog: [],
    latencyMs: 0,
    requestBytes: 0,
    estimatedInputTokens: 0,
    goalVerified: true,
  });
  const ok = (stage, decision) => ({ ok: true, decision, exchange: exchange(stage) });
  const decider = {
    chooseAction: async request => {
      const navigate = new URL(request.observation.url).pathname === '/start';
      const id = request.offers.targets.NAVIGATE?.[0];
      assert(!navigate || id, 'navigation target must be offered');
      return ok('action', {
        operation: navigate ? 'NAVIGATE' : 'DONE',
        target: navigate ? { kind: 'target', id } : { kind: 'not_applicable' },
        confidence: 1,
        operationConfidence: 1,
        ...(navigate ? { targetConfidence: 1 } : {}),
      });
    },
    chooseArgument: async () => ok('argument', { kind: 'none_appropriate', confidence: 1 }),
    classifyCommitment: async () =>
      ok('commitment', { commitment: 'NONE', confidence: 1, agreement: 'agreed' }),
    verifyCompletion: async request =>
      ok('completion', {
        verdict: 'SATISFIED',
        confidence: 1,
        evidenceTargetIds: request.observation.elements
          .filter(element => (element.text ?? element.label).includes('Delivery available'))
          .map(element => element.id),
      }),
  };
  integration = await createBrowserTaskAgent({ context, page, allowedOrigins: [origin], decider });
  await page.goto(`${origin}/start`);
  const documentBefore = await page.evaluate(() => globalThis.__kriyaTaskBridge.documentId);
  const result = await integration.agent.run({
    goal: 'Open the delivery details.',
    startUrl: `${origin}/start`,
    expect: { answer: false },
    authorization: { origins: [origin] },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(page.url(), `${origin}/complete`);
  assert.notEqual(
    await page.evaluate(() => globalThis.__kriyaTaskBridge.documentId),
    documentBefore
  );
  const engine = await page.evaluate(async () => {
    const { fillName } = await import('/browser-engine.js');
    const first = await fillName(document.body);
    const value = document.querySelector('#name').value;
    const api = globalThis.WebAutomata.createAutomationEngine({ screenshotOnError: false });
    api.initialize();
    try {
      const cleared = await api.executeAction(
        { type: 'fill', parameters: { strict: 'true', value: '' } },
        { target: document.querySelector('#name') }
      );
      const blank = document.querySelector('#name').value;
      const clicked = await api.executeAction(
        { type: 'click', parameters: { strict: 'true' } },
        { target: document.querySelector('#save') }
      );
      const missing = await fillName(document.createElement('section'));
      return {
        first: first.success,
        value,
        cleared: cleared.success,
        blank,
        clicked: clicked.success,
        activationCount: window.activationCount,
        missing: missing.success,
      };
    } finally {
      api.dispose();
    }
  });
  assert.deepEqual(engine, {
    first: true,
    value: 'Ada Lovelace',
    cleared: true,
    blank: '',
    clicked: true,
    activationCount: 1,
    missing: false,
  });
  const inPage = await page.evaluate(async () => {
    const { createPageAgent } = await import('/in-page-task.js');
    const exchange = stage => ({
      stage,
      provider: 'scripted-doc-verification',
      attempts: 0,
      attemptLog: [],
      latencyMs: 0,
      requestBytes: 0,
      estimatedInputTokens: 0,
      goalVerified: true,
    });
    const ok = (stage, decision) => ({ ok: true, decision, exchange: exchange(stage) });
    const integration = createPageAgent({
      chooseAction: async () =>
        ok('action', {
          operation: 'DONE',
          target: { kind: 'not_applicable' },
          confidence: 1,
          operationConfidence: 1,
        }),
      chooseArgument: async () => ok('argument', { kind: 'none_appropriate', confidence: 1 }),
      verifyCompletion: async request =>
        ok('completion', {
          verdict: 'SATISFIED',
          confidence: 1,
          evidenceTargetIds: request.observation.elements
            .filter(element => (element.text ?? element.label).includes('Delivery available'))
            .map(element => element.id),
        }),
    });
    try {
      return (
        await integration.agent.run({
          goal: 'Delivery details are available.',
          expect: { answer: false },
          authorization: { origins: [location.origin] },
        })
      ).status;
    } finally {
      await integration.dispose();
    }
  });
  assert.equal(inPage, 'completed');
  // Policy negative control: a foreign start origin must refuse before an action.
  const outside = await integration.agent.run({
    goal: 'Open the delivery details.',
    startUrl: 'https://example.invalid/',
    authorization: { origins: ['https://example.invalid'] },
  });
  assert.equal(outside.status, 'blocked');
  assert.equal(outside.reason, 'ORIGIN_LEFT_SCOPE');
  assert.equal(outside.steps, 0);
  // Force a real commitment classification, then prove the documented helper binds actual consent.
  const { createTaskAgent } = await import('../dist/index.esm.js');
  const { resolveApproval } = await import(
    `data:text/javascript,${encodeURIComponent(ts.transpileModule(await readFile('docs/examples/approval.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)}`
  );
  const approvalAgent = createTaskAgent({
    host: integration.host,
    decider: {
      ...decider,
      chooseAction: async request =>
        ok('action', {
          operation: 'CLICK',
          target: {
            kind: 'target',
            id: request.offers.targets.CLICK?.find(
              id =>
                request.observation.elements.find(element => element.id === id)?.label ===
                'Save preference'
            ),
          },
          confidence: 1,
          operationConfidence: 1,
          targetConfidence: 1,
        }),
      classifyCommitment: async () =>
        ok('commitment', { commitment: 'ACCOUNT_CHANGE', confidence: 1, agreement: 'agreed' }),
    },
  });
  const beforeApproval = await page.evaluate(() => window.activationCount);
  const paused = await approvalAgent.run({
    goal: 'Save my preference.',
    startUrl: page.url(),
    authorization: { origins: [origin] },
  });
  assert.equal(paused.status, 'awaiting_approval', JSON.stringify(paused));
  assert.equal(await page.evaluate(() => window.activationCount), beforeApproval);
  const forged = await approvalAgent.resume({
    checkpoint: paused.checkpoint,
    resolution: {
      kind: 'approval',
      resolution: {
        approvalId: paused.approval.id,
        nonce: 'wrong-nonce',
        digest: paused.approval.digest,
        contextDigest: paused.approval.contextDigest,
        decision: 'approve',
      },
    },
  });
  assert.equal(forged.status, 'failed');
  assert.equal(forged.error.code, 'APPROVAL_MISMATCH');
  assert.equal(await page.evaluate(() => window.activationCount), beforeApproval);
  const denied = await resolveApproval(approvalAgent, paused, 'deny');
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.reason, 'POLICY_DENIED');
  assert.equal(await page.evaluate(() => window.activationCount), beforeApproval);
  const again = await approvalAgent.run({
    goal: 'Save my preference.',
    startUrl: page.url(),
    authorization: { origins: [origin] },
    options: { budgets: { maxSteps: 1 } },
  });
  assert.equal(again.status, 'awaiting_approval');
  const approved = await resolveApproval(approvalAgent, again, 'approve');
  assert.equal(await page.evaluate(() => window.activationCount), beforeApproval + 1);
  assert.equal(approved.ledger.filter(entry => entry.effect === 'applied').length, 1);
  process.stdout.write(
    JSON.stringify({
      gate: 'documentation-integration',
      typedExamples: examples.length,
      typedSnippets: snippets.length,
      browserEngine: true,
      inPageTaskAgent: true,
      remoteFullNavigation: true,
      completionEvidence: true,
      missingTargetRefused: true,
      foreignOriginRefused: true,
      callerUrlCannotWidenAuthorization: true,
      forgedApprovalRefused: true,
      deniedApprovalNotExecuted: true,
      boundApprovalExecutedOnce: true,
      liveProviderCalls: 0,
    }) + '\n'
  );
} finally {
  await integration?.host.dispose();
  await browser?.close();
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
