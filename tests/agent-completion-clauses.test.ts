/** @jest-environment node */
import { randomUUID } from 'crypto';
import {
  assertGoalPreserved,
  buildCompletionQuestions,
  estimateRequestBytes,
} from '@/agent/request';
import { createTypeSafeTaskDecider } from '@/agent/typesafe';
import { TASK_LIMITS, TASK_NONE_APPROPRIATE } from '@/types';
import type { TaskCompletionClauseSplit } from '../src/index';
import type {
  TaskCallContext,
  TaskHttp,
  TaskQuestionSet,
  TaskVerifyCompletionRequest,
  TypeSafeTaskDeciderConfig,
} from '@/types';
import { makeObservation, makePageElements } from './helpers/agent-fixtures';

const requestFor = (goal: string, expectAnswer = false): TaskVerifyCompletionRequest => ({
  goal,
  step: 2,
  observation: makeObservation({ elements: makePageElements() }),
  history: [],
  inputs: [],
  collectedEvidence: [],
  expected: [],
  evidenceSlots: 2,
  expectAnswer,
  maxStateBytes: TASK_LIMITS.modelStateBytes,
});

const contextFor = (goal: string): TaskCallContext => ({
  goal,
  step: 2,
  runId: 'run_000000000001',
  callIndex: 1,
});

const requirementsOf = (set: TaskQuestionSet): readonly string[] =>
  Object.entries(set.questions)
    .filter(([key]) => key === 'completion' || key.startsWith('completion_part_'))
    .map(([, question]) => {
      const instructions = question.instructions as Readonly<Record<string, string>>;
      return instructions['requirement'] ?? '';
    });

