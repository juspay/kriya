import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadScenarios,
  normalizeDeclarations,
  resolveWithSensitive,
} from '../harness/scenario.mjs';
import {
  generateSensitiveValues,
  isScannableSecret,
  scannableSensitiveValues,
} from '../harness/sensitive.mjs';
import { scanForSecrets } from '../harness/evidence.mjs';
import { assertJevCalls } from '../harness/runner.mjs';

const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(worktree, 'e2e/salvage');
const evidenceRoot = path.join(worktree, 'e2e/evidence');
const families = ['catalog', 'settings', 'shipping', 'checkout'];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function optionsFrom(argv) {
  const options = {
    ids: [],
    family: undefined,
    kind: 'live',
    expectedHash: undefined,
    suffix: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--run-id', '--family', '--kind', '--expected-hash', '--suffix'].includes(argument)) {
      const value = argv[++index];
      if (value === undefined) {
        throw new Error('Missing audit option value.');
      }
      if (argument === '--run-id') {
        options.ids.push(value);
      }
      if (argument === '--family') {
        options.family = value;
      }
      if (argument === '--kind') {
        options.kind = value;
      }
      if (argument === '--expected-hash') {
        options.expectedHash = value;
      }
      if (argument === '--suffix') {
        options.suffix = value;
      }
    } else if (!argument.startsWith('--')) {
      options.ids.push(argument);
    } else {
      throw new Error('Unsupported audit option.');
    }
  }
  if (!options.ids.length || options.ids.some(id => !/^[A-Za-z0-9_.-]{1,80}$/.test(id))) {
    throw new Error('Invalid audit run selection.');
  }
  if (options.family !== undefined && !families.includes(options.family)) {
    throw new Error('Invalid family.');
  }
  if (!['live', 'fault', 'all'].includes(options.kind)) {
    throw new Error('Invalid kind.');
  }
  if (options.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedHash)) {
    throw new Error('Invalid expected hash.');
  }
  if (
    options.suffix !== undefined &&
    (options.ids.length !== 1 || !/^[A-Za-z0-9_.-]{1,80}$/.test(options.suffix))
  ) {
    throw new Error('Invalid output suffix.');
  }
  return options;
}

function leafAt(value, dotted) {
  return dotted
    .split('.')
    .reduce(
      (current, key) =>
        current !== null && typeof current === 'object' ? current[key] : undefined,
      value
    );
}
function leaves(value, trail = '', result = []) {
  if (typeof value === 'string' || typeof value === 'number') {
    result.push({ path: trail, value: String(value) });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      leaves(item, trail ? `${trail}.${key}` : key, result);
    }
  }
  return result;
}
function declaredSecrets(inputs, declarations, source) {
  return (normalizeDeclarations(declarations) ?? [])
    .filter(declaration => declaration.sensitive === true)
    .flatMap(declaration =>
      leaves(leafAt(inputs, declaration.path), declaration.path).map(leaf => ({
        label: `${source}:${leaf.path}`,
        path: leaf.path,
        value: leaf.value,
      }))
    );
}
function usedPaths(task, trace) {
  const commands = [
    ...(task.ledger ?? []).map(entry => entry.command?.command),
    ...(trace.events ?? [])
      .filter(event => event.type === 'executing')
      .map(event => event.command?.command),
  ];
  return new Set(
    commands
      .filter(command => command?.operation === 'FILL' && command.value?.source === 'input')
      .map(command => command.value.path)
  );
}
function secretSets(scenario, runId, task, trace, credential) {
  const generated = generateSensitiveValues(`${runId}:${scenario.id}`);
  const inputs = resolveWithSensitive(scenario.inputs, generated);
  const declarations = resolveWithSensitive(scenario.inputDeclarations, generated);
  const declared = declaredSecrets(inputs, declarations, 'input');
  for (const [index, entry] of (scenario.resume ?? []).entries()) {
    const resolution = resolveWithSensitive(entry.resolution, generated) ?? {};
    declared.push(
      ...declaredSecrets(
        resolution.inputs,
        resolution.inputDeclarations ?? declarations,
        `resume.${index}`
      )
    );
    declared.push(
      ...leaves(resolution.sensitiveInputs).map(leaf => ({
        label: `resume.${index}.sensitiveInputs:${leaf.path}`,
        path: leaf.path,
        value: leaf.value,
      }))
    );
  }
  const used = usedPaths(task, trace);
  const short = declared.filter(
    secret => !isScannableSecret(secret.value) && used.has(secret.path)
  );
  const long = [
    { label: 'TYPESAFE_API_KEY', value: credential },
    ...scannableSensitiveValues(generated),
    ...declared.filter(secret => isScannableSecret(secret.value)),
  ];
  const unique = list => [...new Map(list.map(secret => [secret.value, secret])).values()];
  return {
    long: unique(long),
    short: unique(short),
    suppliedShortCount: declared.filter(secret => !isScannableSecret(secret.value)).length,
  };
}
function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? allFiles(file) : entry.isFile() ? [file] : [];
  });
}
const identityKey = key =>
  /(?:^id$|ids?$|signature|fingerprint|digest|hash|nonce|timestamp|^at$|^step$|^seq$|^index$|^calls$|file|screenshot|directory|^path$)/i.test(
    key
  );
