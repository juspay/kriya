/** @jest-environment node */
import { createTaskAgent } from '@/agent/TaskAgent';
import type {
  TaskArgumentDecision,
  TaskChooseArgumentRequest,
  TaskDeciderResult,
  TaskRunOptions,
} from '@/types';
import {
  deciderFail,
  deciderOk,
  makeFakeDecider,
  makeFakeHost,
  makeLink,
  makeObservation,
  makeOutcome,
  makeRequest,
  makeSelectField,
} from './helpers/agent-fixtures';
import { action, requireStatus, terminal } from './helpers/task-agent-contract';

type RequirementReply = (
  request: TaskChooseArgumentRequest
) => TaskDeciderResult<TaskArgumentDecision>;

const keep =
  (confidence: number): RequirementReply =>
  () =>
    deciderOk('argument', { kind: 'keep_current', confidence });
const pick =
  (label: string, confidence: number): RequirementReply =>
  request => {
    const candidate = request.candidates.find(item => item.label === label);
    if (!candidate) throw new Error(`The fixture did not offer ${label}`);
    return deciderOk('argument', { kind: 'candidate', candidateId: candidate.id, confidence });
  };

const runScenario = async (
  replies: readonly RequirementReply[],
  settings: {
    readonly scrolls?: number;
    readonly options?: TaskRunOptions;
    readonly uncertainScroll?: boolean;
    readonly signal?: AbortSignal;
  } = {}
) => {
  let current = '1';
  let scrolls = 0;
  const quantity = () =>
    makeSelectField({
      id: 'lamp-quantity',
      label: 'Lamp quantity',
      inputName: 'lamp.quantity',
      landmark: 'main',
      state: { value: current },
      options: ['1', '2', '3'].map(label => ({
        id: `lamp-quantity.${label}`,
        label,
        value: label,
        selected: label === current,
        disabled: false,
      })),
    });
  const observation = () =>
    makeObservation({
      fingerprint: `quantities-view-${scrolls}-${current}`,
      elements: [quantity(), makeLink({ id: 'main', landmark: 'main' })],
      page: {
        readyState: 'complete',
        busy: false,
        scroll: { directions: ['DOWN'], top: scrolls * 100, max: 1000 },
        viewport: { width: 1024, height: 768 },
      },
    });
  const fakeHost = makeFakeHost({ observations: [observation()] });
  const baseObserve = fakeHost.host.observe;
  const baseExecute = fakeHost.host.execute;
  const host = {
    ...fakeHost.host,
    observe: async (...args: Parameters<typeof baseObserve>) => {
      const result = await baseObserve(...args);
      return result.ok
        ? {
            ok: true as const,
            value: {
              ...observation(),
              sessionId: result.value.sessionId,
              snapshotId: result.value.snapshotId,
              sequence: result.value.sequence,
            },
          }
        : result;
    },
    execute: async (...args: Parameters<typeof baseExecute>) => {
      const result = await baseExecute(...args);
      const command = args[0].command;
      if (command.operation === 'SCROLL') {
        scrolls += 1;
        if (settings.uncertainScroll) {
          return makeOutcome('uncertain', 'uncertain', { requestId: args[0].requestId });
        }
      }
      if (command.operation === 'SELECT' && result.effect === 'applied') {
        if (command.optionId === undefined) {
          throw new Error('The fixture requires an exact observed option id');
        }
        const parts = command.optionId.split('.');
        current = parts[parts.length - 1] ?? current;
      }
      return result;
    },
  };
  const requirements: TaskChooseArgumentRequest[] = [];
  const argumentReply: RequirementReply = request => {
    if (request.target?.id === 'lamp-quantity') {
      requirements.push(request);
      const reply = replies[requirements.length - 1];
      if (!reply) return deciderFail('UNSUPPORTED', { retryable: false });
      return reply(request);
    }
    const candidate = request.candidates.find(
      item => item.source === 'protocol' && item.label === 'Scroll DOWN'
    );
    if (!candidate) throw new Error('The fixture did not offer downward scrolling');
    return deciderOk('argument', {
      kind: 'candidate',
      candidateId: candidate.id,
      confidence: 0.99,
    });
  };
  const fakeDecider = makeFakeDecider({
    chooseArgument: Array.from({ length: 20 }, () => argumentReply),
    chooseAction: [
      ...Array.from({ length: settings.scrolls ?? 1 }, () =>
        deciderOk('action', action('SCROLL', 'page'))
      ),
      deciderOk('action', terminal('BLOCKED')),
    ],
    classifyCommitment: Array.from({ length: 10 }, () =>
      deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' })
    ),
  });
  const agent = createTaskAgent({
    host,
    decider: { ...fakeDecider.decider, supportsRequirements: true },
  });
  const result = await agent.run(
    makeRequest({
      goal: 'Keep the lamp quantity at one while examining the page.',
      options: {
        captureTrace: true,
        confidence: { argument: 0.3 },
        budgets: { maxModelCalls: 30, maxInvalidDecisions: 0 },
        ...settings.options,
      },
    }),
    settings.signal
  );
  return { result, fakeHost, fakeDecider, requirements, current };
};

