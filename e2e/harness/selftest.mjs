import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_CODES, findChromium, preflight } from './env.mjs';
import { checkDist, exportedNames, readBundles, REQUIRED_EXPORTS, SOURCE_DIRS } from './dist.mjs';
import {
  createEvidenceWriter,
  redactSecrets,
  safeStringify,
  scanForSecrets,
  secretVariants,
} from './evidence.mjs';
import {
  generateSensitiveValues,
  isScannableSecret,
  scannableSensitiveValues,
} from './sensitive.mjs';
import {
  BUDGET_KEYS,
  COMMITMENT_EFFECTS,
  DECIDER_MODES,
  declaresSensitive,
  findTextProblems,
  HOST_MODES,
  HOST_OPERATIONS,
  loadScenarioFiles,
  loadScenarios,
  TASK_STATUSES,
  validateScenario,
} from './scenario.mjs';
import { assertJevCalls, readApiKey, runScenario } from './runner.mjs';
import { main, parseArgs, runPool } from '../run.mjs';

/**
 * Self-test of the harness core. Everything here runs with injected fakes: no browser, no model, no dist
 * build. Positive and negative controls come in pairs so a check that measured nothing cannot pass.
 * Run: node e2e/harness/selftest.mjs   (importing this module runs nothing)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

/** Harness sources this selftest is responsible for: every module except other authors' selftests. */
function harnessSources() {
  return [
    ...fs
      .readdirSync(here)
      .filter(
        name => name.endsWith('.mjs') && (name === 'selftest.mjs' || !/\.selftest\.mjs$/.test(name))
      )
      .map(name => path.join(here, name)),
    path.join(REPO_ROOT, 'e2e', 'run.mjs'),
  ];
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64'
);

const tally = { passed: 0, total: 0, failed: [], skipped: [], info: [] };

const CHECK_TIMEOUT_MS = 90000;

async function check(name, fn) {
  tally.total += 1;
  let timer;
  try {
    // a check that hangs is a failed check, not a hung selftest
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS} ms`)),
          CHECK_TIMEOUT_MS
        );
      }),
    ]);
    tally.passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    tally.failed.push(name);
    process.stdout.write(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}\n`);
  } finally {
    clearTimeout(timer);
  }
}

function skip(name, reason) {
  tally.skipped.push(name);
  process.stdout.write(`SKIP ${name}: ${reason}\n`);
}

