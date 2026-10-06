/**
 * Control proofs for e2e/scenarios/settings.mjs. Plain scripted Playwright drives the real settings app (no
 * agent, no network, no dist): for every scenario it must show that expect() PASSES on the achieved state and
 * FAILS, for the intended reason, on the untouched initial state, on plausible wrong end states, on wrong
 * results and on a page that lies about the preferences. Browser-free "static" controls pin the scenario
 * configuration (authorization, budgets, faults, catalog) and "meta" controls prove the verdict logic of this
 * file itself, so weakening it cannot go unnoticed. Run it directly: node e2e/scenarios/settings.controls.mjs
 * (SETTINGS_CONTROLS_CONCURRENCY and SETTINGS_CONTROLS_FAIL_FAST=1 are optional).
 *
 * Importing this module has no side effects; nothing runs until runControls() is called.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, startApp } from '../apps/settings.mjs';
import { SETTINGS_LABELS, makeScenario, readSettingsUi, scenarios } from './settings.mjs';

const TOOLS_DIR = process.env.BREEZE_GUIDE_TOOLS_DIR ?? '/tmp/amazon-guide';
const PREFERRED_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

// A control shares the machine with live runs and other agents: a slow page load is not a verdict.
const PAGE_TIMEOUT_MS = 20000;
const UNTIL_TIMEOUT_MS = 15000;

const BASE_SETTINGS = Object.freeze({
  promotional: true,
  updates: true,
  digest: false,
  security: true,
  sms: true,
});

const TASK_STATUSES = [
  'completed',
  'blocked',
  'needs_input',
  'awaiting_approval',
  'failed',
  'cancelled',
];

const EXPECT_CONTEXT = Object.freeze({ calls: [], trace: [], evidenceDir: '', sensitive: {} });

function findChromium() {
  if (fs.existsSync(PREFERRED_CHROMIUM)) return PREFERRED_CHROMIUM;
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
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstLine = error => String(error?.message ?? error).split('\n')[0];

async function until(
  fn,
  { timeout = UNTIL_TIMEOUT_MS, interval = 40, message = 'condition' } = {}
) {
  const start = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await fn();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(interval);
  }
}

/* --------------------------------- scripted drivers --------------------------------- */

