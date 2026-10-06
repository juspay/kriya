/** @jest-environment node */
import {
  deciderFail,
  deciderOk,
  makeCompletionDecision,
  makeCapabilities,
  makeCheckbox,
  makeElement,
  makeObservation,
  makeOutcome,
  makePassage,
  makeRequest,
  makeSubmitButton,
  makeTextField,
} from './helpers/agent-fixtures';
import {
  action,
  chooseCandidate,
  requireStatus,
  setup,
  terminal,
} from './helpers/task-agent-contract';

describe('TaskAgent independent DONE gate', () => {
  test.each([false, true])(
    'checks saved state rather than the retained draft (discarded: %s)',
    async discarded => {
      const checkbox = makeCheckbox({ state: { checked: true } });
      const draft = { ...checkbox, state: { ...checkbox.state, checked: false } };
      const before = makeObservation({ elements: [checkbox] });
      const after = makeObservation({ elements: [draft] });
      const saved = makeObservation({
        elements: [discarded ? checkbox : draft],
        documentId: 'independent_document',
      });
      const { agent, fakeHost, fakeDecider } = setup(
        {
          chooseAction: [
            deciderOk('action', action('SET_CHECKED', checkbox.id)),
            deciderOk('action', terminal('DONE')),
          ],
          chooseArgument: [
            request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
          ],
          classifyCommitment: [
            deciderOk('commitment', {
              commitment: 'ACCOUNT_CHANGE',
              confidence: 0.99,
              agreement: 'agreed',
            }),
          ],
          verifyCompletion: [
            deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [checkbox.id] })),
          ],
        },
        {
          capabilities: makeCapabilities({ freshStateObservations: true }),
          observations: [before, after, after, saved],
        }
      );
      const result = await agent.run(
        makeRequest({
          authorization: { effects: ['account_change'] },
          options: { budgets: { maxPrematureDone: 0 } },
        })
      );
      expect(result.status).toBe(discarded ? 'blocked' : 'completed');
      expect(fakeHost.calls.observe[3]?.freshState?.allowedOrigins).toEqual([before.origin]);
      expect(fakeDecider.calls.verifyCompletion).toHaveLength(discarded ? 0 : 1);
      if (!discarded)
        expect(fakeDecider.calls.verifyCompletion[0]?.request.independentRead).toBe(true);
    }
  );
  test('empty ledger completes noop only after a fresh gate observation and independent verification', async () => {
    const initial = makeObservation({ elements: [makeElement({ id: 'old' })] });
    const fresh = makeObservation({
      elements: [makeElement({ id: 'fresh', label: 'Already complete' })],
    });
    const { agent, fakeHost, fakeDecider } = setup(
      {
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['fresh'] })),
        ],
      },
      { observations: [initial, fresh] }
    );
    const result = requireStatus(await agent.run(makeRequest()), 'completed');
    expect(fakeHost.calls.observe).toHaveLength(2);
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(
      fakeDecider.calls.verifyCompletion[0]?.request.observation.elements.map(element => element.id)
    ).toEqual(['fresh']);
    expect(result.completion).toMatchObject({
      mode: 'noop',
      effected: false,
      answered: false,
      actionsExecuted: 0,
    });
    expect(result.completion.verifiedSnapshot.snapshotId).not.toBe(
      fakeDecider.calls.chooseAction[0]?.request.observation.snapshotId
    );
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('completed informational task may answer NO', async () => {
    const { agent } = setup({
      chooseAction: [deciderOk('action', terminal('DONE'))],
      verifyCompletion: [
        deciderOk(
          'completion',
          makeCompletionDecision({ answer: { choice: 'NO', confidence: 0.97 } })
        ),
      ],
    });
    const result = requireStatus(
      await agent.run(makeRequest({ expect: { answer: true } })),
      'completed'
    );
    expect(result.answer).toEqual({ value: 'NO', confidence: 0.97 });
    expect(result.completion.mode).toBe('answered');
    expect(result.completion.effected).toBe(false);
  });

  test.each([
    [
      'stale evidence',
      makeCompletionDecision({ evidenceTargetIds: ['absent'] }),
      false,
      'EVIDENCE_NOT_IN_SNAPSHOT',
    ],
    [
      'missing evidence',
      makeCompletionDecision({ evidenceTargetIds: [] }),
      false,
      'EVIDENCE_MISSING',
    ],
    ['missing required answer', makeCompletionDecision(), true, 'ANSWER_MISSING'],
    [
      'unknown answer',
      makeCompletionDecision({ answer: { choice: 'UNKNOWN', confidence: 0.99 } }),
      true,
      'ANSWER_UNKNOWN',
    ],
    [
      'low confidence',
      makeCompletionDecision({ confidence: 0.01 }),
      false,
      'CONFIDENCE_BELOW_FLOOR',
    ],
  ])(
    'rejects %s, records premature DONE, and stops on N+1',
    async (_name, decision, expectAnswer, code) => {
      const { agent, fakeHost, fakeDecider } = setup({
        chooseAction: [
          deciderOk('action', terminal('DONE')),
          deciderOk('action', terminal('DONE')),
        ],
        verifyCompletion: [deciderOk('completion', decision), deciderOk('completion', decision)],
      });
      const result = requireStatus(
        await agent.run(
          makeRequest({
            expect: { answer: expectAnswer },
            options: { budgets: { maxPrematureDone: 1 }, captureTrace: true },
          })
        ),
        'blocked'
      );
      expect(result.reason).toBe('COMPLETION_NOT_VERIFIED');
      expect(fakeDecider.calls.verifyCompletion).toHaveLength(2);
      expect(result.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'done_gate', failures: expect.arrayContaining([code]) }),
        ])
      );
      expect(fakeHost.calls.execute).toHaveLength(0);
    }
  );

  test('premature DONE returns to the loop and an applied action resets the consecutive budget', async () => {
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [
          deciderOk('action', terminal('DONE')),
          deciderOk('action', action('CLICK', 't1')),
          deciderOk('action', terminal('DONE')),
          deciderOk('action', terminal('DONE')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ verdict: 'NOT_SATISFIED' })),
          deciderOk('completion', makeCompletionDecision({ verdict: 'NOT_SATISFIED' })),
          deciderOk('completion', makeCompletionDecision()),
        ],
      },
      {
        observations: [
          makeObservation(),
          makeObservation(),
          makeObservation(),
          makeObservation({ fingerprint: 'changed' }),
        ],
      }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ options: { budgets: { maxPrematureDone: 1 } } })),
      'completed'
    );
    expect(result.completion.mode).toBe('effected');
    expect(result.ledger).toHaveLength(1);
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(3);
    expect(
      fakeDecider.calls.chooseAction.some(call =>
        call.request.history.some(entry => entry.kind === 'premature_done')
      )
    ).toBe(true);
    expect(fakeDecider.calls.verifyCompletion.length).toBeGreaterThan(1);
    expect(
      fakeDecider.calls.verifyCompletion.every(call =>
        call.request.history.every(
          entry => entry.kind !== 'premature_done' && entry.kind !== 'rejected_decision'
        )
      )
    ).toBe(true);
  });

  test('a refused decision stays in the action history but not in the completion request', async () => {
    const { agent, fakeDecider } = setup({
      chooseAction: [
        deciderOk('action', { ...action('CLICK', 't1'), confidence: 0.01 }),
        deciderOk('action', terminal('DONE')),
      ],
      verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
    });
    await agent.run(makeRequest({ options: { budgets: { maxInvalidDecisions: 3 } } }));
    expect(
      fakeDecider.calls.chooseAction.some(call =>
        call.request.history.some(entry => entry.kind === 'rejected_decision')
      )
    ).toBe(true);
    expect(fakeDecider.calls.verifyCompletion.length).toBeGreaterThan(0);
    expect(
      fakeDecider.calls.verifyCompletion.every(call =>
        call.request.history.every(entry => entry.kind !== 'rejected_decision')
      )
    ).toBe(true);
  });

  test('verifyCompletion errors spend the decider failure budget without premature-DONE failures', async () => {
    const { agent, fakeDecider } = setup({
      chooseAction: [deciderOk('action', terminal('DONE')), deciderOk('action', terminal('DONE'))],
      verifyCompletion: [deciderFail('NETWORK'), deciderFail('NETWORK')],
    });
    const result = requireStatus(
      await agent.run(
        makeRequest({
          options: { budgets: { maxDeciderFailures: 1, maxPrematureDone: 0 }, captureTrace: true },
        })
      ),
      'failed'
    );
    expect(result.error.code).toBe('DECIDER_FAILED');
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(2);
    expect(
      fakeDecider.calls.chooseAction.every(call =>
        call.request.history.every(entry => entry.kind !== 'premature_done')
      )
    ).toBe(true);
  });

  test.each(['NOT_SATISFIED', 'UNCERTAIN'] as const)(
    'caller verifier %s vetoes model completion',
    async verdict => {
      const verifier = jest.fn(async () => ({ verdict }));
      const { agent } = setup(
        {
          chooseAction: [deciderOk('action', terminal('DONE'))],
          verifyCompletion: [deciderOk('completion', makeCompletionDecision())],
        },
        {},
        { verifier }
      );
      const result = requireStatus(
        await agent.run(makeRequest({ options: { budgets: { maxPrematureDone: 0 } } })),
        'blocked'
      );
      expect(result.reason).toBe('COMPLETION_NOT_VERIFIED');
      expect(verifier).toHaveBeenCalledTimes(1);
    }
  );

  test('unresolved uncertainty alone blocks without an independent verifier call', async () => {
    const { agent, fakeHost, fakeDecider } = setup(
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
    const result = requireStatus(await agent.run(makeRequest()), 'blocked');
    expect(result.reason).toBe('UNCERTAIN_EFFECT');
    expect(result.unresolvedUncertain).toEqual([1]);
    expect(result.checkpoint?.pending.kind).toBe('uncertain_effect');
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(0);
    expect(fakeHost.calls.execute).toHaveLength(1);
  });

  test('hard-navigation submission resolves uncertainty by transition and verifies the new document', async () => {
    const before = makeObservation({ elements: [makeSubmitButton()] });
    const after = makeObservation({
      documentId: 'doc_000000000002',
      sequence: 1,
      elements: [makeElement({ id: 'receipt' })],
      url: 'https://shop.example.test/receipt',
    });
    const { agent, fakeHost } = setup(
      {
        chooseAction: [
          deciderOk('action', action('SUBMIT', 't6')),
          deciderOk('action', terminal('DONE')),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['receipt'] })),
        ],
      },
      { observations: [before, after, after], outcomes: [makeOutcome('navigated', 'uncertain')] }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({
          authorization: {
            effects: [
              'form_submit',
              'purchase',
              'delete',
              'publish',
              'send',
              'account_change',
              'other_commitment',
            ],
          },
        })
      ),
      'completed'
    );
    expect(result.completion.resolvedUncertain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ by: 'transition', effect: 'applied', seq: 1 }),
      ])
    );
    expect(result.unresolvedUncertain).toEqual([]);
    expect(result.completion.mode).toBe('effected');
    expect(fakeHost.calls.capabilities.length).toBeGreaterThanOrEqual(2);
    expect(fakeHost.calls.execute).toHaveLength(1);
  });

  test('a changed field fails local postconditions before calling the model verifier', async () => {
    const before = makeObservation({ elements: [makeTextField()] });
    const after = makeObservation({
      elements: [makeTextField({ state: { value: 'Different' } })],
      fingerprint: 'after',
    });
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [
          deciderOk('action', action('FILL', 't3')),
          deciderOk('action', terminal('DONE')),
        ],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.preview === 'Ada'),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['t3'] })),
        ],
      },
      { observations: [before, after, after] }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({ inputs: { name: 'Ada' }, options: { budgets: { maxPrematureDone: 0 } } })
      ),
      'blocked'
    );
    expect(result.reason).toBe('COMPLETION_NOT_VERIFIED');
    expect(fakeDecider.calls.verifyCompletion).toHaveLength(0);
  });
  test.each([
    ['a closed disclosure is reopened after the fresh read reloaded the page', {}, 3],
    ['a control with no closed state is not clicked again', { state: { expanded: undefined } }, 2],
    [
      'a commitment hint keeps the earlier click from being repeated',
      { commitHints: [{ class: 'PURCHASE' as const, basis: 'declared_marker' as const }] },
      2,
    ],
  ])('view restoration: %s', async (_name, closedOverrides, clicks) => {
    const view = (expanded: boolean, checked: boolean | undefined, doc: string, fp: string) =>
      makeObservation({
        documentId: doc,
        fingerprint: fp,
        elements: [
          makeElement({ id: 'disc', label: 'Preferences', state: { expanded } }),
          ...(expanded && checked !== undefined
            ? [makeCheckbox({ id: 'box', label: 'Digest email', state: { checked } })]
            : []),
        ],
      });
    const reloaded = makeObservation({
      documentId: 'doc_indep',
      fingerprint: 'pf_i',
      elements: [
        makeElement({
          id: 'disc',
          label: 'Preferences',
          state: { expanded: false },
          ...closedOverrides,
        }),
      ],
    });
    const reopened = view(true, true, 'doc_indep', 'pf_r');
    const none = deciderOk('commitment', {
      commitment: 'NONE' as const,
      confidence: 0.99,
      agreement: 'agreed' as const,
    });
    const { agent, fakeHost } = setup(
      {
        chooseAction: [
          deciderOk('action', action('CLICK', 'disc')),
          deciderOk('action', action('SET_CHECKED', 'box')),
          deciderOk('action', terminal('DONE')),
          deciderOk('action', terminal('DONE')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.label === 'Set checked'),
        ],
        classifyCommitment: [
          none,
          deciderOk('commitment', {
            commitment: 'ACCOUNT_CHANGE' as const,
            confidence: 0.99,
            agreement: 'agreed' as const,
          }),
          none,
        ],
        verifyCompletion: [
          deciderOk(
            'completion',
            makeCompletionDecision({ verdict: 'UNCERTAIN', evidenceTargetIds: [] })
          ),
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['box'] })),
        ],
      },
      {
        capabilities: makeCapabilities({ freshStateObservations: true }),
        observations: [
          view(false, undefined, 'doc_a', 'pf_a'),
          view(true, false, 'doc_a', 'pf_b'),
          view(true, true, 'doc_a', 'pf_c'),
          view(true, true, 'doc_a', 'pf_c'),
          reloaded,
          reloaded,
          reopened,
          reopened,
          reopened,
        ],
      }
    );
    const result = await agent.run(
      makeRequest({
        goal: 'Turn on the digest email.',
        authorization: { effects: ['account_change'] },
      })
    );
    expect(
      fakeHost.calls.execute.filter(request => request.command.operation === 'CLICK')
    ).toHaveLength(clicks - 1);
    expect(fakeHost.calls.execute.map(request => request.command.operation)).toHaveLength(clicks);
    if (clicks === 3) expect(result.status).toBe('completed');
  });
  test('the completion request carries the code-derived effect classes of the executed commands', async () => {
    const button = makeElement({ id: 'open', label: 'Open details' });
    const passage = makePassage();
    const before = makeObservation({ elements: [button, passage] });
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [
          deciderOk('action', action('CLICK', button.id)),
          deciderOk('action', terminal('DONE')),
        ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'NONE' as const,
            confidence: 0.99,
            agreement: 'agreed' as const,
          }),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [passage.id] })),
        ],
      },
      { observations: [before] }
    );
    const result = await agent.run(makeRequest({ goal: 'Open the details.' }));
    expect(result.status).toBe('completed');
    expect(fakeDecider.calls.verifyCompletion[0]?.request.executedEffects).toEqual({
      interact: 1,
    });
  });
});
