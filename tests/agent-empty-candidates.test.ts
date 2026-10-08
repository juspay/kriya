/** @jest-environment node */
import { randomUUID } from 'crypto';
import {
  assertGoalPreserved,
  buildArgumentQuestions,
  estimateRequestBytes,
  questionRotations,
} from '@/agent/request';
import { createTypeSafeTaskDecider } from '@/agent/typesafe';
import {
  TASK_KEEP_CURRENT,
  TASK_LIMITS,
  TASK_NONE_APPROPRIATE,
  TASK_REDACTED,
  TASK_REQUIRED_UNAVAILABLE,
  TASK_UNTRUSTED_DATA_RULE,
} from '@/types';
import type {
  TaskArgumentDecision,
  TaskChooseArgumentRequest,
  TaskHttp,
  TaskQuestionSet,
  TypeSafeTaskDeciderConfig,
} from '@/types';
import {
  makeCheckbox,
  makeObservation,
  makeSensitiveField,
  makeTextField,
} from './helpers/agent-fixtures';

const GOAL = 'Keep the existing details unchanged — café.\nUse only supplied data.';
const SENTINELS = [TASK_KEEP_CURRENT, TASK_REQUIRED_UNAVAILABLE, TASK_NONE_APPROPRIATE];
const ASSESSED_PURPOSES = ['requirement', 'validation', 'group'] as const;
type AssessedPurpose = (typeof ASSESSED_PURPOSES)[number];

const requestFor = (
  purpose?: TaskChooseArgumentRequest['purpose'],
  overrides: Partial<TaskChooseArgumentRequest> = {}
): TaskChooseArgumentRequest => {
  const target = makeTextField({ state: { value: 'Observed existing detail' } });
  return {
    goal: GOAL,
    step: 0,
    ...(purpose === undefined ? {} : { purpose }),
    target,
    observation: makeObservation({ elements: [target] }),
    operation: 'FILL',
    slot: 'value',
    candidates: [],
    inputs: [],
    history: [],
    maxStateBytes: TASK_LIMITS.modelStateBytes,
    ...overrides,
  };
};

const argumentKeys = (set: TaskQuestionSet): string[] =>
  Object.keys(set.questions['argument']?.criteria ?? {});

const harness = (
  choices: Readonly<Record<string, string>>,
  overrides: Partial<TypeSafeTaskDeciderConfig> = {}
) => {
  const sent: TaskQuestionSet[] = [];
  const bodies: string[] = [];
  const http: TaskHttp = (_url, init) => {
    const body = JSON.parse(init.body) as TaskQuestionSet;
    sent.push(body);
    bodies.push(init.body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([key, question]) => {
        const choice = choices[key];
        expect(choice).toBeDefined();
        expect(Object.keys(question.criteria)).toContain(choice);
        return [
          key,
          {
            type: 'choice',
            choice,
            confidence: key === 'argument_applicability' ? 0.91 : 0.63,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map(option => [option, option === choice ? 1 : 0])
            ),
          },
        ];
      })
    );
    return Promise.resolve({
      ok: true,
      status: 200,
      header: () => null,
      json: () => Promise.resolve({ model: 'jev-1.13.0', answers }),
    });
  };
  const decider = createTypeSafeTaskDecider({
    apiKey: `test-${randomUUID()}`,
    http,
    ...overrides,
  });
  const choose = (request: TaskChooseArgumentRequest) =>
    decider.chooseArgument(request, {
      goal: request.goal,
      step: request.step,
      runId: 'run_000000000001',
      callIndex: 1,
    });
  return { sent, bodies, choose };
};

