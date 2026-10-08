/** @jest-environment node */
import { createTaskAgent } from '@/agent/TaskAgent';
import { TASK_DEFAULT_CONFIDENCE, TASK_RESEARCH_PROFILE } from '@/types';
import type { TaskAgentOptions, TaskDeciderConfidenceProfile } from '@/types';
import type { FakeDeciderScript, FakeHostOptions } from './helpers/agent-fixtures';
import {
  counterIds,
  deciderOk,
  makeClock,
  makeCompletionDecision,
  makeFakeDecider,
  makeFakeHost,
  makeObservation,
  makeRequest,
  makeTextField,
} from './helpers/agent-fixtures';
import { action, chooseCandidate, requireStatus, terminal } from './helpers/task-agent-contract';

const profile = (
  floors?: TaskDeciderConfidenceProfile['floors']
): TaskDeciderConfidenceProfile => ({
  kind: 'vendor_reported',
  calibrated: false,
  ...(floors === undefined ? {} : { floors }),
});

const fixture = (
  offeredProfile?: unknown,
  script: FakeDeciderScript = { chooseAction: [deciderOk('action', terminal('BLOCKED'))] },
  options: TaskAgentOptions = {},
  hostOptions: FakeHostOptions = {}
) => {
  const fakeHost = makeFakeHost(hostOptions);
  const fakeDecider = makeFakeDecider(script);
  if (offeredProfile !== undefined) {
    Object.defineProperty(fakeDecider.decider, 'confidenceProfile', {
      value: offeredProfile,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  const agent = createTaskAgent({
    host: fakeHost.host,
    decider: fakeDecider.decider,
    options: { clock: makeClock(), createId: counterIds(), ...options },
  });
  return { agent, fakeHost, fakeDecider };
};

const clickScript = (confidence: number): FakeDeciderScript => ({
  chooseAction: [
    deciderOk('action', { ...action('CLICK', 't1'), confidence }),
    deciderOk('action', terminal('BLOCKED')),
  ],
  classifyCommitment: [
    deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
  ],
});

const pauseScript: FakeDeciderScript = {
  chooseAction: [deciderOk('action', action('FILL', 't3'))],
  chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
};

describe('TaskAgent provider confidence profiles', () => {
  test('absent profiles preserve the result shape, default floors, and warning list', async () => {
    const absent = fixture();
    const explicitUndefined = fixture();
    Object.defineProperty(explicitUndefined.fakeDecider.decider, 'confidenceProfile', {
      value: undefined,
    });
    const undefinedAgent = createTaskAgent({
      host: explicitUndefined.fakeHost.host,
      decider: explicitUndefined.fakeDecider.decider,
      options: { clock: makeClock(), createId: counterIds() },
    });
    const first = await absent.agent.run(makeRequest());
    const second = await undefinedAgent.run(makeRequest());
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('confidenceProfile');
    expect(first.warnings).not.toContainEqual({ code: 'UNCALIBRATED_DECIDER' });
  });

  test('a profile reports default floors and exactly one uncalibrated warning', async () => {
    const scenario = fixture(profile());
    const result = await scenario.agent.run(makeRequest());
    expect(result.confidenceProfile).toEqual({
      kind: 'vendor_reported',
      calibrated: false,
      floors: TASK_DEFAULT_CONFIDENCE,
    });
    expect(result.warnings.filter(warning => warning.code === 'UNCALIBRATED_DECIDER')).toEqual([
      { code: 'UNCALIBRATED_DECIDER' },
    ]);
  });

  test.each(['normalized_entropy', 'unknown'] as const)(
    '%s semantics are caller metadata and calibrated true omits the warning',
    async kind => {
      const result = await fixture({ kind, calibrated: true }).agent.run(makeRequest());
      expect(result.confidenceProfile?.kind).toBe(kind);
      expect(result.confidenceProfile?.calibrated).toBe(true);
      expect(result.warnings).not.toContainEqual({ code: 'UNCALIBRATED_DECIDER' });
    }
  );

  test('request profile, configured run options, and request options override provider defaults in order', async () => {
    const scenario = fixture(
      profile({ action: 0.9, argument: 0.92, commitment: 0.93, completion: 0.94 }),
      undefined,
      { run: { confidence: { argument: 0.65, commitment: 0.8 } } }
    );
    const result = await scenario.agent.run(
      makeRequest({
        profile: {
          ...TASK_RESEARCH_PROFILE,
          confidence: { action: 0.7, argument: 0.8, commitment: 0.85 },
        },
        options: { confidence: { commitment: 0.72 } },
      })
    );
    expect(result.confidenceProfile?.floors).toEqual({
      action: 0.7,
      argument: 0.65,
      commitment: 0.72,
      completion: 0.94,
    });
  });

  test('construction captures nested profile data and ignores later object/property replacement', async () => {
    const mutable = {
      kind: 'vendor_reported' as const,
      calibrated: false,
      floors: { action: 0.8 },
    };
    const scenario = fixture(mutable, clickScript(0.7));
    mutable.floors.action = 0.1;
    mutable.calibrated = true;
    Object.defineProperty(scenario.fakeDecider.decider, 'confidenceProfile', {
      value: { kind: 'unknown', calibrated: true, floors: { action: 0 } },
    });
    const result = requireStatus(
      await scenario.agent.run(makeRequest({ options: { budgets: { maxInvalidDecisions: 0 } } })),
      'blocked'
    );
    expect(result.reason).toBe('MODEL_UNCERTAIN');
    expect(result.confidenceProfile?.floors.action).toBe(0.8);
    expect(result.confidenceProfile?.calibrated).toBe(false);
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test('profile floors reject low-confidence actions while explicit caller floors can accept them', async () => {
    const rejected = fixture(profile({ action: 0.8 }), clickScript(0.7));
    const accepted = fixture(profile({ action: 0.8 }), clickScript(0.7));
    const first = requireStatus(
      await rejected.agent.run(makeRequest({ options: { budgets: { maxInvalidDecisions: 0 } } })),
      'blocked'
    );
    const second = await accepted.agent.run(
      makeRequest({ options: { confidence: { action: 0.6 } } })
    );
    expect(first.reason).toBe('MODEL_UNCERTAIN');
    expect(rejected.fakeHost.calls.execute).toHaveLength(0);
    expect(accepted.fakeHost.calls.execute).toHaveLength(1);
    expect(second.confidenceProfile?.floors.action).toBe(0.6);
  });

  test('provider completion floors remain completion gates rather than metadata alone', async () => {
    const script: FakeDeciderScript = {
      chooseAction: [deciderOk('action', terminal('DONE'))],
      verifyCompletion: [deciderOk('completion', makeCompletionDecision({ confidence: 0.7 }))],
    };
    const strict = fixture(profile({ completion: 0.8 }), script);
    const explicit = fixture(profile({ completion: 0.8 }), script);
    const failed = await strict.agent.run(
      makeRequest({ options: { budgets: { maxPrematureDone: 0 } } })
    );
    const accepted = await explicit.agent.run(
      makeRequest({ options: { confidence: { completion: 0.65 } } })
    );
    expect(failed.status).toBe('blocked');
    expect(accepted.status).toBe('completed');
    expect(strict.fakeHost.calls.execute).toHaveLength(0);
    expect(explicit.fakeHost.calls.execute).toHaveLength(0);
  });

  test('argument floors refuse a real offered value below the effective floor', async () => {
    const script: FakeDeciderScript = {
      chooseAction: [deciderOk('action', action('FILL', 't3'))],
      chooseArgument: [
        request => {
          const chosen = chooseCandidate(request, candidate => candidate.source === 'input');
          if (!chosen.ok) {
            throw new Error('candidate fixture failed');
          }
          return deciderOk('argument', { ...chosen.decision, confidence: 0.7 });
        },
      ],
    };
    const scenario = fixture(
      profile({ argument: 0.8 }),
      script,
      {},
      {
        observations: [makeObservation({ elements: [makeTextField()] })],
      }
    );
    const result = requireStatus(
      await scenario.agent.run(
        makeRequest({
          inputs: { name: 'Ada' },
          options: { budgets: { maxInvalidDecisions: 0 } },
        })
      ),
      'blocked'
    );
    expect(result.reason).toBe('MODEL_UNCERTAIN');
    expect(scenario.fakeDecider.calls.chooseArgument).toHaveLength(1);
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test('commitment floors are sent to classification and low-confidence NONE cannot authorize effects', async () => {
    const scenario = fixture(profile({ commitment: 0.9 }), {
      chooseAction: [deciderOk('action', action('CLICK', 't1'))],
      classifyCommitment: [
        deciderOk('commitment', {
          commitment: 'NONE',
          confidence: 0.8,
          agreement: 'single',
        }),
      ],
    });
    const result = requireStatus(await scenario.agent.run(makeRequest()), 'awaiting_approval');
    expect(scenario.fakeDecider.calls.classifyCommitment[0]?.request.confidenceFloor).toBe(0.9);
    expect(result.approval.effects).toContain('other_commitment');
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test.each([
    null,
    [],
    { kind: 'other', calibrated: false },
    { kind: 'vendor_reported', calibrated: 'yes' },
    { kind: 'vendor_reported', calibrated: false, floors: { action: -0.1 } },
    { kind: 'vendor_reported', calibrated: false, floors: { action: 1.1 } },
    { kind: 'vendor_reported', calibrated: false, floors: { completion: NaN } },
    { kind: 'vendor_reported', calibrated: false, floors: { commitment: Infinity } },
    { kind: 'vendor_reported', calibrated: false, floors: { arbitrary: 0.5 } },
    { kind: 'vendor_reported', calibrated: false, id: 'private-provider-identifier' },
  ])('invalid profile %p fails before every host/model boundary', async offered => {
    const scenario = fixture(offered);
    const result = requireStatus(await scenario.agent.run(makeRequest()), 'failed');
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(scenario.fakeHost.calls.order).toEqual([]);
    expect(scenario.fakeDecider.calls.chooseAction).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('private-provider-identifier');
    expect(result).not.toHaveProperty('confidenceProfile');
  });

  test('profile property and nested floor accessors are rejected without invoking them', async () => {
    const profileGetter = jest.fn(() => profile());
    const floorGetter = jest.fn(() => 0.9);
    const fakeHost = makeFakeHost();
    const fakeDecider = makeFakeDecider();
    Object.defineProperty(fakeDecider.decider, 'confidenceProfile', { get: profileGetter });
    const accessorAgent = createTaskAgent({ host: fakeHost.host, decider: fakeDecider.decider });
    const nested = fixture({
      kind: 'vendor_reported',
      calibrated: false,
      floors: Object.defineProperty({}, 'action', { get: floorGetter, enumerable: true }),
    });
    expect(requireStatus(await accessorAgent.run(makeRequest()), 'failed').error.code).toBe(
      'INVALID_REQUEST'
    );
    expect(requireStatus(await nested.agent.run(makeRequest()), 'failed').error.code).toBe(
      'INVALID_REQUEST'
    );
    expect(profileGetter).not.toHaveBeenCalled();
    expect(floorGetter).not.toHaveBeenCalled();
    expect(fakeHost.calls.order).toEqual([]);
    expect(nested.fakeHost.calls.order).toEqual([]);
  });

  test('malformed profile resume fails INVALID_REQUEST before host/model or checkpoint processing', async () => {
    const first = fixture(
      undefined,
      pauseScript,
      { checkpointKey: 'profile-test-key' },
      {
        observations: [makeObservation({ elements: [makeTextField()] })],
      }
    );
    const paused = requireStatus(await first.agent.run(makeRequest()), 'needs_input');
    const second = fixture(
      { kind: 'vendor_reported', calibrated: false, floors: { action: NaN } },
      undefined,
      { checkpointKey: 'profile-test-key' }
    );
    const result = requireStatus(
      await second.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: { name: 'Ada' } },
      }),
      'failed'
    );
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(second.fakeHost.calls.order).toEqual([]);
    expect(second.fakeDecider.calls.chooseAction).toHaveLength(0);
  });

  test('resume takes the maximum of saved floors, new provider floors, and explicit resume tightening', async () => {
    const first = fixture(
      profile({ action: 0.7, argument: 0.8, completion: 0.9 }),
      pauseScript,
      { checkpointKey: 'profile-test-key' },
      {
        observations: [makeObservation({ elements: [makeTextField()] })],
      }
    );
    const paused = requireStatus(await first.agent.run(makeRequest()), 'needs_input');
    expect(paused.checkpoint.request.options.confidence).toEqual({
      action: 0.7,
      argument: 0.8,
      commitment: 0.5,
      completion: 0.9,
    });
    const second = fixture(profile({ action: 0.9, argument: 0.1, completion: 0.2 }), undefined, {
      checkpointKey: 'profile-test-key',
    });
    const resumed = await second.agent.resume({
      checkpoint: paused.checkpoint,
      resolution: { kind: 'inputs', inputs: { name: 'Ada' } },
      options: { confidence: { action: 0.1, argument: 0.85, commitment: 0.4, completion: 0.2 } },
    });
    expect(resumed.confidenceProfile?.floors).toEqual({
      action: 0.9,
      argument: 0.85,
      commitment: 0.5,
      completion: 0.9,
    });
    expect(resumed.warnings.filter(warning => warning.code === 'UNCALIBRATED_DECIDER')).toEqual([
      { code: 'UNCALIBRATED_DECIDER' },
    ]);
  });

  test('result mutations cannot change saved floors or later profile reports', async () => {
    const scenario = fixture(profile({ action: 0.8 }), {
      chooseAction: [
        deciderOk('action', terminal('BLOCKED')),
        deciderOk('action', terminal('BLOCKED')),
      ],
    });
    const first = await scenario.agent.run(makeRequest());
    Object.assign(first.confidenceProfile?.floors ?? {}, { action: 0 });
    const second = await scenario.agent.run(makeRequest());
    expect(second.confidenceProfile?.floors.action).toBe(0.8);
  });

  test('a new provider floor tightened on resume blocks an action above the saved floor', async () => {
    const first = fixture(
      profile({ action: 0.6 }),
      pauseScript,
      { checkpointKey: 'profile-test-key' },
      {
        observations: [makeObservation({ elements: [makeTextField()] })],
      }
    );
    const paused = requireStatus(await first.agent.run(makeRequest()), 'needs_input');
    const second = fixture(profile({ action: 0.9 }), clickScript(0.7), {
      checkpointKey: 'profile-test-key',
    });
    const result = requireStatus(
      await second.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: { name: 'Ada' } },
        options: { budgets: { maxInvalidDecisions: 0 }, confidence: { action: 0.1 } },
      }),
      'blocked'
    );
    expect(result.reason).toBe('MODEL_UNCERTAIN');
    expect(result.confidenceProfile?.floors.action).toBe(0.9);
    expect(second.fakeHost.calls.execute).toHaveLength(0);
  });
});
