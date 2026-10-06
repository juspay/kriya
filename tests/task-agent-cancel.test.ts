/** @jest-environment node */
import { createTaskAgent } from '@/agent/TaskAgent';
import type { TaskExecutionEffect, TaskExecutionOutcome, TaskHost } from '@/types';
import {
  counterIds,
  deciderFail,
  deciderOk,
  makeCapabilities,
  makeClock,
  makeManualClock,
  makeOutcome,
  makeRequest,
} from './helpers/agent-fixtures';
import { action, deferred, requireStatus, setup, terminal } from './helpers/task-agent-contract';

function abortReached(signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal === undefined) throw new Error('operation did not receive cancellation signal');
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

const routine = deciderOk('commitment', {
  commitment: 'NONE' as const,
  confidence: 0.99,
  agreement: 'single' as const,
});

describe('TaskAgent cancellation and budget accounting', () => {
  test('pre-aborted request returns cancelled idle without touching the page', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, fakeHost } = setup({});
    const result = requireStatus(await agent.run(makeRequest(), controller.signal), 'cancelled');
    expect(result.during).toBe('idle');
    expect(result.lastEffect).toBe('none');
    expect(result.unresolvedUncertain).toEqual([]);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('abort during observation is forwarded to host and never claims completion', async () => {
    const entered = deferred<void>();
    const controller = new AbortController();
    const fixture = setup({});
    const host: TaskHost = {
      ...fixture.fakeHost.host,
      observe: async (_request, signal) => {
        entered.resolve();
        await abortReached(signal);
        return { ok: false, error: { code: 'CANCELLED', message: 'aborted', retryable: false } };
      },
    };
    const agent = createTaskAgent({
      host,
      decider: fixture.fakeDecider.decider,
      options: { clock: makeClock(), createId: counterIds() },
    });
    const running = agent.run(makeRequest(), controller.signal);
    await entered.promise;
    controller.abort();
    const result = requireStatus(await running, 'cancelled');
    expect(result.during).toBe('observation');
    expect(result.lastEffect).toBe('none');
    expect('completion' in result).toBe(false);
    expect(fixture.fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('cancel(runId) aborts only the active named run during a decision', async () => {
    const entered = deferred<void>();
    const fixture = setup({});
    const fakeHost = fixture.fakeHost;
    const agent = createTaskAgent({
      host: fakeHost.host,
      decider: {
        ...fixture.fakeDecider.decider,
        chooseAction: async (_request, context) => {
          entered.resolve();
          await abortReached(context.signal);
          return deciderFail('CANCELLED');
        },
      },
    });
    const running = agent.run(makeRequest({ runId: 'run_000000000009' }));
    await entered.promise;
    expect(agent.cancel('run_000000000008')).toBe(false);
    expect(agent.cancel('run_000000000009')).toBe(true);
    const result = requireStatus(await running, 'cancelled');
    expect(result.during).toBe('decision');
    expect(result.lastEffect).toBe('none');
    expect(agent.cancel()).toBe(false);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test.each(['none', 'applied', 'uncertain'] as const)(
    'action cancellation retains host effect %s and uncertain checkpoint truthfully',
    async (effect: TaskExecutionEffect) => {
      const entered = deferred<void>();
      const controller = new AbortController();
      const fixture = setup({
        chooseAction: [deciderOk('action', action('CLICK', 't1'))],
        classifyCommitment: [routine],
      });
      let executions = 0;
      const host: TaskHost = {
        ...fixture.fakeHost.host,
        execute: async (request, signal) => {
          executions += 1;
          entered.resolve();
          await abortReached(signal);
          return effect === 'uncertain'
            ? makeOutcome('uncertain', effect, {
                requestId: request.requestId,
                code: 'EXECUTION_CANCELLED',
              })
            : makeOutcome('failed', effect, {
                requestId: request.requestId,
                code: 'EXECUTION_CANCELLED',
              });
        },
      };
      const agent = createTaskAgent({
        host,
        decider: fixture.fakeDecider.decider,
        options: { clock: makeClock(), createId: counterIds() },
      });
      const running = agent.run(makeRequest(), controller.signal);
      await entered.promise;
      controller.abort();
      const result = requireStatus(await running, 'cancelled');
      expect(result.during).toBe('action');
      expect(result.lastEffect).toBe(effect);
      expect(result.ledger).toHaveLength(1);
      expect(result.unresolvedUncertain).toEqual(effect === 'uncertain' ? [1] : []);
      expect(result.checkpoint?.pending.kind).toBe(
        effect === 'uncertain' ? 'uncertain_effect' : undefined
      );
      expect('completion' in result).toBe(false);
      expect(executions).toBe(1);
      expect(fixture.fakeHost.calls.release).toEqual([result.sessionId]);
    }
  );

  test('cancellation none waits for the in-flight host outcome before resolving cancelled', async () => {
    const entered = deferred<void>();
    const outcome = deferred<TaskExecutionOutcome>();
    const fixture = setup(
      { chooseAction: [deciderOk('action', action('CLICK', 't1'))], classifyCommitment: [routine] },
      { capabilities: makeCapabilities({ cancellation: 'none' }) }
    );
    const host: TaskHost = {
      ...fixture.fakeHost.host,
      execute: async request => {
        entered.resolve();
        const result = await outcome.promise;
        return { ...result, requestId: request.requestId };
      },
    };
    const agent = createTaskAgent({ host, decider: fixture.fakeDecider.decider });
    let settled = false;
    const running = agent.run(makeRequest()).then(result => {
      settled = true;
      return result;
    });
    await entered.promise;
    expect(agent.cancel()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    outcome.resolve(makeOutcome('applied', 'applied'));
    const result = requireStatus(await running, 'cancelled');
    expect(result.lastEffect).toBe('applied');
    expect(result.during).toBe('action');
  });

  test.each([
    ['maxSteps' as const, 1],
    ['maxModelCalls' as const, 1],
  ])('%s refuses work N+1 while allowing N calls', async (budget, limit) => {
    const { agent, fakeDecider, fakeHost } = setup({
      chooseAction: [deciderOk('action', terminal('DONE'))],
      verifyCompletion: [
        deciderOk('completion', {
          verdict: 'NOT_SATISFIED',
          confidence: 0.99,
          evidenceTargetIds: ['t1'],
        }),
      ],
    });
    const result = requireStatus(
      await agent.run(makeRequest({ options: { budgets: { [budget]: limit } } })),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe(budget);
    expect(fakeDecider.calls.chooseAction).toHaveLength(1);
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(budget === 'maxSteps' ? 1 : 0);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('wall-time budget blocks only after active elapsed time exceeds the limit', async () => {
    const clock = makeManualClock();
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [
          () => {
            clock.advance(11);
            return deciderOk('action', terminal('DONE'));
          },
        ],
        verifyCompletion: [],
      },
      {},
      { clock: clock.now }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ options: { budgets: { maxWallTimeMs: 10 } } })),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('maxWallTimeMs');
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(0);
  });

  test('release errors remain best effort and do not replace the terminal result', async () => {
    const fixture = setup({ chooseAction: [deciderOk('action', terminal('BLOCKED'))] });
    const release = jest.fn(async () => {
      throw new Error('release failure');
    });
    const agent = createTaskAgent({
      host: { ...fixture.fakeHost.host, release },
      decider: fixture.fakeDecider.decider,
    });
    const result = requireStatus(await agent.run(makeRequest()), 'blocked');
    expect(result.reason).toBe('MODEL_BLOCKED');
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.fakeHost.calls.dispose).toHaveLength(0);
  });
});
