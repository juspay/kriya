import { scenarios as settings, readSettingsUi } from './settings.mjs';
import { scenarios as catalog } from './catalog.mjs';

const preference = settings.find(scenario => scenario.id === 'settings-a-disable-promotional');
const search = catalog.find(scenario => scenario.id === 'catalog-a-quoted-search-category');
if (preference === undefined || search === undefined) {
  throw new Error('Fault scenarios require the independently controlled baseline scenarios.');
}
const insist = (condition, message) => {
  if (!condition) throw new Error(`fault proof: ${message}`);
};

function firedProof(scenario, context) {
  const layer = scenario.inject.decider ? 'decider' : 'host';
  const spec = scenario.inject[layer];
  const count = layer === 'decider' ? 'atDecision' : 'atExecution';
  const ordinal = layer === 'decider' ? 'decision' : 'execution';
  const notes = context?.faultNotes;
  insist(Array.isArray(notes), 'the actual injection recorder notes must be available');
  const fired = notes.filter(
    note => note?.event === 'fired' && note.layer === layer && note.mode === spec.mode
  );
  insist(fired.length === 1, 'the configured injection must fire exactly once');
  const note = fired[0];
  insist(
    note.type === 'fault_injection' &&
      note.label === 'FAULT_INJECTION' &&
      note.live === false &&
      note.scenarioId === scenario.id &&
      note[count] === spec[count] &&
      Number.isInteger(note[ordinal]) &&
      note[ordinal] >= spec[count],
    'the fired note must identify this labelled fault and its armed ordinal'
  );
  if (spec.mode === 'staleBeforeExecute')
    insist(note.applied === true && note.replaced > 0, 'the stale replacement must actually occur');
  if (spec.mode === 'contextDestroyed')
    insist(
      note.applied === true && note.navigationPhase === 'during',
      'the replacement document must be caused during execution'
    );
  if (['lostAfterCommit', 'timeoutAfterCommit'].includes(spec.mode)) {
    insist(
      note.operation === 'SET_CHECKED' &&
        note.realEffect === 'applied' &&
        note.realStatus === 'applied',
      'an after-commit injection must follow an actual checked-state write'
    );
  }
  return note;
}

function traced(base, id, inject, check, run = {}) {
  const scenario = {
    ...base,
    id: `fault-${id}`,
    kind: 'fault',
    title: `Labelled injection: ${id}`,
    inject,
    run: { ...base.run, ...run },
    async expect(app, result, page, context) {
      const note = firedProof(scenario, context);
      await base.expect(app, result, page, context);
      check(result, context, note);
    },
  };
  return scenario;
}

async function checkedPreferenceState(app, page) {
  const state = app.state();
  const expected = { promotional: false, updates: true, digest: false, security: true, sms: true };
  const matches = values => Object.keys(expected).every(key => values?.[key] === expected[key]);
  insist(matches(state.settings), 'the achieved preferences must match the independent baseline');
  insist(
    state.writes.length === 1 &&
      state.writes[0].key === 'promotional' &&
      state.writes[0].from === true &&
      state.writes[0].to === false,
    'exactly one requested preference change must persist'
  );
  insist(
    state.accountDeleted === false &&
      state.dangerActions.length === 0 &&
      state.newsletter.length === 0 &&
      state.profile.displayName === 'Jordan Ellis' &&
      state.rejectedWrites === 0,
    'the baseline collateral protections must hold'
  );
  const shown = await readSettingsUi(page, app, 'A');
  insist(
    shown.deleted === false && matches(shown.settings),
    'the fresh UI must agree with achieved backend preferences'
  );
}

function afterCommit(mode, id) {
  const scenario = {
    ...preference,
    id: `fault-${id}`,
    kind: 'fault',
    title: `Labelled injection: ${id}`,
    inject: { host: { mode, atExecution: 1, operation: 'SET_CHECKED' } },
    expectStatus: ['completed', 'blocked'],
    async expect(app, result, page, context) {
      const fired = firedProof(scenario, context);
      insist(
        result?.goal === scenario.goal && Array.isArray(result.ledger),
        'the result must retain the literal goal and ledger'
      );
      const uncertain = result.ledger.filter(
        entry => entry.status === 'uncertain' && entry.effect === 'uncertain'
      );
      insist(
        uncertain.length === 1 &&
          uncertain[0].seq === fired.execution &&
          uncertain[0].command?.command?.operation === 'SET_CHECKED',
        'the lost checked write must remain in the ledger'
      );
      const entry = uncertain[0];
      insist(
        result.ledger.filter(item => item.digest === entry.digest).length === 1,
        'the uncertain digest must never be retried'
      );
      if (mode === 'timeoutAfterCommit')
        insist(
          entry.code === 'EXECUTION_TIMEOUT',
          'the uncertain write must retain the timeout code'
        );
      else insist(entry.code === 'DOCUMENT_LOST', 'the uncertain write must retain the loss code');
      await checkedPreferenceState(app, page);
      if (result.status === 'blocked') {
        insist(
          result.reason === 'UNCERTAIN_EFFECT' &&
            result.lastEffect === 'uncertain' &&
            result.unresolvedUncertain?.includes(entry.seq) &&
            result.checkpoint?.pending?.kind === 'uncertain_effect' &&
            result.checkpoint.pending.entries?.includes(entry.seq) &&
            result.completion === undefined,
          'a blocked uncertain commitment must expose its unresolved checkpoint without completion'
        );
        return;
      }
      insist(
        result.status === 'completed',
        'after-commit recovery must be completed or blocked for uncertainty'
      );
      const completion = result.completion;
      insist(
        result.unresolvedUncertain?.length === 0 &&
          completion?.unresolvedUncertain?.length === 0 &&
          completion.mode === 'effected' &&
          completion.effected === true &&
          completion.actionsExecuted >= 1 &&
          completion.verifierConfidence >= 0.75 &&
          completion.evidence?.length >= 1,
        'completion must carry independent satisfied, cited verification without unresolved effects'
      );
      insist(
        completion.resolvedUncertain?.some(
          resolution =>
            resolution.seq === entry.seq &&
            resolution.effect === 'applied' &&
            resolution.by === 'postcondition'
        ),
        'the write must be resolved by an observed postcondition'
      );
      insist(
        completion.postconditions?.some(
          check =>
            check.ledgerSeq === entry.seq &&
            check.status === 'holds' &&
            check.postcondition?.kind === 'checked' &&
            check.postcondition.checked === false
        ),
        'the requested checked state must hold in the gate observation'
      );
      insist(
        completion.verifiedSnapshot?.snapshotId !== entry.scope.snapshotId &&
          completion.verifiedAt >= entry.finishedAt,
        'verification must use a fresh post-write snapshot and coordinator time'
      );
    },
  };
  return scenario;
}