describe('requirement rewrite confirmation is local to the current assessment', () => {
  test('an earlier under-floor KEEP_CURRENT resample cannot authorize a later weak rewrite', async () => {
    const { fakeHost, requirements, current } = await runScenario([
      keep(0.28),
      keep(0.28),
      pick('2', 0.34),
      keep(0.7),
    ]);
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toEqual(['SCROLL']);
    expect(current).toBe('1');
    expect(requirements).toHaveLength(4);
    expect(requirements.map(request => request.purpose)).toEqual(Array(4).fill('requirement'));
  });

  test('a current agreeing confirmation permits exactly one rewrite with the original confidence', async () => {
    const { result, fakeHost, requirements, current } = await runScenario([
      keep(0.28),
      keep(0.28),
      pick('2', 0.34),
      pick('2', 0.6),
    ]);
    expect(requirements).toHaveLength(4);
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toEqual([
      'SCROLL',
      'SELECT',
    ]);
    expect(fakeHost.calls.execute[1]?.command).toMatchObject({ optionId: 'lamp-quantity.2' });
    expect(current).toBe('2');
    expect(result.trace?.filter(event => event.type === 'planning')).toEqual([
      expect.objectContaining({ operation: 'SELECT', requirementConfidence: 0.34 }),
    ]);
  });

  test.each([
    ['a different rewrite', pick('3', 0.7)],
    ['an agreeing answer below the floor', pick('2', 0.2)],
    ['an unavailable decider', () => deciderFail('NETWORK')],
    [
      'an explicit uncertain answer',
      () => deciderOk('argument', { kind: 'uncertain_requirement' as const, confidence: 0.7 }),
    ],
  ] as const)('%s cannot leave the first weak rewrite executable', async (_name, second) => {
    const { fakeHost, requirements, current, result } = await runScenario([
      keep(0.28),
      keep(0.28),
      pick('2', 0.34),
      second,
    ]);
    expect(requirements).toHaveLength(4);
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toEqual(['SCROLL']);
    expect(current).toBe('1');
    expect(result.status).not.toBe('completed');
  });

  test('a weak rewrite with an unavailable second answer fails closed on its first assessment', async () => {
    const { fakeHost, requirements, current } = await runScenario(
      [pick('2', 0.34), () => deciderFail('NETWORK')],
      { scrolls: 0 }
    );
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(current).toBe('1');
    expect(requirements).toHaveLength(2);
  });

  test('each uncached reassessment requires confirmation after real page progress', async () => {
    const { fakeHost, requirements, current } = await runScenario(
      [keep(0.28), keep(0.28), pick('2', 0.34), pick('3', 0.7), pick('2', 0.34), keep(0.7)],
      { scrolls: 2 }
    );
    expect(requirements).toHaveLength(6);
    expect(requirements[2]?.observation.documentId).toBe(requirements[4]?.observation.documentId);
    expect(requirements[2]?.observation.fingerprint).not.toBe(
      requirements[4]?.observation.fingerprint
    );
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toEqual([
      'SCROLL',
      'SCROLL',
    ]);
    expect(current).toBe('1');
  });

  test('generic under-floor judgments retain their one-resample limit for the field and document', async () => {
    const { fakeHost, requirements, current } = await runScenario([
      keep(0.28),
      keep(0.28),
      keep(0.28),
      pick('2', 0.7),
    ]);
    expect(requirements).toHaveLength(3);
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toEqual(['SCROLL']);
    expect(current).toBe('1');
  });

  test('a mandatory confirmation still obeys the model-call budget before making its second call', async () => {
    const { result, fakeHost, requirements, current } = await runScenario(
      [pick('2', 0.34), pick('2', 0.7)],
      { scrolls: 0, options: { budgets: { maxModelCalls: 1 } } }
    );
    expect(requireStatus(result, 'blocked').budget).toBe('maxModelCalls');
    expect(result.stats.usage.modelCalls).toBe(1);
    expect(requirements).toHaveLength(1);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(current).toBe('1');
  });

  test('an exhausted decider-failure budget preserves its terminal failure', async () => {
    const { result, fakeHost, requirements, current } = await runScenario(
      [pick('2', 0.34), () => deciderFail('NETWORK')],
      { scrolls: 0, options: { budgets: { maxDeciderFailures: 0 } } }
    );
    expect(requireStatus(result, 'failed').error.code).toBe('DECIDER_FAILED');
    expect(result.stats.usage.deciderFailures).toBe(1);
    expect(requirements).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(current).toBe('1');
  });

  test.each(['first', 'confirmation'] as const)(
    'cancellation during the %s sample never executes the weak rewrite',
    async cancellationStage => {
      const controller = new AbortController();
      const abortingPick: RequirementReply = request => {
        controller.abort();
        return pick('2', 0.34)(request);
      };
      const replies =
        cancellationStage === 'first'
          ? [abortingPick, pick('2', 0.7)]
          : [pick('2', 0.34), abortingPick];
      const { result, fakeHost, requirements, current } = await runScenario(replies, {
        scrolls: 0,
        signal: controller.signal,
      });
      expect(result.status).toBe('cancelled');
      expect(requirements).toHaveLength(cancellationStage === 'first' ? 1 : 2);
      expect(fakeHost.calls.execute).toHaveLength(0);
      expect(current).toBe('1');
    }
  );

  test('uncertain page progress cannot authorize a new weak rewrite or repeat the scroll', async () => {
    const { result, fakeHost, requirements, current } = await runScenario(
      [keep(0.28), keep(0.28), pick('2', 0.34), pick('2', 0.7)],
      { scrolls: 2, uncertainScroll: true, options: { budgets: { maxUncertainEffects: 0 } } }
    );
    expect(requireStatus(result, 'blocked').reason).toBe('UNCERTAIN_EFFECT');
    expect(requirements).toHaveLength(2);
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toEqual(['SCROLL']);
    expect(current).toBe('1');
  });
});
