/** @jest-environment node */
import { buildCompletionQuestions } from '@/agent/request';
import { TASK_RESEARCH_PROFILE } from '@/types';
import type { TaskCompletionDecision, TaskExpectation, TaskVerifyCompletionRequest } from '@/types';
import {
  deciderOk,
  makeCompletionDecision,
  makeObservation,
  makeRequest,
} from './helpers/agent-fixtures';
import { requireStatus, setup, terminal } from './helpers/task-agent-contract';

const GOAL = 'Open the summary that is already visible';

function runCompletion(answer: TaskCompletionDecision['answer'], expectAnswer?: TaskExpectation) {
  const fixture = setup({
    chooseAction: [deciderOk('action', terminal('DONE'))],
    verifyCompletion: [deciderOk('completion', makeCompletionDecision({ answer }))],
  });
  const result = fixture.agent.run(
    makeRequest({
      goal: GOAL,
      ...(expectAnswer === undefined ? {} : { expect: expectAnswer }),
      options: { captureTrace: true, budgets: { maxPrematureDone: 0 } },
    })
  );
  return { ...fixture, result };
}

function completionRequest(expectAnswer?: boolean): TaskVerifyCompletionRequest {
  return {
    goal: GOAL,
    step: 1,
    observation: makeObservation(),
    history: [],
    inputs: [],
    evidenceSlots: 2,
    collectedEvidence: [],
    expected: [],
    maxStateBytes: 22000,
    ...(expectAnswer === undefined ? {} : { expectAnswer }),
  };
}