const identifierValue = value =>
  /^(?:t\d+(?:\.\d+)?|c\d+|e\d+|(?:run|ses|snap|doc|req|apr|ck|non|dg|cx|sg)_[a-f0-9.]+)$/.test(
    value
  );
function shortScan(dir, secrets) {
  const hits = [];
  let jsonFiles = 0;
  const textualKey = key =>
    /(?:value|preview|text|message|description|label|expected|observed)/i.test(key);
  function visit(value, key, location, file) {
    if (identityKey(key)) {
      return;
    }
    if (typeof value === 'string' && ['{', '['].includes(value.trimStart()[0])) {
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object') {
          visit(parsed, key, `${location}/(json)`, file);
          return;
        }
      } catch {
        /* Ordinary text is checked below. */
      }
    }
    if (typeof value === 'string' && !identifierValue(value)) {
      for (const secret of secrets) {
        const escaped = secret.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const contains =
          value === secret.value ||
          new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`).test(value);
        if (contains) {
          hits.push({
            file,
            pointer: location,
            label: secret.label,
            match: value === secret.value ? 'exact_string' : 'bounded_text',
          });
        }
      }
    } else if (typeof value === 'number') {
      for (const secret of secrets) {
        if (
          (textualKey(key) || key === secret.path.split('.').at(-1)) &&
          String(value) === secret.value
        ) {
          hits.push({
            file,
            pointer: location,
            label: secret.label,
            match: 'sensitive_numeric_field',
          });
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, key, `${location}/${index}`, file));
    } else if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey, `${location}/${childKey}`, file);
      }
    }
  }
  for (const file of allFiles(dir).filter(file => file.endsWith('.json'))) {
    jsonFiles += 1;
    visit(readJson(file), '', '', path.relative(dir, file));
  }
  return {
    declaredUsedShortValues: secrets.length,
    jsonFiles,
    hits,
    passed: hits.length === 0,
    qualification:
      'Only declared sensitive values used by actual FILL input references are checked structurally. Identity/path/time metadata is excluded. Short-value collisions still require interpretation; byte scans do not prove screenshot pixels.',
  };
}
function requestOf(call) {
  let request = call.request;
  if (typeof request === 'string') {
    request = JSON.parse(request);
  }
  if (typeof request?.body === 'string') {
    request = JSON.parse(request.body);
  }
  return request;
}
function routeData(family, trace, observations) {
  const source = fs.readFileSync(path.join(worktree, `e2e/apps/${family}.mjs`), 'utf8');
  const routes = [...source.matchAll(/['"](\/[A-Za-z0-9_/?=.-]+)['"]/g)].map(match => match[1]);
  let host;
  function visit(value) {
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:url|href)$/i.test(key) && typeof child === 'string') {
          try {
            const parsed = new URL(child);
            routes.push(parsed.pathname);
            host ??= parsed.host;
          } catch {
            /* Non-URL strings are not route evidence. */
          }
        } else {
          visit(child);
        }
      }
    }
  }
  visit(trace);
  visit(observations);
  return { routes: [...new Set(routes)], host };
}

async function auditRun(runId, options, registry, credential) {
  const dir = path.join(evidenceRoot, runId),
    run = readJson(path.join(dir, 'run-summary.json'));
  const observedIds = run.results.map(result => result.id);
  const present = observedIds.map(id => registry.find(scenario => scenario.id === id));
  if (present.some(scenario => scenario === undefined)) {
    throw new Error('Unknown scenario receipt.');
  }
  const chosenFamilies = options.family
    ? [options.family]
    : [...new Set(present.map(scenario => scenario.family))];
  const expected = registry
    .filter(
      scenario =>
        chosenFamilies.includes(scenario.family) &&
        (options.kind === 'all' || scenario.kind === options.kind)
    )
    .map(scenario => scenario.id)
    .sort();
  const unique = [...new Set(observedIds)].sort();
  const receiptsComplete =
    JSON.stringify(expected) === JSON.stringify(unique) && observedIds.length === unique.length;
  const hash = options.expectedHash ?? run.sha256;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Run hash is unavailable.');
  }
  const currentBuild = readJson(path.join(outputDir, 'build-receipt.json'));
  const currentBuildMatches = currentBuild.verified === true && currentBuild.dist.sha256 === hash;
  const rows = [];
  for (const result of run.results) {
    const scenario = registry.find(item => item.id === result.id),
      scenarioDir = path.join(dir, result.id);
    const summary = readJson(path.join(scenarioDir, 'summary.json')),
      task = readJson(path.join(scenarioDir, 'result.json'));
    const calls = readJson(path.join(scenarioDir, 'jev-calls.json')),
      trace = readJson(path.join(scenarioDir, 'trace.json')),
      observations = readJson(path.join(scenarioDir, 'observations.json'));
    const secrets = secretSets(scenario, runId, task ?? {}, trace, credential);
    const scan = scanForSecrets(scenarioDir, secrets.long),
      short = shortScan(scenarioDir, secrets.short);
    const routes = routeData(scenario.family, trace, observations),
      jev = assertJevCalls({ calls, scenario, ...routes });
    let questions = 0,
      goalMismatches = 0;
    for (const call of calls) {
      for (const question of Object.values(requestOf(call)?.questions ?? {})) {
        questions += 1;
        if (question.instructions?.goal !== scenario.goal) {
          goalMismatches += 1;
        }
      }
    }
    const row = {
      id: result.id,
      receiptPassed: result.passed,
      status: result.status,
      resultPresent: task !== null && typeof task === 'object',
      hashMatches: summary.sha256 === hash && summary.sha256 === run.sha256,
      callCountMatches: summary.calls === calls.length && result.calls === calls.length,
      calls: calls.length,
      questions,
      goalMismatches,
      jevAuditFailures: jev.failures.map(failure => ({
        kind: failure.kind,
        message: failure.message,
      })),
      models: jev.models,
      longSecretScan: {
        hits: scan.hits,
        files: scan.scanned,
        skippedLabels: scan.skipped,
        valuesChecked: scan.valuesChecked,
        keyChecked: secrets.long.some(
          secret => secret.label === 'TYPESAFE_API_KEY' && secret.value !== ''
        ),
        passed: scan.hits.length === 0 && scan.scanned > 0 && scan.valuesChecked > 0,
      },
      shortSecretScan: short,
      suppliedButUnusedShortCount: secrets.suppliedShortCount - secrets.short.length,
    };
    row.integrityPassed =
      row.resultPresent &&
      row.hashMatches &&
      row.callCountMatches &&
      goalMismatches === 0 &&
      jev.failures.length === 0 &&
      row.longSecretScan.passed &&
      row.longSecretScan.keyChecked &&
      short.passed;
    rows.push(row);
  }
  const report = {
    runId,
    profile: run.profile ?? null,
    claimedHash: hash,
    expectedHashProvided: options.expectedHash !== undefined,
    currentBuildMatches,
    historicalHashQualification: currentBuildMatches
      ? 'Current verified receipt matches.'
      : 'Historical consistency only unless caller provided independent expected hash.',
    expectedIds: expected,
    observedIds: unique,
    receiptsComplete,
    scenarioPasses: rows.filter(row => row.receiptPassed).map(row => row.id),
    scenarioFailures: rows.filter(row => !row.receiptPassed).map(row => row.id),
    calls: rows.reduce((n, row) => n + row.calls, 0),
    questions: rows.reduce((n, row) => n + row.questions, 0),
    goalMismatches: rows.reduce((n, row) => n + row.goalMismatches, 0),
    passed:
      receiptsComplete &&
      (options.expectedHash !== undefined || currentBuildMatches) &&
      rows.every(row => row.integrityPassed),
    qualification:
      'Audit integrity is distinct from scenario success. No raw secret values are emitted. All artifact bytes are scanned for the key and long values; screenshot pixel contents and unused/ambiguous short-value secrecy are not proven.',
    rows,
  };
  const suffix = options.suffix ?? runId;
  fs.writeFileSync(
    path.join(outputDir, `evidence-audit-${suffix}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ runId, auditPassed: report.passed, receipts: rows.length, expected: expected.length, scenarioPassed: report.scenarioPasses.length, scenarioFailed: report.scenarioFailures.length, calls: report.calls, questions: report.questions, goalMismatches: report.goalMismatches, longSecretHits: rows.reduce((n, row) => n + row.longSecretScan.hits.length, 0), declaredUsedShortValues: rows.reduce((n, row) => n + row.shortSecretScan.declaredUsedShortValues, 0), shortStructuredHits: rows.reduce((n, row) => n + row.shortSecretScan.hits.length, 0), hashMatches: rows.every(row => row.hashMatches), output: `e2e/salvage/evidence-audit-${suffix}.json` })}\n`
  );
  return report.passed;
}

try {
  const options = optionsFrom(process.argv.slice(2));
  const credential =
    typeof process.env.TYPESAFE_API_KEY === 'string' ? process.env.TYPESAFE_API_KEY.trim() : '';
  if (!credential) {
    throw new Error('Credential unavailable for audit.');
  }
  const registry = await loadScenarios(path.join(worktree, 'e2e/scenarios'));
  let passed = true;
  for (const id of options.ids) {
    passed = (await auditRun(id, options, registry, credential)) && passed;
  }
  process.exitCode = passed ? 0 : 1;
} catch {
  process.stderr.write(
    'Evidence audit could not complete; no values or exception text were emitted.\n'
  );
  process.exitCode = 2;
}