export const scenarios = [
  traced(
    preference,
    'premature-done',
    { decider: { mode: 'prematureDone', atDecision: 1 } },
    (result, context) => {
      insist(
        context.trace?.some(event => event.type === 'done_gate' && event.passed === false),
        'the injected DONE must fail its gate'
      );
      insist(
        context.trace?.some(
          event =>
            event.type === 'exchange' &&
            event.exchange?.provider === 'fault-injection' &&
            event.exchange.stage === 'action'
        ),
        'the injected action proposal must remain visible even after consecutive counters reset'
      );
    }
  ),
  {
    ...preference,
    id: 'fault-invalid-target',
    title: 'Labelled injection: reject an unoffered target before any host command',
    kind: 'fault',
    inject: { decider: { mode: 'invalidTarget', atDecision: 1 } },
    run: { budgets: { maxInvalidDecisions: 0 } },
    expectStatus: ['blocked'],
    async expect(app, result, _page, context) {
      firedProof(this, context);
      insist(
        result?.status === 'blocked' &&
          result.reason === 'MODEL_UNCERTAIN' &&
          result.goal === this.goal,
        'invalid target must block at the zero-tolerance decision budget with the literal goal'
      );
      insist(result.stats.usage.invalidDecisions === 1, 'invalid target must be counted');
      insist(
        result.ledger.length === 0 &&
          result.lastEffect === 'none' &&
          result.unresolvedUncertain.length === 0 &&
          result.completion === undefined,
        'no host command or completion may exist'
      );
      insist(app.state().writes.length === 0, 'no preference write may happen');
    },
  },
  traced(
    preference,
    'invalid-argument',
    { decider: { mode: 'invalidArgument', atDecision: 1 } },
    (result, context, note) => {
      insist(
        context.trace?.some(
          event =>
            event.type === 'exchange' &&
            event.exchange?.provider === 'fault-injection' &&
            event.exchange.stage === 'argument'
        ),
        'the injected argument choice must remain visible even after consecutive counters reset'
      );
      insist(
        !context.trace?.some(
          event =>
            event.type === 'argument' &&
            event.outcome === 'chosen' &&
            event.candidateId === note.candidateId
        ),
        'the unoffered argument must never be accepted'
      );
    }
  ),
  traced(
    preference,
    'stale-before-execute',
    { host: { mode: 'staleBeforeExecute', atExecution: 1 } },
    (result, _context, note) => {
      insist(
        result.ledger.some(
          entry =>
            entry.seq === note.execution &&
            entry.status === 'rejected_stale' &&
            entry.effect === 'none'
        ),
        'the replaced element must be rejected as stale'
      );
    }
  ),
  afterCommit('lostAfterCommit', 'lost-after-commit'),
  afterCommit('timeoutAfterCommit', 'timeout-after-commit'),
  traced(
    search,
    'context-destroyed',
    { host: { mode: 'contextDestroyed', atExecution: 1, timing: 'during' } },
    (result, _context, note) => {
      const before = result.ledger.find(entry => entry.seq === note.execution)?.scope.documentId;
      const after =
        result.completion?.verifiedSnapshot?.documentId ?? result.finalObservation?.documentId;
      insist(
        typeof before === 'string' && typeof after === 'string' && before !== after,
        'the fresh completion observation must belong to the replacement document'
      );
    }
  ),
  {
    ...preference,
    id: 'fault-cancel-model-call',
    title: 'Labelled injection: cancellation during a delayed decision',
    kind: 'fault',
    inject: { decider: { mode: 'slow', atDecision: 1, ms: 30000 } },
    run: { cancelAfterMs: 250, cancelWhenFaultFires: true },
    expectStatus: ['cancelled'],
    async expect(app, result, _page, context) {
      firedProof(this, context);
      insist(
        context.faultNotes.some(
          note =>
            note.event === 'slow_finished' &&
            note.mode === 'slow' &&
            note.outcome === 'cancelled_during_delay'
        ),
        'the configured slow decision must actually abort during its delay'
      );
      insist(
        result?.status === 'cancelled' && result.during === 'decision' && result.goal === this.goal,
        'cancellation must stop the pending model call with the literal goal'
      );
      insist(
        result.ledger.length === 0 &&
          app.state().writes.length === 0 &&
          result.lastEffect === 'none' &&
          result.unresolvedUncertain.length === 0 &&
          result.completion === undefined,
        'cancellation must leave no execution, writes or completion'
      );
    },
  },
];
