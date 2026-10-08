/**
 * Selftest of e2e/harness/faults.mjs: fake deciders and hosts for the call-level behavior, a real headless
 * Chromium page (served by a local node:http server) for the DOM-level injectors. No dist, no Jev, no key.
 * Prints PASS/FAIL per check and exits non-zero when any check fails.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from './browser.mjs';
import {
  DECIDER_FAULT_MODES,
  FAULT_LABEL,
  HOST_FAULT_MODES,
  applyInjection,
  validateInjection,
} from './faults.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, 'faults.mjs');

const TASK_OPERATIONS = [
  'READ',
  'CLICK',
  'NAVIGATE',
  'FILL',
  'SELECT',
  'SET_CHECKED',
  'PRESS',
  'SCROLL',
  'WAIT',
  'SUBMIT',
  'DONE',
  'BLOCKED',
];
const TARGET_OPERATIONS = [
  'READ',
  'CLICK',
  'NAVIGATE',
  'FILL',
  'SELECT',
  'SET_CHECKED',
  'PRESS',
  'SUBMIT',
];
const DECIDER_ERROR_CODES = [
  'CANCELLED',
  'TIMEOUT',
  'NETWORK',
  'HTTP_ERROR',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'REQUEST_TOO_LARGE',
  'INVALID_RESPONSE',
  'CHOICE_NOT_OFFERED',
  'GOAL_MISMATCH',
  'INVALID_REQUEST',
  'UNSUPPORTED',
];
const HOST_ERROR_CODES = [
  'HOST_DISPOSED',
  'HOST_UNAVAILABLE',
  'HOST_INCAPABLE',
  'DOCUMENT_CHANGED',
  'DOCUMENT_LOST',
  'TIMEOUT',
  'CANCELLED',
  'PROTOCOL_ERROR',
  'UNSUPPORTED',
  'OBSERVE_FAILED',
  'INTERNAL',
];
const VALID_OUTCOME_PAIRS = {
  applied: ['applied', 'none'],
  noop_already_satisfied: ['none'],
  rejected_stale: ['none'],
  rejected_invalid: ['none'],
  rejected_scope: ['none'],
  failed: ['none', 'applied'],
  uncertain: ['uncertain'],
  navigated: ['applied', 'uncertain'],
};

const GOAL = 'Turn off the promotional emails for my account';
const SCOPE = {
  sessionId: 'ses_0123456789ab',
  snapshotId: 'snap_0123456789ab',
  documentId: 'doc_0123456789ab',
};

// ---------------------------------------------------------------------------------------------
// Check runner
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
    failures.push(name);
    const detail = String(error && error.message ? error.message : error).split('\n')[0];
    console.log(`FAIL ${name}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

function makeElement(id, over = {}) {
  return {
    id,
    signature: `sig:${id}`,
    role: 'button',
    kind: 'button',
    label: `label ${id}`,
    state: {
      disabled: false,
      readOnly: false,
      required: false,
      invalid: false,
      focused: false,
    },
    sensitive: false,
    inViewport: true,
    operations: ['CLICK'],
    sources: [],
    ...over,
  };
}

function makeObservation(elements, over = {}) {
  return {
    ...SCOPE,
    sequence: 1,
    observedAt: 1,
    url: 'http://127.0.0.1:1/',
    origin: 'http://127.0.0.1:1',
    title: 'fake',
    text: '',
    elements,
    forms: [],
    notices: [],
    dialogs: [],
    validation: [],
    fingerprint: 'fp',
    ...over,
  };
}

function makeActionRequest({ elements, offers, goal = GOAL } = {}) {
  const els = elements ?? [makeElement('t1'), makeElement('t2'), makeElement('t3')];
  return {
    goal,
    step: 1,
    observation: makeObservation(els),
    offers: offers ?? {
      operations: ['READ', 'CLICK', 'FILL', 'DONE', 'BLOCKED'],
      targets: { READ: ['t1', 't2', 't3'], CLICK: ['t1', 't2', 't3'], FILL: ['t3'] },
    },
    capabilities: {},
    inputs: [],
    history: [],
    maxStateBytes: 22000,
  };
}

function makeArgumentRequest(candidates = ['c1', 'c2']) {
  return {
    goal: GOAL,
    step: 1,
    observation: makeObservation([makeElement('t3', { kind: 'text_input' })]),
    operation: 'FILL',
    slot: 'value',
    candidates: candidates.map(id => ({ id, source: 'goal_span', label: id, sensitive: false })),
    inputs: [],
    history: [],
    maxStateBytes: 22000,
  };
}

function makeContext({ goal = GOAL, signal, callIndex = 1 } = {}) {
  return { goal, step: 1, runId: 'run_0123456789ab', callIndex, ...(signal ? { signal } : {}) };
}

function realExchange(stage) {
  return {
    stage,
    provider: 'fake',
    model: 'jev-fake-0',
    attempts: 1,
    attemptLog: [{ attempt: 1, latencyMs: 1 }],
    latencyMs: 1,
    requestBytes: 10,
    estimatedInputTokens: 6,
    goalVerified: true,
  };
}

function makeFakeDecider({ withClassify = true } = {}) {
  const calls = {
    chooseAction: [],
    chooseArgument: [],
    classifyCommitment: [],
    verifyCompletion: [],
  };
  const returned = {
    chooseAction: [],
    chooseArgument: [],
    classifyCommitment: [],
    verifyCompletion: [],
  };
  const record = (name, request, context, result) => {
    calls[name].push({ request, context });
    returned[name].push(result);
    return result;
  };
  const decider = {
    chooseAction: async (request, context) =>
      record('chooseAction', request, context, {
        ok: true,
        decision: {
          operation: 'CLICK',
          target: { kind: 'target', id: 't1' },
          confidence: 0.8,
          operationConfidence: 0.8,
          targetConfidence: 0.8,
        },
        exchange: realExchange('action'),
      }),
    chooseArgument: async (request, context) =>
      record('chooseArgument', request, context, {
        ok: true,
        decision: { kind: 'candidate', candidateId: 'c1', confidence: 0.8 },
        exchange: realExchange('argument'),
      }),
    verifyCompletion: async (request, context) =>
      record('verifyCompletion', request, context, {
        ok: true,
        decision: { verdict: 'NOT_SATISFIED', confidence: 0.9, evidenceTargetIds: [] },
        exchange: realExchange('completion'),
      }),
  };
  if (withClassify) {
    decider.classifyCommitment = async (request, context) =>
      record('classifyCommitment', request, context, {
        ok: true,
        decision: { commitment: 'NONE', confidence: 0.9, agreement: 'single' },
        exchange: realExchange('commitment'),
      });
  }
  return { decider, calls, returned };
}

function makeObservationFor(label) {
  return makeObservation(
    [
      makeElement('t1', { label: 'Save changes' }),
      makeElement('t2', { label: 'Cancel' }),
      makeElement('t3', {
        label: 'Email address',
        role: 'textbox',
        kind: 'text_input',
        operations: ['FILL'],
      }),
      makeElement('t4', { label: 'More details', role: 'link', kind: 'link' }),
    ],
    { snapshotId: label }
  );
}

function makeExecuteRequest(n, { snapshotId = SCOPE.snapshotId, targetId = 't1', command } = {}) {
  return {
    requestId: `req_${String(n).padStart(12, '0')}`,
    scope: { ...SCOPE, snapshotId },
    command: command ?? {
      operation: 'CLICK',
      target: { sessionId: SCOPE.sessionId, snapshotId, targetId, signature: `sig:${targetId}` },
    },
    allowedOrigins: ['http://127.0.0.1'],
    timeoutMs: 8000,
    settle: { quietMs: 150, maxMs: 2000 },
  };
}

function makeFakeHost({ withLocation = false, withRelease = true, executeImpl, observation } = {}) {
  const calls = {
    capabilities: [],
    location: [],
    observe: [],
    execute: [],
    release: [],
    dispose: 0,
  };
  const returned = { capabilities: [], location: [], observe: [], execute: [], release: [] };
  const host = {
    capabilities: async (...args) => {
      calls.capabilities.push(args);
      const result = { ok: true, value: { hostKind: 'remote' } };
      returned.capabilities.push(result);
      return result;
    },
    observe: async (request, signal) => {
      calls.observe.push({ request, signal });
      const result = {
        ok: true,
        value: observation ?? makeObservation([makeElement('t1')]),
      };
      returned.observe.push(result);
      return result;
    },
    execute: async (request, signal) => {
      calls.execute.push({ request, signal });
      const n = calls.execute.length;
      const outcome = executeImpl
        ? await executeImpl(request, n, signal)
        : { requestId: request.requestId, status: 'applied', effect: 'applied', durationMs: 1 };
      returned.execute.push(outcome);
      return outcome;
    },
    dispose: async () => {
      calls.dispose += 1;
    },
  };
  if (withLocation) {
    host.location = async (...args) => {
      calls.location.push(args);
      const result = { ok: true, value: { url: 'http://127.0.0.1/', origin: 'http://127.0.0.1' } };
      returned.location.push(result);
      return result;
    };
  }
  if (withRelease) {
    host.release = async (...args) => {
      calls.release.push(args);
      returned.release.push(undefined);
    };
  }
  return { host, calls, returned };
}

const faultScenario = (inject, id = 'fault-selftest') => ({ id, kind: 'fault', inject });

// ---------------------------------------------------------------------------------------------
// Shape validators (mirroring the contract types)
// ---------------------------------------------------------------------------------------------

function assertExchange(exchange) {
  assert.equal(typeof exchange, 'object');
  assert.ok(['action', 'argument', 'commitment', 'completion'].includes(exchange.stage));
  assert.equal(typeof exchange.provider, 'string');
  assert.equal(exchange.attempts, exchange.attemptLog.length);
  assert.equal(typeof exchange.latencyMs, 'number');
  assert.equal(typeof exchange.requestBytes, 'number');
  assert.equal(typeof exchange.estimatedInputTokens, 'number');
  assert.equal(typeof exchange.goalVerified, 'boolean');
  assert.deepEqual(JSON.parse(JSON.stringify(exchange)), exchange);
}

function assertActionDecision(result) {
  assert.equal(result.ok, true);
  const { decision } = result;
  assert.ok(TASK_OPERATIONS.includes(decision.operation));
  assert.ok(['not_applicable', 'target', 'none_appropriate'].includes(decision.target.kind));
  for (const key of ['confidence', 'operationConfidence']) {
    assert.ok(decision[key] >= 0.5 && decision[key] <= 1, key);
  }
  if (decision.target.kind === 'not_applicable') {
    assert.equal(decision.targetConfidence, undefined);
  } else {
    assert.ok(decision.targetConfidence >= 0.5 && decision.targetConfidence <= 1);
    assert.equal(
      decision.confidence,
      Math.min(decision.operationConfidence, decision.targetConfidence)
    );
  }
  assertExchange(result.exchange);
}

const settleTimers = () => new Promise(resolve => setImmediate(resolve));

/** Index of every call whose result is not the exact object the real decider returned. */
async function deviations({ scenario, calls, makeRequest = () => makeActionRequest() }) {
  const fake = makeFakeDecider();
  const { decider } = applyInjection({ decider: fake.decider, scenario });
  const results = [];
  for (let i = 0; i < calls; i += 1) {
    results.push(await decider.chooseAction(makeRequest(i + 1), makeContext({ callIndex: i + 1 })));
  }
  const changed = results.map(result => !fake.returned.chooseAction.includes(result));
  return { changed, indexes: changed.flatMap((flag, i) => (flag ? [i + 1] : [])), fake };
}