describe('optional conjunction completion requirements', () => {
  it.each([
    ['Turn off email and enable digest', ['Turn off email', 'enable digest']],
    ['Search "rock and roll" and save results', ['Search "rock and roll"', 'save results']],
    ['Search "rock, roll and rhythm" and save', ['Search "rock, roll and rhythm"', 'save']],
    ['Save candy and change the brand', ['Save candy', 'change the brand']],
    ['and save AND verify and', ['save', 'verify']],
    ['Save\tAND\nverify', ['Save', 'verify']],
    [
      'Save, and verify. Enable digest and keep email off',
      ['Save', 'verify', 'Enable digest', 'keep email off'],
    ],
    ['Keep digest enabled', ['Keep digest enabled']],
    ['and', ['and']],
  ])('segments %s without dropping the whole goal', (goal, expected) => {
    const request = requestFor(goal as string);
    const set = buildCompletionQuestions(request, { clauseSplit: 'conjunction', rotate: false });
    expect(requirementsOf(set)).toEqual(expected);
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('preserves curly quotes and quoted escaped quotes', () => {
    const left = String.fromCharCode(0x201c);
    const right = String.fromCharCode(0x201d);
    const curly = `Search ${left}bread and butter${right} and save`;
    expect(
      requirementsOf(buildCompletionQuestions(requestFor(curly), { clauseSplit: 'conjunction' }))
    ).toEqual([`Search ${left}bread and butter${right}`, 'save']);
    const escape = String.fromCharCode(92);
    const quoted = `Search "rock ${escape}"and${escape}" roll"`;
    const escaped = `${quoted} and save`;
    expect(
      requirementsOf(buildCompletionQuestions(requestFor(escaped), { clauseSplit: 'conjunction' }))
    ).toEqual([quoted, 'save']);
  });

  it.each([
    'Turn promotional email off and turn the weekly digest on',
    'Create a test reservation with my supplied payment details and decline updates',
  ])('keeps the default wire request unchanged for %s', goal => {
    const request = requestFor(goal);
    const baseline = buildCompletionQuestions(request);
    expect(buildCompletionQuestions(request, { clauseSplit: 'punctuation' })).toEqual(baseline);
    expect(requirementsOf(baseline)).toEqual([goal]);
    expect(
      requirementsOf(buildCompletionQuestions(request, { clauseSplit: 'conjunction' }))
    ).toHaveLength(2);
  });

  it('does not split answer goals even when the conjunction option is enabled', () => {
    const request = requestFor('Are email and digest enabled?', true);
    expect(buildCompletionQuestions(request, { clauseSplit: 'conjunction' })).toEqual(
      buildCompletionQuestions(request)
    );
  });

  it('retains all overflow after the eighth requirement within the byte budget', () => {
    const clauses = Array.from({ length: 12 }, (_, index) => `Set requested control ${index + 1}`);
    const request = requestFor(clauses.join(' and '));
    const set = buildCompletionQuestions(request, { clauseSplit: 'conjunction' });
    expect(requirementsOf(set)).toEqual([...clauses.slice(0, 7), clauses.slice(7).join(', ')]);
    expect(estimateRequestBytes(set, 'jev-latest')).toBeLessThanOrEqual(30000);
    expect(set).toEqual(buildCompletionQuestions(request, { clauseSplit: 'conjunction' }));
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });
});

describe('adapter completion clause configuration', () => {
  const httpFor =
    (sets: TaskQuestionSet[], verdict: string = 'SATISFIED'): TaskHttp =>
    async (_url, init) => {
      const set = JSON.parse(init.body) as TaskQuestionSet;
      sets.push(set);
      const answers = Object.fromEntries(
        Object.entries(set.questions).map(([key, question]) => {
          const choices = Object.keys(question.criteria);
          const choice = key.startsWith('completion')
            ? key === 'completion_part_2'
              ? verdict
              : 'SATISFIED'
            : TASK_NONE_APPROPRIATE;
          return [
            key,
            {
              type: 'choice',
              choice,
              confidence: key === 'completion_part_2' ? 0.7 : 0.95,
              probabilities: Object.fromEntries(
                choices.map(value => [value, value === choice ? 1 : 0])
              ),
            },
          ];
        })
      );
      return {
        ok: true,
        status: 200,
        header: () => null,
        json: async () => ({ model: 'jev-1.13.0', answers }),
      };
    };

  it.each(['SATISFIED', 'NOT_SATISFIED', 'UNCERTAIN'])(
    'combines every opted-in part, including %s and its confidence',
    async verdict => {
      const sets: TaskQuestionSet[] = [];
      const request = requestFor('Enable the digest and turn email off');
      const decider = createTypeSafeTaskDecider({
        apiKey: randomUUID(),
        http: httpFor(sets, verdict),
        completionClauseSplit: 'conjunction',
      });
      const result = await decider.verifyCompletion(request, contextFor(request.goal));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.code);
      expect(result.decision.verdict).toBe(verdict);
      expect(result.decision.confidence).toBe(0.7);
      expect(requirementsOf(sets[0] as TaskQuestionSet)).toEqual([
        'Enable the digest',
        'turn email off',
      ]);
    }
  );

  it('captures the config at construction and preserves the default', async () => {
    const request = requestFor('Enable digest and turn email off');
    const sets: TaskQuestionSet[] = [];
    const config = {
      apiKey: randomUUID(),
      http: httpFor(sets),
      completionClauseSplit: 'conjunction' as TaskCompletionClauseSplit,
    };
    const decider = createTypeSafeTaskDecider(config);
    config.completionClauseSplit = 'punctuation';
    await decider.verifyCompletion(request, contextFor(request.goal));
    expect(requirementsOf(sets[0] as TaskQuestionSet)).toHaveLength(2);
    const defaults = createTypeSafeTaskDecider({ apiKey: randomUUID(), http: httpFor(sets) });
    await defaults.verifyCompletion(request, contextFor(request.goal));
    expect(requirementsOf(sets[1] as TaskQuestionSet)).toEqual([request.goal]);
  });

  it.each(['', 'CONJUNCTION', 'sentences', null, 1, {}, []])(
    'refuses invalid configuration %p before sending anything',
    async value => {
      const http = jest.fn<ReturnType<TaskHttp>, Parameters<TaskHttp>>();
      const decider = createTypeSafeTaskDecider({
        apiKey: randomUUID(),
        http,
        completionClauseSplit: value as TypeSafeTaskDeciderConfig['completionClauseSplit'],
      });
      const request = requestFor('Enable digest and turn email off');
      const result = await decider.verifyCompletion(request, contextFor(request.goal));
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST', retryable: false },
      });
      expect(http).not.toHaveBeenCalled();
    }
  );
});
