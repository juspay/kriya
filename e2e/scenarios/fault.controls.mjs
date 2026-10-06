/**
 * Scripted assertion controls for the eight labelled fault scenarios. No agent, dist or Jev is used.
 * Real local app/backend/UI states are driven independently. Synthetic TaskResults prove assertion
 * behavior only; configured/fired note fixtures never count as a real injected or live-model run.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from '../harness/browser.mjs';
import { validateScenario } from '../harness/scenario.mjs';
import { describe as describeSettings, startApp as startSettings } from '../apps/settings.mjs';
import { describe as describeCatalog, startApp as startCatalog } from '../apps/catalog.mjs';
import { buildControls as settingsControls } from './settings.controls.mjs';
import { buildGroups as catalogGroups } from './catalog.controls.mjs';
import { SETTINGS_LABELS } from './settings.mjs';
import { scenarios } from './fault.mjs';

const PLANS = Object.freeze([
  ['fault-premature-done', 'decider', 'prematureDone', 'completed'],
  ['fault-invalid-target', 'decider', 'invalidTarget', 'blocked'],
  ['fault-invalid-argument', 'decider', 'invalidArgument', 'completed'],
  ['fault-stale-before-execute', 'host', 'staleBeforeExecute', 'completed'],
  ['fault-lost-after-commit', 'host', 'lostAfterCommit', 'completed'],
  ['fault-timeout-after-commit', 'host', 'timeoutAfterCommit', 'completed'],
  ['fault-context-destroyed', 'host', 'contextDestroyed', 'completed'],
  ['fault-cancel-model-call', 'decider', 'slow', 'cancelled'],
]);
const BASE_ID = 'settings-a-disable-promotional';
const CATALOG_ID = 'catalog-a-quoted-search-category';
const scope = {
  sessionId: 'ses_000000000001',
  snapshotId: 'snap_000000000001',
  documentId: 'doc_000000000001',
};
const clone = value => structuredClone(value);
const usage = () => ({
  steps: 2,
  modelCalls: 5,
  staleRetries: 0,
  noProgress: 0,
  uncertainEffects: 0,
  prematureDone: 0,
  invalidDecisions: 0,
  rejectedCommands: 0,
  deciderFailures: 0,
  hostFailures: 0,
  elapsedMs: 1000,
});
const summary = () => ({
  ...scope,
  snapshotId: 'snap_000000000002',
  sequence: 3,
  observedAt: 2000,
  url: 'http://127.0.0.1/',
  title: 'Preferences',
  fingerprint: 'fp3',
  elementCount: 5,
});
const target = () => ({
  sessionId: scope.sessionId,
  snapshotId: scope.snapshotId,
  targetId: 't1',
  signature: 'sg_0000000000000001',
});
const checked = () => ({
  kind: 'checked',
  signature: target().signature,
  label: SETTINGS_LABELS.A.promotional,
  checked: false,
});
const entry = () => ({
  seq: 1,
  step: 1,
  command: {
    command: { operation: 'SET_CHECKED', target: target(), checked: false },
    target: {
      id: 't1',
      signature: target().signature,
      role: 'switch',
      kind: 'switch',
      label: SETTINGS_LABELS.A.promotional,
      sensitive: false,
    },
  },
  digest: 'dg_00000000000000000000000000000001',
  effects: ['toggle'],
  status: 'applied',
  effect: 'applied',
  postconditions: [checked()],
  scope: { ...scope },
  observationSequence: 1,
  observationOrdinal: 1,
  url: 'http://127.0.0.1/',
  startedAt: 1000,
  finishedAt: 1100,
  navigated: false,
});
const completion = () => ({
  mode: 'effected',
  effected: true,
  answered: false,
  basis: 'postconditions',
  evidence: [
    {
      id: 't1',
      source: 'observation',
      label: SETTINGS_LABELS.A.promotional,
      kind: 'switch',
      url: 'http://127.0.0.1/',
    },
  ],
  actionsExecuted: 1,
  verifierConfidence: 0.99,
  verifiedAt: 2000,
  verifiedSnapshot: summary(),
  postconditions: [{ ledgerSeq: 1, postcondition: checked(), status: 'holds' }],
  resolvedUncertain: [],
  unresolvedUncertain: [],
  unobserved: {
    iframes: 0,
    shadowRoots: 0,
    canvases: 0,
    contentEditable: 0,
    multiSelects: 0,
    externalTargets: 0,
  },
});

function synthetic(scenario, plan, catalogResult) {
  const base = {
    runId: 'run_000000000001',
    sessionId: scope.sessionId,
    goal: scenario.goal,
    steps: 2,
    stats: {
      usage: usage(),
      modelLatencyMs: 0,
      actions: { applied: 1, noop: 0, rejected: 0, failed: 0, uncertain: 0, navigated: 0 },
    },
    ledger: [entry()],
    exchanges: [],
    warnings: [],
    startedAt: 900,
    finishedAt: 2000,
    lastEffect: 'applied',
    unresolvedUncertain: [],
    finalObservation: summary(),
    status: plan[3],
    completion: completion(),
  };
  if (plan[2] === 'contextDestroyed') {
    const result = clone(catalogResult);
    result.goal = scenario.goal;
    result.completion.verifiedSnapshot.documentId = 'doc_000000000002';
    result.ledger[1].scope = { ...result.ledger[1].scope, documentId: 'doc_000000000002' };
    return result;
  }
  if (['invalidTarget', 'slow'].includes(plan[2])) {
    base.ledger = [];
    base.lastEffect = 'none';
    delete base.completion;
    base.stats.actions.applied = 0;
    if (plan[2] === 'invalidTarget') {
      base.reason = 'MODEL_UNCERTAIN';
      base.message = 'Unusable target selected.';
      base.stats.usage.invalidDecisions = 1;
    } else base.during = 'decision';
  }
  if (plan[2] === 'staleBeforeExecute') {
    base.ledger.unshift({
      ...entry(),
      effects: ['toggle'],
      status: 'rejected_stale',
      effect: 'none',
      postconditions: [],
      code: 'TARGET_STALE',
    });
    base.ledger[1].seq = 2;
  }
  if (['lostAfterCommit', 'timeoutAfterCommit'].includes(plan[2])) {
    base.ledger[0].status = 'uncertain';
    base.ledger[0].effect = 'uncertain';
    base.ledger[0].code = plan[2] === 'timeoutAfterCommit' ? 'EXECUTION_TIMEOUT' : 'DOCUMENT_LOST';
    base.lastEffect = 'uncertain';
    base.stats.actions = { ...base.stats.actions, applied: 0, uncertain: 1 };
    base.completion.resolvedUncertain = [{ seq: 1, by: 'postcondition', effect: 'applied' }];
  }
  return base;
}

function faultContext(scenario, plan) {
  const countKey = plan[1] === 'decider' ? 'atDecision' : 'atExecution';
  const ordinalKey = plan[1] === 'decider' ? 'decision' : 'execution';
  const note = {
    seq: 2,
    type: 'fault_injection',
    label: 'FAULT_INJECTION',
    live: false,
    scenarioId: scenario.id,
    event: 'fired',
    layer: plan[1],
    mode: plan[2],
    [countKey]: 1,
    [ordinalKey]: 1,
    applied: true,
    replaced: 1,
    operation: 'SET_CHECKED',
    realStatus: 'applied',
    realEffect: 'applied',
    candidateId: 'c9001',
    navigationPhase: 'during',
  };
  const trace = [];
  if (plan[2] === 'prematureDone')
    trace.push(
      { type: 'done_gate', passed: false },
      { type: 'exchange', exchange: { provider: 'fault-injection', stage: 'action' } }
    );
  if (plan[2] === 'invalidArgument')
    trace.push({ type: 'exchange', exchange: { provider: 'fault-injection', stage: 'argument' } });
  return {
    calls: [],
    trace,
    pauses: [],
    results: [],
    faultNotes:
      plan[2] === 'slow'
        ? [note, { event: 'slow_finished', mode: 'slow', outcome: 'cancelled_during_delay' }]
        : [note],
    sensitive: {},
    evidenceDir: '',
    goal: scenario.goal,
  };
}

function blockedUncertain(result) {
  const blocked = clone(result);
  blocked.status = 'blocked';
  blocked.reason = 'UNCERTAIN_EFFECT';
  blocked.message = 'Unresolved commitment.';
  blocked.ledger[0].effects = ['toggle', 'account_change'];
  blocked.unresolvedUncertain = [1];
  delete blocked.completion;
  blocked.checkpoint = {
    version: 1,
    id: 'ck_000000000001',
    runId: blocked.runId,
    sessionId: blocked.sessionId,
    createdAt: 2000,
    request: {
      goal: blocked.goal,
      inputs: {},
      inputDeclarations: [],
      sensitivePaths: [],
      authorization: {
        operations: ['SET_CHECKED'],
        origins: ['http://127.0.0.1'],
        grants: [],
        assumeUnclassifiedRoutine: false,
      },
      options: {},
    },
    step: blocked.steps,
    usage: blocked.stats.usage,
    ledger: clone(blocked.ledger),
    history: [],
    startOrigin: 'http://127.0.0.1',
    locationTrust: 'authoritative',
    consumedApprovalIds: [],
    integrity: `sha256:${'0'.repeat(64)}`,
    pending: { kind: 'uncertain_effect', entries: [1] },
  };
  return blocked;
}

const waitUntil = async read => {
  const start = Date.now();
  while (!read()) {
    if (Date.now() - start > 10000) throw new Error('Scripted state did not persist.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
function settingsDriver(page, app) {
  return {
    apply: async changes => {
      for (const [key, value] of Object.entries(changes)) {
        const switcher = page.getByRole('switch', { name: SETTINGS_LABELS.A[key], exact: true });
        if ((await switcher.getAttribute('aria-checked')) !== String(value)) await switcher.click();
        await waitUntil(() => app.state().settings[key] === value);
      }
    },
  };
}
function catalogDriver(page) {
  return {
    apply: async plan => {
      if (plan.q) {
        await page.getByLabel('Search products').fill(plan.q);
        await page.getByLabel('Search products').press('Enter');
        await page.waitForFunction(
          q => new URLSearchParams(location.search).get('q') === q,
          plan.q
        );
      }
      for (const category of plan.category ?? []) {
        assert.equal(
          category,
          'audio',
          'The bounded catalog control only drives the exported audio baseline.'
        );
        await page.getByRole('checkbox', { name: /^Audio/ }).setChecked(true);
        await page.waitForFunction(() =>
          new URLSearchParams(location.search).getAll('category').includes('audio')
        );
      }
      await page.waitForFunction(() =>
        /^Showing \d+ results?/.test(document.querySelector('#results p.count')?.textContent ?? '')
      );
    },
  };
}

const firstLine = error => String(error?.message ?? error).split('\n')[0];
async function rejected(call, pattern) {
  let failure;
  try {
    await call();
  } catch (error) {
    failure = error;
  }
  assert.notEqual(failure, undefined, 'The damaged state/outcome was accepted.');
  assert.match(
    firstLine(failure),
    pattern,
    'The control failed for an unrelated assertion/fixture reason.'
  );
}

export async function runControls({ log = console.log, only } = {}) {
  const records = [];
  const record = async (id, category, check) => {
    try {
      await check();
      records.push({ id, category, ok: true });
      log(`PASS ${id} :: ${category}`);
    } catch (error) {
      records.push({ id, category, ok: false, message: firstLine(error) });
      log(`FAIL ${id} :: ${category}: ${firstLine(error)}`);
    }
  };
  const selected = PLANS.filter(plan => !only || plan[0] === only);
  await record('catalog', 'exact eight fault ids and labels', () => {
    assert.deepEqual(
      scenarios.map(scenario => scenario.id),
      PLANS.map(plan => plan[0])
    );
    for (const plan of PLANS) {
      const scenario = scenarios.find(item => item.id === plan[0]);
      assert.equal(scenario.kind, 'fault');
      assert.equal(scenario.inject[plan[1]].mode, plan[2]);
    }
  });
  await record('catalog', 'all eight scenario contracts validate', () => {
    for (const scenario of scenarios) {
      const result = validateScenario(scenario, {
        apps: { settings: describeSettings(), catalog: describeCatalog() },
      });
      assert.equal(result.ok, true, result.errors.join('; '));
    }
  });
  if (selected.length === 0)
    await record('selection', 'requested scenario exists', () =>
      assert.fail('No fault controls selected.')
    );
  const settingPass = settingsControls().find(
    control =>
      control.scenarioId === BASE_ID && control.kind === 'pass' && control.category === 'pass'
  );
  const catalogPass = catalogGroups().find(group => group.id === `${CATALOG_ID}:achieved`);
  assert.ok(
    settingPass && catalogPass,
    'The independently controlled family baselines must exist.'
  );
  const browser = await launchBrowser({ headless: true });
  try {
    for (const plan of selected) {
      const scenario = scenarios.find(item => item.id === plan[0]);
      const app = await (scenario.family === 'catalog' ? startCatalog : startSettings)({
        variant: scenario.variant,
        initial: scenario.initial,
        faults: scenario.faults,
      });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(app.url);
      const result = synthetic(
        scenario,
        plan,
        catalogPass.verdicts.find(verdict => verdict.kind === 'pass').result
      );
      const proof = faultContext(scenario, plan);
      const afterCommit = ['lostAfterCommit', 'timeoutAfterCommit'].includes(plan[2]);
      const completes = !['invalidTarget', 'slow'].includes(plan[2]);
      try {
        if (completes)
          await record(scenario.id, 'untouched state fails', () =>
            rejected(
              () => scenario.expect(app, result, page, proof),
              /backend:|fault proof: the achieved preferences|backend |URL|url|search term/
            )
          );
        if (completes) {
          const driver =
            scenario.family === 'catalog' ? catalogDriver(page) : settingsDriver(page, app);
          if (scenario.family === 'catalog') await catalogPass.drive(driver, { app, page });
          else await settingPass.run({ driver, app, page, context });
        }
        await record(scenario.id, 'achieved scripted state passes', () =>
          scenario.expect(app, result, page, proof)
        );
        await record(scenario.id, 'wrong status fails', () => {
          const wrong = clone(result);
          wrong.status = completes ? 'failed' : 'completed';
          return rejected(
            () => scenario.expect(app, wrong, page, proof),
            /status:|result\.status|fault proof:/
          );
        });
        await record(scenario.id, 'altered literal goal fails', () => {
          const wrong = clone(result);
          wrong.goal = 'A different caller goal';
          return rejected(
            () => scenario.expect(app, wrong, page, proof),
            /result: result.goal|result\.goal|fault proof:/
          );
        });
        await record(scenario.id, 'omitted injection proof fails', () =>
          rejected(
            () => scenario.expect(app, result, page, { ...proof, faultNotes: [] }),
            /^fault proof: the configured injection must fire exactly once$/
          )
        );
        await record(scenario.id, 'missing recorder context fails', () =>
          rejected(
            () => scenario.expect(app, result, page, { ...proof, faultNotes: undefined }),
            /^fault proof: the actual injection recorder notes must be available$/
          )
        );
        await record(scenario.id, 'duplicate fired proof fails', () =>
          rejected(
            () =>
              scenario.expect(app, result, page, {
                ...proof,
                faultNotes: [...proof.faultNotes, ...proof.faultNotes],
              }),
            /^fault proof: the configured injection must fire exactly once$/
          )
        );
        await record(scenario.id, 'wrong scenario injection proof fails', () =>
          rejected(
            () =>
              scenario.expect(app, result, page, {
                ...proof,
                faultNotes: [{ ...proof.faultNotes[0], scenarioId: 'fault-another' }],
              }),
            /^fault proof: the fired note/
          )
        );
        await record(scenario.id, 'live-labelled fault proof fails', () =>
          rejected(
            () =>
              scenario.expect(app, result, page, {
                ...proof,
                faultNotes: [{ ...proof.faultNotes[0], live: true }],
              }),
            /^fault proof: the fired note/
          )
        );
        await record(scenario.id, 'wrong backend state fails', () => {
          const seen = {
            ...app,
            state: () => {
              const current = app.state();
              return scenario.family === 'catalog'
                ? { ...current, searches: [] }
                : {
                    ...current,
                    settings: { ...current.settings, promotional: completes },
                    writes: completes
                      ? current.writes
                      : [{ key: 'promotional', from: true, to: false }],
                  };
            },
          };
          return rejected(
            () => scenario.expect(seen, result, page, proof),
            /backend:|backend |fault proof:/
          );
        });
        if (!completes) {
          await record(scenario.id, 'wrong effect fails', () => {
            const wrong = clone(result);
            wrong.lastEffect = 'applied';
            return rejected(() => scenario.expect(app, wrong, page, proof), /^fault proof:/);
          });
          await record(scenario.id, 'unresolved effect on a no-action result fails', () => {
            const wrong = clone(result);
            wrong.unresolvedUncertain = [1];
            return rejected(() => scenario.expect(app, wrong, page, proof), /^fault proof:/);
          });
        }
        if (plan[2] === 'prematureDone' || plan[2] === 'invalidArgument')
          await record(scenario.id, 'omitted trace proof fails', () =>
            rejected(
              () => scenario.expect(app, result, page, { ...proof, trace: [] }),
              /^fault proof:/
            )
          );
        if (plan[2] === 'staleBeforeExecute')
          await record(scenario.id, 'omitted stale rejection fails', () => {
            const wrong = clone(result);
            wrong.ledger = wrong.ledger.filter(item => item.status !== 'rejected_stale');
            return rejected(() => scenario.expect(app, wrong, page, proof), /^fault proof:/);
          });
        if (plan[2] === 'contextDestroyed') {
          await record(scenario.id, 'one document only fails', () => {
            const wrong = clone(result);
            for (const item of wrong.ledger) item.scope.documentId = scope.documentId;
            wrong.completion.verifiedSnapshot.documentId = scope.documentId;
            return rejected(() => scenario.expect(app, wrong, page, proof), /^fault proof:/);
          });
          await record(
            scenario.id,
            'fresh replacement gate observation needs no extra command',
            () => {
              const good = clone(result);
              for (const item of good.ledger) item.scope.documentId = scope.documentId;
              return scenario.expect(app, good, page, proof);
            }
          );
          await record(scenario.id, 'reload after execution is not a during-execution fault', () =>
            rejected(
              () =>
                scenario.expect(app, result, page, {
                  ...proof,
                  faultNotes: [{ ...proof.faultNotes[0], navigationPhase: 'after_execute' }],
                }),
              /^fault proof:/
            )
          );
        }
        if (afterCommit || plan[2] === 'staleBeforeExecute') {
          await record(scenario.id, 'injection ordinal must match its affected ledger entry', () =>
            rejected(
              () =>
                scenario.expect(app, result, page, {
                  ...proof,
                  faultNotes: [{ ...proof.faultNotes[0], execution: 2 }],
                }),
              /^fault proof:/
            )
          );
        }
        if (afterCommit) {
          await record(scenario.id, 'commitment blocks with checkpoint and achieved state', () =>
            scenario.expect(app, blockedUncertain(result), page, proof)
          );
          await record(scenario.id, 'no-commit injection cannot masquerade as after-commit', () =>
            rejected(
              () =>
                scenario.expect(app, result, page, {
                  ...proof,
                  faultNotes: [{ ...proof.faultNotes[0], realEffect: 'none' }],
                }),
              /^fault proof:/
            )
          );
          for (const [name, damage] of [
            [
              'uncertain entry omitted',
              wrong => {
                wrong.ledger = [];
              },
            ],
            [
              'unresolved effect accepted',
              wrong => {
                wrong.unresolvedUncertain = [1];
              },
            ],
            [
              'resolution omitted',
              wrong => {
                wrong.completion.resolvedUncertain = [];
              },
            ],
            [
              'resolution inferred only from transition',
              wrong => {
                wrong.completion.resolvedUncertain[0].by = 'transition';
              },
            ],
            [
              'observed postcondition omitted',
              wrong => {
                wrong.completion.postconditions = [];
              },
            ],
            [
              'fresh snapshot omitted',
              wrong => {
                wrong.completion.verifiedSnapshot.snapshotId = wrong.ledger[0].scope.snapshotId;
              },
            ],
            [
              'independent evidence omitted',
              wrong => {
                wrong.completion.evidence = [];
              },
            ],
            [
              'uncertain digest retried',
              wrong => {
                wrong.ledger.push({
                  ...clone(wrong.ledger[0]),
                  seq: 2,
                  status: 'applied',
                  effect: 'applied',
                });
              },
            ],
          ])
            await record(scenario.id, `${name} fails`, () => {
              const wrong = clone(result);
              damage(wrong);
              return rejected(() => scenario.expect(app, wrong, page, proof), /^fault proof:/);
            });
          await record(scenario.id, 'blocked uncertain outcome without checkpoint fails', () => {
            const wrong = blockedUncertain(result);
            delete wrong.checkpoint;
            return rejected(() => scenario.expect(app, wrong, page, proof), /^fault proof:/);
          });
        }
      } finally {
        await context.close();
        await app.close();
      }
    }
  } finally {
    await browser.close();
  }
  const coverage = selected.map(plan => ({
    id: plan[0],
    records: records.filter(record => record.id === plan[0]).length,
    pass: records.some(
      record =>
        record.id === plan[0] && record.category === 'achieved scripted state passes' && record.ok
    ),
    missingProofFails: records.some(
      record =>
        record.id === plan[0] && record.category === 'omitted injection proof fails' && record.ok
    ),
  }));
  await record(
    'coverage',
    'every selected fault has a positive and no-proof negative control',
    () =>
      assert.ok(
        coverage.length > 0 &&
          coverage.every(item => item.pass && item.missingProofFails && item.records >= 10)
      )
  );
  const summary = {
    total: records.length,
    passed: records.filter(record => record.ok).length,
    failed: records.filter(record => !record.ok),
    scenarios: coverage.length,
    coverage,
  };
  log(
    `fault controls: ${summary.passed}/${summary.total} passed, ${summary.failed.length} failed; scenarios covered ${coverage.filter(item => item.pass && item.missingProofFails).length}/${coverage.length}`
  );
  return summary;
}

if (
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const onlyAt = process.argv.indexOf('--only');
  runControls({ only: onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined }).then(
    summary => {
      process.exit(
        summary.total > 0 && summary.failed.length === 0 && summary.scenarios > 0 ? 0 : 1
      );
    },
    error => {
      console.error(`FAIL fault controls: ${firstLine(error)}`);
      process.exit(1);
    }
  );
}