// ---------------------------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------------------------

const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

function findChromium() {
  if (fs.existsSync(PREFERRED_CHROMIUM)) {
    return PREFERRED_CHROMIUM;
  }
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
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const pageHtml = loadId => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>faults selftest ${loadId}</title></head>
<body>
<main id="main">
  <p id="load">load ${loadId}</p>
  <ul id="siblings"><li id="keep">keep</li></ul>
  <button id="save" type="button" class="primary">Save changes</button>
  <button id="cancel" type="button">Cancel</button>
  <label for="email">Email address</label>
  <input id="email" name="email" type="text">
  <a id="more" href="/more">More details</a>
  <label for="plan">Plan</label>
  <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select>
</main>
<script>
  window.__loadId = ${loadId};
  window.__clicks = [];
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (button) { window.__clicks.push(button.id); }
  });
</script>
</body></html>`;

function startServer() {
  const state = { loads: 0 };
  const server = http.createServer((request, response) => {
    const pathname = String(request.url).split('?')[0];
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    state.loads += 1;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageHtml(state.loads));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        state,
        close: () => new Promise(done => server.close(() => done())),
        resetLoads: () => {
          state.loads = 0;
        },
      });
    });
  });
}

async function freshPage(context, server) {
  const page = await context.newPage();
  server.resetLoads();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  return page;
}

const hold = page =>
  page.evaluate(() => {
    window.__held = {
      main: document.getElementById('main'),
      keep: document.getElementById('keep'),
      save: document.getElementById('save'),
      cancel: document.getElementById('cancel'),
      email: document.getElementById('email'),
      more: document.getElementById('more'),
    };
    window.__saveHtml = document.getElementById('save').outerHTML;
  });

const heldConnected = page =>
  page.evaluate(() =>
    Object.fromEntries(Object.entries(window.__held).map(([key, node]) => [key, node.isConnected]))
  );

// ---------------------------------------------------------------------------------------------
// Checks: validation, pass-through, notes, recorder
// ---------------------------------------------------------------------------------------------

async function runValidationChecks() {
  await check('validation: every documented mode is accepted', () => {
    for (const mode of DECIDER_FAULT_MODES) {
      assert.equal(validateInjection({ decider: { mode, atDecision: 1 } }).ok, true, mode);
    }
    for (const mode of HOST_FAULT_MODES) {
      assert.equal(validateInjection({ host: { mode, atExecution: 1 } }).ok, true, mode);
    }
  });

  await check('validation: rejects unknown modes, bad counts and stray options', () => {
    const bad = [
      undefined,
      null,
      {},
      { decider: { mode: 'explode', atDecision: 1 } },
      { decider: { mode: 'prematureDone', atDecision: 0 } },
      { decider: { mode: 'prematureDone', atDecision: 1.5 } },
      { decider: { mode: 'prematureDone', atDecision: '1' } },
      { decider: { mode: 'prematureDone' } },
      { decider: { mode: 'prematureDone', atDecision: 1, ms: 5 } },
      { decider: { mode: 'slow', atDecision: 1, ms: -1 } },
      { decider: { mode: 'slow', atDecision: 1, ms: 'soon' } },
      { decider: { mode: 'throw', atDecision: 1, style: 'boom' } },
      { decider: { mode: 'slow', atDecision: 1, style: 'result' } },
      { decider: { mode: 'noneAppropriate', atDecision: 1, stage: 'commitment' } },
      { decider: { mode: 'slow', atDecision: 1, extra: true } },
      { decider: { mode: 'slow', atDecision: 1, stage: 'argument' } },
      { decider: { mode: 'invalidArgument', atDecision: 1, stage: 'argument' } },
      { decider: { mode: 'prematureDone', atDecision: 1 }, other: {} },
      {
        decider: { mode: 'prematureDone', atDecision: 1 },
        host: { mode: 'lostAfterCommit', atExecution: 0 },
      },
      { host: { mode: 'staleBeforeExecute', atExecution: 0 } },
      { host: { mode: 'prematureDone', atExecution: 1 } },
      { host: { mode: 'lostAfterCommit', atExecution: 1, ms: 5 } },
      { host: { mode: 'contextDestroyed', atExecution: 1, timing: 'later' } },
      { host: { mode: 'slowObserve', atExecution: 1, timing: 'before' } },
      { decider: { mode: 'slowObserve', atDecision: 1 } },
      { other: { mode: 'slow' } },
    ];
    for (const inject of bad) {
      assert.equal(validateInjection(inject).ok, false, JSON.stringify(inject));
    }
  });

  await check('validation: delays are bounded (accepted at the limit, rejected above it)', () => {
    const slow = ms => validateInjection({ decider: { mode: 'slow', atDecision: 1, ms } }).ok;
    const observe = ms =>
      validateInjection({ host: { mode: 'slowObserve', atExecution: 1, ms } }).ok;
    for (const accepts of [slow, observe]) {
      assert.equal(accepts(0), true);
      assert.equal(accepts(600000), true, 'the documented limit itself');
      assert.equal(accepts(600001), false);
      assert.equal(accepts(Number.MAX_SAFE_INTEGER), false);
      assert.equal(accepts(Number.POSITIVE_INFINITY), false);
      assert.equal(accepts(Number.NaN), false);
      assert.equal(accepts(-0.5), false);
    }
  });

  await check(
    'validation: applyInjection throws on a bad fault scenario instead of injecting nothing',
    () => {
      const fake = makeFakeDecider();
      assert.throws(
        () => applyInjection({ decider: fake.decider, scenario: faultScenario({}) }),
        /faults: scenario fault-selftest/
      );
      assert.throws(
        () =>
          applyInjection({
            decider: fake.decider,
            scenario: faultScenario({ decider: { mode: 'nope', atDecision: 1 } }),
          }),
        /mode must be one of/
      );
    }
  );

  await check('validation: missing decider, host or page for a configured block throws', () => {
    const fake = makeFakeDecider();
    const fakeHost = makeFakeHost();
    assert.throws(() =>
      applyInjection({
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      })
    );
    assert.throws(() =>
      applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
      })
    );
    assert.throws(
      () =>
        applyInjection({
          host: fakeHost.host,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        }),
      /needs the Playwright page/
    );
    assert.throws(
      () =>
        applyInjection({
          host: fakeHost.host,
          page: {},
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        }),
      /needs the Playwright page/
    );
  });

  await check('validation: a decider block and a host block together are accepted', () => {
    const both = validateInjection({
      decider: { mode: 'slow', atDecision: 2, ms: 10 },
      host: { mode: 'contextDestroyed', atExecution: 3, timing: 'before' },
    });
    assert.deepEqual(both, { ok: true, errors: [] });
  });

  await check('validation: a decider or host missing a method is refused at apply time', () => {
    const fake = makeFakeDecider();
    for (const method of ['chooseAction', 'chooseArgument', 'verifyCompletion']) {
      const partial = { ...fake.decider };
      delete partial[method];
      assert.throws(
        () =>
          applyInjection({
            decider: partial,
            scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
          }),
        /needs a TaskDecider/,
        method
      );
    }
    const fakeHost = makeFakeHost();
    for (const method of ['capabilities', 'observe', 'execute', 'dispose']) {
      const partial = { ...fakeHost.host };
      delete partial[method];
      assert.throws(
        () =>
          applyInjection({
            host: partial,
            scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
          }),
        /needs a TaskHost/,
        method
      );
    }
  });

  await check('configured notes record the defaults that apply when an option is left out', () => {
    const configured = inject => {
      const out = applyInjection({
        decider: makeFakeDecider().decider,
        host: makeFakeHost().host,
        page: {
          evaluate() {},
          goto() {},
          url() {},
          on() {},
          off() {},
        },
        scenario: faultScenario(inject),
      });
      return out.notes.find(note => note.event === 'configured');
    };
    assert.equal(configured({ decider: { mode: 'slow', atDecision: 1 } }).ms, 30000);
    assert.equal(configured({ decider: { mode: 'slow', atDecision: 1, ms: 7 } }).ms, 7);
    assert.equal(configured({ decider: { mode: 'throw', atDecision: 1 } }).style, 'reject');
    assert.equal(
      configured({ decider: { mode: 'noneAppropriate', atDecision: 1 } }).stage,
      'action'
    );
    assert.equal(
      configured({ decider: { mode: 'invalidArgument', atDecision: 1 } }).stage,
      'argument'
    );
    assert.equal(configured({ host: { mode: 'slowObserve', atExecution: 1 } }).ms, 3000);
    assert.equal(
      configured({ host: { mode: 'contextDestroyed', atExecution: 1 } }).timing,
      'during'
    );
  });

  await check('live scenario: decider and host come back untouched with no notes', () => {
    const fake = makeFakeDecider();
    const fakeHost = makeFakeHost();
    const out = applyInjection({
      decider: fake.decider,
      host: fakeHost.host,
      scenario: { id: 'live-one', kind: 'live' },
    });
    assert.equal(out.decider, fake.decider);
    assert.equal(out.host, fakeHost.host);
    assert.deepEqual(out.notes, []);
    assert.deepEqual(out.report().fired, []);
  });

  await check(
    'live scenario carrying an inject block is refused (injection never leaks into live runs)',
    () => {
      const fake = makeFakeDecider();
      assert.throws(
        () =>
          applyInjection({
            decider: fake.decider,
            scenario: {
              id: 'live-two',
              kind: 'live',
              inject: { decider: { mode: 'prematureDone', atDecision: 1 } },
            },
          }),
        /never applies to a live scenario/
      );
    }
  );

  await check(
    'control: the deviation measurement sees nothing for a live scenario and something for a fault',
    async () => {
      const live = await deviations({ scenario: { id: 'live', kind: 'live' }, calls: 4 });
      assert.deepEqual(live.indexes, []);
      const fault = await deviations({
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 2 } }),
        calls: 4,
      });
      assert.deepEqual(fault.indexes, [2]);
    }
  );
}

async function runPassThroughChecks() {
  await check(
    'decider wrapper keeps classifyCommitment absent when the real decider has none',
    () => {
      const fake = makeFakeDecider({ withClassify: false });
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      assert.equal('classifyCommitment' in decider, false);
    }
  );

  await check(
    'decider wrapper forwards classifyCommitment, verifyCompletion and chooseArgument untouched',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      await decider.chooseAction(makeActionRequest(), makeContext());
      const ctx = makeContext();
      const argRequest = makeArgumentRequest();
      const classifyRequest = { goal: GOAL };
      const verifyRequest = { goal: GOAL };
      const a = await decider.chooseArgument(argRequest, ctx);
      const c = await decider.classifyCommitment(classifyRequest, ctx);
      const v = await decider.verifyCompletion(verifyRequest, ctx);
      assert.equal(a, fake.returned.chooseArgument[0]);
      assert.equal(c, fake.returned.classifyCommitment[0]);
      assert.equal(v, fake.returned.verifyCompletion[0]);
      assert.equal(fake.calls.chooseArgument[0].request, argRequest);
      assert.equal(fake.calls.classifyCommitment[0].request, classifyRequest);
      assert.equal(fake.calls.verifyCompletion[0].context, ctx);
    }
  );

  await check(
    'decider pass-through hands the real decider the very request and context objects',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 5 } }),
      });
      const request = makeActionRequest();
      const context = makeContext();
      await decider.chooseAction(request, context);
      assert.equal(fake.calls.chooseAction[0].request, request);
      assert.equal(fake.calls.chooseAction[0].context, context);
    }
  );

  await check('a decider-only injection leaves the host object itself untouched', () => {
    const fake = makeFakeDecider();
    const fakeHost = makeFakeHost();
    const out = applyInjection({
      decider: fake.decider,
      host: fakeHost.host,
      scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
    });
    assert.equal(out.host, fakeHost.host);
    assert.notEqual(out.decider, fake.decider);
  });

  await check('host wrapper keeps location and release absent when the real host has none', () => {
    const fakeHost = makeFakeHost({ withLocation: false, withRelease: false });
    const { host } = applyInjection({
      host: fakeHost.host,
      scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
    });
    assert.equal('location' in host, false);
    assert.equal('release' in host, false);
  });

  await check(
    'host wrapper forwards capabilities, location, release and dispose with their arguments',
    async () => {
      const fakeHost = makeFakeHost({ withLocation: true, withRelease: true });
      const { host } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 9 } }),
      });
      const signal = new AbortController().signal;
      const caps = await host.capabilities(signal);
      const loc = await host.location(signal);
      await host.release('ses_x', signal);
      await host.dispose();
      assert.equal(caps, fakeHost.returned.capabilities[0]);
      assert.equal(loc, fakeHost.returned.location[0]);
      assert.deepEqual(fakeHost.calls.capabilities[0], [signal]);
      assert.deepEqual(fakeHost.calls.release[0], ['ses_x', signal]);
      assert.equal(fakeHost.calls.dispose, 1);
    }
  );

  await check(
    'host pass-through returns the exact outcome object and forwards request and signal',
    async () => {
      const fakeHost = makeFakeHost();
      const { host } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 3 } }),
      });
      const request = makeExecuteRequest(1);
      const signal = new AbortController().signal;
      const outcome = await host.execute(request, signal);
      assert.equal(outcome, fakeHost.returned.execute[0]);
      assert.equal(fakeHost.calls.execute[0].request, request);
      assert.equal(fakeHost.calls.execute[0].signal, signal);
    }
  );
}

async function runRecorderChecks() {
  await check(
    'notes: a configured note per block, then a fired note; JSON-safe and labelled not live',
    async () => {
      const fake = makeFakeDecider();
      const out = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 2 } }, 'notes-one'),
      });
      assert.equal(out.notes.length, 1);
      assert.equal(out.notes[0].event, 'configured');
      await out.decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(out.notes.length, 1);
      await out.decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(out.notes.length, 2);
      const fired = out.notes[1];
      assert.equal(fired.event, 'fired');
      assert.equal(fired.mode, 'prematureDone');
      assert.equal(fired.atDecision, 2);
      assert.equal(fired.decision, 2);
      assert.equal(fired.label, FAULT_LABEL);
      assert.equal(fired.live, false);
      assert.ok(Number.isFinite(fired.elapsedMs) && fired.elapsedMs >= 0);
      assert.ok(fired.elapsedMs >= out.notes[0].elapsedMs);
      assert.equal(fired.scenarioId, 'notes-one');
      assert.match(out.notes[0].description, /not live verification/);
      assert.deepEqual(JSON.parse(JSON.stringify(out.notes)), out.notes);
    }
  );

  await check(
    'recorder: function, record(), note() and push() receivers all get every note',
    () => {
      const seen = { fn: [], record: [], note: [], push: [] };
      const receivers = {
        fn: entry => seen.fn.push(entry),
        record: { record: entry => seen.record.push(entry) },
        note: { note: entry => seen.note.push(entry) },
        push: { push: entry => seen.push.push(entry) },
      };
      for (const [key, recorder] of Object.entries(receivers)) {
        const fake = makeFakeDecider();
        applyInjection({
          decider: fake.decider,
          recorder,
          scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
        });
        assert.equal(seen[key].length, 1, key);
        assert.equal(seen[key][0].event, 'configured', key);
      }
    }
  );

  await check(
    'recorder: entries are copies, and a throwing recorder never changes the run',
    async () => {
      const seen = [];
      const fake = makeFakeDecider();
      const throwing = applyInjection({
        decider: fake.decider,
        recorder: () => {
          throw new Error('recorder broke');
        },
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      const result = await throwing.decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(result.decision.operation, 'DONE');
      const copying = applyInjection({
        decider: makeFakeDecider().decider,
        recorder: entry => seen.push(entry),
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      seen[0].mode = 'tampered';
      assert.equal(copying.notes[0].mode, 'prematureDone');
    }
  );

  await check(
    'recorder: an async recorder that rejects neither changes the run nor ends the process',
    async () => {
      const unhandled = [];
      const onUnhandled = reason => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const fake = makeFakeDecider();
        const out = applyInjection({
          decider: fake.decider,
          recorder: async () => {
            throw new Error('async recorder broke');
          },
          scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
        });
        const result = await out.decider.chooseAction(makeActionRequest(), makeContext());
        await settleTimers();
        await sleepFor(30);
        assert.equal(result.decision.operation, 'DONE');
        assert.equal(out.notes.length, 2);
        assert.deepEqual(unhandled, []);
        Promise.reject(new Error('control rejection'));
        await settleTimers();
        await sleepFor(30);
        assert.equal(unhandled.length, 1, 'control: an unhandled rejection must be visible here');
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    }
  );

  await check(
    'recorder: absent recorder is fine and report() lists configured, fired and unfired',
    async () => {
      const fake = makeFakeDecider();
      const out = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'throw', atDecision: 2, style: 'result' } }),
      });
      assert.deepEqual(out.report().unfired, [{ layer: 'decider', mode: 'throw', atDecision: 2 }]);
      await out.decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(out.report().fired.length, 0);
      await out.decider.chooseAction(makeActionRequest(), makeContext());
      const report = out.report();
      assert.deepEqual(report.fired, [{ layer: 'decider', mode: 'throw', atDecision: 2 }]);
      assert.deepEqual(report.unfired, []);
      assert.deepEqual(report.configured, report.fired);
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Checks: decider modes
// ---------------------------------------------------------------------------------------------

async function runDeciderChecks() {
  await check('prematureDone: fires exactly at decision 3, not before and not after', async () => {
    const out = await deviations({
      scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 3 } }),
      calls: 6,
    });
    assert.deepEqual(out.indexes, [3]);
    assert.equal(out.fake.calls.chooseAction.length, 5);
  });

  await check(
    'prematureDone: the replaced answer is DONE with a complete decision and exchange shape',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      const result = await decider.chooseAction(makeActionRequest(), makeContext());
      assertActionDecision(result);
      assert.equal(result.decision.operation, 'DONE');
      assert.deepEqual(result.decision.target, { kind: 'not_applicable' });
      assert.equal(result.exchange.provider, 'fault-injection');
      assert.equal(result.exchange.goalVerified, true);
      assert.equal(result.exchange.stage, 'action');
      assert.equal(fake.calls.chooseAction.length, 0);
    }
  );

  await check(
    'prematureDone: an exchange never claims the goal was verified when request and context disagree',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      const result = await decider.chooseAction(
        makeActionRequest(),
        makeContext({ goal: 'another' })
      );
      assert.equal(result.exchange.goalVerified, false);
    }
  );

  await check(
    'prematureDone: the other three stage methods are not affected around the injection',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'prematureDone', atDecision: 1 } }),
      });
      await decider.chooseAction(makeActionRequest(), makeContext());
      const v = await decider.verifyCompletion({ goal: GOAL }, makeContext());
      const a = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.equal(v.decision.verdict, 'NOT_SATISFIED');
      assert.equal(a.decision.candidateId, 'c1');
    }
  );

  await check(
    'invalidTarget: fires only at its decision and names an unoffered target of an offered target operation',
    async () => {
      const request = makeActionRequest({
        elements: [makeElement('t1'), makeElement('t2'), makeElement('t3')],
        offers: {
          operations: ['CLICK', 'DONE', 'BLOCKED'],
          targets: { CLICK: ['t1', 't2'] },
        },
      });
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'invalidTarget', atDecision: 2 } }),
      });
      const first = await decider.chooseAction(request, makeContext());
      const second = await decider.chooseAction(request, makeContext());
      const third = await decider.chooseAction(request, makeContext());
      assert.equal(first, fake.returned.chooseAction[0]);
      assert.equal(third, fake.returned.chooseAction[1]);
      assertActionDecision(second);
      assert.equal(second.decision.operation, 'CLICK');
      assert.equal(second.decision.target.kind, 'target');
      assert.equal(second.decision.target.id, 't3');
      assert.ok(!request.offers.targets.CLICK.includes(second.decision.target.id));
    }
  );

  await check(
    'invalidTarget: with every observed element offered the id is fabricated and absent from the observation',
    async () => {
      const request = makeActionRequest();
      const { decider, notes } = applyInjection({
        decider: makeFakeDecider().decider,
        scenario: faultScenario({ decider: { mode: 'invalidTarget', atDecision: 1 } }),
      });
      const result = await decider.chooseAction(request, makeContext());
      const id = result.decision.target.id;
      assert.match(id, /^t\d+$/);
      assert.ok(!request.observation.elements.some(element => element.id === id));
      assert.ok(!request.offers.targets.CLICK.includes(id));
      assert.equal(notes.at(-1).targetKind, 'fabricated');
      assert.equal(notes.at(-1).targetId, id);
    }
  );

  await check(
    'invalidTarget: survives a request with no offers and no observation (no throw, a target operation)',
    async () => {
      const { decider } = applyInjection({
        decider: makeFakeDecider().decider,
        scenario: faultScenario({ decider: { mode: 'invalidTarget', atDecision: 1 } }),
      });
      const result = await decider.chooseAction({ goal: GOAL }, makeContext());
      assert.equal(result.ok, true);
      assert.ok(TARGET_OPERATIONS.includes(result.decision.operation));
      assert.equal(result.decision.target.kind, 'target');
    }
  );

  await check(
    'noneAppropriate (action): fires at its decision with the none_appropriate target choice',
    async () => {
      const out = await deviations({
        scenario: faultScenario({ decider: { mode: 'noneAppropriate', atDecision: 2 } }),
        calls: 4,
      });
      assert.deepEqual(out.indexes, [2]);
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'noneAppropriate', atDecision: 1 } }),
      });
      const result = await decider.chooseAction(makeActionRequest(), makeContext());
      assertActionDecision(result);
      assert.deepEqual(result.decision.target, { kind: 'none_appropriate' });
      assert.ok(TARGET_OPERATIONS.includes(result.decision.operation));
    }
  );

  await check(
    'noneAppropriate (stage argument): the first chooseArgument at or after the decision answers none_appropriate, once',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({
          decider: { mode: 'noneAppropriate', atDecision: 2, stage: 'argument' },
        }),
      });
      await decider.chooseAction(makeActionRequest(), makeContext());
      const early = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.equal(early, fake.returned.chooseArgument[0]);
      await decider.chooseAction(makeActionRequest(), makeContext());
      const poisoned = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.equal(poisoned.ok, true);
      assert.equal(poisoned.decision.kind, 'none_appropriate');
      assert.ok(poisoned.decision.confidence >= 0.6);
      assertExchange(poisoned.exchange);
      const later = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.equal(later, fake.returned.chooseArgument[1]);
      assert.equal(fake.calls.chooseArgument.length, 2);
    }
  );

  await check(
    'invalidArgument: argument questions before the armed decision pass through unmodified',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'invalidArgument', atDecision: 3 } }),
      });
      for (let i = 1; i <= 2; i += 1) {
        await decider.chooseAction(makeActionRequest(), makeContext());
        const result = await decider.chooseArgument(makeArgumentRequest(), makeContext());
        assert.equal(result, fake.returned.chooseArgument[i - 1]);
      }
    }
  );

  await check(
    'invalidArgument: the argument question of the armed decision names a candidate that was not offered',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'invalidArgument', atDecision: 2 } }),
      });
      await decider.chooseAction(makeActionRequest(), makeContext());
      await decider.chooseArgument(makeArgumentRequest(), makeContext());
      await decider.chooseAction(makeActionRequest(), makeContext());
      const request = makeArgumentRequest(['c1', 'c2', 'c3']);
      const result = await decider.chooseArgument(request, makeContext());
      assert.equal(result.ok, true);
      assert.equal(result.decision.kind, 'candidate');
      assert.ok(
        !request.candidates.some(candidate => candidate.id === result.decision.candidateId)
      );
      assert.match(result.decision.candidateId, /^c\d+$/);
      assert.ok(result.decision.confidence >= 0.6);
      assertExchange(result.exchange);
    }
  );

  await check(
    'invalidArgument: fires exactly once; later argument questions pass through',
    async () => {
      const fake = makeFakeDecider();
      const { decider, notes } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'invalidArgument', atDecision: 1 } }),
      });
      await decider.chooseAction(makeActionRequest(), makeContext());
      const first = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      const second = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.notEqual(first, fake.returned.chooseArgument[0]);
      assert.equal(second, fake.returned.chooseArgument[0]);
      assert.equal(notes.filter(note => note.event === 'fired').length, 1);
    }
  );

  await check(
    'invalidArgument: a decision without an argument stage leaves it armed; the note records both numbers',
    async () => {
      const fake = makeFakeDecider();
      const { decider, notes } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'invalidArgument', atDecision: 1 } }),
      });
      await decider.chooseAction(makeActionRequest(), makeContext());
      await decider.chooseAction(makeActionRequest(), makeContext());
      await decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(notes.filter(note => note.event === 'fired').length, 0);
      const result = await decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.equal(result.decision.kind, 'candidate');
      const fired = notes.at(-1);
      assert.equal(fired.armedAtDecision, 1);
      assert.equal(fired.firedAtDecision, 3);
    }
  );

  await check(
    'every synthetic answer carries the exchange stage of the question it answers',
    async () => {
      const stageOf = async (config, ask) => {
        const { decider } = applyInjection({
          decider: makeFakeDecider().decider,
          scenario: faultScenario({ decider: config }),
        });
        const result = await ask(decider);
        assert.equal(result.ok, true, JSON.stringify(config));
        return result.exchange.stage;
      };
      const action = decider => decider.chooseAction(makeActionRequest(), makeContext());
      const argument = decider => decider.chooseArgument(makeArgumentRequest(), makeContext());
      assert.equal(await stageOf({ mode: 'prematureDone', atDecision: 1 }, action), 'action');
      assert.equal(await stageOf({ mode: 'invalidTarget', atDecision: 1 }, action), 'action');
      assert.equal(await stageOf({ mode: 'noneAppropriate', atDecision: 1 }, action), 'action');
      assert.equal(await stageOf({ mode: 'invalidArgument', atDecision: 1 }, argument), 'argument');
      assert.equal(
        await stageOf({ mode: 'noneAppropriate', atDecision: 1, stage: 'argument' }, argument),
        'argument'
      );
    }
  );

  await check(
    'throw (reject): chooseAction #2 rejects with a fixed message; calls 1 and 3 pass through',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'throw', atDecision: 2 } }),
      });
      const first = await decider.chooseAction(makeActionRequest(), makeContext());
      await assert.rejects(
        () => decider.chooseAction(makeActionRequest(), makeContext()),
        error =>
          error instanceof Error && /^fault injection: scripted decider throw/.test(error.message)
      );
      const third = await decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(first, fake.returned.chooseAction[0]);
      assert.equal(third, fake.returned.chooseAction[1]);
      assert.equal(fake.calls.chooseAction.length, 2);
    }
  );

  await check(
    'throw (result style): an error result in the TaskDeciderError shape, no rejection',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'throw', atDecision: 1, style: 'result' } }),
      });
      const result = await decider.chooseAction(makeActionRequest(), makeContext());
      assert.equal(result.ok, false);
      assert.ok(DECIDER_ERROR_CODES.includes(result.error.code));
      assert.equal(typeof result.error.message, 'string');
      assert.equal(typeof result.error.retryable, 'boolean');
      assert.equal(fake.calls.chooseAction.length, 0);
    }
  );

  await check(
    'no decider mode other than throw (reject style) ever rejects, even on malformed requests',
    async () => {
      const modes = [
        { mode: 'prematureDone', atDecision: 1 },
        { mode: 'invalidTarget', atDecision: 1 },
        { mode: 'invalidArgument', atDecision: 1 },
        { mode: 'noneAppropriate', atDecision: 1 },
        { mode: 'noneAppropriate', atDecision: 1, stage: 'argument' },
        { mode: 'throw', atDecision: 1, style: 'result' },
      ];
      for (const config of modes) {
        const { decider } = applyInjection({
          decider: makeFakeDecider().decider,
          scenario: faultScenario({ decider: config }),
        });
        const action = await decider.chooseAction({}, undefined);
        const argument = await decider.chooseArgument({}, undefined);
        assert.equal(typeof action.ok, 'boolean', config.mode);
        assert.equal(typeof argument.ok, 'boolean', config.mode);
      }
    }
  );

  await check(
    'slow: only decision 2 is delayed by at least ms, then the real decider answers (same object)',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'slow', atDecision: 2, ms: 160 } }),
      });
      const timed = async () => {
        const start = Date.now();
        const result = await decider.chooseAction(makeActionRequest(), makeContext());
        return { result, took: Date.now() - start };
      };
      const first = await timed();
      const second = await timed();
      const third = await timed();
      assert.ok(first.took < 100, `decision 1 took ${first.took}ms`);
      assert.ok(second.took >= 150, `decision 2 took ${second.took}ms`);
      assert.ok(third.took < 100, `decision 3 took ${third.took}ms`);
      assert.equal(second.result, fake.returned.chooseAction[1]);
      assert.equal(fake.calls.chooseAction.length, 3);
    }
  );

  await check(
    'slow: an abort during the delay returns the CANCELLED result early and never asks the real decider',
    async () => {
      const fake = makeFakeDecider();
      const { decider, notes } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'slow', atDecision: 1, ms: 5000 } }),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 40);
      const start = Date.now();
      const result = await decider.chooseAction(
        makeActionRequest(),
        makeContext({ signal: controller.signal })
      );
      assert.ok(Date.now() - start < 1000);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'CANCELLED');
      assert.equal(result.error.retryable, false);
      assert.equal(fake.calls.chooseAction.length, 0);
      assert.equal(notes.at(-1).outcome, 'cancelled_during_delay');
    }
  );

  await check('slow: an already aborted signal is CANCELLED at once without waiting', async () => {
    const fake = makeFakeDecider();
    const { decider } = applyInjection({
      decider: fake.decider,
      scenario: faultScenario({ decider: { mode: 'slow', atDecision: 1, ms: 5000 } }),
    });
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await decider.chooseAction(
      makeActionRequest(),
      makeContext({ signal: controller.signal })
    );
    assert.ok(Date.now() - start < 500);
    assert.equal(result.error.code, 'CANCELLED');
    assert.equal(fake.calls.chooseAction.length, 0);
  });

  await check(
    'slow: neither a timer nor an abort listener is left behind (abort path and elapsed path)',
    async () => {
      const timers = () =>
        process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
      const baseline = timers();
      const control = setTimeout(() => {}, 4000);
      assert.equal(
        timers(),
        baseline + 1,
        'control: a live timer must be visible to the measurement'
      );
      clearTimeout(control);

      const abortRun = new AbortController();
      const { decider: abortable } = applyInjection({
        decider: makeFakeDecider().decider,
        scenario: faultScenario({ decider: { mode: 'slow', atDecision: 1, ms: 5000 } }),
      });
      const pending = abortable.chooseAction(
        makeActionRequest(),
        makeContext({ signal: abortRun.signal })
      );
      await settleTimers();
      abortRun.abort();
      await pending;
      assert.equal(timers(), baseline, 'abort path left a timer');

      const elapsedRun = new AbortController();
      const { decider: elapsing } = applyInjection({
        decider: makeFakeDecider().decider,
        scenario: faultScenario({ decider: { mode: 'slow', atDecision: 1, ms: 30 } }),
      });
      await elapsing.chooseAction(makeActionRequest(), makeContext({ signal: elapsedRun.signal }));
      assert.equal(
        getEventListeners(elapsedRun.signal, 'abort').length,
        0,
        'elapsed path left a listener'
      );
      assert.equal(timers(), baseline, 'elapsed path left a timer');
    }
  );

  await check(
    'slow: without a signal the delay still elapses and the real decider answers',
    async () => {
      const fake = makeFakeDecider();
      const { decider } = applyInjection({
        decider: fake.decider,
        scenario: faultScenario({ decider: { mode: 'slow', atDecision: 1, ms: 30 } }),
      });
      const result = await decider.chooseAction(makeActionRequest(), { goal: GOAL });
      assert.equal(result, fake.returned.chooseAction[0]);
    }
  );

  await check(
    'stage isolation: an action-stage mode never touches argument questions, an argument-stage mode never touches action questions',
    async () => {
      const actionStage = [
        { mode: 'prematureDone', atDecision: 1 },
        { mode: 'invalidTarget', atDecision: 1 },
        { mode: 'noneAppropriate', atDecision: 1 },
        { mode: 'noneAppropriate', atDecision: 1, stage: 'action' },
        { mode: 'slow', atDecision: 1, ms: 0 },
        { mode: 'throw', atDecision: 1, style: 'result' },
        { mode: 'throw', atDecision: 1 },
      ];
      for (const config of actionStage) {
        const fake = makeFakeDecider();
        const { decider, notes } = applyInjection({
          decider: fake.decider,
          scenario: faultScenario({ decider: config }),
        });
        await decider.chooseAction(makeActionRequest(), makeContext()).catch(() => {});
        assert.equal(
          notes.filter(note => note.event === 'fired').length,
          1,
          JSON.stringify(config)
        );
        const first = await decider.chooseArgument(makeArgumentRequest(), makeContext());
        const second = await decider.chooseArgument(makeArgumentRequest(), makeContext());
        assert.deepEqual([first, second], fake.returned.chooseArgument, JSON.stringify(config));
        assert.equal(first, fake.returned.chooseArgument[0], JSON.stringify(config));
        assert.equal(
          notes.filter(note => note.event === 'fired').length,
          1,
          JSON.stringify(config)
        );
      }
      const argumentStage = [
        { mode: 'invalidArgument', atDecision: 1 },
        { mode: 'noneAppropriate', atDecision: 1, stage: 'argument' },
      ];
      for (const config of argumentStage) {
        const fake = makeFakeDecider();
        const { decider, notes } = applyInjection({
          decider: fake.decider,
          scenario: faultScenario({ decider: config }),
        });
        const actions = [];
        for (let i = 0; i < 3; i += 1) {
          actions.push(await decider.chooseAction(makeActionRequest(), makeContext()));
        }
        assert.deepEqual(actions, fake.returned.chooseAction, JSON.stringify(config));
        actions.forEach((result, i) =>
          assert.equal(result, fake.returned.chooseAction[i], JSON.stringify(config))
        );
        assert.equal(
          notes.filter(note => note.event === 'fired').length,
          0,
          JSON.stringify(config)
        );
      }
    }
  );

  await check(
    'every decider mode fires exactly once at its configured count over 5 calls (control: count 9 never fires)',
    async () => {
      const fired = async config => {
        const out = await deviations({ scenario: faultScenario({ decider: config }), calls: 5 });
        return out.indexes;
      };
      assert.deepEqual(await fired({ mode: 'prematureDone', atDecision: 4 }), [4]);
      assert.deepEqual(await fired({ mode: 'invalidTarget', atDecision: 5 }), [5]);
      assert.deepEqual(await fired({ mode: 'noneAppropriate', atDecision: 1 }), [1]);
      assert.deepEqual(await fired({ mode: 'throw', atDecision: 3, style: 'result' }), [3]);
      assert.deepEqual(await fired({ mode: 'slow', atDecision: 2, ms: 0 }), []);
      assert.deepEqual(await fired({ mode: 'prematureDone', atDecision: 9 }), []);
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Checks: host modes without a browser
// ---------------------------------------------------------------------------------------------

async function runHostChecks() {
  await check(
    'lostAfterCommit: the real execute runs once with the same request, the outcome is uncertain/DOCUMENT_LOST',
    async () => {
      const fakeHost = makeFakeHost();
      const { host } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 2 } }),
      });
      const r1 = makeExecuteRequest(1);
      const r2 = makeExecuteRequest(2);
      await host.execute(r1);
      const outcome = await host.execute(r2);
      assert.equal(fakeHost.calls.execute.length, 2);
      assert.equal(fakeHost.calls.execute[1].request, r2);
      assert.equal(outcome.requestId, r2.requestId);
      assert.equal(outcome.status, 'uncertain');
      assert.equal(outcome.effect, 'uncertain');
      assert.equal(outcome.code, 'DOCUMENT_LOST');
      assert.equal(typeof outcome.message, 'string');
      assert.equal(typeof outcome.durationMs, 'number');
      assert.notEqual(outcome, fakeHost.returned.execute[1]);
    }
  );

  await check('lostAfterCommit: executions 1 and 3 return the real outcome objects', async () => {
    const fakeHost = makeFakeHost();
    const { host } = applyInjection({
      host: fakeHost.host,
      scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 2 } }),
    });
    const o1 = await host.execute(makeExecuteRequest(1));
    await host.execute(makeExecuteRequest(2));
    const o3 = await host.execute(makeExecuteRequest(3));
    assert.equal(o1, fakeHost.returned.execute[0]);
    assert.equal(o3, fakeHost.returned.execute[2]);
  });

  await check(
    'lostAfterCommit and timeoutAfterCommit: the reported pair is a valid TaskExecutionOutcome pair',
    async () => {
      for (const mode of ['lostAfterCommit', 'timeoutAfterCommit']) {
        const fakeHost = makeFakeHost();
        const { host } = applyInjection({
          host: fakeHost.host,
          scenario: faultScenario({ host: { mode, atExecution: 1 } }),
        });
        const outcome = await host.execute(makeExecuteRequest(1));
        assert.ok(VALID_OUTCOME_PAIRS[outcome.status].includes(outcome.effect), mode);
        assert.deepEqual(JSON.parse(JSON.stringify(outcome)), outcome);
      }
    }
  );

  await check(
    'lostAfterCommit: the signal reaches the real execute and an aborted signal does not change the mapping',
    async () => {
      const fakeHost = makeFakeHost();
      const { host } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
      });
      const controller = new AbortController();
      controller.abort();
      const request = makeExecuteRequest(1);
      const outcome = await host.execute(request, controller.signal);
      assert.equal(fakeHost.calls.execute[0].signal, controller.signal);
      assert.equal(outcome.status, 'uncertain');
    }
  );

  await check(
    'a decider block and a host block combine: independent counters, two configured and two fired notes',
    async () => {
      const fake = makeFakeDecider();
      const fakeHost = makeFakeHost();
      const recorded = [];
      const out = applyInjection({
        decider: fake.decider,
        host: fakeHost.host,
        recorder: entry => recorded.push(entry),
        scenario: faultScenario({
          decider: { mode: 'prematureDone', atDecision: 2 },
          host: { mode: 'lostAfterCommit', atExecution: 1 },
        }),
      });
      assert.equal(out.notes.filter(note => note.event === 'configured').length, 2);
      await out.decider.chooseAction(makeActionRequest(), makeContext());
      const lost = await out.host.execute(makeExecuteRequest(1));
      const done = await out.decider.chooseAction(makeActionRequest(), makeContext());
      const normal = await out.host.execute(makeExecuteRequest(2));
      assert.equal(lost.status, 'uncertain');
      assert.equal(done.decision.operation, 'DONE');
      assert.equal(normal, fakeHost.returned.execute[1]);
      assert.deepEqual(
        out.notes.filter(note => note.event === 'fired').map(note => `${note.layer}:${note.mode}`),
        ['host:lostAfterCommit', 'decider:prematureDone']
      );
      assert.deepEqual(recorded, out.notes);
      assert.deepEqual(out.report().unfired, []);
    }
  );

  await check('report: a host injection that was never reached is listed as unfired', async () => {
    const fakeHost = makeFakeHost();
    const { host, report } = applyInjection({
      host: fakeHost.host,
      scenario: faultScenario({ host: { mode: 'timeoutAfterCommit', atExecution: 3 } }),
    });
    await host.execute(makeExecuteRequest(1));
    await host.execute(makeExecuteRequest(2));
    assert.deepEqual(report().unfired, [
      { layer: 'host', mode: 'timeoutAfterCommit', atExecution: 3 },
    ]);
    await host.execute(makeExecuteRequest(3));
    assert.deepEqual(report().unfired, []);
  });

  await check(
    'timeoutAfterCommit: uncertain/EXECUTION_TIMEOUT after the command really ran, never run a second time',
    async () => {
      const fakeHost = makeFakeHost();
      const { host, notes } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'timeoutAfterCommit', atExecution: 1 } }),
      });
      const outcome = await host.execute(makeExecuteRequest(1));
      assert.equal(outcome.status, 'uncertain');
      assert.equal(outcome.effect, 'uncertain');
      assert.equal(outcome.code, 'EXECUTION_TIMEOUT');
      assert.equal(fakeHost.calls.execute.length, 1);
      const fired = notes.at(-1);
      assert.equal(fired.realStatus, 'applied');
      assert.equal(fired.realEffect, 'applied');
      assert.deepEqual(fired.reported, {
        status: 'uncertain',
        effect: 'uncertain',
        code: 'EXECUTION_TIMEOUT',
      });
    }
  );

  await check(
    'lostAfterCommit: a real execute that rejects (contract violation) is still reported uncertain and noted',
    async () => {
      const fakeHost = makeFakeHost({
        executeImpl: async () => {
          throw new Error('host broke');
        },
      });
      const { host, notes } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
      });
      const outcome = await host.execute(makeExecuteRequest(1));
      assert.equal(outcome.status, 'uncertain');
      assert.equal(notes.at(-1).realRejected, true);
    }
  );

  await check(
    'slowObserve: only the first observe after execution 2 is delayed; earlier and later observes are not',
    async () => {
      const fakeHost = makeFakeHost();
      const { host, notes } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'slowObserve', atExecution: 2, ms: 160 } }),
      });
      const timed = async () => {
        const start = Date.now();
        const result = await host.observe({ sessionId: SCOPE.sessionId });
        return { result, took: Date.now() - start };
      };
      const t0 = await timed();
      await host.execute(makeExecuteRequest(1));
      const t1 = await timed();
      await host.execute(makeExecuteRequest(2));
      const t2 = await timed();
      const t3 = await timed();
      assert.ok(t0.took < 100 && t1.took < 100, `before: ${t0.took}/${t1.took}`);
      assert.ok(t2.took >= 150, `delayed observe took ${t2.took}ms`);
      assert.ok(t3.took < 100, `after: ${t3.took}ms`);
      assert.equal(fakeHost.calls.observe.length, 4);
      assert.equal(notes.filter(note => note.event === 'fired').length, 1);
      assert.equal(t2.result, fakeHost.returned.observe[2]);
    }
  );

  await check(
    'slowObserve: an abort during the delay yields a CANCELLED host error and no real observe',
    async () => {
      const fakeHost = makeFakeHost();
      const { host, notes } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'slowObserve', atExecution: 1, ms: 5000 } }),
      });
      await host.execute(makeExecuteRequest(1));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 40);
      const start = Date.now();
      const result = await host.observe({ sessionId: SCOPE.sessionId }, controller.signal);
      assert.ok(Date.now() - start < 1000);
      assert.equal(result.ok, false);
      assert.ok(HOST_ERROR_CODES.includes(result.error.code));
      assert.equal(result.error.code, 'CANCELLED');
      assert.equal(typeof result.error.retryable, 'boolean');
      assert.equal(fakeHost.calls.observe.length, 0);
      assert.equal(notes.at(-1).outcome, 'cancelled_during_delay');
      const next = await host.observe({ sessionId: SCOPE.sessionId });
      assert.equal(next.ok, true);
    }
  );

  await check(
    'slowObserve: an already aborted signal is CANCELLED immediately and no timer is left',
    async () => {
      const timers = () =>
        process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
      const baseline = timers();
      const fakeHost = makeFakeHost();
      const { host } = applyInjection({
        host: fakeHost.host,
        scenario: faultScenario({ host: { mode: 'slowObserve', atExecution: 1, ms: 5000 } }),
      });
      await host.execute(makeExecuteRequest(1));
      const controller = new AbortController();
      controller.abort();
      const result = await host.observe({ sessionId: SCOPE.sessionId }, controller.signal);
      assert.equal(result.error.code, 'CANCELLED');
      assert.equal(timers(), baseline);
    }
  );

  await check(
    'host modes that act on execute never touch observe results (identity preserved)',
    async () => {
      for (const mode of ['lostAfterCommit', 'timeoutAfterCommit']) {
        const fakeHost = makeFakeHost();
        const { host } = applyInjection({
          host: fakeHost.host,
          scenario: faultScenario({ host: { mode, atExecution: 1 } }),
        });
        const observed = await host.observe({ sessionId: SCOPE.sessionId });
        assert.equal(observed, fakeHost.returned.observe[0]);
      }
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Checks: DOM-level host injectors in a real browser
// ---------------------------------------------------------------------------------------------

function makePageHost(page, { onExecute, label = 'obs-1' } = {}) {
  const observation = makeObservationFor(label);
  const seenAtForward = [];
  const fake = makeFakeHost({
    observation,
    executeImpl: async (request, n) => {
      const outcome = onExecute
        ? await onExecute(request, n, seenAtForward)
        : await (async () => {
            const connected = await page.evaluate(() => window.__held.save.isConnected);
            seenAtForward.push({ n, saveConnected: connected });
            return connected
              ? {
                  requestId: request.requestId,
                  status: 'applied',
                  effect: 'applied',
                  durationMs: 1,
                }
              : {
                  requestId: request.requestId,
                  status: 'rejected_stale',
                  effect: 'none',
                  staleReason: 'element_detached',
                  durationMs: 1,
                };
          })();
      return outcome;
    },
  });
  return { ...fake, observation, seenAtForward };
}

async function runStaleChecks(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await check(
      'staleBeforeExecute: fires only at execution 2; the held node is stale when the real execute starts',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 2 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        const o1 = await host.execute(
          makeExecuteRequest(1, { snapshotId: made.observation.snapshotId })
        );
        const connectedAfterFirst = (await heldConnected(page)).save;
        const signal = new AbortController().signal;
        const request2 = makeExecuteRequest(2, { snapshotId: made.observation.snapshotId });
        const o2 = await host.execute(request2, signal);
        const o3 = await host.execute(
          makeExecuteRequest(3, { snapshotId: made.observation.snapshotId })
        );
        assert.equal(made.calls.execute[1].request, request2);
        assert.equal(made.calls.execute[1].signal, signal);
        assert.equal(o1.status, 'applied');
        assert.equal(connectedAfterFirst, true, 'execution 1 must not change the DOM');
        assert.deepEqual(
          made.seenAtForward.map(seen => seen.saveConnected),
          [true, false, false]
        );
        assert.equal(o2.status, 'rejected_stale');
        assert.equal(o3.status, 'rejected_stale');
        assert.equal(notes.filter(note => note.event === 'fired').length, 1);
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: the target is replaced by an equivalent connected clone in the same place',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(makeExecuteRequest(1, { snapshotId: made.observation.snapshotId }));
        const state = await page.evaluate(() => {
          const current = document.getElementById('save');
          return {
            replaced: current !== window.__held.save,
            currentConnected: current.isConnected,
            heldConnected: window.__held.save.isConnected,
            sameHtml: current.outerHTML === window.__saveHtml,
            sameParent: current.parentNode === window.__held.main,
            sameIndex:
              Array.prototype.indexOf.call(current.parentNode.children, current) ===
              Array.prototype.indexOf.call(
                current.parentNode.children,
                document.getElementById('cancel')
              ) -
                1,
            buttons: document.querySelectorAll('button').length,
          };
        });
        assert.deepEqual(state, {
          replaced: true,
          currentConnected: true,
          heldConnected: false,
          sameHtml: true,
          sameParent: true,
          sameIndex: true,
          buttons: 2,
        });
        const fired = notes.at(-1);
        assert.equal(fired.strategy, 'target');
        assert.equal(fired.matches, 1);
        assert.equal(fired.replaced, 1);
        assert.deepEqual(fired.tags, ['BUTTON']);
        assert.equal(fired.applied, true);
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: no wrong element is touched (siblings and the other controls keep their identity)',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(makeExecuteRequest(1, { snapshotId: made.observation.snapshotId }));
        assert.deepEqual(await heldConnected(page), {
          main: true,
          keep: true,
          save: false,
          cancel: true,
          email: true,
          more: true,
        });
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: the clone is functional (delegated listener fires) and replaced only once across later executions',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(makeExecuteRequest(1, { snapshotId: made.observation.snapshotId }));
        await page.evaluate(() => {
          window.__second = document.getElementById('save');
        });
        await host.execute(makeExecuteRequest(2, { snapshotId: made.observation.snapshotId }));
        await page.click('#save');
        const state = await page.evaluate(() => ({
          sameNode: window.__second === document.getElementById('save'),
          clicks: window.__clicks.slice(),
        }));
        assert.deepEqual(state, { sameNode: true, clicks: ['save'] });
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: a text input keeps its typed value on the clone while the held node goes stale',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        await page.fill('#email', 'typed.value@example.test');
        const made = makePageHost(page);
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(
          makeExecuteRequest(1, {
            snapshotId: made.observation.snapshotId,
            targetId: 't3',
            command: {
              operation: 'FILL',
              target: {
                sessionId: SCOPE.sessionId,
                snapshotId: made.observation.snapshotId,
                targetId: 't3',
                signature: 'sig:t3',
              },
              value: 'unused',
              sensitive: false,
            },
          })
        );
        const state = await page.evaluate(() => ({
          value: document.getElementById('email').value,
          replaced: document.getElementById('email') !== window.__held.email,
          heldConnected: window.__held.email.isConnected,
        }));
        assert.deepEqual(state, {
          value: 'typed.value@example.test',
          replaced: true,
          heldConnected: false,
        });
        assert.deepEqual(notes.at(-1).tags, ['INPUT']);
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: an unknown snapshot falls back to replacing every control, never a container (strategy controls)',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.execute(makeExecuteRequest(1, { snapshotId: 'snap_never_observed' }));
        assert.deepEqual(await heldConnected(page), {
          main: true,
          keep: true,
          save: false,
          cancel: false,
          email: false,
          more: false,
        });
        const state = await page.evaluate(() => ({
          buttons: document.querySelectorAll('button').length,
          selects: document.querySelectorAll('select').length,
          text: document.getElementById('load').textContent,
        }));
        assert.deepEqual(state, { buttons: 2, selects: 1, text: 'load 1' });
        assert.equal(notes.at(-1).strategy, 'controls');
        assert.equal(notes.at(-1).descriptor, 'snapshot_not_observed');
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: a command without a target (WAIT) also replaces the controls and only the controls',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(
          makeExecuteRequest(1, { command: { operation: 'WAIT', durationMs: 250 } })
        );
        const connected = await heldConnected(page);
        assert.equal(connected.main, true);
        assert.equal(connected.save, false);
        assert.equal(notes.at(-1).strategy, 'controls');
        assert.equal(notes.at(-1).descriptor, 'command_has_no_target');
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: the right control is chosen among several by role and accessible name',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(
          makeExecuteRequest(1, { snapshotId: made.observation.snapshotId, targetId: 't2' })
        );
        const connected = await heldConnected(page);
        assert.equal(connected.cancel, false);
        assert.equal(connected.save, true);
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: the observed label matches the page name regardless of case and spacing',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const observation = makeObservation([makeElement('t1', { label: '  SAVE\n   changes ' })], {
          snapshotId: 'snap_spacing',
        });
        const fake = makeFakeHost({ observation });
        const { host, notes } = applyInjection({
          host: fake.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(makeExecuteRequest(1, { snapshotId: 'snap_spacing', targetId: 't1' }));
        const connected = await heldConnected(page);
        assert.equal(notes.at(-1).strategy, 'target');
        assert.equal(connected.save, false);
        assert.equal(connected.cancel, true);
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: notes carry ids, tags and counts but never the observed label text',
      async () => {
        const page = await freshPage(context, server);
        await hold(page);
        const made = makePageHost(page);
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(makeExecuteRequest(1, { snapshotId: made.observation.snapshotId }));
        const text = JSON.stringify(notes);
        assert.ok(!text.includes('Save changes'));
        assert.ok(text.includes('"targetId":"t1"'));
        await page.close();
      }
    );
  } finally {
    await context.close();
  }
}

const sameLoad = (page, loadId) => page.evaluate(id => window.__loadId === id, loadId);

async function runNavigationChecks(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const clickAndWait = page =>
    page.evaluate(() => {
      document.getElementById('save').click();
      return new Promise(resolve => setTimeout(resolve, 4000));
    });
  const during = (page, state) => async (request, n) => {
    if (n !== 2) {
      return { requestId: request.requestId, status: 'applied', effect: 'applied', durationMs: 1 };
    }
    try {
      await clickAndWait(page);
      return { requestId: request.requestId, status: 'applied', effect: 'applied', durationMs: 1 };
    } catch (error) {
      state.rejection = String(error && error.message).split('\n')[0];
      return {
        requestId: request.requestId,
        status: 'navigated',
        effect: 'uncertain',
        durationMs: 1,
      };
    }
  };
  try {
    await check(
      'contextDestroyed (during): one full navigation inside execution 2, the execute sees its context destroyed',
      async () => {
        const page = await freshPage(context, server);
        const state = {};
        const made = makePageHost(page, { onExecute: during(page, state) });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 2 } }),
        });
        const urlBefore = page.url();
        await host.execute(makeExecuteRequest(1));
        assert.equal(server.state.loads, 1, 'execution 1 must not navigate');
        const outcome = await host.execute(makeExecuteRequest(2));
        assert.equal(server.state.loads, 2);
        assert.equal(outcome.status, 'navigated');
        assert.match(state.rejection, /context was destroyed|navigation/i);
        assert.equal(page.url(), urlBefore);
        assert.equal(await sameLoad(page, 2), true);
        const fired = notes.at(-1);
        assert.equal(fired.navigationPhase, 'during');
        assert.equal(fired.applied, true);
        assert.equal(fired.executeStatus, 'navigated');
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): execution 3 does not navigate and the trap is gone from the new document',
      async () => {
        const page = await freshPage(context, server);
        const state = {};
        const made = makePageHost(page, { onExecute: during(page, state) });
        const { host } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 2 } }),
        });
        await host.execute(makeExecuteRequest(1));
        await host.execute(makeExecuteRequest(2));
        await host.execute(makeExecuteRequest(3));
        assert.equal(server.state.loads, 2);
        await page.click('#save');
        await page.fill('#email', 'x');
        await sleepFor(300);
        assert.equal(server.state.loads, 2, 'a stray trap navigated again');
        assert.equal(await page.evaluate(() => document.getElementById('email').value), 'x');
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): the navigation starts from the first event of the forwarded command, not from a timer',
      async () => {
        const page = await freshPage(context, server);
        let clickReached = false;
        const made = makePageHost(page, {
          onExecute: async request => {
            await sleepFor(500);
            try {
              await page.evaluate(() => {
                document.getElementById('save').click();
                return new Promise(resolve => setTimeout(resolve, 4000));
              });
            } catch {
              clickReached = true;
            }
            return {
              requestId: request.requestId,
              status: 'navigated',
              effect: 'uncertain',
              durationMs: 1,
            };
          },
        });
        const { host } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        const loadsAtStart = server.state.loads;
        const pending = host.execute(makeExecuteRequest(1));
        await sleepFor(300);
        assert.equal(
          server.state.loads,
          loadsAtStart,
          'navigated before the command produced an event'
        );
        await pending;
        assert.equal(clickReached, true);
        assert.equal(server.state.loads, 2);
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): an execute that produces no event is followed by the navigation right after it (after_execute)',
      async () => {
        const page = await freshPage(context, server);
        const made = makePageHost(page, {
          onExecute: async request => ({
            requestId: request.requestId,
            status: 'applied',
            effect: 'none',
            durationMs: 1,
          }),
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        const outcome = await host.execute(makeExecuteRequest(1));
        assert.equal(outcome.status, 'applied');
        assert.equal(server.state.loads, 2);
        assert.equal(await sameLoad(page, 2), true);
        assert.equal(notes.at(-1).navigationPhase, 'after_execute');
        await page.click('#save');
        await sleepFor(200);
        assert.equal(server.state.loads, 2, 'the trap must not survive into the new document');
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): a scroll event does not trigger a CLICK command navigation; the click event does',
      async () => {
        const page = await freshPage(context, server);
        let loadsAfterScroll = -1;
        const made = makePageHost(page, {
          onExecute: async request => {
            await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
            await sleepFor(150);
            loadsAfterScroll = server.state.loads;
            try {
              await clickAndWait(page);
            } catch {
              return {
                requestId: request.requestId,
                status: 'navigated',
                effect: 'uncertain',
                durationMs: 1,
              };
            }
            return {
              requestId: request.requestId,
              status: 'applied',
              effect: 'applied',
              durationMs: 1,
            };
          },
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await host.execute(makeExecuteRequest(1));
        assert.equal(loadsAfterScroll, 1, 'a scroll event navigated a CLICK command');
        assert.equal(server.state.loads, 2);
        assert.equal(notes.at(-1).navigationPhase, 'during');
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): a SCROLL command navigates on its scroll event',
      async () => {
        const page = await freshPage(context, server);
        let rejection;
        const made = makePageHost(page, {
          onExecute: async request => {
            try {
              await page.evaluate(() => {
                window.dispatchEvent(new Event('scroll'));
                return new Promise(resolve => setTimeout(resolve, 4000));
              });
            } catch (error) {
              rejection = String(error && error.message);
            }
            return {
              requestId: request.requestId,
              status: 'navigated',
              effect: 'uncertain',
              durationMs: 1,
            };
          },
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await host.execute(
          makeExecuteRequest(1, { command: { operation: 'SCROLL', direction: 'DOWN' } })
        );
        assert.match(rejection, /context was destroyed|navigation/i);
        assert.equal(server.state.loads, 2);
        assert.equal(notes.at(-1).navigationPhase, 'during');
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): a READ command arms no trap and the navigation follows the execute',
      async () => {
        const page = await freshPage(context, server);
        const made = makePageHost(page, {
          onExecute: async request => ({
            requestId: request.requestId,
            status: 'applied',
            effect: 'none',
            durationMs: 1,
          }),
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await host.execute(
          makeExecuteRequest(1, {
            command: {
              operation: 'READ',
              target: {
                sessionId: SCOPE.sessionId,
                snapshotId: SCOPE.snapshotId,
                targetId: 't1',
                signature: 'sig:t1',
              },
            },
          })
        );
        assert.equal(notes.at(-1).trapEvents, 0);
        assert.equal(notes.at(-1).navigationPhase, 'after_execute');
        assert.equal(server.state.loads, 2);
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): a real execute that rejects is rethrown unchanged after the injection is recorded',
      async () => {
        const page = await freshPage(context, server);
        const made = makePageHost(page, {
          onExecute: async () => {
            throw new Error('host broke');
          },
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await assert.rejects(() => host.execute(makeExecuteRequest(1)), /host broke/);
        assert.equal(notes.at(-1).event, 'fired');
        assert.equal(server.state.loads, 2);
        await page.close();
      }
    );

    await check(
      'contextDestroyed (before): the navigation completes before the real execute is forwarded',
      async () => {
        const page = await freshPage(context, server);
        const seen = [];
        const made = makePageHost(page, {
          onExecute: async (request, n) => {
            seen.push({ n, loadId: await page.evaluate(() => window.__loadId) });
            return {
              requestId: request.requestId,
              status: 'rejected_stale',
              effect: 'none',
              durationMs: 1,
            };
          },
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({
            host: { mode: 'contextDestroyed', atExecution: 2, timing: 'before' },
          }),
        });
        await host.execute(makeExecuteRequest(1));
        await host.execute(makeExecuteRequest(2));
        await host.execute(makeExecuteRequest(3));
        assert.deepEqual(seen, [
          { n: 1, loadId: 1 },
          { n: 2, loadId: 2 },
          { n: 3, loadId: 2 },
        ]);
        assert.equal(server.state.loads, 2);
        assert.equal(notes.at(-1).navigationPhase, 'before_execute');
        assert.equal(notes.at(-1).applied, true);
        await page.close();
      }
    );

    await check(
      'contextDestroyed: a url fragment is dropped so the navigation is a real document load',
      async () => {
        const page = await freshPage(context, server);
        await page.evaluate(() => {
          window.location.hash = 'section';
        });
        const made = makePageHost(page, {
          onExecute: async request => ({
            requestId: request.requestId,
            status: 'applied',
            effect: 'none',
            durationMs: 1,
          }),
        });
        const { host } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({
            host: { mode: 'contextDestroyed', atExecution: 1, timing: 'before' },
          }),
        });
        await host.execute(makeExecuteRequest(1));
        assert.equal(server.state.loads, 2);
        assert.ok(!page.url().includes('#'));
        await page.close();
      }
    );
  } finally {
    await context.close();
  }
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Checks: secrets, listeners, timers and app safety (adversarial additions)
// ---------------------------------------------------------------------------------------------

// Contains characters no enumeration token has, like a generated password; never a literal secret.
const makeFakeSecret = () => `Pw-${crypto.randomBytes(9).toString('hex')}!`;

const activeTimers = () =>
  process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

/**
 * Playwright keeps a transient timer for about half a second after a page opens or navigates. A baseline
 * read inside that window counts it, the timer then expires, and a one-timer leak is hidden by the drop.
 * So the baseline is taken only once the count has been unchanged for a while.
 */
async function quiescentTimers(stableMs = 900, maxMs = 6000) {
  const deadline = Date.now() + maxMs;
  let last = activeTimers();
  let since = Date.now();
  while (Date.now() < deadline && Date.now() - since < stableMs) {
    await sleepFor(50);
    const now = activeTimers();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  return last;
}

/** Transient timers of a loaded machine settle within the window; a leaked 4s or 5s timer does not. */
async function timersSettleTo(limit, windowMs = 2000) {
  const deadline = Date.now() + windowMs;
  let current = activeTimers();
  while (current > limit && Date.now() < deadline) {
    await sleepFor(25);
    current = activeTimers();
  }
  return current;
}

const LISTENER_PAGE = `<!doctype html><html><body>
<div id="root">
  <form id="f" action="#">
    <label><input type="checkbox" id="c"> Promotional emails</label>
    <button type="submit" id="b">Save changes</button>
  </form>
  <p id="status"></p>
