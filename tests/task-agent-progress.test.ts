/** @jest-environment node */
import * as progress from '@/agent/progress';
import { createTaskAgent } from '@/agent/TaskAgent';
import type { TaskElementState, TaskObservation, TaskRunOptions } from '@/types';
import {
  deciderOk,
  makeCompletionDecision,
  makeElement,
  makeObservation,
  makePassage,
  makeRequest,
  makeSensitiveField,
  makeTextField,
} from './helpers/agent-fixtures';
import { action, requireStatus, secretValue, setup, terminal } from './helpers/task-agent-contract';

const routine = deciderOk('commitment', {
  commitment: 'NONE' as const,
  confidence: 0.99,
  agreement: 'single' as const,
});
const page = (overrides: Partial<TaskObservation> = {}): TaskObservation =>
  makeObservation({ elements: [makeElement(), makeTextField()], ...overrides });

async function observePair(first: TaskObservation, second: TaskObservation, capture = true) {
  const scenario = setup(
    {
      chooseAction: [deciderOk('action', action('CLICK', 't1'))],
      classifyCommitment: [routine],
    },
    { observations: [first, second] }
  );
  const result = requireStatus(
    await scenario.agent.run(
      makeRequest({ options: { captureProgressDiagnostics: capture, budgets: { maxSteps: 1 } } })
    ),
    'blocked'
  );
  expect(result.reason).toBe('BUDGET_EXHAUSTED');
  expect(scenario.fakeHost.calls.execute).toHaveLength(1);
  return { ...scenario, result };
}

