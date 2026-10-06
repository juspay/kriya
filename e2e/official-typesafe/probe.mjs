import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRecordingHttp } from '../harness/jev.mjs';
import { scanForSecrets, redactSecrets } from '../harness/evidence.mjs';
import {
  loadScenarios,
  normalizeDeclarations,
  resolveWithSensitive,
} from '../harness/scenario.mjs';
import { generateSensitiveValues, scannableSensitiveValues } from '../harness/sensitive.mjs';
import { createRedactor } from '../../dist/index.esm.js';
import { readResponse, atomicQuestions, focusedQuestions, atomicVerdict } from './primitives.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const runId = process.argv[2];
const focused = process.argv[3] === '--focused';
if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
  throw new Error('Supply a fresh probe run ID.');
}
const output = path.resolve(root, '../evidence', runId);
if (fs.existsSync(output)) {
  throw new Error('Probe evidence must not be overwritten.');
}
fs.mkdirSync(output, { recursive: true });
const credential = () => process.env.TYPESAFE_API_KEY?.trim() ?? '';
if (!credential()) {
  throw new Error('Load the credential using Node --env-file.');
}
const secretValues = [{ label: 'credential', value: credential() }];
const events = [];
const http = createRecordingHttp({
  gate: 2,
  redactValues: () => secretValues,
  recorder: entry => events.push(entry),
});
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const write = (name, value) =>
  fs.writeFileSync(
    path.join(output, name),
    redactSecrets(`${JSON.stringify(value, null, 2)}\n`, secretValues)
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ask(request) {
  const body = JSON.stringify({ ...request, model: 'jev-1.13.0' });
  if (Buffer.byteLength(body) > 39953) {
    return { ok: false, code: 'BUDGET' };
  }
  if (body.includes(credential())) {
    return { ok: false, code: 'CREDENTIAL_BODY' };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await http('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credential,
        body,
        timeoutMs: 20000,
      });
    } catch {
      if (attempt === 2) {
        return { ok: false, code: 'TRANSPORT' };
      }
      await delay(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      if ([408, 429].includes(response.status) || response.status >= 500) {
        if (attempt < 2) {
          await delay(500 * 2 ** attempt);
          continue;
        }
      }
      return { ok: false, code: 'HTTP', status: response.status };
    }
    try {
      return { ...readResponse(request, await response.json()), bytes: Buffer.byteLength(body) };
    } catch {
      return { ok: false, code: 'JSON' };
    }
  }
  return { ok: false, code: 'EXHAUSTED' };
}

function batches(state, questions) {
  const groups = [];
  let current = {};
  for (const [key, question] of Object.entries(questions)) {
    const candidate = { ...current, [key]: question };
    if (
      Buffer.byteLength(JSON.stringify({ model: 'jev-1.13.0', state, questions: candidate })) >
        30000 &&
      Object.keys(current).length
    ) {
      groups.push({ state, questions: current });
      current = { [key]: question };
    } else {
      current = candidate;
    }
  }
  if (Object.keys(current).length) {
    groups.push({ state, questions: current });
  }
  return groups;
}

function publicFields(inputs, declarations, prefix = '', result = []) {
  if (inputs === null || typeof inputs !== 'object') {
    return result;
  }
  const redactor = createRedactor();
  for (const [key, value] of Object.entries(inputs)) {
    const leafPath = prefix ? `${prefix}.${key}` : key;
    const sensitive =
      redactor.isSensitiveKey(leafPath) ||
      declarations.some(
        d => d.sensitive === true && (leafPath === d.path || leafPath.startsWith(`${d.path}.`))
      );
    if (sensitive) {
      continue;
    }
    if (value !== null && typeof value === 'object') {
      publicFields(value, declarations, leafPath, result);
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      result.push({ path: leafPath, value });
    }
  }
  return result;
}