function ok(condition, message) {
  if (!condition) {
    throw new Error(message ?? 'assertion failed');
  }
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message ?? 'values differ'}: expected ${b}, got ${a}`);
  }
}

async function rejects(fn, message) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message ?? 'expected a rejection');
}

function hasError(result, fragment) {
  return result.errors.some(error => error.includes(fragment));
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const FAKE_KEY = `sk-${randomBytes(12).toString('hex')}`;
const DIST_SHA = randomBytes(32).toString('hex');
const LIVE_GOAL = 'Find the wireless mouse in the Electronics category and show me only that.';

const goodLive = (overrides = {}) => ({
  id: 'catalog-a-demo',
  family: 'catalog',
  variant: 'A',
  kind: 'live',
  title: 'Demo scenario',
  goal: LIVE_GOAL,
  inputs: { query: 'wireless mouse' },
  expectStatus: 'completed',
  expect: async () => {},
  ...overrides,
});

const goodFault = (overrides = {}) =>
  goodLive({
    id: 'catalog-a-demo-fault',
    kind: 'fault',
    inject: { decider: { mode: 'prematureDone', atDecision: 1 } },
    ...overrides,
  });

const baseResult = (goal, extra) => ({
  runId: 'run_000000000001',
  sessionId: 'ses_000000000001',
  goal,
  steps: 2,
  stats: { usage: {}, modelLatencyMs: 10, actions: {} },
  ledger: [],
  exchanges: [],
  warnings: [],
  startedAt: 1,
  finishedAt: 2,
  lastEffect: 'none',
  unresolvedUncertain: [],
  ...extra,
});

const checkpoint = { id: 'ck_000000000001', version: 1, runId: 'run_000000000001' };
const approval = {
  id: 'apr_000000000001',
  nonce: 'non_000000000001',
  digest: 'dg_000000000001',
  contextDigest: 'cx_000000000001',
};

const results = {
  completed: goal => baseResult(goal, { status: 'completed', completion: { basis: 'grounded' } }),
  failed: goal =>
    baseResult(goal, {
      status: 'failed',
      error: { code: 'INTERNAL', message: 'nope', retryable: false },
    }),
  needsInput: goal =>
    baseResult(goal, {
      status: 'needs_input',
      requirements: [{ id: 'r1', kind: 'argument', reason: 'input_missing', description: 'x' }],
      checkpoint,
    }),
  awaiting: goal => baseResult(goal, { status: 'awaiting_approval', approval, checkpoint }),
  cancelled: goal => baseResult(goal, { status: 'cancelled', during: 'decision' }),
};

function jevEntry(goal, overrides = {}) {
  return {
    at: '2026-10-03T00:00:00.000Z',
    url: 'https://api.typesafe.ai/v1/systemone',
    attempt: 1,
    requestHeaders: { 'content-type': 'application/json', Authorization: '[REDACTED]' },
    request: {
      model: 'jev-latest',
      state: { page: 'listing' },
      questions: {
        operation: {
          type: 'choice',
          instructions: { goal, rules: ['Pick one criterion by its id.'] },
          criteria: { t1: 'Search box', DONE: 'finished' },
        },
      },
    },
    response: { model: 'jev-1.13.0', answers: {} },
    model: 'jev-1.13.0',
    requestId: 'req_00000000000000000000000000000001',
    latency: 12,
    status: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Fake world for runScenario
// ---------------------------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function emitExecuted(onEvent, step = 1) {
  onEvent({
    type: 'observed',
    seq: 1,
    at: 0,
    runId: 'run_000000000001',
    step,
    ordinal: step,
    changed: true,
    snapshot: {
      url: 'http://127.0.0.1:4010/',
      title: 'Listing',
      sequence: step,
      fingerprint: 'fp',
      elementCount: 7,
    },
  });
  onEvent({
    type: 'executed',
    seq: 2,
    at: 1,
    runId: 'run_000000000001',
    step,
    requestId: 'req_1',
    status: 'applied',
    effect: 'applied',
    durationMs: 3,
  });
}

function makeWorld(opts = {}) {
  const world = {
    log: [],
    backend: { searches: [], lastResultIds: [] },
    runRequests: [],
    resumeRequests: [],
    visible: opts.visibleTexts ?? [],
  };
  const appOrigin = opts.appOrigin ?? 'http://127.0.0.1:4010';
  const app = {
    url: `${appOrigin}/`,
    origin: appOrigin,
    family: 'catalog',
    variant: 'A',
    state: () => structuredClone(world.backend),
    requests: () =>
      opts.requests ?? [
        { seq: 1, method: 'GET', path: '/api/products', query: {}, bodySummary: null },
      ],
    reset: () => undefined,
    close: async () => {
      world.log.push('app.close');
    },
  };
  const page = {
    url: () => app.url,
    goto: async () => {
      world.log.push('page.goto');
    },
    screenshot: async ({ path: target }) => {
      fs.writeFileSync(target, PNG);
    },
    evaluate: async () => {
      world.evaluateCalls = (world.evaluateCalls ?? 0) + 1;
      return world.visible.length > 0
        ? world.visible.shift()
        : (world.pageText ?? 'plain catalog page');
    },
    content: async () => opts.html ?? '<html><body>fake page</body></html>',
    isClosed: () => false,
  };
  world.app = app;
  world.page = page;
  const defaultScript = async ({ request, onEvent }) => {
    emitExecuted(onEvent);
    world.backend.searches.push({ q: 'wireless mouse', count: 1 });
    world.callJev(request.goal);
    return results.completed(request.goal);
  };
  world.callJev = (goal, overrides) => world.httpArgs.recorder.record(jevEntry(goal, overrides));
  world.deps = {
    startApp: async options => {
      if (opts.startAppThrows) {
        throw new Error('app failed to start');
      }
      world.startOptions = options;
      world.log.push('app.start');
      return app;
    },
    newScenarioContext: async (browser, { umd }) => {
      if (opts.contextThrows) {
        throw new Error('context failed');
      }
      world.browser = browser;
      world.umd = umd;
      world.log.push('context.new');
      return {
        context: {},
        page,
        close: () => {
          world.log.push('context.close');
          if (opts.contextCloseError !== undefined) {
            return Promise.reject(new Error(opts.contextCloseError));
          }
          return opts.contextCloseHangs ? new Promise(() => undefined) : Promise.resolve();
        },
        diagnostics: () => ({
          console: [{ type: 'log', text: opts.consoleText ?? 'hello from the page' }],
          pageErrors: [],
        }),
      };
    },
    createPlaywrightTransport: args => {
      world.transportArgs = args;
      args.onTrace?.({ method: 'observe', callId: 'req_1', kind: 'response', ms: 4 });
      return {
        invoke: async () => ({ kind: 'lost', reason: 'error' }),
        concurrent: true,
        close: async () => {
          world.log.push('transport.close');
        },
      };
    },
    createRecordingHttp: args => {
      world.httpArgs = args;
      const http = async () => undefined;
      http.recorded = () => [];
      return http;
    },
    applyInjection: async args => {
      world.injectionArgs = args;
      const fired = Object.entries(args.scenario.inject).map(([layer, spec]) => ({
        event: 'fired',
        layer,
        mode: spec.mode,
        applied: true,
      }));
      if (!opts.unfiredInjection) fired.forEach(note => args.recorder.record(note));
      return {
        decider: { wrapped: true, inner: args.decider },
        host: { wrapped: true, inner: args.host },
        notes: [{ type: 'fault_injection', event: 'configured' }],
        report: () => ({
          configured: [1],
          fired: opts.unfiredInjection ? [] : fired,
          unfired: opts.unfiredInjection ? [1] : [],
        }),
      };
    },
    readApiKey: () => FAKE_KEY,
    dist: {
      createRedactor: () => ({
        isSensitiveKey: key => /(?:^|[._])(?:password|card|token|secret)(?:$|[._])/i.test(key),
      }),
      redactEnvelope: envelope => ({ method: envelope?.method }),
      createRemoteTaskHost: ({ transport }) =>
        opts.remoteHost ?? {
          hostKind: 'fake',
          transport,
          dispose: async () => {
            world.log.push('host.dispose');
          },
        },
      createTypeSafeTaskDecider: config => {
        world.deciderConfig = config;
        return { kind: 'decider', config };
      },
      createTaskAgent: config => {
        world.agentConfig = config;
        return {
          run: async (request, signal) => {
            world.runRequests.push(request);
            world.signal = signal;
            if (opts.agentRunThrows) {
              throw new Error('agent exploded');
            }
            return (opts.script ?? defaultScript)({
              request,
              signal,
              world,
              onEvent: config.options.onEvent,
            });
          },
          resume: async (request, signal) => {
            world.resumeRequests.push(request);
            const script = opts.resumeScript ?? (async ({ goal }) => results.completed(goal));
            return script({
              request,
              signal,
              world,
              onEvent: config.options.onEvent,
              goal: world.runRequests[0]?.goal,
            });
          },
          cancel: () => {
            world.cancelCalled = true;
            return true;
          },
        };
      },
    },
  };
  return world;
}

const SCRATCH_PREFIX = 'kriya-e2e-selftest-';
// created by runSelftest() and removed in its finally: importing this module must leave nothing behind
let scratch = '';
let evidenceRoot = '';
let runCounter = 0;

async function exec(scenario, opts = {}, extra = {}) {
  const world = makeWorld(opts);
  const runId = `st-${(runCounter += 1)}`;
  const gate = { fake: 'gate' };
  const outcome = await runScenario({
    scenario,
    env: {},
    bundles: { umd: 'fake-umd-text', sha256: 'f'.repeat(64) },
    browser: { fakeBrowser: true },
    gate,
    runId,
    evidenceRoot,
    dist: { sha256: DIST_SHA },
    deps: { ...world.deps, ...(extra.deps ?? {}) },
    ...(extra.args ?? {}),
  });
  world.gate = gate;
  return {
    outcome,
    world,
    dir: path.join(evidenceRoot, runId, scenario.id),
    read: name =>
      JSON.parse(fs.readFileSync(path.join(evidenceRoot, runId, scenario.id, name), 'utf8')),
    has: name => fs.existsSync(path.join(evidenceRoot, runId, scenario.id, name)),
  };
}

const kinds = outcome => (outcome.failures ?? []).map(failure => failure.kind);

// ---------------------------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------------------------

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: text => {
      out += text;
    },
    stderr: text => {
      err += text;
    },
    out: () => out,
    err: () => err,
  };
}

function scenarioSource(list) {
  const body = list
    .map(item => {
      const { expect: _expect, ...data } = item;
      return `{ ...${JSON.stringify(data)}, expect: async () => {} }`;
    })
    .join(',\n');
  return `export const scenarios = [\n${body}\n];\n`;
}

function writeScenarioDir(name, files) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, file),
      typeof content === 'string' ? content : scenarioSource(content)
    );
  }
  return dir;
}

function cliDeps(overrides = {}) {
  const seen = { ids: [], gateLimit: undefined, browserClosed: false, running: 0, peak: 0 };
  return {
    seen,
    deps: {
      preflight: () => ({ ok: true, exitCode: 0, problems: [], chromePath: 'chrome' }),
      checkDist: () => ({ ok: true, exitCode: 0, sha256: 'a'.repeat(64) }),
      readBundles: () => ({ umd: 'u', esmUrl: 'file:///x', sha256: 'a'.repeat(64) }),
      launchBrowser: async () => ({
        close: async () => {
          seen.browserClosed = true;
        },
      }),
      getProcessGate: limit => {
        seen.gateLimit = limit;
        return { gate: limit };
      },
      runScenario: async args => {
        seen.ids.push(args.scenario.id);
        seen.running += 1;
        seen.peak = Math.max(seen.peak, seen.running);
        await sleep(overrides.delayMs ?? 0);
        seen.running -= 1;
        return {
          id: args.scenario.id,
          kind: args.scenario.kind,
          passed: true,
          status: 'completed',
          durationMs: 5,
          calls: 1,
          model: 'jev-1.13.0',
          leak: false,
        };
      },
      ...(overrides.deps ?? {}),
    },
  };
}

async function runCli(argv, { deps, files, root = REPO_ROOT } = {}) {
  const io = capture();
  const dir = writeScenarioDir(`cli-${(runCounter += 1)}`, files ?? {});
  const code = await main({
    argv: ['--scenarios-dir', dir, '--evidence-root', path.join(scratch, 'cli-evidence'), ...argv],
    deps,
    root,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  return { code, out: io.out(), err: io.err() };
}

const demoSet = () => [
  goodLive({ id: 'catalog-a-one', family: 'catalog', variant: 'A', kind: 'live' }),
  goodLive({ id: 'settings-b-two', family: 'settings', variant: 'B', kind: 'live' }),
  goodFault({ id: 'checkout-c-three', family: 'checkout', variant: 'C' }),
  goodLive({ id: 'shipping-a-four', family: 'shipping', variant: 'A', kind: 'live' }),
  goodLive({ id: 'catalog-c-five', family: 'catalog', variant: 'C', kind: 'live' }),
];

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

async function validatorChecks() {
  const sensitiveInputs = sensitive => ({ payment: { password: sensitive.password } });
  await check('validate: accepts a good live scenario', () => {
    const result = validateScenario(goodLive());
    ok(result.ok, result.errors.join('; '));
  });
  await check('validate: accepts a good fault scenario', () => {
    ok(validateScenario(goodFault()).ok);
  });
  await check(
    'validate: accepts function inputs, declarations and resume with sensitive values',
    () => {
      const result = validateScenario(
        goodLive({
          inputs: sensitiveInputs,
          inputDeclarations: sensitive => [
            {
              path: 'payment.password',
              sensitive: true,
              description: String(sensitive.password).length > 0 ? 'secret' : '',
            },
          ],
          resume: [
            {
              on: 'needs_input',
              resolution: sensitive => ({
                kind: 'inputs',
                inputs: { extra: sensitive.otp.length ? 'x' : 'y' },
              }),
            },
          ],
        })
      );
      ok(result.ok, result.errors.join('; '));
    }
  );
  await check('validate: rejects an unknown top-level key', () => {
    const result = validateScenario(goodLive({ steps: ['a'] }));
    ok(!result.ok && hasError(result, 'scenario.steps'), result.errors.join('; '));
  });
  // each bad goal names the rule that must catch it, so one rule cannot hide behind another
  const badGoals = {
    'a URL': ['Open https://shop.example.test/products and find the mouse for me please.', 'url'],
    'a host': ['Go to 127.0.0.1 and find the wireless mouse for me today.', 'url'],
    'an absolute path': [
      'Please use /settings/notifications to turn the digest off for me.',
      'path',
    ],
    'a page file name': ['Open checkout.html and fill in my details for the order please.', 'file'],
    'a CSS selector': [
      'Turn off the digest using #notify-digest for my account please.',
      'selector',
    ],
    'a class selector': [
      'Find the mouse then use the .product-card .buy-now control please.',
      'selector',
    ],
    'a click instruction': [
      'Click the Save button after you turned the digest off for me.',
      'click',
    ],
    'a numbered list': ['Do this for me:\n1. open the settings\n2. turn the digest off', 'steps'],
    'a step reference': [
      'In step 2 turn the weekly digest off and then check that it saved.',
      'steps',
    ],
    'a quoted label as instruction': [
      "Press the 'Save changes' button once the digest is off for me.",
      'control_instruction',
    ],
    'a labelled control': [
      'Turn off the switch called Promotional emails in my account please.',
      'control_instruction',
    ],
    'an expected phrase': [
      "Turn the digest off until you see 'Saved' on the page for my account.",
      'expected_text',
    ],
    'a count of steps': [
      'Turn the weekly digest off in 3 steps for my account, nothing else.',
      'steps',
    ],
    'a count of clicks': [
      'Turn the weekly digest off in 3 clicks for my account, nothing else.',
      'steps',
    ],
  };
  for (const [label, [goal, code]] of Object.entries(badGoals)) {
    await check(`validate: rejects a goal with ${label}`, () => {
      const result = validateScenario(goodLive({ goal }));
      ok(
        !result.ok &&
          result.errors.some(error => error.startsWith('goal ') && error.includes(`(${code})`)),
        `expected rule ${code}: ${result.errors.join('; ')}`
      );
    });
  }
  await check('validate: rejects control, bidi and zero-width characters in a goal', () => {
    const base = 'Turn the weekly digest off for my account and leave the rest alone.';
    for (const code of [0x200b, 0x200f, 0x202e, 0x2066, 0x0007, 0x007f, 0x0000]) {
      const goal = `${base.slice(0, 20)}${String.fromCharCode(code)}${base.slice(20)}`;
      const result = validateScenario(goodLive({ goal }));
      ok(
        !result.ok && hasError(result, 'control, bidi or zero-width'),
        `U+${code.toString(16)}: ${result.errors.join('; ')}`
      );
    }
    for (const fine of ['\t', '\n', ' ', String.fromCharCode(0x00e9)]) {
      const goal = `${base.slice(0, 20)}${fine}${base.slice(20)}`;
      ok(
        validateScenario(goodLive({ goal })).ok,
        `U+${fine.charCodeAt(0).toString(16)} is ordinary`
      );
    }
  });
  await check('validate: title is one line of 1 to 160 characters', () => {
    ok(!validateScenario(goodLive({ title: 'two\nlines' })).ok, 'multi-line');
    ok(!validateScenario(goodLive({ title: '   ' })).ok, 'blank');
    ok(!validateScenario(goodLive({ title: 'x'.repeat(161) })).ok, 'too long');
    ok(validateScenario(goodLive({ title: 'x'.repeat(160) })).ok, 'exactly 160');
  });
  await check(
    'validate: accepts goals with a quoted literal, "first name" and "click and collect"',
    () => {
      for (const goal of [
        "Search for 'wireless mouse' and narrow it to the Electronics category for me.",
        'Fill in my shipping details with first name Ada and last name Lovelace please.',
        'Choose the click and collect delivery option for this order, nothing more.',
        'Turn off promotional emails but keep product updates switched on for me.',
      ]) {
        const result = validateScenario(goodLive({ goal }));
        ok(result.ok, `${goal} -> ${result.errors.join('; ')}`);
      }
    }
  );
  await check('validate: a goal may be quoted, accented, multi-line prose without any hint', () => {
    const prose = [
      "Search for 'café table' and keep only the Home category for me, thanks.",
      'Please sort out the weekly digest for my account.\nLeave every other preference as it is.',
    ];
    for (const goal of prose) {
      const result = validateScenario(goodLive({ goal }));
      ok(result.ok, `${goal} -> ${result.errors.join('; ')}`);
    }
  });
  await check('validate: rejects a goal longer than 1500 bytes', () => {
    ok(!validateScenario(goodLive({ goal: `Find the mouse ${'x'.repeat(1600)}` })).ok);
  });
  await check('validate: rejects an unknown inject decider mode and host mode', () => {
    ok(
      !validateScenario(goodFault({ inject: { decider: { mode: 'explode', atDecision: 1 } } })).ok
    );
    ok(!validateScenario(goodFault({ inject: { host: { mode: 'melt', atExecution: 1 } } })).ok);
  });
  await check(
    'validate: rejects bad inject details (counts, stray keys, misplaced options)',
    () => {
      ok(!validateScenario(goodFault({ inject: { decider: { mode: 'slow', atDecision: 0 } } })).ok);
      ok(
        !validateScenario(
          goodFault({ inject: { decider: { mode: 'throw', atDecision: 1, stray: 1 } } })
        ).ok
      );
      ok(
        !validateScenario(
          goodFault({ inject: { decider: { mode: 'prematureDone', atDecision: 1, ms: 5 } } })
        ).ok
      );
      ok(
        !validateScenario(
          goodFault({ inject: { host: { mode: 'slowObserve', atExecution: 1, timing: 'before' } } })
        ).ok
      );
      ok(!validateScenario(goodFault({ inject: { other: {} } })).ok);
      ok(
        validateScenario(
          goodFault({ inject: { host: { mode: 'slowObserve', atExecution: 2, ms: 500 } } })
        ).ok
      );
    }
  );
  await check('validate: inject is forbidden on live and required on fault', () => {
    const live = validateScenario(
      goodLive({ inject: { decider: { mode: 'throw', atDecision: 1 } } })
    );
    ok(
      !live.ok && hasError(live, 'only allowed on a scenario of kind fault'),
      live.errors.join('; ')
    );
    const fault = validateScenario(goodFault({ inject: undefined }));
    ok(!fault.ok && hasError(fault, 'needs an inject object'), fault.errors.join('; '));
  });
  await check('validate: expectStatus must be known, non-empty and distinct', () => {
    ok(!validateScenario(goodLive({ expectStatus: 'done' })).ok);
    ok(!validateScenario(goodLive({ expectStatus: [] })).ok);
    ok(!validateScenario(goodLive({ expectStatus: ['failed', 'failed'] })).ok);
    ok(!validateScenario(goodLive({ expectStatus: undefined })).ok);
    ok(validateScenario(goodLive({ expectStatus: ['blocked', 'needs_input'] })).ok);
  });
  await check('validate: resume entries are checked, nested approval form accepted', () => {
    ok(!validateScenario(goodLive({ resume: [{ on: 'completed', resolution: {} }] })).ok);
    ok(
      !validateScenario(
        goodLive({ resume: [{ on: 'awaiting_approval', resolution: { decision: 'maybe' } }] })
      ).ok
    );
    ok(!validateScenario(goodLive({ resume: [{ on: 'needs_input', resolution: {} }] })).ok);
    ok(
      !validateScenario(
        goodLive({
          resume: [{ on: 'awaiting_approval', resolution: { decision: 'approve', nonce: 'x' } }],
        })
      ).ok
    );
    ok(
      validateScenario(
        goodLive({
          resume: [{ on: 'awaiting_approval', resolution: { decision: 'approve', scope: 'once' } }],
        })
      ).ok
    );
    const nested = validateScenario(
      goodLive({
        resume: [
          {
            on: 'awaiting_approval',
            resolution: { kind: 'approval', resolution: { decision: 'deny' } },
          },
        ],
      })
    );
    ok(nested.ok, nested.errors.join('; '));
    ok(
      validateScenario(
        goodLive({
          resume: [{ on: 'needs_input', resolution: { kind: 'inputs', inputs: { a: 'b' } } }],
        })
      ).ok
    );
  });
  await check(
    'validate: a scenario that throws while being read is a failed validation, not a crash',
    () => {
      const hostile = goodLive();
      Object.defineProperty(hostile, 'goal', {
        enumerable: true,
        get() {
          throw new Error('getter exploded');
        },
      });
      const result = validateScenario(hostile);
      ok(!result.ok && hasError(result, 'validation threw'), result.errors.join('; '));
    }
  );
  await check('validate: expect must be a function', () => {
    ok(!validateScenario(goodLive({ expect: 'nope' })).ok);
  });
  await check(
    'validate: inputs may not hold URLs, selectors or click instructions; plain data passes',
    () => {
      ok(!validateScenario(goodLive({ inputs: { page: 'https://shop.example.test/cart' } })).ok);
      ok(!validateScenario(goodLive({ inputs: { target: '#buy-now' } })).ok);
      ok(!validateScenario(goodLive({ inputs: { how: 'click the green button' } })).ok);
      ok(!validateScenario(goodLive({ inputs: { path: '/checkout/review' } })).ok);
      ok(
        validateScenario(
          goodLive({
            inputs: {
              line1: '221B Baker Street',
              email: 'ada@example.test',
              delivery: 'Click and collect',
            },
          })
        ).ok
      );
    }
  );
  await check('validate: id, family, variant and kind are checked', () => {
    ok(!validateScenario(goodLive({ id: 'Catalog_A' })).ok);
    ok(!validateScenario(goodLive({ family: 'billing' })).ok);
    ok(!validateScenario(goodLive({ variant: 'D' })).ok);
    ok(!validateScenario(goodLive({ kind: 'maybe' })).ok);
    ok(!validateScenario(null).ok);
  });
  await check('validate: authorization and run blocks are checked; $app is the only origin', () => {
    ok(
      validateScenario(goodLive({ authorization: { effects: ['purchase'], origins: ['$app'] } })).ok
    );
    ok(!validateScenario(goodLive({ authorization: { origins: ['http://127.0.0.1:1'] } })).ok);
    ok(!validateScenario(goodLive({ authorization: { effects: ['teleport'] } })).ok);
    ok(!validateScenario(goodLive({ authorization: { grant: 1 } })).ok);
    ok(
      validateScenario(
        goodLive({ run: { budgets: { maxSteps: 5 }, cancelAfterMs: 2000, allowRunLoss: false } })
      ).ok
    );
    ok(!validateScenario(goodLive({ run: { budgets: { maxCoffee: 5 } } })).ok);
    ok(!validateScenario(goodLive({ run: { speed: 1 } })).ok);
    ok(!validateScenario(goodLive({ run: { cancelAfterMs: 0 } })).ok);
  });
  await check(
    'validate: app options are cross-checked against describe() when apps are given',
    async () => {
      const catalog = await import('../apps/catalog.mjs');
      const apps = { catalog: catalog.describe() };
      ok(
        validateScenario(goodLive({ faults: { rerenderEveryMs: 1200 }, initial: { cart: [] } }), {
          apps,
        }).ok
      );
      const badFault = validateScenario(goodLive({ faults: { teleport: true } }), { apps });
      ok(!badFault.ok && hasError(badFault, 'faults.teleport'), badFault.errors.join('; '));
      const badInitial = validateScenario(goodLive({ initial: { colour: 'red' } }), { apps });
      ok(!badInitial.ok && hasError(badInitial, 'initial.colour'), badInitial.errors.join('; '));
      ok(
        validateScenario(goodLive({ faults: { teleport: true } })).ok,
        'without apps nothing is cross-checked'
      );
    }
  );
  await check('validate: declarations are strict', () => {
    ok(!validateScenario(goodLive({ inputDeclarations: [{ path: 'a', sensitive: 'yes' }] })).ok);
    ok(
      !validateScenario(goodLive({ inputDeclarations: [{ path: 'a', sensitive: true, tag: 1 }] }))
        .ok
    );
    ok(validateScenario(goodLive({ inputDeclarations: { 'payment.cardNumber': true } })).ok);
    ok(
      !validateScenario(
        goodLive({
          inputDeclarations: [{ path: 'a', sensitive: true, bind: { origins: ['http://x'] } }],
        })
      ).ok
    );
  });
  await check(
    'text rules: library text mode flags routes and selectors but not ordinary wording',
    () => {
      eq(findTextProblems('Pick the element to click next by its id t12.', 'library'), []);
      ok(
        findTextProblems('Open /settings/notifications now', 'library').some(p => p.code === 'path')
      );
      ok(findTextProblems('Use #save-btn', 'library').some(p => p.code === 'selector'));
      ok(
        findTextProblems('Use input[name=email] next', 'library').some(p => p.code === 'selector')
      );
      ok(findTextProblems('Use button.primary next', 'library').some(p => p.code === 'selector'));
      for (const ordinary of [
        'Answer [DONE] when the goal is met.',
        'Options t12.1 and t12.2 belong to t12.',
        'Note: disabled controls cannot be used; state:checked is a value.',
        'Pick yes / no, and/or read-only data.',
      ]) {
        eq(findTextProblems(ordinary, 'library'), [], ordinary);
      }
      ok(findTextProblems('See https://x.example.test/a', 'library').some(p => p.code === 'url'));
    }
  );
  await check('validate: unsafe keys in inputs are rejected', () => {
    const inputs = JSON.parse('{"a":{"__proto__":{"x":1}}}');
    ok(!validateScenario(goodLive({ inputs })).ok);
    for (const text of [
      '{"a":{"constructor":{"x":1}}}',
      '{"prototype":1}',
      '{"list":[{"deep":{"__proto__":1}}]}',
    ]) {
      const result = validateScenario(goodLive({ inputs: JSON.parse(text) }));
      ok(!result.ok && hasError(result, 'unsafe key'), `${text}: ${result.errors.join('; ')}`);
    }
    ok(validateScenario(goodLive({ inputs: { protocol: 'a', constructors: 'b' } })).ok);
  });
  await check(
    'validate: resume.on is one of the pause statuses whatever the resolution says',
    () => {
      const result = validateScenario(
        goodLive({ resume: [{ on: 'completed', resolution: { decision: 'approve' } }] })
      );
      ok(!result.ok && hasError(result, 'resume.0.on must be one of'), result.errors.join('; '));
    }
  );
  await check('validate: cancelAfterMs is an integer from 1 to 600000', () => {
    ok(validateScenario(goodLive({ run: { cancelAfterMs: 600000 } })).ok);
    ok(!validateScenario(goodLive({ run: { cancelAfterMs: 600001 } })).ok, 'above the cap');
    ok(!validateScenario(goodLive({ run: { cancelAfterMs: 1.5 } })).ok, 'not an integer');
  });
  await check(
    'validate: forbiddenInstructionText is a list of phrases of 3 or more characters',
    () => {
      ok(validateScenario(goodLive({ forbiddenInstructionText: ['abc', 'order confirmed'] })).ok);
      ok(!validateScenario(goodLive({ forbiddenInstructionText: ['ab'] })).ok, 'too short');
      ok(!validateScenario(goodLive({ forbiddenInstructionText: 'abc' })).ok, 'not a list');
      ok(!validateScenario(goodLive({ forbiddenInstructionText: [5] })).ok, 'not a string');
    }
  );
  await check('validate: a sensitive value is never a literal in the scenario source', () => {
    const literal = validateScenario(
      goodLive({
        inputs: { payment: { card: 'literal-value-1' } },
        inputDeclarations: [{ path: 'payment.card', sensitive: true }],
      })
    );
    ok(
      !literal.ok && hasError(literal, 'declared sensitive but written as a literal'),
      literal.errors.join('; ')
    );
    const generated = validateScenario(
      goodLive({
        inputs: sensitive => ({ payment: { card: sensitive.cardNumber } }),
        inputDeclarations: [{ path: 'payment.card', sensitive: true }],
      })
    );
    ok(generated.ok, generated.errors.join('; '));
    const plain = validateScenario(
      goodLive({
        inputs: { name: 'Ada', payment: { card: 'literal-value-1' } },
        inputDeclarations: [{ path: 'payment.card', sensitive: false }],
      })
    );
    ok(plain.ok, 'a non-sensitive literal is data');
    const resume = validateScenario(
      goodLive({
        resume: [
          { on: 'needs_input', resolution: { inputs: {}, sensitiveInputs: { pin: 'abc' } } },
        ],
      })
    );
    ok(!resume.ok && hasError(resume, 'sensitiveInputs is a literal'), resume.errors.join('; '));
    const resumeFn = validateScenario(
      goodLive({
        resume: [
          {
            on: 'needs_input',
            resolution: sensitive => ({ inputs: {}, sensitiveInputs: { pin: sensitive.otp } }),
          },
        ],
      })
    );
    ok(resumeFn.ok, resumeFn.errors.join('; '));
  });
  await check(
    'declaresSensitive: function forms, sensitive declarations and sensitive resumes count',
    () => {
      ok(!declaresSensitive(goodLive()));
      ok(declaresSensitive(goodLive({ inputs: sensitive => ({ a: sensitive.password }) })));
      ok(declaresSensitive(goodLive({ inputDeclarations: [{ path: 'a', sensitive: true }] })));
      ok(!declaresSensitive(goodLive({ inputDeclarations: [{ path: 'a', sensitive: false }] })));
      ok(
        declaresSensitive(
          goodLive({ resume: [{ on: 'needs_input', resolution: { sensitiveInputs: { a: 'x' } } }] })
        )
      );
      ok(
        declaresSensitive(
          goodLive({
            resume: [
              {
                on: 'needs_input',
                resolution: { inputs: {}, inputDeclarations: [{ path: 'a', sensitive: true }] },
              },
            ],
          })
        )
      );
      ok(
        !declaresSensitive(
          goodLive({ resume: [{ on: 'needs_input', resolution: { inputs: {} } }] })
        )
      );
    }
  );
}

async function loaderChecks() {
  await check(
    'loadScenarios: loads scenarios, skips *.controls.mjs, accepts several exports',
    async () => {
      const dir = writeScenarioDir('load-ok', {
        'a.mjs': [goodLive({ id: 'catalog-a-one' }), goodLive({ id: 'catalog-a-two' })],
        'a.controls.mjs': 'throw new Error("controls must not be imported");\n',
        'b.mjs': `export const scenario = ${JSON.stringify(goodLive({ id: 'settings-a-one', family: 'settings' }))};\nscenario.expect = async () => {};\n`,
      });
      const loaded = await loadScenarios(dir);
      eq(
        loaded.map(item => item.id),
        ['catalog-a-one', 'catalog-a-two', 'settings-a-one']
      );
    }
  );
  await check('loadScenarios: duplicate ids and import failures are reported', async () => {
    const dupDir = writeScenarioDir('load-dup', {
      'a.mjs': [goodLive({ id: 'catalog-a-one' })],
      'b.mjs': [goodLive({ id: 'catalog-a-one' })],
    });
    await rejects(() => loadScenarios(dupDir), 'duplicates must throw');
    const badDir = writeScenarioDir('load-bad', {
      'a.mjs': 'export const scenarios = [ ;\n',
      'b.mjs': 'export const unrelated = 1;\n',
    });
    const { errors } = await loadScenarioFiles(badDir);
    eq(
      errors.map(error => error.file),
      ['a.mjs', 'b.mjs']
    );
    const missing = await loadScenarioFiles(path.join(scratch, 'no-such-dir'));
    ok(missing.errors.length === 1);
  });
  await check(
    'scenario modes agree with faults.mjs (decider and host modes, accepted and rejected configs)',
    async () => {
      let faults;
      try {
        faults = await import('./faults.mjs');
      } catch {
        throw new Error('faults.mjs is not importable, so the lists cannot be compared');
      }
      eq([...DECIDER_MODES].sort(), [...faults.DECIDER_FAULT_MODES].sort(), 'decider modes');
      eq([...HOST_MODES].sort(), [...faults.HOST_FAULT_MODES].sort(), 'host modes');
      const samples = [
        { decider: { mode: 'slow', atDecision: 2, ms: 100 } },
        { decider: { mode: 'throw', atDecision: 1, style: 'result' } },
        { decider: { mode: 'noneAppropriate', atDecision: 1, stage: 'argument' } },
        { decider: { mode: 'prematureDone', atDecision: 1, ms: 5 } },
        { decider: { mode: 'invalidTarget', atDecision: 0 } },
        { host: { mode: 'contextDestroyed', atExecution: 1, timing: 'before' } },
        { host: { mode: 'slowObserve', atExecution: 1, ms: 5 } },
        { host: { mode: 'staleBeforeExecute', atExecution: 1, ms: 5 } },
        { host: { mode: 'lostAfterCommit', atExecution: 'x' } },
        {
          decider: { mode: 'throw', atDecision: 1 },
          host: { mode: 'lostAfterCommit', atExecution: 1 },
        },
        {},
      ];
      for (const inject of samples) {
        const mine = validateScenario(goodFault({ inject })).ok;
        const theirs = faults.validateInjection(inject).ok;
        ok(mine === theirs, `validators disagree on ${JSON.stringify(inject)}`);
      }
    }
  );
  await check(
    'scenario copies of the contract lists (host operations, commitment effects, budgets, statuses) match src/types/agent.ts',
    () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'types', 'agent.ts'), 'utf8');
      const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
      const constList = name => {
        const found = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
        ok(found !== null, `${name} not found in src/types/agent.ts`);
        return quoted(found[1]);
      };
      eq(HOST_OPERATIONS, constList('TASK_HOST_OPERATIONS'), 'host operations');
      eq(COMMITMENT_EFFECTS, constList('TASK_COMMITMENT_EFFECTS'), 'commitment effects');
      const union = source.match(/export type TaskStatus =([^;]*);/);
      ok(union !== null, 'TaskStatus not found');
      eq([...TASK_STATUSES].sort(), quoted(union[1]).sort(), 'statuses');
      const budgets = source.match(/export type TaskBudgets = \{([\s\S]*?)\n\};/);
      ok(budgets !== null, 'TaskBudgets not found');
      const keys = [...budgets[1].matchAll(/^\s{2}readonly (\w+): number;/gm)].map(
        match => match[1]
      );
      eq([...BUDGET_KEYS].sort(), keys.sort(), 'budget keys');
    }
  );
  const scenarioDir = path.join(REPO_ROOT, 'e2e', 'scenarios');
  const loaded = await loadScenarioFiles(scenarioDir);
  const catalog = {};
  for (const family of ['catalog', 'settings', 'shipping', 'checkout']) {
    try {
      catalog[family] = (await import(`../apps/${family}.mjs`)).describe();
    } catch {
      // cross-check disabled for that family
    }
  }
  const problems = [
    ...loaded.errors.map(error => `${error.file}: ${error.message}`),
    ...loaded.entries.flatMap(({ scenario }) =>
      validateScenario(scenario, { apps: catalog }).errors.map(error => `${scenario.id}: ${error}`)
    ),
  ];
  tally.info.push(
    `integration: ${loaded.entries.length} scenario(s) in e2e/scenarios, ${problems.length} problem(s)${problems.length > 0 ? `: ${problems.slice(0, 3).join(' | ')}` : ''}`
  );
}

async function evidenceChecks() {
  const dirFor = name => {
    const dir = path.join(scratch, `scan-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const secret = `Zq${randomBytes(6).toString('hex')}-!x`;
  const tricky = `pa"ss\\w&rd ${randomBytes(4).toString('hex')}`;
  await check(
    'scan: positive control finds the exact value (and names file and label, never the value)',
    () => {
      const dir = dirFor('exact');
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ note: `x ${secret} y` }));
      const scan = scanForSecrets(dir, [{ label: 'demo', value: secret }]);
      eq(
        scan.hits.map(hit => [hit.file, hit.label, hit.variant]),
        [['a.json', 'demo', 'exact']]
      );
      ok(!JSON.stringify(scan).includes(secret), 'the scan result must not hold the value');
      ok(scan.scanned === 1 && scan.valuesChecked === 1);
    }
  );
  await check(
    'scan: negative control on a clean directory finds nothing and reports what it scanned',
    () => {
      const dir = dirFor('clean');
      fs.writeFileSync(path.join(dir, 'a.json'), '{"ok":true}');
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, 'nested', 'b.txt'), 'nothing to see');
      const scan = scanForSecrets(dir, [secret, tricky]);
      ok(scan.hits.length === 0 && scan.scanned === 2 && scan.valuesChecked === 2);
    }
  );
  await check('scan: a missing directory measures nothing (scanned 0)', () => {
    eq(scanForSecrets(path.join(scratch, 'absent'), [secret]).scanned, 0);
  });
  await check('scan: JSON-escaped and double-escaped variants are found', () => {
    const dir = dirFor('json');
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ v: tricky }));
    fs.writeFileSync(
      path.join(dir, 'b.json'),
      JSON.stringify({ body: JSON.stringify({ v: tricky }) })
    );
    const hits = scanForSecrets(dir, [{ label: 't', value: tricky }]).hits;
    ok(
      hits.some(hit => hit.file === 'a.json' && hit.variant === 'json'),
      'single escape'
    );
    ok(
      hits.some(hit => hit.file === 'b.json'),
      'double escape'
    );
  });
  await check('scan: URL-encoded (percent and plus) and HTML-escaped variants are found', () => {
    const dir = dirFor('url');
    fs.writeFileSync(path.join(dir, 'a.txt'), `GET /x?v=${encodeURIComponent(tricky)}`);
    fs.writeFileSync(
      path.join(dir, 'b.txt'),
      `v=${encodeURIComponent(tricky).replace(/%20/g, '+')}`
    );
    fs.writeFileSync(
      path.join(dir, 'c.html'),
      `<input value="${tricky.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
    );
    const files = scanForSecrets(dir, [tricky])
      .hits.map(hit => hit.file)
      .sort();
    eq(files, ['a.txt', 'b.txt', 'c.html']);
  });
  await check(
    'scan: form-encoded values are found (apostrophe, parentheses, tilde and bang are escaped there only)',
    () => {
      const dir = dirFor('form');
      const awkward = `it's (ok)~! ${randomBytes(3).toString('hex')}`;
      const form = new URLSearchParams({ v: awkward }).toString().slice(2);
      ok(form !== encodeURIComponent(awkward).replace(/%20/g, '+'), 'the control must differ');
      fs.writeFileSync(path.join(dir, 'body.txt'), `v=${form}&other=1`);
      const hits = scanForSecrets(dir, [{ label: 'awkward', value: awkward }]).hits;
      ok(
        hits.some(hit => hit.file === 'body.txt' && hit.variant === 'url'),
        'form-encoded body'
      );
      ok(
        redactSecrets(`v=${form}`, [awkward]) === 'v=[REDACTED]',
        'redactSecrets knows the same variants'
      );
    }
  );
  await check('scan: HTML text and attribute serializations are found', () => {
    const dir = dirFor('html-contexts');
    const mixed = `a<b & "c" ${randomBytes(3).toString('hex')}`;
    fs.writeFileSync(
      path.join(dir, 'text.html'),
      `<p>${mixed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
    );
    fs.writeFileSync(
      path.join(dir, 'attr.html'),
      `<input value="${mixed.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
    );
    const quoted = `o'brien <x> & "y" ${randomBytes(3).toString('hex')}`;
    fs.writeFileSync(
      path.join(dir, 'full.html'),
      `<p data-x='${quoted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}'></p>`
    );
    const files = scanForSecrets(dir, [mixed, quoted])
      .hits.map(hit => hit.file)
      .sort();
    eq(files, ['attr.html', 'full.html', 'text.html']);
  });
  await check(
    'scan: lower-case percent encoding is found too (some servers and loggers lower-case it)',
    () => {
      const dir = dirFor('lowercase-percent');
      const slashed = `path/to/${randomBytes(4).toString('hex')}/Zq?x=1`;
      const lower = encodeURIComponent(slashed).replace(/%[0-9A-F]{2}/g, match =>
        match.toLowerCase()
      );
      ok(lower !== encodeURIComponent(slashed), 'the control must differ from the upper-case form');
      fs.writeFileSync(path.join(dir, 'log.txt'), `GET /x?v=${lower} 200`);
      const hits = scanForSecrets(dir, [slashed]).hits;
      ok(
        hits.some(hit => hit.file === 'log.txt' && hit.variant === 'url'),
        JSON.stringify(hits)
      );
      eq(redactSecrets(`v=${lower}`, [slashed]), 'v=[REDACTED]');
    }
  );
  await check(
    'scan: a value that cannot be URL-encoded (lone surrogate) does not break the scan',
    () => {
      const dir = dirFor('surrogate');
      const odd = `before-${String.fromCharCode(0xd800)}-after-${randomBytes(2).toString('hex')}`;
      fs.writeFileSync(path.join(dir, 'a.txt'), 'clean');
      const scan = scanForSecrets(dir, [{ label: 'odd', value: odd }]);
      ok(scan.hits.length === 0 && scan.scanned === 1 && scan.valuesChecked === 1);
      ok(secretVariants(odd).some(variant => variant.kind === 'exact'));
      ok(typeof redactSecrets(odd, [odd]) === 'string');
    }
  );
  await check('scan: card numbers are found grouped with spaces, dashes and digits only', () => {
    const dir = dirFor('card');
    const card = ['4242', '4242', '4242', '4242'];
    fs.writeFileSync(path.join(dir, 'a.txt'), card.join(' '));
    fs.writeFileSync(path.join(dir, 'b.txt'), card.join('-'));
    fs.writeFileSync(path.join(dir, 'c.txt'), card.join(''));
    const files = scanForSecrets(dir, [card.join('')])
      .hits.map(hit => hit.file)
      .sort();
    eq(files, ['a.txt', 'b.txt', 'c.txt']);
  });
  await check('scan: binary files and nested directories are scanned', () => {
    const dir = dirFor('binary');
    fs.mkdirSync(path.join(dir, 'screenshots'));
    fs.writeFileSync(
      path.join(dir, 'screenshots', 'x.png'),
      Buffer.concat([PNG, Buffer.from(secret)])
    );
    eq(
      scanForSecrets(dir, [secret]).hits.map(hit => hit.file),
      ['screenshots/x.png']
    );
  });
  await check(
    'scan: values that are too short or short numbers are skipped and listed by label',
    () => {
      const dir = dirFor('short');
      fs.writeFileSync(path.join(dir, 'a.txt'), '123 12/30 abc');
      const scan = scanForSecrets(dir, [
        { label: 'cvc', value: '123' },
        { label: 'otp', value: '123456' },
        { label: 'expiry', value: '12/30' },
      ]);
      eq(scan.skipped.sort(), ['cvc', 'expiry', 'otp']);
      ok(scan.valuesChecked === 0 && scan.hits.length === 0);
    }
  );
  await check('scan: accepts an object of labels and values', () => {
    const dir = dirFor('map');
    fs.writeFileSync(path.join(dir, 'a.txt'), secret);
    eq(scanForSecrets(dir, { demo: secret }).hits[0].label, 'demo');
  });
  await check(
    'finalize: scrubs hit files (text rewritten, binary removed) and a rescan is clean',
    () => {
      const writer = createEvidenceWriter({
        runId: 'fin',
        scenarioId: 'one',
        root: path.join(scratch, 'fin'),
      });
      writer.write('a.json', { leak: secret });
      fs.mkdirSync(path.join(writer.dir, 'screenshots'));
      fs.writeFileSync(
        path.join(writer.dir, 'screenshots', 'x.png'),
        Buffer.concat([PNG, Buffer.from(secret)])
      );
      writer.write('clean.json', { fine: true });
      const outcome = writer.finalize([{ label: 'demo', value: secret }]);
      eq(outcome.hits.map(hit => hit.file).sort(), ['a.json', 'screenshots/x.png']);
      eq(outcome.scrubbed, ['a.json']);
      eq(outcome.removed, ['screenshots/x.png']);
      ok(scanForSecrets(writer.dir, [secret]).hits.length === 0, 'rescan must be clean');
      ok(fs.readFileSync(path.join(writer.dir, 'a.json'), 'utf8').includes('[REDACTED]'));
      ok(fs.existsSync(path.join(writer.dir, 'clean.json')));
    }
  );
  await check('writer: a non-empty scenario directory is refused, an empty one is fine', () => {
    const root = path.join(scratch, 'reuse');
    const first = createEvidenceWriter({ runId: 'r', scenarioId: 's', root });
    createEvidenceWriter({ runId: 'r', scenarioId: 's', root });
    first.write('a.json', { a: 1 });
    let message = '';
    try {
      createEvidenceWriter({ runId: 'r', scenarioId: 's', root });
    } catch (error) {
      message = String(error.message);
    }
    ok(message.includes('already holds files'), message);
    ok(fs.existsSync(path.join(first.dir, 'a.json')), 'the existing file is untouched');
  });
  await check('writer: json, text and binary writes, nested names, traversal rejected', () => {
    const writer = createEvidenceWriter({
      runId: 'w',
      scenarioId: 's',
      root: path.join(scratch, 'writer'),
    });
    writer.write('a.json', { n: 1n, e: new Error('boom') });
    writer.write('failure/log.txt', 'text');
    writer.write('b.bin', Buffer.from([1, 2, 3]));
    const circular = {};
    circular.self = circular;
    writer.write('c.json', circular);
    ok(fs.readFileSync(path.join(writer.dir, 'a.json'), 'utf8').includes('"1"'));
    ok(fs.readFileSync(path.join(writer.dir, 'c.json'), 'utf8').includes('[Circular]'));
    for (const bad of ['../x.json', '/abs.json', 'a/../../x', '.hidden', 'a//b']) {
      let threw = false;
      try {
        writer.write(bad, {});
      } catch {
        threw = true;
      }
      ok(threw, `${bad} must be rejected`);
    }
    for (const bad of [
      { runId: '..', scenarioId: 'x' },
      { runId: 'a/b', scenarioId: 'x' },
      { runId: 'a..b', scenarioId: 'x' },
      { runId: 'a', scenarioId: 'x..y' },
      { runId: 'a', scenarioId: '' },
    ]) {
      let threw = false;
      try {
        createEvidenceWriter({ ...bad, root: scratch });
      } catch {
        threw = true;
      }
      ok(threw, `${JSON.stringify(bad)} must be rejected`);
    }
  });
  await check(
    'writer.screenshot: writes through the page, reports failures without throwing',
    async () => {
      const writer = createEvidenceWriter({
        runId: 'shot',
        scenarioId: 's',
        root: path.join(scratch, 'shots'),
      });
      const page = { screenshot: async ({ path: target }) => fs.writeFileSync(target, PNG) };
      const good = await writer.screenshot(page, 'step-00-initial');
      ok(good.ok && fs.existsSync(path.join(writer.dir, 'screenshots', 'step-00-initial.png')));
      const bad = await writer.screenshot(
        {
          screenshot: async () => {
            throw new Error('page closed');
          },
        },
        'final'
      );
      ok(!bad.ok && !fs.existsSync(path.join(writer.dir, 'screenshots', 'final.png')));
      const traversal = await writer.screenshot(page, '../evil');
      ok(!traversal.ok);
    }
  );
  await check(
    'redactSecrets: replaces every variant, longest first, and passes non-strings through',
    () => {
      const text = `a ${tricky} b ${encodeURIComponent(tricky)} c ${JSON.stringify(tricky).slice(1, -1)}`;
      const redacted = redactSecrets(text, [tricky]);
      ok(!redacted.includes(tricky) && !redacted.includes(encodeURIComponent(tricky)));
      ok(redacted.split('[REDACTED]').length === 4);
      eq(redactSecrets(undefined, [tricky]), undefined);
      eq(redactSecrets('plain text', [tricky]), 'plain text');
    }
  );
  await check(
    'redactSecrets: the longer of two overlapping secrets wins, whatever the order',
    () => {
      const short = `Qx${randomBytes(4).toString('hex')}`;
      const long = `${short}-tail${randomBytes(2).toString('hex')}`;
      for (const list of [
        [short, long],
        [long, short],
      ]) {
        eq(
          redactSecrets(`a ${long} b`, list),
          'a [REDACTED] b',
          'no tail of the longer secret may remain'
        );
      }
      eq(redactSecrets(`a ${short} b`, [short, long]), 'a [REDACTED] b');
    }
  );
  await check('scan: a secret with surrounding whitespace is also found trimmed', () => {
    const dir = dirFor('trim');
    const core = `Zq${randomBytes(5).toString('hex')}`;
    fs.writeFileSync(path.join(dir, 'a.txt'), `value=${core};`);
    const hits = scanForSecrets(dir, [{ label: 'padded', value: `  ${core}  ` }]).hits;
    ok(
      hits.some(hit => hit.file === 'a.txt' && hit.label === 'padded'),
      JSON.stringify(hits)
    );
    eq(redactSecrets(`value=${core};`, [`  ${core}  `]), 'value=[REDACTED];');
  });
  await check('secretVariants: kinds cover exact, json, url, html and digits', () => {
    const kindsSeen = new Set(secretVariants(tricky).map(variant => variant.kind));
    for (const kind of ['exact', 'json', 'url', 'html']) {
      ok(kindsSeen.has(kind), kind);
    }
    ok(
      new Set(
        secretVariants(['4242', '4242', '4242', '4242'].join('')).map(variant => variant.kind)
      ).has('digits')
    );
  });
  await check('safeStringify: handles bigint, errors, circular references and undefined', () => {
    ok(safeStringify({ a: 1n }).includes('"1"'));
    ok(safeStringify(undefined) === 'null');
    const shared = { x: 1 };
    const out = safeStringify({ one: shared, two: shared });
    ok(!out.includes('Circular'), 'shared references are not cycles');
  });
}

