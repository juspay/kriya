import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_CODES, preflight as realPreflight } from './harness/env.mjs';
import { checkDist, readBundles as realReadBundles, REQUIRED_EXPORTS } from './harness/dist.mjs';
import { runScenario as realRunScenario } from './harness/runner.mjs';
import {
  FAMILIES,
  findDuplicateIds,
  KINDS,
  loadScenarioFiles,
  validateScenario,
  VARIANTS,
} from './harness/scenario.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(here, '..');
const DEFAULT_JEV_CONCURRENCY = 3;
const MAX_JOBS = 16;
const INTERRUPT_GRACE_MS = 10000;
const EXIT_FLUSH_MS = 3000;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const USAGE = `Usage: node [--env-file=<file defining TYPESAFE_API_KEY>] e2e/run.mjs [options]

Selection
  --scenario <id>...       run these scenario ids (repeatable)
  --family <f[,f]>         catalog | settings | shipping | checkout
  --variant <v[,v]>        A | B | C
  --kind <k>               live | fault | all (default all)
Execution
  --jobs <n>               scenarios in parallel (default 1)
  --action-confidence <n>  uniform action floor from 0 to 1
  --argument-confidence <n> uniform argument floor from 0 to 1
  --completion-confidence <n> uniform completion floor from 0 to 1
  --observe-offscreen     include rendered offscreen elements in observations
  --jev-concurrency <n>    process-wide limit of in-flight Jev requests (default ${DEFAULT_JEV_CONCURRENCY})
  --run-id <id>            evidence directory name under e2e/evidence (default a timestamp)
Inspection
  --list                   print id, family, variant, kind and title of every selected scenario
  --validate               validate every scenario file and exit
Other
  --scenarios-dir <dir>    scenario directory (default e2e/scenarios)
  --evidence-root <dir>    evidence root (default e2e/evidence)
  --root <dir>             repository root (default the parent of e2e)
  --help

Exit codes: 0 all passed, 1 a scenario failed (or validation failed), 2 preflight or usage, 3 dist stale or
missing, 4 the evidence scan found a secret.
`;

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--scenario',
  '--family',
  '--variant',
  '--kind',
  '--jobs',
  '--jev-concurrency',
  '--action-confidence',
  '--argument-confidence',
  '--completion-confidence',
  '--run-id',
  '--scenarios-dir',
  '--evidence-root',
  '--root',
]);
const BOOLEAN_FLAGS = new Set(['--list', '--validate', '--help', '-h', '--observe-offscreen']);

function parseCount(name, text, errors) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_JOBS) {
    errors.push(`${name} must be an integer between 1 and ${MAX_JOBS}`);
    return undefined;
  }
  return value;
}