describe('TaskAgent opt-in shadow semantic progress', () => {
  test('counts fresh completion observations while a changing page clock remains cosmetic', async () => {
    const clockPage = (clock: number) =>
      page({
        text: `Clock ${clock}`,
        elements: [makeElement(), makePassage({ text: `${clock}` })],
      });
    const scenario = setup(
      {
        chooseAction: [
          deciderOk('action', action('CLICK', 't1')),
          deciderOk('action', terminal('DONE')),
        ],
        classifyCommitment: [routine],
        verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
      },
      { observations: [clockPage(1), clockPage(2), clockPage(3)] }
    );
    const result = requireStatus(
      await scenario.agent.run(makeRequest({ options: { captureProgressDiagnostics: true } })),
      'completed'
    );
    expect(result.progressDiagnostics).toEqual({
      scope: 'active_segment',
      observations: 3,
      semanticChanges: 0,
      cosmeticOnlyChanges: 2,
      repeatedStates: 2,
      maxUnchangedStreak: 2,
    });
    expect(scenario.fakeDecider.calls.verifyCompletion).toHaveLength(1);
    expect(result.stats.usage.noProgress).toBe(0);
  });

  test('snapshot ids, timestamps, focused state and passage changes do not count as semantic changes', async () => {
    const first = page({ elements: [makeElement(), makePassage()] });
    const second = page({
      snapshotId: 'snap_changed',
      observedAt: first.observedAt + 100,
      title: 'Clock 09:43',
      text: 'Clock 09:43',
      elements: [makeElement({ state: { focused: true } }), makePassage({ text: '09:43' })],
      truncation: { ...first.truncation, textTruncated: true },
    });
    const { result } = await observePair(first, second);
    expect(result.progressDiagnostics).toEqual({
      scope: 'active_segment',
      observations: 2,
      semanticChanges: 0,
      cosmeticOnlyChanges: 1,
      repeatedStates: 1,
      maxUnchangedStreak: 1,
    });
  });

  test.each<Partial<TaskElementState>>([
    { value: 'Updated name' },
    { checked: true },
    { selected: true },
    { expanded: true },
    { pressed: true },
    { disabled: true },
    { readOnly: true },
    { required: true },
    { invalid: true },
    { constraintInvalid: true },
  ])('observes relevant control state %j without changing the execution budget', async state => {
    const { result } = await observePair(
      page(),
      page({ elements: [makeElement(), makeTextField({ state })] })
    );
    expect(result.progressDiagnostics).toEqual({
      scope: 'active_segment',
      observations: 2,
      semanticChanges: 1,
      cosmeticOnlyChanges: 0,
      repeatedStates: 0,
      maxUnchangedStreak: 0,
    });
    expect(result.stats.usage.steps).toBe(1);
  });

  test.each<Partial<TaskObservation>>([
    { documentId: 'doc_changed' },
    { url: 'https://shop.example.test/next' },
    { validation: [{ source: 'native', text: 'Enter your name', targetId: 't3' }] },
    { dialogs: [{ id: 'dialog_1', modal: true, label: 'Confirm', elementIds: ['t1'] }] },
    { elements: [makeElement(), makeTextField({ inViewport: false })] },
    {
      page: {
        ...page().page,
        scroll: { top: 100, max: 200, directions: ['UP', 'DOWN'] },
      },
    },
  ])('tracks navigation, validation, dialog, visibility and scroll facts %j', async change => {
    const { result } = await observePair(page(), page(change));
    expect(result.progressDiagnostics?.semanticChanges).toBe(1);
    expect(result.progressDiagnostics?.observations).toBe(2);
  });

  test('stable control identities survive changed snapshot target ids and element order', async () => {
    const first = page({
      elements: [
        makeElement({ controlId: 'button_node', dialogId: 'dialog_1' }),
        makeTextField({ controlId: 'field_node', dialogId: 'dialog_1' }),
      ],
      validation: [{ source: 'native', text: 'Enter your name', targetId: 't3' }],
      dialogs: [{ id: 'dialog_1', modal: true, label: 'Confirm', elementIds: ['t1', 't3'] }],
    });
    const second = page({
      elements: [
        makeTextField({ id: 'new_field', controlId: 'field_node', dialogId: 'dialog_2' }),
        makeElement({ id: 'new_button', controlId: 'button_node', dialogId: 'dialog_2' }),
      ],
      validation: [{ source: 'native', text: 'Enter your name', targetId: 'new_field' }],
      dialogs: [
        { id: 'dialog_2', modal: true, label: 'Confirm', elementIds: ['new_field', 'new_button'] },
      ],
    });
    const { result } = await observePair(first, second);
    expect(result.progressDiagnostics?.semanticChanges).toBe(0);
    expect(result.progressDiagnostics?.repeatedStates).toBe(1);
  });

  test('existing NO_PROGRESS outcome and counters remain identical with diagnostics enabled', async () => {
    const scenario = (captureProgressDiagnostics: boolean) =>
      setup(
        {
          chooseAction: [
            deciderOk('action', action('CLICK', 't1')),
            deciderOk('action', action('CLICK', 't9')),
          ],
          classifyCommitment: [routine, routine],
        },
        { observations: [page({ elements: [makeElement(), makeElement({ id: 't9' })] })] },
        { run: { captureProgressDiagnostics, budgets: { maxNoProgress: 1 } } }
      );
    const plain = scenario(false);
    const captured = scenario(true);
    const without = requireStatus(await plain.agent.run(makeRequest()), 'blocked');
    const withDiagnostics = requireStatus(await captured.agent.run(makeRequest()), 'blocked');
    expect(without.reason).toBe('NO_PROGRESS');
    const { progressDiagnostics, ...remaining } = withDiagnostics;
    expect(remaining).toEqual(without);
    expect(progressDiagnostics?.observations).toBe(3);
    expect(progressDiagnostics?.maxUnchangedStreak).toBe(2);
    expect(captured.fakeHost.calls.order).toEqual(plain.fakeHost.calls.order);
    expect(captured.fakeHost.calls.execute).toEqual(plain.fakeHost.calls.execute);
  });

  test('default results omit diagnostics and the semantic tracker is not invoked', async () => {
    const trackerFactory = jest.spyOn(progress, 'createProgressTracker');
    const { agent } = setup({}, {}, { run: { budgets: { maxSteps: 0 } } });
    const result = await agent.run(makeRequest());
    expect(result).not.toHaveProperty('progressDiagnostics');
    expect(trackerFactory).not.toHaveBeenCalled();
    trackerFactory.mockRestore();
  });

  test('an instrumentation failure cannot turn a real coordinator completion into failure', async () => {
    const original = progress.createProgressTracker;
    const trackerFactory = jest
      .spyOn(progress, 'createProgressTracker')
      .mockImplementation(maxSteps => ({
        ...original(maxSteps),
        observe: () => {
          throw new Error('diagnostic-only failure');
        },
      }));
    try {
      const scenario = setup({
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
      });
      const result = requireStatus(
        await scenario.agent.run(
          makeRequest({
            options: { captureProgressDiagnostics: true },
          })
        ),
        'completed'
      );
      expect(result).not.toHaveProperty('progressDiagnostics');
      expect(scenario.fakeDecider.calls.verifyCompletion).toHaveLength(1);
      expect(scenario.fakeHost.calls.execute).toHaveLength(0);
    } finally {
      trackerFactory.mockRestore();
    }
  });

  test('diagnostics expose only counters and do not distinguish two populated sensitive values', async () => {
    const secret = secretValue();
    const scenario = setup(
      { chooseAction: [deciderOk('action', action('CLICK', 't1'))], classifyCommitment: [routine] },
      {
        observations: [
          page({ elements: [makeElement(), makeSensitiveField({ state: { value: secret } })] }),
          page({
            elements: [
              makeElement(),
              makeSensitiveField({ state: { value: 'other-secret-value' } }),
            ],
          }),
        ],
      }
    );
    const result = await scenario.agent.run(
      makeRequest({
        inputs: { password: secret },
        options: { captureProgressDiagnostics: true, budgets: { maxSteps: 1 } },
      })
    );
    expect(result.progressDiagnostics?.semanticChanges).toBe(0);
    expect(Object.keys(result.progressDiagnostics ?? {}).sort()).toEqual([
      'cosmeticOnlyChanges',
      'maxUnchangedStreak',
      'observations',
      'repeatedStates',
      'scope',
      'semanticChanges',
    ]);
    expect(JSON.stringify(result.progressDiagnostics)).not.toContain(secret);
    expect(JSON.stringify(result.progressDiagnostics)).not.toContain('other-secret-value');
  });

  test('a resumed segment starts a new tracker without checkpoint progress state', async () => {
    const scenario = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [page()] }
    );
    const paused = requireStatus(
      await scenario.agent.run(
        makeRequest({ inputs: { name: 'Ada' }, options: { captureProgressDiagnostics: true } })
      ),
      'needs_input'
    );
    expect(paused.progressDiagnostics?.observations).toBe(1);
    expect(paused.checkpoint).not.toHaveProperty('progressDiagnostics');
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: { name: 'Grace' } },
        options: { budgets: { maxSteps: paused.steps } },
      }),
      'blocked'
    );
    expect(result.progressDiagnostics).toEqual({
      scope: 'active_segment',
      observations: 1,
      semanticChanges: 0,
      cosmeticOnlyChanges: 0,
      repeatedStates: 0,
      maxUnchangedStreak: 0,
    });
  });

  test.each(['request', 'configured', 'resume'] as const)(
    'rejects nonboolean %s flags before any new boundary calls',
    async source => {
      const invalid = { captureProgressDiagnostics: 'yes' } as unknown as TaskRunOptions;
      if (source === 'resume') {
        const scenario = setup(
          {
            chooseAction: [deciderOk('action', action('FILL', 't3'))],
            chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
          },
          { observations: [page()] }
        );
        const paused = requireStatus(await scenario.agent.run(makeRequest()), 'needs_input');
        const before = [...scenario.fakeHost.calls.order];
        const result = requireStatus(
          await scenario.agent.resume({
            checkpoint: paused.checkpoint,
            resolution: { kind: 'inputs', inputs: {} },
            options: invalid,
          }),
          'failed'
        );
        expect(result.error.code).toBe('INVALID_REQUEST');
        expect(scenario.fakeHost.calls.order).toEqual(before);
        return;
      }
      const scenario = setup({}, {}, source === 'configured' ? { run: invalid } : {});
      const result = requireStatus(
        await scenario.agent.run(makeRequest(source === 'request' ? { options: invalid } : {})),
        'failed'
      );
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(scenario.fakeHost.calls.order).toHaveLength(0);
      expect(scenario.fakeDecider.calls.chooseAction).toHaveLength(0);
    }
  );

  test('cancellation keeps the diagnostics for accepted observations and performs no action', async () => {
    const controller = new AbortController();
    const scenario = setup({
      chooseAction: [
        () => {
          controller.abort();
          return deciderOk('action', action('CLICK', 't1'));
        },
      ],
    });
    const result = requireStatus(
      await scenario.agent.run(
        makeRequest({ options: { captureProgressDiagnostics: true } }),
        controller.signal
      ),
      'cancelled'
    );
    expect(result.progressDiagnostics?.observations).toBe(1);
    expect(result.progressDiagnostics?.semanticChanges).toBe(0);
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test('counts returns to earlier semantic states but bounds retained state history', () => {
    const tracker = progress.createProgressTracker(1);
    const numbered = (number: number) =>
      page({ elements: [makeTextField({ state: { value: String(number) } })] });
    tracker.observe(numbered(0));
    tracker.observe(numbered(1));
    tracker.observe(numbered(0));
    expect(tracker.snapshot().repeatedStates).toBe(1);
    for (const number of [2, 3, 4, 5, 0]) tracker.observe(numbered(number));
    expect(tracker.snapshot().repeatedStates).toBe(1);
    expect(tracker.snapshot().semanticChanges).toBe(7);
    const copy = tracker.snapshot();
    tracker.observe(numbered(0));
    expect(copy.observations).toBe(8);
    expect(tracker.snapshot().observations).toBe(9);
  });

  test.each(['own', 'inherited', 'accessor'] as const)(
    'a %s decider initialization marker fails before all host and model calls',
    async kind => {
      const scenario = setup({});
      const decider = {
        ...scenario.fakeDecider.decider,
        ...(kind === 'own' ? { initializationError: 'INVALID_CONFIGURATION' as const } : {}),
      };
      const getter = jest.fn(() => 'INVALID_CONFIGURATION');
      if (kind === 'inherited') {
        Object.setPrototypeOf(decider, { initializationError: 'INVALID_CONFIGURATION' });
      } else if (kind === 'accessor') {
        Object.defineProperty(decider, 'initializationError', { get: getter });
      }
      const agent = createTaskAgent({ host: scenario.fakeHost.host, decider });
      const result = requireStatus(await agent.run(makeRequest()), 'failed');
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.message).toBe('The decider configuration is invalid.');
      expect(scenario.fakeHost.calls.order).toHaveLength(0);
      expect(scenario.fakeDecider.calls.chooseAction).toHaveLength(0);
      expect(getter).not.toHaveBeenCalled();
    }
  );

  test('an invalid custom decider cannot resume a valid checkpoint or release its host', async () => {
    const first = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [page()] },
      { checkpointKey: 'test-resume-initialization-marker' }
    );
    const paused = requireStatus(await first.agent.run(makeRequest()), 'needs_input');
    const second = setup({});
    const agent = createTaskAgent({
      host: second.fakeHost.host,
      decider: { ...second.fakeDecider.decider, initializationError: 'INVALID_CONFIGURATION' },
      options: { checkpointKey: 'test-resume-initialization-marker' },
    });
    const result = requireStatus(
      await agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: {} },
      }),
      'failed'
    );
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(second.fakeHost.calls.order).toHaveLength(0);
    expect(second.fakeDecider.calls.chooseAction).toHaveLength(0);
  });
});
