/** @jest-environment node */
import { createTaskAgent } from '@/agent/TaskAgent';
import { commandDigest } from '@/agent/commands';
import type { TaskAgentOptions, TaskApprovalResolution, TaskCheckpoint } from '@/types';
import {
  counterIds,
  deciderOk,
  makeClock,
  makeCompletionDecision,
  makeElement,
  makeManualClock,
  makeLedgerEntry,
  makeObservation,
  makeOutcome,
  makeRequest,
  makeTextField,
  roundTrip,
} from './helpers/agent-fixtures';
import {
  action,
  approvalResolution,
  chooseCandidate,
  requireStatus,
  secretValue,
  setup,
  terminal,
} from './helpers/task-agent-contract';

function approvalScenario(options: TaskAgentOptions = {}, changed = makeObservation()) {
  return setup(
    {
      chooseAction: [
        deciderOk('action', action('CLICK', 't1')),
        deciderOk('action', terminal('DONE')),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'PURCHASE', confidence: 0.99, agreement: 'single' }),
      ],
      verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
    },
    { observations: [makeObservation(), changed] },
    options
  );
}

async function pauseForApproval(scenario: ReturnType<typeof approvalScenario>) {
  return requireStatus(await scenario.agent.run(makeRequest()), 'awaiting_approval');
}