/** @returns {{ options: object, errors: string[] }} */
export function parseArgs(argv) {
  const options = {
    scenarios: [],
    families: [],
    variants: [],
    kind: 'all',
    jobs: 1,
    jevConcurrency: DEFAULT_JEV_CONCURRENCY,
    list: false,
    validate: false,
    help: false,
  };
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const [flag, inline] =
      raw.startsWith('--') && raw.includes('=')
        ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
        : [raw, undefined];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === '--observe-offscreen') {
        options.observeOffscreen = true;
      } else if (flag === '--list') {
        options.list = true;
      } else if (flag === '--validate') {
        options.validate = true;
      } else {
        options.help = true;
      }
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      errors.push(`unknown argument ${flag.startsWith('-') ? flag : raw}`);
      continue;
    }
    const values = [];
    if (inline !== undefined) {
      values.push(inline);
    } else if (flag === '--scenario') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i += 1;
        values.push(argv[i]);
      }
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      i += 1;
      values.push(argv[i]);
    }
    if (values.length === 0) {
      errors.push(`${flag} needs a value`);
      continue;
    }
    const [value] = values;
    // an empty list would mean "no filter", i.e. every scenario against the live model
    const items = values.flatMap(item => item.split(',')).filter(Boolean);
    if (['--scenario', '--family', '--variant'].includes(flag) && items.length === 0) {
      errors.push(`${flag} needs a non-empty value`);
      continue;
    }
    switch (flag) {
      case '--scenario':
        options.scenarios.push(...items);
        break;
      case '--family':
        options.families.push(...items);
        break;
      case '--variant':
        options.variants.push(...items.map(item => item.toUpperCase()));
        break;
      case '--kind':
        if (value === 'all' || KINDS.includes(value)) {
          options.kind = value;
        } else {
          errors.push('--kind must be live, fault or all');
        }
        break;
      case '--jobs':
        options.jobs = parseCount('--jobs', value, errors) ?? options.jobs;
        break;
      case '--action-confidence':
      case '--argument-confidence':
      case '--completion-confidence': {
        const floor = Number(value);
        if (!Number.isFinite(floor) || floor < 0 || floor > 1)
          errors.push(`${flag} must be between 0 and 1`);
        else {
          options.confidence ??= {};
          options.confidence[flag.slice(2).split('-')[0]] = floor;
        }
        break;
      }
      case '--jev-concurrency':
        options.jevConcurrency =
          parseCount('--jev-concurrency', value, errors) ?? options.jevConcurrency;
        break;
      case '--run-id':
        if (RUN_ID_PATTERN.test(value) && !value.includes('..')) {
          options.runId = value;
        } else {
          errors.push(
            '--run-id must be 1 to 80 characters of letters, digits, dot, dash or underscore'
          );
        }
        break;
      case '--scenarios-dir':
        options.scenariosDir = value;
        break;
      case '--evidence-root':
        options.evidenceRoot = value;
        break;
      default:
        options.root = value;
    }
  }
  for (const family of options.families) {
    if (!FAMILIES.includes(family)) {
      errors.push(`--family ${family} is not one of ${FAMILIES.join(', ')}`);
    }
  }
  for (const variant of options.variants) {
    if (!VARIANTS.includes(variant)) {
      errors.push(`--variant ${variant} is not one of ${VARIANTS.join(', ')}`);
    }
  }
  return { options, errors };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function defaultRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `run-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Runs worker over items with at most `limit` in flight; results keep the order of items. */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function loadAppDescriptions(root) {
  const apps = {};
  for (const family of FAMILIES) {
    try {
      const module = await import(
        pathToFileURL(path.join(root, 'e2e', 'apps', `${family}.mjs`)).href
      );
      apps[family] = module.describe();
    } catch {
      // an app that cannot be described only disables the option cross-check for its family
    }
  }
  return apps;
}

const pickText = (value, width) => String(value ?? '').padEnd(width);

function selectScenarios(entries, options) {
  return entries.filter(({ scenario }) => {
    if (options.scenarios.length > 0 && !options.scenarios.includes(scenario.id)) {
      return false;
    }
    if (options.families.length > 0 && !options.families.includes(scenario.family)) {
      return false;
    }
    if (options.variants.length > 0 && !options.variants.includes(scenario.variant)) {
      return false;
    }
    return options.kind === 'all' || scenario.kind === options.kind;
  });
}

function formatResult(result) {
  const label = result.kind === 'fault' ? 'FAULT-INJECTED' : 'LIVE';
  const seconds = ((result.durationMs ?? 0) / 1000).toFixed(1);
  const head = `${result.passed ? 'PASS' : 'FAIL'} ${pickText(label, 14)} ${result.id} (${result.status}, ${seconds}s, ${result.calls ?? 0} Jev calls${result.model ? `, ${result.model}` : ''})`;
  if (result.passed) {
    return head;
  }
  const lines = (result.failures ?? [result.failure]).filter(Boolean).slice(0, 6);
  return [
    head,
    ...lines.map(failure => `     ${failure.kind}: ${String(failure.message).split('\n')[0]}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

