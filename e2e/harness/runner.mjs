import fs from 'node:fs';
import {
  createEvidenceWriter,
  normalizeSecrets,
  redactSecrets,
  secretVariants,
} from './evidence.mjs';
import { generateSensitiveValues, scannableSensitiveValues } from './sensitive.mjs';
import {
  approvalChoice,
  declaresSensitive,
  findTextProblems,
  isPlainObject,
  normalizeDeclarations,
  PAUSE_STATUSES,
  resolveWithSensitive,
  substituteAppOrigin,
} from './scenario.mjs';

/**
 * @typedef {import('../../dist/index.d.ts').TaskResult} TaskResult
 * @typedef {import('../../dist/index.d.ts').TaskRequest} TaskRequest
 * @typedef {import('../../dist/index.d.ts').TaskResumeRequest} TaskResumeRequest
 * @typedef {import('../../dist/index.d.ts').TaskEvent} TaskEvent
 */

const DEFAULT_MAX_SCENARIO_MS = 480000;
const DEFAULT_ABORT_GRACE_MS = 10000;
const DEFAULT_EXPECT_MS = 120000;
const DEFAULT_CLOSE_MS = 15000;
const PAGE_CONTENT_MS = 5000;
const GOTO_TIMEOUT_MS = 20000;
const MAX_EVENT_SCREENSHOTS = 40;
const MAX_FAILURE_MESSAGE_CHARS = 700;
const MAX_JEV_FAILURES = 20;
const MAX_TRANSPORT_LINES = 2000;
const MODEL_PATTERN = /^jev-/;
const DEADLINE = Symbol('deadline');

/**
 * The one place harness code reads the TypeSafe key. It is handed to the decider as a callback and used
 * for the evidence scan; it is never logged, written or placed in a request.
 */
export function readApiKey() {
  const value = process.env.TYPESAFE_API_KEY;
  return typeof value === 'string' ? value.trim() : '';
}

const pad = value => String(value).padStart(2, '0');
const clone = value => (value === undefined ? undefined : structuredClone(value));