async function sensitiveChecks() {
  await check(
    'sensitive: same seed gives the same values, different seeds differ, no seed is random',
    () => {
      const a = generateSensitiveValues('seed-1');
      eq(a, generateSensitiveValues('seed-1'));
      ok(a.password !== generateSensitiveValues('seed-2').password);
      ok(generateSensitiveValues().password !== generateSensitiveValues().password);
    }
  );
  await check(
    'sensitive: password mixes classes, card number is a Luhn-valid 16 digits, cvc is 3 digits',
    () => {
      const values = generateSensitiveValues('shape');
      ok(/[A-Z]/.test(values.password) && /[a-z]/.test(values.password));
      ok(/\d/.test(values.password) && /[!$_+-]/.test(values.password));
      ok(/^\d{16}$/.test(values.cardNumber));
      const sum = [...values.cardNumber]
        .reverse()
        .map(Number)
        .reduce(
          (total, digit, index) =>
            total + (index % 2 === 1 ? (digit * 2 > 9 ? digit * 2 - 9 : digit * 2) : digit),
          0
        );
      ok(sum % 10 === 0, 'Luhn');
      ok(/^[1-9]\d{2}$/.test(values.cardCvc) && values.cvc === values.cardCvc);
      eq(values.cardNumberSpaced.replace(/ /g, ''), values.cardNumber);
    }
  );
  await check(
    'sensitive: scannable values include password and card, exclude cvc, expiry and short numbers',
    () => {
      const labels = scannableSensitiveValues(generateSensitiveValues('scan')).map(
        item => item.label
      );
      for (const wanted of ['sensitive.password', 'sensitive.cardNumber', 'sensitive.apiToken']) {
        ok(labels.includes(wanted), wanted);
      }
      for (const unwanted of [
        'sensitive.cardCvc',
        'sensitive.cvc',
        'sensitive.cardExpiry',
        'sensitive.otp',
      ]) {
        ok(!labels.includes(unwanted), unwanted);
      }
      ok(
        !isScannableSecret('12345678'.slice(0, 7)) &&
          isScannableSecret('12345678') &&
          !isScannableSecret(5)
      );
    }
  );
  await check('sensitive: no generated value appears as a literal in the harness sources', () => {
    const sources = harnessSources()
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
    for (const seed of ['a', 'b', 'run-1:catalog-a-demo', 'scenario-validate', 'shape']) {
      const values = generateSensitiveValues(seed);
      for (const [label, value] of Object.entries(values)) {
        if (isScannableSecret(value) && label !== 'cardNumber' && label !== 'cardNumberSpaced') {
          ok(!sources.includes(value), `${label} of seed ${seed} appears in source`);
        }
      }
    }
    ok(
      !sources.includes(generateSensitiveValues().cardNumber),
      'the card number is assembled from parts'
    );
  });
}