/**
 * The CLI as a function (importing this module runs nothing). `deps` replaces preflight, checkDist,
 * readBundles, launchBrowser, runScenario and getProcessGate so the exit codes and the scheduling can be
 * proven without a browser or a model. SIGINT and SIGTERM close the browser and exit 130; they are trapped
 * unless `deps.launchBrowser` is faked, and `deps.trapSignals` forces either way. A browser that does not close within `deps.interruptGraceMs` (10 s) no longer delays the exit.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text),
  deps = {},
  root,
} = {}) {
  const out = line => stdout(`${line}\n`);
  const err = line => stderr(`${line}\n`);
  const { options, errors } = parseArgs(argv);
  if (errors.length > 0) {
    errors.forEach(message => err(`error: ${message}`));
    err(USAGE);
    return EXIT_CODES.PREFLIGHT;
  }
  if (options.help) {
    out(USAGE);
    return EXIT_CODES.PASS;
  }
  const repoRoot = path.resolve(options.root ?? root ?? DEFAULT_ROOT);
  const scenariosDir = path.resolve(
    options.scenariosDir ?? path.join(repoRoot, 'e2e', 'scenarios')
  );
  const evidenceRoot = path.resolve(options.evidenceRoot ?? path.join(repoRoot, 'e2e', 'evidence'));

  const { entries, errors: loadErrors } = await loadScenarioFiles(scenariosDir);

  if (options.validate) {
    return validateAll({ entries, loadErrors, repoRoot, out, err });
  }
  if (loadErrors.length > 0) {
    loadErrors.forEach(item => err(`error: ${item.file}: ${item.message}`));
    return EXIT_CODES.PREFLIGHT;
  }

  const duplicates = findDuplicateIds(entries);
  if (duplicates.length > 0) {
    duplicates.forEach(item =>
      err(`error: duplicate scenario id ${item.id} in ${item.files.join(', ')}`)
    );
    return EXIT_CODES.PREFLIGHT;
  }

  const unknown = options.scenarios.filter(
    id => !entries.some(({ scenario }) => scenario.id === id)
  );
  if (unknown.length > 0) {
    err(`error: unknown scenario id(s): ${unknown.join(', ')}`);
    return EXIT_CODES.PREFLIGHT;
  }
  const selected = selectScenarios(entries, options);

  if (options.list) {
    out(
      `${pickText('id', 44)} ${pickText('family', 9)} ${pickText('variant', 8)} ${pickText('kind', 5)} title`
    );
    for (const { scenario } of selected) {
      out(
        `${pickText(scenario.id, 44)} ${pickText(scenario.family, 9)} ${pickText(scenario.variant, 8)} ${pickText(scenario.kind, 5)} ${scenario.title ?? ''}`
      );
    }
    out(`${selected.length} scenario(s)`);
    return EXIT_CODES.PASS;
  }

  if (selected.length === 0) {
    err('error: no scenario matches the selection');
    return EXIT_CODES.PREFLIGHT;
  }
  const apps = await loadAppDescriptions(repoRoot);
  const invalid = selected
    .map(({ file, scenario }) => ({ file, scenario, result: validateScenario(scenario, { apps }) }))
    .filter(item => !item.result.ok);
  if (invalid.length > 0) {
    for (const item of invalid) {
      err(`invalid scenario ${item.scenario?.id ?? '(no id)'} in ${item.file}:`);
      item.result.errors.forEach(message => err(`  - ${message}`));
    }
    return EXIT_CODES.PREFLIGHT;
  }

  const preflightResult = await (deps.preflight ?? realPreflight)({ env });
  if (!preflightResult.ok) {
    err('preflight failed:');
    (preflightResult.problems ?? []).forEach(message => err(`  - ${message}`));
    return EXIT_CODES.PREFLIGHT;
  }
  const distResult = await (deps.checkDist ?? checkDist)({
    root: repoRoot,
    requiredExports: REQUIRED_EXPORTS,
  });
  if (!distResult.ok) {
    err('dist check failed (the harness never builds; the package build is a separate step):');
    (distResult.reasons ?? []).forEach(message => err(`  - ${message}`));
    return EXIT_CODES.DIST;
  }
  const bundles = await (deps.readBundles ?? realReadBundles)(repoRoot);
  if (bundles.sha256 !== distResult.sha256) {
    err('dist changed between verification and loading; run again against a stable build');
    return EXIT_CODES.DIST;
  }

  const runId = options.runId ?? defaultRunId();
  const taken = selected
    .map(({ scenario }) => path.join(evidenceRoot, runId, String(scenario.id)))
    .filter(dir => fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
  if (taken.length > 0) {
    err(
      `error: run id ${runId} already has evidence for ${taken.length} selected scenario(s); evidence is never overwritten, pass a new --run-id`
    );
    return EXIT_CODES.PREFLIGHT;
  }
  const startedAt = new Date().toISOString();
  let browser;
  let gate;
  try {
    const launch =
      deps.launchBrowser ??
      (await import(pathToFileURL(path.join(here, 'harness', 'browser.mjs')).href)).launchBrowser;
    const getGate =
      deps.getProcessGate ??
      (await import(pathToFileURL(path.join(here, 'harness', 'jev.mjs')).href)).getProcessGate;
    gate = getGate(options.jevConcurrency);
    browser = await launch(preflightResult);
  } catch (error) {
    err(
      `preflight failed: the browser or the Jev gate could not start (${String(error?.message ?? error).split('\n')[0]})`
    );
    return EXIT_CODES.PREFLIGHT;
  }

  const execute = deps.runScenario ?? realRunScenario;
  let results;
  const interrupt = signal => () => {
    err(`interrupted (${signal}): closing the browser`);
    const hardExit = setTimeout(
      () => process.exit(130),
      deps.interruptGraceMs ?? INTERRUPT_GRACE_MS
    );
    hardExit.unref?.();
    Promise.resolve()
      .then(() => browser?.close?.())
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  const onSigint = interrupt('SIGINT');
  const onSigterm = interrupt('SIGTERM');
  const trapSignals = deps.trapSignals ?? deps.launchBrowser === undefined;
  if (trapSignals) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }
  try {
    results = await runPool(selected, options.jobs, async ({ scenario }) => {
      try {
        const result = await execute({
          scenario,
          env: preflightResult,
          bundles,
          browser,
          gate,
          runId,
          evidenceRoot,
          dist: distResult,
          runOverrides:
            options.confidence === undefined ? undefined : { confidence: options.confidence },
          observeOffscreen: options.observeOffscreen === true,
        });
        out(formatResult(result));
        return result;
      } catch (error) {
        const failure = {
          kind: 'runner_threw',
          message: String(error?.message ?? error).split('\n')[0],
        };
        const result = {
          id: scenario.id,
          kind: scenario.kind,
          passed: false,
          status: 'error',
          failure,
          failures: [failure],
          leak: false,
        };
        out(formatResult(result));
        return result;
      }
    });
  } finally {
    if (trapSignals) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
    try {
      await browser?.close?.();
    } catch {
      // closing is best effort
    }
  }

  const exitCode = results.some(result => result.leak)
    ? EXIT_CODES.EVIDENCE
    : results.every(result => result.passed)
      ? EXIT_CODES.PASS
      : EXIT_CODES.FAILED;
  const receiptSaved = summarize({
    results,
    exitCode,
    runId,
    startedAt,
    evidenceRoot,
    distResult,
    out,
    profile: {
      confidence: options.confidence ?? null,
      observeOffscreen: options.observeOffscreen === true,
    },
  });
  return receiptSaved ? exitCode : EXIT_CODES.FAILED;
}

function validateAll({ entries, loadErrors, repoRoot, out, err }) {
  return loadAppDescriptions(repoRoot).then(apps => {
    let problems = 0;
    for (const item of loadErrors) {
      problems += 1;
      err(`ERROR ${item.file}: ${item.message}`);
    }
    for (const { file, scenario } of entries) {
      const result = validateScenario(scenario, { apps });
      if (result.ok) {
        out(`OK    ${scenario.id} (${file})`);
      } else {
        problems += result.errors.length;
        err(`ERROR ${scenario?.id ?? '(no id)'} (${file}):`);
        result.errors.forEach(message => err(`  - ${message}`));
      }
    }
    for (const duplicate of findDuplicateIds(entries)) {
      problems += 1;
      err(`ERROR duplicate scenario id ${duplicate.id} in ${duplicate.files.join(', ')}`);
    }
    if (entries.length === 0) {
      problems += 1;
      err('ERROR no scenarios were found: validating nothing proves nothing');
    }
    out(`validated ${entries.length} scenario(s), ${problems} problem(s)`);
    return problems === 0 ? EXIT_CODES.PASS : EXIT_CODES.FAILED;
  });
}

function summarize({
  results,
  exitCode,
  runId,
  startedAt,
  evidenceRoot,
  distResult,
  out,
  profile,
}) {
  const live = results.filter(result => result.kind !== 'fault');
  const fault = results.filter(result => result.kind === 'fault');
  const count = list => `${list.filter(result => result.passed).length} of ${list.length}`;
  out('');
  out(`live-verified (real Jev, real Chromium, real dist): ${count(live)} scenarios passed`);
  out(`fault-injected (labelled, not live verification): ${count(fault)} scenarios passed`);
  const runDir = path.join(evidenceRoot, runId);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'run-summary.json'),
      `${JSON.stringify(
        {
          runId,
          startedAt,
          finishedAt: new Date().toISOString(),
          sha256: distResult?.sha256 ?? null,
          profile,
          exitCode,
          liveVerified: { passed: live.filter(result => result.passed).length, total: live.length },
          faultInjected: {
            passed: fault.filter(result => result.passed).length,
            total: fault.length,
          },
          results: results.map(result => ({
            id: result.id,
            kind: result.kind,
            passed: result.passed,
            status: result.status,
            durationMs: result.durationMs ?? null,
            calls: result.calls ?? 0,
            model: result.model ?? null,
            leak: Boolean(result.leak),
            failures: (result.failures ?? []).map(failure => ({
              kind: failure.kind,
              message: failure.message,
            })),
          })),
        },
        null,
        2
      )}\n`
    );
    out(`evidence: ${runDir}`);
  } catch {
    out('evidence: the run summary could not be written');
    out(`exit code ${EXIT_CODES.FAILED}`);
    return false;
  }
  out(`exit code ${exitCode}`);
  return true;
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

/**
 * Lets piped output drain before the process ends; the unref'd timer still forces the exit if something
 * (a dangling agent run, a socket) keeps the event loop alive.
 */
function finishProcess(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), EXIT_FLUSH_MS).unref();
}

if (isMain) {
  main().then(finishProcess, error => {
    process.stderr.write(`internal error: ${String(error?.message ?? error).split('\n')[0]}\n`);
    finishProcess(EXIT_CODES.FAILED);
  });
}