</div>
<script>
  window.__log = [];
  window.__status = document.getElementById('status');
  document.getElementById('root').addEventListener('click', function (event) {
    window.__log.push('root:' + (event.target.id || event.target.tagName));
  });
  document.getElementById('f').addEventListener('submit', function (event) {
    event.preventDefault();
    window.__status.textContent = 'Saved';
    window.__log.push('submit');
  });
</script></body></html>`;

async function runCheapHardeningChecks() {
  await check(
    'secrets: a fake secret in every request, observation and host field never reaches a note, the report or a recorded entry',
    async () => {
      const SECRET = makeFakeSecret();
      const configs = [
        { decider: { mode: 'prematureDone', atDecision: 1 } },
        { decider: { mode: 'invalidTarget', atDecision: 1 } },
        { decider: { mode: 'invalidArgument', atDecision: 1 } },
        { decider: { mode: 'noneAppropriate', atDecision: 1 } },
        { decider: { mode: 'noneAppropriate', atDecision: 1, stage: 'argument' } },
        { decider: { mode: 'slow', atDecision: 1, ms: 0 } },
        { decider: { mode: 'throw', atDecision: 1 } },
        { decider: { mode: 'throw', atDecision: 1, style: 'result' } },
        { host: { mode: 'lostAfterCommit', atExecution: 1 } },
        { host: { mode: 'timeoutAfterCommit', atExecution: 1 } },
        { host: { mode: 'slowObserve', atExecution: 1, ms: 0 } },
      ];
      let flowedThroughDecision = false;
      let flowedThroughOutcome = false;
      for (const inject of configs) {
        const recorded = [];
        const fake = makeFakeDecider();
        const hostile = makeFakeHost({
          observation: makeObservation(
            [makeElement('t1', { label: SECRET }), makeElement(SECRET, { label: SECRET })],
            { title: SECRET, text: SECRET, url: `http://127.0.0.1:1/?q=${SECRET}` }
          ),
          executeImpl: async request => ({
            requestId: request.requestId,
            status: SECRET,
            effect: SECRET,
            code: SECRET,
            message: SECRET,
            durationMs: 1,
          }),
        });
        const out = applyInjection({
          decider: fake.decider,
          host: hostile.host,
          recorder: entry => recorded.push(entry),
          scenario: faultScenario(inject, 'secrets-selftest'),
        });
        const actionRequest = makeActionRequest({
          goal: SECRET,
          elements: [makeElement('t1', { label: SECRET }), makeElement(SECRET, { label: SECRET })],
          offers: {
            operations: ['CLICK', 'DONE', 'BLOCKED'],
            targets: { CLICK: ['t1'] },
          },
        });
        const argumentRequest = { ...makeArgumentRequest(['c1']), goal: SECRET, slot: SECRET };
        const sunk = [];
        const call = async fn => {
          try {
            sunk.push(await fn());
          } catch {
            // 'throw' mode rejects by design.
          }
        };
        const context = makeContext({ goal: SECRET });
        await call(() => out.decider.chooseAction(actionRequest, context));
        await call(() => out.decider.chooseArgument(argumentRequest, context));
        await call(() => out.decider.chooseAction(actionRequest, context));
        const executeRequest = makeExecuteRequest(1, {
          command: {
            operation: SECRET,
            target: {
              sessionId: SCOPE.sessionId,
              snapshotId: SCOPE.snapshotId,
              targetId: SECRET,
              signature: SECRET,
            },
          },
        });
        await call(() => out.host.execute(executeRequest));
        await call(() => out.host.observe({ sessionId: SCOPE.sessionId }));
        await call(() => out.host.execute(executeRequest));
        if (inject.decider?.mode === 'invalidTarget') {
          flowedThroughDecision = JSON.stringify(sunk).includes(SECRET);
        }
        if (inject.host?.mode === 'lostAfterCommit') {
          flowedThroughOutcome = JSON.stringify(hostile.returned.execute).includes(SECRET);
        }
        const everything = JSON.stringify({ notes: out.notes, report: out.report(), recorded });
        assert.ok(
          !everything.includes(SECRET),
          `a note leaked the fake secret in ${JSON.stringify(inject)}`
        );
        assert.ok(
          out.notes.some(note => note.event === 'fired'),
          `nothing fired for ${JSON.stringify(inject)}`
        );
      }
      assert.ok(
        flowedThroughDecision,
        'control: the secret must reach the returned decision in invalidTarget'
      );
      assert.ok(
        flowedThroughOutcome,
        'control: the secret must reach the real outcome the host returned'
      );
    }
  );

  await check(
    'secrets: a host that reports free text as status, effect or code is recorded as unrecognized, not copied',
    async () => {
      const hostile = makeFakeHost({
        executeImpl: async request => ({
          requestId: request.requestId,
          status: 'applied with text',
          effect: 'x'.repeat(200),
          code: 'a b',
          durationMs: 1,
        }),
      });
      const out = applyInjection({
        host: hostile.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
      });
      await out.host.execute(makeExecuteRequest(1));
      const fired = out.notes.at(-1);
      assert.equal(fired.realStatus, 'unrecognized');
      assert.equal(fired.realEffect, 'unrecognized');
      assert.equal(fired.realCode, 'unrecognized');
      const honest = makeFakeHost({
        executeImpl: async request => ({
          requestId: request.requestId,
          status: 'failed',
          effect: 'none',
          code: 'TARGET_DISABLED',
          durationMs: 1,
        }),
      });
      const out2 = applyInjection({
        host: honest.host,
        scenario: faultScenario({ host: { mode: 'lostAfterCommit', atExecution: 1 } }),
      });
      await out2.host.execute(makeExecuteRequest(1));
      const kept = out2.notes.at(-1);
      assert.deepEqual(
        [kept.realStatus, kept.realEffect, kept.realCode],
        ['failed', 'none', 'TARGET_DISABLED']
      );
    }
  );
}