async function envChecks() {
  const fakePlaywright = { chromium: { launch: () => undefined } };
  const base = {
    env: { TYPESAFE_API_KEY: FAKE_KEY },
    loadPlaywright: () => fakePlaywright,
    findChromium: () => '/fake/chrome',
    nodeVersion: '24.0.0',
  };
  await check(
    'preflight: ok with Playwright, Chromium and a key; the key is a boolean only',
    () => {
      const result = preflight(base);
      ok(result.ok && result.exitCode === 0 && result.keyPresent === true);
      ok(result.playwright === fakePlaywright && result.chromePath === '/fake/chrome');
      ok(
        !JSON.stringify({ ...result, playwright: null }).includes(FAKE_KEY),
        'the key must not appear'
      );
    }
  );
  await check('preflight: a missing key is exit 2 (and fine when requireKey is false)', () => {
    const missing = preflight({ ...base, env: {} });
    ok(!missing.ok && missing.exitCode === 2 && missing.keyPresent === false);
    ok(missing.problems.some(problem => problem.includes('TYPESAFE_API_KEY')));
    ok(preflight({ ...base, env: { TYPESAFE_API_KEY: '   ' } }).exitCode === 2, 'blank key');
    ok(preflight({ ...base, env: {}, requireKey: false }).ok);
  });
  await check('preflight: Playwright, Chromium and Node problems are each exit 2', () => {
    const noPlaywright = preflight({
      ...base,
      loadPlaywright: () => {
        throw new Error('nope');
      },
    });
    ok(noPlaywright.exitCode === 2 && noPlaywright.playwright === null);
    ok(preflight({ ...base, loadPlaywright: () => ({}) }).exitCode === 2, 'no chromium.launch');
    const noChrome = preflight({ ...base, findChromium: () => undefined });
    ok(noChrome.exitCode === 2 && noChrome.chromePath === null);
    const oldNode = preflight({ ...base, nodeVersion: '18.19.0' });
    ok(oldNode.exitCode === 2 && oldNode.nodeOk === false);
    ok(
      preflight({ ...base, nodeVersion: '20.8.1' }).ok &&
        !preflight({ ...base, nodeVersion: '20.8.0' }).ok
    );
  });
  await check(
    'preflight: a BREEZE_CHROME_PATH that points nowhere is a problem even when another browser is found',
    () => {
      const missing = preflight({
        ...base,
        env: { TYPESAFE_API_KEY: FAKE_KEY, BREEZE_CHROME_PATH: '/typo/chrome' },
        exists: () => false,
      });
      ok(!missing.ok && missing.exitCode === 2, 'mistyped override');
      ok(
        missing.problems.some(problem => problem.includes('BREEZE_CHROME_PATH')),
        missing.problems.join('; ')
      );
      const present = preflight({
        ...base,
        env: { TYPESAFE_API_KEY: FAKE_KEY, BREEZE_CHROME_PATH: '/real/chrome' },
        exists: file => file === '/real/chrome',
      });
      ok(present.ok, present.problems.join('; '));
      ok(
        preflight({ ...base, env: { TYPESAFE_API_KEY: FAKE_KEY } }).ok,
        'no override, nothing to check'
      );
    }
  );
  await check(
    'findChromium: honors an override, then the preferred build, then an installed chromium-N',
    () => {
      const files = new Set(['/override/chrome']);
      eq(
        findChromium({
          env: { BREEZE_CHROME_PATH: '/override/chrome' },
          exists: file => files.has(file),
        }),
        '/override/chrome'
      );
      const cache = '/cache';
      const exe = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
      const second = path.join(cache, 'chromium-2000', 'chrome-mac', exe);
      const found = findChromium({
        env: {},
        cacheRoot: cache,
        exists: file => file === cache || file === second,
        readdir: () => ['chromium-1000', 'notes', 'chromium-2000'],
      });
      ok(
        found === second || (typeof found === 'string' && found.includes('chromium-')),
        String(found)
      );
      eq(findChromium({ env: {}, cacheRoot: '/none', exists: () => false }), undefined);
    }
  );
  await check(
    'preflight: the real environment answers with a well-formed result (booleans only)',
    () => {
      const real = preflight({ requireKey: false });
      ok(typeof real.ok === 'boolean' && (real.exitCode === 0 || real.exitCode === 2));
      ok(typeof real.keyPresent === 'boolean' && Array.isArray(real.problems));
      process.stdout.write(
        `     real environment: ok=${real.ok} playwright=${real.playwright !== null} chromium=${real.chromePath !== null} key=${real.keyPresent}\n`
      );
    }
  );
}

function makeDistTree(name, { esm, umd, withSrc = true } = {}) {
  const root = path.join(scratch, `dist-${name}`);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const names = REQUIRED_EXPORTS.join(', ');
  fs.writeFileSync(
    path.join(root, 'dist', 'index.esm.js'),
    esm ?? `const a=1;\nexport { ${names} };\n`
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'index.umd.js'),
    umd ?? `exports.${REQUIRED_EXPORTS.join('=exports.')}=1;`
  );
  const old = new Date(Date.now() - 600000);
  if (withSrc) {
    for (const dir of SOURCE_DIRS) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      const file = path.join(root, dir, 'x.ts');
      fs.writeFileSync(file, 'export const x = 1;\n');
      fs.utimesSync(file, old, old);
    }
  }
  const recent = new Date(Date.now() - 60000);
  for (const file of ['index.esm.js', 'index.umd.js']) {
    fs.utimesSync(path.join(root, 'dist', file), recent, recent);
  }
  return root;
}

async function distChecks() {
  await check('dist: a fresh dist with every export is ok and carries a sha256', () => {
    const result = checkDist({ root: makeDistTree('good') });
    ok(
      result.ok && result.exitCode === 0 && /^[0-9a-f]{64}$/.test(result.sha256),
      result.reasons.join('; ')
    );
  });
  await check(
    'dist: a source file newer than the bundles is stale (exit 3), in every watched directory',
    () => {
      for (const dir of SOURCE_DIRS) {
        const root = makeDistTree(`stale-${dir.replace('/', '-')}`);
        const file = path.join(root, dir, 'x.ts');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(file, future, future);
        const result = checkDist({ root });
        ok(
          !result.ok && result.exitCode === 3 && result.reasons.some(r => r.includes('stale')),
          `${dir}: ${result.reasons.join('; ')}`
        );
      }
    }
  );
  await check('dist: redactEnvelope is a required export (contract 2.16)', () => {
    ok(REQUIRED_EXPORTS.includes('redactEnvelope'));
    const names = REQUIRED_EXPORTS.filter(name => name !== 'redactEnvelope');
    const root = makeDistTree('no-redact', {
      esm: `export { ${names.join(', ')} };\n`,
      umd: `exports.${names.join('=exports.')}=1;`,
    });
    const result = checkDist({ root });
    ok(
      !result.ok &&
        result.exitCode === 3 &&
        result.reasons.some(reason => reason.includes('redactEnvelope')),
      result.reasons.join('; ')
    );
    const umdOnly = checkDist({
      root: makeDistTree('no-redact-umd', {
        umd: `exports.${names.join('=exports.')}=1;`,
      }),
    });
    ok(
      !umdOnly.ok &&
        umdOnly.reasons.some(
          reason => reason.includes('index.umd.js') && reason.includes('redactEnvelope')
        ),
      umdOnly.reasons.join('; ')
    );
  });
  await check(
    'dist: an edit anywhere under src/ (index, forms, context, guide, nested) makes the bundles stale',
    () => {
      for (const relative of [
        'src/index.ts',
        'src/forms/FormRegistry.ts',
        'src/context/ContextCapture.ts',
        'src/guide/observe.ts',
        'src/agent/browser/observe.ts',
      ]) {
        const root = makeDistTree(`stale-any-${relative.replace(/[/.]/g, '-')}`);
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'export const y = 1;\n');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(file, future, future);
        const result = checkDist({ root });
        ok(
          !result.ok && result.exitCode === 3 && result.reasons.some(r => r.includes(relative)),
          `${relative}: ${result.reasons.join('; ')}`
        );
      }
    }
  );
  await check('dist: the OLDER bundle decides staleness, and .DS_Store never does', () => {
    const root = makeDistTree('mixed');
    const file = path.join(root, 'src', 'x.ts');
    const between = new Date(Date.now() - 30000);
    fs.utimesSync(file, between, between);
    fs.utimesSync(
      path.join(root, 'dist', 'index.esm.js'),
      new Date(Date.now() - 60000),
      new Date(Date.now() - 60000)
    );
    fs.utimesSync(
      path.join(root, 'dist', 'index.umd.js'),
      new Date(Date.now() - 5000),
      new Date(Date.now() - 5000)
    );
    const stale = checkDist({ root });
    ok(
      !stale.ok && stale.reasons.some(reason => reason.includes('stale')),
      stale.reasons.join('; ')
    );
    const clean = makeDistTree('dsstore');
    const junk = path.join(clean, 'src', '.DS_Store');
    fs.writeFileSync(junk, 'x');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(junk, future, future);
    ok(checkDist({ root: clean }).ok, 'a .DS_Store is not a source file');
  });
  await check(
    'dist: a source file older than the bundles stays ok (negative control for stale)',
    () => {
      ok(checkDist({ root: makeDistTree('older') }).ok);
    }
  );
  await check(
    'dist: a missing export is exit 3 and names it (ESM export clause and UMD text)',
    () => {
      const esm = makeDistTree('noexport', {
        esm: `export { createTaskAgent, installTaskBridge };\n`,
      });
      const result = checkDist({ root: esm });
      ok(!result.ok && result.exitCode === 3);
      ok(
        result.reasons.some(r => r.includes('createRemoteTaskHost') && r.includes('index.esm.js'))
      );
      const umd = makeDistTree('noumd', { umd: 'exports.createTaskAgent=1;' });
      ok(checkDist({ root: umd }).reasons.some(r => r.includes('index.umd.js')));
    }
  );
  await check('dist: missing bundles are exit 3 with no sha256 and readBundles refuses', () => {
    const root = path.join(scratch, 'dist-empty');
    fs.mkdirSync(root, { recursive: true });
    const result = checkDist({ root });
    ok(!result.ok && result.exitCode === 3 && result.sha256 === null);
    let threw = false;
    try {
      readBundles(root);
    } catch {
      threw = true;
    }
    ok(threw);
  });
  await check(
    'dist: sha256 is stable for the same bytes and changes with them; readBundles agrees',
    () => {
      const root = makeDistTree('sha');
      const first = checkDist({ root });
      eq(checkDist({ root }).sha256, first.sha256);
      const bundles = readBundles(root);
      eq(bundles.sha256, first.sha256);
      ok(bundles.esmUrl.startsWith('file://') && bundles.umd.includes('createTaskAgent'));
      fs.appendFileSync(path.join(root, 'dist', 'index.umd.js'), '\n;');
      const later = new Date(Date.now() - 30000);
      fs.utimesSync(path.join(root, 'dist', 'index.umd.js'), later, later);
      ok(checkDist({ root }).sha256 !== first.sha256);
    }
  );
  await check(
    'dist: exportedNames reads export clauses with aliases and declaration exports',
    () => {
      const names = exportedNames(
        'export { a as b, c };\nexport function d() {}\nexport const e = 1;\nexport async function f() {}'
      );
      eq([...names].sort(), ['b', 'c', 'd', 'e', 'f']);
    }
  );
  await check(
    'dist: the real repository dist is checked without building (result reported, not asserted)',
    () => {
      const real = checkDist({ root: REPO_ROOT });
      ok(typeof real.ok === 'boolean' && (real.exitCode === 0 || real.exitCode === 3));
      process.stdout.write(`     real dist: ok=${real.ok} reasons=${real.reasons.length}\n`);
    }
  );
}