describe('TaskAgent checkpoint integrity, rebinding and approval consumption', () => {
  test('same-instance resume retains prior digest exclusions', async () => {
    const target = makeElement();
    const observation = makeObservation({ elements: [target, makeTextField()] });
    const digest = commandDigest({
      command: {
        operation: 'CLICK',
        target: {
          sessionId: observation.sessionId,
          snapshotId: observation.snapshotId,
          targetId: target.id,
          signature: target.signature,
        },
      },
      effects: ['interact'],
      origin: observation.origin,
      target,
    });
    const scenario = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          deciderOk('action', action('CLICK', target.id)),
        ],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      { observations: [observation] }
    );
    const paused = requireStatus(
      await scenario.agent.run(
        makeRequest({
          priorEffects: [{ digest, effects: ['interact'], resolution: 'applied' }],
          options: { budgets: { maxInvalidDecisions: 0 } },
        })
      ),
      'needs_input'
    );
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: {} },
      }),
      'blocked'
    );
    expect(result.reason).toBe('MODEL_UNCERTAIN');
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test('HMAC continuation with prior effects fails closed on another instance', async () => {
    const checkpointKey = 'test-prior-checkpoint-key';
    const first = approvalScenario({ checkpointKey });
    const paused = requireStatus(
      await first.agent.run(
        makeRequest({
          priorEffects: [
            { digest: 'dg_' + '9'.repeat(32), effects: ['read'], resolution: 'applied' },
          ],
        })
      ),
      'awaiting_approval'
    );
    const second = approvalScenario({ checkpointKey });
    const result = requireStatus(
      await second.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'failed'
    );
    expect(result.error.code).toBe('CHECKPOINT_INVALID');
    expect(second.fakeHost.calls.observe).toHaveLength(0);
    expect(second.fakeHost.calls.execute).toHaveLength(0);
  });

  test('active wall time accumulates across resumes while time paused is excluded', async () => {
    const clock = makeManualClock();
    const scenario = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          () => {
            clock.advance(5);
            return deciderOk('action', terminal('DONE'));
          },
        ],
        chooseArgument: [
          () => {
            clock.advance(6);
            return deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 });
          },
        ],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] },
      { clock: clock.now }
    );
    const paused = requireStatus(
      await scenario.agent.run(
        makeRequest({ inputs: { name: 'Ada' }, options: { budgets: { maxWallTimeMs: 10 } } })
      ),
      'needs_input'
    );
    expect(paused.checkpoint.usage.elapsedMs).toBe(6);
    clock.advance(1000);
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: { name: 'Grace' } },
      }),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('maxWallTimeMs');
    expect(scenario.fakeDecider.calls.chooseAction).toHaveLength(2);
  });

  test('needs-input checkpoint is JSON, omits secrets, and input resume keeps run/session ids', async () => {
    const secret = secretValue();
    const { agent, fakeHost } = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const paused = requireStatus(
      await agent.run(makeRequest({ inputs: { password: secret, name: 'Ada' } })),
      'needs_input'
    );
    expect(roundTrip(paused.checkpoint)).toEqual(paused.checkpoint);
    expect(JSON.stringify(paused.checkpoint).includes(secret)).toBe(false);
    expect(paused.checkpoint.request.sensitivePaths).toContain('password');
    expect(paused.checkpoint.request.inputs).toEqual({ name: 'Ada' });
    const result = requireStatus(
      await agent.resume({
        checkpoint: roundTrip(paused.checkpoint),
        resolution: { kind: 'inputs', inputs: { name: 'Grace', password: secret } },
      }),
      'blocked'
    );
    expect(result.runId).toBe(paused.runId);
    expect(result.sessionId).toBe(paused.sessionId);
    expect(result.goal).toBe(paused.goal);
    expect(fakeHost.calls.release).toEqual([paused.sessionId, paused.sessionId]);
  });

  test('resume pauses again before observing when omitted secret paths were not rebound', async () => {
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const paused = requireStatus(
      await agent.run(makeRequest({ inputs: { password: secretValue(), name: 'Ada' } })),
      'needs_input'
    );
    const before = fakeHost.calls.observe.length;
    const result = requireStatus(
      await agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: { name: 'Grace' } },
      }),
      'needs_input'
    );
    expect(result.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'sensitive_input', inputPath: 'password' }),
      ])
    );
    expect(fakeHost.calls.observe).toHaveLength(before);
  });

  test('omitSensitivePaths permits continuation without an unused secret', async () => {
    const { agent } = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const paused = requireStatus(
      await agent.run(makeRequest({ inputs: { password: secretValue(), name: 'Ada' } })),
      'needs_input'
    );
    const result = await agent.resume({
      checkpoint: paused.checkpoint,
      resolution: { kind: 'inputs', inputs: { name: 'Grace' } },
      omitSensitivePaths: ['password'],
    });
    expect(result.status).toBe('blocked');
  });

  test.each([undefined, 'test-checkpoint-key'])(
    'authorization, ledger and grant edits fail integrity with key=%s',
    async checkpointKey => {
      for (const mutation of ['authorization', 'ledger', 'grants'] as const) {
        const scenario = approvalScenario({ checkpointKey });
        const paused = await pauseForApproval(scenario);
        const checkpoint = roundTrip(paused.checkpoint);
        const edited: TaskCheckpoint =
          mutation === 'authorization'
            ? {
                ...checkpoint,
                request: {
                  ...checkpoint.request,
                  authorization: {
                    ...checkpoint.request.authorization,
                    origins: ['https://attacker.example.test'],
                  },
                },
              }
            : mutation === 'ledger'
              ? { ...checkpoint, ledger: [makeLedgerEntry()] }
              : {
                  ...checkpoint,
                  request: {
                    ...checkpoint.request,
                    authorization: {
                      ...checkpoint.request.authorization,
                      grants: [
                        {
                          effect: 'purchase',
                          origins: [checkpoint.startOrigin],
                          used: 0,
                          maxUses: null,
                          expiresAt: null,
                          signatures: null,
                        },
                      ],
                    },
                  },
                };
        const result = requireStatus(
          await scenario.agent.resume({
            checkpoint: edited,
            resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
          }),
          'failed'
        );
        expect(result.error.code).toBe('CHECKPOINT_INVALID');
        expect(scenario.fakeHost.calls.execute).toHaveLength(0);
      }
    }
  );

  test('SHA checkpoint requires the issuing instance registry, even when its hash is valid', async () => {
    const first = approvalScenario();
    const paused = await pauseForApproval(first);
    const other = approvalScenario();
    const result = requireStatus(
      await other.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'failed'
    );
    expect(result.error.code).toBe('CHECKPOINT_INVALID');
    expect(other.fakeHost.calls.observe).toHaveLength(0);
  });

  test('HMAC checkpoint can resume on another instance with the same key', async () => {
    const checkpointKey = 'test-checkpoint-key';
    const first = approvalScenario({ checkpointKey });
    const paused = await pauseForApproval(first);
    const other = setup(
      {
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
      },
      {},
      { checkpointKey }
    );
    const result = requireStatus(
      await other.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'completed'
    );
    expect(result.runId).toBe(paused.runId);
    expect(other.fakeHost.calls.execute).toHaveLength(1);
  });

  test('unsafe checkpoint keys are refused before any observation', async () => {
    const scenario = approvalScenario();
    const paused = await pauseForApproval(scenario);
    const checkpoint = JSON.parse(
      JSON.stringify(paused.checkpoint).replace(
        '"version":1',
        '"version":1,"__proto__":{"polluted":true}'
      )
    ) as TaskCheckpoint;
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'failed'
    );
    expect(result.error.code).toBe('CHECKPOINT_INVALID');
    expect(scenario.fakeHost.calls.observe).toHaveLength(1);
  });

  test('approval is rebound to a fresh snapshot and consumed before execution; replay never executes twice', async () => {
    const order: string[] = [];
    const scenario = approvalScenario({
      beforeExecute: () => {
        order.push('beforeExecute');
      },
      consumeApproval: async () => {
        order.push('consume');
        return true;
      },
    });
    const host = {
      ...scenario.fakeHost.host,
      execute: async (...args: Parameters<typeof scenario.fakeHost.host.execute>) => {
        order.push('execute');
        return scenario.fakeHost.host.execute(...args);
      },
    };
    const agent = createTaskAgent({
      host,
      decider: scenario.fakeDecider.decider,
      options: {
        clock: makeClock(),
        createId: counterIds(),
        beforeExecute: () => {
          order.push('beforeExecute');
        },
        consumeApproval: async () => {
          order.push('consume');
          return true;
        },
      },
    });
    const paused = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    const request = {
      checkpoint: paused.checkpoint,
      resolution: { kind: 'approval' as const, resolution: approvalResolution(paused.approval) },
    };
    requireStatus(await agent.resume(request), 'completed');
    expect(order).toEqual(['beforeExecute', 'consume', 'execute']);
    expect(scenario.fakeHost.calls.execute[0]?.scope.snapshotId).not.toBe(
      paused.approval.snapshotId
    );
    expect(scenario.fakeHost.calls.execute[0]?.command).toMatchObject({
      operation: 'CLICK',
      target: { signature: paused.approval.command.target?.signature },
    });
    const replay = requireStatus(await agent.resume(request), 'failed');
    expect(replay.error.code).toBe('APPROVAL_CONSUMED');
    expect(scenario.fakeHost.calls.execute).toHaveLength(1);
  });

  test('cross-process consumeApproval refusal fails closed before host execution', async () => {
    const consumeApproval = jest.fn(async () => false);
    const scenario = approvalScenario({ consumeApproval });
    const paused = await pauseForApproval(scenario);
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'failed'
    );
    expect(result.error.code).toBe('APPROVAL_CONSUMED');
    expect(consumeApproval).toHaveBeenCalledWith(paused.approval.id);
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test.each(['nonce', 'digest', 'contextDigest', 'approvalId'] as const)(
    'mismatched %s refuses approval without execution',
    async field => {
      const scenario = approvalScenario();
      const paused = await pauseForApproval(scenario);
      const resolution: TaskApprovalResolution = {
        ...approvalResolution(paused.approval),
        [field]: 'mismatched',
      };
      const result = requireStatus(
        await scenario.agent.resume({
          checkpoint: paused.checkpoint,
          resolution: { kind: 'approval', resolution },
        }),
        'failed'
      );
      expect(result.error.code).toBe('APPROVAL_MISMATCH');
      expect(scenario.fakeHost.calls.execute).toHaveLength(0);
    }
  );

  test('denial ends the run with POLICY_DENIED and never materializes or executes', async () => {
    const scenario = approvalScenario();
    const paused = await pauseForApproval(scenario);
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: {
          kind: 'approval',
          resolution: approvalResolution(paused.approval, { decision: 'deny' }),
        },
      }),
      'blocked'
    );
    expect(result.reason).toBe('POLICY_DENIED');
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test('expired approval is refused using the coordinator clock', async () => {
    const clock = makeManualClock();
    const scenario = approvalScenario({ clock: clock.now });
    const paused = await pauseForApproval(scenario);
    clock.set(paused.approval.expiresAt + 1);
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'failed'
    );
    expect(result.error.code).toBe('APPROVAL_EXPIRED');
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test.each([
    ['document change', makeObservation({ documentId: 'doc_000000000002' })],
    [
      'target signature change',
      makeObservation({ elements: [makeElement({ signature: 'sg_9000000000000000' })] }),
    ],
    [
      'review context change',
      makeObservation({
        elements: [
          makeElement({ region: 'Order summary' }),
          makeElement({
            id: 't2',
            signature: 'sg_1000000000000000',
            kind: 'passage',
            region: 'Order summary',
            operations: ['READ'],
            text: 'Order total changed',
          }),
        ],
      }),
    ],
  ])('%s voids approval and requires a new concrete review', async (_name, changed) => {
    const scenario = setup(
      {
        chooseAction: [
          deciderOk('action', action('CLICK', 't1')),
          deciderOk('action', action('CLICK', 't1')),
        ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'PURCHASE',
            confidence: 0.99,
            agreement: 'single',
          }),
          deciderOk('commitment', {
            commitment: 'PURCHASE',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      },
      {
        observations: [
          _name === 'review context change'
            ? makeObservation({
                elements: [
                  makeElement({ region: 'Order summary' }),
                  makeElement({
                    id: 't2',
                    signature: 'sg_1000000000000000',
                    kind: 'passage',
                    region: 'Order summary',
                    operations: ['READ'],
                    text: 'Original order total',
                  }),
                ],
              })
            : makeObservation(),
          changed,
        ],
      }
    );
    const paused = requireStatus(
      await scenario.agent.run(makeRequest({ options: { captureTrace: true } })),
      'awaiting_approval'
    );
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
      }),
      'awaiting_approval'
    );
    expect(result.approval.id).not.toBe(paused.approval.id);
    expect(result.trace).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'approval', phase: 'void' })])
    );
    expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  });

  test('resolving uncertain effect applied completes without a second execution', async () => {
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
      { outcomes: [makeOutcome('uncertain', 'uncertain')] }
    );
    const blocked = requireStatus(
      await scenario.agent.run(makeRequest({ options: { budgets: { maxUncertainEffects: 0 } } })),
      'blocked'
    );
    expect(blocked.checkpoint).toBeDefined();
    if (blocked.checkpoint === undefined) throw new Error('uncertainty checkpoint missing');
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: blocked.checkpoint,
        resolution: { kind: 'effect', ledgerSeq: 1, resolution: 'applied' },
      }),
      'completed'
    );
    expect(result.unresolvedUncertain).toEqual([]);
    expect(result.completion.resolvedUncertain).toEqual(
      expect.arrayContaining([expect.objectContaining({ by: 'caller', effect: 'applied' })])
    );
    expect(scenario.fakeHost.calls.execute).toHaveLength(1);
  });

  test('resume cannot increase the original step budget', async () => {
    const scenario = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          deciderOk('action', terminal('DONE')),
        ],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const paused = requireStatus(
      await scenario.agent.run(
        makeRequest({ inputs: { name: 'Ada' }, options: { budgets: { maxSteps: 1 } } })
      ),
      'needs_input'
    );
    const result = requireStatus(
      await scenario.agent.resume({
        checkpoint: paused.checkpoint,
        resolution: { kind: 'inputs', inputs: { name: 'Grace' } },
        options: { budgets: { maxSteps: 100 } },
      }),
      'blocked'
    );
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('maxSteps');
    expect(scenario.fakeDecider.calls.chooseAction).toHaveLength(1);
  });
});