// Runs before every other browser check: a timer leaked by an earlier check would sit in the baseline and
// expire during the measurement, which hides the very leak this check looks for.
async function runLeakChecks(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const newClickAndWait = page => () =>
    page.evaluate(() => {
      document.getElementById('save').click();
      return new Promise(resolve => setTimeout(resolve, 4000));
    });
  try {
    await check(
      'page-side injections leave no timer behind (stale replacement and navigation trap)',
      async () => {
        const page = await freshPage(context, server);
        const baseline = await quiescentTimers();
        const control = setTimeout(() => {}, 4000);
        const withControl = activeTimers();
        clearTimeout(control);
        assert.equal(withControl, baseline + 1, 'control: a live timer must be visible');
        await hold(page);
        const made = makePageHost(page);
        const stale = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await stale.host.observe({ sessionId: SCOPE.sessionId });
        await stale.host.execute(
          makeExecuteRequest(1, { snapshotId: made.observation.snapshotId })
        );
        assert.equal(stale.notes.at(-1).applied, true);
        assert.ok((await timersSettleTo(baseline)) <= baseline, 'stale replacement left a timer');
        await quiescentTimers();
        const clickAndWait = newClickAndWait(page);
        const navigating = makePageHost(page, {
          onExecute: async request => {
            await clickAndWait().catch(() => {});
            return {
              requestId: request.requestId,
              status: 'navigated',
              effect: 'uncertain',
              durationMs: 1,
            };
          },
        });
        const trap = applyInjection({
          host: navigating.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await trap.host.execute(makeExecuteRequest(1));
        assert.equal(trap.notes.at(-1).applied, true);
        assert.ok((await timersSettleTo(baseline)) <= baseline, 'navigation trap left a timer');
        await page.close();
      }
    );
  } finally {
    await context.close();
  }
}

async function runBrowserHardeningChecks(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const newClickAndWait = page => () =>
    page.evaluate(() => {
      document.getElementById('save').click();
      return new Promise(resolve => setTimeout(resolve, 4000));
    });
  try {
    await check(
      'staleBeforeExecute: a select keeps its chosen option on the clone while the held node goes stale',
      async () => {
        const page = await freshPage(context, server);
        await page.selectOption('#plan', 'team');
        await page.evaluate(() => {
          window.__heldPlan = document.getElementById('plan');
        });
        const observation = makeObservation(
          [
            makeElement('t1', {
              label: 'Plan',
              role: 'combobox',
              kind: 'select',
              operations: ['SELECT'],
            }),
          ],
          { snapshotId: 'snap_select' }
        );
        const fake = makeFakeHost({ observation });
        const { host, notes } = applyInjection({
          host: fake.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await host.observe({ sessionId: SCOPE.sessionId });
        await host.execute(makeExecuteRequest(1, { snapshotId: 'snap_select', targetId: 't1' }));
        const state = await page.evaluate(() => ({
          value: document.getElementById('plan').value,
          replaced: document.getElementById('plan') !== window.__heldPlan,
          heldConnected: window.__heldPlan.isConnected,
        }));
        assert.deepEqual(state, { value: 'team', replaced: true, heldConnected: false });
        assert.equal(notes.at(-1).strategy, 'target');
        assert.deepEqual(notes.at(-1).tags, ['SELECT']);
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: the fallback keeps container listeners and cached nodes alive (the app still works afterwards)',
      async () => {
        const drive = async withFault => {
          const page = await context.newPage();
          await page.setContent(LISTENER_PAGE);
          if (withFault) {
            const made = makeFakeHost();
            const { host, notes } = applyInjection({
              host: made.host,
              page,
              scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
            });
            await host.execute(
              makeExecuteRequest(1, { command: { operation: 'WAIT', durationMs: 100 } })
            );
            assert.equal(notes.at(-1).strategy, 'controls');
            assert.ok(notes.at(-1).replaced >= 2, 'the controls must have been replaced');
          }
          await page.click('#c');
          await page.click('#b');
          const result = await page.evaluate(() => ({
            log: window.__log.slice(),
            statusText: document.getElementById('status').textContent,
            cachedStatusConnected: window.__status.isConnected,
          }));
          await page.close();
          return result;
        };
        const control = await drive(false);
        assert.ok(control.log.includes('submit'), 'control: the pristine page must submit');
        const faulted = await drive(true);
        assert.deepEqual(faulted, control);
        assert.equal(faulted.statusText, 'Saved');
        assert.equal(faulted.cachedStatusConnected, true);
      }
    );

    await check(
      'contextDestroyed (during): a page whose url carries a fragment still gets a real document load',
      async () => {
        const page = await freshPage(context, server);
        await page.evaluate(() => {
          window.location.hash = 'section';
        });
        const clickAndWait = newClickAndWait(page);
        let rejection;
        const made = makePageHost(page, {
          onExecute: async request => {
            try {
              await clickAndWait();
            } catch (error) {
              rejection = String(error && error.message).split('\n')[0];
            }
            return {
              requestId: request.requestId,
              status: 'navigated',
              effect: 'uncertain',
              durationMs: 1,
            };
          },
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await host.execute(makeExecuteRequest(1));
        assert.equal(
          server.state.loads,
          2,
          'the in-page trap must start a document load, not a hash change'
        );
        assert.match(rejection, /context was destroyed|navigation/i);
        assert.ok(!page.url().includes('#'));
        assert.equal(notes.at(-1).navigationPhase, 'during');
        assert.equal(notes.at(-1).applied, true);
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): the trap fires once even when the command dispatches several events',
      async () => {
        const page = await freshPage(context, server);
        const tokens = [];
        page.on('console', message => {
          if (message.text().startsWith('kriya-e2e-fault-nav-')) {
            tokens.push(message.text());
          }
        });
        const made = makePageHost(page, {
          onExecute: async request => {
            await page
              .evaluate(() => {
                const save = document.getElementById('save');
                for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
                  save.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
                }
                return new Promise(resolve => setTimeout(resolve, 4000));
              })
              .catch(() => {});
            return {
              requestId: request.requestId,
              status: 'navigated',
              effect: 'uncertain',
              durationMs: 1,
            };
          },
        });
        const { host, notes } = applyInjection({
          host: made.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await host.execute(makeExecuteRequest(1));
        assert.equal(notes.at(-1).navigationPhase, 'during');
        assert.equal(tokens.length, 1, `the trap announced itself ${tokens.length} times`);
        assert.equal(server.state.loads, 2);
        await page.close();
      }
    );

    await check(
      'contextDestroyed (during): no console listener is left on the page, whether the trap fired or not',
      async () => {
        const page = await freshPage(context, server);
        const baseline = page.listenerCount('console');
        const control = () => {};
        page.on('console', control);
        assert.equal(
          page.listenerCount('console'),
          baseline + 1,
          'control: a listener must be visible'
        );
        page.off('console', control);
        const clickAndWait = newClickAndWait(page);
        const fired = makePageHost(page, {
          onExecute: async request => {
            await clickAndWait().catch(() => {});
            return {
              requestId: request.requestId,
              status: 'navigated',
              effect: 'uncertain',
              durationMs: 1,
            };
          },
        });
        const a = applyInjection({
          host: fired.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await a.host.execute(makeExecuteRequest(1));
        assert.equal(a.notes.at(-1).navigationPhase, 'during');
        assert.equal(page.listenerCount('console'), baseline, 'trap-fired path left a listener');
        const quiet = makePageHost(page, {
          onExecute: async request => ({
            requestId: request.requestId,
            status: 'applied',
            effect: 'none',
            durationMs: 1,
          }),
        });
        const b = applyInjection({
          host: quiet.host,
          page,
          scenario: faultScenario({ host: { mode: 'contextDestroyed', atExecution: 1 } }),
        });
        await b.host.execute(makeExecuteRequest(1));
        assert.equal(b.notes.at(-1).navigationPhase, 'after_execute');
        assert.equal(page.listenerCount('console'), baseline, 'after_execute path left a listener');
        await page.close();
      }
    );

    await check(
      'contextDestroyed: a failed navigation is recorded without the page url (a query string can hold a secret)',
      async () => {
        const SECRET = makeFakeSecret();
        const doomedPage = async () => {
          const doomed = await startServer();
          const page = await context.newPage();
          await page.goto(`${doomed.url}?q=${encodeURIComponent(SECRET)}`, {
            waitUntil: 'domcontentloaded',
          });
          await doomed.close();
          return page;
        };
        const controlPage = await doomedPage();
        let rawError = '';
        await controlPage.goto(controlPage.url(), { timeout: 3000 }).catch(error => {
          rawError = String(error && error.message);
        });
        await controlPage.close();
        assert.ok(
          rawError.includes(encodeURIComponent(SECRET)) || rawError.includes(SECRET),
          'control: the raw Playwright error must quote the url, or this check measures nothing'
        );
        const page = await doomedPage();
        const fake = makeFakeHost();
        const { host, notes } = applyInjection({
          host: fake.host,
          page,
          scenario: faultScenario({
            host: { mode: 'contextDestroyed', atExecution: 1, timing: 'before' },
          }),
        });
        await host.execute(makeExecuteRequest(1));
        const fired = notes.at(-1);
        assert.equal(fired.applied, false);
        assert.equal(typeof fired.error, 'string');
        const everything = JSON.stringify(notes);
        assert.ok(!everything.includes(SECRET));
        assert.ok(!everything.includes(encodeURIComponent(SECRET)));
        assert.ok(!/https?:\/\//.test(everything), 'a recorded error must not carry a url');
        await page.close();
      }
    );

    await check(
      'staleBeforeExecute: a stale injection on a page that was closed is recorded as not applied and never rejects',
      async () => {
        const page = await freshPage(context, server);
        const fake = makeFakeHost();
        const { host, notes } = applyInjection({
          host: fake.host,
          page,
          scenario: faultScenario({ host: { mode: 'staleBeforeExecute', atExecution: 1 } }),
        });
        await page.close();
        const outcome = await host.execute(makeExecuteRequest(1, { snapshotId: 'snap_none' }));
        assert.equal(outcome.status, 'applied');
        assert.equal(notes.at(-1).applied, false);
        assert.equal(notes.at(-1).replaced, 0);
        assert.equal(typeof notes.at(-1).error, 'string');
      }
    );
  } finally {
    await context.close();
  }
}

async function runImportCheck() {
  await check(
    'module imports without side effects: no output, no open handles, exits on its own',
    () => {
      const script = `import(${JSON.stringify(pathToFileURL(MODULE_PATH).href)}).then(m => {
      if (typeof m.applyInjection !== 'function') { process.exitCode = 3; }
    });`;
      const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 8000 });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, '');
      assert.equal(run.signal, null);
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  await runValidationChecks();
  await runPassThroughChecks();
  await runRecorderChecks();
  await runDeciderChecks();
  await runHostChecks();
  await runCheapHardeningChecks();
  await runImportCheck();

  const { chromium } = loadPlaywright({});
  const executablePath = findChromium();
  let browser;
  let server;
  try {
    server = await startServer();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    await runLeakChecks(browser, server);
    await runStaleChecks(browser, server);
    await runNavigationChecks(browser, server);
    await runBrowserHardeningChecks(browser, server);
  } catch (error) {
    total += 1;
    failures.push('browser fixture');
    console.log(`FAIL browser fixture: ${String(error && error.message).split('\n')[0]}`);
  } finally {
    if (browser) {
      await browser.close();
    }
    if (server) {
      await server.close();
    }
  }

  console.log(`faults.selftest: ${passed}/${total} passed`);
  if (failures.length > 0) {
    console.log(`faults.selftest failed: ${failures.join(' | ')}`);
    process.exitCode = 1;
  }
}

const isEntryPoint =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
  main().catch(error => {
    console.log(`FAIL selftest crashed: ${String(error && error.message).split('\n')[0]}`);
    process.exitCode = 1;
  });
}