async function runnerChecks() {
  await check('runner: a completed run passes and leaves every evidence file', async () => {
    const run = await exec(goodLive());
    ok(
      run.outcome.passed && run.outcome.status === 'completed',
      JSON.stringify(run.outcome.failures)
    );
    for (const name of [
      'summary.json',
      'jev-calls.json',
      'trace.json',
      'observations.json',
      'backend-before.json',
      'backend-after.json',
      'result.json',
      'screenshots/step-00-initial.png',
      'screenshots/step-01-executed.png',
      'screenshots/final.png',
    ]) {
      ok(run.has(name), `${name} is missing`);
    }
    ok(!run.has('failure/failures.json'), 'no failure artifacts on a pass');
  });
  await check(
    'runner: summary.json carries kind, status, resolved model, call count and the dist sha256',
    async () => {
      const summary = (await exec(goodLive())).read('summary.json');
      ok(summary.passed === true && summary.kind === 'live' && summary.status === 'completed');
      ok(summary.model === 'jev-1.13.0' && summary.calls === 1 && summary.sha256 === DIST_SHA);
      ok(summary.secretsChecked > 0 && !JSON.stringify(summary).includes(FAKE_KEY));
    }
  );
  await check(
    'runner: backend snapshots bracket the run; jev-calls.json holds the recorded exchange',
    async () => {
      const run = await exec(goodLive());
      eq(run.read('backend-before.json').searches, []);
      eq(run.read('backend-after.json').searches.length, 1);
      const calls = run.read('jev-calls.json');
      ok(
        Array.isArray(calls) &&
          calls.length === 1 &&
          calls[0].request.questions.operation.instructions.goal === LIVE_GOAL
      );
    }
  );
  await check(
    'runner: uniform calibration reaches the request and offscreen host without changing the goal',
    async () => {
      const confidence = { action: 0.2, argument: 0.3, completion: 0.6 };
      const forwarded = [];
      const remoteHost = {
        hostKind: 'fake',
        observe: async req => {
          forwarded.push(req);
          return { ok: true, value: {} };
        },
        dispose: async () => undefined,
      };
      const run = await exec(
        goodLive(),
        { remoteHost },
        { args: { runOverrides: { confidence }, observeOffscreen: true } }
      );
      eq(run.world.runRequests[0].goal, LIVE_GOAL);
      eq(run.world.runRequests[0].expect, { answer: false });
      eq(run.world.runRequests[0].options.confidence, confidence);
      await run.world.agentConfig.host.observe({
        sessionId: 'ses_probe',
        options: { includeText: true },
      });
      ok(
        forwarded[0].options.includeOffscreen === true && forwarded[0].options.includeText === true
      );
      eq(run.read('summary.json').profile, {
        runOverrides: { confidence },
        observeOffscreen: true,
      });
    }
  );
  await check('runner: trace.json and observations.json come from the agent events', async () => {
    const run = await exec(goodLive());
    const trace = run.read('trace.json');
    ok(trace.events.some(event => event.type === 'executed') && trace.events.length === 2);
    ok(trace.transport.length === 1 && trace.transport[0].method === 'observe');
    const observations = run.read('observations.json');
    ok(observations.steps.length === 1 && observations.steps[0].elementCount === 7);
  });
  await check(
    'runner: lifecycle order is app, context, navigation, run; everything is closed afterwards',
    async () => {
      const run = await exec(goodLive());
      const { log } = run.world;
      ok(
        log.indexOf('app.start') < log.indexOf('context.new') &&
          log.indexOf('context.new') < log.indexOf('page.goto')
      );
      for (const entry of ['host.dispose', 'transport.close', 'context.close', 'app.close']) {
        ok(log.includes(entry), `${entry} did not run`);
      }
      ok(log.indexOf('context.close') < log.indexOf('app.close'));
    }
  );
  await check(
    'runner: collaborators receive the bundle, the gate, a cloned app configuration and the goal',
    async () => {
      const scenario = goodLive({ initial: { cart: [] }, faults: { rerenderEveryMs: 1200 } });
      const run = await exec(scenario);
      ok(run.world.umd === 'fake-umd-text' && run.world.browser.fakeBrowser === true);
      ok(run.world.httpArgs.gate === run.world.gate, 'gate');
      eq(run.world.startOptions, {
        family: 'catalog',
        variant: 'A',
        initial: { cart: [] },
        faults: { rerenderEveryMs: 1200 },
      });
      ok(run.world.startOptions.faults !== scenario.faults, 'faults must be cloned');
      const request = run.world.runRequests[0];
      ok(request.goal === LIVE_GOAL && request.startUrl === 'http://127.0.0.1:4010/');
      eq(request.inputs, { query: 'wireless mouse' });
    }
  );
  await check(
    'runner: the API key reaches the decider only as a callback; http gets it only as a redaction value',
    async () => {
      const run = await exec(goodLive());
      const { apiKey } = run.world.deciderConfig;
      ok(typeof apiKey === 'function' && apiKey() === FAKE_KEY);
      ok(!JSON.stringify(run.world.deciderConfig).includes(FAKE_KEY), 'config JSON');
      ok(run.world.httpArgs.redactValues.includes(FAKE_KEY), 'redactValues');
      ok(typeof run.world.deciderConfig.http === 'function');
      ok(!JSON.stringify(run.world.agentConfig).includes(FAKE_KEY));
      ok(!JSON.stringify(run.world.runRequests).includes(FAKE_KEY));
    }
  );
  await check(
    'runner: the transport scrubs text and envelopes through the supplied redactors',
    async () => {
      const run = await exec(goodLive());
      const { redact, redactEnvelope } = run.world.transportArgs;
      const { password } = generateSensitiveValues('st-' + runCounter + ':catalog-a-demo');
      eq(typeof redact('typed ' + password), 'string');
      ok(!redact(`typed ${password} here`).includes(password), 'password removed from text');
      ok(!redact(`key ${FAKE_KEY}`).includes(FAKE_KEY), 'key removed from text');
      eq(redactEnvelope({ method: 'execute', payload: { value: 'x' } }), { method: 'execute' });
    }
  );
  await check(
    'runner: expect gets (app, result, page, ctx) with calls, trace, evidenceDir and sensitive values',
    async () => {
      let seen;
      const run = await exec(
        goodLive({
          expect: async (app, result, page, ctx) => {
            seen = { app, result, page, ctx };
          },
        })
      );
      ok(run.outcome.passed);
      ok(
        seen.app === run.world.app &&
          seen.page === run.world.page &&
          seen.result.status === 'completed'
      );
      ok(seen.ctx.calls.length === 1 && seen.ctx.trace.length === 2);
      ok(seen.ctx.evidenceDir === run.dir && typeof seen.ctx.sensitive.password === 'string');
      ok(
        seen.ctx.goal === LIVE_GOAL &&
          Array.isArray(seen.ctx.pauses) &&
          seen.ctx.results.length === 1
      );
    }
  );
  await check(
    'runner: function inputs receive the same run-time sensitive values that expect sees',
    async () => {
      let sensitiveInExpect;
      const run = await exec(
        goodLive({
          inputs: sensitive => ({ account: { secret: sensitive.password } }),
          inputDeclarations: [{ path: 'account.secret', sensitive: true, description: 'secret' }],
          expect: async (app, result, page, ctx) => {
            sensitiveInExpect = ctx.sensitive.password;
          },
        })
      );
      const request = run.world.runRequests[0];
      ok(
        request.inputs.account.secret === sensitiveInExpect &&
          request.inputDeclarations[0].sensitive === true
      );
      ok(!JSON.stringify(run.read('summary.json')).includes(sensitiveInExpect));
    }
  );
  await check(
    'runner: needs_input then resume applies the data-only resolution with the checkpoint',
    async () => {
      const goal = LIVE_GOAL;
      const run = await exec(
        goodLive({
          resume: [
            {
              on: 'needs_input',
              resolution: sensitive => ({
                kind: 'inputs',
                inputs: { profile: { email: 'ada@example.test' } },
                sensitiveInputs: { account: { secret: sensitive.password } },
                inputDeclarations: [{ path: 'profile.email', sensitive: false }],
              }),
            },
          ],
        }),
        {
          script: async ({ onEvent, world }) => {
            emitExecuted(onEvent);
            world.callJev(goal);
            world.backend.searches.push({ stage: 'at-pause' });
            return results.needsInput(goal);
          },
        }
      );
      ok(
        run.outcome.passed && run.outcome.status === 'completed',
        JSON.stringify(run.outcome.failures)
      );
      const [resume] = run.world.resumeRequests;
      ok(resume.checkpoint.id === checkpoint.id && resume.resolution.kind === 'inputs');
      eq(resume.resolution.inputs, { profile: { email: 'ada@example.test' } });
      ok(
        typeof resume.inputs.account.secret === 'string' &&
          resume.resolution.inputDeclarations.length === 1
      );
      const pauses = run.read('pauses.json');
      ok(
        pauses.length === 1 &&
          pauses[0].status === 'needs_input' &&
          pauses[0].backend.searches.length === 1
      );
      ok(run.read('result-pause-1.json').status === 'needs_input', 'the paused result is kept');
    }
  );
  await check(
    'runner: ctx.pauses holds the paused results themselves, ctx.results every result in order',
    async () => {
      let seen;
      await exec(
        goodLive({
          resume: [{ on: 'needs_input', resolution: { kind: 'inputs', inputs: { a: 'b' } } }],
          expect: async (app, result, page, ctx) => {
            seen = ctx;
          },
        }),
        { script: async ({ world }) => (world.callJev(LIVE_GOAL), results.needsInput(LIVE_GOAL)) }
      );
      ok(
        seen.pauses.length === 1 &&
          seen.pauses[0].status === 'needs_input' &&
          seen.pauses[0].requirements.length === 1
      );
      eq(
        seen.results.map(result => result.status),
        ['needs_input', 'completed']
      );
      ok(seen.pauseBackends[0].status === 'needs_input');
    }
  );
  await check(
    'runner: awaiting_approval then resume echoes approval id, nonce and digests (nested and flat forms)',
    async () => {
      for (const resolution of [
        { kind: 'approval', resolution: { decision: 'approve', scope: 'once' } },
        { decision: 'approve', scope: 'once' },
      ]) {
        const run = await exec(goodLive({ resume: [{ on: 'awaiting_approval', resolution }] }), {
          script: async ({ world }) => (world.callJev(LIVE_GOAL), results.awaiting(LIVE_GOAL)),
        });
        ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
        const [resume] = run.world.resumeRequests;
        eq(
          resume.resolution,
          {
            kind: 'approval',
            resolution: {
              ...approval,
              approvalId: approval.id,
              decision: 'approve',
              scope: 'once',
            },
          }.resolution && {
            kind: 'approval',
            resolution: {
              approvalId: approval.id,
              nonce: approval.nonce,
              digest: approval.digest,
              contextDigest: approval.contextDigest,
              decision: 'approve',
              scope: 'once',
            },
          }
        );
        ok(resume.checkpoint.id === checkpoint.id);
      }
    }
  );
  await check(
    'runner: approval resume privately rebinds retained sensitive paths and honors omissions',
    async () => {
      for (const omit of [false, true]) {
        const run = await exec(
          goodLive({
            inputs: sensitive => ({ payment: { password: sensitive.password } }),
            inputDeclarations: () => [{ path: 'payment.password', sensitive: true }],
            resume: [
              {
                on: 'awaiting_approval',
                resolution: {
                  decision: 'approve',
                  ...(omit ? { omitSensitivePaths: ['payment.password'] } : {}),
                },
              },
            ],
          }),
          {
            script: async ({ world }) => {
              world.callJev(LIVE_GOAL);
              return {
                ...results.awaiting(LIVE_GOAL),
                checkpoint: {
                  ...checkpoint,
                  request: { sensitivePaths: ['payment.password'] },
                },
              };
            },
          }
        );
        const [resume] = run.world.resumeRequests;
        ok(resume.resolution.kind === 'approval');
        ok(
          omit
            ? resume.inputs === undefined && resume.omitSensitivePaths.length === 1
            : resume.inputs.payment.password === run.world.runRequests[0].inputs.payment.password,
          'sensitive rebinding must match the caller data without entering the approval resolution'
        );
        ok(run.outcome.passed, 'private rebinding must not leak into evidence');
      }
    }
  );
  await check(
    'runner: a pause the scenario did not expect is a resume_mismatch failure',
    async () => {
      const run = await exec(
        goodLive({ resume: [{ on: 'awaiting_approval', resolution: { decision: 'approve' } }] }),
        {
          script: async ({ world }) => (world.callJev(LIVE_GOAL), results.needsInput(LIVE_GOAL)),
        }
      );
      ok(
        !run.outcome.passed && kinds(run.outcome).includes('resume_mismatch'),
        JSON.stringify(kinds(run.outcome))
      );
      ok(run.world.resumeRequests.length === 0, 'no resume may be sent');
    }
  );
  await check(
    'runner: resume steps that were never needed are a resume_unused failure',
    async () => {
      const run = await exec(
        goodLive({ resume: [{ on: 'needs_input', resolution: { inputs: { a: 'b' } } }] })
      );
      ok(
        !run.outcome.passed && kinds(run.outcome).includes('resume_unused'),
        JSON.stringify(kinds(run.outcome))
      );
    }
  );
  await check(
    'runner: cancelAfterMs aborts the signal after about that long and a cancelled result passes expectStatus cancelled',
    async () => {
      let abortedAfterMs = -1;
      const run = await exec(goodLive({ expectStatus: 'cancelled', run: { cancelAfterMs: 50 } }), {
        script: async ({ signal, world }) => {
          const began = Date.now();
          world.callJev(LIVE_GOAL);
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          abortedAfterMs = Date.now() - began;
          return results.cancelled(LIVE_GOAL);
        },
      });
      ok(
        run.outcome.passed && run.outcome.status === 'cancelled',
        JSON.stringify(run.outcome.failures)
      );
      ok(run.world.signal.aborted, 'the signal was aborted');
      ok(
        abortedAfterMs >= 45 && abortedAfterMs < 1500,
        `aborted after ${abortedAfterMs} ms, wanted about 50`
      );
    }
  );
  await check(
    'runner: a failed run against expectStatus completed fails with failure artifacts',
    async () => {
      const { password } = generateSensitiveValues(`st-${runCounter + 1}:catalog-a-demo`);
      const run = await exec(goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }), {
        script: async ({ world, onEvent }) => (
          emitExecuted(onEvent),
          world.callJev(LIVE_GOAL),
          results.failed(LIVE_GOAL)
        ),
        html: `<html><body><input value="${password}"></body></html>`,
        consoleText: `typed ${password}`,
      });
      ok(
        !run.outcome.passed && run.outcome.failure.kind === 'status_mismatch',
        JSON.stringify(kinds(run.outcome))
      );
      for (const name of [
        'failure/failures.json',
        'failure/console.json',
        'failure/page.html',
        'failure/last-observation.json',
      ]) {
        ok(run.has(name), `${name} is missing`);
      }
      ok(
        !fs.readFileSync(path.join(run.dir, 'failure', 'page.html'), 'utf8').includes(password),
        'html redacted'
      );
      ok(
        !fs.readFileSync(path.join(run.dir, 'failure', 'console.json'), 'utf8').includes(password),
        'console redacted'
      );
      ok(run.read('summary.json').passed === false && run.outcome.leak === false);
    }
  );
  await check('runner: a failed run is a pass when failed is an expected status', async () => {
    const run = await exec(goodLive({ expectStatus: ['failed', 'blocked'] }), {
      script: async ({ world }) => (world.callJev(LIVE_GOAL), results.failed(LIVE_GOAL)),
    });
    ok(run.outcome.passed && run.outcome.status === 'failed', JSON.stringify(run.outcome.failures));
  });
  await check(
    'runner: an expect that throws is expect_failed, the message is kept, and everything still closes',
    async () => {
      const run = await exec(
        goodLive({
          expect: async () => {
            throw new Error('[backend] searches.length expected 1, got 0');
          },
        })
      );
      ok(!run.outcome.passed && run.outcome.failure.kind === 'expect_failed');
      ok(run.outcome.failure.message.includes('[backend] searches.length expected 1, got 0'));
      ok(run.world.log.includes('app.close') && run.world.log.includes('context.close'));
      ok(run.has('failure/failures.json'));
    }
  );
  await check('runner: a missing expect function is reported, not thrown', async () => {
    const run = await exec(goodLive({ expect: undefined }));
    ok(!run.outcome.passed && kinds(run.outcome).includes('expect_failed'));
  });
  await check(
    'runner: a sensitive value leaking into an artifact fails the run as evidence_secret (exit 4 path)',
    async () => {
      let leaked;
      const run = await exec(
        goodLive({
          expect: async (app, result, page, ctx) => {
            leaked = ctx.sensitive.password;
            fs.writeFileSync(
              path.join(ctx.evidenceDir, 'leak.json'),
              JSON.stringify({ oops: leaked })
            );
          },
        })
      );
      ok(
        !run.outcome.passed &&
          run.outcome.leak === true &&
          kinds(run.outcome).includes('evidence_secret')
      );
      ok(
        run.outcome.leaks.some(
          hit => hit.file === 'leak.json' && hit.label === 'sensitive.password'
        )
      );
      ok(!JSON.stringify(run.outcome).includes(leaked), 'the outcome must not hold the value');
      ok(
        !fs.readFileSync(path.join(run.dir, 'leak.json'), 'utf8').includes(leaked),
        'the file is scrubbed'
      );
      ok(scanForSecrets(run.dir, [leaked]).hits.length === 0);
      ok(run.read('summary.json').passed === false);
    }
  );
  await check(
    'runner: a leak through the result is found in result.json, labelled by value kind',
    async () => {
      const run = await exec(goodLive({ inputs: sensitive => ({ card: sensitive.cardNumber }) }), {
        script: async ({ world, request, onEvent }) => {
          emitExecuted(onEvent);
          world.callJev(request.goal);
          return {
            ...results.completed(request.goal),
            note: `typed ${['4242', '4242', '4242', '4242'].join(' ')}`,
          };
        },
      });
      ok(
        run.outcome.leak &&
          run.outcome.leaks.some(
            hit => hit.file === 'result.json' && hit.label === 'sensitive.cardNumber'
          )
      );
    }
  );
  await check(
    'runner: the API key leaking into an artifact is a leak and never appears in the outcome',
    async () => {
      const run = await exec(goodLive(), {
        script: async ({ world, request }) => {
          world.callJev(request.goal);
          return { ...results.completed(request.goal), debug: `Bearer ${FAKE_KEY}` };
        },
      });
      ok(run.outcome.leak && run.outcome.leaks.some(hit => hit.label === 'TYPESAFE_API_KEY'));
      ok(!JSON.stringify(run.outcome).includes(FAKE_KEY));
      ok(scanForSecrets(run.dir, [FAKE_KEY]).hits.length === 0, 'scrubbed on disk');
    }
  );
  await check(
    'runner: a clean run has leak false and an empty leak list (negative control)',
    async () => {
      const run = await exec(goodLive({ inputs: sensitive => ({ card: sensitive.cardNumber }) }));
      ok(run.outcome.passed && run.outcome.leak === false && run.outcome.leaks.length === 0);
    }
  );
  await check(
    'runner: a question whose instructions.goal is not the scenario goal is jev_goal',
    async () => {
      const run = await exec(goodLive(), {
        script: async ({ world }) => (
          world.callJev('Some other goal entirely'),
          results.completed(LIVE_GOAL)
        ),
      });
      ok(
        !run.outcome.passed && kinds(run.outcome).includes('jev_goal'),
        JSON.stringify(kinds(run.outcome))
      );
      const stringInstructions = await exec(goodLive(), {
        script: async ({ world }) => (
          world.callJev(LIVE_GOAL, { request: { questions: { q: { instructions: LIVE_GOAL } } } }),
          results.completed(LIVE_GOAL)
        ),
      });
      ok(
        kinds(stringInstructions.outcome).includes('jev_goal'),
        'string instructions carry no goal field'
      );
    }
  );
  await check(
    'runner: route, selector, host and forbidden-phrase hints in library text are jev_hint',
    async () => {
      const hints = [
        ['an app route from the request log', 'Open /api/products to continue'],
        ['a CSS selector', 'Use #buy-now to continue'],
        ['the app host', 'Stay on 127.0.0.1:4010 please'],
        ['a forbidden phrase', 'Stop when Order confirmed appears'],
      ];
      for (const [label, rules] of hints) {
        const run = await exec(goodLive({ forbiddenInstructionText: ['order confirmed'] }), {
          script: async ({ world }) => {
            world.callJev(LIVE_GOAL, {
              request: { questions: { q: { instructions: { goal: LIVE_GOAL, rules: [rules] } } } },
            });
            return results.completed(LIVE_GOAL);
          },
        });
        ok(
          !run.outcome.passed && kinds(run.outcome).includes('jev_hint'),
          `${label}: ${JSON.stringify(kinds(run.outcome))}`
        );
      }
    }
  );
  await check(
    'runner: ordinary library wording passes the hint check (negative control)',
    async () => {
      const run = await exec(goodLive(), {
        script: async ({ world }) => {
          world.callJev(LIVE_GOAL, {
            request: {
              questions: {
                q: {
                  instructions: {
                    goal: LIVE_GOAL,
                    rules: [
                      'Choose the control to click next by its id t12.',
                      'Prefer ids that were offered.',
                    ],
                  },
                },
              },
            },
          });
          return results.completed(LIVE_GOAL);
        },
      });
      ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
    }
  );
  await check(
    'runner: a response model that is not jev-* is jev_model; an unanswered attempt needs no model',
    async () => {
      const wrong = await exec(goodLive(), {
        script: async ({ world }) => (
          world.callJev(LIVE_GOAL, { model: 'other-1', response: { model: 'other-1' } }),
          results.completed(LIVE_GOAL)
        ),
      });
      ok(!wrong.outcome.passed && kinds(wrong.outcome).includes('jev_model'));
      const retried = await exec(goodLive(), {
        script: async ({ world }) => {
          world.callJev(LIVE_GOAL, { status: 429, response: null, model: null });
          world.callJev(LIVE_GOAL, { attempt: 2 });
          return results.completed(LIVE_GOAL);
        },
      });
      ok(
        retried.outcome.passed && retried.outcome.calls === 2,
        JSON.stringify(retried.outcome.failures)
      );
    }
  );
  await check(
    'runner: a live scenario with no Jev call fails; a fault scenario without one does not',
    async () => {
      const silent = { script: async () => results.completed(LIVE_GOAL) };
      const live = await exec(goodLive(), silent);
      ok(!live.outcome.passed && kinds(live.outcome).includes('no_jev_calls'));
      const fault = await exec(goodFault(), silent);
      ok(fault.outcome.passed, JSON.stringify(fault.outcome.failures));
    }
  );
  await check('runner: a configured fault that never fires fails closed', async () => {
    const run = await exec(goodFault(), { unfiredInjection: true });
    ok(!run.outcome.passed && kinds(run.outcome).includes('fault_unfired'));
  });
  await check(
    'runner: a fault scenario applies the injection to decider and host and is labelled',
    async () => {
      const run = await exec(goodFault());
      ok(run.outcome.passed && run.outcome.kind === 'fault');
      const args = run.world.injectionArgs;
      ok(
        args.scenario.id === 'catalog-a-demo-fault' &&
          args.page === run.world.page &&
          typeof args.recorder.record === 'function'
      );
      ok(args.decider.kind === 'decider' && args.host.hostKind === 'fake');
      ok(
        run.world.agentConfig.decider.wrapped === true &&
          run.world.agentConfig.host.wrapped === true,
        'agent uses the wrapped pair'
      );
      const injection = run.read('injection.json');
      ok(
        injection.label === 'FAULT_INJECTION' &&
          injection.live === false &&
          injection.notes.length === 1
      );
      ok(run.read('summary.json').label.includes('FAULT_INJECTION'));
    }
  );
  await check('runner: a live scenario never applies an injection', async () => {
    const run = await exec(goodLive());
    ok(run.world.injectionArgs === undefined && !run.has('injection.json'));
    ok(run.world.agentConfig.decider.kind === 'decider');
  });
  await check(
    'runner: a dist that lacks a required function is setup_failed and names it',
    async () => {
      for (const missing of [
        'createTaskAgent',
        'createRemoteTaskHost',
        'createTypeSafeTaskDecider',
      ]) {
        const world = makeWorld();
        const dist = { ...world.deps.dist, [missing]: undefined };
        const run = await exec(goodLive(), {}, { deps: { dist } });
        ok(
          !run.outcome.passed &&
            run.outcome.failure.kind === 'setup_failed' &&
            run.outcome.failure.message.includes(missing),
          `${missing}: ${JSON.stringify(run.outcome.failures)}`
        );
        ok(!run.world.log.includes('app.start'), 'nothing may start against a broken dist');
      }
    }
  );
  await check(
    'runner: a start failure is setup_failed, nothing else is left open, summary.json still exists',
    async () => {
      const run = await exec(goodLive(), { startAppThrows: true });
      ok(
        !run.outcome.passed &&
          run.outcome.failure.kind === 'setup_failed' &&
          run.outcome.failure.message.includes('app failed to start')
      );
      ok(
        !run.world.log.includes('context.new') && run.has('summary.json') && run.has('result.json')
      );
      ok(run.read('summary.json').passed === false);
    }
  );
  await check('runner: a context failure still closes the app that was started', async () => {
    const run = await exec(goodLive(), { contextThrows: true });
    ok(!run.outcome.passed && run.outcome.failure.kind === 'setup_failed');
    ok(run.world.log.includes('app.close'));
  });
  await check('runner: an agent that rejects is run_threw and everything closes', async () => {
    const run = await exec(goodLive(), { agentRunThrows: true });
    ok(!run.outcome.passed && kinds(run.outcome).includes('run_threw'));
    ok(run.world.log.includes('app.close') && run.world.log.includes('context.close'));
  });
  await check(
    'runner: a hung agent is aborted by the watchdog (timeout) and the run still returns and closes',
    async () => {
      const started = Date.now();
      const run = await exec(
        goodLive(),
        { script: () => new Promise(() => undefined) },
        { deps: { maxScenarioMs: 60, abortGraceMs: 30 } }
      );
      ok(
        !run.outcome.passed && kinds(run.outcome).includes('timeout'),
        JSON.stringify(kinds(run.outcome))
      );
      ok(
        Date.now() - started < 3000 && run.world.signal.aborted && run.world.cancelCalled === true
      );
      ok(run.world.log.includes('app.close'));
    }
  );
  await check(
    'runner: screenshots are skipped while a sensitive value is visible and taken when it is not',
    async () => {
      const withSecret = `card ${generateSensitiveValues(`st-${runCounter + 1}:catalog-a-demo`).password}`;
      const run = await exec(goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }), {
        script: async ({ world, onEvent, request }) => {
          emitExecuted(onEvent);
          world.pageText = withSecret;
          world.callJev(request.goal);
          return results.completed(request.goal);
        },
      });
      ok(run.has('screenshots/step-00-initial.png'), 'initial page showed nothing sensitive');
      ok(
        !run.has('screenshots/step-01-executed.png') && !run.has('screenshots/final.png'),
        'sensitive pages are not captured'
      );
      ok(run.read('trace.json').notes.some(note => note.includes('skipped')));
    }
  );
  await check(
    'runner: a value that appears while a screenshot is being taken removes that screenshot again',
    async () => {
      const withSecret = `card ${generateSensitiveValues(`st-${runCounter + 1}:catalog-a-demo`).password}`;
      const run = await exec(goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }), {
        visibleTexts: ['clean before the shot', withSecret],
      });
      ok(
        !run.has('screenshots/step-00-initial.png'),
        'the first probe was clean, the second was not'
      );
      ok(run.has('screenshots/step-01-executed.png') && run.has('screenshots/final.png'));
      ok(run.read('trace.json').notes.some(note => note.includes('removed')));
      ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
    }
  );
  await check('runner: an unreadable page counts as showing a secret (no screenshot)', async () => {
    const world = makeWorld();
    world.page.evaluate = async () => {
      throw new Error('page is gone');
    };
    const runId = `st-${(runCounter += 1)}`;
    const outcome = await runScenario({
      scenario: goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }),
      env: {},
      bundles: { umd: 'u' },
      browser: {},
      gate: {},
      runId,
      evidenceRoot,
      dist: { sha256: DIST_SHA },
      deps: world.deps,
    });
    const shots = path.join(evidenceRoot, runId, 'catalog-a-demo', 'screenshots');
    ok(!fs.existsSync(shots) || fs.readdirSync(shots).length === 0, 'no screenshot may exist');
    ok(outcome.passed, JSON.stringify(outcome.failures));
  });
  await check(
    'runner: sensitive scenarios capture a page that shows nothing sensitive; plain scenarios never probe',
    async () => {
      const sensitiveRun = await exec(
        goodLive({ inputs: sensitive => ({ secret: sensitive.password }) })
      );
      ok(
        sensitiveRun.has('screenshots/step-01-executed.png') &&
          sensitiveRun.has('screenshots/final.png')
      );
      ok(sensitiveRun.world.evaluateCalls >= 3);
      const plain = await exec(goodLive());
      ok(
        plain.world.evaluateCalls === undefined,
        'no DOM probe for a scenario without sensitive values'
      );
    }
  );
  await check(
    'runner: the dist argument may be a module namespace and the sha256 of the bundles is the fallback',
    async () => {
      const world = makeWorld();
      const runId = `st-${(runCounter += 1)}`;
      const outcome = await runScenario({
        scenario: goodLive(),
        env: {},
        bundles: { umd: 'u', sha256: 'b'.repeat(64) },
        browser: {},
        gate: {},
        runId,
        evidenceRoot,
        dist: world.deps.dist,
        deps: { ...world.deps, dist: undefined },
      });
      ok(outcome.passed, JSON.stringify(outcome.failures));
      const summary = JSON.parse(
        fs.readFileSync(path.join(evidenceRoot, runId, 'catalog-a-demo', 'summary.json'), 'utf8')
      );
      ok(summary.sha256 === 'b'.repeat(64));
    }
  );
  await check(
    'runner: it never rejects, even when the evidence root is unusable or the run id is unsafe',
    async () => {
      const blocker = path.join(scratch, 'blocker');
      fs.writeFileSync(blocker, 'file');
      const world = makeWorld();
      const unusable = await runScenario({
        scenario: goodLive(),
        env: {},
        bundles: { umd: 'u' },
        browser: {},
        gate: {},
        runId: 'x',
        evidenceRoot: blocker,
        dist: {},
        deps: world.deps,
      });
      ok(!unusable.passed && unusable.failure.kind === 'evidence_failed');
      const unsafe = await runScenario({
        scenario: goodLive(),
        env: {},
        bundles: { umd: 'u' },
        browser: {},
        gate: {},
        runId: '../escape',
        evidenceRoot,
        dist: {},
        deps: world.deps,
      });
      ok(!unsafe.passed && unsafe.failure.kind === 'evidence_failed');
      ok(!fs.existsSync(path.join(scratch, 'escape')));
    }
  );
  await check(
    'runner: concurrent scenarios keep separate evidence directories and states',
    async () => {
      const [a, b] = await Promise.all([
        exec(goodLive({ id: 'catalog-a-par-one' }), {
          script: async ({ world, request }) => (
            await sleep(30),
            world.callJev(request.goal),
            world.backend.searches.push({ q: 'one' }),
            results.completed(request.goal)
          ),
        }),
        exec(goodLive({ id: 'catalog-a-par-two' }), {
          script: async ({ world, request }) => (
            world.callJev(request.goal),
            results.completed(request.goal)
          ),
        }),
      ]);
      ok(a.outcome.passed && b.outcome.passed && a.dir !== b.dir);
      eq(a.read('backend-after.json').searches.length, 1);
      eq(b.read('backend-after.json').searches.length, 0);
    }
  );
  await check(
    'runner: a sensitive value in a Jev request is a jev_request_secret leak (exit 4) even though jev.mjs masks it on disk',
    async () => {
      let credentialCalls = 0;
      const sendRequest = world =>
        world.deciderConfig.http('https://api.example.test/v1', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credential: () => {
            credentialCalls += 1;
            return FAKE_KEY;
          },
          body: JSON.stringify({ questions: { q: { note: `typed ${world.secretValue}` } } }),
          timeoutMs: 1000,
        });
      let secretValue;
      const run = await exec(goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }), {
        script: async ({ world, request }) => {
          secretValue = request.inputs.secret;
          world.secretValue = secretValue;
          world.callJev(request.goal);
          await sendRequest(world);
          return results.completed(request.goal);
        },
      });
      ok(!run.outcome.passed && run.outcome.leak === true, JSON.stringify(run.outcome.failures));
      ok(kinds(run.outcome).includes('jev_request_secret'), JSON.stringify(kinds(run.outcome)));
      ok(
        run.outcome.leaks.some(
          hit => hit.label === 'sensitive.password' && hit.variant === 'request'
        )
      );
      ok(!JSON.stringify(run.outcome).includes(secretValue), 'the outcome must not hold the value');
      ok(credentialCalls === 0, 'the harness must never call credential() itself');

      const clean = await exec(
        goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }),
        {
          script: async ({ world, request }) => {
            world.secretValue = 'nothing secret here';
            world.callJev(request.goal);
            await sendRequest(world);
            return results.completed(request.goal);
          },
        }
      );
      ok(
        clean.outcome.passed && clean.outcome.leak === false,
        JSON.stringify(clean.outcome.failures)
      );

      const keyInHeader = await exec(goodLive(), {
        script: async ({ world, request }) => {
          world.callJev(request.goal);
          await world.deciderConfig.http('https://api.example.test/v1', {
            method: 'POST',
            headers: { 'x-debug': `Bearer ${FAKE_KEY}` },
            credential: () => FAKE_KEY,
            body: '{}',
            timeoutMs: 1000,
          });
          return results.completed(request.goal);
        },
      });
      ok(
        keyInHeader.outcome.leak &&
          keyInHeader.outcome.leaks.some(hit => hit.label === 'TYPESAFE_API_KEY'),
        'the key in a header counts'
      );
    }
  );
  await check(
    'runner: heuristic-sensitive input without a declaration is scanned and capture-guarded',
    async () => {
      const secret = `probe-${randomBytes(8).toString('hex')}`;
      const run = await exec(
        goodLive({
          inputs: { credentials: { password: secret } },
          expect: async (_app, _result, _page, ctx) => {
            fs.writeFileSync(path.join(ctx.evidenceDir, 'heuristic.txt'), secret);
          },
        })
      );
      ok(run.outcome.leak && run.outcome.leaks.some(hit => hit.label.includes('heuristic:')));
      ok(run.world.evaluateCalls > 0);
    }
  );
  await check('runner: key is redacted even if an input callback throws before setup', async () => {
    const run = await exec(
      goodLive({
        inputs: () => {
          throw new Error(FAKE_KEY);
        },
      })
    );
    ok(!run.outcome.passed && !JSON.stringify(run.read('summary.json')).includes(FAKE_KEY));
  });
  await check(
    'runner: every leaf below a sensitive declaration is a secret, numbers included',
    async () => {
      const holder = `Holder-${randomBytes(4).toString('hex')}`;
      const scenario = goodLive({
        inputs: sensitive => ({
          payment: { card: { number: sensitive.cardNumber, holder }, pin: 48151623 },
        }),
        inputDeclarations: [
          { path: 'payment.card', sensitive: true },
          { path: 'payment.pin', sensitive: true },
        ],
        expect: async (app, result, page, ctx) => {
          fs.writeFileSync(path.join(ctx.evidenceDir, 'holder.txt'), `h=${holder}`);
          fs.writeFileSync(path.join(ctx.evidenceDir, 'pin.txt'), 'pin=48151623');
        },
      });
      const run = await exec(scenario);
      const labels = run.outcome.leaks.map(hit => `${hit.file}:${hit.label}`).sort();
      ok(
        labels.includes('holder.txt:input:payment.card.holder') &&
          labels.includes('pin.txt:input:payment.pin'),
        labels.join(' | ')
      );
      ok(!fs.readFileSync(path.join(run.dir, 'holder.txt'), 'utf8').includes(holder), 'scrubbed');
    }
  );
  await check(
    'runner: a live scenario whose Jev attempts were never answered fails (no_jev_answer); a fault scenario does not',
    async () => {
      const unanswered = {
        script: async ({ world, request }) => {
          world.callJev(request.goal, { status: 401, response: null, model: null });
          return results.completed(request.goal);
        },
      };
      const live = await exec(goodLive(), unanswered);
      ok(
        !live.outcome.passed && kinds(live.outcome).includes('no_jev_answer'),
        JSON.stringify(kinds(live.outcome))
      );
      const expectingFailure = await exec(goodLive({ expectStatus: ['failed', 'blocked'] }), {
        script: async ({ world, request }) => {
          world.callJev(request.goal, { status: 401, response: null, model: null });
          return results.failed(request.goal);
        },
      });
      ok(
        !expectingFailure.outcome.passed &&
          kinds(expectingFailure.outcome).includes('no_jev_answer'),
        'a bad key must not make a live refusal scenario pass'
      );
      const fault = await exec(goodFault(), unanswered);
      ok(fault.outcome.passed, JSON.stringify(fault.outcome.failures));
    }
  );
  await check('runner: the model pattern is anchored (x-jev-1 is not a jev model)', async () => {
    const run = await exec(goodLive(), {
      script: async ({ world, request }) => (
        world.callJev(request.goal, { model: 'x-jev-1', response: { model: 'x-jev-1' } }),
        results.completed(request.goal)
      ),
    });
    ok(!run.outcome.passed && kinds(run.outcome).includes('jev_model'));
  });
  await check(
    'runner: an app host in library text is a hint even when no other rule sees it',
    async () => {
      const run = await exec(goodLive(), {
        appOrigin: 'http://shop.test:4010',
        script: async ({ world, request }) => {
          world.callJev(request.goal, {
            request: {
              questions: {
                q: {
                  instructions: { goal: request.goal, rules: ['Stay on shop.test:4010 please'] },
                },
              },
            },
          });
          return results.completed(request.goal);
        },
      });
      ok(
        !run.outcome.passed &&
          run.outcome.failures.some(f => f.kind === 'jev_hint' && f.message.includes('app host')),
        JSON.stringify(run.outcome.failures)
      );
    }
  );
  await check(
    'runner: a lone slash in library wording is not an app route (negative control for the root path)',
    async () => {
      const run = await exec(goodLive(), {
        requests: [{ seq: 1, method: 'GET', path: '/', query: {}, bodySummary: null }],
        script: async ({ world, request }) => {
          world.callJev(request.goal, {
            request: {
              questions: {
                q: {
                  instructions: {
                    goal: request.goal,
                    rules: ['Pick yes / no, and/or read-only data.'],
                  },
                },
              },
            },
          });
          return results.completed(request.goal);
        },
      });
      ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
    }
  );
  await check(
    'runner: a paused result without a checkpoint is a resume_mismatch and sends no resume',
    async () => {
      const run = await exec(
        goodLive({ resume: [{ on: 'needs_input', resolution: { inputs: { a: 'b' } } }] }),
        {
          script: async ({ world, request }) => (
            world.callJev(request.goal),
            { ...results.needsInput(request.goal), checkpoint: undefined }
          ),
        }
      );
      ok(!run.outcome.passed && kinds(run.outcome).includes('resume_mismatch'));
      ok(run.world.resumeRequests.length === 0, 'no resume may be sent');
    }
  );
  await check(
    'runner: a close step that hangs is abandoned after closeTimeoutMs and the rest still closes',
    async () => {
      const started = Date.now();
      const run = await exec(
        goodLive(),
        { contextCloseHangs: true },
        { deps: { closeTimeoutMs: 40 } }
      );
      ok(Date.now() - started < 4000, 'must not wait for the hung close');
      ok(run.world.log.includes('app.close'), 'the app is closed after the hung context');
      ok(
        run.read('summary.json').notes.some(note => note.includes('close page and context failed'))
      );
      ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
    }
  );
  await check(
    'runner: an expect() that never settles fails after expectTimeoutMs and closes',
    async () => {
      const started = Date.now();
      const run = await exec(
        goodLive({ expect: () => new Promise(() => undefined) }),
        {},
        { deps: { expectTimeoutMs: 40 } }
      );
      ok(!run.outcome.passed && kinds(run.outcome).includes('expect_failed'));
      ok(run.outcome.failure.message.includes('did not finish'), run.outcome.failure.message);
      ok(Date.now() - started < 4000);
      ok(run.world.log.includes('app.close') && run.world.log.includes('context.close'));
    }
  );
  await check(
    'runner: the watchdog covers the agent run only: a slow expect() is not aborted or cancelled by it',
    async () => {
      const run = await exec(
        goodLive({
          expect: async () => {
            await sleep(180);
          },
        }),
        {},
        { deps: { maxScenarioMs: 60, abortGraceMs: 30 } }
      );
      ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
      ok(run.world.signal.aborted === false, 'the run signal was aborted during expect');
      ok(run.world.cancelCalled === undefined, 'agent.cancel was called during expect');
    }
  );
  await check(
    'runner: no timer outlives a finished scenario (cancel and deadline timers are cleared)',
    async () => {
      const timers = () =>
        process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
      await sleep(5); // the per-check watchdog of this selftest exists by now and belongs to `before`
      const before = timers();
      const run = await exec(
        goodLive({ run: { cancelAfterMs: 500000 } }),
        {},
        { deps: { maxScenarioMs: 3600000, abortGraceMs: 3600000 } }
      );
      ok(run.outcome.passed, JSON.stringify(run.outcome.failures));
      ok(timers() <= before, `timers before ${before}, after ${timers()}`);
    }
  );
  await check(
    'runner: a failure message that quotes a secret is redacted before it is kept',
    async () => {
      let value;
      const run = await exec(
        goodLive({
          inputs: sensitive => ({ secret: sensitive.password }),
          expect: async (app, result, page, ctx) => {
            value = ctx.sensitive.password;
            throw new Error(`the field held ${value} and ${encodeURIComponent(value)}`);
          },
        })
      );
      ok(!run.outcome.passed && run.outcome.failure.kind === 'expect_failed');
      ok(!JSON.stringify(run.outcome).includes(value), 'outcome');
      ok(run.outcome.leak === false, 'redacted before it was written, so nothing leaked');
      ok(!fs.readFileSync(path.join(run.dir, 'failure', 'failures.json'), 'utf8').includes(value));
      ok(!fs.readFileSync(path.join(run.dir, 'summary.json'), 'utf8').includes(value));
    }
  );
  await check(
    'runner: a close error that quotes a secret is redacted in the notes (nothing leaks through summary.json)',
    async () => {
      const value = generateSensitiveValues(`st-${runCounter + 1}:catalog-a-demo`).password;
      const run = await exec(goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }), {
        contextCloseError: `could not close, last value ${value}`,
      });
      ok(run.outcome.passed && run.outcome.leak === false, JSON.stringify(run.outcome.failures));
      const notes = run.read('summary.json').notes;
      ok(
        notes.some(note => note.includes('close page and context failed')),
        'the close failure is recorded'
      );
      ok(!JSON.stringify(notes).includes(value), 'the note is redacted');
    }
  );
  await check(
    'runner: failure artifacts redact a page that cannot be read (page-error.txt)',
    async () => {
      const value = generateSensitiveValues(`st-${runCounter + 1}:catalog-a-demo`).password;
      const world = makeWorld();
      world.page.content = async () => {
        throw new Error(`cannot serialize, field held ${value}`);
      };
      const runId = `st-${(runCounter += 1)}`;
      const outcome = await runScenario({
        scenario: goodLive({
          inputs: sensitive => ({ secret: sensitive.password }),
          expectStatus: 'failed',
        }),
        env: {},
        bundles: { umd: 'u' },
        browser: {},
        gate: {},
        runId,
        evidenceRoot,
        dist: { sha256: DIST_SHA },
        deps: world.deps,
      });
      const dir = path.join(evidenceRoot, runId, 'catalog-a-demo');
      ok(!outcome.passed && outcome.leak === false, JSON.stringify(outcome.failures));
      ok(fs.existsSync(path.join(dir, 'failure', 'page-error.txt')), 'the page error is kept');
      ok(scanForSecrets(dir, [value]).hits.length === 0, 'and holds no secret');
    }
  );
  await check(
    'runner: a scan that checked no value is a failure (evidence_scan_empty)',
    async () => {
      const run = await exec(
        goodLive(),
        {},
        { deps: { readApiKey: () => '', generateSensitiveValues: () => ({}) } }
      );
      ok(
        !run.outcome.passed && kinds(run.outcome).includes('evidence_scan_empty'),
        JSON.stringify(kinds(run.outcome))
      );
      const normal = await exec(goodLive());
      ok(normal.outcome.passed);
    }
  );
  await check(
    'runner: a secret that only reaches summary.json after the scan is still caught and scrubbed',
    async () => {
      let value;
      const run = await exec(goodLive({ inputs: sensitive => ({ secret: sensitive.password }) }), {
        script: async ({ world, request, onEvent }) => {
          emitExecuted(onEvent);
          value = request.inputs.secret;
          world.callJev(request.goal, { model: `jev-${value}`, response: { model: 'jev-1.13.0' } });
          return results.completed(request.goal);
        },
      });
      ok(run.outcome.leak === true && !run.outcome.passed);
      ok(scanForSecrets(run.dir, [value]).hits.length === 0, 'every file is clean after the run');
      ok(!fs.readFileSync(path.join(run.dir, 'summary.json'), 'utf8').includes(value));
    }
  );
  await check(
    'runner: it refuses to write into an evidence directory that already holds files',
    async () => {
      const world = makeWorld();
      const args = {
        scenario: goodLive({ id: 'catalog-a-reuse' }),
        env: {},
        bundles: { umd: 'u' },
        browser: {},
        gate: {},
        runId: 'reused-run',
        evidenceRoot,
        dist: { sha256: DIST_SHA },
        deps: world.deps,
      };
      const first = await runScenario(args);
      ok(first.passed, JSON.stringify(first.failures));
      const dir = path.join(evidenceRoot, 'reused-run', 'catalog-a-reuse');
      const before = fs.readFileSync(path.join(dir, 'summary.json'), 'utf8');
      const second = await runScenario({ ...args, deps: makeWorld().deps });
      ok(
        !second.passed && second.failure.kind === 'evidence_failed',
        JSON.stringify(second.failure)
      );
      ok(second.failure.message.includes('already holds files'), second.failure.message);
      eq(
        fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'),
        before,
        'the first run is untouched'
      );
    }
  );
  await check('assertJevCalls: unit controls for goal, hint and model checks', () => {
    const scenario = { goal: LIVE_GOAL, kind: 'live' };
    const clean = assertJevCalls({ calls: [jevEntry(LIVE_GOAL)], scenario });
    ok(clean.failures.length === 0 && clean.models[0] === 'jev-1.13.0');
    const wrongGoal = assertJevCalls({ calls: [jevEntry('x')], scenario });
    ok(wrongGoal.failures.some(f => f.kind === 'jev_goal'));
    const parsedFromString = assertJevCalls({
      calls: [jevEntry(LIVE_GOAL, { request: JSON.stringify(jevEntry(LIVE_GOAL).request) })],
      scenario,
    });
    ok(parsedFromString.failures.length === 0, 'string request bodies are parsed');
    const unparseable = assertJevCalls({
      calls: [jevEntry(LIVE_GOAL, { request: '[UNREDACTABLE]' })],
      scenario,
    });
    ok(unparseable.failures.some(f => f.kind === 'jev_request_missing'));
    const flood = assertJevCalls({
      calls: Array.from({ length: 40 }, () => jevEntry('x')),
      scenario,
    });
    ok(flood.failures.length === 21 && flood.failures[20].kind === 'jev_overflow');
  });
  await check(
    'readApiKey: reads the environment variable trimmed and returns an empty string when it is unset',
    () => {
      const before = process.env.TYPESAFE_API_KEY;
      try {
        process.env.TYPESAFE_API_KEY = `  ${FAKE_KEY}  `;
        eq(readApiKey(), FAKE_KEY);
        delete process.env.TYPESAFE_API_KEY;
        eq(readApiKey(), '');
      } finally {
        if (before === undefined) {
          delete process.env.TYPESAFE_API_KEY;
        } else {
          process.env.TYPESAFE_API_KEY = before;
        }
      }
    }
  );
}