/** Rejects with `message` after `ms`; the timer is always cleared, so it never keeps the process alive. */
function withTimeout(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function lazy(deps, name, loader) {
  if (deps[name] !== undefined) {
    return deps[name];
  }
  return loader();
}

const here = relative => new URL(relative, import.meta.url).href;
const distCache = new Map();

async function importDist(url) {
  if (!distCache.has(url)) {
    distCache.set(url, import(url));
  }
  return distCache.get(url);
}

async function resolveCollaborators(scenario, { deps = {}, bundles, dist }) {
  const out = {
    readApiKey: deps.readApiKey ?? readApiKey,
    maxScenarioMs: deps.maxScenarioMs ?? DEFAULT_MAX_SCENARIO_MS,
    abortGraceMs: deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
    expectTimeoutMs: deps.expectTimeoutMs ?? DEFAULT_EXPECT_MS,
    closeTimeoutMs: deps.closeTimeoutMs ?? DEFAULT_CLOSE_MS,
  };
  out.newScenarioContext = await lazy(
    deps,
    'newScenarioContext',
    async () => (await import(here('./browser.mjs'))).newScenarioContext
  );
  out.createPlaywrightTransport = await lazy(
    deps,
    'createPlaywrightTransport',
    async () => (await import(here('./host.mjs'))).createPlaywrightTransport
  );
  out.createRecordingHttp = await lazy(
    deps,
    'createRecordingHttp',
    async () => (await import(here('./jev.mjs'))).createRecordingHttp
  );
  out.applyInjection =
    scenario.kind === 'fault'
      ? await lazy(
          deps,
          'applyInjection',
          async () => (await import(here('./faults.mjs'))).applyInjection
        )
      : undefined;
  out.startApp = await lazy(deps, 'startApp', async () => async options => {
    const family = await import(here(`../apps/${scenario.family}.mjs`));
    return family.startApp(options);
  });
  const distNamespace =
    dist !== undefined && typeof dist.createTaskAgent === 'function' ? dist : undefined;
  out.dist = await lazy(deps, 'dist', async () => distNamespace ?? importDist(bundles.esmUrl));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

function leafAt(value, dotPath) {
  let current = value;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Every string and number leaf at or below `value` (booleans never: `true` would match ordinary words). */
function leavesUnder(value, trail, out = [], depth = 0) {
  if (typeof value === 'string' || typeof value === 'number') {
    out.push({ trail, value: String(value) });
  } else if (depth < 20 && value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      leavesUnder(item, trail === '' ? key : `${trail}.${key}`, out, depth + 1);
    }
  }
  return out;
}

/** A declaration names a leaf or a subtree: every leaf below a sensitive path is sensitive. */
function declaredSensitiveLeaves(inputs, declarations, label) {
  const leaves = [];
  for (const declaration of declarations ?? []) {
    if (declaration?.sensitive !== true || typeof declaration.path !== 'string') {
      continue;
    }
    for (const leaf of leavesUnder(leafAt(inputs, declaration.path), declaration.path)) {
      leaves.push({ label: `${label}:${leaf.trail}`, value: leaf.value });
    }
  }
  return leaves;
}

function buildSecrets({
  apiKey,
  sensitive,
  inputs,
  declarations,
  resolutions,
  isSensitiveKey = () => false,
}) {
  const secrets = [];
  if (apiKey !== '') {
    secrets.push({ label: 'TYPESAFE_API_KEY', value: apiKey });
  }
  secrets.push(...scannableSensitiveValues(sensitive));
  secrets.push(...declaredSensitiveLeaves(inputs, declarations, 'input'));
  secrets.push(
    ...leavesUnder(inputs, '')
      .filter(leaf => isSensitiveKey(leaf.trail))
      .map(leaf => ({ label: `heuristic:${leaf.trail}`, value: leaf.value }))
  );
  resolutions.forEach((resolution, index) => {
    const declared = normalizeDeclarations(resolution.inputDeclarations) ?? declarations;
    secrets.push(...declaredSensitiveLeaves(resolution.inputs, declared, `resume.${index}`));
    secrets.push(
      ...leavesUnder(resolution.inputs, '')
        .filter(leaf => isSensitiveKey(leaf.trail))
        .map(leaf => ({ label: `resume.${index}.heuristic:${leaf.trail}`, value: leaf.value }))
    );
    for (const leaf of leavesUnder(resolution.sensitiveInputs, '')) {
      secrets.push({ label: `resume.${index}.sensitiveInputs.${leaf.trail}`, value: leaf.value });
    }
  });
  const unique = new Map();
  for (const secret of secrets) {
    if (!unique.has(secret.value)) {
      unique.set(secret.value, secret);
    }
  }
  return [...unique.values()];
}

/** Labels (never values) of the secrets that show up in `text` in any variant. */
function secretLabelsIn(text, secrets) {
  const { usable } = normalizeSecrets(secrets);
  return usable
    .filter(secret => secretVariants(secret.value).some(variant => text.includes(variant.text)))
    .map(secret => secret.label);
}

const textShowsSecret = (text, secrets) => secretLabelsIn(text, secrets).length > 0;

/**
 * jev.mjs masks known values before a request reaches disk, so a leak into a model request would be
 * invisible to the evidence scan. The runner therefore looks at the raw request (body and headers, never
 * the credential) on its way in and keeps only the label and the call number.
 */
function inspectJevRequest(run, init) {
  run.requestCount += 1;
  let text = '';
  try {
    text = `${typeof init?.body === 'string' ? init.body : ''}\n${JSON.stringify(init?.headers ?? {})}`;
  } catch {
    // an uninspectable request is still sent; the recorder masks it
  }
  for (const label of secretLabelsIn(text, run.secrets)) {
    if (!run.requestLeaks.has(label)) {
      run.requestLeaks.set(label, run.requestCount);
    }
  }
}

/** Runs in the page: visible text plus the value of every control that shows its value (not password fields). */
function collectVisibleText() {
  const parts = [document.body ? document.body.innerText : ''];
  for (const element of document.querySelectorAll('input, textarea, select')) {
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (type !== 'password' && type !== 'hidden') {
      parts.push(String(element.value ?? ''));
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Recorders
// ---------------------------------------------------------------------------------------------

/**
 * What createRecordingHttp writes to. record/push/add receive one redacted exchange; write('jev-calls.json',
 * [...]) replaces the list. Everything is mirrored into evidence/jev-calls.json at the end.
 */
function createJevRecorder(run) {
  const add = entry => {
    run.calls.push(entry);
    return run.calls.length;
  };
  return {
    record: add,
    push: add,
    add,
    write: (name, data) => {
      if (name === 'jev-calls.json' && Array.isArray(data)) {
        run.calls.splice(0, run.calls.length, ...data);
        run.jevFileWrittenByHttp = true;
      }
      return run.writer.write(name, data);
    },
    get dir() {
      return run.writer.dir;
    },
  };
}

function createFaultRecorder(run) {
  return { record: entry => run.faultNotes.push(entry) };
}

// ---------------------------------------------------------------------------------------------
// Jev request assertions (E2E_SPEC): goal literal everywhere, no hints in library text, jev-* models
// ---------------------------------------------------------------------------------------------

function parseRequest(call) {
  let request = call?.request;
  if (typeof request === 'string') {
    try {
      request = JSON.parse(request);
    } catch {
      return null;
    }
  }
  if (isPlainObject(request) && typeof request.body === 'string') {
    try {
      request = JSON.parse(request.body);
    } catch {
      return null;
    }
  }
  return isPlainObject(request) ? request : null;
}

function questionEntries(questions) {
  if (Array.isArray(questions)) {
    return questions.map((question, index) => [String(index), question]);
  }
  return isPlainObject(questions) ? Object.entries(questions) : [];
}

function libraryText(instructions) {
  const texts = [];
  const walk = (value, depth) => {
    if (typeof value === 'string') {
      texts.push(value);
    } else if (depth < 12 && Array.isArray(value)) {
      value.forEach(item => walk(item, depth + 1));
    } else if (depth < 12 && isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (!(depth === 0 && key === 'goal')) {
          walk(item, depth + 1);
        }
      }
    }
  };
  walk(instructions, 0);
  return texts;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesRoute(text, route) {
  return new RegExp(`(?:^|[^\\w/-])${escapeRegExp(route)}(?![\\w-])`).test(text);
}

/**
 * Checks every recorded Jev exchange. Returns [{ kind, message }]; messages carry question keys and
 * call numbers, never the text that failed.
 *
 * @param {{ calls: object[], scenario: { goal: string, kind: string, forbiddenInstructionText?: string[] }, routes?: string[], host?: string }} input
 */
export function assertJevCalls({ calls, scenario, routes = [], host }) {
  const failures = [];
  const models = new Set();
  const forbidden = (scenario.forbiddenInstructionText ?? []).map(text => text.toLowerCase());
  const appRoutes = [...new Set(routes)].filter(
    route => typeof route === 'string' && route.length > 1
  );

  if (scenario.kind === 'live' && calls.length === 0) {
    failures.push({ kind: 'no_jev_calls', message: 'a live scenario recorded no Jev request' });
  }

  calls.forEach((call, index) => {
    const label = `jev call ${index + 1}`;
    const request = parseRequest(call);
    if (request === null) {
      failures.push({
        kind: 'jev_request_missing',
        message: `${label}: no parseable request recorded`,
      });
    } else {
      const questions = questionEntries(request.questions);
      if (questions.length === 0) {
        failures.push({
          kind: 'jev_request_missing',
          message: `${label}: request has no questions`,
        });
      }
      for (const [key, question] of questions) {
        const instructions = question?.instructions;
        if (!isPlainObject(instructions) || instructions.goal !== scenario.goal) {
          failures.push({
            kind: 'jev_goal',
            message: `${label} question ${key}: instructions.goal is not the scenario goal literal`,
          });
        }
        for (const text of libraryText(instructions)) {
          for (const problem of findTextProblems(text, 'library')) {
            failures.push({
              kind: 'jev_hint',
              message: `${label} question ${key}: library instruction text ${problem.message}`,
            });
          }
          const route = appRoutes.find(candidate => namesRoute(text, candidate));
          if (route !== undefined) {
            failures.push({
              kind: 'jev_hint',
              message: `${label} question ${key}: library instruction text names an app route`,
            });
          }
          if (typeof host === 'string' && host.length > 0 && text.includes(host)) {
            failures.push({
              kind: 'jev_hint',
              message: `${label} question ${key}: library instruction text names the app host`,
            });
          }
          if (forbidden.some(fragment => text.toLowerCase().includes(fragment))) {
            failures.push({
              kind: 'jev_hint',
              message: `${label} question ${key}: library instruction text holds a forbidden phrase`,
            });
          }
        }
      }
    }
    const answered =
      typeof call?.status === 'number'
        ? call.status >= 200 && call.status < 300
        : call?.response !== null && call?.response !== undefined;
    if (answered) {
      const model = typeof call.model === 'string' ? call.model : call.response?.model;
      if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
        failures.push({
          kind: 'jev_model',
          message: `${label}: the response model does not start with jev-`,
        });
      } else {
        models.add(model);
      }
    }
  });

  if (scenario.kind === 'live' && calls.length > 0 && models.size === 0) {
    failures.push({
      kind: 'no_jev_answer',
      message: `${calls.length} Jev attempt(s) were recorded but none was answered by a jev-* model: nothing here was decided by the live model`,
    });
  }

  const kept = failures.slice(0, MAX_JEV_FAILURES);
  if (failures.length > kept.length) {
    kept.push({
      kind: 'jev_overflow',
      message: `${failures.length - kept.length} more Jev assertion failures not listed`,
    });
  }
  return { failures: kept, models: [...models] };
}

// ---------------------------------------------------------------------------------------------
// Request and resume construction
// ---------------------------------------------------------------------------------------------

function buildRequest({ scenario, app, inputs, declarations }) {
  // These scenarios request state changes. Explicitly opt out of inferred informational answers.
  const request = { goal: scenario.goal, startUrl: app.url, expect: { answer: false } };
  if (inputs !== undefined) {
    request.inputs = inputs;
  }
  if (declarations !== undefined) {
    request.inputDeclarations = substituteAppOrigin(declarations, app.origin);
  }
  if (scenario.authorization !== undefined) {
    request.authorization = substituteAppOrigin(scenario.authorization, app.origin);
  }
  const options = {};
  if (scenario.run?.budgets !== undefined) {
    options.budgets = { ...scenario.run.budgets };
  }
  if (scenario.run?.allowRunLoss !== undefined) {
    options.allowRunLoss = scenario.run.allowRunLoss;
  }
  if (Object.keys(options).length > 0) {
    request.options = options;
  }
  return request;
}

/** Turns a data-only scenario resolution into a TaskResumeRequest for the paused result. */
function buildResumeRequest(paused, resolution, appOrigin, retainedInputs) {
  const bindings = structuredClone(resolution.sensitiveInputs ?? {});
  for (const path of paused.checkpoint?.request?.sensitivePaths ?? []) {
    if (resolution.omitSensitivePaths?.includes(path) || leafAt(bindings, path) !== undefined) {
      continue;
    }
    const value = leafAt(retainedInputs, path);
    const segments = path.split('.');
    if (
      value === undefined ||
      segments.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))
    ) {
      continue;
    }
    let cursor = bindings;
    for (const key of segments.slice(0, -1)) {
      cursor[key] ??= {};
      cursor = cursor[key];
    }
    cursor[segments.at(-1)] = value;
  }
  const common = {
    ...(Object.keys(bindings).length > 0 ? { inputs: bindings } : {}),
    ...(resolution.omitSensitivePaths === undefined
      ? {}
      : { omitSensitivePaths: resolution.omitSensitivePaths }),
    ...(resolution.options === undefined ? {} : { options: resolution.options }),
  };
  if (paused.status === 'awaiting_approval') {
    const { approval } = paused;
    const choice = approvalChoice(resolution);
    const decision = {
      approvalId: approval.id,
      nonce: approval.nonce,
      digest: approval.digest,
      contextDigest: approval.contextDigest,
      decision: choice.decision,
    };
    if (choice.scope !== undefined) {
      decision.scope = choice.scope;
    }
    if (choice.maxUses !== undefined) {
      decision.maxUses = choice.maxUses;
    }
    return {
      ...common,
      checkpoint: paused.checkpoint,
      resolution: { kind: 'approval', resolution: decision },
    };
  }
  const request = {
    ...common,
    checkpoint: paused.checkpoint,
    resolution: { kind: 'inputs', inputs: resolution.inputs ?? {} },
  };
  const declarations = normalizeDeclarations(resolution.inputDeclarations);
  if (declarations !== undefined) {
    request.resolution = {
      ...request.resolution,
      inputDeclarations: substituteAppOrigin(declarations, appOrigin),
    };
  }
  return request;
}

// ---------------------------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------------------------

function describeError(error) {
  return String(error?.message ?? error).trim();
}

function addFailure(run, kind, message) {
  const redacted = redactSecrets(String(message), run.secrets);
  run.failures.push({ kind, message: redacted.slice(0, MAX_FAILURE_MESSAGE_CHARS) });
}

function addNote(run, text) {
  run.notes.push(redactSecrets(String(text), run.secrets));
}

function snapshot(read) {
  try {
    return read();
  } catch (error) {
    return { snapshotError: describeError(error) };
  }
}

function eventScreenshotName(event) {
  if (event.type === 'executed') {
    return `step-${pad(event.step)}-executed`;
  }
  if (event.type === 'approval' && event.phase === 'requested') {
    return `step-${pad(event.step)}-approval-requested`;
  }
  if (event.type === 'done_gate') {
    return `step-${pad(event.step)}-done-gate`;
  }
  return null;
}

/** True when the page shows a secret, or when that cannot be told (an unreadable page counts as showing one). */
async function pageMayShowSecret(run) {
  let visible;
  try {
    visible = await run.page.evaluate(collectVisibleText);
  } catch {
    visible = null;
  }
  return typeof visible !== 'string' || textShowsSecret(visible, run.secrets);
}

/**
 * In a scenario that declares sensitive values the page is probed before and after the capture: the agent
 * keeps running while a shot is taken, so a value typed in between shows up in the second probe and the
 * file is removed again.
 */
async function takeScreenshot(run, name) {
  const { page } = run;
  if (page === undefined || run.writer === undefined) {
    return;
  }
  if (run.sensitiveScenario && (await pageMayShowSecret(run))) {
    addNote(run, `screenshot ${name} skipped: a sensitive value may be visible`);
    return;
  }
  const shot = await run.writer.screenshot(page, name);
  if (!shot.ok) {
    addNote(run, `screenshot ${name} failed: ${shot.reason}`);
    return;
  }
  if (run.sensitiveScenario && (await pageMayShowSecret(run))) {
    fs.rmSync(shot.path, { force: true });
    addNote(
      run,
      `screenshot ${name} removed: a sensitive value may have appeared while it was taken`
    );
  }
}

function queueScreenshot(run, name) {
  run.shotChain = run.shotChain.then(() => takeScreenshot(run, name)).catch(() => undefined);
  return run.shotChain;
}

function createEventRecorder(run) {
  const taken = new Map();
  let eventShots = 0;
  return event => {
    try {
      run.trace.push(event);
      if (event.type === 'observed') {
        run.observations.push({
          step: event.step,
          ordinal: event.ordinal,
          changed: event.changed,
          url: event.snapshot?.url,
          title: event.snapshot?.title,
          sequence: event.snapshot?.sequence,
          fingerprint: event.snapshot?.fingerprint,
          elementCount: event.snapshot?.elementCount,
        });
      }
      const base = eventScreenshotName(event);
      if (base !== null && eventShots < MAX_EVENT_SCREENSHOTS) {
        const count = (taken.get(base) ?? 0) + 1;
        taken.set(base, count);
        eventShots += 1;
        queueScreenshot(run, count === 1 ? base : `${base}-${count}`);
      }
    } catch {
      // an event sink must never change the run it observes
    }
  };
}

/** ctx.pauses holds the paused TaskResults themselves; the backend snapshot of each is kept alongside. */
function recordPause(run, result, index, app) {
  run.pauses.push(result);
  run.pauseBackends.push({ index, status: result.status, backend: snapshot(() => app.state()) });
}

async function driveRun(run, { agent, request, controller, app }) {
  const { scenario } = run;
  const signal = controller.signal;
  let result = await agent.run(request, signal);
  run.results.push(result);
  let used = 0;
  while (PAUSE_STATUSES.includes(result.status) && used < (scenario.resume ?? []).length) {
    const entry = scenario.resume[used];
    recordPause(run, result, used, app);
    await queueScreenshot(
      run,
      `step-${pad(result.steps ?? 0)}-paused-${used + 1}-${result.status}`
    );
    if (entry.on !== result.status) {
      addFailure(
        run,
        'resume_mismatch',
        `resume[${used}] is for a ${entry.on} pause but the run paused as ${result.status}`
      );
      return result;
    }
    if (result.checkpoint === undefined) {
      addFailure(
        run,
        'resume_mismatch',
        `resume[${used}]: the paused result carries no checkpoint`
      );
      return result;
    }
    const resolution = resolveWithSensitive(entry.resolution, run.sensitive);
    result = await agent.resume(
      buildResumeRequest(result, resolution, app.origin, run.inputs),
      signal
    );
    run.results.push(result);
    used += 1;
  }
  if (used < (scenario.resume ?? []).length) {
    addFailure(
      run,
      'resume_unused',
      `${scenario.resume.length - used} resume step(s) were never needed: the run ended as ${result.status}`
    );
  } else if (PAUSE_STATUSES.includes(result.status)) {
    recordPause(run, result, used, app);
  }
  return result;
}

/** The watchdog and the cancel timer govern the agent run only; they must not fire during expect(). */
function clearRunTimers(run) {
  clearTimeout(run.cancelTimer);
  clearTimeout(run.deadlineTimer);
  clearTimeout(run.graceTimer);
}

async function executeScenario(run, args) {
  const { scenario, runId, bundles, browser, gate } = args;
  const collaborators = run.collaborators ?? (await resolveCollaborators(scenario, args));
  run.collaborators = collaborators;
  const { dist: distModule } = collaborators;
  for (const name of ['createTaskAgent', 'createRemoteTaskHost', 'createTypeSafeTaskDecider']) {
    if (typeof distModule?.[name] !== 'function') {
      throw new Error(`the dist bundle does not export ${name} as a function`);
    }
  }

  run.app = await collaborators.startApp({
    family: scenario.family,
    variant: scenario.variant,
    initial: clone(scenario.initial ?? {}),
    faults: clone(scenario.faults ?? {}),
  });
  const { app } = run;
  run.writer.write(
    'backend-before.json',
    snapshot(() => app.state())
  );

  run.scenarioContext = await collaborators.newScenarioContext(browser, { umd: bundles.umd });
  const { page } = run.scenarioContext;
  run.page = page;
  await page.goto(app.url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
  await queueScreenshot(run, 'step-00-initial');

  const transport = collaborators.createPlaywrightTransport({
    page,
    redact: text => redactSecrets(text, run.secrets),
    redactEnvelope: distModule.redactEnvelope,
    onTrace: line => {
      if (run.transportLines.length < MAX_TRANSPORT_LINES) {
        run.transportLines.push(line);
      }
    },
  });
  run.transport = transport;
  const remote = distModule.createRemoteTaskHost({ transport });
  const host =
    args.observeOffscreen === true
      ? {
          ...remote,
          observe: (request, signal) =>
            remote.observe(
              { ...request, options: { ...request.options, includeOffscreen: true } },
              signal
            ),
        }
      : remote;
  run.host = host;

  const http = collaborators.createRecordingHttp({
    gate,
    recorder: createJevRecorder(run),
    redactValues: run.secrets.map(secret => secret.value),
  });
  run.http = http;
  const inspectedHttp = (url, init) => {
    try {
      inspectJevRequest(run, init);
    } catch {
      // an inspection problem must not change what the decider sends
    }
    return http(url, init);
  };
  const apiKeyCallback = () => collaborators.readApiKey();
  let decider = distModule.createTypeSafeTaskDecider({
    apiKey: apiKeyCallback,
    http: inspectedHttp,
  });
  let agentHost = host;

  if (scenario.kind === 'fault') {
    const injected = await collaborators.applyInjection({
      decider,
      host,
      page,
      scenario,
      recorder: createFaultRecorder(run),
    });
    decider = injected.decider;
    agentHost = injected.host;
    run.injectionReporter =
      typeof injected.report === 'function' ? injected.report.bind(injected) : undefined;
    run.injection = {
      label: 'FAULT_INJECTION',
      live: false,
      inject: scenario.inject,
      notes: injected.notes,
      report: typeof injected.report === 'function' ? injected.report() : undefined,
    };
  }

  const agent = distModule.createTaskAgent({
    host: agentHost,
    decider,
    options: { onEvent: createEventRecorder(run) },
  });
  run.agent = agent;

  const request = buildRequest({
    scenario,
    app,
    inputs: run.inputs,
    declarations: run.declarations,
  });
  if (args.runOverrides !== undefined) {
    request.options = { ...request.options, ...args.runOverrides };
  }
  const controller = new AbortController();
  run.controller = controller;
  if (scenario.run?.cancelAfterMs !== undefined) {
    run.cancelTimer = setTimeout(() => controller.abort(), scenario.run.cancelAfterMs);
  }
  const deadline = new Promise(resolve => {
    run.deadlineTimer = setTimeout(() => {
      run.timedOut = true;
      controller.abort();
      run.graceTimer = setTimeout(() => resolve(DEADLINE), collaborators.abortGraceMs);
    }, collaborators.maxScenarioMs);
  });

  let outcome;
  try {
    outcome = await Promise.race([driveRun(run, { agent, request, controller, app }), deadline]);
  } catch (error) {
    addFailure(run, 'run_threw', `the agent run rejected: ${describeError(error)}`);
    outcome = undefined;
  } finally {
    clearRunTimers(run);
  }
  if (outcome === DEADLINE) {
    outcome = undefined;
  }
  if (run.timedOut) {
    addFailure(
      run,
      'timeout',
      `the scenario exceeded ${collaborators.maxScenarioMs} ms and was aborted`
    );
  }
  run.result = outcome;
  if (run.injectionReporter !== undefined) {
    run.injection.report = snapshot(run.injectionReporter);
  }
}

function writeRunEvidence(run) {
  const { writer, result } = run;
  writer.write('trace.json', {
    runId: run.runId,
    scenarioId: run.scenario.id,
    kind: run.scenario.kind,
    events: run.trace,
    pauses: run.pauseBackends.map(pause => ({ index: pause.index, status: pause.status })),
    transport: run.transportLines,
    injection: run.injection,
    notes: run.notes,
  });
  writer.write('observations.json', {
    steps: run.observations,
    final: result?.finalObservation ?? null,
  });
  if (result !== undefined) {
    writer.write('result.json', result);
  } else {
    writer.write('result.json', { error: 'the run produced no result' });
  }
  if (run.pauseBackends.length > 0) {
    writer.write('pauses.json', run.pauseBackends);
    run.pauses.forEach((paused, index) => writer.write(`result-pause-${index + 1}.json`, paused));
  }
  if (run.injection !== undefined) {
    writer.write('injection.json', { ...run.injection, recorded: run.faultNotes });
  }
}

function currentCalls(run) {
  if (run.calls.length > 0) {
    return run.calls.slice();
  }
  const recorded =
    typeof run.http?.recorded === 'function' ? snapshot(() => run.http.recorded()) : [];
  return Array.isArray(recorded) ? recorded.slice() : [];
}

async function checkOutcome(run) {
  const { scenario, result, app } = run;
  if (scenario.kind === 'fault') {
    for (const [layer, spec] of Object.entries(scenario.inject ?? {})) {
      const fired = run.faultNotes.find(
        note => note.event === 'fired' && note.layer === layer && note.mode === spec.mode
      );
      if (fired === undefined || fired.applied === false) {
        addFailure(
          run,
          'fault_unfired',
          `The configured ${layer} ${spec.mode} fault did not apply.`
        );
      }
    }
  }
  if (result !== undefined) {
    const allowed = Array.isArray(scenario.expectStatus)
      ? scenario.expectStatus
      : [scenario.expectStatus];
    if (!allowed.includes(result.status)) {
      addFailure(
        run,
        'status_mismatch',
        `status ${result.status} is not one of the expected ${allowed.join(', ')}`
      );
    }
    const ctx = {
      calls: currentCalls(run),
      trace: run.trace.slice(),
      evidenceDir: run.writer.dir,
      sensitive: run.sensitive,
      pauses: run.pauses.slice(),
      pauseBackends: run.pauseBackends.slice(),
      results: run.results.slice(),
      goal: scenario.goal,
      runId: run.runId,
      notes: run.notes.slice(),
      faultNotes: run.faultNotes.slice(),
    };
    try {
      const { expectTimeoutMs } = run.collaborators;
      await withTimeout(
        Promise.resolve().then(() => scenario.expect(app, result, run.page, ctx)),
        expectTimeoutMs,
        `expect() did not finish within ${expectTimeoutMs} ms`
      );
    } catch (error) {
      addFailure(run, 'expect_failed', describeError(error));
      run.expectStack = redactSecrets(String(error?.stack ?? error), run.secrets);
    }
  }
  run.calls = currentCalls(run);
  const requests = snapshot(() => app.requests());
  const routes = Array.isArray(requests)
    ? requests.map(entry => entry?.path).filter(route => typeof route === 'string')
    : [];
  let host;
  try {
    host = new URL(app.url).host;
  } catch {
    host = undefined;
  }
  const jev = assertJevCalls({ calls: run.calls, scenario, routes, host });
  run.models = jev.models;
  for (const failure of jev.failures) {
    addFailure(run, failure.kind, failure.message);
  }
}

async function writeFailureArtifacts(run) {
  const { writer, page } = run;
  const safeWrite = (name, content) => {
    try {
      writer.write(name, content);
    } catch {
      // failure artifacts are best effort
    }
  };
  safeWrite('failure/failures.json', {
    failures: run.failures,
    pageUrl:
      page === undefined
        ? null
        : redactSecrets(
            snapshot(() => page.url()),
            run.secrets
          ),
    stack: run.expectStack,
  });
  const diagnostics = snapshot(() => run.scenarioContext?.diagnostics?.()) ?? {};
  safeWrite(
    'failure/console.json',
    redactSecrets(JSON.stringify(diagnostics, null, 2), run.secrets) ?? '{}'
  );
  const lastObservation =
    [...run.trace].reverse().find(event => event.type === 'observed')?.snapshot ??
    run.result?.finalObservation ??
    null;
  safeWrite('failure/last-observation.json', lastObservation);
  if (page !== undefined) {
    try {
      const html = await withTimeout(
        Promise.resolve().then(() => page.content()),
        PAGE_CONTENT_MS,
        'content timeout'
      );
      safeWrite('failure/page.html', redactSecrets(String(html), run.secrets));
    } catch (error) {
      safeWrite('failure/page-error.txt', redactSecrets(describeError(error), run.secrets));
    }
  }
}

async function closeAll(run) {
  clearRunTimers(run);
  const closeMs = run.collaborators?.closeTimeoutMs ?? DEFAULT_CLOSE_MS;
  const attempt = async (label, action) => {
    try {
      await withTimeout(
        Promise.resolve().then(action),
        closeMs,
        `did not finish within ${closeMs} ms`
      );
    } catch (error) {
      addNote(run, `close ${label} failed: ${describeError(error)}`);
    }
  };
  if (run.agent !== undefined && run.timedOut) {
    await attempt('agent', () => run.agent.cancel?.());
  }
  await attempt('screenshots', () => run.shotChain);
  await attempt('host', () => run.host?.dispose?.());
  await attempt('transport', () => run.transport?.close?.());
  await attempt('page and context', () => run.scenarioContext?.close?.());
  await attempt('app', () => run.app?.close?.());
}

function leakMessage(hits) {
  const where = hits.map(hit => `${hit.file} (${hit.label}, ${hit.variant})`).slice(0, 8);
  return `evidence scan found ${hits.length} secret hit(s) in: ${where.join('; ')}; the files were scrubbed`;
}

async function finish(run, startedAt) {
  const { scenario, writer } = run;
  const durationMs = Date.now() - startedAt;
  const status = run.result?.status ?? 'error';
  let leak = false;
  let scan = { hits: [], scanned: 0, skipped: [], valuesChecked: 0 };
  const requestHits = [...run.requestLeaks].map(([label, call]) => ({
    file: `jev-request-${call}`,
    label,
    variant: 'request',
  }));
  try {
    if (requestHits.length > 0) {
      leak = true;
      for (const hit of requestHits) {
        addFailure(
          run,
          'jev_request_secret',
          `Jev request ${hit.file.slice('jev-request-'.length)} carried the sensitive value ${hit.label}`
        );
      }
    }
    const stepCount =
      run.result?.steps ?? run.trace.filter(event => event.type === 'executed').length;
    const summarize = () => ({
      id: scenario.id,
      family: scenario.family,
      variant: scenario.variant,
      kind: scenario.kind,
      label: scenario.kind === 'fault' ? 'FAULT_INJECTION (not live verification)' : 'live',
      passed: run.failures.length === 0,
      status,
      model: run.models[0] ?? null,
      models: run.models,
      calls: run.calls.length,
      steps: stepCount,
      durationMs,
      sha256: run.distSha256,
      profile: {
        runOverrides: run.profile?.runOverrides ?? null,
        observeOffscreen: run.profile?.observeOffscreen ?? false,
      },
      runId: run.runId,
      failures: run.failures,
      notes: run.notes,
      secretsChecked: scan.valuesChecked,
      secretsSkipped: scan.skipped,
    });
    if (!run.jevFileWrittenByHttp || run.calls.length > 0) {
      writer.write('jev-calls.json', run.calls);
    }
    writer.write('summary.json', summarize());
    scan = writer.finalize(run.secrets);
    if (scan.scanned === 0 || scan.valuesChecked === 0) {
      addFailure(
        run,
        'evidence_scan_empty',
        'the evidence scan looked at nothing and proves nothing'
      );
    }
    if (scan.hits.length > 0) {
      leak = true;
      addFailure(run, 'evidence_secret', leakMessage(scan.hits));
    }
    writer.write('summary.json', summarize());
    const last = writer.finalize(run.secrets);
    if (last.hits.length > 0) {
      leak = true;
      scan = { ...scan, hits: [...scan.hits, ...last.hits] };
      addFailure(run, 'evidence_secret', leakMessage(last.hits));
    }
  } catch (error) {
    addFailure(run, 'evidence_failed', `evidence could not be finalized: ${describeError(error)}`);
  }
  const passed = run.failures.length === 0;
  return {
    id: scenario.id,
    kind: scenario.kind,
    passed,
    status,
    evidenceDir: writer?.dir,
    durationMs,
    calls: run.calls.length,
    model: run.models[0] ?? null,
    leak,
    leaks: [...scan.hits, ...requestHits],
    ...(passed ? {} : { failure: run.failures[0], failures: run.failures }),
  };
}

/**
 * Runs one scenario end to end and always closes the page, the context and the app. Never rejects.
 *
 * `deps` overrides every collaborator so the wiring can be proven with fakes: newScenarioContext,
 * createPlaywrightTransport, createRecordingHttp, applyInjection, startApp ({ family, variant, initial,
 * faults }), dist (module with createTaskAgent, createRemoteTaskHost, createTypeSafeTaskDecider and
 * optionally redactEnvelope), readApiKey, generateSensitiveValues, maxScenarioMs, abortGraceMs,
 * expectTimeoutMs, closeTimeoutMs. Without an override the sibling modules and the dist bundle are
 * imported on first use.
 *
 * `dist` is the checkDist() result (its sha256 goes into summary.json); a module namespace is accepted too.
 *
 * @returns {Promise<{ id: string, kind: string, passed: boolean, status: string, evidenceDir?: string,
 *   durationMs: number, calls: number, model: string | null, leak: boolean,
 *   failure?: { kind: string, message: string }, failures?: { kind: string, message: string }[] }>}
 */
export async function runScenario(args) {
  const startedAt = Date.now();
  const { scenario, runId, evidenceRoot, dist, bundles } = args;
  const deps = args.deps ?? {};
  const run = {
    scenario,
    runId,
    failures: [],
    notes: [],
    trace: [],
    observations: [],
    pauses: [],
    pauseBackends: [],
    results: [],
    calls: [],
    faultNotes: [],
    transportLines: [],
    models: [],
    profile: { runOverrides: args.runOverrides, observeOffscreen: args.observeOffscreen === true },
    secrets: [],
    requestCount: 0,
    requestLeaks: new Map(),
    shotChain: Promise.resolve(),
    distSha256:
      typeof dist?.sha256 === 'string'
        ? dist.sha256
        : typeof bundles?.sha256 === 'string'
          ? bundles.sha256
          : null,
  };
  try {
    run.writer = createEvidenceWriter({ runId, scenarioId: scenario.id, root: evidenceRoot });
  } catch (error) {
    return {
      id: scenario?.id,
      kind: scenario?.kind,
      passed: false,
      status: 'error',
      durationMs: Date.now() - startedAt,
      calls: 0,
      model: null,
      leak: false,
      failure: { kind: 'evidence_failed', message: describeError(error) },
      failures: [{ kind: 'evidence_failed', message: describeError(error) }],
    };
  }

  try {
    const apiKey = (deps.readApiKey ?? readApiKey)();
    run.secrets = apiKey === '' ? [] : [{ label: 'TYPESAFE_API_KEY', value: apiKey }];
    run.collaborators = await resolveCollaborators(scenario, args);
    const inspector = run.collaborators.dist.createRedactor();
    run.sensitive = (deps.generateSensitiveValues ?? generateSensitiveValues)(
      `${runId}:${scenario.id}`
    );
    run.sensitiveScenario = declaresSensitive(scenario);
    run.inputs = resolveWithSensitive(scenario.inputs, run.sensitive);
    run.declarations = normalizeDeclarations(
      resolveWithSensitive(scenario.inputDeclarations, run.sensitive)
    );
    const resolutions = (scenario.resume ?? []).map(
      entry => resolveWithSensitive(entry.resolution, run.sensitive) ?? {}
    );
    run.secrets = buildSecrets({
      apiKey,
      sensitive: run.sensitive,
      inputs: run.inputs,
      declarations: run.declarations,
      resolutions,
      isSensitiveKey: inspector.isSensitiveKey,
    });
    run.sensitiveScenario ||= run.secrets.some(secret => secret.label.includes('heuristic:'));
    await executeScenario(run, args);
    writeRunEvidence(run);
    await run.shotChain;
    if (run.app !== undefined) {
      run.writer.write(
        'backend-after.json',
        snapshot(() => run.app.state())
      );
    }
    if (run.page !== undefined && run.result !== undefined) {
      await queueScreenshot(run, 'final');
    }
    if (run.app !== undefined) {
      await checkOutcome(run);
    }
  } catch (error) {
    addFailure(run, 'setup_failed', describeError(error));
  }

  try {
    if (run.failures.length > 0) {
      await writeFailureArtifacts(run);
    }
    if (!run.writer.exists('trace.json')) {
      writeRunEvidence(run);
    }
  } finally {
    await closeAll(run);
  }
  return finish(run, startedAt);
}