describe('empty semantic candidate assessments', () => {
  it.each(ASSESSED_PURPOSES)('keeps semantic choices and literal goal for %s', purpose => {
    for (const step of [0, 1, 5]) {
      for (const rotate of [true, false]) {
        const set = buildArgumentQuestions(requestFor(purpose, { step }), { rotate });
        expect(argumentKeys(set)).toEqual(SENTINELS);
        expect(Object.keys(set.questions)).toEqual(
          purpose === 'group' ? ['argument'] : ['argument_applicability', 'argument']
        );
        expect(assertGoalPreserved(set, GOAL)).toEqual({ ok: true });
        expect(set.state.focus?.value).toBe('Observed existing detail');
        for (const question of Object.values(set.questions)) {
          expect(question.type).toBe('choice');
          expect(Object.keys(question.criteria).length).toBeGreaterThanOrEqual(2);
          expect(question.instructions['rules']).toContain(TASK_UNTRUSTED_DATA_RULE);
        }
        expect(questionRotations(set, step, rotate)['argument']).toBe(0);
      }
    }
  });

  const outcomes: readonly {
    readonly purpose: AssessedPurpose;
    readonly choice: string;
    readonly kind: TaskArgumentDecision['kind'];
  }[] = ASSESSED_PURPOSES.flatMap(purpose => [
    { purpose, choice: TASK_KEEP_CURRENT, kind: 'keep_current' as const },
    { purpose, choice: TASK_REQUIRED_UNAVAILABLE, kind: 'required_unavailable' as const },
    {
      purpose,
      choice: TASK_NONE_APPROPRIATE,
      kind: purpose === 'group' ? ('none_appropriate' as const) : ('required_unavailable' as const),
    },
  ]);

  it.each(outcomes)('roundtrips $purpose / $choice through the adapter', async entry => {
    const fake = harness({ argument_applicability: 'REQUIRED', argument: entry.choice });
    const result = await fake.choose(requestFor(entry.purpose));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: entry.kind, confidence: 0.63 });
      expect(result.exchange.goalVerified).toBe(true);
      expect(result.exchange.rotations?.['argument']).toBe(0);
    }
    expect(fake.sent).toHaveLength(1);
    expect(argumentKeys(fake.sent[0] as TaskQuestionSet)).toEqual(SENTINELS);
    expect(fake.sent[0]?.state.task).toBe(GOAL);
  });

  it.each(['requirement', 'validation'] as const)(
    'retains unrelated and uncertain applicability semantics for %s',
    async purpose => {
      for (const [applicability, kind] of [
        ['UNRELATED', 'none_appropriate'],
        ['UNCERTAIN', 'uncertain_requirement'],
      ] as const) {
        const fake = harness({
          argument_applicability: applicability,
          argument: TASK_REQUIRED_UNAVAILABLE,
        });
        const result = await fake.choose(requestFor(purpose));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.decision).toEqual({ kind, confidence: 0.91 });
        }
        expect(fake.sent).toHaveLength(1);
      }
    }
  );

  it('preserves real observed group context without inventing member candidates', async () => {
    const members = [
      makeCheckbox({ kind: 'radio', role: 'radio', state: { checked: true } }),
      makeCheckbox({ id: 't24', kind: 'radio', role: 'radio', state: { checked: false } }),
    ];
    const request = requestFor('group', {
      target: members[0],
      operation: 'SET_CHECKED',
      slot: 'checked',
      group: { id: 'observed_group', members },
      observation: makeObservation({ elements: members }),
    });
    const fake = harness({ argument: TASK_KEEP_CURRENT });
    const result = await fake.choose(request);
    expect(result.ok).toBe(true);
    expect(fake.sent[0]?.state.group?.members.map(member => member.id)).toEqual(
      members.map(member => member.id)
    );
    expect(fake.sent[0]?.state.group?.members[0]?.checked).toBe(true);
    expect(argumentKeys(fake.sent[0] as TaskQuestionSet)).toEqual(SENTINELS);
    expect(fake.sent[0]?.questions['argument']?.instructions['rules']).toContain(
      'Choose the single desired member of the mutually exclusive group in state.group.'
    );
  });

  it('keeps an empty sensitive field opaque through a real adapter call', async () => {
    const opaque = `runtime-${randomUUID()}`;
    const target = makeSensitiveField({ state: { value: opaque } });
    const request = requestFor('requirement', {
      target,
      observation: makeObservation({ elements: [target] }),
      inputs: [{ path: 'profile.password', description: 'Existing credential', sensitive: true }],
    });
    const fake = harness({ argument_applicability: 'REQUIRED', argument: TASK_KEEP_CURRENT });
    const result = await fake.choose(request);
    expect(result.ok).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.state.focus?.value).toBe(TASK_REDACTED);
    expect(fake.bodies[0]).not.toContain(opaque);
    expect(fake.sent[0]?.state.inputs[0]).toEqual(request.inputs[0]);
  });
});