async function cliChecks() {
  await check('cli: calibration flags are explicit bounded runtime options', () => {
    const parsed = parseArgs([
      '--action-confidence',
      '0.2',
      '--argument-confidence',
      '0.3',
      '--completion-confidence',
      '0.6',
      '--observe-offscreen',
    ]);
    eq(parsed.errors, []);
    eq(parsed.options.confidence, { action: 0.2, argument: 0.3, completion: 0.6 });
    ok(parsed.options.observeOffscreen === true);
    for (const bad of ['-1', '1.1', 'NaN'])
      ok(parseArgs(['--action-confidence', bad]).errors.length > 0);
  });

  await check(
    'cli: parseArgs reads repeated and multi-value flags, = forms, and normalizes variants',
    () => {
      const { options, errors } = parseArgs([
        '--scenario',
        'a',
        'b',
        '--scenario',
        'c',
        '--family=catalog,settings',
        '--variant',
        'a',
        '--jobs',
        '2',
        '--kind',
        'live',
      ]);
      eq(errors, []);
      eq(options.scenarios, ['a', 'b', 'c']);
      eq(options.families, ['catalog', 'settings']);
      eq(options.variants, ['A']);
      ok(options.jobs === 2 && options.kind === 'live' && options.jevConcurrency === 3);
    }
  );
  await check(
    'cli: bad arguments are exit 2 (unknown flag, missing value, bad numbers and enums)',
    async () => {
      for (const argv of [
        ['--bogus'],
        ['--jobs'],
        ['--jobs', '0'],
        ['--jobs', 'x'],
        ['--kind', 'maybe'],
        ['--family', 'billing'],
        ['--variant', 'Z'],
        ['--jev-concurrency', '99'],
        ['--run-id', '../x'],
      ]) {
        const run = await runCli(argv, { files: { 'a.mjs': [goodLive()] }, deps: cliDeps().deps });
        ok(run.code === 2, `${argv.join(' ')} -> ${run.code}`);
        ok(run.err.includes('error:'), 'the problem is named');
      }
    }
  );
  await check('cli: --help prints usage with the exit codes and exits 0', async () => {
    const run = await runCli(['--help'], { deps: cliDeps().deps });
    ok(run.code === 0 && run.out.includes('Exit codes') && run.out.includes('--jev-concurrency'));
  });
  await check('cli: --list prints id, family, variant, kind and title; filters apply', async () => {
    const files = { 'a.mjs': demoSet() };
    const all = await runCli(['--list'], { files, deps: cliDeps().deps });
    ok(all.code === 0 && all.out.includes('5 scenario(s)'));
    ok(
      all.out
        .split('\n')
        .some(
          line =>
            line.includes('checkout-c-three') &&
            line.includes('checkout') &&
            line.includes('fault') &&
            line.includes('Demo scenario')
        )
    );
    const faultOnly = await runCli(['--list', '--kind', 'fault'], { files, deps: cliDeps().deps });
    ok(faultOnly.out.includes('1 scenario(s)') && faultOnly.out.includes('checkout-c-three'));
    const family = await runCli(['--list', '--family', 'catalog', '--variant', 'C'], {
      files,
      deps: cliDeps().deps,
    });
    ok(family.out.includes('1 scenario(s)') && family.out.includes('catalog-c-five'));
  });
  await check('cli: --validate exits 0 on good files and non-zero on any error', async () => {
    const good = await runCli(['--validate'], {
      files: { 'a.mjs': demoSet() },
      deps: cliDeps().deps,
    });
    ok(
      good.code === 0 && good.out.includes('validated 5 scenario(s), 0 problem(s)'),
      good.out + good.err
    );
    const bad = await runCli(['--validate'], {
      files: {
        'a.mjs': [
          goodLive(),
          goodLive({
            id: 'catalog-a-bad',
            goal: 'Click the Save button after the digest is off for me.',
          }),
        ],
      },
    });
    ok(bad.code === 1 && bad.err.includes('catalog-a-bad') && bad.err.includes('goal '), bad.err);
  });
  await check(
    'cli: --validate fails on duplicates, import errors, empty directories and unknown app options',
    async () => {
      ok(
        (await runCli(['--validate'], { files: { 'a.mjs': [goodLive()], 'b.mjs': [goodLive()] } }))
          .code === 1,
        'duplicate ids'
      );
      ok(
        (await runCli(['--validate'], { files: { 'a.mjs': 'export const scenarios = [ ;\n' } }))
          .code === 1,
        'import error'
      );
      const empty = await runCli(['--validate'], { files: {} });
      ok(empty.code === 1 && empty.err.includes('validating nothing proves nothing'));
      const option = await runCli(['--validate'], {
        files: { 'a.mjs': [goodLive({ faults: { teleport: true } })] },
      });
      ok(option.code === 1 && option.err.includes('faults.teleport'));
    }
  );
  await check('cli: selection errors are exit 2 (unknown id, nothing selected)', async () => {
    const files = { 'a.mjs': demoSet() };
    const unknown = await runCli(['--scenario', 'nope'], { files, deps: cliDeps().deps });
    ok(unknown.code === 2 && unknown.err.includes('unknown scenario id'));
    const none = await runCli(['--family', 'settings', '--kind', 'fault'], {
      files,
      deps: cliDeps().deps,
    });
    ok(none.code === 2 && none.err.includes('no scenario matches'));
  });
  await check(
    'cli: invalid scenarios block the run (exit 2) before any scenario starts',
    async () => {
      const harness = cliDeps();
      const run = await runCli([], {
        files: {
          'a.mjs': [
            goodLive({ goal: 'See https://x.example.test now and find the mouse for me.' }),
          ],
        },
        deps: harness.deps,
      });
      ok(run.code === 2 && run.err.includes('invalid scenario') && harness.seen.ids.length === 0);
    }
  );
  await check(
    'cli: preflight failure is exit 2 and lists the problems; the dist check never runs after it',
    async () => {
      let distCalled = false;
      const harness = cliDeps({
        deps: {
          preflight: () => ({ ok: false, exitCode: 2, problems: ['TYPESAFE_API_KEY is not set'] }),
          checkDist: () => {
            distCalled = true;
            return { ok: true };
          },
        },
      });
      const run = await runCli([], { files: { 'a.mjs': [goodLive()] }, deps: harness.deps });
      ok(
        run.code === 2 &&
          run.err.includes('TYPESAFE_API_KEY is not set') &&
          !distCalled &&
          harness.seen.ids.length === 0
      );
    }
  );
  await check(
    'cli: a stale or incomplete dist is exit 3 (fake check and the real check on a tree without dist)',
    async () => {
      const harness = cliDeps({
        deps: {
          checkDist: () => ({
            ok: false,
            exitCode: 3,
            reasons: ['stale dist: src/agent/x.ts is newer'],
          }),
        },
      });
      const stale = await runCli([], { files: { 'a.mjs': [goodLive()] }, deps: harness.deps });
      ok(stale.code === 3 && stale.err.includes('stale dist') && harness.seen.ids.length === 0);
      const bare = path.join(scratch, 'bare-root');
      fs.mkdirSync(bare, { recursive: true });
      const real = cliDeps();
      delete real.deps.checkDist;
      const io = capture();
      const dir = writeScenarioDir('cli-real-dist', { 'a.mjs': [goodLive()] });
      const code = await main({
        argv: ['--scenarios-dir', dir, '--root', bare],
        deps: real.deps,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      ok(code === 3 && io.err().includes('missing dist/index.esm.js'), `${code} ${io.err()}`);
    }
  );
  await check('cli: browser or gate start failure is exit 2', async () => {
    const harness = cliDeps({
      deps: {
        launchBrowser: async () => {
          throw new Error('no browser');
        },
      },
    });
    const run = await runCli([], { files: { 'a.mjs': [goodLive()] }, deps: harness.deps });
    ok(run.code === 2 && run.err.includes('could not start'));
  });
  await check(
    'cli: all passing is exit 0, labelled live vs fault-injected, with a run summary under the run id',
    async () => {
      const harness = cliDeps();
      const run = await runCli(['--run-id', 'selftest-run'], {
        files: { 'a.mjs': demoSet() },
        deps: harness.deps,
      });
      ok(run.code === 0, run.err);
      ok(run.out.includes('live-verified (real Jev, real Chromium, real dist): 4 of 4'));
      ok(run.out.includes('fault-injected (labelled, not live verification): 1 of 1'));
      ok(
        run.out
          .split('\n')
          .some(line => line.startsWith('PASS FAULT-INJECTED') && line.includes('checkout-c-three'))
      );
      const summary = JSON.parse(
        fs.readFileSync(
          path.join(scratch, 'cli-evidence', 'selftest-run', 'run-summary.json'),
          'utf8'
        )
      );
      ok(
        summary.exitCode === 0 &&
          summary.results.length === 5 &&
          summary.liveVerified.total === 4 &&
          summary.faultInjected.total === 1
      );
      ok(harness.seen.browserClosed, 'the browser is closed');
    }
  );
  await check(
    'cli: a failing scenario is exit 1 and names its failure; a leak outranks it with exit 4',
    async () => {
      const failing = id => async args => ({
        id: args.scenario.id,
        kind: args.scenario.kind,
        passed: args.scenario.id !== id,
        status: 'failed',
        durationMs: 1,
        calls: 1,
        leak: false,
        failures:
          args.scenario.id === id ? [{ kind: 'expect_failed', message: 'backend mismatch' }] : [],
      });
      const failed = cliDeps({ deps: { runScenario: failing('catalog-a-one') } });
      const run = await runCli([], { files: { 'a.mjs': demoSet() }, deps: failed.deps });
      ok(
        run.code === 1 &&
          run.out.includes('FAIL LIVE') &&
          run.out.includes('expect_failed: backend mismatch')
      );
      const leaking = cliDeps({
        deps: {
          runScenario: async args => ({
            id: args.scenario.id,
            kind: args.scenario.kind,
            passed: args.scenario.id !== 'settings-b-two' && args.scenario.id !== 'catalog-a-one',
            leak: args.scenario.id === 'settings-b-two',
            status: 'completed',
            failures: [{ kind: 'evidence_secret', message: 'hit' }],
          }),
        },
      });
      ok((await runCli([], { files: { 'a.mjs': demoSet() }, deps: leaking.deps })).code === 4);
    }
  );
  await check('cli: filters select the expected scenarios for the run', async () => {
    const files = { 'a.mjs': demoSet() };
    const byId = cliDeps();
    await runCli(['--scenario', 'settings-b-two', 'shipping-a-four'], { files, deps: byId.deps });
    eq(byId.seen.ids.sort(), ['settings-b-two', 'shipping-a-four']);
    const byKind = cliDeps();
    await runCli(['--kind', 'fault'], { files, deps: byKind.deps });
    eq(byKind.seen.ids, ['checkout-c-three']);
    const byFamily = cliDeps();
    await runCli(['--family', 'catalog', '--variant', 'A,C'], { files, deps: byFamily.deps });
    eq(byFamily.seen.ids.sort(), ['catalog-a-one', 'catalog-c-five']);
  });
  await check(
    'cli: --jobs bounds the number of scenarios in flight (default 1, 2 reaches 2, never above the bound)',
    async () => {
      const files = { 'a.mjs': demoSet() };
      const serial = cliDeps({ delayMs: 20 });
      await runCli([], { files, deps: serial.deps });
      eq(serial.seen.peak, 1, 'default is serial');
      const two = cliDeps({ delayMs: 40 });
      await runCli(['--jobs', '2'], { files, deps: two.deps });
      eq(two.seen.peak, 2, 'two lanes');
      eq(two.seen.ids.length, 5);
      const three = cliDeps({ delayMs: 20 });
      await runCli(['--jobs', '3'], { files, deps: three.deps });
      ok(three.seen.peak <= 3 && three.seen.peak >= 2);
    }
  );
  await check(
    'cli: an empty filter value is a usage error, never "every scenario against the live model"',
    async () => {
      const files = { 'a.mjs': demoSet() };
      for (const argv of [
        ['--scenario', ''],
        ['--scenario='],
        ['--scenario', ','],
        ['--family', ''],
        ['--variant='],
      ]) {
        const harness = cliDeps();
        const run = await runCli(argv, { files, deps: harness.deps });
        ok(run.code === 2 && harness.seen.ids.length === 0, `${argv.join(' ')} -> ${run.code}`);
        ok(run.err.includes('non-empty'), run.err);
      }
      eq(parseArgs(['--run-id', 'a/b']).errors.length, 1, 'a slash in a run id');
      eq(
        parseArgs(['--run-id', 'a..b']).errors.length,
        1,
        'dot-dot in a run id (the writer refuses it too)'
      );
      eq(parseArgs(['--run-id', 'run-2026.10_03a']).errors.length, 0, 'an ordinary run id');
    }
  );
  await check(
    'cli: a run id that already holds evidence for a selected scenario is exit 2 and nothing runs',
    async () => {
      const files = { 'a.mjs': demoSet() };
      const first = cliDeps();
      const one = await runCli(['--run-id', 'twice', '--scenario', 'catalog-a-one'], {
        files,
        deps: first.deps,
      });
      ok(one.code === 0, one.err);
      const mark = path.join(scratch, 'cli-evidence', 'twice', 'catalog-a-one');
      fs.mkdirSync(mark, { recursive: true });
      fs.writeFileSync(path.join(mark, 'summary.json'), '{"old":true}');
      const second = cliDeps();
      const again = await runCli(['--run-id', 'twice', '--scenario', 'catalog-a-one'], {
        files,
        deps: second.deps,
      });
      ok(again.code === 2 && second.seen.ids.length === 0, `${again.code}: ${again.err}`);
      ok(again.err.includes('never overwritten'), again.err);
      eq(fs.readFileSync(path.join(mark, 'summary.json'), 'utf8'), '{"old":true}');
      const other = cliDeps();
      const fresh = await runCli(['--run-id', 'twice', '--scenario', 'settings-b-two'], {
        files,
        deps: other.deps,
      });
      ok(
        fresh.code === 0 && other.seen.ids.length === 1,
        'a different scenario of the same run id is fine'
      );
    }
  );
  await check(
    'cli: SIGINT and SIGTERM handlers exist only while scenarios run, and only when asked for',
    async () => {
      const files = { 'a.mjs': [goodLive()] };
      const baseline = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
      const during = [];
      const trapped = cliDeps({
        deps: {
          trapSignals: true,
          runScenario: async args => {
            during.push(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)));
            return {
              id: args.scenario.id,
              kind: 'live',
              passed: true,
              status: 'completed',
              leak: false,
            };
          },
        },
      });
      ok((await runCli([], { files, deps: trapped.deps })).code === 0);
      eq(
        during[0],
        baseline.map(count => count + 1),
        'one handler each while running'
      );
      eq(
        ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)),
        baseline,
        'removed afterwards'
      );
      const untrapped = cliDeps({
        deps: {
          runScenario: async args => {
            during.push(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)));
            return {
              id: args.scenario.id,
              kind: 'live',
              passed: true,
              status: 'completed',
              leak: false,
            };
          },
        },
      });
      ok((await runCli([], { files, deps: untrapped.deps })).code === 0);
      eq(during[1], baseline, 'a faked browser installs no handler');
    }
  );
  // runs run.mjs's main() in a child process with a browser that stands in for the real one, sends SIGTERM
  // once the first scenario is running and reports how the child ended
  async function interruptedRun({ name, closeHangs, graceMs }) {
    const dir = writeScenarioDir(`proc-${name}`, { 'a.mjs': [goodLive()] });
    const marker = path.join(scratch, `${name}-marker.txt`);
    const script = path.join(scratch, `${name}-driver.mjs`);
    const close = closeHangs
      ? 'new Promise(() => undefined)'
      : `Promise.resolve().then(() => fs.writeFileSync(${JSON.stringify(marker)}, 'closed'))`;
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
import { main } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'e2e', 'run.mjs')).href)};
setInterval(() => undefined, 1000); // stands in for the browser process that keeps a real run alive
const code = await main({
  argv: ['--scenarios-dir', ${JSON.stringify(dir)}, '--evidence-root', ${JSON.stringify(path.join(scratch, `${name}-evidence`))}, '--root', ${JSON.stringify(REPO_ROOT)}],
  deps: {
    trapSignals: true,
    interruptGraceMs: ${graceMs},
    preflight: () => ({ ok: true, problems: [] }),
    checkDist: () => ({ ok: true, sha256: 'a'.repeat(64) }),
    readBundles: () => ({ umd: 'u', esmUrl: 'file:///x', sha256: 'a'.repeat(64) }),
    launchBrowser: async () => ({ close: () => ${close} }),
    getProcessGate: () => ({}),
    runScenario: () => { process.stdout.write('READY\\n'); return new Promise(() => undefined); },
  },
});
process.exit(code);
`
    );
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let signalledAt = 0;
    child.stdout.on('data', chunk => {
      output += chunk;
      if (signalledAt === 0 && output.includes('READY')) {
        signalledAt = Date.now();
        child.kill('SIGTERM');
      }
    });
    const exit = await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: 'timeout', signal: null });
      }, 45000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    ok(signalledAt > 0, 'the driver never reached the run');
    return {
      exit,
      exitedAfterMs: Date.now() - signalledAt,
      closed: fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'closed',
    };
  }
  await check('cli: as a process, SIGTERM closes the browser and exits 130 at once', async () => {
    // a long grace: only the normal path (browser closed, then exit) can end the process quickly
    const { exit, exitedAfterMs, closed } = await interruptedRun({
      name: 'sigterm',
      closeHangs: false,
      graceMs: 30000,
    });
    ok(exit.code === 130, `exit ${JSON.stringify(exit)}`);
    ok(closed, 'the browser was not closed');
    ok(
      exitedAfterMs < 6000,
      `exit took ${exitedAfterMs} ms: the handler must exit once the browser is closed, not wait for the hard limit`
    );
  });
  await check(
    'cli: as a process, a browser that never closes does not stop SIGTERM from ending the run (130 after the grace)',
    async () => {
      const { exit, exitedAfterMs } = await interruptedRun({
        name: 'sigterm-hung',
        closeHangs: true,
        graceMs: 300,
      });
      ok(exit.code === 130, `exit ${JSON.stringify(exit)}`);
      ok(exitedAfterMs >= 250 && exitedAfterMs < 6000, `exit took ${exitedAfterMs} ms`);
    }
  );
  await check(
    'cli: as a process, a scenario file that leaves a timer running cannot keep a finished run alive',
    async () => {
      const dir = writeScenarioDir('proc-leaky', {
        'a.mjs': `${scenarioSource([goodLive()])}setInterval(() => undefined, 1000);\n`,
      });
      const child = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'e2e', 'run.mjs'), '--scenarios-dir', dir, '--list'],
        { encoding: 'utf8', timeout: 60000 }
      );
      ok(child.status === 0, `status ${child.status} signal ${child.signal}: ${child.stderr}`);
      ok(child.stdout.includes('1 scenario(s)'), child.stdout);
    }
  );
  await check('cli: duplicate scenario ids block a run (exit 2), not only --validate', async () => {
    const harness = cliDeps();
    const run = await runCli([], {
      files: { 'a.mjs': [goodLive()], 'b.mjs': [goodLive()] },
      deps: harness.deps,
    });
    ok(
      run.code === 2 && harness.seen.ids.length === 0 && run.err.includes('duplicate scenario id'),
      run.err
    );
  });
  await check('cli: runPool keeps result order and tolerates a single lane', async () => {
    const order = await runPool([30, 5, 15], 2, async (ms, index) => (await sleep(ms), index));
    eq(order, [0, 1, 2]);
    eq(await runPool([], 3, async () => 1), []);
  });
  await check('cli: aggregate receipt write failure changes success to failure', async () => {
    const blocked = path.join(scratch, 'summary-path-is-a-file');
    fs.writeFileSync(blocked, 'not a directory');
    const harness = cliDeps();
    const run = await runCli(['--evidence-root', blocked], {
      files: { 'a.mjs': [goodLive()] },
      deps: harness.deps,
    });
    ok(run.code === EXIT_CODES.FAILED && run.out.includes('summary could not be written'));
  });
  await check('cli: changed loaded bundle hash fails before any scenario runs', async () => {
    const harness = cliDeps({
      deps: { readBundles: () => ({ umd: 'u', esmUrl: 'file:///x', sha256: 'b'.repeat(64) }) },
    });
    const run = await runCli([], { files: { 'a.mjs': [goodLive()] }, deps: harness.deps });
    ok(run.code === EXIT_CODES.DIST && harness.seen.ids.length === 0);
  });
  await check('cli: --jev-concurrency reaches the gate (default 3)', async () => {
    const files = { 'a.mjs': [goodLive()] };
    const custom = cliDeps();
    await runCli(['--jev-concurrency', '5'], { files, deps: custom.deps });
    eq(custom.seen.gateLimit, 5);
    const standard = cliDeps();
    await runCli([], { files, deps: standard.deps });
    eq(standard.seen.gateLimit, 3);
  });
  await check(
    'cli: a runner that throws is a failed scenario (exit 1) and the browser is still closed',
    async () => {
      const harness = cliDeps({
        deps: {
          runScenario: async () => {
            throw new Error('runner exploded');
          },
        },
      });
      const run = await runCli([], { files: { 'a.mjs': [goodLive()] }, deps: harness.deps });
      ok(
        run.code === 1 &&
          run.out.includes('runner_threw: runner exploded') &&
          harness.seen.browserClosed
      );
    }
  );
  await check(
    'cli: a secret leaking through the real runner makes the real CLI exit 4 (and scrubs the file)',
    async () => {
      const world = makeWorld();
      const harness = cliDeps();
      const { expect: _expect, ...data } = goodLive({ id: 'catalog-a-leaky' });
      const source = `import fs from 'node:fs';