const registry = await loadScenarios(path.resolve(root, '../scenarios'));
const CASES = [
  ['checkout-a-authorized-test-checkout', false],
  ['checkout-a-approval-resume-one-order', false],
  ['catalog-c-outdoor-budget-cheapest', false],
  ['catalog-b-kitchen-under-forty-saved', false],
  ['checkout-c-buy-now-two-lines-unused-card', true],
  ['shipping-c-gift-next-day', true],
  ['shipping-a-fill-review', true],
  ['settings-a-already-off', true],
];
const historicalRun = 'continuation-final-20261004-c';
const dataRoot = path.resolve(root, '../evidence', historicalRun);
const smokeGoal = 'Set promotional messages off and verify the saved preference.';
const smokeState = {
  task: smokeGoal,
  requested: 'off',
  editableDraft: 'off',
  savedPreference: 'on',
};
const smoke = await ask({
  state: smokeState,
  questions: {
    selected: {
      type: 'choice',
      instructions: {
        goal: smokeGoal,
        question:
          'Is the saved preference in `state.savedPreference` equal to the requested preference in `state.requested`?',
      },
      criteria: {
        SATISFIED: 'The saved preference matches the requested preference.',
        NOT_SATISFIED: 'The saved preference differs from the requested preference.',
      },
    },
    holds: {
      type: 'noul',
      instructions: {
        goal: smokeGoal,
        question: 'Does `state.savedPreference` match `state.requested`?',
      },
      criteria: { true: 'The saved preference matches.', false: 'The saved preference differs.' },
    },
    support: {
      type: 'score',
      instructions: {
        goal: smokeGoal,
        question:
          'How much evidence does `state.savedPreference` give that the requested preference was saved?',
      },
      criteria: [
        { description: 'Saved preference contradicts the request.' },
        { description: 'Saved preference is unavailable.' },
        { description: 'Saved preference matches the request.' },
      ],
    },
  },
});
write('smoke.json', smoke);
if (!smoke.ok) {
  write('calls.json', events);
  process.stdout.write(
    `${JSON.stringify({ primitiveProbe: false, code: smoke.code, status: smoke.status })}\n`
  );
  process.exitCode = 1;
} else {
  const results = [];
  for (const [id, expectedSatisfied] of CASES) {
    const scenario = registry.find(s => s.id === id);
    const historicalCalls = read(path.join(dataRoot, id, 'jev-calls.json'));
    const original = historicalCalls.filter(call => call.request?.questions?.completion).at(-1);
    const summary = read(path.join(dataRoot, id, 'summary.json'));
    if (!original || summary.passed !== expectedSatisfied) {
      throw new Error('Recorded benchmark label/observation mismatch.');
    }
    const generated = generateSensitiveValues(`${historicalRun}:${id}`);
    secretValues.push(...scannableSensitiveValues(generated));
    const inputs = resolveWithSensitive(scenario.inputs, generated) ?? {};
    const declarations =
      normalizeDeclarations(resolveWithSensitive(scenario.inputDeclarations, generated)) ?? [];
    const observation = original.request.state;
    const citedIds = Object.entries(original.response.answers)
      .filter(([key]) => key.startsWith('evidence_'))
      .map(([, value]) => value.choice);
    const citedEvidence = [...new Set(citedIds)].flatMap(citedId => {
      const found = [...observation.elements, ...(observation.collectedEvidence ?? [])].find(
        e => e.id === citedId
      );
      return found ? [found] : [];
    });
    const controls = observation.elements
      .filter(e =>
        [
          'text_input',
          'textarea',
          'select',
          'checkbox',
          'switch',
          'radio',
          'range',
          'option',
        ].includes(e.kind)
      )
      .map(e =>
        Object.fromEntries(
          Object.entries(e).filter(([key]) =>
            [
              'id',
              'label',
              'kind',
              'inputType',
              'value',
              'checked',
              'selected',
              'options',
              'region',
            ].includes(key)
          )
        )
      );
    const state = {
      observation,
      suppliedFields: publicFields(inputs, declarations),
      controls,
      citedEvidence,
    };
    const baseline = await ask(original.request);
    const explicitRequest = structuredClone(original.request);
    for (const [key, question] of Object.entries(explicitRequest.questions)) {
      question.instructions.question =
        key === 'completion'
          ? 'Is every applicable requirement of `state.task` satisfied by current facts in `state.page`, `state.elements` and `state.collectedEvidence`, compared with `state.inputs` and `state.expected`? Every supplied matching profile value and each requested filter must be reflected in the final result.'
          : 'Which offered current element or collected passage directly evidences the required final state of `state.task`? Choose NONE_APPROPRIATE for unrelated labels, a draft, a success message alone, or absent final facts.';
    }
    const explicit = await ask(explicitRequest);
    const allAnswers = {};
    const responses = [];
    const requests = focused
      ? batches(
          {
            task: scenario.goal,
            currentPage: observation.page,
            observedElements: observation.elements,
          },
          focusedQuestions(scenario.goal, state)
        )
      : batches(state, atomicQuestions(scenario.goal, state));
    for (const request of requests) {
      const response = await ask(request);
      responses.push(response);
      if (response.ok) {
        Object.assign(allAnswers, response.answers);
      }
    }
    const row = {
      id,
      expectedSatisfied,
      recordedVerdict: original.response.answers.completion,
      sourceSha256: digest(fs.readFileSync(path.join(dataRoot, id, 'jev-calls.json'))),
      suppliedFields: state.suppliedFields.map(field => field.path),
      controlCount: controls.length,
      baseline,
      explicit,
      atomic: {
        valid: responses.every(r => r.ok),
        batches: responses.length,
        questions: Object.keys(allAnswers).length,
        answers: allAnswers,
        accepted: responses.every(r => r.ok) && atomicVerdict(allAnswers),
      },
    };
    results.push(row);
    write(`${id}.json`, row);
    process.stdout.write(
      `${JSON.stringify({ id, expectedSatisfied, baseline: baseline.answers?.completion?.choice, explicit: explicit.answers?.completion?.choice, atomic: row.atomic.accepted, valid: row.atomic.valid, batches: requests.length })}\n`
    );
  }
  write('calls.json', events);
  const tally = reader => ({
    acceptedTrue: results.filter(r => r.expectedSatisfied && reader(r)).length,
    acceptedFalse: results.filter(r => !r.expectedSatisfied && reader(r)).length,
    trueCases: results.filter(r => r.expectedSatisfied).length,
    falseCases: results.filter(r => !r.expectedSatisfied).length,
  });
  write('summary.json', {
    kind: 'SHADOW_REPLAY_NOT_BROWSER_E2E',
    model: smoke.model,
    historicalRun,
    cases: results.length,
    actualHttpCalls: events.length,
    smokeValid: smoke.ok,
    thresholds: { yes: 0.9, no: 0.1 },
    questionForm: focused ? 'direct structured comparison criteria' : 'indexed state references',
    baseline: tally(r => r.baseline.answers?.completion?.choice === 'SATISFIED'),
    explicit: tally(r => r.explicit.answers?.completion?.choice === 'SATISFIED'),
    atomic: tally(r => r.atomic.accepted),
    allResponsesValid: results.every(r => r.baseline.ok && r.explicit.ok && r.atomic.valid),
    librarySourceEditsByProbe: 0,
  });
  const scan = scanForSecrets(output, secretValues);
  write('secret-scan.json', {
    hits: scan.hits,
    files: scan.scanned,
    valuesChecked: scan.valuesChecked,
    shortValuePixelLimit:
      'No browser or images were used; public input filtering excludes declared/heuristic secrets. Byte scans cover known long values.',
  });
  if (scan.hits.length) {
    process.exitCode = 4;
  } else if (results.some(r => !r.baseline.ok || !r.explicit.ok || !r.atomic.valid)) {
    process.exitCode = 1;
  }
}