describe('completion answer expectation follows the three contract states', () => {
  test.each([
    ['YES with low confidence', { choice: 'YES' as const, confidence: 0.01 }],
    ['NO with low confidence', { choice: 'NO' as const, confidence: 0.01 }],
    ['UNKNOWN', { choice: 'UNKNOWN' as const, confidence: 0.99 }],
    ['no answer', undefined],
  ])('explicit false ignores %s through the real coordinator gate', async (_name, answer) => {
    const fixture = runCompletion(answer, { answer: false });
    const result = requireStatus(await fixture.result, 'completed');
    const request = fixture.fakeDecider.calls.verifyCompletion[0]?.request;
    expect(request?.expectAnswer).toBe(false);
    expect(result.answer).toBeUndefined();
    expect(result.completion).toMatchObject({ answered: false, mode: 'noop' });
    expect(fixture.fakeHost.calls.observe).toHaveLength(2);
    expect(fixture.fakeHost.calls.execute).toHaveLength(0);
    expect(request).toBeDefined();
    if (request === undefined) throw new Error('completion request missing');
    expect(buildCompletionQuestions(request).questions).not.toHaveProperty('answer');
  });

  test.each(['YES', 'NO'] as const)(
    'omitted expectation accepts an injected %s answer above the floor',
    async choice => {
      const fixture = runCompletion({ choice, confidence: 0.99 });
      const result = requireStatus(await fixture.result, 'completed');
      expect(fixture.fakeDecider.calls.verifyCompletion[0]?.request.expectAnswer).toBeUndefined();
      expect(result.answer).toEqual({ value: choice, confidence: 0.99 });
      expect(result.completion).toMatchObject({ answered: true, mode: 'answered' });
    }
  );

  test('omitted expectation rejects injected UNKNOWN instead of acting like false', async () => {
    const fixture = runCompletion({ choice: 'UNKNOWN', confidence: 0.99 });
    const result = requireStatus(await fixture.result, 'blocked');
    expect(result.reason).toBe('COMPLETION_NOT_VERIFIED');
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'done_gate',
          passed: false,
          failures: expect.arrayContaining(['ANSWER_UNKNOWN']),
        }),
      ])
    );
  });

  test.each([
    ['no answer', undefined],
    ['NOT_APPLICABLE', { choice: 'NOT_APPLICABLE' as const, confidence: 0.99 }],
  ])(
    'omitted expectation allows %s without creating an informational result',
    async (_name, answer) => {
      const fixture = runCompletion(answer);
      const result = requireStatus(await fixture.result, 'completed');
      expect(result.answer).toBeUndefined();
      expect(result.completion).toMatchObject({ answered: false, mode: 'noop' });
    }
  );

  test.each(['YES', 'NO'] as const)('explicit true requires and preserves %s', async choice => {
    const fixture = runCompletion({ choice, confidence: 0.99 }, { answer: true });
    const result = requireStatus(await fixture.result, 'completed');
    expect(fixture.fakeDecider.calls.verifyCompletion[0]?.request.expectAnswer).toBe(true);
    expect(result.answer).toEqual({ value: choice, confidence: 0.99 });
    expect(result.completion.answered).toBe(true);
  });

  test.each([
    ['missing', undefined, 'ANSWER_MISSING'],
    ['not applicable', { choice: 'NOT_APPLICABLE' as const, confidence: 0.99 }, 'ANSWER_MISSING'],
    ['unknown', { choice: 'UNKNOWN' as const, confidence: 0.99 }, 'ANSWER_UNKNOWN'],
    ['below floor', { choice: 'YES' as const, confidence: 0.01 }, 'CONFIDENCE_BELOW_FLOOR'],
  ])('explicit true rejects an answer that is %s', async (_name, answer, code) => {
    const fixture = runCompletion(answer, { answer: true });
    const result = requireStatus(await fixture.result, 'blocked');
    expect(result.reason).toBe('COMPLETION_NOT_VERIFIED');
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'done_gate',
          passed: false,
          failures: expect.arrayContaining([code]),
        }),
      ])
    );
  });

  test('profile answer true is retained when request expectation is omitted', async () => {
    const fixture = setup({
      chooseAction: [deciderOk('action', terminal('DONE'))],
      verifyCompletion: [
        deciderOk(
          'completion',
          makeCompletionDecision({ answer: { choice: 'NO', confidence: 0.99 } })
        ),
      ],
    });
    const result = requireStatus(
      await fixture.agent.run(makeRequest({ goal: GOAL, profile: TASK_RESEARCH_PROFILE })),
      'completed'
    );
    expect(fixture.fakeDecider.calls.verifyCompletion[0]?.request.expectAnswer).toBe(true);
    expect(result.answer?.value).toBe('NO');
  });

  test('explicit request false overrides a profile answer expectation', async () => {
    const fixture = setup({
      chooseAction: [deciderOk('action', terminal('DONE'))],
      verifyCompletion: [
        deciderOk(
          'completion',
          makeCompletionDecision({ answer: { choice: 'UNKNOWN', confidence: 0.99 } })
        ),
      ],
    });
    const result = requireStatus(
      await fixture.agent.run(
        makeRequest({ goal: GOAL, profile: TASK_RESEARCH_PROFILE, expect: { answer: false } })
      ),
      'completed'
    );
    expect(fixture.fakeDecider.calls.verifyCompletion[0]?.request.expectAnswer).toBe(false);
    expect(result.answer).toBeUndefined();
  });
});

describe('completion request answer question', () => {
  test('explicit false omits the question while preserving completion and evidence questions', () => {
    const set = buildCompletionQuestions(completionRequest(false));
    expect(Object.keys(set.questions)).toEqual(['completion', 'evidence_1', 'evidence_2']);
  });

  test.each([undefined, true])(
    'expectAnswer=%s includes the answer question under the current contract',
    expectAnswer => {
      const set = buildCompletionQuestions(completionRequest(expectAnswer));
      expect(set.questions).toHaveProperty('answer');
      expect(Object.keys(set.questions.answer?.criteria ?? {}).sort()).toEqual([
        'NO',
        'NOT_APPLICABLE',
        'UNKNOWN',
        'YES',
      ]);
    }
  );
});
