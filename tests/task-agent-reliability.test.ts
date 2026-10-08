/** @jest-environment node */
import type { TaskDeciderError } from '@/types';
import {
  deciderFail,
  deciderOk,
  makeCommitmentDecision,
  makeCompletionDecision,
  makeElement,
  makeExchange,
  makeObservation,
  makeOutcome,
  makeRequest,
} from './helpers/agent-fixtures';
import { action, requireStatus, secretValue, setup, terminal } from './helpers/task-agent-contract';

const routine = deciderOk('commitment', makeCommitmentDecision());
const click = deciderOk('action', action('CLICK', 't1'));
const done = deciderOk('action', terminal('DONE'));
const satisfied = deciderOk('completion', makeCompletionDecision());

describe('TaskAgent bounded read-only commitment recovery', () => {
  test('a hung classifier times out at the coordinator boundary and recovers before execution', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click, done],
      classifyCommitment: [routine],
      verifyCompletion: [satisfied],
    });
    const classifier = jest
      .spyOn(fakeDecider.decider, 'classifyCommitment')
      .mockImplementationOnce(() => new Promise(() => {}));
    const result = requireStatus(
      await agent.run(makeRequest({ options: { observeTimeoutMs: 20, captureTrace: true } })),
      'completed'
    );
    expect(classifier).toHaveBeenCalledTimes(2);
    expect(classifier.mock.calls.map(call => call[1].callIndex)).toEqual([2, 3]);
    expect(classifier.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(classifier.mock.calls[1]?.[1].signal?.aborted).toBe(false);
    expect(fakeHost.calls.execute).toHaveLength(1);
    expect(result.stats.usage.modelCalls).toBe(5);
  });

  test.each<Partial<TaskDeciderError>>([
    { code: 'TIMEOUT' },
    { code: 'NETWORK' },
    { code: 'HTTP_ERROR', status: 408 },
    { code: 'RATE_LIMITED', status: 429 },
    { code: 'RATE_LIMITED' },
    { code: 'HTTP_ERROR', status: 429 },
    { code: 'HTTP_ERROR', status: 500 },
    { code: 'HTTP_ERROR', status: 503 },
    { code: 'HTTP_ERROR', status: 529 },
  ])('recovers from $code/$status before executing exactly once', async failure => {
    const first = {
      ...deciderFail('NETWORK', failure),
      exchange: makeExchange('commitment', { requestId: 'first-transport' }),
    };
    const second = deciderOk('commitment', makeCommitmentDecision(), {
      requestId: 'second-transport',
    });
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click, done],
      classifyCommitment: [first, second],
      verifyCompletion: [satisfied],
    });
    const result = requireStatus(
      await agent.run(makeRequest({ options: { captureTrace: true } })),
      'completed'
    );
    expect(fakeHost.calls.execute).toHaveLength(1);
    expect(result.ledger).toHaveLength(1);
    expect(result.completion.actionsExecuted).toBe(1);
    expect(fakeDecider.calls.classifyCommitment.map(call => call.context.callIndex)).toEqual([
      2, 3,
    ]);
    expect(fakeDecider.calls.classifyCommitment[1]?.request).toEqual(
      fakeDecider.calls.classifyCommitment[0]?.request
    );
    expect(result.stats.usage.modelCalls).toBe(5);
    expect(result.exchanges.filter(exchange => exchange.stage === 'commitment')).toEqual([
      expect.objectContaining({ requestId: 'first-transport' }),
      expect.objectContaining({ requestId: 'second-transport' }),
    ]);
    expect(
      result.trace?.filter(
        event => event.type === 'exchange' && event.exchange.stage === 'commitment'
      )
    ).toHaveLength(2);
  });

  test('a second transport failure fails closed without consuming a third available answer', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [deciderFail('TIMEOUT'), deciderFail('NETWORK'), routine],
    });
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('other_commitment');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(result.stats.usage.deciderFailures).toBe(2);
  });

  test.each<Partial<TaskDeciderError>>([
    { code: 'TIMEOUT', retryable: false },
    { code: 'NETWORK', retryable: false },
    { code: 'HTTP_ERROR', status: 503, retryable: false },
    { code: 'UNAUTHORIZED', retryable: true, status: 503 },
    { code: 'INVALID_REQUEST', retryable: true, status: 503 },
    { code: 'INVALID_RESPONSE', retryable: true },
    { code: 'CHOICE_NOT_OFFERED', retryable: true },
    { code: 'GOAL_MISMATCH', retryable: true },
    { code: 'REQUEST_TOO_LARGE', retryable: true },
    { code: 'HTTP_ERROR', status: 400 },
    { code: 'HTTP_ERROR', status: 401 },
    { code: 'HTTP_ERROR', status: 403 },
    { code: 'HTTP_ERROR', status: 422 },
    { code: 'HTTP_ERROR' },
    { code: 'TIMEOUT', status: 401 },
    { code: 'RATE_LIMITED', status: 422 },
  ])('does not retry ineligible $code/$status/$retryable', async failure => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [deciderFail('NETWORK', failure), routine],
    });
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('other_commitment');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(1);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('a low-confidence routine answer fails closed without asking again', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [
        deciderOk('commitment', makeCommitmentDecision({ confidence: 0.01 })),
        routine,
      ],
    });
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('other_commitment');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(1);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test.each(['reported', 'signal'] as const)('never retries %s cancellation', async kind => {
    const controller = new AbortController();
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [
        () => {
          if (kind === 'signal') controller.abort();
          return deciderFail(kind === 'signal' ? 'NETWORK' : 'CANCELLED', { retryable: true });
        },
        routine,
      ],
    });
    const result = requireStatus(await agent.run(makeRequest(), controller.signal), 'cancelled');
    expect(result.lastEffect).toBe('none');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(1);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('model-call exhaustion prevents the additional classifier attempt', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [deciderFail('TIMEOUT'), routine],
    });
    const result = requireStatus(
      await agent.run(makeRequest({ options: { budgets: { maxModelCalls: 2 } } })),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('maxModelCalls');
    expect(result.stats.usage.modelCalls).toBe(2);
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(1);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('wall-time exhaustion prevents the additional classifier attempt', async () => {
    let now = 1000;
    const { agent, fakeHost, fakeDecider } = setup(
      {
        chooseAction: [click],
        classifyCommitment: [
          () => {
            now += 100;
            return deciderFail('TIMEOUT');
          },
          routine,
        ],
      },
      {},
      { clock: () => now }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ options: { budgets: { maxWallTimeMs: 50 } } })),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('maxWallTimeMs');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(1);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test.each([0, 1])('failure budget %s remains authoritative', async maxDeciderFailures => {
    const value = secretValue();
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [
        deciderFail('TIMEOUT', { message: value }),
        deciderFail('NETWORK', { message: value }),
        routine,
      ],
    });
    const result = requireStatus(
      await agent.run(
        makeRequest({
          inputs: { password: value },
          options: { budgets: { maxDeciderFailures }, captureTrace: true },
        })
      ),
      'failed'
    );
    expect(result.error.code).toBe('DECIDER_FAILED');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(maxDeciderFailures + 1);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  test('recovered classification preserves model commitment approval', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [click],
      classifyCommitment: [
        deciderFail('TIMEOUT'),
        deciderOk('commitment', makeCommitmentDecision({ commitment: 'PURCHASE' })),
      ],
    });
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('purchase');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('routine recovery cannot lower an observed structural commitment hint', async () => {
    const { agent, fakeHost, fakeDecider } = setup(
      {
        chooseAction: [click],
        classifyCommitment: [deciderFail('TIMEOUT'), routine],
      },
      {
        observations: [
          makeObservation({
            elements: [
              makeElement({ commitHints: [{ class: 'PUBLISH', basis: 'declared_marker' }] }),
            ],
          }),
        ],
      }
    );
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('publish');
    expect(fakeDecider.calls.classifyCommitment).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('an uncertain execution after classification recovery is never executed again', async () => {
    const { agent, fakeHost, fakeDecider } = setup(
      { chooseAction: [click, done], classifyCommitment: [deciderFail('NETWORK'), routine] },
      { outcomes: [makeOutcome('uncertain', 'uncertain', { code: 'EXECUTION_TIMEOUT' })] }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ options: { captureTrace: true } })),
      'blocked'
    );
    expect(result.reason).toBe('UNCERTAIN_EFFECT');
    expect(fakeHost.calls.execute).toHaveLength(1);
    expect(result.unresolvedUncertain).toHaveLength(1);
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(0);
    expect(result.trace?.filter(event => event.type === 'done_gate')).toEqual([
      expect.objectContaining({ passed: false, failures: ['UNRESOLVED_UNCERTAIN_EFFECT'] }),
    ]);
    expect(result.trace?.some(event => event.type === 'done_gate' && event.passed)).not.toBe(true);
  });
});

