/** @jest-environment node */
import { createTaskAgent } from '@/agent/TaskAgent';
import { buildActionQuestions } from '@/agent/request';
import { TASK_REDACTED } from '@/types';
import type { TaskEvent, TaskIdFactory, TaskInputs, TaskObservation } from '@/types';
import {
  deciderOk,
  makeClock,
  makeCompletionDecision,
  makeElement,
  makeFakeDecider,
  makeFakeHost,
  makeObservation,
  makeOutcome,
  makeRequest,
  makeTextField,
} from './helpers/agent-fixtures';
import {
  action,
  approvalResolution,
  chooseCandidate,
  requireStatus,
  setup,
  terminal,
} from './helpers/task-agent-contract';

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const hasOwn = (value: object | undefined, key: string): boolean =>
  value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
const neutralGoal = 'Complete the task.';

function simpleCompletion(
  secret: string,
  overrides: { readonly observation?: TaskObservation; readonly capture?: boolean } = {}
) {
  const observation =
    overrides.observation ??
    makeObservation({ elements: [makeElement({ label: `Confirm ${secret}` })] });
  const events: TaskEvent[] = [];
  const scenario = setup(
    {
      chooseAction: [
        deciderOk('action', action('CLICK', 't1')),
        deciderOk('action', terminal('DONE')),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
      ],
      verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
    },
    { observations: [observation] },
    { onEvent: event => events.push(event) }
  );
  return {
    ...scenario,
    events,
    request: makeRequest({
      goal: neutralGoal,
      inputs: { password: secret },
      options: { captureTrace: overrides.capture ?? true },
    }),
  };
}