describe('candidate compatibility and budgets', () => {
  it.each([undefined, 'activation'] as const)(
    'deliberately refuses an empty non-assessed %s request before HTTP',
    async purpose => {
      const request = requestFor(purpose);
      expect(buildArgumentQuestions(request).questions).toEqual({});
      const fake = harness({});
      const result = await fake.choose(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_REQUEST');
        expect(result.error.retryable).toBe(false);
      }
      expect(fake.sent).toHaveLength(0);
    }
  );

  it.each([undefined, 'requirement', 'validation', 'activation', 'group'] as const)(
    'preserves offered ids, first-option rotation and candidate parsing for %s',
    async purpose => {
      const candidates = ['c1', 'c2', 'c3'].map(id => ({
        id,
        source: 'input' as const,
        inputPath: `profile.${id}`,
        label: `Supplied detail ${id}`,
        preview: `Value ${id}`,
        sensitive: false,
      }));
      const request = requestFor(purpose, { candidates, step: 1 });
      const assessed = purpose !== undefined && purpose !== 'activation';
      const applicability = purpose !== undefined && purpose !== 'group';
      const set = buildArgumentQuestions(request);
      expect(argumentKeys(set)).toEqual([
        ...(applicability ? ['c3', 'c1', 'c2'] : ['c2', 'c3', 'c1']),
        ...(assessed ? SENTINELS : [TASK_NONE_APPROPRIATE]),
      ]);
      const fake = harness({ argument_applicability: 'REQUIRED', argument: 'c2' });
      const result = await fake.choose(request);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision).toEqual({ kind: 'candidate', candidateId: 'c2', confidence: 0.63 });
      }
      expect(fake.sent).toHaveLength(1);
    }
  );

  it.each(ASSESSED_PURPOSES)(
    'keeps %s sentinels when the byte budget cannot fit and refuses before HTTP',
    async purpose => {
      const request = requestFor(purpose);
      const set = buildArgumentQuestions(request, { maxRequestBytes: 1 });
      expect(argumentKeys(set)).toEqual(SENTINELS);
      expect(assertGoalPreserved(set, GOAL)).toEqual({ ok: true });
      expect(estimateRequestBytes(set, 'jev-latest')).toBeGreaterThan(1);
      const fake = harness({}, { maxRequestBytes: 1 });
      const result = await fake.choose(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('REQUEST_TOO_LARGE');
      }
      expect(fake.sent).toHaveLength(0);
    }
  );

  it.each(['requirement', 'validation'] as const)(
    'refuses oversized %s supplied data instead of manufacturing its absence',
    async purpose => {
      const request = requestFor(purpose, {
        candidates: Array.from({ length: 20 }, (_, index) => ({
          id: `c${String(index)}`,
          source: 'goal_span' as const,
          label: 'Observed offered detail '.repeat(20),
          preview: 'Supplied literal value '.repeat(20),
          sensitive: false,
        })),
      });
      const empty = buildArgumentQuestions({ ...request, candidates: [] }, { maxRequestBytes: 1 });
      const maxRequestBytes = estimateRequestBytes(empty, 'm'.repeat(64));
      const set = buildArgumentQuestions(request, { maxRequestBytes });
      expect(argumentKeys(set)).toEqual(['c0', ...SENTINELS]);
      expect(estimateRequestBytes(set, 'm'.repeat(64))).toBeGreaterThan(maxRequestBytes);
      const fake = harness(
        { argument_applicability: 'REQUIRED', argument: TASK_KEEP_CURRENT },
        { maxRequestBytes }
      );
      const result = await fake.choose(request);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected oversized request refusal');
      }
      expect(result.error.code).toBe('REQUEST_TOO_LARGE');
      expect(fake.sent).toHaveLength(0);
    }
  );
});