import path from 'node:path';
export const scenarios = [{ ...${JSON.stringify(data)}, expect: async (app, result, page, ctx) => {
  fs.writeFileSync(path.join(ctx.evidenceDir, 'leak.txt'), 'oops ' + ctx.sensitive.password);
} }];
`;
      harness.deps.runScenario = args => runScenario({ ...args, deps: world.deps });
      const run = await runCli(['--run-id', 'selftest-leak'], {
        files: { 'a.mjs': source },
        deps: harness.deps,
      });
      ok(run.code === 4, `exit ${run.code}: ${run.out}${run.err}`);
      ok(run.out.includes('evidence_secret'), run.out);
      const file = path.join(
        scratch,
        'cli-evidence',
        'selftest-leak',
        'catalog-a-leaky',
        'leak.txt'
      );
      ok(
        fs.readFileSync(file, 'utf8') === 'oops [REDACTED]',
        'the leaked value is scrubbed on disk'
      );
    }
  );
  await check(
    'cli: the real runner and real run.mjs work end to end with fake collaborators',
    async () => {
      const world = makeWorld();
      const harness = cliDeps();
      delete harness.deps.runScenario;
      const real = await import('./runner.mjs');
      harness.deps.runScenario = args => real.runScenario({ ...args, deps: world.deps });
      const run = await runCli(['--run-id', 'selftest-e2e'], {
        files: { 'a.mjs': [goodLive()] },
        deps: harness.deps,
      });
      ok(run.code === 0, run.out + run.err);
      ok(
        fs.existsSync(
          path.join(scratch, 'cli-evidence', 'selftest-e2e', 'catalog-a-demo', 'summary.json')
        )
      );
    }
  );
  await check(
    'cli: as a process, --list and --help exit 0, --validate fails on bad files, a missing key is exit 2',
    () => {
      const dir = writeScenarioDir('proc-ok', { 'a.mjs': demoSet() });
      const env = { ...process.env };
      delete env.TYPESAFE_API_KEY;
      const run = args =>
        spawnSync(process.execPath, [path.join(REPO_ROOT, 'e2e', 'run.mjs'), ...args], {
          env,
          encoding: 'utf8',
        });
      const list = run(['--scenarios-dir', dir, '--list']);
      ok(list.status === 0 && list.stdout.includes('catalog-a-one'), list.stderr);
      ok(run(['--help']).status === 0);
      const badDir = writeScenarioDir('proc-bad', {
        'a.mjs': [goodLive({ expectStatus: 'nope' })],
      });
      ok(run(['--scenarios-dir', badDir, '--validate']).status === 1);
      const noKey = run(['--scenarios-dir', dir, '--scenario', 'catalog-a-one']);
      ok(
        noKey.status === 2 && noKey.stderr.includes('TYPESAFE_API_KEY is not set'),
        `${noKey.status} ${noKey.stderr}`
      );
    }
  );
}

async function hygieneChecks() {
  const ownFiles = [
    'run.mjs',
    'README.md',
    'harness/env.mjs',
    'harness/dist.mjs',
    'harness/evidence.mjs',
    'harness/sensitive.mjs',
    'harness/scenario.mjs',
    'harness/runner.mjs',
    'harness/selftest.mjs',
  ].map(name => path.join(REPO_ROOT, 'e2e', name));
  await check(
    'hygiene: importing any harness module has no side effects (no output, exit 0, no evidence or temp directory)',
    () => {
      const evidence = path.join(REPO_ROOT, 'e2e', 'evidence');
      const before = fs.existsSync(evidence);
      // each probe gets a private TMPDIR, so a sibling selftest running at the same time cannot disturb the count
      const probeTmp = path.join(scratch, 'probe-tmp');
      fs.mkdirSync(probeTmp, { recursive: true });
      const modules = [
        ...new Set([...ownFiles.filter(name => name.endsWith('.mjs')), ...harnessSources()]),
      ];
      ok(modules.length >= 9, `only ${modules.length} modules were probed`);
      for (const file of modules) {
        const probe = spawnSync(
          process.execPath,
          ['-e', `import(${JSON.stringify(pathToFileURL(file).href)})`],
          { encoding: 'utf8', timeout: 30000, env: { ...process.env, TMPDIR: probeTmp } }
        );
        ok(probe.status === 0, `${path.basename(file)} exit ${probe.status}: ${probe.stderr}`);
        ok(
          probe.stdout === '' && probe.stderr === '',
          `${path.basename(file)} printed output on import`
        );
      }
      ok(fs.existsSync(evidence) === before, 'importing created the evidence directory');
      eq(fs.readdirSync(probeTmp), [], 'importing a module left a temp directory behind');
    }
  );
  await check(
    'hygiene: harness sources never import from src/ and read the API key in exactly one place',
    () => {
      const harnessFiles = harnessSources();
      let reads = 0;
      for (const file of harnessFiles) {
        const source = fs.readFileSync(file, 'utf8');
        const isTest = /selftest\.mjs$/.test(file);
        ok(
          !/from\s+['"][^'"]*\/src\//.test(source) && !/import\(['"][^'"]*\/src\//.test(source),
          `${path.basename(file)} imports src/`
        );
        reads += isTest ? 0 : (source.match(/process\.env\.TYPESAFE_API_KEY/g) ?? []).length;
      }
      const runner = fs.readFileSync(path.join(here, 'runner.mjs'), 'utf8');
      ok(
        (runner.match(/process\.env\.TYPESAFE_API_KEY/g) ?? []).length === 1,
        'runner.mjs reads it once'
      );
      ok(
        reads === 1,
        `process.env.TYPESAFE_API_KEY appears ${reads} times in the harness (selftests excluded)`
      );
    }
  );
  await check(
    'hygiene: process.env is touched only where the harness needs it (an allow-list over every harness source)',
    () => {
      const envAccess = /process\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/g;
      const allowed = {
        'env.mjs': () => true,
        'run.mjs': () => true,
        'runner.mjs': text => /^process\.env\.TYPESAFE_API_KEY$/.test(text),
        'browser.mjs': text => /^process\.env\.BREEZE_GUIDE_TOOLS_DIR$/.test(text),
      };
      for (const file of harnessSources().filter(name => !/selftest\.mjs$/.test(name))) {
        const source = fs.readFileSync(file, 'utf8');
        const base = path.basename(file);
        for (const match of source.matchAll(
          new RegExp(`${envAccess.source}(?:\\s*\\.\\s*\\w+)?`, 'g')
        )) {
          const text = match[0].replace(/\s+/g, '');
          ok((allowed[base] ?? (() => false))(text), `${base} reads ${text}`);
        }
        if (!['env.mjs', 'runner.mjs', 'run.mjs'].includes(base)) {
          ok(!source.includes('TYPESAFE_API_KEY'), `${base} names the key variable`);
        }
      }
    }
  );
  await check('hygiene: harness sources hold no card-number or password literals', () => {
    const files = [...new Set([...ownFiles, ...harnessSources()])];
    for (const file of files.filter(
      name => name.endsWith('.mjs') && !name.endsWith('selftest.mjs')
    )) {
      const source = fs.readFileSync(file, 'utf8');
      ok(
        !/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/.test(source),
        `${path.basename(file)} holds a card-shaped literal`
      );
      ok(
        !/password\s*:\s*['"][^'"]{10,}['"]/i.test(source),
        `${path.basename(file)} holds a password literal`
      );
    }
  });
  await check('hygiene: the evidence directory is ignored by prettier', () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.prettierignore'), 'utf8').split('\n');
    ok(ignore.includes('e2e/evidence/'));
  });
}

export async function runSelftest() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  evidenceRoot = path.join(scratch, 'evidence');
  try {
    await validatorChecks();
    await loaderChecks();
    await evidenceChecks();
    await sensitiveChecks();
    await envChecks();
    await distChecks();
    await runnerChecks();
    await cliChecks();
    await hygieneChecks();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write('\n');
  tally.info.forEach(line => process.stdout.write(`INFO ${line}\n`));
  process.stdout.write(
    `selftest: ${tally.passed}/${tally.total} checks passed${tally.skipped.length > 0 ? `, ${tally.skipped.length} skipped` : ''}\n`
  );
  if (tally.failed.length > 0) {
    process.stdout.write(`failed: ${tally.failed.join('; ')}\n`);
  }
  return { ...tally, exitCode: tally.failed.length === 0 && tally.total > 0 ? 0 : 1 };
}

const isMain = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  runSelftest().then(
    outcome => process.exit(outcome.exitCode),
    error => {
      process.stderr.write(`selftest crashed: ${String(error?.message ?? error)}\n`);
      process.exit(1);
    }
  );
}