describe('coordinator preserves typed structure while redacting text', () => {
  test('issuer-only prior continuation marker remains exact when its fixed wording matches a secret', async () => {
    const secret = characters(105, 115, 115, 117, 105, 110, 103);
    const checkpointKey = `checkpoint-${secret}`;
    const first = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] },
      { checkpointKey }
    );
    const paused = requireStatus(
      await first.agent.run(
        makeRequest({
          goal: neutralGoal,
          inputs: { password: secret },
          priorEffects: [
            { digest: `dg_${'9'.repeat(32)}`, effects: ['read'], resolution: 'applied' },
          ],
        })
      ),
      'needs_input'
    );
    expect(
      paused.checkpoint.history.some(
        entry => entry.detail === 'Coordinator prior effects require the issuing agent instance.'
      )
    ).toBe(true);
    const other = setup({}, {}, { checkpointKey });
    const resumed = requireStatus(
      await other.agent.resume({
        checkpoint: JSON.parse(JSON.stringify(paused.checkpoint)) as typeof paused.checkpoint,
        inputs: { password: secret },
        resolution: { kind: 'inputs', inputs: {} },
      }),
      'failed'
    );
    expect(resumed.error.code).toBe('CHECKPOINT_INVALID');
    expect(other.fakeHost.calls.capabilities).toHaveLength(0);
    expect(other.fakeHost.calls.observe).toHaveLength(0);
    expect(other.fakeHost.calls.execute).toHaveLength(0);
    expect(other.fakeDecider.calls.chooseAction).toHaveLength(0);
  });

  test('hex fragment identities and input references survive approval checkpoint, JSON resume and DONE', async () => {
    const secret = characters(49, 50, 51, 52);
    const profileKey = `profile${secret}`;
    const path = `${profileKey}.name`;
    let count = 0;
    const ids: TaskIdFactory = prefix =>
      `${prefix}_${secret}${(++count).toString(16).padStart(8, '0')}`;
    const field = makeTextField({
      signature: `sg_${secret}${'a'.repeat(12)}`,
      commitHints: [{ class: 'SEND', basis: 'declared_marker' }],
    });
    const before = makeObservation({
      elements: [field],
      documentId: `doc_${secret}abcdef00`,
      fingerprint: `fp_${secret}_before`,
    });
    const after = makeObservation({
      ...before,
      elements: [{ ...field, state: { ...field.state, value: 'Ada' } }],
      fingerprint: `fp_${secret}_after`,
    });
    const fakeHost = makeFakeHost({ observations: [before, before, after], createId: ids });
    const fakeDecider = makeFakeDecider({
      chooseAction: [
        deciderOk('action', action('FILL', field.id)),
        deciderOk('action', terminal('DONE')),
      ],
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.source === 'input'),
      ],
      verifyCompletion: [
        deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [field.id] })),
      ],
    });
    const agent = createTaskAgent({
      host: fakeHost.host,
      decider: fakeDecider.decider,
      options: {
        createId: ids,
        clock: makeClock(),
        verifier: async () => ({ verdict: 'SATISFIED' }),
      },
    });
    const inputs: TaskInputs = { [profileKey]: { name: 'Ada' }, password: secret };
    const paused = requireStatus(
      await agent.run(makeRequest({ goal: neutralGoal, inputs, options: { captureTrace: true } })),
      'awaiting_approval'
    );
    const checkpoint = JSON.parse(JSON.stringify(paused.checkpoint)) as typeof paused.checkpoint;
    expect(hasOwn(checkpoint.request.inputs, profileKey)).toBe(true);
    expect(
      checkpoint.pending.kind === 'awaiting_approval' &&
        checkpoint.pending.command.operation === 'FILL' &&
        checkpoint.pending.command.value.source === 'input' &&
        checkpoint.pending.command.value.path === path
    ).toBe(true);
    expect(paused.approval.command.target?.signature === field.signature).toBe(true);
    const completed = requireStatus(
      await agent.resume({
        checkpoint,
        inputs: { password: secret },
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'completed'
    );
    const entry = completed.ledger[0];
    expect(entry?.command.target?.signature === field.signature).toBe(true);
    expect(entry?.scope.snapshotId === fakeHost.calls.execute[0]?.scope.snapshotId).toBe(true);
    expect(completed.sessionId === paused.sessionId && completed.runId === paused.runId).toBe(true);
    expect(
      entry?.command.command.operation === 'FILL' &&
        entry.command.command.value.source === 'input' &&
        entry.command.command.value.path === path
    ).toBe(true);
    expect(completed.completion.verifiedSnapshot.snapshotId.includes(secret)).toBe(true);
    expect(completed.completion.verifiedSnapshot.documentId === before.documentId).toBe(true);
    expect(completed.completion.effected).toBe(true);
    expect(fakeHost.calls.execute).toHaveLength(1);
  });

  test('a common sensitive word never renames label fields in ledger, evidence or events', async () => {
    const secret = characters(108, 97, 98, 101, 108);
    const scenario = simpleCompletion(secret);
    const result = requireStatus(await scenario.agent.run(scenario.request), 'completed');
    expect(hasOwn(result.ledger[0]?.command.target, 'label')).toBe(true);
    expect(result.ledger[0]?.command.target?.label.includes(secret)).toBe(false);
    expect(hasOwn(result.completion.evidence[0], 'label')).toBe(true);
    expect(result.completion.evidence[0]?.label.includes(secret)).toBe(false);
    const executing = scenario.events.find(event => event.type === 'executing');
    expect(executing?.type === 'executing' && hasOwn(executing.command.target, 'label')).toBe(true);
    expect(hasOwn(result.stats.actions, 'applied')).toBe(true);
  });

  test('a sensitive word matching applied preserves effect/status and completion facts', async () => {
    const secret = characters(97, 112, 112, 108, 105, 101, 100);
    const scenario = simpleCompletion(secret);
    const result = requireStatus(await scenario.agent.run(scenario.request), 'completed');
    expect(result.ledger[0]?.status === 'applied' && result.ledger[0].effect === 'applied').toBe(
      true
    );
    expect(result.lastEffect === 'applied' && result.stats.actions.applied === 1).toBe(true);
    expect(result.completion.mode === 'effected' && result.completion.effected === true).toBe(true);
    const executed = scenario.events.find(event => event.type === 'executed');
    expect(
      executed?.type === 'executed' &&
        executed.status === 'applied' &&
        executed.effect === 'applied'
    ).toBe(true);
    expect(
      scenario.fakeDecider.calls.chooseAction[1]?.request.history.some(
        entry => entry.outcome === 'applied' && entry.effect === 'applied'
      )
    ).toBe(true);
  });

  test('short numeric secret preserves numeric metadata and literal task/goal in captured exchanges', async () => {
    const secret = characters(49, 50, 51);
    const numeric = Number(secret);
    const goal = `Complete item ${secret}.`;
    const events: TaskEvent[] = [];
    const exchange = {
      latencyMs: numeric,
      requestBytes: numeric,
      estimatedInputTokens: numeric,
      attemptLog: [{ attempt: 1, status: 200, latencyMs: numeric }],
      usage: { inputTokens: numeric, outputTokens: numeric },
    };
    const { agent } = setup(
      {
        chooseAction: [
          request =>
            deciderOk('action', action('CLICK', 't1'), {
              ...exchange,
              request: buildActionQuestions(request),
            }),
          deciderOk('action', terminal('DONE')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
        verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
      },
      {
        outcomes: [
          makeOutcome('applied', 'applied', {
            durationMs: numeric,
            readback: { kind: 'click', defaultPrevented: true },
          }),
        ],
      },
      { onEvent: event => events.push(event) }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({
          goal,
          inputs: { password: secret },
          options: { captureExchanges: true, captureTrace: true },
        })
      ),
      'completed'
    );
    expect(result.goal === goal && result.exchanges[0]?.request?.state.task === goal).toBe(true);
    expect(
      Object.values(result.exchanges[0]?.request?.questions ?? {}).every(
        question => question.instructions.goal === goal
      )
    ).toBe(true);
    expect(
      result.exchanges[0]?.latencyMs === numeric &&
        typeof result.exchanges[0]?.latencyMs === 'number'
    ).toBe(true);
    expect(
      result.exchanges[0]?.requestBytes === numeric &&
        result.exchanges[0]?.usage?.inputTokens === numeric
    ).toBe(true);
    const executed = events.find(event => event.type === 'executed');
    expect(
      executed?.type === 'executed' &&
        executed.durationMs === numeric &&
        typeof executed.durationMs === 'number'
    ).toBe(true);
    expect(
      result.trace?.every(
        event =>
          typeof event.seq === 'number' &&
          typeof event.step === 'number' &&
          typeof event.at === 'number'
      )
    ).toBe(true);
    expect(
      result.ledger[0]?.readback?.kind === 'click' &&
        result.ledger[0].readback.defaultPrevented === true
    ).toBe(true);
  });

  test('checkpoint caller data is scrubbed even under identity/discriminator/goal-shaped keys', async () => {
    const secret = characters(108, 97, 98, 101, 108);
    const { agent } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({
          goal: neutralGoal,
          inputDeclarations: [
            {
              path: 'audit.label',
              sensitive: false,
              bind: { origins: [`https://user:pass@example.test/?token=${secret}#fragment`] },
            },
          ],
          inputs: {
            password: secret,
            audit: {
              id: secret,
              status: secret,
              kind: secret,
              label: secret,
              goal: secret,
              nested: [{ effect: secret }],
              websiteUrl: `https://user:pass@example.test/?token=${secret}#fragment`,
              count: 123,
              enabled: true,
            },
          },
        })
      ),
      'needs_input'
    );
    const inputs = result.checkpoint.request.inputs;
    expect(hasOwn(inputs, 'password')).toBe(false);
    const auditValue = inputs.audit;
    if (auditValue === null || typeof auditValue !== 'object' || Array.isArray(auditValue)) {
      throw new Error('Checkpoint data shape changed.');
    }
    const audit = auditValue as TaskInputs;
    for (const key of ['id', 'status', 'kind', 'label', 'goal']) {
      expect(hasOwn(audit, key)).toBe(true);
      expect(audit[key] === TASK_REDACTED).toBe(true);
    }
    const nested = audit.nested;
    expect(
      Array.isArray(nested) &&
        typeof nested[0] === 'object' &&
        nested[0] !== null &&
        !Array.isArray(nested[0]) &&
        nested[0].effect === TASK_REDACTED
    ).toBe(true);
    expect(audit.count === 123 && typeof audit.count === 'number' && audit.enabled === true).toBe(
      true
    );
    const url = typeof audit.websiteUrl === 'string' ? new URL(audit.websiteUrl) : undefined;
    expect(
      url?.username === '' &&
        url.password === '' &&
        url.hash === '' &&
        url.searchParams.get('token') === TASK_REDACTED
    ).toBe(true);
    const bindingUrl = result.checkpoint.request.inputDeclarations[0]?.bind?.origins?.[0];
    const bound = typeof bindingUrl === 'string' ? new URL(bindingUrl) : undefined;
    expect(
      bound?.username === '' &&
        bound.password === '' &&
        bound.hash === '' &&
        bound.searchParams.get('token') === TASK_REDACTED
    ).toBe(true);
    expect(result.checkpoint.request.goal === neutralGoal).toBe(true);
    expect(JSON.parse(JSON.stringify(result.checkpoint))).toEqual(result.checkpoint);
  });

  test('protocol argument sources and field roles remain typed when they equal a sensitive value', async () => {
    const secret = characters(112, 114, 111, 116, 111, 99, 111, 108);
    const field = makeElement({
      id: 't4',
      kind: 'switch',
      role: 'switch',
      operations: ['SET_CHECKED'],
      state: { checked: true },
    });
    const before = makeObservation({ elements: [field] });
    const after = makeObservation({
      elements: [{ ...field, state: { ...field.state, checked: false } }],
    });
    const { agent } = setup(
      {
        chooseAction: [
          deciderOk('action', action('SET_CHECKED', 't4')),
          deciderOk('action', terminal('DONE')),
        ],
        chooseArgument: [
          request =>
            chooseCandidate(
              request,
              candidate => candidate.source === 'protocol' && candidate.label.includes('unchecked')
            ),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['t4'] })),
        ],
      },
      { observations: [before, after] }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({
          goal: neutralGoal,
          inputs: { password: secret },
          options: { captureTrace: true },
        })
      ),
      'completed'
    );
    expect(result.ledger[0]?.command.argument?.source === 'protocol').toBe(true);
    expect(
      result.ledger[0]?.command.argument?.slot === 'checked' &&
        result.ledger[0]?.command.target?.role === 'switch'
    ).toBe(true);
    expect(
      result.trace?.some(event => event.type === 'argument' && event.source === 'protocol')
    ).toBe(true);
  });
});