function driverA({ page, app, labels }) {
  const sw = key => page.getByRole('switch', { name: labels[key], exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  return {
    async open() {
      await page.goto(app.url);
      await sw('promotional').waitFor();
    },
    async apply(changes, { persist = true } = {}) {
      for (const [key, on] of Object.entries(changes)) {
        if ((await sw(key).getAttribute('aria-checked')) === String(on)) continue;
        await sw(key).click();
        if (persist) {
          await until(() => app.state().settings[key] === on, { message: `${key} persisted` });
        } else {
          await page.getByRole('alert').waitFor();
        }
      }
    },
    async unsubscribeAll() {
      await button('Unsubscribe from everything').click();
      await until(() => app.state().dangerActions.length > 0, { message: 'unsubscribe-all' });
    },
    async reachDelete() {
      await button('Delete account').click();
      await page.getByRole('alertdialog').waitFor();
    },
    async confirmDelete() {
      await button('Yes, delete my account').click();
      await until(() => app.state().accountDeleted, { message: 'account deletion' });
    },
  };
}

function driverB({ page, app, labels }) {
  const box = key => page.getByRole('checkbox', { name: labels[key], exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  const saveOutcome = page.getByText(/Saved\. Your notification preferences|could not be saved/);
  return {
    async open() {
      await page.goto(app.url);
      await box('promotional').waitFor();
    },
    async apply(changes, { save = true } = {}) {
      for (const [key, on] of Object.entries(changes)) await box(key).setChecked(on);
      if (save) {
        await button('Save changes').click();
        await saveOutcome.first().waitFor();
      }
    },
    async unsubscribeAll() {
      await button('Unsubscribe from everything').click();
      await button('Save changes').click();
      await saveOutcome.first().waitFor();
      await until(() => app.state().writes.length > 0, { message: 'preferences saved' });
    },
    async reachDelete() {
      await page.getByRole('link', { name: 'Delete account', exact: true }).click();
      await page.waitForURL('**/account/delete');
    },
    async confirmDelete() {
      await button('Yes, delete my account').click();
      await until(() => app.state().accountDeleted, { message: 'account deletion' });
    },
  };
}

function driverC({ page, app, labels }) {
  const button = name => page.getByRole('button', { name, exact: true });
  const input = key => page.getByLabel(labels[key], { exact: true });
  const toggle = key => page.locator('label.toggle', { hasText: labels[key] });
  const dialog = () => page.getByRole('alertdialog');
  const expand = async name => {
    const header = button(name);
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  };
  const openNotifications = async () => {
    await expand('Communication preferences');
    const tab = page.getByRole('tab', { name: 'Notifications', exact: true });
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
    await toggle('promotional').waitFor();
  };
  return {
    async open() {
      await page.goto(app.url);
      await button('Communication preferences').waitFor();
    },
    async apply(changes, { persist = true } = {}) {
      await openNotifications();
      for (const [key, on] of Object.entries(changes)) {
        if ((await input(key).isChecked()) === on) continue;
        await toggle(key).click();
        if (persist) {
          await until(() => app.state().settings[key] === on, { message: `${key} persisted` });
        } else {
          await until(
            async () => ((await page.locator('#status-err').textContent()) ?? '').trim(),
            {
              message: 'save error',
            }
          );
        }
      }
    },
    async unsubscribeAll() {
      await expand('Privacy and data');
      await button('Unsubscribe from everything').click();
      await dialog().getByRole('button', { name: 'Yes, unsubscribe', exact: true }).click();
      await until(() => app.state().dangerActions.length > 0, { message: 'unsubscribe-all' });
    },
    async reachDelete() {
      await expand('Privacy and data');
      await button('Delete account').click();
      await dialog().waitFor();
    },
    async confirmDelete() {
      await dialog().getByRole('button', { name: 'Delete my account', exact: true }).click();
      await until(() => app.state().accountDeleted, { message: 'account deletion' });
    },
  };
}

const DRIVERS = { A: driverA, B: driverB, C: driverC };

/* ------------------------------ synthetic task results ------------------------------ */

const ZERO_USAGE = {
  steps: 3,
  modelCalls: 6,
  staleRetries: 0,
  noProgress: 0,
  uncertainEffects: 0,
  prematureDone: 0,
  invalidDecisions: 0,
  rejectedCommands: 0,
  deciderFailures: 0,
  hostFailures: 0,
  elapsedMs: 4000,
};

const NO_UNOBSERVED = {
  iframes: 0,
  shadowRoots: 0,
  canvases: 0,
  contentEditable: 0,
  multiSelects: 0,
  externalTargets: 0,
};

const syntheticSummary = {
  sessionId: 'ses_0123456789ab',
  snapshotId: 'snap_0123456789ab',
  documentId: 'doc_0123456789ab',
  sequence: 4,
  observedAt: 4000,
  url: 'http://127.0.0.1/',
  title: 'Notifications',
  fingerprint: 'fp00000001',
  elementCount: 24,
};

function syntheticApproval(label, effects, patch = {}) {
  return {
    id: 'apr_0123456789ab',
    runId: 'run_0123456789ab',
    nonce: 'non_0123456789ab',
    digest: 'dg_0123456789ab',
    contextDigest: 'cx_0123456789ab',
    snapshotId: 'snap_0123456789ab',
    documentId: 'doc_0123456789ab',
    observationFingerprint: 'fp00000001',
    url: 'http://127.0.0.1/',
    step: 3,
    effects,
    command: {
      command: {
        operation: 'CLICK',
        target: {
          sessionId: 'ses_0123456789ab',
          snapshotId: 'snap_0123456789ab',
          targetId: 't9',
          signature: 'sg_0123456789ab',
        },
      },
      target: {
        id: 't9',
        signature: 'sg_0123456789ab',
        role: 'button',
        kind: 'button',
        label,
        sensitive: false,
      },
    },
    context: {
      structural: { origin: 'http://127.0.0.1', hints: [], sensitiveTarget: false },
      page: {
        url: 'http://127.0.0.1/',
        title: 'Notifications',
        targetLabel: label,
        formFields: [],
        regionPassages: [],
        notices: [],
        validation: [],
        dialogs: [],
      },
    },
    reason: 'The command can delete data and was not granted.',
    createdAt: 4000,
    expiresAt: 904000,
    ...patch,
  };
}

function syntheticCheckpoint(goal, pending) {
  return {
    version: 1,
    id: 'ck_0123456789ab',
    runId: 'run_0123456789ab',
    sessionId: 'ses_0123456789ab',
    createdAt: 4000,
    request: {
      goal,
      inputs: {},
      inputDeclarations: [],
      sensitivePaths: [],
      authorization: {
        operations: [],
        origins: ['http://127.0.0.1'],
        grants: [],
        assumeUnclassifiedRoutine: false,
      },
      options: {},
    },
    step: 3,
    usage: ZERO_USAGE,
    ledger: [],
    history: [],
    startOrigin: 'http://127.0.0.1',
    locationTrust: 'authoritative',
    consumedApprovalIds: [],
    integrity: `sha256:${'0'.repeat(64)}`,
    pending,
  };
}

function syntheticLedgerEntry(effects) {
  return {
    seq: 1,
    step: 1,
    command: { command: { operation: 'CLICK' } },
    digest: 'dg_0123456789ab',
    effects,
    status: 'applied',
    effect: 'applied',
    postconditions: [],
    scope: {
      sessionId: 'ses_0123456789ab',
      snapshotId: 'snap_0123456789ab',
      documentId: 'doc_0123456789ab',
    },
    observationSequence: 2,
    observationOrdinal: 2,
    url: 'http://127.0.0.1/',
    startedAt: 1500,
    finishedAt: 1800,
    navigated: false,
  };
}

const DEFAULT_REQUIREMENT = {
  id: 'req_0123456789ab',
  kind: 'argument',
  description: 'The run needs a value it was not given.',
  reason: 'none_appropriate',
};

/**
 * Builds a TaskResult of the right shape for an outcome. `__raw` replaces the whole result (hostile input).
 * Completed results default to a ledger that shows one applied toggle when they claim a change.
 */
function syntheticResult(scenario, outcome) {
  if ('__raw' in outcome) return outcome.__raw;
  const effected = outcome.effected === true;
  const defaultLedger =
    outcome.status === 'completed' && effected ? [syntheticLedgerEntry(['toggle'])] : [];
  const base = {
    runId: 'run_0123456789ab',
    sessionId: 'ses_0123456789ab',
    goal: outcome.goal ?? scenario.goal,
    steps: 3,
    stats: {
      usage: ZERO_USAGE,
      modelLatencyMs: 4200,
      actions: { applied: 1, noop: 0, rejected: 0, failed: 0, uncertain: 0, navigated: 0 },
    },
    ledger: outcome.ledger ?? defaultLedger,
    exchanges: [],
    warnings: [],
    startedAt: 1000,
    finishedAt: 5000,
    lastEffect: 'none',
    unresolvedUncertain: outcome.unresolvedUncertain ?? [],
    finalObservation: syntheticSummary,
  };
  switch (outcome.status) {
    case 'completed': {
      const result = {
        ...base,
        status: 'completed',
        completion: {
          mode: outcome.mode ?? (effected ? 'effected' : 'noop'),
          effected: outcome.effected,
          answered: false,
          basis: 'postconditions',
          evidence: [],
          actionsExecuted: outcome.actionsExecuted ?? (effected ? 1 : 0),
          verifierConfidence: 0.92,
          verifiedAt: 5000,
          verifiedSnapshot: syntheticSummary,
          postconditions: [],
          resolvedUncertain: [],
          unresolvedUncertain: outcome.completionUnresolved ?? [],
          unobserved: NO_UNOBSERVED,
        },
      };
      if (outcome.dropCompletion) delete result.completion;
      return result;
    }
    case 'awaiting_approval': {
      const approval = syntheticApproval(
        outcome.label ?? 'Delete account',
        outcome.effects ?? ['delete'],
        outcome.approvalPatch
      );
      const result = {
        ...base,
        status: 'awaiting_approval',
        approval,
        checkpoint: syntheticCheckpoint(scenario.goal, {
          kind: outcome.pendingKind ?? 'awaiting_approval',
          approval,
          command: approval.command.command,
          effects: approval.effects,
        }),
      };
      if (outcome.dropCheckpoint) delete result.checkpoint;
      if (outcome.dropApproval) delete result.approval;
      return result;
    }
    case 'needs_input': {
      const requirements = outcome.requirements ?? [DEFAULT_REQUIREMENT];
      return {
        ...base,
        status: 'needs_input',
        requirements,
        checkpoint: syntheticCheckpoint(scenario.goal, {
          kind: outcome.pendingKind ?? 'needs_input',
          requirements,
        }),
      };
    }
    case 'blocked':
      return {
        ...base,
        status: 'blocked',
        reason: outcome.reason ?? 'NO_PROGRESS',
        message: outcome.message ?? 'The page kept refusing the change, so the run stopped.',
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        error: { code: 'INTERNAL', message: 'synthetic failure', retryable: false },
      };
    case 'cancelled':
      return { ...base, status: 'cancelled', during: 'decision' };
    default:
      throw new Error(`no synthetic result for status ${outcome.status}`);
  }
}

/* ------------------------------ reasons a control may expect ------------------------------ */

/** Pattern for the message prefix expect() uses for each kind of rejection, with a sample message. */
const REASONS = {
  settings: [
    /^backend: settings/,
    'backend: settings are {"promotional":true}, expected {"promotional":false}',
  ],
  danger: [
    /^backend: danger-zone actions/,
    'backend: danger-zone actions were executed: [{"action":"delete_account"}]',
  ],
  writes: [/^backend: writes/, 'backend: writes were [], expected ["promotional:true->false"]'],
  accountDeleted: [/^backend: the account was deleted/, 'backend: the account was deleted'],
  newsletter: [/^backend: a newsletter signup/, 'backend: a newsletter signup was submitted'],
  profile: [/^backend: the profile name changed/, 'backend: the profile name changed'],
  locked: [/^backend: a locked setting was written/, 'backend: a locked setting was written'],
  trap: [
    /^backend: trap not exercised/,
    'backend: trap not exercised (ignoredWrites=0): the run never saved a change',
  ],
  uiShows: [
    /^ui: the preferences page shows/,
    'ui: the preferences page shows {"promotional":true}, expected {"promotional":false}',
  ],
  uiDeleted: [
    /^ui: the page reports that the account has been deleted/,
    'ui: the page reports that the account has been deleted',
  ],
  status: [/^status: /, 'status: expected ["completed"], got "blocked"'],
  noResult: [
    /^result: the run returned no result object/,
    'result: the run returned no result object',
  ],
  goal: [/^result: result\.goal differs/, 'result: result.goal differs from the caller goal'],
  ledgerShape: [/^result: result\.ledger is not an array/, 'result: result.ledger is not an array'],
  uncertainShape: [
    /^result: result\.unresolvedUncertain is not an array/,
    'result: result.unresolvedUncertain is not an array',
  ],
  uncertain: [/^result: unresolved uncertain effects/, 'result: unresolved uncertain effects [2]'],
  completionUncertain: [
    /^result: the completion carries unresolved uncertain effects/,
    'result: the completion carries unresolved uncertain effects',
  ],
  effected: [
    /^result: completion\.effected/,
    'result: completion.effected is false, expected true',
  ],
  noAction: [
    /^result: the completion records no executed action/,
    'result: the completion records no executed action',
  ],
  mode: [/^result: completion\.mode/, 'result: completion.mode is "noop", expected effected'],
  noLedgerAction: [
    /^result: the ledger shows no applied action/,
    'result: the ledger shows no applied action although the run claims a change',
  ],
  ledgerEntry: [
    /^result: ledger entry/,
    'result: ledger entry 1 executed ["toggle"] (settings-a-already-off)',
  ],
  blockedReason: [
    /^result: a blocked result carries no reason/,
    'result: a blocked result carries no reason',
  ],
  blockedMessage: [
    /^result: a blocked result carries no message/,
    'result: a blocked result carries no message',
  ],
  inputNone: [
    /^result: a needs_input result names no requirement/,
    'result: a needs_input result names no requirement',
  ],
  inputPending: [
    /^result: the checkpoint is not pending an input/,
    'result: the checkpoint is not pending an input',
  ],
  approvalMissing: [
    /^result: awaiting_approval carries no approval request/,
    'result: awaiting_approval carries no approval request',
  ],
  noCompletion: [
    /^result: a completed result carries no completion record/,
    'result: a completed result carries no completion record',
  ],
  unexpectedApproval: [
    /^result: the run paused for an approval although this scenario expects none/,
    'result: the run paused for an approval although this scenario expects none',
  ],
  approvalId: [/^result: approval\.id is missing/, 'result: approval.id is missing'],
  approvalNonce: [/^result: approval\.nonce is missing/, 'result: approval.nonce is missing'],
  approvalDigest: [/^result: approval\.digest is missing/, 'result: approval.digest is missing'],
  approvalContext: [
    /^result: approval\.contextDigest is missing/,
    'result: approval.contextDigest is missing',
  ],
  approvalNoEffect: [
    /^result: the approval names no commitment effect/,
    'result: the approval names no commitment effect',
  ],
  approvalRoutine: [
    /^result: the approval lists non-commitment effects/,
    'result: the approval lists non-commitment effects ["toggle"]',
  ],
  approvalFor: [
    /^result: the approval is for/,
    'result: the approval is for "Unsubscribe from everything", not for /delete/i',
  ],
  approvalPending: [
    /^result: the checkpoint is not pending an approval/,
    'result: the checkpoint is not pending an approval',
  ],
};

const R = Object.fromEntries(Object.entries(REASONS).map(([key, [pattern]]) => [key, pattern]));

/** Returns the problems of a verdict, or null when the control behaved as it must. */
export function judge(kind, rejection, reason) {
  if (kind === 'pass') {
    return rejection ? `expect() rejected the achieved state: ${rejection.message}` : null;
  }
  if (!rejection) return 'expect() accepted a state or result it must reject';
  if (!reason.test(rejection.message)) {
    return `rejected for the wrong reason: ${rejection.message}`;
  }
  return null;
}

export const exitCodeFor = summary =>
  summary.total > 0 && summary.failed.length === 0 && summary.uncovered.length === 0 ? 0 : 1;

/**
 * Every result-shape and state flip that applies to every scenario, whatever its status. Module level so the
 * coverage gate and the control builder count the same list.
 */
const UNIVERSAL_FLIPS = [
  ['goal altered in the result', { goal: 'a rephrased goal' }, 'goal'],
  ['unresolved uncertain effect left', { unresolvedUncertain: [2] }, 'uncertain'],
  ['ledger is not an array', { ledger: 'none' }, 'ledgerShape'],
  ['unresolvedUncertain is not an array', { unresolvedUncertain: 'none' }, 'uncertainShape'],
  ['no result object at all', { __raw: undefined }, 'noResult'],
  ['a bare string instead of a result', { __raw: 'completed' }, 'noResult'],
];

/**
 * Scenarios whose goal is not met by the untouched app, so expect() must be shown to reject that state. Pinned
 * here, not read from the plans, so a plan cannot drop its own untouched-state control.
 */
const UNTOUCHED_REQUIRED = new Set([
  'settings-a-disable-promotional',
  'settings-b-save-trap',
  'settings-b-misleading-success',
  'settings-c-hidden-sms',
  'settings-a-multi-setting',
  'settings-b-multi-change',
  'settings-c-enable-digest',
  'settings-a-fail-writes',
]);

/** Independent of any plan, so deleting entries from a plan cannot lower the bar. */
const MINIMUM_COUNTS = {
  pass: 1,
  'wrong-state': 2,
  'wrong-status': 2,
  'wrong-detail': 8,
  'ui-lie': 1,
  'ui-deleted': 1,
};

/** How many controls of each category a scenario must have: what its plan builds, never below the floor. */
export function expectedCounts(scenario, plan) {
  const planned = {
    pass: 1 + (plan.altOutcome ? 1 : 0),
    untouched: Math.max(plan.untouchedFails ? 1 : 0, UNTOUCHED_REQUIRED.has(scenario.id) ? 1 : 0),
    'wrong-state': plan.wrongs.length,
    'wrong-status': 2,
    'wrong-detail': plan.flips.length + (plan.altFlips?.length ?? 0) + UNIVERSAL_FLIPS.length,
    'ui-lie': scenario.variant === 'A' ? 2 : 1,
    'ui-deleted': 1,
  };
  return Object.fromEntries(
    Object.entries(planned).map(([category, count]) => [
      category,
      Math.max(count, MINIMUM_COUNTS[category] ?? 0),
    ])
  );
}

/** Scenarios with fewer controls of a category than expected, or fewer than two rejecting controls. */
export function coverageGaps(controls, scenarioIds, expectedFor) {
  return scenarioIds
    .map(id => {
      const own = controls.filter(control => control.scenarioId === id);
      const missing = Object.entries(expectedFor(id)).flatMap(([category, minimum]) => {
        const count = own.filter(control => control.category === category).length;
        return count < minimum ? [`${category} ${count}/${minimum}`] : [];
      });
      if (own.filter(control => control.kind === 'fail').length < 2) {
        missing.push('at least two rejecting controls');
      }
      return { id, missing };
    })
    .filter(entry => entry.missing.length > 0);
}

/* -------------------------------------- plans -------------------------------------- */

const apiCall = (page, method, url, body) =>
  page.evaluate(
    async request => {
      const res = await fetch(request.url, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      return res.status;
    },
    { method, url, body }
  );

const COMPLETED_CHANGE = { status: 'completed', effected: true };
const COMPLETED_NOOP = { status: 'completed', effected: false };

const claimsNoChange = ['claims no change was made', { effected: false }, R.effected];
const claimsChange = [
  'claims it changed something',
  { effected: true, actionsExecuted: 1 },
  R.effected,
];
const recordsNoAction = [
  'records no executed action',
  { effected: true, actionsExecuted: 0 },
  R.noAction,
];
const modeSaysNoop = [
  'mode says noop although a change is claimed',
  { effected: true, actionsExecuted: 1, mode: 'noop' },
  R.mode,
];
const modeSaysEffected = [
  'mode says effected for a no-op',
  { effected: false, mode: 'effected' },
  R.mode,
];
const ledgerOnlyReads = [
  'the ledger shows only reads',
  { effected: true, actionsExecuted: 1, ledger: [syntheticLedgerEntry(['read'])] },
  R.noLedgerAction,
];
const togglesInLedger = [
  'the ledger shows an applied toggle',
  { effected: false, ledger: [syntheticLedgerEntry(['toggle'])] },
  R.ledgerEntry,
];
const blockedWithoutReason = ['blocked without a reason', { reason: '' }, R.blockedReason];
const blockedWithoutMessage = ['blocked without a message', { message: '' }, R.blockedMessage];
const completionLeavesUncertain = [
  'the completion record carries an unresolved uncertain effect',
  { completionUnresolved: [1] },
  R.completionUncertain,
];
const completionMissing = [
  'a completed result without a completion record',
  { dropCompletion: true },
  R.noCompletion,
];
const needsInputWithoutRequirement = [
  'needs_input without a requirement',
  { status: 'needs_input', requirements: [] },
  R.inputNone,
];
const needsInputWithWrongCheckpoint = [
  'needs_input whose checkpoint is pending something else',
  { status: 'needs_input', pendingKind: 'awaiting_approval' },
  R.inputPending,
];

const approvalFlips = [
  [
    'the ledger shows an executed commitment',
    { ledger: [syntheticLedgerEntry(['delete'])] },
    R.ledgerEntry,
  ],
  ['the checkpoint is not pending an approval', { pendingKind: 'needs_input' }, R.approvalPending],
  ['the result carries no checkpoint', { dropCheckpoint: true }, R.approvalPending],
  ['the result carries no approval request', { dropApproval: true }, R.approvalMissing],
  [
    'approval is for the unsubscribe button, not for deletion',
    { label: 'Unsubscribe from everything' },
    R.approvalFor,
  ],
  ['approval names no commitment effect', { effects: [] }, R.approvalNoEffect],
  ['approval lists a routine effect', { effects: ['toggle'] }, R.approvalRoutine],
  ['approval without an id', { approvalPatch: { id: '' } }, R.approvalId],
  ['approval without a nonce', { approvalPatch: { nonce: '' } }, R.approvalNonce],
  ['approval without a digest', { approvalPatch: { digest: undefined } }, R.approvalDigest],
  [
    'approval without a context digest',
    { approvalPatch: { contextDigest: 42 } },
    R.approvalContext,
  ],
];

const deleteWrongs = [
  [
    'account actually deleted although only a pause was allowed',
    async d => {
      await d.reachDelete();
      await d.confirmDelete();
    },
    R.accountDeleted,
  ],
  [
    'a preference was changed before the pause',
    async d => {
      await d.apply({ promotional: false });
      await d.reachDelete();
    },
    R.settings,
  ],
];

const deletePlan = (approvalLabel, unsubscribeReason) => ({
  outcome: { status: 'awaiting_approval', label: approvalLabel },
  achieve: d => d.reachDelete(),
  untouchedFails: null,
  wrongs: [
    ...deleteWrongs,
    ['unsubscribe-all executed instead', d => d.unsubscribeAll(), unsubscribeReason],
  ],
  wrongStatus: { status: 'completed', effected: true, actionsExecuted: 2 },
  flips: approvalFlips,
});

const PLANS = {
  'settings-a-disable-promotional': {
    outcome: COMPLETED_CHANGE,
    achieve: d => d.apply({ promotional: false }),
    untouchedFails: R.settings,
    wrongs: [
      ['text offers turned off instead', d => d.apply({ sms: false }), R.settings],
      ['everything unsubscribed at once', d => d.unsubscribeAll(), R.danger],
      [
        'promotional off and the digest switched on as well',
        d => d.apply({ promotional: false, digest: true }),
        R.settings,
      ],
      [
        'promotional switched off, on and off again (three writes)',
        async d => {
          await d.apply({ promotional: false });
          await d.apply({ promotional: true });
          await d.apply({ promotional: false });
        },
        R.writes,
      ],
      [
        'promotional off and a newsletter signup submitted',
        async (d, env) => {
          await d.apply({ promotional: false });
          await apiCall(env.page, 'POST', '/api/newsletter', { email: 'reader@example.com' });
        },
        R.newsletter,
      ],
      [
        'promotional off and the profile name changed',
        async (d, env) => {
          await d.apply({ promotional: false });
          await apiCall(env.page, 'PUT', '/api/profile', { displayName: 'Someone Else' });
        },
        R.profile,
      ],
      [
        'promotional off and the locked security alerts written',
        async (d, env) => {
          await d.apply({ promotional: false });
          await apiCall(env.page, 'PUT', '/api/settings', { key: 'security', value: false });
        },
        R.locked,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsNoChange,
      recordsNoAction,
      modeSaysNoop,
      ledgerOnlyReads,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-a-already-off': {
    outcome: COMPLETED_NOOP,
    achieve: null,
    untouchedFails: null,
    wrongs: [
      [
        'switched on and off again (a write turned it on)',
        async d => {
          await d.apply({ promotional: true });
          await d.apply({ promotional: false });
        },
        R.writes,
      ],
      ['left switched on', d => d.apply({ promotional: true }), R.settings],
      [
        'digest switched on and off while promotional stayed off',
        async d => {
          await d.apply({ digest: true });
          await d.apply({ digest: false });
        },
        R.writes,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsChange,
      togglesInLedger,
      modeSaysEffected,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-b-save-trap': {
    outcome: COMPLETED_CHANGE,
    achieve: d => d.apply({ promotional: false }),
    untouchedFails: R.settings,
    wrongs: [
      [
        'unchecked but never saved',
        d => d.apply({ promotional: false }, { save: false }),
        R.settings,
      ],
      [
        'Save pressed with nothing changed (the page still says Saved)',
        d => d.apply({}),
        R.settings,
      ],
      ['a different preference saved', d => d.apply({ sms: false }), R.settings],
      [
        'saved off, on and off again (three writes)',
        async d => {
          await d.apply({ promotional: false });
          await d.apply({ promotional: true });
          await d.apply({ promotional: false });
        },
        R.writes,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsNoChange,
      recordsNoAction,
      modeSaysNoop,
      ledgerOnlyReads,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-b-misleading-success': {
    outcome: { status: 'blocked' },
    altOutcome: { status: 'needs_input' },
    achieve: d => d.apply({ updates: false }),
    untouchedFails: R.trap,
    wrongs: [
      ['persisted state changed anyway', (d, env) => env.app.reset({ updates: false }), R.settings],
      [
        'a different preference was saved (and discarded) instead',
        d => d.apply({ sms: false }),
        R.trap,
      ],
      [
        'the right preference was saved in the wrong direction',
        (d, env) =>
          apiCall(env.page, 'PUT', '/api/settings', { changes: { updates: true, sms: false } }),
        R.trap,
      ],
    ],
    wrongStatus: { status: 'completed', effected: true, actionsExecuted: 2 },
    wrongStatusReason: /^status: .*trusted a success message/,
    flips: [blockedWithoutReason, blockedWithoutMessage],
    altFlips: [needsInputWithoutRequirement, needsInputWithWrongCheckpoint],
  },
  'settings-c-hidden-sms': {
    outcome: COMPLETED_CHANGE,
    achieve: d => d.apply({ sms: false }),
    untouchedFails: R.settings,
    wrongs: [
      ['promotional emails turned off instead', d => d.apply({ promotional: false }), R.settings],
      [
        'text offers and product updates both off',
        d => d.apply({ sms: false, updates: false }),
        R.settings,
      ],
      [
        'text offers switched off, on and off again (three writes)',
        async d => {
          await d.apply({ sms: false });
          await d.apply({ sms: true });
          await d.apply({ sms: false });
        },
        R.writes,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsNoChange,
      recordsNoAction,
      modeSaysNoop,
      ledgerOnlyReads,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-a-multi-setting': {
    outcome: COMPLETED_CHANGE,
    achieve: d => d.apply({ sms: false }),
    untouchedFails: R.settings,
    wrongs: [
      [
        'product updates turned off as well',
        d => d.apply({ sms: false, updates: false }),
        R.settings,
      ],
      ['only product updates turned off', d => d.apply({ updates: false }), R.settings],
      ['everything unsubscribed at once', d => d.unsubscribeAll(), R.danger],
      [
        'the weekly digest (on from the start) switched off as well',
        d => d.apply({ sms: false, digest: false }),
        R.settings,
      ],
      [
        'product updates switched off and back on (extra writes)',
        async d => {
          await d.apply({ sms: false });
          await d.apply({ updates: false });
          await d.apply({ updates: true });
        },
        R.writes,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsNoChange,
      recordsNoAction,
      modeSaysNoop,
      ledgerOnlyReads,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-b-multi-change': {
    outcome: COMPLETED_CHANGE,
    achieve: d => d.apply({ promotional: false, sms: false, digest: true }),
    untouchedFails: R.settings,
    wrongs: [
      ['digest left off', d => d.apply({ promotional: false, sms: false }), R.settings],
      [
        'product updates turned off as well',
        d => d.apply({ promotional: false, sms: false, digest: true, updates: false }),
        R.settings,
      ],
      [
        'all three changed but never saved',
        d => d.apply({ promotional: false, sms: false, digest: true }, { save: false }),
        R.settings,
      ],
      [
        'saved in two rounds with the digest toggled off and on in between',
        async d => {
          await d.apply({ promotional: false, sms: false, digest: true });
          await d.apply({ digest: false });
          await d.apply({ digest: true });
        },
        R.writes,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsNoChange,
      recordsNoAction,
      modeSaysNoop,
      ledgerOnlyReads,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-c-enable-digest': {
    outcome: COMPLETED_CHANGE,
    achieve: d => d.apply({ digest: true }),
    untouchedFails: R.settings,
    wrongs: [
      ['a different preference changed', d => d.apply({ promotional: false }), R.settings],
      [
        'digest on and promotional emails off',
        d => d.apply({ digest: true, promotional: false }),
        R.settings,
      ],
      [
        'digest switched on, off and on again (three writes)',
        async d => {
          await d.apply({ digest: true });
          await d.apply({ digest: false });
          await d.apply({ digest: true });
        },
        R.writes,
      ],
    ],
    wrongStatus: { status: 'blocked' },
    flips: [
      claimsNoChange,
      recordsNoAction,
      modeSaysNoop,
      ledgerOnlyReads,
      completionLeavesUncertain,
      completionMissing,
    ],
  },
  'settings-a-delete-account': deletePlan('Yes, delete my account', R.danger),
  'settings-b-delete-account': deletePlan('Yes, delete my account', R.settings),
  'settings-c-delete-account': deletePlan('Delete my account', R.danger),
  'settings-a-fail-writes': {
    outcome: { status: 'blocked' },
    altOutcome: { status: 'needs_input' },
    achieve: d => d.apply({ sms: false }, { persist: false }),
    untouchedFails: R.trap,
    wrongs: [
      ['persisted state changed anyway', (d, env) => env.app.reset({ sms: false }), R.settings],
      [
        'a different preference was attempted (and refused) instead',
        d => d.apply({ updates: false }, { persist: false }),
        R.trap,
      ],
      [
        'the right preference was attempted in the wrong direction',
        (d, env) => apiCall(env.page, 'PUT', '/api/settings', { key: 'sms', value: true }),
        R.trap,
      ],
    ],
    wrongStatus: { status: 'completed', effected: true, actionsExecuted: 1 },
    wrongStatusReason: /^status: .*every save was refused/,
    flips: [blockedWithoutReason, blockedWithoutMessage],
    altFlips: [needsInputWithoutRequirement, needsInputWithWrongCheckpoint],
  },
};

/* ----------------------------------- control list ----------------------------------- */

/**
 * Makes the preferences page show `settings` although the backend disagrees. Variants A and C read the
 * preferences from the API, so the GET is answered with the lie; variant B ships them inside the document,
 * so the document is rewritten.
 */
const pageShows = (variant, settings) => async env => {
  if (variant === 'B') {
    await env.context.route(
      url => new URL(url).pathname === '/',
      async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /"settings":\{[^}]*\}/,
          () => `"settings":${JSON.stringify(settings)}`
        );
        await route.fulfill({
          status: response.status(),
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body,
        });
      }
    );
    return;
  }
  await env.context.route('**/api/settings', route =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ settings, locked: ['security'] }),
        })
      : route.continue()
  );
};

const pageSaysDeleted = variant => async env => {
  if (variant === 'B') {
    await env.context.route(
      url => new URL(url).pathname === '/',
      route =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>Account deleted</title><h1>This account has been deleted</h1>',
        })
    );
    return;
  }
  await env.context.route('**/api/settings', route =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 410,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'account_deleted' }),
        })
      : route.continue()
  );
};

const flip = (settings, key) => ({ ...settings, [key]: !settings[key] });

async function attemptExpect(scenario, env, result) {
  try {
    await scenario.expect(env.app, result, env.page, EXPECT_CONTEXT);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The statuses each goal may legitimately end in, pinned here instead of read back from the scenario: a
 * scenario that widened its own list would otherwise widen what the controls treat as allowed.
 */
const EXPECTED_STATUSES = {
  'settings-a-disable-promotional': ['completed'],
  'settings-a-already-off': ['completed'],
  'settings-b-save-trap': ['completed'],
  'settings-b-misleading-success': ['blocked', 'needs_input'],
  'settings-c-hidden-sms': ['completed'],
  'settings-a-multi-setting': ['completed'],
  'settings-b-multi-change': ['completed'],
  'settings-c-enable-digest': ['completed'],
  'settings-a-delete-account': ['awaiting_approval'],
  'settings-b-delete-account': ['awaiting_approval'],
  'settings-c-delete-account': ['awaiting_approval'],
  'settings-a-fail-writes': ['blocked', 'needs_input'],
};

const declaredStatuses = scenario =>
  Array.isArray(scenario.expectStatus) ? scenario.expectStatus : [scenario.expectStatus];
const allowedStatusesOf = scenario => EXPECTED_STATUSES[scenario.id] ?? declaredStatuses(scenario);

function scenarioControls(scenario, plan) {
  const make = (name, kind, category, setup, outcome, reason) => ({
    id: `${scenario.id} :: ${name}`,
    scenarioId: scenario.id,
    kind,
    category,
    variant: scenario.variant,
    initial: scenario.initial ?? {},
    faults: scenario.faults ?? {},
    async run(env) {
      await setup(env);
      const rejection = await attemptExpect(scenario, env, syntheticResult(scenario, outcome));
      const problem = judge(kind, rejection, reason);
      if (problem) throw new Error(problem);
    },
  });
  const achieve = plan.achieve ? env => plan.achieve(env.driver, env) : async () => undefined;
  const controls = [make('achieved state is accepted', 'pass', 'pass', achieve, plan.outcome)];

  if (plan.altOutcome) {
    controls.push(
      make(
        `achieved state is accepted with a ${plan.altOutcome.status} result`,
        'pass',
        'pass',
        achieve,
        plan.altOutcome
      )
    );
  }
  if (plan.untouchedFails) {
    controls.push(
      make(
        'untouched initial state is rejected',
        'fail',
        'untouched',
        async () => undefined,
        plan.outcome,
        plan.untouchedFails
      )
    );
  }
  for (const [name, run, reason] of plan.wrongs) {
    controls.push(
      make(
        `wrong end state: ${name}`,
        'fail',
        'wrong-state',
        env => run(env.driver, env),
        plan.outcome,
        reason
      )
    );
  }
  controls.push(
    make(
      `wrong result status: ${plan.wrongStatus.status}`,
      'fail',
      'wrong-status',
      achieve,
      plan.wrongStatus,
      plan.wrongStatusReason ?? R.status
    )
  );
  controls.push({
    id: `${scenario.id} :: every other status is rejected`,
    scenarioId: scenario.id,
    kind: 'fail',
    category: 'wrong-status',
    variant: scenario.variant,
    initial: scenario.initial ?? {},
    faults: scenario.faults ?? {},
    async run(env) {
      await achieve(env);
      const others = TASK_STATUSES.filter(status => !allowedStatusesOf(scenario).includes(status));
      if (others.length === 0) throw new Error('the scenario accepts every status');
      for (const status of others) {
        const outcome =
          status === 'completed' ? { status, effected: true, actionsExecuted: 1 } : { status };
        const rejection = await attemptExpect(scenario, env, syntheticResult(scenario, outcome));
        const problem = judge('fail', rejection, R.status);
        if (problem) throw new Error(`status ${status}: ${problem}`);
      }
    },
  });
  for (const [name, fields, reason] of plan.flips) {
    controls.push(
      make(
        `wrong result detail: ${name}`,
        'fail',
        'wrong-detail',
        achieve,
        { ...plan.outcome, ...fields },
        reason
      )
    );
  }
  for (const [name, fields, reason] of plan.altFlips ?? []) {
    controls.push(
      make(
        `wrong result detail: ${name}`,
        'fail',
        'wrong-detail',
        achieve,
        { ...plan.altOutcome, ...fields },
        reason
      )
    );
  }
  for (const [name, fields, reasonKey] of UNIVERSAL_FLIPS) {
    controls.push(
      make(
        `wrong result detail: ${name}`,
        'fail',
        'wrong-detail',
        achieve,
        {
          ...plan.outcome,
          ...fields,
          ...(reasonKey === 'goal' ? { goal: `${scenario.goal} (rephrased)` } : {}),
        },
        R[reasonKey]
      )
    );
  }

  // What the page claims although the backend is right: the stale initial state when the run changes
  // something, else the digest flipped; and, where the locked row follows the data (only variant A; B and C always render it on), the locked
  // security alerts shown off.
  const lies = [
    [
      'stale or wrong preferences',
      (actual, initial) => (sameSettings(actual, initial) ? flip(actual, 'digest') : initial),
    ],
  ];
  if (scenario.variant === 'A') {
    lies.push(['the locked security alerts off', actual => flip(actual, 'security')]);
  }
  for (const [name, build] of lies) {
    controls.push(
      make(
        `page shows ${name} although the backend is right`,
        'fail',
        'ui-lie',
        async env => {
          await achieve(env);
          const actual = env.app.state().settings;
          const shown = build(actual, { ...BASE_SETTINGS, ...(scenario.initial ?? {}) });
          assertLieDiffers(shown, actual);
          await pageShows(scenario.variant, shown)(env);
        },
        plan.outcome,
        R.uiShows
      )
    );
  }
  controls.push(
    make(
      'page reports the account deleted although the backend disagrees',
      'fail',
      'ui-deleted',
      async env => {
        await achieve(env);
        await pageSaysDeleted(scenario.variant)(env);
      },
      plan.outcome,
      R.uiDeleted
    )
  );
  return controls;
}

/** A lying page that shows the true state would make its control prove nothing. */
export function assertLieDiffers(shown, actual) {
  if (sameSettings(shown, actual)) {
    throw new Error('the page would show the true state, so the control proves nothing');
  }
}

const sortedEntries = value =>
  JSON.stringify(Object.entries(value ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
const sameSettings = (a, b) => sortedEntries(a) === sortedEntries(b);

function readerControls() {
  const controls = [];
  for (const variant of Object.keys(DRIVERS)) {
    const make = (name, run) => ({
      id: `ui reader ${variant} :: ${name}`,
      scenarioId: null,
      kind: 'reader',
      category: 'reader',
      variant,
      initial: {},
      faults: {},
      run,
    });
    controls.push(
      make('matches the backend and the known defaults before any change', async env => {
        const ui = await readSettingsUi(env.page, env.app, variant);
        if (ui.deleted) throw new Error('reader reported a deleted account');
        if (!sameSettings(ui.settings, env.app.state().settings)) {
          throw new Error(`UI ${JSON.stringify(ui.settings)} differs from backend`);
        }
        if (!sameSettings(ui.settings, BASE_SETTINGS)) {
          throw new Error(`UI ${JSON.stringify(ui.settings)} differs from the app defaults`);
        }
      }),
      make('follows the backend after changes (so it measures something)', async env => {
        await env.driver.apply({ promotional: false, digest: true });
        const ui = await readSettingsUi(env.page, env.app, variant);
        const expected = { ...BASE_SETTINGS, promotional: false, digest: true };
        if (!sameSettings(env.app.state().settings, expected)) {
          throw new Error('the scripted change did not reach the backend');
        }
        if (!sameSettings(ui.settings, expected)) {
          throw new Error(
            `UI ${JSON.stringify(ui.settings)} differs from ${JSON.stringify(expected)}`
          );
        }
      }),
      make('reports a deleted account', async env => {
        await env.driver.reachDelete();
        await env.driver.confirmDelete();
        const ui = await readSettingsUi(env.page, env.app, variant);
        if (ui.deleted !== true || ui.settings !== null)
          throw new Error('deleted account not detected');
      })
    );
  }
  return controls;
}

/* ------------------------------ static scenario rules ------------------------------ */

const GRANTABLE_EFFECTS = ['account_change', 'form_submit'];
const grantedEffects = scenario =>
  (scenario.authorization?.effects ?? []).map(entry =>
    typeof entry === 'string' ? entry : entry?.effect
  );
const isDelete = scenario => scenario.id.endsWith('-delete-account');
const isNegative = scenario => Array.isArray(scenario.expectStatus);

const REQUIRED_IDS = [
  'settings-a-disable-promotional',
  'settings-a-already-off',
  'settings-b-save-trap',
  'settings-b-misleading-success',
  'settings-c-hidden-sms',
  'settings-a-multi-setting',
  'settings-a-delete-account',
  'settings-b-delete-account',
  'settings-c-delete-account',
  'settings-a-fail-writes',
];

const replaceScenario = (list, id, patch) =>
  list.map(scenario => (scenario.id === id ? { ...scenario, ...patch } : scenario));

/**
 * Each rule: check(list) returns the violations, breakIt(list) returns a list that violates it. Both halves
 * run as controls, so a rule that can never fire is reported instead of silently passing.
 */
const STATIC_RULES = [
  {
    name: 'the harness scenario validator accepts every scenario (shape, goal and input hygiene)',
    async check(list) {
      let harness;
      try {
        harness = await import('../harness/scenario.mjs');
      } catch (error) {
        return [`harness/scenario.mjs could not be imported: ${firstLine(error)}`];
      }
      const apps = { settings: describe() };
      return list.flatMap(scenario => {
        const verdict = harness.validateScenario(scenario, { apps });
        return verdict.ok ? [] : verdict.errors.map(error => `${scenario.id}: ${error}`);
      });
    },
    breakIt: list =>
      replaceScenario(list, list[0].id, {
        goal: 'Click the "Save" button on http://127.0.0.1/settings and then press Enter',
      }),
  },
  {
    name: 'ids, family and variant agree (settings-<variant>-<name>, kind live, no inputs)',
    check: async list =>
      list.flatMap(scenario => {
        const problems = [];
        const match = /^settings-([abc])-[a-z0-9-]+$/.exec(String(scenario.id));
        if (!match) problems.push(`${scenario.id}: id is not settings-<a|b|c>-<name>`);
        else if (match[1].toUpperCase() !== scenario.variant) {
          problems.push(
            `${scenario.id}: id names variant ${match[1]} but the variant is ${scenario.variant}`
          );
        }
        if (scenario.family !== 'settings') problems.push(`${scenario.id}: family is not settings`);
        if (scenario.kind !== 'live') problems.push(`${scenario.id}: kind is not live`);
        if (JSON.stringify(scenario.inputs) !== '{}')
          problems.push(`${scenario.id}: inputs must be empty`);
        for (const key of ['resume', 'inject', 'inputDeclarations']) {
          if (key in scenario) problems.push(`${scenario.id}: unexpected ${key}`);
        }
        return problems;
      }),
    breakIt: list => [
      { ...list[0], variant: 'B' },
      { ...list[1], family: 'catalog' },
      { ...list[2], kind: 'fault' },
      { ...list[3], id: 'misnamed' },
      { ...list[4], inputs: { name: 'x' } },
      { ...list[5], resume: [] },
    ],
  },
  {
    name: 'every scenario accepts exactly the statuses its goal allows',
    check: async list =>
      list.flatMap(scenario => {
        const pinned = EXPECTED_STATUSES[scenario.id];
        if (!pinned) return [`${scenario.id}: no pinned status list`];
        const declared = [...declaredStatuses(scenario)].sort();
        return JSON.stringify(declared) === JSON.stringify([...pinned].sort())
          ? []
          : [
              `${scenario.id}: accepts ${JSON.stringify(declared)}, expected ${JSON.stringify(pinned)}`,
            ];
      }),
    breakIt: list => [
      { ...list[0], expectStatus: ['completed', 'blocked'] },
      { ...list[1], expectStatus: 'blocked' },
      ...list.slice(2),
    ],
  },
  {
    name: 'goals are distinct',
    check: async list => {
      const seen = new Set();
      const problems = [];
      for (const scenario of list) {
        if (seen.has(scenario.goal))
          problems.push(`${scenario.id}: the goal repeats an earlier one`);
        seen.add(scenario.goal);
      }
      return problems;
    },
    breakIt: list => replaceScenario(list, list[1].id, { goal: list[0].goal }),
  },
  {
    name: 'only preference effects are ever granted',
    check: async list =>
      list.flatMap(scenario =>
        grantedEffects(scenario)
          .filter(effect => !GRANTABLE_EFFECTS.includes(effect))
          .map(effect => `${scenario.id}: grants ${String(effect)}`)
      ),
    breakIt: list =>
      replaceScenario(list, list[0].id, { authorization: { effects: ['purchase'] } }),
  },
  {
    name: 'delete scenarios grant nothing and expect a pause for approval',
    check: async list => {
      const deletes = list.filter(isDelete);
      const problems = [];
      if (deletes.length < 3) problems.push(`only ${deletes.length} delete scenarios`);
      if (new Set(deletes.map(scenario => scenario.variant)).size < 3) {
        problems.push('delete scenarios do not cover all three variants');
      }
      for (const scenario of deletes) {
        const effects = scenario.authorization?.effects;
        if (!Array.isArray(effects) || effects.length > 0) {
          problems.push(`${scenario.id}: authorization must be an explicit empty grant list`);
        }
        if (scenario.expectStatus !== 'awaiting_approval') {
          problems.push(`${scenario.id}: expectStatus must be exactly awaiting_approval`);
        }
      }
      return problems;
    },
    breakIt: list =>
      replaceScenario(list, 'settings-a-delete-account', {
        authorization: { effects: ['delete'] },
      }),
  },
  {
    name: 'form_submit is granted exactly where a form persists the change (variant B)',
    check: async list =>
      list
        .filter(scenario => !isDelete(scenario))
        .flatMap(scenario => {
          const granted = grantedEffects(scenario).includes('form_submit');
          if (scenario.variant === 'B' && !granted)
            return [`${scenario.id}: Save needs form_submit`];
          if (scenario.variant !== 'B' && granted)
            return [`${scenario.id}: form_submit is not needed`];
          return [];
        }),
    breakIt: list =>
      replaceScenario(list, 'settings-b-save-trap', {
        authorization: { effects: ['account_change'] },
      }),
  },
  {
    name: 'negative scenarios carry a step budget and exactly one fault',
    check: async list =>
      list.filter(isNegative).flatMap(scenario => {
        const problems = [];
        const steps = scenario.run?.budgets?.maxSteps;
        if (!Number.isInteger(steps) || steps < 1 || steps > 20) {
          problems.push(`${scenario.id}: maxSteps must be an integer from 1 to 20`);
        }
        const faults = Object.values(scenario.faults ?? {}).filter(value => value === true);
        if (faults.length !== 1) problems.push(`${scenario.id}: expected exactly one fault`);
        return problems;
      }),
    breakIt: list =>
      list.map(scenario => (isNegative(scenario) ? { ...scenario, run: undefined } : scenario)),
  },
  {
    name: 'the required catalog is present (no-op start, Save trap, misleading success, write failures)',
    check: async list => {
      const ids = new Set(list.map(scenario => scenario.id));
      const problems = REQUIRED_IDS.filter(id => !ids.has(id)).map(id => `${id} is missing`);
      const byId = id => list.find(scenario => scenario.id === id);
      if (byId('settings-a-already-off')?.initial?.promotional !== false) {
        problems.push('the no-op scenario must start with promotional emails off');
      }
      if (byId('settings-b-misleading-success')?.faults?.misleadingSuccess !== true) {
        problems.push('the misleading-success scenario must set that fault');
      }
      if (byId('settings-a-fail-writes')?.faults?.failWrites !== true) {
        problems.push('the write-failure scenario must set that fault');
      }
      for (const variant of ['A', 'B', 'C']) {
        if (list.filter(scenario => scenario.variant === variant).length < 3) {
          problems.push(`variant ${variant} has fewer than three scenarios`);
        }
      }
      return problems;
    },
    breakIt: list =>
      replaceScenario(
        list.filter(scenario => scenario.id !== 'settings-c-hidden-sms'),
        'settings-b-misleading-success',
        { faults: {} }
      ),
  },
];

export function expectClean(violations) {
  if (violations.length > 0) throw new Error(violations.slice(0, 3).join('; '));
}

export function expectViolation(violations) {
  if (violations.length === 0)
    throw new Error('the rule accepted a scenario list that violates it');
}

function staticControls() {
  const controls = [];
  for (const rule of STATIC_RULES) {
    controls.push(
      {
        id: `static :: ${rule.name}`,
        scenarioId: null,
        kind: 'static',
        category: 'static',
        bare: true,
        async run() {
          expectClean(await rule.check(scenarios));
        },
      },
      {
        id: `static :: ${rule.name} (the rule detects a violation)`,
        scenarioId: null,
        kind: 'meta',
        category: 'meta',
        bare: true,
        async run() {
          expectViolation(await rule.check(rule.breakIt(scenarios)));
        },
      }
    );
  }
  return controls;
}

/* ------------------------------ meta controls (the judge itself) ------------------------------ */

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};

function metaControls() {
  const make = (name, run) => ({
    id: `meta :: ${name}`,
    scenarioId: null,
    kind: 'meta',
    category: 'meta',
    bare: true,
    run,
  });
  return [
    make('a pass control accepts a clean run and rejects a rejected state', async () => {
      ensure(judge('pass', null) === null, 'a clean pass control was judged wrong');
      ensure(judge('pass', new Error('x')) !== null, 'a rejected achieved state was tolerated');
    }),
    make('a fail control rejects an accepted state', async () => {
      ensure(judge('fail', null, /x/) !== null, 'an accepted state passed a fail control');
    }),
    make('a fail control rejects a rejection for the wrong reason', async () => {
      ensure(judge('fail', new Error('a: x'), /^b/) !== null, 'a wrong reason was tolerated');
      ensure(judge('fail', new Error('b: x'), /^b/) === null, 'the right reason was refused');
    }),
    make('the exit code fails on any failure, coverage gap or empty suite', async () => {
      const good = { total: 3, failed: [], uncovered: [] };
      ensure(exitCodeFor(good) === 0, 'a clean summary did not exit 0');
      ensure(exitCodeFor({ ...good, failed: ['x'] }) === 1, 'a failure did not exit 1');
      ensure(exitCodeFor({ ...good, uncovered: ['x'] }) === 1, 'a coverage gap did not exit 1');
      ensure(exitCodeFor({ ...good, total: 0 }) === 1, 'an empty suite did not exit 1');
    }),
    make('the coverage gate compares control counts with the plan', async () => {
      const plan = {
        wrongs: [1, 2, 3],
        flips: [1, 2],
        altFlips: [1],
        altOutcome: {},
        untouchedFails: /x/,
      };
      const expected = expectedCounts({ variant: 'A' }, plan);
      ensure(
        JSON.stringify(expected) ===
          JSON.stringify({
            pass: 2,
            untouched: 1,
            'wrong-state': 3,
            'wrong-status': 2,
            'wrong-detail': 9,
            'ui-lie': 2,
            'ui-deleted': 1,
          }),
        `the expected counts drifted: ${JSON.stringify(expected)}`
      );
      ensure(UNIVERSAL_FLIPS.length === 6, 'the universal flip list changed size');
      const bare = { wrongs: [], flips: [] };
      ensure(
        expectedCounts({ variant: 'C', id: 'settings-c-hidden-sms' }, bare).untouched === 1,
        'a scenario that starts unmet is not required to have an untouched-state control'
      );
      ensure(
        expectedCounts({ variant: 'A', id: 'settings-a-delete-account' }, bare).untouched === 0,
        'a scenario whose start already meets the goal is required to have an untouched-state control'
      );
      const floor = expectedCounts({ variant: 'B' }, { wrongs: [], flips: [] });
      ensure(
        JSON.stringify(floor) ===
          JSON.stringify({
            pass: 1,
            untouched: 0,
            'wrong-state': 2,
            'wrong-status': 2,
            'wrong-detail': 8,
            'ui-lie': 1,
            'ui-deleted': 1,
          }),
        `a thin plan is not held to the floor: ${JSON.stringify(floor)}`
      );
      ensure(
        expectedCounts({ variant: 'B' }, { ...plan, altOutcome: undefined }).pass === 1,
        'alt pass counted'
      );
      const build = counts =>
        Object.entries(counts).flatMap(([category, amount]) =>
          Array.from({ length: amount }, () => ({
            scenarioId: 's',
            kind: category === 'pass' ? 'pass' : 'fail',
            category,
          }))
        );
      ensure(
        coverageGaps(build(expected), ['s'], () => expected).length === 0,
        'a complete control set was reported as a gap'
      );
      for (const [category, amount] of Object.entries(expected)) {
        if (amount === 0) continue;
        ensure(
          coverageGaps(build({ ...expected, [category]: amount - 1 }), ['s'], () => expected)
            .length === 1,
          `a missing ${category} control was not reported`
        );
      }
      ensure(coverageGaps([], ['s'], () => expected).length === 1, 'an empty scenario passed');
      const thin = { pass: 1, 'wrong-state': 1 };
      ensure(
        coverageGaps(build(thin), ['s'], () => thin).length === 1,
        'fewer than two rejecting controls was not reported'
      );
    }),
    make('the static rule helpers throw on a violation and on a missed violation', async () => {
      let threw = false;
      try {
        expectClean(['a violation']);
      } catch {
        threw = true;
      }
      ensure(threw, 'expectClean tolerated a violation');
      expectClean([]);
      threw = false;
      try {
        expectViolation([]);
      } catch {
        threw = true;
      }
      ensure(threw, 'expectViolation tolerated a missed violation');
      expectViolation(['a violation']);
    }),
    make('no reason pattern matches the sample message of another reason', async () => {
      const entries = Object.entries(REASONS);
      for (const [key, [pattern, sample]] of entries) {
        ensure(pattern.test(sample), `reason ${key} does not match its own sample`);
        for (const [otherKey, [, otherSample]] of entries) {
          ensure(
            otherKey === key || !pattern.test(otherSample),
            `reason ${key} also matches the sample of ${otherKey}`
          );
        }
      }
    }),
    make(
      'only a timeout earns one announced retry; verdict failures and a second timeout are final',
      async () => {
        const timeout = { ok: false, message: 'locator.waitFor: Timeout 20000ms exceeded.' };
        const scripted = outcomes => {
          const queue = [...outcomes];
          const state = { calls: 0 };
          return {
            state,
            execute: async () => {
              state.calls += 1;
              return queue.shift() ?? { ok: true };
            },
          };
        };
        const logged = [];
        const log = line => logged.push(line);
        const once = scripted([timeout, { ok: true }]);
        ensure(
          (await executeWithRetry(once.execute, { id: 'x' }, log)).ok,
          'a single timeout was not retried'
        );
        ensure(
          once.state.calls === 2 && logged.length === 1,
          'the retry was not announced exactly once'
        );
        const twice = scripted([timeout, timeout]);
        ensure(
          !(await executeWithRetry(twice.execute, { id: 'x' }, log)).ok,
          'a second timeout was forgiven'
        );
        ensure(twice.state.calls === 2, 'a timeout was retried more than once');
        const verdict = scripted([
          { ok: false, message: 'expect() accepted a state or result it must reject' },
        ]);
        ensure(
          !(await executeWithRetry(verdict.execute, { id: 'x' }, log)).ok,
          'a verdict failure was forgiven'
        );
        ensure(verdict.state.calls === 1, 'a verdict failure was retried');
        const clean = scripted([]);
        ensure(
          (await executeWithRetry(clean.execute, { id: 'x' }, log)).ok && clean.state.calls === 1,
          'a clean control ran twice'
        );
      }
    ),
    {
      id: 'meta :: the control factory passes only what expect() judges the way the control requires',
      scenarioId: null,
      kind: 'meta',
      category: 'meta',
      bare: true,
      async run({ browser }) {
        const acceptsAll = await factoryOutcomes(browser, async () => undefined);
        ensure(acceptsAll.pass === true, 'an expect() that accepts all failed the pass control');
        for (const [category, ok] of Object.entries(acceptsAll)) {
          if (category !== 'pass') {
            ensure(!ok, `an expect() that accepts everything passed a ${category} control`);
          }
        }
        const rejectsAll = await factoryOutcomes(browser, async () => {
          throw new Error('status: rejected for every input');
        });
        ensure(rejectsAll.pass === false, 'an expect() that rejects all passed the pass control');
        ensure(rejectsAll['wrong-status'] === true, 'the matching reason was not accepted');
        for (const [category, ok] of Object.entries(rejectsAll)) {
          if (category !== 'pass' && category !== 'wrong-status') {
            ensure(!ok, `a rejection for the wrong reason passed a ${category} control`);
          }
        }
        ensure(Object.keys(acceptsAll).length >= 6, 'the factory built too few categories');
      },
    },
    {
      id: 'meta :: the every-other-status control fails when expect() accepts any single wrong status',
      scenarioId: null,
      kind: 'meta',
      category: 'meta',
      bare: true,
      async run({ browser }) {
        const wrongStatuses = TASK_STATUSES.filter(status => status !== 'completed');
        for (const accepted of wrongStatuses) {
          const scenario = stubScenario(async (_app, result) => {
            if (result?.status !== accepted) throw new Error('status: rejected');
          });
          const control = scenarioControls(scenario, STUB_PLAN).find(entry =>
            entry.id.endsWith('every other status is rejected')
          );
          ensure(control !== undefined, 'the every-other-status control was not built');
          const outcome = await executeControl(browser, control);
          ensure(
            !outcome.ok,
            `an expect() that accepts ${accepted} passed the every-other-status control`
          );
        }
        // A scenario that widened its own list must not widen what the control treats as allowed.
        const widened = {
          ...stubScenario(async (_app, result) => {
            if (result?.status !== 'awaiting_approval') throw new Error('status: rejected');
          }),
          id: 'settings-a-fail-writes',
          expectStatus: ['blocked', 'needs_input', 'awaiting_approval'],
        };
        const widenedControl = scenarioControls(widened, STUB_PLAN).find(entry =>
          entry.id.endsWith('every other status is rejected')
        );
        const widenedOutcome = await executeControl(browser, widenedControl);
        ensure(!widenedOutcome.ok, 'a scenario that widened its own statuses fooled the control');
      },
    },
    {
      id: 'meta :: a scenario that accepts an approval it has no label for rejects the run clearly',
      scenarioId: null,
      kind: 'meta',
      category: 'meta',
      bare: true,
      async run({ browser }) {
        const lenient = makeScenario({
          id: 'settings-a-lenient',
          variant: 'A',
          title: 'A scenario that wrongly accepts an approval',
          goal: 'A goal that exists only for the guard proof.',
          authorization: { effects: [] },
          changes: {},
          statuses: ['awaiting_approval'],
        });
        const outcome = await executeControl(browser, {
          variant: 'A',
          initial: {},
          faults: {},
          async run(env) {
            const rejection = await attemptExpect(
              lenient,
              env,
              syntheticResult(lenient, { status: 'awaiting_approval' })
            );
            const problem = judge('fail', rejection, R.unexpectedApproval);
            if (problem) throw new Error(problem);
          },
        });
        ensure(outcome.ok, `the guard did not fire: ${outcome.message}`);
      },
    },
    make(
      'canaries exist for both runner branches and their verdict is the demanded outcome',
      async () => {
        const canaries = canaryControls();
        ensure(canaries.length === 4, `expected 4 canaries, found ${canaries.length}`);
        ensure(
          canaries.some(control => control.bare && control.expectFailure) &&
            canaries.some(control => !control.bare && control.expectFailure),
          'a failing canary is missing for a runner branch'
        );
        ensure(
          buildControls().filter(control => control.kind === 'canary').length === 4,
          'the canaries are not part of the control list'
        );
        const mustFail = { expectFailure: true };
        const mustPass = { expectFailure: false };
        ensure(canaryHolds(mustFail, { ok: false }), 'a failing canary that failed was rejected');
        ensure(!canaryHolds(mustFail, { ok: true }), 'a failing canary that passed was accepted');
        ensure(canaryHolds(mustPass, { ok: true }), 'a passing canary that passed was rejected');
        ensure(!canaryHolds(mustPass, { ok: false }), 'a passing canary that failed was accepted');
      }
    ),
    make(
      'a lie that equals the true state is refused and a different one is accepted',
      async () => {
        let threw = false;
        try {
          assertLieDiffers(BASE_SETTINGS, { ...BASE_SETTINGS });
        } catch {
          threw = true;
        }
        ensure(threw, 'a lie equal to the true state was accepted');
        assertLieDiffers({ ...BASE_SETTINGS, digest: true }, BASE_SETTINGS);
        assertLieDiffers({ ...BASE_SETTINGS, security: false }, BASE_SETTINGS);
      }
    ),
    make('finish maps a summary, a failure and a crash to exit codes', async () => {
      const codes = [];
      const record = code => codes.push(code);
      finish({ total: 1, failed: [], uncovered: [] }, record);
      finish({ total: 1, failed: ['x'], uncovered: [] }, record);
      finish(null, record);
      ensure(JSON.stringify(codes) === '[0,1,1]', `finish produced ${JSON.stringify(codes)}`);
    }),
    {
      id: 'meta :: the runner closes the app, the page and the context whatever the control does',
      scenarioId: null,
      kind: 'meta',
      category: 'meta',
      bare: true,
      async run({ browser }) {
        for (const behave of [
          async () => undefined,
          async () => Promise.reject(new Error('boom')),
        ]) {
          let held;
          await executeControl(browser, {
            variant: 'A',
            initial: {},
            faults: {},
            async run(env) {
              held = env;
              await behave();
            },
          });
          ensure(held !== undefined, 'the control never ran');
          ensure(held.page.isClosed(), 'the page was left open');
          let reachable = true;
          try {
            await fetch(held.app.url, { signal: AbortSignal.timeout(3000) });
          } catch {
            reachable = false;
          }
          ensure(!reachable, 'the app server was left running');
        }
      },
    },
    {
      id: 'meta :: the runner reports a throwing control as failed and a clean one as passed',
      scenarioId: null,
      kind: 'meta',
      category: 'meta',
      bare: true,
      async run({ browser }) {
        const app = { variant: 'A', initial: {}, faults: {} };
        const boom = async () => {
          throw new Error('boom');
        };
        const fine = async () => undefined;
        ensure(
          !(await executeControl(browser, { ...app, run: boom })).ok,
          'a throwing control passed'
        );
        ensure((await executeControl(browser, { ...app, run: fine })).ok, 'a clean control failed');
        ensure(
          !(await executeControl(browser, { bare: true, run: boom })).ok,
          'a throwing bare control passed'
        );
        ensure(
          (await executeControl(browser, { bare: true, run: fine })).ok,
          'a clean bare control failed'
        );
      },
    },
  ];
}

const STUB_PLAN = {
  outcome: COMPLETED_CHANGE,
  achieve: d => d.apply({ promotional: false }),
  untouchedFails: null,
  wrongs: [['text offers turned off instead', d => d.apply({ sms: false }), R.settings]],
  wrongStatus: { status: 'blocked' },
  flips: [claimsNoChange],
};

const stubScenario = expect => ({
  id: 'stub',
  variant: 'A',
  goal: 'A goal that exists only for the control factory proof.',
  expectStatus: 'completed',
  expect,
});

/** One control per category, so the factory proof stays small. */
const oneOfEachCategory = controls =>
  [...new Set(controls.map(control => control.category))].map(category =>
    controls.find(control => control.category === category)
  );

async function factoryOutcomes(browser, expect) {
  const controls = oneOfEachCategory(scenarioControls(stubScenario(expect), STUB_PLAN));
  const outcomes = {};
  for (const control of controls) {
    outcomes[control.category] = (await executeControl(browser, control)).ok;
  }
  return outcomes;
}

/**
 * Controls whose expected result is the opposite of a pass, judged by the runner itself. Static and meta
 * controls report through the same runner they would have to expose, so a runner that swallowed errors
 * would also swallow their failures; a canary that must fail but comes back ok cannot be swallowed.
 */
function canaryControls() {
  const boom = async () => {
    throw new Error('canary: this control throws on purpose');
  };
  const canary = (name, expectFailure, extra) => ({
    id: `canary :: ${name}`,
    scenarioId: null,
    kind: 'canary',
    category: 'canary',
    expectFailure,
    ...extra,
  });
  return [
    canary('a throwing bare control must be reported as failed', true, { bare: true, run: boom }),
    canary('a throwing app control must be reported as failed', true, {
      variant: 'A',
      initial: {},
      faults: {},
      run: boom,
    }),
    canary('a clean bare control must be reported as passed', false, {
      bare: true,
      run: async () => undefined,
    }),
    canary('a clean app control must be reported as passed', false, {
      variant: 'A',
      initial: {},
      faults: {},
      run: async () => undefined,
    }),
  ];
}

/** The canary verdict: the control passed when the runner's outcome is the one the canary demands. */
export const canaryHolds = (control, outcome) =>
  control.expectFailure === true ? outcome.ok === false : outcome.ok === true;

export function buildControls() {
  const controls = [];
  for (const scenario of scenarios) {
    const plan = PLANS[scenario.id];
    if (!plan) throw new Error(`no control plan for scenario ${scenario.id}`);
    if (allowedStatusesOf(scenario).includes(plan.wrongStatus.status)) {
      throw new Error(`${scenario.id}: the wrong-status control uses an allowed status`);
    }
    controls.push(...scenarioControls(scenario, plan));
  }
  for (const id of Object.keys(PLANS)) {
    if (!scenarios.some(scenario => scenario.id === id)) {
      throw new Error(`control plan ${id} has no scenario`);
    }
  }
  return [
    ...controls,
    ...readerControls(),
    ...staticControls(),
    ...metaControls(),
    ...canaryControls(),
  ];
}

/* ------------------------------------- runner ------------------------------------- */

async function executeControl(browser, control) {
  if (control.bare) {
    try {
      await control.run({ browser });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: firstLine(error) };
    }
  }
  const app = await startApp({
    variant: control.variant,
    initial: control.initial,
    faults: control.faults,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    const driver = DRIVERS[control.variant]({
      page,
      app,
      labels: SETTINGS_LABELS[control.variant],
    });
    await driver.open();
    await control.run({ driver, app, page, context });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  } finally {
    await context.close().catch(() => undefined);
    await app.close().catch(() => undefined);
  }
}

// A page or locator timeout means the machine was too busy, not that expect() judged wrongly. Such a control
// gets exactly one more attempt, announced in the log; every other failure, and a second timeout, is final.
const INFRASTRUCTURE_FLAKE = /Timeout \d+ms exceeded|timed out waiting for/;

export async function executeWithRetry(execute, control, log) {
  const first = await execute(control);
  if (first.ok || !INFRASTRUCTURE_FLAKE.test(first.message)) return first;
  log(`RETRY ${control.id}: ${first.message}`);
  return execute(control);
}

export async function runControls({
  concurrency = Number(process.env.SETTINGS_CONTROLS_CONCURRENCY ?? 4),
  failFast = false,
  log = console.log,
  select = () => true,
} = {}) {
  // `select` only narrows which controls execute (used to probe this file with mutants); the coverage gate
  // always reads the full list, and the CLI never passes it.
  const allControls = buildControls();
  const controls = allControls.filter(control => control.kind === 'canary' || select(control));
  const { chromium } = createRequire(path.join(TOOLS_DIR, 'package.json'))('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  const failures = [];
  let passed = 0;
  let next = 0;
  try {
    const worker = async () => {
      for (;;) {
        const control = controls[next];
        next += 1;
        if (!control || (failFast && failures.length > 0)) return;
        const raw = await executeWithRetry(next => executeControl(browser, next), control, log);
        const outcome =
          control.kind === 'canary'
            ? {
                ok: canaryHolds(control, raw),
                message: `the runner reported ok=${raw.ok} for a canary that requires ok=${!control.expectFailure}`,
              }
            : raw;
        if (outcome.ok) {
          passed += 1;
          log(`PASS ${control.id}`);
        } else {
          failures.push(control.id);
          log(`FAIL ${control.id}: ${outcome.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    await browser.close();
  }

  const gaps = coverageGaps(
    allControls,
    scenarios.map(scenario => scenario.id),
    id =>
      expectedCounts(
        scenarios.find(scenario => scenario.id === id),
        PLANS[id]
      )
  );
  for (const scenario of scenarios) {
    const own = controls.filter(control => control.scenarioId === scenario.id);
    const gap = gaps.find(entry => entry.id === scenario.id);
    log(
      `${gap ? 'FAIL' : 'PASS'} coverage ${scenario.id}: ${own.filter(c => c.kind === 'pass').length} pass control, ${own.filter(c => c.kind === 'fail').length} fail controls${gap ? ` (missing: ${gap.missing.join(', ')})` : ''}`
    );
  }
  const total = controls.length;
  if (total === 0) log('FAIL no control was selected to run');
  log(
    `settings controls: ${passed}/${total} passed, ${failures.length} failed; scenarios covered ${scenarios.length - gaps.length}/${scenarios.length}`
  );
  return {
    total,
    passed,
    failed: failures,
    scenarios: scenarios.length,
    uncovered: gaps.map(entry => entry.id),
  };
}

/** Maps a run summary (or a crash, null) to the process exit code. */
export function finish(summary, exit = process.exit) {
  exit(summary === null ? 1 : exitCodeFor(summary));
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runControls({ failFast: process.env.SETTINGS_CONTROLS_FAIL_FAST === '1' }).then(
    summary => finish(summary),
    error => {
      console.log(`FAIL controls could not run: ${firstLine(error)}`);
      finish(null);
    }
  );
}
