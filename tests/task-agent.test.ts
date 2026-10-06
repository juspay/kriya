/** @jest-environment node */
import { createTaskPolicy } from '@/agent/policy';
import { TASK_LIMITS, TASK_REDACTED } from '@/types';
import { commandDigest } from '@/agent/commands';
import type {
  TaskActionDecision,
  TaskChooseActionRequest,
  TaskHostResult,
  TaskObservation,
} from '@/types';
import {
  FIXTURE_ORIGIN,
  deciderFail,
  deciderOk,
  makeActionDecision,
  makeCapabilities,
  makeCompletionDecision,
  makeElement,
  makeObservation,
  makeLedgerEntry,
  makeOutcome,
  makeRequest,
  makeSensitiveField,
  makeTextField,
} from './helpers/agent-fixtures';
import {
  action,
  chooseCandidate,
  deferred,
  requireStatus,
  secretValue,
  setup,
  terminal,
} from './helpers/task-agent-contract';

describe('TaskAgent request and decision contract', () => {
  test.each(['applied', 'unknown'] as const)(
    'prior %s digest is excluded without execution',
    async resolution => {
      const observation = makeObservation();
      const target = observation.elements[0];
      if (!target) {
        throw new Error('fixture target is absent');
      }
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
      const { agent, fakeHost } = setup({
        chooseAction: [deciderOk('action', action('CLICK', target.id))],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      const result = requireStatus(
        await agent.run(
          makeRequest({
            priorEffects: [{ digest, effects: ['interact'], resolution }],
            options: { budgets: { maxInvalidDecisions: 0 } },
          })
        ),
        'blocked'
      );
      expect(result.reason).toBe('MODEL_UNCERTAIN');
      expect(fakeHost.calls.execute).toHaveLength(0);
    }
  );
  test('unknown prior commitment joins pending commitments and outranks a standing grant', async () => {
    const defaultPolicy = createTaskPolicy();
    const evaluate = jest.fn(defaultPolicy.evaluate);
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('CLICK', 't1'))],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'PURCHASE',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      },
      {},
      {},
      { ...defaultPolicy, evaluate }
    );
    const digest = 'dg_' + '7'.repeat(32);
    const result = requireStatus(
      await agent.run(
        makeRequest({
          priorEffects: [{ digest, effects: ['purchase'], resolution: 'unknown' }],
          authorization: { effects: ['purchase'] },
        })
      ),
      'awaiting_approval'
    );
    expect(result.approval.reason).toBe('uncertain_commitment_pending');
    expect(evaluate.mock.calls[0]?.[0].pendingCommitments).toEqual(
      expect.arrayContaining([expect.objectContaining({ digest, effects: ['purchase'] })])
    );
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('resolver is invoked lazily only after policy allows its chosen reference', async () => {
    const resolve = jest.fn(async () => ({ ok: true as const, value: 'Ada' }));
    const resolver = {
      id: 'name',
      description: 'Caller name provider',
      sensitive: false,
      slots: ['value' as const],
      resolve,
    };
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.source === 'resolver'),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] },
      { resolvers: [resolver] },
      createTaskPolicy({
        onUnauthorized: 'deny',
        classifyOperations: ['FILL'],
        classify: () => 'SEND',
      })
    );
    const result = requireStatus(await agent.run(makeRequest()), 'blocked');
    expect(result.reason).toBe('POLICY_DENIED');
    expect(resolve).not.toHaveBeenCalled();
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test.each(['refused', 'unavailable'] as const)(
    'resolver %s returns a concrete requirement',
    async code => {
      const resolve = jest.fn(async () => ({
        ok: false as const,
        code,
        message: 'unavailable fixture',
      }));
      const { agent, fakeHost } = setup(
        {
          chooseAction: [deciderOk('action', action('FILL', 't3'))],
          chooseArgument: [
            request => chooseCandidate(request, candidate => candidate.source === 'resolver'),
          ],
        },
        { observations: [makeObservation({ elements: [makeTextField()] })] },
        {
          resolvers: [
            {
              id: 'name',
              description: 'Caller name provider',
              sensitive: false,
              slots: ['value'],
              resolve,
            },
          ],
        }
      );
      const result = requireStatus(await agent.run(makeRequest()), 'needs_input');
      expect(result.requirements[0]?.reason).toBe(
        code === 'refused' ? 'resolver_refused' : 'resolver_unavailable'
      );
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(fakeHost.calls.execute).toHaveLength(0);
    }
  );

  test('resolver exception is scrubbed and returns RESOLVER_FAILED', async () => {
    const secret = secretValue();
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't8'))],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.source === 'resolver'),
        ],
      },
      { observations: [makeObservation({ elements: [makeSensitiveField()] })] },
      {
        resolvers: [
          {
            id: 'credential',
            description: 'Caller credential provider',
            sensitive: true,
            slots: ['value'],
            resolve: async () => {
              throw new Error(secret);
            },
          },
        ],
      }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ inputs: { password: secret } })),
      'failed'
    );
    expect(result.error.code).toBe('RESOLVER_FAILED');
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test.each(['maxStaleRetries', 'maxRejectedCommands', 'maxUncertainEffects'] as const)(
    '%s tolerates one occurrence and stops at two',
    async budget => {
      const second = makeElement({ id: 't9' });
      const outcome =
        budget === 'maxStaleRetries'
          ? makeOutcome('rejected_stale', 'none', { staleReason: 'element_missing' })
          : budget === 'maxRejectedCommands'
            ? makeOutcome('rejected_invalid', 'none', { code: 'TARGET_DISABLED' })
            : makeOutcome('uncertain', 'uncertain');
      const { agent, fakeHost } = setup(
        {
          chooseAction: [
            deciderOk('action', action('CLICK', 't1')),
            deciderOk('action', action('CLICK', 't9')),
          ],
          classifyCommitment: [
            deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
            deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
          ],
        },
        {
          observations: [
            makeObservation(),
            makeObservation({ elements: [second], fingerprint: 'changed' }),
          ],
          outcomes: [outcome, outcome],
        }
      );
      const result = requireStatus(
        await agent.run(makeRequest({ options: { budgets: { [budget]: 1 } } })),
        'blocked'
      );
      expect(result.reason).toBe(
        budget === 'maxStaleRetries'
          ? 'STALE_LIMIT'
          : budget === 'maxRejectedCommands'
            ? 'COMMANDS_REJECTED'
            : 'UNCERTAIN_EFFECT'
      );
      expect(fakeHost.calls.execute).toHaveLength(2);
    }
  );

  test('no-progress budget tolerates one unchanged post-action observation then blocks at two', async () => {
    const page = makeObservation({ elements: [makeElement(), makeElement({ id: 't9' })] });
    const { agent, fakeHost } = setup(
      {
        chooseAction: [
          deciderOk('action', action('CLICK', 't1')),
          deciderOk('action', action('CLICK', 't9')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      { observations: [page] }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ options: { budgets: { maxNoProgress: 1 } } })),
      'blocked'
    );
    expect(result.reason).toBe('NO_PROGRESS');
    expect(fakeHost.calls.execute).toHaveLength(2);
  });

  test.each([
    ['blank', { goal: ' \t ' }],
    ['UTF-8 byte cap', { goal: '🙂'.repeat(Math.floor(TASK_LIMITS.goalBytes / 4) + 1) }],
    ['non-http start URL', { startUrl: 'javascript:void(0)' }],
    [
      'duplicate declaration path',
      {
        inputDeclarations: [
          { path: 'name', sensitive: false },
          { path: 'name', sensitive: false },
        ],
      },
    ],
    [
      'description control character',
      { inputDeclarations: [{ path: 'name', sensitive: false, description: 'line\nline' }] },
    ],
    [
      'description too long',
      {
        inputDeclarations: [
          {
            path: 'name',
            sensitive: false,
            description: 'x'.repeat(TASK_LIMITS.descriptionChars + 1),
          },
        ],
      },
    ],
  ])('rejects %s before observing or deciding', async (_name, request) => {
    const { agent, fakeHost, fakeDecider } = setup({});
    const result = requireStatus(await agent.run(makeRequest(request)), 'failed');
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(result.lastEffect).toBe('none');
    expect(result.unresolvedUncertain).toEqual([]);
    expect(fakeHost.calls.observe).toHaveLength(0);
    expect(fakeDecider.calls.chooseAction).toHaveLength(0);
  });

  test('one active run refuses a second run and allows the original to finish', async () => {
    const waiting = deferred<TaskHostResult<TaskObservation>>();
    const entered = deferred<void>();
    const original = setup({ chooseAction: [deciderOk('action', terminal('BLOCKED'))] });
    const host = {
      ...original.fakeHost.host,
      observe: async () => {
        entered.resolve();
        return waiting.promise;
      },
    };
    const { createTaskAgent } = await import('@/agent/TaskAgent');
    const agent = createTaskAgent({ host, decider: original.fakeDecider.decider });
    const first = agent.run(makeRequest());
    await entered.promise;
    const second = requireStatus(await agent.run(makeRequest({ goal: 'Another goal' })), 'failed');
    expect(second.error.code).toBe('RUN_IN_PROGRESS');
    waiting.resolve({
      ok: false,
      error: { code: 'OBSERVE_FAILED', message: 'stop', retryable: false },
    });
    await expect(first).resolves.toMatchObject({ status: 'failed' });
  });

  test.each([
    ['unoffered operation', makeActionDecision({ operation: 'READ' })],
    ['foreign target', makeActionDecision({ target: { kind: 'target', id: 't999' } })],
    ['none appropriate', makeActionDecision({ target: { kind: 'none_appropriate' } })],
    [
      'below confidence',
      makeActionDecision({ confidence: 0.01, operationConfidence: 0.01, targetConfidence: 0.01 }),
    ],
  ])('rejects %s without dispatch and counts N then N+1', async (_name, decision) => {
    const { agent, fakeHost, fakeDecider } = setup({
      chooseAction: [deciderOk('action', decision), deciderOk('action', decision)],
    });
    const result = requireStatus(
      await agent.run(
        makeRequest({ options: { budgets: { maxInvalidDecisions: 1 }, captureTrace: true } })
      ),
      'blocked'
    );
    expect(result.reason).toBe('MODEL_UNCERTAIN');
    expect(fakeDecider.calls.chooseAction).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('rejects an invented argument candidate rather than passing text to host', async () => {
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [
          deciderOk('argument', { kind: 'candidate', candidateId: 'invented', confidence: 0.99 }),
        ],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({ inputs: { name: 'Ada' }, options: { budgets: { maxInvalidDecisions: 0 } } })
      ),
      'blocked'
    );
    expect(result.reason).toBe('MODEL_UNCERTAIN');
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('a missing target does not remove every target for the operation on an unchanged page', async () => {
    const observation = makeObservation();
    const target = observation.elements[0];
    if (!target) {
      throw new Error('fixture target is absent');
    }
    const { agent, fakeHost, fakeDecider } = setup(
      {
        chooseAction: [
          deciderOk('action', makeActionDecision({ target: { kind: 'none_appropriate' } })),
          deciderOk('action', action('CLICK', target.id)),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'agreed' }),
        ],
      },
      { observations: [observation] }
    );
    await agent.run(makeRequest());
    expect(fakeDecider.calls.chooseAction[1]?.request.offers.targets.CLICK).toContain(target.id);
    expect(fakeHost.calls.execute).toHaveLength(1);
  });

  test('none-appropriate argument returns a concrete requirement and secret-free checkpoint', async () => {
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 })],
      },
      { observations: [makeObservation({ elements: [makeTextField()] })] }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ inputs: { name: 'Ada' } })),
      'needs_input'
    );
    expect(result.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'FILL', slot: 'value', reason: 'none_appropriate' }),
      ])
    );
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('sensitive input cannot be redirected by a plain field label', async () => {
    const secret = secretValue();
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('FILL', 't3'))],
        chooseArgument: [
          request => {
            expect(request.candidates.some(candidate => candidate.source === 'input')).toBe(false);
            return deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 });
          },
        ],
      },
      {
        observations: [
          makeObservation({
            elements: [makeTextField({ label: 'Type your password here to continue' })],
          }),
        ],
      }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ inputs: { password: secret } })),
      'needs_input'
    );
    expect(result.requirements[0]?.reason).toBe('none_appropriate');
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  });

  test('preserves the exact goal in all four decider stages', async () => {
    const goal = '  Fill the name and continue; keep punctuation!  ';
    const field = makeTextField();
    const page = makeObservation({ elements: [field, makeElement()] });
    const after = makeObservation({
      elements: [makeTextField({ state: { value: 'Ada' } }), makeElement()],
      fingerprint: 'after',
    });
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          deciderOk('action', action('CLICK', 't1')),
          deciderOk('action', terminal('DONE')),
        ],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.preview === 'Ada'),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
        verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
      },
      { observations: [page, after, after, after] }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ goal, inputs: { name: 'Ada' } })),
      'completed'
    );
    expect(result.goal).toBe(goal);
    for (const calls of Object.values(fakeDecider.calls)) {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.request.goal).toBe(goal);
        expect(call.context.goal).toBe(goal);
      }
    }
  });

  test('rejects a long declared secret in goal without altering goal', async () => {
    const secret = secretValue();
    const goal = `Use ${secret}`;
    const { agent, fakeDecider } = setup({});
    const result = requireStatus(
      await agent.run(makeRequest({ goal, inputs: { password: secret } })),
      'failed'
    );
    expect(result.error.code).toBe('GOAL_CONTAINS_SECRET');
    expect(result.goal).toBe(goal);
    expect(fakeDecider.calls.chooseAction).toHaveLength(0);
  });

  test('short secret scrubs text but preserves ids, signatures, fingerprint and literal goal', async () => {
    const short = String.fromCharCode(49, 50, 51, 52);
    const shorter = String.fromCharCode(49, 50, 51);
    const signature = `sg_0000${short}00000000`;
    const field = makeSensitiveField({
      id: 't8',
      signature,
      label: `Password ${shorter}`,
      state: { value: shorter },
    });
    const page = makeObservation({
      snapshotId: `snap_00000000${short}`,
      fingerprint: `fp_${shorter}`,
      text: `echo ${shorter}`,
      elements: [field],
    });
    const { agent, fakeHost, fakeDecider } = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't8')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.source === 'input'),
        ],
      },
      { observations: [page], restamp: false }
    );
    const result = await agent.run(
      makeRequest({
        goal: `Write code ${shorter}`,
        inputs: { password: shorter },
        options: { captureTrace: true },
      })
    );
    const request = fakeDecider.calls.chooseAction[0]?.request;
    expect(request?.goal).toBe(`Write code ${shorter}`);
    expect(request?.observation.snapshotId).toBe(page.snapshotId);
    expect(request?.observation.fingerprint).toBe(page.fingerprint);
    expect(request?.observation.elements[0]?.signature).toBe(signature);
    expect(request?.observation.text).toContain(TASK_REDACTED);
    expect(fakeHost.calls.execute[0]?.command).toMatchObject({
      operation: 'FILL',
      target: { signature },
      sensitive: true,
    });
    expect(result.warnings.some(warning => warning.code === 'SHORT_SENSITIVE_INPUT')).toBe(true);
    expect(result.ledger[0]?.postconditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ expected: { sensitive: true, nonEmpty: true } }),
      ])
    );
    expect(result.ledger[0]?.command.argument?.preview).toBeUndefined();
  });

  test('authoritative origin mismatch blocks before a decision', async () => {
    const { agent, fakeDecider, fakeHost } = setup(
      {},
      {
        location: {
          url: 'https://foreign.example.test/cart',
          origin: 'https://foreign.example.test',
        },
      }
    );
    const result = requireStatus(await agent.run(makeRequest()), 'blocked');
    expect(result.reason).toBe('ORIGIN_UNVERIFIED');
    expect(fakeDecider.calls.chooseAction).toHaveLength(0);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('stale rejection re-observes and compiles the newly selected target', async () => {
    const { agent, fakeHost } = setup(
      {
        chooseAction: [
          deciderOk('action', action('CLICK', 't1')),
          deciderOk('action', action('CLICK', 't9')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      {
        observations: [
          makeObservation(),
          makeObservation({ elements: [makeElement({ id: 't9' })] }),
        ],
        outcomes: [
          makeOutcome('rejected_stale', 'none', { staleReason: 'url_changed' }),
          makeOutcome('applied', 'applied'),
        ],
      }
    );
    await agent.run(makeRequest());
    expect(fakeHost.calls.execute).toHaveLength(2);
    expect(
      fakeHost.calls.execute.map(request =>
        'target' in request.command ? request.command.target?.targetId : undefined
      )
    ).toEqual(['t1', 't9']);
    expect(fakeHost.calls.execute[1]?.scope.snapshotId).not.toBe(
      fakeHost.calls.execute[0]?.scope.snapshotId
    );
  });

  test('uncertain command is excluded by signature across new target ids and never retried', async () => {
    const observed: TaskChooseActionRequest[] = [];
    const record = (request: TaskChooseActionRequest) => {
      observed.push(request);
      return deciderOk('action', terminal('BLOCKED'));
    };
    const original = makeElement();
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('CLICK', 't1')), record],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      {
        observations: [
          makeObservation(),
          makeObservation({ elements: [makeElement({ id: 't9', signature: original.signature })] }),
        ],
        outcomes: [makeOutcome('uncertain', 'uncertain', { code: 'EXECUTION_TIMEOUT' })],
      }
    );
    const result = requireStatus(await agent.run(makeRequest()), 'blocked');
    expect(fakeHost.calls.execute).toHaveLength(1);
    expect(observed[0]?.offers.targets.CLICK ?? []).not.toContain('t9');
    expect(result.lastEffect).toBe('uncertain');
    expect(result.unresolvedUncertain).toEqual([1]);
    expect(result.checkpoint?.pending.kind).toBe('uncertain_effect');
  });

  test.each(['host', 'decider'] as const)('%s failures tolerate N then fail on N+1', async kind => {
    const { agent, fakeHost, fakeDecider } = setup(
      { chooseAction: [deciderFail(), deciderFail()] },
      kind === 'host'
        ? {
            observations: [
              { error: { code: 'OBSERVE_FAILED', message: 'fixture failure', retryable: true } },
            ],
          }
        : {}
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({ options: { budgets: { maxHostFailures: 1, maxDeciderFailures: 1 } } })
      ),
      'failed'
    );
    expect(result.error.code).toBe(kind === 'host' ? 'HOST_FAILED' : 'DECIDER_FAILED');
    expect(
      kind === 'host' ? fakeHost.calls.observe.length : fakeDecider.calls.chooseAction.length
    ).toBe(2);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('inputPreviews false hides non-sensitive data previews', async () => {
    const { agent, fakeDecider } = setup({
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
    });
    await agent.run(makeRequest({ inputs: { name: 'Ada' }, options: { inputPreviews: false } }));
    expect(fakeDecider.calls.chooseAction[0]?.request.inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'name' })])
    );
    expect(JSON.stringify(fakeDecider.calls.chooseAction[0]?.request.inputs)).not.toContain('Ada');
  });

  test('boolean sensitive input leaves do not scrub ordinary goal words', async () => {
    const { agent, fakeDecider } = setup({
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
    });
    const result = await agent.run(
      makeRequest({ goal: 'Check whether this is true', inputs: { secretFlag: true } })
    );
    expect(result.status).toBe('blocked');
    expect(fakeDecider.calls.chooseAction[0]?.request.goal).toBe('Check whether this is true');
  });
});