describe('TaskAgent independent completion unavailability evidence', () => {
  test.each(['NETWORK', 'UNAUTHORIZED', 'UNSUPPORTED'] as const)(
    'records unavailable gate on %s without semantic premature DONE or secret leakage',
    async code => {
      const value = secretValue();
      const { agent, fakeHost, fakeDecider } = setup({
        chooseAction: [done],
        verifyCompletion: [deciderFail(code, { message: value }), satisfied],
      });
      const result = requireStatus(
        await agent.run(
          makeRequest({
            inputs: { password: value },
            options: {
              captureTrace: true,
              budgets: { maxDeciderFailures: 0, maxPrematureDone: 0 },
            },
          })
        ),
        'failed'
      );
      expect(result.error.code).toBe('DECIDER_FAILED');
      expect(result.stats.usage.prematureDone).toBe(0);
      expect(fakeDecider.calls.verifyCompletion).toHaveLength(1);
      expect(fakeHost.calls.execute).toHaveLength(0);
      expect(result.trace?.filter(event => event.type === 'done_gate')).toEqual([
        expect.objectContaining({ passed: false, failures: ['DECIDER_UNAVAILABLE'] }),
      ]);
      expect(JSON.stringify(result)).not.toContain(value);
    }
  );

  test('a completion transport failure can recover through the existing loop without spending premature-DONE budget', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [done, done],
      verifyCompletion: [deciderFail('NETWORK'), satisfied],
    });
    const result = requireStatus(
      await agent.run(
        makeRequest({ options: { captureTrace: true, budgets: { maxPrematureDone: 0 } } })
      ),
      'completed'
    );
    expect(result.stats.usage.prematureDone).toBe(0);
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(result.trace?.filter(event => event.type === 'done_gate')).toEqual([
      expect.objectContaining({ passed: false, failures: ['DECIDER_UNAVAILABLE'] }),
      expect.objectContaining({ passed: true, failures: [] }),
    ]);
    expect(
      fakeDecider.calls.chooseAction.every(call =>
        call.request.history.every(entry => entry.kind !== 'premature_done')
      )
    ).toBe(true);
  });

  test('records unavailable gate when model budget prevents independent verification', async () => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [done],
      verifyCompletion: [satisfied],
    });
    const result = requireStatus(
      await agent.run(
        makeRequest({ options: { captureTrace: true, budgets: { maxModelCalls: 1 } } })
      ),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('maxModelCalls');
    expect(result.stats.usage.prematureDone).toBe(0);
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(0);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(result.trace?.filter(event => event.type === 'done_gate')).toEqual([
      expect.objectContaining({ passed: false, failures: ['DECIDER_UNAVAILABLE'] }),
    ]);
  });

  test('completion cancellation records unavailable evidence and remains cancelled', async () => {
    const { agent, fakeDecider } = setup({
      chooseAction: [done],
      verifyCompletion: [deciderFail('CANCELLED', { retryable: true }), satisfied],
    });
    const result = requireStatus(
      await agent.run(makeRequest({ options: { captureTrace: true } })),
      'cancelled'
    );
    expect(result.stats.usage.prematureDone).toBe(0);
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(1);
    expect(result.trace?.filter(event => event.type === 'done_gate')).toEqual([
      expect.objectContaining({ passed: false, failures: ['DECIDER_UNAVAILABLE'] }),
    ]);
  });
});
