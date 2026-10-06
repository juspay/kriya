/** @jest-environment node */
import { createTaskPolicy } from '@/agent/policy';
import { TASK_RESEARCH_PROFILE } from '@/types';
import {
  deciderOk,
  makeCheckbox,
  makeCompletionDecision,
  makeElement,
  makeForm,
  makeLink,
  makeObservation,
  makeOutcome,
  makeRequest,
  makeSelectField,
  makeSubmitButton,
} from './helpers/agent-fixtures';
import {
  action,
  chooseCandidate,
  requireStatus,
  setup,
  terminal,
} from './helpers/task-agent-contract';

describe('TaskAgent policy boundary', () => {
  test('missing model classification fails closed for a script-driven button', async () => {
    const { agent, fakeHost } = setup({
      chooseAction: [deciderOk('action', action('CLICK', 't1'))],
    });
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('other_commitment');
    expect(fakeHost.calls.execute).toHaveLength(0);
    expect(fakeHost.calls.release).toEqual([result.sessionId]);
  });

  test('caller opt-out of missing classification is recorded and proceeds', async () => {
    const { agent, fakeHost } = setup({
      chooseAction: [
        deciderOk('action', action('CLICK', 't1')),
        deciderOk('action', terminal('BLOCKED')),
      ],
    });
    const result = await agent.run(
      makeRequest({ authorization: { assumeUnclassifiedRoutine: true } })
    );
    expect(fakeHost.calls.execute).toHaveLength(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ASSUMED_ROUTINE_CLASSIFICATION' })])
    );
  });

  test('throwing caller classifier remains a commitment despite model NONE', async () => {
    const policy = createTaskPolicy({
      classify: () => {
        throw new Error('classifier unavailable');
      },
    });
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('CLICK', 't1'))],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      {},
      {},
      policy
    );
    const result = requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(result.approval.effects).toContain('other_commitment');
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test.each([
    [
      'link',
      makeLink({ commitHints: [{ class: 'PUBLISH', basis: 'declared_marker' }] }),
      'NAVIGATE' as const,
    ],
    [
      'switch',
      makeCheckbox({ commitHints: [{ class: 'ACCOUNT_CHANGE', basis: 'declared_marker' }] }),
      'SET_CHECKED' as const,
    ],
    [
      'select',
      makeSelectField({ commitHints: [{ class: 'SEND', basis: 'declared_marker' }] }),
      'SELECT' as const,
    ],
  ])('declared marker on %s outranks model NONE and pauses', async (_name, element, operation) => {
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action(operation, element.id))],
        chooseArgument: [request => chooseCandidate(request, () => true)],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      { observations: [makeObservation({ elements: [element] })] }
    );
    requireStatus(await agent.run(makeRequest()), 'awaiting_approval');
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test.each(['https://foreign.example.test/post', 'javascript:void(0)'])(
    'form destination %s is denied despite standing grants',
    async destination => {
      const element = makeSubmitButton({ formTarget: { action: destination, method: 'POST' } });
      const { agent, fakeHost } = setup(
        { chooseAction: [deciderOk('action', action('SUBMIT', 't6'))] },
        {
          observations: [
            makeObservation({ elements: [element], forms: [makeForm({ action: destination })] }),
          ],
        }
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
        'blocked'
      );
      expect(result.reason).toBe('ORIGIN_LEFT_SCOPE');
      expect(fakeHost.calls.execute).toHaveLength(0);
    }
  );

  test('uncertain submission stops immediately even with a large uncertainty budget', async () => {
    const { agent, fakeHost } = setup(
      { chooseAction: [deciderOk('action', action('SUBMIT', 't6'))] },
      {
        observations: [makeObservation({ elements: [makeSubmitButton()] })],
        outcomes: [makeOutcome('uncertain', 'uncertain', { code: 'EXECUTION_TIMEOUT' })],
      }
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
          options: { budgets: { maxUncertainEffects: 100 } },
        })
      ),
      'blocked'
    );
    expect(result.reason).toBe('UNCERTAIN_EFFECT');
    expect(result.checkpoint?.pending).toEqual({ kind: 'uncertain_effect', entries: [1] });
    expect(fakeHost.calls.execute).toHaveLength(1);
  });

  test('expired grant provides no authorization', async () => {
    const { agent, fakeHost } = setup({
      chooseAction: [deciderOk('action', action('CLICK', 't1'))],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'DELETE', confidence: 0.99, agreement: 'single' }),
      ],
    });
    const result = requireStatus(
      await agent.run(
        makeRequest({ authorization: { effects: [{ effect: 'delete', expiresAt: 1 }] } })
      ),
      'awaiting_approval'
    );
    expect(result.approval.effects).toContain('delete');
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('research profile denies a marked navigation rather than requesting approval', async () => {
    const { agent, fakeHost } = setup(
      {
        chooseAction: [deciderOk('action', action('NAVIGATE', 't2'))],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      {
        observations: [
          makeObservation({
            elements: [makeLink({ commitHints: [{ class: 'PUBLISH', basis: 'declared_marker' }] })],
          }),
        ],
      }
    );
    const result = requireStatus(
      await agent.run(makeRequest({ profile: TASK_RESEARCH_PROFILE })),
      'blocked'
    );
    expect(result.reason).toBe('POLICY_DENIED');
    expect(fakeHost.calls.execute).toHaveLength(0);
  });

  test('a granted commitment uses its grant exactly once before the next checkpoint', async () => {
    const first = makeSubmitButton();
    const second = makeSubmitButton({ id: 't9', signature: 'sg_9000000000000000' });
    const { agent, fakeHost } = setup(
      {
        chooseAction: [
          deciderOk('action', action('SUBMIT', 't6')),
          deciderOk('action', action('SUBMIT', 't9')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      },
      {
        observations: [
          makeObservation({ elements: [first] }),
          makeObservation({ elements: [second], fingerprint: 'changed' }),
        ],
      }
    );
    const result = requireStatus(
      await agent.run(
        makeRequest({ authorization: { effects: [{ effect: 'form_submit', maxUses: 1 }] } })
      ),
      'awaiting_approval'
    );
    expect(fakeHost.calls.execute).toHaveLength(1);
    expect(result.checkpoint.request.authorization.grants[0]?.used).toBe(1);
  });
});
