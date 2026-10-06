/** @jest-environment node */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assertGoalPreserved,
  buildActionQuestions,
  buildArgumentQuestions,
  buildCommitmentQuestions,
  buildCompletionQuestions,
  estimateRequestBytes,
  estimateRequestTokens,
  questionRotations,
} from '@/agent/request';
import {
  TASK_ANSWER_CHOICES,
  TASK_COMMITMENT_CLASSES,
  TASK_LIMITS,
  TASK_NONE_APPROPRIATE,
  TASK_PAGE_TARGET_ID,
  TASK_REDACTED,
  TASK_TYPESAFE_DEFAULTS,
  TASK_TYPESAFE_LIMITS,
  TASK_UNTRUSTED_DATA_RULE,
} from '@/types';
import type {
  ChoiceQuestion,
  TaskAssertGoalPreservedFn,
  TaskBuildActionQuestionsFn,
  TaskBuildArgumentQuestionsFn,
  TaskBuildCommitmentQuestionsFn,
  TaskBuildCompletionQuestionsFn,
  TaskCandidateView,
  TaskChooseActionRequest,
  TaskChooseArgumentRequest,
  TaskClassifyCommitmentRequest,
  TaskElement,
  TaskEstimateRequestBytesFn,
  TaskEstimateRequestTokensFn,
  TaskExpectedState,
  TaskSubmittedControl,
  TaskHistoryEntry,
  TaskInputSummary,
  TaskObservation,
  TaskOffers,
  TaskQuestionSet,
  TaskVerifyCompletionRequest,
} from '@/types';
import {
  FIXTURE_ORIGIN,
  makeCapabilities,
  makeCheckbox,
  makeCommand,
  makeElement,
  makeForm,
  makeObservation,
  makePageElements,
  makeRedactedCommand,
  makeSelectField,
  makeSensitiveField,
  makeSubmitButton,
  makeTextField,
  roundTrip,
  signatureFor,
  summarizeElement,
} from './helpers/agent-fixtures';

export const seamConformance: {
  readonly buildActionQuestions: TaskBuildActionQuestionsFn;
  readonly buildArgumentQuestions: TaskBuildArgumentQuestionsFn;
  readonly buildCommitmentQuestions: TaskBuildCommitmentQuestionsFn;
  readonly buildCompletionQuestions: TaskBuildCompletionQuestionsFn;
  readonly assertGoalPreserved: TaskAssertGoalPreservedFn;
  readonly estimateRequestBytes: TaskEstimateRequestBytesFn;
  readonly estimateRequestTokens: TaskEstimateRequestTokensFn;
} = {
  buildActionQuestions,
  buildArgumentQuestions,
  buildCommitmentQuestions,
  buildCompletionQuestions,
  assertGoalPreserved,
  estimateRequestBytes,
  estimateRequestTokens,
};

const GOAL = 'Find the cheapest blue umbrella and add it to the cart';
const CANARY = 'Canary-Label-9f3a';
const MODEL = 'jev-latest';
// Generated at run time: no literal secret exists in this file.
const SECRET = `hunter-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

const OPERATION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  READ: 'Read a rendered passage as evidence. Does not change the page.',
  CLICK: 'Activate a control that is not a link, a form submitter, a field or a switch.',
  NAVIGATE: 'Follow an observed link.',
  FILL: 'Enter or clear text in an editable field. The value is chosen afterwards from supplied candidates.',
  SELECT: 'Choose an option in a dropdown or listbox.',
  SET_CHECKED: 'Set a checkbox, radio or switch to a requested state.',
  PRESS: 'Press a key on a field.',
  SCROLL: 'Scroll the page or a scrollable region.',
  WAIT: 'Wait for the page to change.',
  SUBMIT: 'Submit a form through its submit control.',
  DONE: 'Every requirement of the task is visibly satisfied by the current page.',
  BLOCKED: 'No offered operation can make progress on the task.',
};

const NONE_DESCRIPTION = 'None of the offered options is appropriate.';

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

const questionOf = (set: TaskQuestionSet, key: string): ChoiceQuestion =>
  must(set.questions[key], `question ${key}`);
const keysOf = (question: ChoiceQuestion): string[] => Object.keys(question.criteria);
const withoutSentinels = (keys: readonly string[], sentinels: readonly string[]): string[] =>
  keys.filter(key => !sentinels.includes(key));
const rotateBy = <T>(list: readonly T[], offset: number): T[] =>
  list.map((_, index) => must(list[(index + offset) % list.length], 'rotated item'));
const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
};
const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

const PAGE_OFFERS: TaskOffers = {
  operations: [
    'READ',
    'CLICK',
    'NAVIGATE',
    'FILL',
    'SELECT',
    'SET_CHECKED',
    'SUBMIT',
    'SCROLL',
    'WAIT',
    'DONE',
    'BLOCKED',
  ],
  targets: {
    READ: ['t7'],
    CLICK: ['t1'],
    NAVIGATE: ['t2'],
    FILL: ['t3', 't8'],
    SELECT: ['t5'],
    SET_CHECKED: ['t4'],
    SUBMIT: ['t6'],
    SCROLL: [TASK_PAGE_TARGET_ID],
  },
};

const pageObservation = (overrides: Partial<TaskObservation> = {}): TaskObservation =>
  makeObservation({ elements: makePageElements(), ...overrides });

const actionRequest = (
  overrides: Partial<TaskChooseActionRequest> = {}
): TaskChooseActionRequest => ({
  goal: GOAL,
  step: 0,
  observation: pageObservation(),
  offers: PAGE_OFFERS,
  capabilities: makeCapabilities(),
  inputs: [],
  history: [],
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

const CANDIDATES: readonly TaskCandidateView[] = [
  {
    id: 'c1',
    source: 'goal_span',
    label: 'Goal text: blue umbrella',
    preview: 'blue umbrella',
    sensitive: false,
  },
  { id: 'c2', source: 'input', label: 'email', preview: 'a@example.test', sensitive: false },
  { id: 'c3', source: 'input', label: 'Account password', sensitive: true },
];

const argumentRequest = (
  overrides: Partial<TaskChooseArgumentRequest> = {}
): TaskChooseArgumentRequest => ({
  goal: GOAL,
  step: 0,
  observation: pageObservation(),
  operation: 'FILL',
  target: makeTextField(),
  slot: 'value',
  candidates: CANDIDATES,
  inputs: [],
  history: [],
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

const commitmentRequest = (
  overrides: Partial<TaskClassifyCommitmentRequest> = {}
): TaskClassifyCommitmentRequest => ({
  goal: GOAL,
  step: 0,
  observation: pageObservation({
    elements: [
      makeTextField({ state: { value: 'Ada Lovelace' } }),
      makeSubmitButton(),
      makeSensitiveField({ state: { value: TASK_REDACTED } }),
      makeElement({ id: 't1', label: 'Unrelated' }),
    ],
    notices: [{ kind: 'alert', text: 'This purchase is free of charge' }],
  }),
  command: makeRedactedCommand({
    command: makeCommand('SUBMIT'),
    target: summarizeElement(makeSubmitButton()),
  }),
  target: makeSubmitButton(),
  form: makeForm({ fieldIds: ['t3', 't8'] }),
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

const completionRequest = (
  overrides: Partial<TaskVerifyCompletionRequest> = {}
): TaskVerifyCompletionRequest => ({
  goal: GOAL,
  step: 3,
  observation: pageObservation(),
  history: [],
  inputs: [],
  evidenceSlots: 2,
  collectedEvidence: [
    {
      id: 'e1',
      ledgerSeq: 2,
      url: `${FIXTURE_ORIGIN}/help`,
      label: 'Shipping policy',
      text: 'Orders ship in two days.',
    },
    {
      id: 'e2',
      ledgerSeq: 4,
      url: `${FIXTURE_ORIGIN}/faq`,
      label: 'Returns',
      text: 'Thirty day returns.',
    },
  ],
  expected: [
    {
      label: 'Name',
      kind: 'field_value',
      expected: 'Ada Lovelace',
      sensitive: false,
      status: 'holds',
    },
    { label: 'Password', kind: 'field_value', expected: true, sensitive: true, status: 'holds' },
  ],
  expectAnswer: true,
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

type OfferedElementOptions = {
  readonly inViewport?: boolean;
  readonly offered?: boolean;
  readonly dialogId?: string;
};

/** A button t<index> that the CLICK operation can offer; label length makes each element about 350 bytes. */
const buttonAt = (index: number, options: OfferedElementOptions = {}): TaskElement =>
  makeElement({
    id: `t${String(index)}`,
    signature: signatureFor(`t${String(index)}`),
    label: `Product number ${String(index)} ${'lorem ipsum '.repeat(12)}`,
    href: `${FIXTURE_ORIGIN}/products/${String(index)}`,
    region: 'Results',
    inViewport: options.inViewport ?? true,
    operations: options.offered === false ? [] : ['CLICK'],
    ...(options.dialogId === undefined ? {} : { dialogId: options.dialogId }),
  });

const clickOffers = (elements: readonly TaskElement[]): TaskOffers => ({
  operations: ['CLICK', 'DONE', 'BLOCKED'],
  targets: {
    CLICK: elements
      .filter(element => element.operations.includes('CLICK'))
      .map(element => element.id),
  },
});

const bigObservation = (count: number): TaskObservation =>
  makeObservation({
    text: 'Search results page. '.repeat(280),
    elements: Array.from({ length: count }, (_, index) =>
      buttonAt(index + 1, { inViewport: index % 3 !== 0 })
    ),
  });

const bigRequest = (count: number, overrides: Partial<TaskChooseActionRequest> = {}) => {
  const observation = bigObservation(count);
  return actionRequest({ observation, offers: clickOffers(observation.elements), ...overrides });
};

const stateIds = (set: TaskQuestionSet): string[] => set.state.elements.map(element => element.id);

const allQuestionSets = (): readonly TaskQuestionSet[] => [
  buildActionQuestions(actionRequest()),
  buildArgumentQuestions(argumentRequest()),
  buildCommitmentQuestions(commitmentRequest(), 'forward'),
  buildCommitmentQuestions(commitmentRequest(), 'reverse'),
  buildCompletionQuestions(completionRequest()),
];

describe('assertGoalPreserved', () => {
  it('accepts every stage built from a goal', () => {
    for (const set of allQuestionSets()) {
      expect(assertGoalPreserved(set, GOAL)).toEqual({ ok: true });
    }
  });

  it('rejects a goal that differs by a single character, naming the question', () => {
    const set = buildActionQuestions(actionRequest());
    expect(assertGoalPreserved(set, `${GOAL}.`)).toEqual({ ok: false, questionKey: 'state' });
    const target = questionOf(set, 'click_target');
    const tampered: TaskQuestionSet = {
      ...set,
      questions: {
        ...set.questions,
        click_target: {
          ...target,
          instructions: { ...target.instructions, goal: GOAL.replace('blue', 'red') },
        },
      },
    };
    expect(assertGoalPreserved(tampered, GOAL)).toEqual({ ok: false, questionKey: 'click_target' });
  });

  it('rejects a state whose task was rewritten and a question with no goal', () => {
    const set = buildCompletionQuestions(completionRequest());
    expect(
      assertGoalPreserved({ ...set, state: { ...set.state, task: 'Something else' } }, GOAL)
    ).toEqual({
      ok: false,
      questionKey: 'state',
    });
    const completion = questionOf(set, 'completion');
    const { goal: _removed, ...withoutGoal } = completion.instructions;
    const missing: TaskQuestionSet = {
      ...set,
      questions: { ...set.questions, completion: { ...completion, instructions: withoutGoal } },
    };
    expect(assertGoalPreserved(missing, GOAL)).toEqual({ ok: false, questionKey: 'completion' });
  });

  it('is strict string equality: no trimming and no case folding', () => {
    const set = buildActionQuestions(actionRequest({ goal: ` ${GOAL.toUpperCase()}\n` }));
    expect(assertGoalPreserved(set, ` ${GOAL.toUpperCase()}\n`)).toEqual({ ok: true });
    expect(assertGoalPreserved(set, GOAL.toUpperCase())).toEqual({
      ok: false,
      questionKey: 'state',
    });
  });
});

describe('goal preservation in every question', () => {
  it('copies the literal goal, byte for byte, into state.task and every question of every stage', () => {
    const goal = `  Buy "umbrella" é日本 ${String.fromCodePoint(0x1f600)}\n and [t12] ok  `;
    const sets = [
      buildActionQuestions(actionRequest({ goal })),
      buildArgumentQuestions(argumentRequest({ goal })),
      buildCommitmentQuestions(commitmentRequest({ goal }), 'forward'),
      buildCompletionQuestions(completionRequest({ goal })),
    ];
    for (const set of sets) {
      expect(set.state.task).toBe(goal);
      const keys = Object.keys(set.questions);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(questionOf(set, key).instructions['goal']).toBe(goal);
      }
    }
  });

  it('never shortens the goal to fit the budget: a goal at the 1500 byte limit with ten questions still fits', () => {
    const goal = 'g'.repeat(TASK_LIMITS.goalBytes);
    const observation = bigObservation(120);
    const operations = [
      'READ',
      'CLICK',
      'NAVIGATE',
      'FILL',
      'SELECT',
      'SET_CHECKED',
      'PRESS',
      'SUBMIT',
      'SCROLL',
    ] as const;
    const ids = observation.elements.map(element => element.id);
    const offers: TaskOffers = {
      operations: [...operations, 'WAIT', 'DONE', 'BLOCKED'],
      targets: Object.fromEntries(operations.map(op => [op, ids])),
    };
    const set = buildActionQuestions(actionRequest({ goal, observation, offers }));
    expect(Object.keys(set.questions).length).toBe(10);
    expect(set.state.task).toBe(goal);
    for (const key of Object.keys(set.questions)) {
      expect(questionOf(set, key).instructions['goal']).toBe(goal);
    }
    expect(estimateRequestBytes(set, MODEL)).toBeLessThanOrEqual(
      TASK_TYPESAFE_DEFAULTS.maxRequestBytes
    );
  });

  it('reserves the goal copies first: a goal too large for the budget leaves a request over the budget, unshortened', () => {
    const goal = 'x'.repeat(12000);
    const set = buildActionQuestions(bigRequest(40, { goal }));
    expect(set.state.task).toBe(goal);
    expect(questionOf(set, 'operation').instructions['goal']).toBe(goal);
    expect(estimateRequestBytes(set, MODEL)).toBeGreaterThan(
      TASK_TYPESAFE_DEFAULTS.maxRequestBytes
    );
    expect(set.state.elements.length).toBe(1);
    expect(set.state.page.text).toBe('');
  });

  it('counts the goal in bytes, not characters', () => {
    const goal = 'g'.repeat(1000) + '日'.repeat(100);
    const set = buildCompletionQuestions(completionRequest({ goal }));
    expect(bytesOf(set.state.task)).toBe(1300);
    expect(estimateRequestBytes(set, MODEL)).toBeGreaterThanOrEqual(5 * 1300);
  });
});

describe('stage 1: chooseAction', () => {
  it('offers every operation with its library description, DONE and BLOCKED last', () => {
    const set = buildActionQuestions(actionRequest(), { rotate: false });
    expect(set.stage).toBe('action');
    const operation = questionOf(set, 'operation');
    expect(keysOf(operation)).toEqual(PAGE_OFFERS.operations);
    for (const key of keysOf(operation)) {
      expect(operation.criteria[key]).toBe(OPERATION_DESCRIPTIONS[key]);
    }
    expect(operation.type).toBe('choice');
  });

  it('describes PRESS and drops an operation that has no targets', () => {
    const offers: TaskOffers = {
      operations: ['PRESS', 'FILL', 'CLICK', 'DONE', 'BLOCKED'],
      targets: { PRESS: ['t3'], FILL: [] },
    };
    const set = buildActionQuestions(actionRequest({ offers }), { rotate: false });
    expect(keysOf(questionOf(set, 'operation'))).toEqual(['PRESS', 'DONE', 'BLOCKED']);
    expect(questionOf(set, 'operation').criteria['PRESS']).toBe(OPERATION_DESCRIPTIONS['PRESS']);
    expect(Object.keys(set.questions)).toEqual(['operation', 'press_target']);
  });

  it('honors withheld DONE, retains BLOCKED, and ignores unknown operations', () => {
    const offers = {
      operations: ['CLICK', 'TELEPORT'],
      targets: { CLICK: ['t1'] },
    } as unknown as TaskOffers;
    const set = buildActionQuestions(actionRequest({ offers }), { rotate: false });
    expect(keysOf(questionOf(set, 'operation'))).toEqual(['CLICK', 'BLOCKED']);
  });

  it('asks one target question per offered operation that has targets, keyed by the operation', () => {
    const set = buildActionQuestions(actionRequest(), { rotate: false });
    expect(Object.keys(set.questions)).toEqual([
      'operation',
      'read_target',
      'click_target',
      'navigate_target',
      'fill_target',
      'select_target',
      'set_checked_target',
      'submit_target',
      'scroll_target',
    ]);
    const fill = questionOf(set, 'fill_target');
    expect(keysOf(fill)).toEqual(['t3', 't8', TASK_NONE_APPROPRIATE]);
    expect(fill.criteria[TASK_NONE_APPROPRIATE]).toBe(NONE_DESCRIPTION);
    expect(Object.keys(fill.instructions)).toEqual(['goal', 'operation', 'rules']);
    expect(fill.instructions['operation']).toBe('FILL');
  });

  it('describes each target as flat strings: element id and label, role, kind, state and operation hint', () => {
    const observation = pageObservation({
      elements: [
        makeElement({ id: 't1', label: 'Pay', state: { disabled: true } }),
        makeTextField({ state: { value: 'Ada', required: true, invalid: true } }),
        makeCheckbox(),
        makeSelectField(),
        makeSubmitButton(),
        makeElement({
          id: 't2',
          role: 'link',
          kind: 'link',
          label: 'Help',
          href: `${FIXTURE_ORIGIN}/help`,
          region: 'Footer',
          operations: ['NAVIGATE'],
        }),
      ],
    });
    const set = buildActionQuestions(actionRequest({ observation }), { rotate: false });
    const valueOf = (key: string, id: string): unknown => questionOf(set, key).criteria[id];
    expect(valueOf('click_target', 't1')).toEqual({
      element: '[t1] Pay',
      role: 'button',
      kind: 'button',
      disabled: 'true',
    });
    expect(valueOf('fill_target', 't3')).toEqual({
      element: '[t3] Name',
      role: 'textbox',
      kind: 'text_input',
      currentValue: 'Ada',
      inputType: 'text',
      required: 'true',
      invalid: 'true',
    });
    expect(valueOf('set_checked_target', 't4')).toEqual({
      element: '[t4] Subscribe',
      role: 'checkbox',
      kind: 'checkbox',
      checked: 'false',
    });
    expect(valueOf('select_target', 't5')).toEqual({
      element: '[t5] Country',
      role: 'combobox',
      kind: 'select',
      currentValue: 'India',
      required: 'false',
      operationHint: 'chooses among its options',
    });
    expect(valueOf('submit_target', 't6')).toEqual({
      element: '[t6] Submit',
      formId: 'f1',
      role: 'button',
      kind: 'button',
      operationHint: 'submits its form',
    });
    expect(valueOf('navigate_target', 't2')).toEqual({
      element: '[t2] Help',
      role: 'link',
      kind: 'link',
      href: `${FIXTURE_ORIGIN}/help`,
      region: 'Footer',
    });
  });

  it('offers the whole page as a scroll target and an ARIA option as a select target', () => {
    const observation = pageObservation({
      elements: [
        makeElement({
          id: 't9',
          role: 'option',
          kind: 'option',
          label: 'Large',
          operations: ['SELECT'],
        }),
        makeElement({
          id: 't10',
          role: 'region',
          kind: 'scroller',
          label: 'Results list',
          operations: ['SCROLL'],
        }),
      ],
    });
    const offers: TaskOffers = {
      operations: ['SELECT', 'SCROLL', 'DONE', 'BLOCKED'],
      targets: { SELECT: ['t9'], SCROLL: [TASK_PAGE_TARGET_ID, 't10'] },
    };
    const set = buildActionQuestions(actionRequest({ observation, offers }), { rotate: false });
    expect(keysOf(questionOf(set, 'scroll_target'))).toEqual([
      TASK_PAGE_TARGET_ID,
      't10',
      TASK_NONE_APPROPRIATE,
    ]);
    expect(questionOf(set, 'scroll_target').criteria[TASK_PAGE_TARGET_ID]).toBe('The whole page');
    expect(asRecord(questionOf(set, 'scroll_target').criteria['t10'])['operationHint']).toBe(
      'scrollable region'
    );
    expect(asRecord(questionOf(set, 'select_target').criteria['t9'])['operationHint']).toBe(
      'selects this option'
    );
  });

  it('puts the page, controls, notices, validation, inputs, history and unobserved counts into the state', () => {
    const history: readonly TaskHistoryEntry[] = [
      {
        step: 1,
        kind: 'action',
        operation: 'FILL',
        target: 'Name',
        outcome: 'applied',
        effect: 'applied',
        changed: true,
        matched: null,
      },
    ];
    const inputs: readonly TaskInputSummary[] = [
      { path: 'email', sensitive: false, description: 'Contact email', preview: 'a@example.test' },
    ];
    const observation = pageObservation({
      title: 'Checkout',
      text: 'Order summary',
      notices: [{ kind: 'status', text: 'Saved' }],
      validation: [{ source: 'native', text: 'Name is required', targetId: 't3' }],
      page: {
        readyState: 'complete',
        busy: false,
        scroll: { directions: ['DOWN', 'BOTTOM'], top: 0, max: 900 },
        viewport: { width: 800, height: 600 },
      },
      unobserved: {
        iframes: 2,
        shadowRoots: 0,
        canvases: 1,
        contentEditable: 0,
        multiSelects: 0,
        externalTargets: 3,
      },
    });
    const capabilities = makeCapabilities({ waitDurationsMs: [250, 1000] });
    const set = buildActionQuestions(actionRequest({ observation, history, inputs, capabilities }));
    expect(set.state.page).toEqual({
      url: observation.url,
      title: 'Checkout',
      text: 'Order summary',
    });
    expect(set.state.pageControls).toEqual({
      scroll: { directions: ['DOWN', 'BOTTOM'] },
      waitDurationsMs: [250, 1000],
    });
    expect(set.state.notices).toEqual(['status: Saved']);
    expect(set.state.validation).toEqual(['[t3] Name is required']);
    expect(set.state.inputs).toEqual(inputs);
    expect(set.state.recentActions).toEqual(history);
    expect(set.state.unobserved).toEqual(observation.unobserved);
    expect(set.state.truncation).toEqual({ elementsOmitted: 0, textTruncated: false });
  });

  it('shows each element only with its offered operations and its options with the selected one first-class', () => {
    const set = buildActionQuestions(actionRequest());
    const submit = must(
      set.state.elements.find(element => element.id === 't6'),
      't6'
    );
    expect(submit.operations).toEqual(['SUBMIT']);
    expect(submit.inViewport).toBe(true);
    const select = must(
      set.state.elements.find(element => element.id === 't5'),
      't5'
    );
    expect(select.options).toEqual([
      { id: 't5.1', label: 'India', selected: true },
      { id: 't5.2', label: 'France', selected: false },
    ]);
    expect(select.optionCount).toBe(2);
    const passage = must(
      set.state.elements.find(element => element.id === 't7'),
      't7'
    );
    expect(passage.text).toBe('Orders ship in two days.');
  });

  it('keeps at most 20 options per element and keeps the selected one', () => {
    const options = Array.from({ length: 30 }, (_, index) => ({
      id: `t5.${String(index + 1)}`,
      label: `Option ${String(index + 1)}`,
      value: `v${String(index + 1)}`,
      selected: index === 25,
      disabled: false,
    }));
    const observation = pageObservation({ elements: [makeSelectField({ options })] });
    const offers: TaskOffers = {
      operations: ['SELECT', 'DONE', 'BLOCKED'],
      targets: { SELECT: ['t5'] },
    };
    const set = buildActionQuestions(actionRequest({ observation, offers }));
    const shown = must(set.state.elements[0], 'select').options ?? [];
    expect(shown.length).toBe(20);
    expect(shown.some(option => option.id === 't5.26' && option.selected)).toBe(true);
    expect(set.state.elements[0]?.optionCount).toBe(30);
    const ids = shown.map(option => Number(option.id.slice(3)));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('is deterministic and JSON-safe: the same request builds the same set, and it round-trips', () => {
    const request = actionRequest({ step: 5 });
    const first = buildActionQuestions(request);
    const second = buildActionQuestions(request);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(roundTrip(first)).toStrictEqual(first);
    for (const set of allQuestionSets()) {
      expect(roundTrip(set)).toStrictEqual(set);
    }
  });

  it('keeps only the most recent twelve history entries, newest last', () => {
    const history: readonly TaskHistoryEntry[] = Array.from({ length: 20 }, (_, index) => ({
      step: index + 1,
      kind: 'action',
      operation: 'CLICK',
      outcome: 'applied',
    }));
    const set = buildActionQuestions(actionRequest({ history }));
    expect(set.state.recentActions.length).toBe(TASK_LIMITS.historyEntries);
    expect(set.state.recentActions.map(entry => entry.step)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 9)
    );
  });

  it('does not mutate the request', () => {
    const request = actionRequest({ step: 2 });
    const before = JSON.stringify(request);
    buildActionQuestions(request);
    expect(JSON.stringify(request)).toBe(before);
  });
});

describe('stage 2: chooseArgument', () => {
  it('keeps requested-form use independent of selecting unused supplied payment data', () => {
    const goal = 'Use the existing stored payment method and the supplied delivery details.';
    const request = argumentRequest({
      purpose: 'requirement',
      goal,
      target: makeSensitiveField({ formId: 'fPayment' }),
      candidates: [
        {
          id: 'c1',
          source: 'input',
          inputPath: 'unused.payment',
          sensitive: true,
          label: 'Unused supplied payment',
          preview: SECRET,
        },
      ],
    });
    const set = buildArgumentQuestions(request);
    expect(questionOf(set, 'argument_applicability').criteria['REQUIRED']).toContain(
      'independently judges what to use or preserve'
    );
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'unused supplied data stays unused'
    );
    expect(questionOf(set, 'argument').instructions['rules']).toContain(
      'Form participation alone never selects a value'
    );
    expect(questionOf(set, 'argument').instructions['rules']).toContain(
      'existing/stored method with an unused supplied reference'
    );
    expect(questionOf(set, 'argument').criteria['KEEP_CURRENT']).toBeDefined();
    expect(questionOf(set, 'argument').criteria['c1']).toBeDefined();
    expect(JSON.stringify(set)).not.toContain(SECRET);
    expect(assertGoalPreserved(set, goal)).toEqual({ ok: true });
  });

  it('keeps unspecified optional details distinct from supplied or explicitly requested missing data', () => {
    const target = makeTextField({
      id: 't81',
      label: 'Apartment or unit',
      inputName: 'shipping.address2',
      autocomplete: 'address-line2',
      formId: 'fDelivery',
      state: { required: false, value: '' },
    });
    const candidate = {
      id: 'c1',
      source: 'input' as const,
      inputPath: 'shipping.address1',
      label: 'Supplied street',
      sensitive: false,
      preview: '77 Example Street',
    };
    const goals = [
      'Use my supplied delivery address.',
      'Use my supplied delivery address, including an apartment number I have not provided.',
    ];
    for (const goal of goals) {
      const request = argumentRequest({
        purpose: 'requirement',
        target,
        goal,
        candidates: [candidate],
      });
      const set = buildArgumentQuestions(request);
      const scope = questionOf(set, 'argument_applicability').instructions['rules'] ?? '';
      const value = questionOf(set, 'argument').instructions['rules'] ?? '';
      expect(scope).toContain('may contain unspecified optional fields');
      expect(scope).toContain('not discarded solely because the literal goal omits the field name');
      expect(scope).toContain('Empty lists do not exclude semantic matches');
      expect(value).toContain('Do not invent missing optional data');
      expect(value).toContain('still needs REQUIRED_UNAVAILABLE, even if HTML marks it optional');
      expect(value).toContain(
        'state.matchingSuppliedInputPaths or state.compatibleSuppliedInputPaths fits this field'
      );
      expect(value).toContain('unless the goal asks to leave the field empty or unchanged');
      expect(set.state.matchingSuppliedInputPaths).toEqual([]);
      expect(set.state.compatibleSuppliedInputPaths).toEqual([]);
      expect(set.state.focus?.required).toBe(false);
      expect(questionOf(set, 'argument').criteria['KEEP_CURRENT']).toBeDefined();
      expect(questionOf(set, 'argument').criteria['REQUIRED_UNAVAILABLE']).toBeDefined();
      expect(assertGoalPreserved(set, goal)).toEqual({ ok: true });
    }
    const supplied = buildArgumentQuestions(
      argumentRequest({
        purpose: 'requirement',
        target,
        candidates: [{ ...candidate, inputPath: 'shipping.address2', label: 'Supplied unit' }],
      })
    );
    expect(supplied.state.matchingSuppliedInputPaths).toEqual(['shipping.address2']);
    expect(supplied.state.compatibleSuppliedInputPaths).toEqual(['shipping.address2']);
  });

  it('isolates supplied data assessment to the actual form while preserving parent and opaque-input facts', () => {
    const target = makeTextField({
      id: 't40',
      formId: 'fDelivery',
      inputName: 'phone',
      autocomplete: 'tel',
      label: 'Phone (optional)',
    });
    const parent = makeSelectField({ id: 't41', formId: 'fDelivery', label: 'Country' });
    const submit = makeSubmitButton({ id: 't42', formId: 'fDelivery' });
    const unrelated = makeTextField({
      id: 't43',
      formId: 'fNewsletter',
      label: 'Subscribe by email',
    });
    const outsider = makeCheckbox({ id: 't44', label: 'An independent preference' });
    const observation = pageObservation({
      elements: [target, parent, submit, unrelated, outsider],
    });
    const goalRequirements = [
      {
        targetId: outsider.id,
        operation: 'SET_CHECKED' as const,
        desired: 'Preserve another assessed state',
        satisfied: true,
      },
    ];
    const request = argumentRequest({
      purpose: 'requirement',
      target,
      observation,
      goal: 'Enter the delivery details from my supplied profile.',
      goalRequirements,
      inputs: [{ path: 'profile.phone', sensitive: true, preview: SECRET }],
      candidates: [
        {
          id: 'c1',
          source: 'input',
          inputPath: 'profile.phone',
          label: 'Supplied phone',
          sensitive: true,
          preview: SECRET,
        },
      ],
    });
    const set = buildArgumentQuestions(request);
    expect(stateIds(set)).toEqual([target.id, parent.id, submit.id]);
    expect(set.state.goalRequirements).toEqual(goalRequirements);
    expect(set.state.focus?.autocomplete).toBe('tel');
    expect(set.state.compatibleSuppliedInputPaths).toEqual(['profile.phone']);
    expect(set.state.elements.find(element => element.id === parent.id)?.options).toBeDefined();
    expect(set.state.page.text).toBe(observation.text);
    expect(set.state.truncation.elementsOmitted).toBe(2);
    expect(JSON.stringify(set)).not.toContain(SECRET);
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'including optional contact/address details'
    );
    expect(questionOf(set, 'argument_applicability').instructions['rules']).not.toContain(
      'Promotional email does not request SMS'
    );
    expect(questionOf(set, 'argument').instructions['rules']).not.toContain(
      'Turning promotional email off'
    );
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('isolates a formless state control without dropping goal or historical counterevidence', () => {
    const target = makeCheckbox({
      id: 't51',
      formId: undefined,
      label: 'Text message preference',
      state: { checked: true },
    });
    const other = makeCheckbox({
      id: 't52',
      formId: undefined,
      label: 'Email preference',
      state: { checked: false },
    });
    const goalRequirements = [
      {
        targetId: other.id,
        operation: 'SET_CHECKED' as const,
        desired: 'Email off',
        satisfied: true,
      },
    ];
    const expected: readonly TaskExpectedState[] = [
      { label: other.label, kind: 'checked', expected: false, sensitive: false, status: 'holds' },
    ];
    const request = argumentRequest({
      purpose: 'requirement',
      operation: 'SET_CHECKED',
      slot: 'checked',
      target,
      observation: pageObservation({ elements: [other, target] }),
      goalRequirements,
      expected,
    });
    const set = buildArgumentQuestions(request);
    expect(stateIds(set)).toEqual([target.id]);
    expect(set.state.goalRequirements).toEqual(goalRequirements);
    expect(set.state.expected).toEqual(expected);
    expect(set.state.focus?.checked).toBe(true);
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'Preserve unrequested communication channels'
    );
    expect(questionOf(set, 'argument_applicability').instructions['rules']).not.toContain(
      'including optional contact/address details'
    );
    expect(questionOf(set, 'argument').instructions['rules']).not.toContain('For facet-only tasks');
  });

  it('uses actual optional facet labels/options and distinguishes review from final payment', () => {
    const target = makeSelectField({
      label: 'Price',
      inputName: 'maxPrice',
      state: { required: false },
      options: [{ id: 'o1', label: 'Up to $50', value: '50', selected: false, disabled: false }],
    });
    const request = argumentRequest({
      purpose: 'requirement',
      goal: 'Show the requested maker below $50.',
      target,
      operation: 'SELECT',
      slot: 'option',
    });
    const set = buildArgumentQuestions(request);
    const rules = questionOf(set, 'argument_applicability').instructions['rules'] ?? '';
    expect(rules).toContain('applying requested facets count');
    expect(rules).toContain('the independent value question determines the requested source');
    expect(rules).toContain('Optional status alone does not settle form use or value need');
    expect(rules).toContain('subscriber data fields used only to enroll');
    expect(rules).toContain(
      'a separate peripheral signup form for the same preference is UNRELATED'
    );
    expect(set.state.focus?.options?.[0]?.label).toBe('Up to $50');
    expect(set.state.focus?.required).toBe(false);
    const review = buildArgumentQuestions(
      argumentRequest({
        purpose: 'activation',
        operation: 'SUBMIT',
        slot: undefined,
        goal: 'Bring me to review before paying.',
        target: makeSubmitButton(),
      })
    );
    expect(questionOf(review, 'argument_applicability').instructions['rules']).toContain(
      'requested review or next stage is REQUIRED'
    );
    expect(questionOf(review, 'argument_applicability').instructions['rules']).toContain(
      'distinct from a later payment'
    );
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('distinguishes explicitly requested header search from unrequested facet-derived query text', () => {
    const target = makeTextField({
      label: 'Search products',
      inputType: 'search',
      landmark: 'header',
    });
    for (const goal of [
      'Search for "wireless" and filter by category.',
      'Show a requested brand below a budget, cheapest first.',
    ]) {
      const set = buildArgumentQuestions(argumentRequest({ purpose: 'requirement', goal, target }));
      const scope = questionOf(set, 'argument_applicability').instructions['rules'] ?? '';
      const value = questionOf(set, 'argument').instructions['rules'] ?? '';
      expect(scope).toContain('without inventing an additional query');
      expect(scope).toContain('Choose UNRELATED for an unrequested free-text search');
      expect(scope).toContain('even in the header');
      expect(scope).not.toContain('choose UNCERTAIN for an unidentified result control');
      expect(value).toContain('For facet-only tasks, keep the query unchanged');
      expect(value).toContain('choose the literal requested phrase, even in a header form');
      expect(set.state.focus?.inputType).toBe('search');
      expect(set.state.focus?.landmark).toBe('header');
      expect(assertGoalPreserved(set, goal)).toEqual({ ok: true });
    }
  });

  it('keeps independent notification channels distinct from submitted ancillary opt-ins', () => {
    const target = makeCheckbox({ label: 'Text message offers', state: { checked: true } });
    const request = argumentRequest({
      purpose: 'requirement',
      goal: 'Make sure promotional email is off.',
      operation: 'SET_CHECKED',
      slot: 'checked',
      target,
    });
    const set = buildArgumentQuestions(request);
    const scope = questionOf(set, 'argument_applicability').instructions['rules'] ?? '';
    const value = questionOf(set, 'argument').instructions['rules'] ?? '';
    expect(scope).toContain('Preserve unrequested communication channels');
    expect(scope).toContain('explicitly requested preservation requires KEEP_CURRENT');
    expect(scope).toContain('assess them UNRELATED unless explicitly constrained');
    expect(scope).toContain(
      'A preference control for a different channel or subscription than the one the literal goal names'
    );
    expect(scope).toContain('unless the goal covers every channel or all communication');
    expect(value).toContain('outside the requested channel or purpose, choose KEEP_CURRENT');
    expect(value).toContain('unrequested opt-in carried by that submission');
    expect(value).toContain('Preserve unrelated independent preferences');
    expect(value).not.toContain('Assume state.focus is relevant');
    expect(value).not.toContain('choose unchecked for an unrequested extra');
    expect(set.state.focus?.checked).toBe(true);
    expect(questionOf(set, 'argument').criteria['KEEP_CURRENT']).toBeDefined();
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('keeps an observed header search submitter available for a literal search request', () => {
    const target = makeSubmitButton({ label: 'Search', landmark: 'header' });
    const request = argumentRequest({
      purpose: 'activation',
      operation: 'SUBMIT',
      slot: undefined,
      goal: 'Search the store for "wireless".',
      target,
    });
    const set = buildArgumentQuestions(request);
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'Header placement does not exclude an explicitly requested search'
    );
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'A site-wide search form, or a discount or promo code form, in the page header, navigation or an aside is UNRELATED when the goal names no search phrase, no code and no drafted facet that this form applies'
    );
    expect(questionOf(set, 'argument').instructions['rules']).toContain('including a header form');
    expect(set.state.focus?.operations).toContain('SUBMIT');
    expect(questionOf(set, 'argument').criteria[TASK_NONE_APPROPRIATE]).toBeDefined();
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('keeps an observed facet application form relevant without requesting additional query text', () => {
    const target = makeSubmitButton({ label: 'Show results', formId: 'f2', landmark: 'main' });
    const request = argumentRequest({
      purpose: 'activation',
      operation: 'SUBMIT',
      slot: undefined,
      goal: 'Show the requested maker below the budget.',
      target,
    });
    const set = buildArgumentQuestions(request);
    const scope = questionOf(set, 'argument_applicability').instructions['rules'] ?? '';
    const activation = questionOf(set, 'argument').instructions['rules'] ?? '';
    expect(scope).toContain(
      'containing form remains relevant when submission applies those requested choices'
    );
    expect(activation).toContain('keep its unrequested query unchanged');
    expect(scope).toContain(
      'independent form with no requested field changes or necessary goal continuation is UNRELATED'
    );
    expect(set.state.focus?.formId).toBe('f2');
    expect(questionOf(set, 'argument').criteria[TASK_NONE_APPROPRIATE]).toBeDefined();
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('asks about the control own requested state or effect without equating relevance with mutation', () => {
    const target = makeTextField({
      label: 'Quantity of an existing cart item',
      state: { value: '2' },
    });
    const request = argumentRequest({
      purpose: 'requirement',
      goal: 'Buy the existing whole cart.',
      target,
    });
    const set = buildArgumentQuestions(request);
    const scope = questionOf(set, 'argument_applicability');
    expect(scope.criteria['REQUIRED']).toContain(
      'value question independently judges what to use or preserve'
    );
    expect(scope.criteria['UNRELATED']).toContain('outside the requested data flow');
    expect(scope.instructions['rules']).toContain('whole cart preserves original quantities');
    expect(scope.instructions['rules']).not.toContain('Judge participation');
    expect(questionOf(set, 'argument').criteria['KEEP_CURRENT']).toBeDefined();
    expect(Object.keys(scope.criteria)).toEqual(
      expect.arrayContaining(['REQUIRED', 'UNRELATED', 'UNCERTAIN'])
    );
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('keeps future result state conditional and preserves native negative and supplied-data boundaries', () => {
    const target = makeCheckbox({
      label: 'Save an existing item for later',
      state: { checked: true },
    });
    const request = argumentRequest({
      purpose: 'requirement',
      goal: 'Search for an umbrella and save the first matching result.',
      operation: 'CLICK',
      target,
    });
    const set = buildArgumentQuestions(request);
    const rules = questionOf(set, 'argument_applicability').instructions['rules'] ?? '';
    expect(rules).toContain('choose UNCERTAIN for an unidentified result control');
    expect(rules).toContain('A matching product does not request cart or wishlist actions');
    expect(rules).toContain('unselected unrequested alternatives are unrelated');
    expect(rules).toContain(
      'selected conflicting alternatives need deselection unless explicitly preserved'
    );
    expect(rules).toContain('Explicit prohibitions and requested original values remain relevant');
    expect(rules).toContain('Preserve goals testing rejection');
    expect(rules).toContain(TASK_UNTRUSTED_DATA_RULE);
    expect(set.state.focus?.checked).toBe(true);
    expect(questionOf(set, 'argument').criteria['KEEP_CURRENT']).toBeDefined();
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('separates a requested activation effect from whether that effect is necessary now', () => {
    const set = buildArgumentQuestions(
      argumentRequest({
        purpose: 'activation',
        operation: 'SUBMIT',
        slot: undefined,
        target: makeSubmitButton(),
      })
    );
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'Scope does not imply submission is necessary now'
    );
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'own requested activation effect'
    );
    expect(questionOf(set, 'argument').criteria[TASK_NONE_APPROPRIATE]).toBeDefined();
    expect(questionOf(set, 'argument').instructions['rules']).toContain(
      'A submission that only reapplies already-correct values is unnecessary'
    );
  });

  it('uses exact numeric choice-label spans as advisory evidence without interpreting a value code', () => {
    const goal = '🧭 No more than $50; do not choose the $150 alternative.';
    const target = makeElement({
      kind: 'button',
      label: '$50 or less',
      inputName: 'maxPrice',
      state: { pressed: false, value: 'le50' },
    });
    const set = buildArgumentQuestions(argumentRequest({ purpose: 'requirement', goal, target }));
    const start = goal.indexOf('50');
    expect(set.state.observedGoalLabelMatches).toEqual([
      { labelToken: '50', goalStart: start, goalEnd: start + 2 },
    ]);
    expect(set.state.observedGoalCodeMatches).toBeUndefined();
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'judge comparisons and polarity separately'
    );
    expect(set.state.focus?.pressed).toBe(false);
    expect(questionOf(set, 'argument_applicability').instructions['goal']).toBe(goal);
  });

  it('does not turn negative numeric label wording into a desired checked state', () => {
    const goal = 'Do not select the $50 tier.';
    const target = makeCheckbox({ label: '$50 tier', state: { checked: false, value: 'on' } });
    const set = buildArgumentQuestions(argumentRequest({ purpose: 'requirement', goal, target }));
    const start = goal.indexOf('50');
    expect(set.state.observedGoalLabelMatches).toEqual([
      { labelToken: '50', goalStart: start, goalEnd: start + 2 },
    ]);
    expect(set.state.observedGoalCodeMatches).toBeUndefined();
    expect(set.state.focus?.checked).toBe(false);
  });

  it('excludes sensitive, truncated, editable, partial and reinterpreted numeric label matches', () => {
    const targets = [
      makeCheckbox({ label: '$50 tier', sensitive: true, state: { checked: false } }),
      makeCheckbox({ label: '$50 tier', state: { checked: false, valueTruncated: true } }),
      makeTextField({ label: '$50 tier', state: { value: '50' } }),
      makeCheckbox({ label: '$150 tier', state: { checked: false } }),
      makeCheckbox({ label: '$50.00 tier', state: { checked: false } }),
      makeCheckbox({ label: 'Choice x50', state: { checked: false } }),
      makeCheckbox({ label: 'Choose a tier', state: { checked: false, value: '50' } }),
    ];
    for (const target of targets) {
      const set = buildArgumentQuestions(
        argumentRequest({ purpose: 'requirement', goal: 'Choose $50.', target })
      );
      expect(set.state.observedGoalLabelMatches).toBeUndefined();
    }
  });

  it('projects literal native choice-code spans as advisory scope evidence without deciding polarity', () => {
    const goal = '🧭 No OUTDOOR equipment; keep the outdoor preference off.';
    const target = makeCheckbox({
      label: 'Adventure',
      state: { checked: false, value: 'outdoor' },
    });
    const request = argumentRequest({ purpose: 'requirement', goal, target });
    const set = buildArgumentQuestions(request);
    const first = goal.indexOf('OUTDOOR');
    const second = goal.indexOf('outdoor');
    expect(set.state.observedGoalCodeMatches).toEqual([
      { code: 'outdoor', goalStart: first, goalEnd: first + 7 },
      { code: 'outdoor', goalStart: second, goalEnd: second + 7 },
    ]);
    for (const match of set.state.observedGoalCodeMatches ?? []) {
      expect(goal.slice(match.goalStart, match.goalEnd).toLowerCase()).toBe(match.code);
    }
    expect(questionOf(set, 'argument_applicability').instructions['rules']).toContain(
      'Advisory scope evidence only; judge polarity separately'
    );
    expect(questionOf(set, 'argument_applicability').instructions['goal']).toBe(goal);
    expect(Object.keys(questionOf(set, 'argument').criteria)).toEqual(
      Object.keys(
        questionOf(buildArgumentQuestions({ ...request, goal: GOAL }), 'argument').criteria
      )
    );
  });

  it('recognizes an actual pressed choice code when its visible label differs', () => {
    const target = makeElement({
      kind: 'button',
      label: 'Adventure',
      inputName: 'category',
      state: { pressed: false, value: 'outdoor' },
    });
    const set = buildArgumentQuestions(
      argumentRequest({ purpose: 'requirement', goal: 'Show outdoor gear.', target })
    );
    expect(set.state.observedGoalCodeMatches).toEqual([
      { code: 'outdoor', goalStart: 5, goalEnd: 12 },
    ]);
  });

  it.each([
    { code: 'outdoor', goal: 'Show outdoors or indoor_outdoor gear.' },
    { code: 'on', goal: 'Keep it on.' },
    { code: 'true', goal: 'True is displayed.' },
    { code: 'FALSE', goal: 'Leave FALSE visible.' },
    { code: 'yes', goal: 'Say yes.' },
    { code: 'no', goal: 'Say no.' },
    { code: '50', goal: 'Budget 50.' },
    { code: 'outdoor…', goal: 'Show outdoor…' },
    { code: 'a'.repeat(49), goal: 'a'.repeat(49) },
  ])('excludes nonmeaningful or partial choice-code matches: $code', ({ code, goal }) => {
    const target = makeCheckbox({ state: { checked: false, value: code } });
    const set = buildArgumentQuestions(argumentRequest({ purpose: 'requirement', goal, target }));
    expect(set.state.observedGoalCodeMatches).toBeUndefined();
  });

  it('excludes sensitive, truncated and editable values from literal code evidence', () => {
    const goal = 'Choose outdoor.';
    const targets = [
      makeCheckbox({ sensitive: true, state: { checked: false, value: 'outdoor' } }),
      makeCheckbox({ state: { checked: false, value: 'outdoor', valueTruncated: true } }),
      makeTextField({ state: { value: 'outdoor' } }),
    ];
    for (const target of targets) {
      const set = buildArgumentQuestions(argumentRequest({ purpose: 'requirement', goal, target }));
      expect(set.state.observedGoalCodeMatches).toBeUndefined();
    }
  });

  it('lists every option group only when the shown options are truncated and grouped', () => {
    const option = (index: number, groupLabel?: string) => ({
      id: `o${String(index)}`,
      label: `Option ${String(index)}`,
      value: `v${String(index)}`,
      selected: index === 0,
      disabled: false,
      ...(groupLabel === undefined ? {} : { groupLabel }),
    });
    const many = (groupFor: (index: number) => string | undefined) =>
      Array.from({ length: 30 }, (_, index) => option(index, groupFor(index)));
    const focusOf = (options: ReturnType<typeof many>) =>
      buildArgumentQuestions(
        argumentRequest({
          purpose: 'requirement',
          operation: 'SELECT',
          slot: 'option',
          target: makeSelectField({ options }),
          candidates: [],
        })
      ).state.focus;
    const grouped = focusOf(many(index => (index < 20 ? 'United States' : 'Canada')));
    expect(grouped?.options).toHaveLength(20);
    expect(grouped?.optionCount).toBe(30);
    expect(grouped?.optionGroups).toEqual(['United States', 'Canada']);
    expect(focusOf(many(() => undefined))?.optionGroups).toBeUndefined();
    const short = focusOf(many(() => 'One group').slice(0, 5));
    expect(short?.optionGroups).toBeUndefined();
  });

  it('lists up to eight option groups and none at all above that, never a list cut at the cap', () => {
    const options = (groupCount: number) =>
      Array.from({ length: 40 }, (_, index) => ({
        id: `o${String(index)}`,
        label: `Option ${String(index)}`,
        value: `v${String(index)}`,
        selected: index === 0,
        disabled: false,
        groupLabel: `Group ${String(index % groupCount)}`,
      }));
    const groupsFor = (groupCount: number, overrides: Parameters<typeof makeSelectField>[0] = {}) =>
      buildArgumentQuestions(
        argumentRequest({
          purpose: 'requirement',
          operation: 'SELECT',
          slot: 'option',
          target: makeSelectField({ options: options(groupCount), ...overrides }),
          candidates: [],
        })
      ).state.focus?.optionGroups;
    expect(groupsFor(8)).toHaveLength(8);
    expect(groupsFor(9)).toBeUndefined();
  });

  it('never lists option groups for a sensitive element', () => {
    const options = Array.from({ length: 30 }, (_, index) => ({
      id: `o${String(index)}`,
      label: `Option ${String(index)}`,
      value: `v${String(index)}`,
      selected: index === 0,
      disabled: false,
      groupLabel: index < 20 ? 'First group' : 'Second group',
    }));
    const focus = buildArgumentQuestions(
      argumentRequest({
        purpose: 'requirement',
        operation: 'SELECT',
        slot: 'option',
        target: makeSelectField({ options, sensitive: true }),
        candidates: [],
      })
    ).state.focus;
    expect(focus?.optionGroups).toBeUndefined();
    expect(JSON.stringify(focus)).not.toContain('Second group');
  });

  it('tells a data applicability judgment that a region control outside the supplied country is unrelated', () => {
    const request = argumentRequest({
      purpose: 'requirement',
      goal: 'Fill in the delivery details from the supplied profile.',
      operation: 'SELECT',
      slot: 'option',
      target: makeSelectField({ label: 'State, province or region' }),
      candidates: [
        {
          id: 'c1',
          source: 'input',
          inputPath: 'profile.address.country',
          label: 'Supplied country',
          sensitive: false,
          preview: 'Germany',
        },
      ],
    });
    const rules =
      questionOf(buildArgumentQuestions(request), 'argument_applicability').instructions['rules'] ??
      '';
    expect(rules).toContain(
      'when its optionGroups is present and does not include the supplied country'
    );
    expect(rules).toContain('even when the page marks it required');
  });

  it('projects actual option groups as context without changing candidate or option identities', () => {
    const target = makeSelectField({
      options: [
        {
          id: 'o1',
          label: 'Observed region',
          value: 'R',
          selected: false,
          disabled: false,
          groupLabel: 'Observed parent group',
        },
      ],
    });
    const set = buildArgumentQuestions(
      argumentRequest({
        operation: 'SELECT',
        slot: 'option',
        target,
        candidates: [
          {
            id: 'c1',
            source: 'observed_option',
            label: 'Observed region',
            optionGroup: 'Observed parent group',
            sensitive: false,
          },
        ],
      })
    );
    expect(set.state.focus?.options?.[0]?.groupLabel).toBe('Observed parent group');
    expect(asRecord(questionOf(set, 'argument').criteria['c1'])['optionGroup']).toBe(
      'Observed parent group'
    );
    expect(set.state.focus?.options?.[0]?.id).toBe('o1');
  });

  it('reports autocomplete-compatible supplied paths separately from exact native-name matches', () => {
    const target = makeTextField({
      inputName: 'address2',
      autocomplete: 'section-delivery shipping address-line2',
    });
    const candidates: readonly TaskCandidateView[] = [
      {
        id: 'c1',
        source: 'input',
        inputPath: 'profile.address.line2',
        label: 'Address component',
        sensitive: true,
        preview: SECRET,
      },
      {
        id: 'c2',
        source: 'input',
        inputPath: 'profile.address.line1',
        label: 'Street',
        sensitive: false,
        preview: 'Different component',
      },
      {
        id: 'c3',
        source: 'goal_span',
        inputPath: 'profile.address.line2',
        label: 'A task phrase',
        sensitive: false,
        preview: 'Not an eligible supplied reference',
      },
    ];
    const set = buildArgumentQuestions(
      argumentRequest({ purpose: 'requirement', target, candidates })
    );
    expect(set.state.matchingSuppliedInputPaths).toEqual([]);
    expect(set.state.compatibleSuppliedInputPaths).toEqual(['profile.address.line2']);
    expect(JSON.stringify(set)).not.toContain(SECRET);
    expect(Object.keys(questionOf(set, 'argument').criteria)).toEqual(
      expect.arrayContaining(['c1', 'c2', 'c3'])
    );
  });

  it('asks one mutually exclusive group choice over every observed member with preservation sentinels', () => {
    const members = Array.from({ length: 14 }, (_, index) =>
      makeCheckbox({
        id: `t${String(index + 20)}`,
        kind: 'radio',
        role: 'radio',
        label: `Observed alternative ${String(index)}`,
        state: { checked: index === 0, value: `choice_${String(index)}` },
      })
    );
    const candidates: readonly TaskCandidateView[] = members.map(member => ({
      id: member.id,
      source: 'protocol',
      label: member.label,
      code: member.state.value,
      sensitive: false,
    }));
    const set = buildArgumentQuestions(
      argumentRequest({
        purpose: 'group',
        group: { id: 'observed_group', members },
        target: members[0],
        candidates,
      }),
      { maxOptions: 12, rotate: false }
    );
    expect(Object.keys(set.questions)).toEqual(['argument']);
    expect(keysOf(questionOf(set, 'argument'))).toEqual([
      ...members.map(member => member.id),
      'KEEP_CURRENT',
      'REQUIRED_UNAVAILABLE',
      'NONE_APPROPRIATE',
    ]);
    expect(set.state.group?.members.map(member => member.id)).toEqual(
      members.map(member => member.id)
    );
    expect(set.state.group?.members[0]?.checked).toBe(true);
    expect(questionOf(set, 'argument').instructions['goal']).toBe(GOAL);
  });

  it('keeps main continuation links for activation without restoring header and footer navigation', () => {
    const target = makeSubmitButton();
    const main = makeElement({
      id: 't20',
      kind: 'link',
      landmark: 'main',
      operations: ['NAVIGATE'],
    });
    const header = makeElement({
      id: 't21',
      kind: 'link',
      landmark: 'header',
      operations: ['NAVIGATE'],
    });
    const footer = makeElement({
      id: 't22',
      kind: 'link',
      landmark: 'footer',
      operations: ['NAVIGATE'],
    });
    const set = buildArgumentQuestions(
      argumentRequest({
        purpose: 'activation',
        target,
        observation: pageObservation({ elements: [target, main, header, footer] }),
      })
    );
    expect(stateIds(set)).toEqual([target.id, main.id]);
  });

  it('exposes exact eligible supplied paths without exposing secret values or trusting other sources', () => {
    const target = makeTextField({ inputName: 'contact.phone' });
    const candidates: readonly TaskCandidateView[] = [
      {
        id: 'c1',
        source: 'input',
        inputPath: 'contact.phone',
        label: 'Supplied contact number',
        sensitive: true,
        preview: SECRET,
      },
      {
        id: 'c2',
        source: 'goal_span',
        inputPath: 'contact.phone',
        label: 'A phrase in the request',
        sensitive: false,
        preview: 'not a supplied reference',
      },
    ];
    const set = buildArgumentQuestions(
      argumentRequest({ purpose: 'requirement', target, candidates })
    );
    expect(set.state.matchingSuppliedInputPaths).toEqual(['contact.phone']);
    expect(asRecord(questionOf(set, 'argument').criteria['c1'])['inputPath']).toBe('contact.phone');
    expect(asRecord(questionOf(set, 'argument').criteria['c2'])['inputPath']).toBeUndefined();
    expect(JSON.stringify(set)).not.toContain(SECRET);
  });

  it('focuses assessment context on associated form controls while retaining page text', () => {
    const target = makeTextField({ formId: 'fFocus' });
    const passage = makeElement({ id: 't9', kind: 'passage', operations: ['READ'] });
    const parent = makeElement({
      id: 't10',
      kind: 'button',
      formId: 'fFocus',
      operations: ['CLICK'],
    });
    const submit = makeSubmitButton({ formId: 'fFocus' });
    const observation = pageObservation({
      elements: [target, passage, parent, submit],
    });
    const set = buildArgumentQuestions(
      argumentRequest({
        purpose: 'requirement',
        target,
        observation,
        goalRequirements: [
          {
            targetId: parent.id,
            operation: 'CLICK',
            desired: 'Open required form',
            satisfied: false,
          },
        ],
      })
    );
    expect(stateIds(set)).toEqual([target.id, parent.id, submit.id]);
    expect(set.state.page.text).toBe(observation.text);
    expect(set.state.truncation.elementsOmitted).toBe(1);
  });

  it('asks relevance independently and puts the focused control only in untrusted state', () => {
    const target = makeTextField({ label: CANARY });
    const set = buildArgumentQuestions(argumentRequest({ purpose: 'requirement', target }), {
      rotate: false,
    });
    expect(Object.keys(set.questions)).toEqual(['argument_applicability', 'argument']);
    expect(keysOf(questionOf(set, 'argument_applicability'))).toEqual([
      'REQUIRED',
      'UNRELATED',
      'UNCERTAIN',
    ]);
    expect(set.state.focus?.label).toBe(CANARY);
    expect(set.state.focus?.id).toBe(target.id);
    for (const question of Object.values(set.questions)) {
      expect(JSON.stringify(question.instructions)).not.toContain(CANARY);
      expect(question.instructions['goal']).toBe(GOAL);
    }
    const activation = buildArgumentQuestions(argumentRequest({ purpose: 'activation', target }));
    expect(Object.keys(activation.questions)).toEqual(['argument_applicability', 'argument']);
    expect(activation.state.focus?.id).toBe(target.id);
  });

  it('asks one argument question: candidates c1.., the none option last, instructions with ids only', () => {
    const set = buildArgumentQuestions(argumentRequest(), { rotate: false });
    expect(set.stage).toBe('argument');
    expect(Object.keys(set.questions)).toEqual(['argument']);
    const question = questionOf(set, 'argument');
    expect(keysOf(question)).toEqual(['c1', 'c2', 'c3', TASK_NONE_APPROPRIATE]);
    expect(question.criteria[TASK_NONE_APPROPRIATE]).toBe(NONE_DESCRIPTION);
    expect(Object.keys(question.instructions)).toEqual([
      'goal',
      'operation',
      'slot',
      'target',
      'rules',
    ]);
    expect(question.instructions['operation']).toBe('FILL');
    expect(question.instructions['slot']).toBe('value');
    expect(question.instructions['target']).toBe('t3');
    expect(question.criteria['c1']).toEqual({
      value: 'blue umbrella',
      source: 'goal_span',
      label: 'Goal text: blue umbrella',
    });
    expect(question.criteria['c2']).toEqual({
      value: 'a@example.test',
      source: 'input',
      label: 'email',
    });
  });

  it('describes a sensitive candidate only by its label and the word sensitive, whatever the view carries', () => {
    const leaky: readonly TaskCandidateView[] = [
      { id: 'c1', source: 'input', label: 'Account password', preview: SECRET, sensitive: true },
      { id: 'c2', source: 'goal_span', label: 'umbrella', preview: 'umbrella', sensitive: false },
    ];
    const set = buildArgumentQuestions(argumentRequest({ candidates: leaky }), { rotate: false });
    expect(questionOf(set, 'argument').criteria['c1']).toEqual({
      value: '[sensitive input]',
      source: 'input',
      label: 'Account password',
    });
    expect(JSON.stringify(set)).not.toContain(SECRET);
  });

  it('omits the target key when there is no target element and sends no question without candidates', () => {
    const noTarget = buildArgumentQuestions(
      argumentRequest({ operation: 'SCROLL', slot: 'direction', target: undefined })
    );
    expect(Object.keys(questionOf(noTarget, 'argument').instructions)).toEqual([
      'goal',
      'operation',
      'slot',
      'rules',
    ]);
    const none = buildArgumentQuestions(argumentRequest({ candidates: [] }));
    expect(none.questions).toEqual({});
    expect(none.state.task).toBe(GOAL);
  });

  it('shows the target element in the state even when it is far down a long page', () => {
    const observation = bigObservation(200);
    const target = must(observation.elements[199], 'last element');
    const set = buildArgumentQuestions(
      argumentRequest({ observation, target, maxStateBytes: 6000 }),
      { maxOptions: 12 }
    );
    expect(stateIds(set)).toContain(target.id);
    expect(questionOf(set, 'argument').instructions['target']).toBe(target.id);
  });

  it('puts the target into the state even when the observation no longer lists it, so its label is there to match', () => {
    const target = makeTextField({ id: 't99', label: 'Postal code' });
    const set = buildArgumentQuestions(argumentRequest({ target }));
    expect(stateIds(set)).toContain('t99');
    const shown = must(
      set.state.elements.find(element => element.id === 't99'),
      't99'
    );
    expect(shown.label).toBe('Postal code');
    expect(questionOf(set, 'argument').instructions['target']).toBe('t99');
    const crowded = buildArgumentQuestions(
      argumentRequest({ observation: bigObservation(200), target, maxStateBytes: 6000 }),
      { maxOptions: 12 }
    );
    expect(stateIds(crowded)).toContain('t99');
  });

  it('does not add the target twice when the observation already lists it', () => {
    const target = must(pageObservation().elements[2], 't3');
    const set = buildArgumentQuestions(argumentRequest({ target }));
    expect(stateIds(set).filter(id => id === target.id)).toHaveLength(1);
    expect(set.state.truncation.elementsOmitted).toBe(0);
  });

  it('caps candidates to the option limit and keeps the sentinel', () => {
    const candidates: TaskCandidateView[] = Array.from({ length: 100 }, (_, index) => ({
      id: `c${String(index + 1)}`,
      source: 'input',
      label: `input ${String(index + 1)}`,
      preview: `value ${String(index + 1)}`,
      sensitive: false,
    }));
    const set = buildArgumentQuestions(argumentRequest({ candidates }), {
      maxOptions: 20,
      rotate: false,
    });
    const keys = keysOf(questionOf(set, 'argument'));
    expect(keys.length).toBe(20);
    expect(keys[keys.length - 1]).toBe(TASK_NONE_APPROPRIATE);
    expect(keys.slice(0, 19)).toEqual(candidates.slice(0, 19).map(candidate => candidate.id));
  });

  it('sanitizes candidate text and keeps lookalike ids out of it', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const candidates: readonly TaskCandidateView[] = [
      {
        id: 'c1',
        source: 'observed_option',
        label: `Pick [t12] now${zeroWidth}`,
        preview: `x${zeroWidth}y`,
        sensitive: false,
      },
    ];
    const set = buildArgumentQuestions(argumentRequest({ candidates }), { rotate: false });
    expect(questionOf(set, 'argument').criteria['c1']).toEqual({
      value: 'xy',
      source: 'observed_option',
      label: 'Pick (t12) now',
    });
  });
});

describe('stage 3: buildCommitmentQuestions', () => {
  it('asks one commitment question with the eight classes, in the requested order', () => {
    const forward = buildCommitmentQuestions(commitmentRequest(), 'forward', { rotate: false });
    const reverse = buildCommitmentQuestions(commitmentRequest(), 'reverse', { rotate: false });
    expect(forward.stage).toBe('commitment');
    expect(Object.keys(forward.questions)).toEqual(['commitment']);
    expect(keysOf(questionOf(forward, 'commitment'))).toEqual([...TASK_COMMITMENT_CLASSES]);
    expect(keysOf(questionOf(reverse, 'commitment'))).toEqual(
      [...TASK_COMMITMENT_CLASSES].reverse()
    );
    expect(questionOf(forward, 'commitment').criteria['PURCHASE']).toBe(
      'Spends money or places an order.'
    );
    for (const key of TASK_COMMITMENT_CLASSES) {
      expect(typeof questionOf(forward, 'commitment').criteria[key]).toBe('string');
    }
  });

  it('tells every order of the commitment question that a search or filter submit commits nothing and a facet change is NONE', () => {
    for (const order of ['forward', 'reverse'] as const) {
      const rules =
        questionOf(buildCommitmentQuestions(commitmentRequest(), order), 'commitment').instructions[
          'rules'
        ] ?? '';
      expect(rules).toContain(
        'Activating the submit control of a search or filter form that only changes which results the page shows commits nothing: choose FORM_SUBMIT, not OTHER_COMMITMENT. Changing a facet, filter or sort control inside such a form is NONE.'
      );
      expect(rules).toContain('When the action might commit something and you cannot tell');
    }
  });

  it('keeps the two orders exact reverses of each other under rotation, whatever the step', () => {
    for (const step of [0, 1, 2, 7, 8, 13]) {
      const forward = keysOf(
        questionOf(buildCommitmentQuestions(commitmentRequest({ step }), 'forward'), 'commitment')
      );
      const reverse = keysOf(
        questionOf(buildCommitmentQuestions(commitmentRequest({ step }), 'reverse'), 'commitment')
      );
      expect(reverse).toEqual([...forward].reverse());
      expect([...forward].sort()).toEqual([...TASK_COMMITMENT_CLASSES].sort());
    }
    const canonical = keysOf(
      questionOf(
        buildCommitmentQuestions(commitmentRequest({ step: 3 }), 'forward', { rotate: false }),
        'commitment'
      )
    );
    const rotated = keysOf(
      questionOf(buildCommitmentQuestions(commitmentRequest({ step: 3 }), 'forward'), 'commitment')
    );
    expect(rotated).toEqual(rotateBy(canonical, 3));
  });

  it('carries url, title, the target, its form fields without values, and the notices', () => {
    const set = buildCommitmentQuestions(commitmentRequest(), 'forward');
    expect(set.state.page.url).toBe(commitmentRequest().observation.url);
    expect(set.state.page.title).toBe('Fixture page');
    expect(set.state.page.text).toBe('');
    expect(stateIds(set)).toEqual(['t3', 't6', 't8']);
    for (const element of set.state.elements) {
      expect(element.value).toBeUndefined();
      expect(element.text).toBeUndefined();
      expect(element.options).toBeUndefined();
    }
    expect(
      must(
        set.state.elements.find(element => element.id === 't6'),
        't6'
      ).href
    ).toBe(`${FIXTURE_ORIGIN}/submit`);
    expect(set.state.notices).toEqual(['alert: This purchase is free of charge']);
    expect(JSON.stringify(set)).not.toContain('Ada Lovelace');
  });

  it('names the action by ids and library constants only, never by a page label', () => {
    const set = buildCommitmentQuestions(
      commitmentRequest({
        target: makeSubmitButton({ label: `Place order ${CANARY}` }),
        command: makeRedactedCommand({
          command: makeCommand('SUBMIT'),
          target: summarizeElement(makeSubmitButton({ label: `Place order ${CANARY}` })),
        }),
      }),
      'forward'
    );
    const instructions = questionOf(set, 'commitment').instructions;
    expect(Object.keys(instructions)).toEqual(['goal', 'operation', 'target', 'rules']);
    expect(instructions['operation']).toBe('SUBMIT');
    expect(instructions['target']).toBe('t6');
    expect(JSON.stringify(instructions)).not.toContain(CANARY);
    expect(JSON.stringify(set.state)).toContain(CANARY);
  });

  it('names a selected option by its id and shows only that option as data', () => {
    const select = makeSelectField();
    const set = buildCommitmentQuestions(
      commitmentRequest({
        observation: pageObservation({ elements: [select] }),
        target: select,
        form: undefined,
        command: makeRedactedCommand({
          command: makeCommand('SELECT', { optionId: 't5.2' }),
          target: summarizeElement(select),
          optionLabel: 'France',
        }),
      }),
      'forward'
    );
    const instructions = questionOf(set, 'commitment').instructions;
    expect(instructions['operation']).toBe('SELECT');
    expect(instructions['option']).toBe('t5.2');
    expect(set.state.elements[0]?.options).toEqual([
      { id: 't5.2', label: 'France', selected: false },
    ]);
  });

  it('works without a form and without a target element object', () => {
    const set = buildCommitmentQuestions(
      commitmentRequest({ form: undefined, target: undefined }),
      'forward'
    );
    expect(stateIds(set)).toEqual(['t6']);
    const missing = buildCommitmentQuestions(
      commitmentRequest({
        form: undefined,
        target: undefined,
        observation: pageObservation({ elements: [] }),
      }),
      'forward'
    );
    expect(missing.state.elements).toEqual([]);
    expect(Object.keys(missing.questions)).toEqual(['commitment']);
  });
});

describe('stage 4: chooseCompletion questions', () => {
  it('derives checked-state matches only from satisfied actual controls and preserves counterevidence', () => {
    const off = makeCheckbox({
      id: 't41',
      label: 'Requested off state',
      state: { checked: false },
    });
    const on = makeCheckbox({ id: 't42', label: 'Requested on state', state: { checked: true } });
    const unmet = makeCheckbox({ id: 't43', label: 'Unsatisfied state', state: { checked: true } });
    const observation = pageObservation({ elements: [off, on, unmet] });
    const goalRequirements = [
      { targetId: off.id, operation: 'SET_CHECKED' as const, desired: off.label, satisfied: true },
      { targetId: on.id, operation: 'SET_CHECKED' as const, desired: on.label, satisfied: true },
      {
        targetId: unmet.id,
        operation: 'SET_CHECKED' as const,
        desired: unmet.label,
        satisfied: false,
      },
    ];
    const set = buildCompletionQuestions(
      completionRequest({ observation, goalRequirements, independentRead: true })
    );
    expect(set.state.verifiedCurrentGoalStates).toEqual([
      {
        field: off.label,
        requestedCheckedState: false,
        currentCheckedState: false,
        assessedGoalRequirementMatches: true,
        observedInIndependentSavedView: true,
      },
      {
        field: on.label,
        requestedCheckedState: true,
        currentCheckedState: true,
        assessedGoalRequirementMatches: true,
        observedInIndependentSavedView: true,
      },
    ]);
    expect(set.state.goalRequirements).toEqual(goalRequirements);
    const normalView = buildCompletionQuestions(
      completionRequest({ observation, goalRequirements })
    );
    expect(
      normalView.state.verifiedCurrentGoalStates?.every(
        fact => !fact.observedInIndependentSavedView
      )
    ).toBe(true);
  });

  it('shows code-derived executed effect classes to the completion judgment without a rule sentence', () => {
    const withEffects = buildCompletionQuestions(
      completionRequest({ executedEffects: { purchase: 1, interact: 2 } }),
      { rotate: false }
    );
    expect(withEffects.state.executedEffects).toEqual({ purchase: 1, interact: 2 });
    for (const key of Object.keys(withEffects.questions).filter(name =>
      name.startsWith('completion')
    )) {
      expect(questionOf(withEffects, key).instructions['rules'] ?? '').not.toContain(
        'executedEffects'
      );
    }
    for (const empty of [undefined, {}]) {
      const set = buildCompletionQuestions(
        completionRequest(empty === undefined ? {} : { executedEffects: empty }),
        { rotate: false }
      );
      expect(Object.keys(set.state)).not.toContain('executedEffects');
    }
  });

  it('adds the results-summary evidence sentence to the main completion question only when expectations exist', () => {
    const sentence = 'A results summary on the page that names the applied facets';
    const withExpected = buildCompletionQuestions(
      completionRequest({
        expected: [
          {
            label: 'Sort',
            kind: 'option_selected',
            expected: 'Price',
            sensitive: false,
            status: 'holds',
          },
        ],
      }),
      { rotate: false }
    );
    expect(questionOf(withExpected, 'completion').instructions['rules'] ?? '').toContain(sentence);
    expect(questionOf(withExpected, 'completion').instructions['rules'] ?? '').not.toContain(
      'code-checked matches of the requested facets'
    );
    const without = buildCompletionQuestions(completionRequest({ expected: [] }), {
      rotate: false,
    });
    expect(questionOf(without, 'completion').instructions['rules'] ?? '').not.toContain(sentence);
  });

  it('asks completion, answer and two evidence questions by default', () => {
    const set = buildCompletionQuestions(completionRequest(), { rotate: false });
    expect(set.stage).toBe('completion');
    expect(Object.keys(set.questions)).toEqual([
      'completion',
      'answer',
      'evidence_1',
      'evidence_2',
    ]);
    expect(keysOf(questionOf(set, 'completion'))).toEqual([
      'SATISFIED',
      'NOT_SATISFIED',
      'UNCERTAIN',
    ]);
    expect(keysOf(questionOf(set, 'answer'))).toEqual([...TASK_ANSWER_CHOICES]);
    for (const key of ['evidence_1', 'evidence_2']) {
      const evidence = keysOf(questionOf(set, key));
      expect(evidence[evidence.length - 1]).toBe(TASK_NONE_APPROPRIATE);
      expect(evidence).toEqual(
        expect.arrayContaining([...stateIds(set), 'e1', 'e2', TASK_NONE_APPROPRIATE])
      );
      expect(new Set(evidence).size).toBe(evidence.length);
    }
    expect(Object.keys(questionOf(set, 'completion').instructions)).toEqual([
      'goal',
      'requirement',
      'rules',
    ]);
  });

  it('omits the answer question when no answer is expected', () => {
    const set = buildCompletionQuestions(completionRequest({ expectAnswer: false }));
    expect(Object.keys(set.questions)).toEqual(['completion', 'evidence_1', 'evidence_2']);
    expect(
      Object.keys(
        buildCompletionQuestions(completionRequest({ expectAnswer: undefined })).questions
      )
    ).toContain('answer');
  });

  it('sets the evidence question count from the option, then the request, then the default', () => {
    const count = (set: TaskQuestionSet): number =>
      Object.keys(set.questions).filter(key => key.startsWith('evidence_')).length;
    expect(count(buildCompletionQuestions(completionRequest({ evidenceSlots: 4 })))).toBe(4);
    expect(
      count(
        buildCompletionQuestions(completionRequest({ evidenceSlots: 4 }), { evidenceQuestions: 3 })
      )
    ).toBe(3);
    expect(count(buildCompletionQuestions(completionRequest({ evidenceSlots: Number.NaN })))).toBe(
      TASK_TYPESAFE_DEFAULTS.evidenceQuestions
    );
    expect(count(buildCompletionQuestions(completionRequest({ evidenceSlots: 0 })))).toBe(1);
    expect(count(buildCompletionQuestions(completionRequest({ evidenceSlots: 99 })))).toBe(6);
  });

  it('carries the collected evidence, the expected states and the fresh observation in the state', () => {
    const history: readonly TaskHistoryEntry[] = [
      { step: 2, kind: 'action', operation: 'CLICK', outcome: 'applied' },
    ];
    const set = buildCompletionQuestions(completionRequest({ history }));
    expect(set.state.collectedEvidence).toEqual([
      {
        id: 'e1',
        ledgerSeq: 2,
        url: `${FIXTURE_ORIGIN}/help`,
        label: 'Shipping policy',
        text: 'Orders ship in two days.',
      },
      {
        id: 'e2',
        ledgerSeq: 4,
        url: `${FIXTURE_ORIGIN}/faq`,
        label: 'Returns',
        text: 'Thirty day returns.',
      },
    ]);
    expect(set.state.expected).toEqual([
      {
        label: 'Name',
        kind: 'field_value',
        expected: 'Ada Lovelace',
        sensitive: false,
        status: 'holds',
      },
      { label: 'Password', kind: 'field_value', expected: true, sensitive: true, status: 'holds' },
    ]);
    expect(set.state.recentActions).toEqual(history);
    expect(set.state.unobserved).toBeDefined();
    expect(stateIds(set)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
  });

  it('never shows a string for a sensitive expectation and caps the evidence it carries', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `e${String(index + 1)}`,
      ledgerSeq: index,
      url: `${FIXTURE_ORIGIN}/p${String(index)}`,
      label: `Passage ${String(index + 1)}`,
      text: 'word '.repeat(300),
    }));
    const set = buildCompletionQuestions(
      completionRequest({
        collectedEvidence: many,
        expected: [
          {
            label: 'Card',
            kind: 'field_value',
            expected: SECRET as unknown as boolean,
            sensitive: true,
            status: 'holds',
          },
        ],
      })
    );
    expect(set.state.collectedEvidence?.length).toBe(TASK_LIMITS.collectedEvidence);
    expect(set.state.collectedEvidence?.[0]?.text.length).toBeLessThanOrEqual(
      TASK_LIMITS.collectedEvidenceChars
    );
    expect(set.state.expected?.[0]?.expected).toBe(TASK_REDACTED);
    expect(JSON.stringify(set)).not.toContain(SECRET);
    const evidenceKeys = keysOf(questionOf(set, 'evidence_1'));
    expect(evidenceKeys).toEqual(expect.arrayContaining(['e1', 'e8']));
    expect(evidenceKeys).not.toContain('e9');
  });

  it('describes evidence ids as data: collected passages with text and url, elements like targets', () => {
    const set = buildCompletionQuestions(completionRequest(), { rotate: false });
    const evidence = questionOf(set, 'evidence_1');
    expect(evidence.criteria['e1']).toEqual({
      evidence: '[e1] Shipping policy',
      text: 'Orders ship in two days.',
      url: `${FIXTURE_ORIGIN}/help`,
    });
    expect(asRecord(evidence.criteria['t3'])['element']).toBe('[t3] Name');
    expect(evidence.criteria[TASK_NONE_APPROPRIATE]).toBe(NONE_DESCRIPTION);
  });

  it('describes the verdict and answer choices with library text', () => {
    const set = buildCompletionQuestions(completionRequest(), { rotate: false });
    expect(questionOf(set, 'completion').criteria['SATISFIED']).toBe(
      'Every requirement of the task is visibly satisfied by the current page.'
    );
    expect(questionOf(set, 'completion').criteria['UNCERTAIN']).toBe(
      'The page does not show enough to tell.'
    );
    expect(questionOf(set, 'answer').criteria['NOT_APPLICABLE']).toBe(
      'The task asks for an action, not an answer.'
    );
    expect(questionOf(set, 'answer').criteria['UNKNOWN']).toBe(
      'The page does not show the answer.'
    );
  });

  it('retains submitted consent and opaque supplied values for each final-state clause', () => {
    const goal = 'Create a test reservation, use my supplied payment details, and decline updates.';
    const expected: readonly TaskExpectedState[] = [
      {
        label: 'Payment credential',
        kind: 'field_value',
        expected: true,
        sensitive: true,
        status: 'retired',
        retiredBy: 'submit',
        inputPath: 'payment.credential',
        preparationBasis: 'matched_supplied_input_submission',
      },
      {
        label: 'Send updates',
        kind: 'checked',
        expected: false,
        sensitive: false,
        status: 'retired',
        retiredBy: 'submit',
      },
      {
        label: 'Old address',
        kind: 'field_value',
        expected: 'An earlier draft',
        sensitive: false,
        status: 'retired',
        retiredBy: 'document_change',
      },
    ];
    const set = buildCompletionQuestions(
      completionRequest({ goal, expected, expectAnswer: false })
    );
    expect(set.state.expected).toEqual(expected);
    expect(set.state.verifiedPreparationFacts).toEqual([
      {
        field: 'Payment credential',
        suppliedInput: 'payment.credential',
        suppliedInputWasMatchedBeforeSubmission: true,
        formSubmissionWasAttempted: true,
        valueIntentionallyHidden: true,
      },
    ]);
    const clauses = Object.entries(set.questions).filter(([key]) => key.startsWith('completion'));
    expect(clauses).toHaveLength(3);
    expect(clauses.map(([, question]) => asRecord(question.instructions)['requirement'])).toEqual([
      'Create a test reservation',
      'use my supplied payment details',
      'decline updates.',
    ]);
    for (const [, question] of clauses) {
      expect(asRecord(question.instructions)['goal']).toBe(goal);
      expect(Object.keys(question.criteria).sort()).toEqual([
        'CALLER_CONTEXT_ONLY',
        'NOT_SATISFIED',
        'SATISFIED',
        'UNCERTAIN',
      ]);
    }
  });
});

describe('every stage', () => {
  it('retains every bound unresolved control independently of the capped ordinary evidence choices', () => {
    const elements = Array.from({ length: 14 }, (_, index) =>
      makeElement({
        id: `u${String(index)}`,
        label: `${CANARY} ${String(index)}`,
        operations: ['SUBMIT'],
        formId: `f${String(index)}`,
      })
    );
    const observation = pageObservation({ elements });
    const unresolvedControls = elements.map(element => ({
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      targetId: element.id,
      signature: element.signature,
    }));
    const request = completionRequest({
      unresolvedControls,
      observation,
      expectAnswer: false,
      collectedEvidence: [],
    });
    const set = buildCompletionQuestions(request, { maxOptions: 12 });
    expect(set.state.unresolvedControls?.map(control => control.target)).toEqual(
      unresolvedControls
    );
    expect(set.state.unresolvedControls?.map(control => control.element.id)).toEqual(
      elements.map(element => element.id)
    );
    expect(set.state.elements.length).toBeLessThanOrEqual(11);
    const atoms = Object.values(set.questions).filter(
      question => 'unresolvedControlIndex' in question.instructions
    );
    expect(atoms).toHaveLength(elements.length);
    expect(atoms.map(question => question.instructions['unresolvedControlIndex'])).toEqual(
      elements.map((_, index) => String(index))
    );
    for (const question of atoms) {
      expect(question.instructions['goal']).toBe(request.goal);
      expect(JSON.stringify(question.instructions)).not.toContain(CANARY);
      expect(question.instructions['rules']).toContain('not scope resolution or permission to act');
      expect(Object.keys(question.criteria).sort()).toEqual([
        'NOT_SATISFIED',
        'SATISFIED',
        'UNCERTAIN',
      ]);
    }
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('refuses unresolved controls that cannot bind completely instead of producing partial completion questions', () => {
    const element = makeElement();
    const observation = pageObservation({ elements: [element] });
    const target = {
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      targetId: element.id,
      signature: element.signature,
    };
    for (const controls of [
      [{ ...target, signature: 'stale' }],
      [{ ...target, snapshotId: 'stale' }],
      [target, target],
      Array.from({ length: TASK_LIMITS.expectedStates + 1 }, () => target),
    ]) {
      const set = buildCompletionQuestions(
        completionRequest({ observation, unresolvedControls: controls })
      );
      expect(set.questions).toEqual({});
      expect(set.state.unresolvedControls).toBeUndefined();
    }
  });

  it('retains historical blanks while supplying later source/sequence/current-record evidence for temporal omission judgment', () => {
    const submittedControls: readonly TaskSubmittedControl[] = [
      {
        ledgerSeq: 4,
        origin: FIXTURE_ORIGIN,
        label: 'Contact field',
        kind: 'text_input',
        observedEmptyAtSubmission: true,
        effect: 'uncertain',
      },
    ];
    const expected: readonly TaskExpectedState[] = [
      {
        label: 'Contact field',
        kind: 'field_value',
        sensitive: true,
        expected: true,
        status: 'retired',
        retiredBy: 'submit',
        inputPath: 'profile.phone',
        preparationBasis: 'matched_supplied_input_submission',
      },
    ];
    const record = makeElement({
      id: 't90',
      kind: 'passage',
      role: 'passage',
      landmark: 'main',
      label: 'Updated contact recorded',
      contexts: ['Contact', 'Review'],
      text: 'Current review shows the corrected contact.',
      operations: ['READ'],
    });
    const history: readonly TaskHistoryEntry[] = [
      {
        step: 5,
        kind: 'action',
        operation: 'FILL',
        target: 'Contact field',
        changed: true,
        matched: true,
        outcome: 'applied',
      },
      { step: 6, kind: 'action', operation: 'SUBMIT', outcome: 'applied', pageChanged: true },
    ];
    const request = completionRequest({
      goal: 'Use my supplied contact details and stop at review.',
      submittedControls,
      expected,
      history,
      inputs: [{ path: 'profile.phone', sensitive: true, preview: SECRET }],
      observation: pageObservation({ text: record.text, elements: [record] }),
      expectAnswer: false,
    });
    const corrected = buildCompletionQuestions(request);
    const omission = Object.values(corrected.questions).find(
      question => 'submittedControlIndex' in question.instructions
    );
    expect(omission?.instructions['rules']).toContain('Judge the CURRENT omission');
    expect(omission?.instructions['rules']).toContain(
      'Actual later same-field/source matching and current record evidence'
    );
    expect(omission?.instructions['rules']).toContain('do not identify fields solely by labels');
    expect(corrected.state.submittedControls).toEqual(submittedControls);
    expect(
      corrected.state.recentActions.some(entry => entry.step === 6 && entry.operation === 'SUBMIT')
    ).toBe(true);
    expect(corrected.state.expected?.[0]?.inputPath).toBe('profile.phone');
    expect(corrected.state.verifiedPreparationFacts?.[0]?.suppliedInput).toBe('profile.phone');
    expect(corrected.state.page.text).toBe(record.text);
    expect(stateIds(corrected)).toContain(record.id);
    expect(JSON.stringify(corrected)).not.toContain(SECRET);
    const unresolved = buildCompletionQuestions({
      ...request,
      expected: [],
      history: [],
      observation: pageObservation({
        elements: [],
        text: 'The current record has no supplied contact.',
      }),
    });
    const stillOmitted = Object.values(unresolved.questions).find(
      question => 'submittedControlIndex' in question.instructions
    );
    expect(stillOmitted?.criteria['NOT_SATISFIED']).toContain(
      'remains omitted in the current outcome'
    );
    expect(Object.keys(stillOmitted?.criteria ?? {})).toEqual(
      Object.keys(omission?.criteria ?? {})
    );
    expect(unresolved.state.submittedControls).toEqual(submittedControls);
    expect(unresolved.state.verifiedPreparationFacts).toEqual([]);
    expect(assertGoalPreserved(corrected, request.goal)).toEqual({ ok: true });
  });

  it('adds atomic actual-empty omission judgments without dropping clauses or promoting untrusted labels', () => {
    const goal = 'Use my supplied profile, retain the requested method.';
    const controls: readonly TaskSubmittedControl[] = [
      {
        ledgerSeq: 7,
        origin: FIXTURE_ORIGIN,
        label: 'Preserved preference',
        kind: 'checkbox',
        checked: false,
      },
      {
        ledgerSeq: 7,
        origin: FIXTURE_ORIGIN,
        label: CANARY,
        kind: 'text_input',
        observedEmptyAtSubmission: true,
        effect: 'uncertain',
      },
      {
        ledgerSeq: 7,
        origin: FIXTURE_ORIGIN,
        label: 'Unit field',
        kind: 'text_input',
        observedEmptyAtSubmission: true,
        effect: 'uncertain',
      },
    ];
    const set = buildCompletionQuestions(
      completionRequest({ goal, submittedControls: controls, expectAnswer: false })
    );
    const omissionQuestions = Object.entries(set.questions).filter(
      ([, question]) => 'submittedControlIndex' in question.instructions
    );
    expect(omissionQuestions).toHaveLength(2);
    expect(
      omissionQuestions.map(([, question]) => question.instructions['submittedControlIndex'])
    ).toEqual(['1', '2']);
    expect(
      Object.values(set.questions).filter(question => 'requirement' in question.instructions)
    ).toHaveLength(2);
    for (const [, question] of omissionQuestions) {
      expect(Object.keys(question.criteria).sort()).toEqual([
        'NOT_SATISFIED',
        'SATISFIED',
        'UNCERTAIN',
      ]);
      expect(question.instructions['goal']).toBe(goal);
      expect(JSON.stringify(question.instructions)).not.toContain(CANARY);
      expect(question.instructions['rules']).toContain('unused supplied data');
      expect(question.instructions['rules']).toContain(
        'blank observation alone declares no requirement'
      );
    }
    expect(set.state.submittedControls).toEqual(controls);
    expect(assertGoalPreserved(set, goal)).toEqual({ ok: true });
  });

  it('retains actual blank-at-submission counterevidence without creating a requirement or preparation proof', () => {
    const submittedControls: readonly TaskSubmittedControl[] = [
      {
        ledgerSeq: 7,
        origin: FIXTURE_ORIGIN,
        label: 'Contact field',
        kind: 'text_input',
        observedEmptyAtSubmission: true,
        effect: 'uncertain',
      },
    ];
    const request = completionRequest({ submittedControls, expected: [], expectAnswer: false });
    const set = buildCompletionQuestions(request);
    expect(set.state.submittedControls).toEqual(submittedControls);
    expect(set.state.expected).toEqual([]);
    expect(set.state.verifiedPreparationFacts).toEqual([]);
    expect(set.state.preservedOriginalValueFacts).toEqual([]);
    expect(questionOf(set, 'completion').instructions['rules']).toContain(
      'not a requirement or persistence verdict'
    );
    expect(Object.keys(questionOf(set, 'completion').criteria)).toEqual(
      expect.arrayContaining(['SATISFIED', 'NOT_SATISFIED', 'UNCERTAIN'])
    );
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('retains original preserved control values as dispatch context without fabricating checkbox states', () => {
    const submittedControls: readonly TaskSubmittedControl[] = [
      {
        ledgerSeq: 3,
        origin: FIXTURE_ORIGIN,
        label: 'Existing destination',
        kind: 'text_input',
        preservedValue: 'Original destination',
        effect: 'uncertain',
      },
    ];
    const set = buildCompletionQuestions(completionRequest({ submittedControls }));
    expect(set.state.submittedControls).toEqual(submittedControls);
    expect(set.state.preservedOriginalValueFacts).toEqual([
      {
        field: 'Existing destination',
        originalValue: 'Original destination',
        valueStillMatchedBeforeSubmission: true,
        formSubmissionWasAttempted: true,
        outcome: 'uncertain',
      },
    ]);
    expect(Object.prototype.hasOwnProperty.call(set.state.submittedControls?.[0], 'checked')).toBe(
      false
    );
    expect(set.state.expected).toEqual(completionRequest().expected);
    expect(set.state.verifiedPreparationFacts).toEqual([]);
  });

  it('carries verified historical expectations into action and argument state', () => {
    const expected: readonly TaskExpectedState[] = [
      {
        label: 'Quantity',
        kind: 'field_value',
        expected: '1',
        sensitive: false,
        status: 'retired',
        retiredBy: 'submit',
      },
    ];
    for (const set of [
      buildActionQuestions(actionRequest({ expected })),
      buildArgumentQuestions(argumentRequest({ expected })),
    ]) {
      expect(set.state.expected).toEqual(expected);
    }
  });

  it('retains bounded submitted consent in action, argument and completion state', () => {
    const submittedControls: readonly TaskSubmittedControl[] = Array.from(
      { length: TASK_LIMITS.expectedStates + 1 },
      (_, index) => ({
        ledgerSeq: index + 1,
        origin: FIXTURE_ORIGIN,
        label: `Consent ${String(index)}`,
        kind: 'checkbox',
        checked: true,
        effect: 'uncertain',
      })
    );
    const sets = [
      buildActionQuestions(actionRequest({ submittedControls })),
      buildArgumentQuestions(argumentRequest({ submittedControls })),
      buildCompletionQuestions(completionRequest({ submittedControls })),
    ];
    for (const set of sets) {
      expect(set.state.submittedControls).toEqual(submittedControls.slice(1));
      expect(set.state.submittedControls?.[0]?.origin).toBe(FIXTURE_ORIGIN);
      expect(set.state.submittedControls?.[0]?.checked).toBe(true);
      expect(set.state.submittedControls).toHaveLength(TASK_LIMITS.expectedStates);
    }
  });

  it('has at least two criteria per question, and never builds a question with fewer', () => {
    for (const set of allQuestionSets()) {
      for (const key of Object.keys(set.questions)) {
        expect(keysOf(questionOf(set, key)).length).toBeGreaterThanOrEqual(2);
      }
    }
    const lonely = buildActionQuestions(
      actionRequest({
        offers: { operations: ['CLICK', 'DONE', 'BLOCKED'], targets: { CLICK: ['t1'] } },
        observation: pageObservation({ elements: [makeElement()] }),
      })
    );
    expect(keysOf(questionOf(lonely, 'click_target'))).toEqual(['t1', TASK_NONE_APPROPRIATE]);
  });

  it('carries NONE_APPROPRIATE, last, in every target, argument and evidence question', () => {
    for (const set of allQuestionSets()) {
      for (const key of Object.keys(set.questions)) {
        if (key.endsWith('_target') || key === 'argument' || key.startsWith('evidence_')) {
          const keys = keysOf(questionOf(set, key));
          expect(keys[keys.length - 1]).toBe(TASK_NONE_APPROPRIATE);
          expect(questionOf(set, key).criteria[TASK_NONE_APPROPRIATE]).toBe(NONE_DESCRIPTION);
        }
      }
    }
  });

  it('has the untrusted-data rule in the rules of every question of every stage', () => {
    for (const set of allQuestionSets()) {
      for (const key of Object.keys(set.questions)) {
        expect(questionOf(set, key).instructions['rules']).toContain(TASK_UNTRUSTED_DATA_RULE);
      }
    }
  });

  it('keeps page labels out of instructions: they live in state and criteria only', () => {
    const labelled = (
      id: string,
      role: string,
      kind: TaskElement['kind'],
      operations: TaskElement['operations']
    ) =>
      makeElement({
        id,
        signature: signatureFor(id),
        role,
        kind,
        operations,
        label: `${CANARY} ${id}`,
        region: `${CANARY} region`,
        href: `${FIXTURE_ORIGIN}/${CANARY}`,
      });
    const elements = [
      labelled('t1', 'button', 'button', ['CLICK']),
      labelled('t3', 'textbox', 'text_input', ['FILL', 'PRESS']),
      labelled('t6', 'button', 'button', ['SUBMIT']),
    ];
    const observation = pageObservation({
      title: `${CANARY} title`,
      text: `${CANARY} text`,
      elements,
      notices: [{ kind: 'alert', text: `${CANARY} notice` }],
    });
    const offers: TaskOffers = {
      operations: ['CLICK', 'FILL', 'SUBMIT', 'DONE', 'BLOCKED'],
      targets: { CLICK: ['t1'], FILL: ['t3'], SUBMIT: ['t6'] },
    };
    const history: readonly TaskHistoryEntry[] = [
      {
        step: 1,
        kind: 'action',
        operation: 'CLICK',
        target: `${CANARY} history`,
        detail: `${CANARY} detail`,
      },
    ];
    const candidates: readonly TaskCandidateView[] = [
      {
        id: 'c1',
        source: 'input',
        label: `${CANARY} candidate`,
        preview: `${CANARY} preview`,
        sensitive: false,
      },
    ];
    const sets = [
      buildActionQuestions(actionRequest({ observation, offers, history })),
      buildArgumentQuestions(
        argumentRequest({ observation, candidates, target: elements[1], history })
      ),
      buildCommitmentQuestions(
        commitmentRequest({ observation, target: elements[2], form: undefined }),
        'forward'
      ),
      buildCompletionQuestions(
        completionRequest({
          observation,
          history,
          collectedEvidence: [
            {
              id: 'e1',
              ledgerSeq: 1,
              url: `${FIXTURE_ORIGIN}/x`,
              label: `${CANARY} evidence`,
              text: `${CANARY} text`,
            },
          ],
        })
      ),
    ];
    for (const set of sets) {
      const instructions = Object.keys(set.questions).map(key =>
        JSON.stringify(questionOf(set, key).instructions)
      );
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.join('\n').toLowerCase()).not.toContain(CANARY.toLowerCase());
      expect(JSON.stringify(set).toLowerCase()).toContain(CANARY.toLowerCase());
    }
  });

  it('writes every instruction and criterion value as a string; absent and empty fields are omitted', () => {
    const observation = pageObservation({
      elements: [
        makeElement({ id: 't1', label: '', state: { disabled: true } }),
        makeCheckbox({ state: { checked: 'mixed' } }),
        makeCheckbox({ id: 't9', label: 'Terms', state: { checked: true } }),
        makeTextField({ state: { value: '' } }),
      ],
    });
    const offers: TaskOffers = {
      operations: ['CLICK', 'SET_CHECKED', 'FILL', 'DONE', 'BLOCKED'],
      targets: { CLICK: ['t1'], SET_CHECKED: ['t4', 't9'], FILL: ['t3'] },
    };
    const sets = [
      buildActionQuestions(actionRequest({ observation, offers })),
      ...allQuestionSets(),
    ];
    let strings = 0;
    for (const set of sets) {
      for (const key of Object.keys(set.questions)) {
        const question = questionOf(set, key);
        for (const value of Object.values(question.instructions)) {
          expect(typeof value).toBe('string');
          expect(value).not.toBe('');
          strings += 1;
        }
        for (const criterion of Object.values(question.criteria)) {
          if (typeof criterion === 'string') {
            expect(criterion).not.toBe('');
            continue;
          }
          for (const [field, value] of Object.entries(criterion)) {
            expect(typeof value).toBe('string');
            expect(value).not.toBe('');
            expect(['undefined', 'null', 'NaN']).not.toContain(value);
            expect(field).not.toBe('');
            strings += 1;
          }
        }
      }
    }
    expect(strings).toBeGreaterThan(100);
    const action = buildActionQuestions(actionRequest({ observation, offers }), { rotate: false });
    expect(questionOf(action, 'click_target').criteria['t1']).toEqual({
      element: '[t1]',
      role: 'button',
      kind: 'button',
      disabled: 'true',
    });
    expect(asRecord(questionOf(action, 'set_checked_target').criteria['t4'])['checked']).toBe(
      'mixed'
    );
    expect(asRecord(questionOf(action, 'set_checked_target').criteria['t9'])['checked']).toBe(
      'true'
    );
    expect(
      asRecord(questionOf(action, 'set_checked_target').criteria['t4'])['disabled']
    ).toBeUndefined();
    expect(
      asRecord(questionOf(action, 'fill_target').criteria['t3'])['currentValue']
    ).toBeUndefined();
  });

  it('puts the unobserved counts in every state', () => {
    const observation = pageObservation({
      unobserved: {
        iframes: 4,
        shadowRoots: 1,
        canvases: 0,
        contentEditable: 0,
        multiSelects: 0,
        externalTargets: 0,
      },
    });
    const sets = [
      buildActionQuestions(actionRequest({ observation })),
      buildArgumentQuestions(argumentRequest({ observation })),
      buildCommitmentQuestions(commitmentRequest({ observation }), 'forward'),
      buildCompletionQuestions(completionRequest({ observation })),
    ];
    for (const set of sets) {
      expect(set.state.unobserved).toEqual(observation.unobserved);
    }
  });

  it('sanitizes every page string: controls, invisible characters, lookalike ids and runaway length', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const bell = String.fromCharCode(0x07);
    const long = 'w'.repeat(5000);
    const observation = pageObservation({
      title: `Ti${zeroWidth}tle${bell}`,
      text: `Text [t3] [c1] ${long}`,
      elements: [
        makeElement({ id: 't1', label: `Click${zeroWidth} [t7] ${long}`, region: `Reg${bell}ion` }),
      ],
      notices: [{ kind: 'alert', text: `Note${zeroWidth}   spaced\n\n out ${long}` }],
    });
    const offers: TaskOffers = {
      operations: ['CLICK', 'DONE', 'BLOCKED'],
      targets: { CLICK: ['t1'] },
    };
    const set = buildActionQuestions(actionRequest({ observation, offers }));
    expect(set.state.page.title).toBe('Title');
    expect(set.state.page.text.startsWith('Text (t3) (c1) www')).toBe(true);
    expect(set.state.page.text.length).toBeLessThanOrEqual(TASK_LIMITS.observedTextChars);
    const element = must(set.state.elements[0], 't1');
    expect(element.label.startsWith('Click (t7) www')).toBe(true);
    expect(element.label.length).toBeLessThanOrEqual(TASK_LIMITS.labelChars);
    expect(element.region).toBe('Region');
    const notice = must(set.state.notices[0], 'notice');
    expect(notice.startsWith('alert: Note spaced out www')).toBe(true);
    expect(notice.length).toBeLessThan(400);
    const serialized = JSON.stringify(set);
    expect(serialized).not.toContain(zeroWidth);
    expect(serialized).not.toContain('[t3]');
    expect(serialized).not.toContain('[c1]');
    expect(serialized).not.toContain('\\u0007');
  });

  it('shows caller descriptions only as data after sanitizing, never in instructions', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const inputs: readonly TaskInputSummary[] = [
      {
        path: 'contact.email',
        sensitive: false,
        description: `Contact${zeroWidth} email [t3] ${CANARY}`,
        preview: 'a@example.test',
      },
      { path: 'password', sensitive: true, description: 'Account password', preview: SECRET },
    ];
    const sets = [
      buildActionQuestions(actionRequest({ inputs })),
      buildArgumentQuestions(argumentRequest({ inputs })),
      buildCompletionQuestions(completionRequest({ inputs })),
    ];
    for (const set of sets) {
      expect(set.state.inputs).toEqual([
        {
          path: 'contact.email',
          sensitive: false,
          description: `Contact email (t3) ${CANARY}`,
          preview: 'a@example.test',
        },
        { path: 'password', sensitive: true, description: 'Account password' },
      ]);
      const instructions = Object.keys(set.questions).map(key =>
        JSON.stringify(questionOf(set, key).instructions)
      );
      expect(instructions.join('')).not.toContain(CANARY);
      expect(JSON.stringify(set)).not.toContain(SECRET);
    }
  });

  it('never carries a sensitive value: a leaked raw value in an observation still comes out redacted', () => {
    const observation = pageObservation({
      elements: [
        makeSensitiveField({ state: { value: SECRET } }),
        makeTextField({ inputType: 'password', state: { value: SECRET } }),
        makeElement({ id: 't1', label: 'Pay' }),
      ],
      text: 'Checkout',
    });
    const offers: TaskOffers = {
      operations: ['FILL', 'CLICK', 'DONE', 'BLOCKED'],
      targets: { FILL: ['t8', 't3'], CLICK: ['t1'] },
    };
    const action = buildActionQuestions(actionRequest({ observation, offers }));
    const sensitiveElement = must(
      action.state.elements.find(element => element.id === 't8'),
      't8'
    );
    expect(sensitiveElement.value).toBe(TASK_REDACTED);
    expect(sensitiveElement.text).toBeUndefined();
    expect(asRecord(questionOf(action, 'fill_target').criteria['t8'])['currentValue']).toBe(
      TASK_REDACTED
    );
    expect(asRecord(questionOf(action, 'fill_target').criteria['t3'])['currentValue']).toBe(
      TASK_REDACTED
    );
    const sets = [
      action,
      buildArgumentQuestions(argumentRequest({ observation })),
      buildCommitmentQuestions(
        commitmentRequest({ observation, form: makeForm({ fieldIds: ['t8', 't3'] }) }),
        'forward'
      ),
      buildCompletionQuestions(completionRequest({ observation })),
    ];
    for (const set of sets) {
      expect(JSON.stringify(set)).not.toContain(SECRET);
    }
  });

  it('keeps a sensitive field that holds no text empty rather than inventing a marker', () => {
    const observation = pageObservation({
      elements: [makeSensitiveField({ state: { value: '' } })],
    });
    const offers: TaskOffers = {
      operations: ['FILL', 'DONE', 'BLOCKED'],
      targets: { FILL: ['t8'] },
    };
    const set = buildActionQuestions(actionRequest({ observation, offers }));
    expect(set.state.elements[0]?.value ?? '').toBe('');
    expect(asRecord(questionOf(set, 'fill_target').criteria['t8'])['currentValue']).toBeUndefined();
  });

  it('shows no option of a sensitive select, neither its labels nor which one is selected, in any stage', () => {
    const chosenLabel = `Chosen-${SECRET}`;
    const select = makeSelectField({
      sensitive: true,
      options: [
        { id: 't5.1', label: chosenLabel, value: 'a', selected: true, disabled: false },
        { id: 't5.2', label: 'Other', value: 'b', selected: false, disabled: false },
      ],
      state: { value: 'a' },
    });
    const observation = pageObservation({ elements: [select, makeSubmitButton()] });
    const offers: TaskOffers = {
      operations: ['SELECT', 'DONE', 'BLOCKED'],
      targets: { SELECT: ['t5'] },
    };
    const action = buildActionQuestions(actionRequest({ observation, offers }));
    const shown = must(
      action.state.elements.find(element => element.id === 't5'),
      't5'
    );
    expect(shown.options).toBeUndefined();
    expect(shown.optionCount).toBeUndefined();
    expect(shown.value).toBe(TASK_REDACTED);
    const selectCommand = makeRedactedCommand({
      command: makeCommand('SELECT'),
      target: summarizeElement(select),
      optionLabel: chosenLabel,
    });
    const sets = [
      action,
      buildArgumentQuestions(argumentRequest({ observation, target: select, operation: 'SELECT' })),
      buildCommitmentQuestions(
        commitmentRequest({
          observation,
          target: select,
          command: selectCommand,
          form: makeForm({ fieldIds: ['t5'] }),
        }),
        'forward'
      ),
      buildCompletionQuestions(completionRequest({ observation })),
    ];
    for (const set of sets) {
      expect(JSON.stringify(set)).not.toContain(chosenLabel);
      expect(JSON.stringify(set)).not.toContain('"t5.1"');
    }
  });

  it('still shows the options of an ordinary select, so the sensitive rule is not a blanket removal', () => {
    const observation = pageObservation({ elements: [makeSelectField(), makeSubmitButton()] });
    const offers: TaskOffers = {
      operations: ['SELECT', 'DONE', 'BLOCKED'],
      targets: { SELECT: ['t5'] },
    };
    const set = buildActionQuestions(actionRequest({ observation, offers }));
    const shown = must(
      set.state.elements.find(element => element.id === 't5'),
      't5'
    );
    expect(shown.options?.map(option => option.label)).toEqual(['India', 'France']);
    expect(shown.optionCount).toBe(2);
  });
});

describe('option rotation', () => {
  const rotationRequest = (step: number): TaskChooseActionRequest => {
    const elements = [
      ...Array.from({ length: 6 }, (_, index) => buttonAt(index + 1)),
      ...Array.from({ length: 4 }, (_, index) =>
        makeTextField({
          id: `t${String(index + 11)}`,
          signature: signatureFor(`t${String(index + 11)}`),
        })
      ),
    ];
    return actionRequest({
      step,
      observation: makeObservation({ elements }),
      offers: {
        operations: ['CLICK', 'FILL', 'DONE', 'BLOCKED'],
        targets: {
          CLICK: ['t1', 't2', 't3', 't4', 't5', 't6'],
          FILL: ['t11', 't12', 't13', 't14'],
        },
      },
    });
  };

  it('rotates every question by (step + index) % n with the sentinels last, never first', () => {
    for (let step = 0; step < 14; step += 1) {
      const set = buildActionQuestions(rotationRequest(step));
      const plain = buildActionQuestions(rotationRequest(step), { rotate: false });
      const keys = Object.keys(set.questions);
      expect(keys).toEqual(['operation', 'click_target', 'fill_target']);
      keys.forEach((key, index) => {
        const sentinels = key === 'operation' ? ['DONE', 'BLOCKED'] : [TASK_NONE_APPROPRIATE];
        const base = withoutSentinels(keysOf(questionOf(plain, key)), sentinels);
        const rotated = keysOf(questionOf(set, key));
        const expected = [...rotateBy(base, (step + index) % base.length), ...sentinels];
        expect(rotated).toEqual(expected);
        expect(sentinels).not.toContain(rotated[0]);
        expect(keysOf(questionOf(plain, key))).toEqual([...base, ...sentinels]);
      });
    }
  });

  it('puts the first-option bias on a different candidate at each step', () => {
    const firsts = new Set<string>();
    for (let step = 0; step < 6; step += 1) {
      firsts.add(
        must(
          keysOf(questionOf(buildActionQuestions(rotationRequest(step)), 'click_target'))[0],
          'first'
        )
      );
    }
    expect(firsts.size).toBe(6);
  });

  it('offsets different questions of one request differently', () => {
    const set = buildActionQuestions(rotationRequest(0));
    expect(keysOf(questionOf(set, 'click_target'))[0]).toBe('t2');
    expect(keysOf(questionOf(set, 'fill_target'))[0]).toBe('t13');
    expect(keysOf(questionOf(set, 'operation'))[0]).toBe('CLICK');
  });

  it('rotates stage 2 and stage 4 questions too, each by its own index', () => {
    const argument = buildArgumentQuestions(argumentRequest({ step: 1 }));
    expect(keysOf(questionOf(argument, 'argument'))).toEqual([
      'c2',
      'c3',
      'c1',
      TASK_NONE_APPROPRIATE,
    ]);
    const plain = buildCompletionQuestions(completionRequest({ step: 3 }), { rotate: false });
    const rotated = buildCompletionQuestions(completionRequest({ step: 3 }));
    Object.keys(rotated.questions).forEach((key, index) => {
      const sentinels = key.startsWith('evidence_') ? [TASK_NONE_APPROPRIATE] : [];
      const base = withoutSentinels(keysOf(questionOf(plain, key)), sentinels);
      expect(keysOf(questionOf(rotated, key))).toEqual([
        ...rotateBy(base, (3 + index) % base.length),
        ...sentinels,
      ]);
    });
    const evidence1 = keysOf(questionOf(rotated, 'evidence_1'));
    const evidence2 = keysOf(questionOf(rotated, 'evidence_2'));
    expect(evidence1[0]).not.toBe(evidence2[0]);
  });

  it('keeps document order when rotation is switched off', () => {
    const base = buildActionQuestions(rotationRequest(0), { rotate: false });
    for (const step of [1, 4, 9]) {
      expect(buildActionQuestions(rotationRequest(step), { rotate: false })).toEqual(base);
    }
    expect(keysOf(questionOf(base, 'click_target'))).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      TASK_NONE_APPROPRIATE,
    ]);
  });

  it('reports the offsets it applied, including 0 when rotation is off', () => {
    for (const step of [0, 3, 10]) {
      const set = buildActionQuestions(rotationRequest(step));
      expect(questionRotations(set, step, true)).toEqual({
        operation: step % 2,
        click_target: (step + 1) % 6,
        fill_target: (step + 2) % 4,
      });
      expect(questionRotations(set, step, false)).toEqual({
        operation: 0,
        click_target: 0,
        fill_target: 0,
      });
    }
    const evidence = buildCompletionQuestions(completionRequest({ step: 4 }));
    const offsets = questionRotations(evidence, 4, true);
    expect(Object.keys(offsets)).toEqual(Object.keys(evidence.questions));
    expect(offsets['completion']).toBe(4 % 3);
    expect(offsets['answer']).toBe((4 + 1) % 4);
    expect(offsets['evidence_1']).toBe((4 + 2) % 10);
    expect(offsets['evidence_2']).toBe((4 + 3) % 10);
  });

  it('keeps the reported offsets true when a host repeats an element id', () => {
    const elements = [
      ...Array.from({ length: 5 }, (_, index) => buttonAt(index + 1)),
      buttonAt(3),
      buttonAt(5),
    ];
    const set = buildActionQuestions(
      actionRequest({
        step: 4,
        observation: makeObservation({ elements }),
        offers: clickOffers(elements),
      })
    );
    const criteria = keysOf(questionOf(set, 'click_target'));
    expect(new Set(criteria).size).toBe(criteria.length);
    expect(criteria.length).toBe(6);
    const offsets = questionRotations(set, 4, true);
    expect(offsets['click_target']).toBe((4 + 1) % 5);
    const plain = buildActionQuestions(
      actionRequest({
        step: 4,
        observation: makeObservation({ elements }),
        offers: clickOffers(elements),
      }),
      { rotate: false }
    );
    const base = withoutSentinels(keysOf(questionOf(plain, 'click_target')), [
      TASK_NONE_APPROPRIATE,
    ]);
    expect(withoutSentinels(criteria, [TASK_NONE_APPROPRIATE])).toEqual(
      rotateBy(base, (4 + 1) % 5)
    );
  });

  it('treats a bad step as zero and never rotates a one-option question', () => {
    for (const step of [Number.NaN, -5, Number.POSITIVE_INFINITY, 1.7]) {
      const set = buildActionQuestions(rotationRequest(step));
      const offsets = questionRotations(set, step, true);
      for (const offset of Object.values(offsets)) {
        expect(Number.isInteger(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
      }
    }
    const single = buildActionQuestions(
      actionRequest({
        step: 9,
        offers: { operations: ['CLICK', 'DONE', 'BLOCKED'], targets: { CLICK: ['t1'] } },
        observation: pageObservation({ elements: [makeElement()] }),
      })
    );
    expect(keysOf(questionOf(single, 'click_target'))).toEqual(['t1', TASK_NONE_APPROPRIATE]);
    expect(questionRotations(single, 9, true)['click_target']).toBe(0);
  });

  it('mirrors the commitment pair: the reverse question reports the forward offset', () => {
    const forward = buildCommitmentQuestions(commitmentRequest({ step: 5 }), 'forward');
    const reverse = buildCommitmentQuestions(commitmentRequest({ step: 5 }), 'reverse');
    const combined: TaskQuestionSet = {
      ...forward,
      questions: {
        commitment: questionOf(forward, 'commitment'),
        commitment_reverse: questionOf(reverse, 'commitment'),
      },
    };
    expect(questionRotations(combined, 5, true)).toEqual({ commitment: 5, commitment_reverse: 5 });
  });
});

describe('trimming and the byte budget', () => {
  it('retains an already-satisfied goal control as evidence without offering its mutation', () => {
    const other = Array.from({ length: 25 }, (_, index) => buttonAt(index + 1));
    const held = makeElement({
      id: 't200',
      label: 'Requested saved item',
      state: { pressed: true },
      operations: ['CLICK'],
    });
    const observation = makeObservation({ elements: [...other, held] });
    const set = buildActionQuestions(
      actionRequest({
        observation,
        offers: clickOffers(other),
        goalRequirements: [
          { targetId: held.id, operation: 'CLICK', desired: held.label, satisfied: true },
        ],
      }),
      { maxOptions: 12 }
    );
    expect(stateIds(set)).toContain(held.id);
    expect(set.state.elements.find(element => element.id === held.id)?.pressed).toBe(true);
    expect(questionOf(set, 'click_target').criteria[held.id]).toBeUndefined();
  });

  it('keeps current receipt text and main evidence when multi-clause verification needs compact state', () => {
    const recordText = `Record REF-2468 contains the submitted destination, delivery method and test payment. ${'Recorded item details. '.repeat(35)}`;
    const record = makeElement({
      id: 't200',
      kind: 'passage',
      role: 'passage',
      landmark: 'main',
      label: 'Completed record REF-2468',
      text: recordText,
      operations: ['READ'],
    });
    const observation = makeObservation({
      text: recordText,
      elements: [
        ...Array.from({ length: 40 }, (_, index) =>
          makeElement({
            id: `t${String(index + 1)}`,
            kind: 'link',
            role: 'link',
            landmark: 'header',
            label: `Unrelated navigation ${String(index)} ${'long navigation detail '.repeat(12)}`,
            text: 'Navigation text '.repeat(25),
            href: `${FIXTURE_ORIGIN}/info/${String(index)}`,
            operations: ['NAVIGATE', 'READ'],
          })
        ),
        record,
      ],
    });
    const set = buildCompletionQuestions(
      completionRequest({
        goal: 'Complete the reservation, use the supplied address, select standard delivery, use the test payment, decline updates, and retain the existing contact.',
        observation,
        initialPage: {
          url: FIXTURE_ORIGIN,
          title: 'Earlier view',
          text: 'Earlier page context. '.repeat(270),
        },
        collectedEvidence: [],
        expectAnswer: false,
      }),
      { maxRequestBytes: 21100 }
    );
    expect(estimateRequestBytes(set, MODEL)).toBeLessThanOrEqual(21100);
    expect(set.state.page.text).toBe(recordText.trim());
    expect(stateIds(set)).toContain(record.id);
    expect(questionOf(set, 'evidence_1').criteria[record.id]).toBeDefined();
    expect(Object.keys(set.questions).filter(key => key.startsWith('completion'))).toHaveLength(6);
    expect(questionOf(set, 'completion').instructions['rules']).toContain(
      'Prepared filter controls do not prove rendered filtered results'
    );
  });

  it('keeps full scope compatibility when the only click target has a broader effect', () => {
    const target = makeElement({
      id: 't91',
      label: 'Unsubscribe from every channel',
      operations: ['CLICK'],
      contexts: ['Preferences'],
    });
    const request = actionRequest({
      goal: 'Make sure promotional email is off.',
      observation: makeObservation({ elements: [target] }),
      offers: { operations: ['CLICK', 'DONE', 'BLOCKED'], targets: { CLICK: [target.id] } },
    });
    const set = buildActionQuestions(request);
    expect(questionOf(set, 'operation').instructions['rules']).toContain(
      'compatible with the whole literal task'
    );
    expect(questionOf(set, 'operation').instructions['rules']).toContain(
      'Do not use a broader bulk change'
    );
    expect(questionOf(set, 'click_target').instructions['rules']).toContain(
      'unrelated channels/preferences is incompatible'
    );
    expect(questionOf(set, 'click_target').criteria[TASK_NONE_APPROPRIATE]).toBeDefined();
    expect(questionOf(set, 'click_target').criteria[target.id]).toBeDefined();
    expect(set.state.elements[0]?.label).toBe(target.label);
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('retains later labeled record values and contradictions within the same evidence option cap', () => {
    const headings = Array.from({ length: 24 }, (_, index) =>
      makeElement({
        id: `t${String(index + 1)}`,
        kind: 'passage',
        role: 'passage',
        landmark: 'main',
        label: `Section ${String(index)}`,
        contexts: [`Section ${String(index)}`, 'Review'],
        operations: ['READ'],
      })
    );
    const rows = [
      { id: 't100', field: 'Destination', value: '77 Current Street' },
      { id: 't101', field: 'Phone', value: '555-0108' },
      { id: 't102', field: 'Delivery', value: 'Standard' },
      { id: 't103', field: 'Gift wrap', value: 'No' },
      { id: 't104', field: 'Save this address for future orders', value: 'Yes' },
      { id: 't105', field: 'Save this address for future orders', value: 'No, pending correction' },
    ].map(row =>
      makeElement({
        id: row.id,
        kind: 'passage',
        role: 'passage',
        landmark: 'main',
        label: row.value,
        text: row.value,
        contexts: [row.field, 'Review'],
        operations: ['READ'],
      })
    );
    const initialPage = {
      url: FIXTURE_ORIGIN,
      title: 'Original cart and options',
      text: 'Original bag contains two items.',
      controls: [
        { kind: 'checkbox' as const, label: 'Save this address for future orders', checked: true },
      ],
    };
    const request = completionRequest({
      goal: 'Use the supplied phone and address, standard delivery and no gift wrap, leave other options unchanged.',
      observation: makeObservation({
        elements: [...headings, ...rows],
        text: 'Full current record includes a pending correction.',
      }),
      inputs: [{ path: 'profile.address', sensitive: false, preview: '77 Current Street' }],
      initialPage,
      expected: [
        {
          label: 'Phone',
          kind: 'field_value',
          expected: '555-0108',
          sensitive: false,
          status: 'retired',
          retiredBy: 'submit',
        },
      ],
      submittedControls: [
        {
          ledgerSeq: 9,
          origin: FIXTURE_ORIGIN,
          label: 'Save this address for future orders',
          kind: 'checkbox',
          preservedChecked: true,
        },
      ],
      expectAnswer: false,
    });
    const set = buildCompletionQuestions(request, { maxOptions: 12, maxRequestBytes: 21000 });
    expect(set.state.elements.length).toBeLessThanOrEqual(9);
    for (const row of rows) {
      expect(stateIds(set)).toContain(row.id);
      expect(questionOf(set, 'evidence_1').criteria[row.id]).toBeDefined();
    }
    expect(Object.keys(questionOf(set, 'evidence_1').criteria).length).toBeLessThanOrEqual(12);
    expect(set.state.elements.find(element => element.id === 't105')?.label).toBe(
      'No, pending correction'
    );
    expect(set.state.initialPage).toEqual(initialPage);
    expect(set.state.page.text).toBe(request.observation.text);
    expect(estimateRequestBytes(set, MODEL)).toBeLessThanOrEqual(21000);
    expect(assertGoalPreserved(set, request.goal)).toEqual({ ok: true });
  });

  it('shows expansion semantics to both the action picker and the commitment classifier', () => {
    const target = makeElement({ state: { expanded: false } });
    const observation = makeObservation({ elements: [target] });
    const actions = buildActionQuestions(
      actionRequest({ observation, offers: clickOffers([target]) })
    );
    const commitment = buildCommitmentQuestions(
      commitmentRequest({ observation, target, form: undefined }),
      'forward'
    );
    expect(actions.state.elements[0]?.expanded).toBe(false);
    expect(commitment.state.elements[0]?.expanded).toBe(false);
    expect(asRecord(questionOf(actions, 'click_target').criteria[target.id])['expanded']).toBe(
      'false'
    );
  });
  it('trims to the 30000 byte default, keeping the request close to it', () => {
    const request = bigRequest(250);
    const set = buildActionQuestions(request);
    const bytes = estimateRequestBytes(set, MODEL);
    expect(bytes).toBeLessThanOrEqual(30000);
    expect(bytes).toBeGreaterThan(28000);
    expect(set.state.elements.length).toBeGreaterThan(10);
    expect(set.state.elements.length).toBeLessThanOrEqual(TASK_TYPESAFE_DEFAULTS.maxOptions - 2);
    expect(set.state.truncation.elementsOmitted).toBe(250 - set.state.elements.length);
    const untrimmed = buildActionQuestions(request, { maxRequestBytes: 400000 });
    expect(estimateRequestBytes(untrimmed, MODEL)).toBeGreaterThan(30000);
  });

  it('honours a smaller maxRequestBytes and clamps a larger one to 40000', () => {
    const small = buildActionQuestions(bigRequest(250), { maxRequestBytes: 9000 });
    expect(estimateRequestBytes(small, MODEL)).toBeLessThanOrEqual(9000);
    expect(small.state.elements.length).toBeGreaterThan(0);
    const huge = buildActionQuestions(bigRequest(250), {
      maxRequestBytes: 10_000_000,
      maxOptions: 255,
    });
    const hugeBytes = estimateRequestBytes(huge, MODEL);
    expect(hugeBytes).toBeLessThanOrEqual(TASK_TYPESAFE_LIMITS.requestBytesCeiling);
    expect(hugeBytes).toBeGreaterThan(36000);
  });

  it('keeps the state under the caller state budget and flags the truncation', () => {
    const set = buildActionQuestions(bigRequest(250, { maxStateBytes: 9000 }), {
      maxRequestBytes: 40000,
    });
    expect(bytesOf(JSON.stringify(set.state))).toBeLessThanOrEqual(9000);
    expect(set.state.truncation.elementsOmitted).toBeGreaterThan(0);
  });

  it('fits a state that is already small without trimming anything', () => {
    const set = buildActionQuestions(actionRequest());
    expect(set.state.truncation).toEqual({ elementsOmitted: 0, textTruncated: false });
    expect(set.state.elements.length).toBe(8);
  });

  it('counts what the page already dropped in elementsOmitted and textTruncated', () => {
    const observation = pageObservation({
      truncation: { elementsDropped: 40, optionsDropped: 0, textTruncated: true },
    });
    const set = buildActionQuestions(actionRequest({ observation }));
    expect(set.state.truncation).toEqual({ elementsOmitted: 40, textTruncated: true });
  });

  it('keeps modal and actionable controls before passive viewport content', () => {
    const elements: TaskElement[] = [
      ...Array.from({ length: 10 }, (_, index) => buttonAt(index + 1, { inViewport: false })),
      ...Array.from({ length: 10 }, (_, index) =>
        buttonAt(index + 11, { inViewport: true, offered: false })
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        buttonAt(index + 21, { inViewport: false, dialogId: 'd1' })
      ),
      ...Array.from({ length: 10 }, (_, index) => buttonAt(index + 26, { inViewport: true })),
    ];
    const observation = makeObservation({
      elements,
      dialogs: [
        {
          id: 'd1',
          modal: true,
          label: 'Sign in',
          elementIds: elements.slice(20, 25).map(e => e.id),
        },
      ],
    });
    const offers = clickOffers(elements);
    const build = (maxOptions: number): TaskQuestionSet =>
      buildActionQuestions(actionRequest({ observation, offers }), { maxOptions, rotate: false });
    const range = (from: number, to: number): string[] =>
      Array.from({ length: to - from + 1 }, (_, index) => `t${String(from + index)}`);
    // maxOptions 12 leaves room for 10 elements: only the modal dialog and then the offered in-viewport ones.
    expect(stateIds(build(12))).toEqual([...range(21, 25), ...range(26, 30)]);
    // 18 elements: modal (5), in viewport and offered (10), then offscreen actionable controls.
    expect(stateIds(build(20))).toEqual([...range(1, 3), ...range(21, 25), ...range(26, 35)]);
    // Passive viewport content follows the actionable controls.
    expect(stateIds(build(32))).toEqual([
      ...range(1, 10),
      ...range(11, 15),
      ...range(21, 25),
      ...range(26, 35),
    ]);
    const criteria = keysOf(questionOf(build(12), 'click_target')).filter(
      key => key !== TASK_NONE_APPROPRIATE
    );
    expect(criteria).toEqual([...range(21, 25), ...range(26, 30)]);
  });

  it('does not trim the only actionable control behind a long list of visible passages', () => {
    const passages = Array.from({ length: 80 }, (_, index) =>
      makeElement({
        id: `p${String(index)}`,
        kind: 'passage',
        role: 'passage',
        operations: ['READ'],
        inViewport: true,
      })
    );
    const button = buttonAt(90, { inViewport: false });
    const observation = makeObservation({ elements: [...passages, button] });
    const offers: TaskOffers = {
      operations: ['READ', 'CLICK', 'DONE', 'BLOCKED'],
      targets: { READ: passages.map(element => element.id), CLICK: [button.id] },
    };
    const set = buildActionQuestions(actionRequest({ observation, offers }), { maxOptions: 12 });
    expect(stateIds(set)).toContain(button.id);
    expect(keysOf(questionOf(set, 'click_target'))).toContain(button.id);
    expect(estimateRequestBytes(set, MODEL)).toBeLessThanOrEqual(30000);
  });

  it('describes the same subset in the state and in the target criteria', () => {
    const set = buildActionQuestions(bigRequest(250));
    const criteria = keysOf(questionOf(set, 'click_target')).filter(
      key => key !== TASK_NONE_APPROPRIATE
    );
    expect([...criteria].sort(byNumber)).toEqual([...stateIds(set)].sort(byNumber));
  });

  it('never exceeds maxOptions criteria in any question, and clamps maxOptions to the API limit', () => {
    const request = bigRequest(400);
    for (const maxOptions of [12, 25, 60]) {
      const set = buildActionQuestions(request, {
        maxOptions,
        maxRequestBytes: 40000,
        rotate: false,
      });
      for (const key of Object.keys(set.questions)) {
        expect(keysOf(questionOf(set, key)).length).toBeLessThanOrEqual(maxOptions);
      }
      expect(set.state.elements.length).toBeLessThanOrEqual(maxOptions - 2);
    }
    const unbounded = buildActionQuestions(request, {
      maxOptions: 5000,
      maxRequestBytes: 10_000_000,
    });
    for (const key of Object.keys(unbounded.questions)) {
      expect(keysOf(questionOf(unbounded, key)).length).toBeLessThanOrEqual(
        TASK_TYPESAFE_LIMITS.apiMaxOptions
      );
    }
    const tiny = buildActionQuestions(actionRequest(), { maxOptions: 1 });
    expect(keysOf(questionOf(tiny, 'operation')).length).toBe(11);
  });

  it('shortens the page text before it drops the elements it must keep', () => {
    const elements = Array.from({ length: 5 }, (_, index) => buttonAt(index + 1));
    const observation = makeObservation({ elements, text: 'Page body. '.repeat(540) });
    const offers = clickOffers(elements);
    const full = buildActionQuestions(actionRequest({ observation, offers }), {
      maxRequestBytes: 40000,
    });
    expect(full.state.truncation.textTruncated).toBe(false);
    const fullBytes = estimateRequestBytes(full, MODEL);
    const budget = fullBytes - 2500;
    const set = buildActionQuestions(actionRequest({ observation, offers }), {
      maxRequestBytes: budget,
    });
    expect(estimateRequestBytes(set, MODEL)).toBeLessThanOrEqual(budget);
    expect(set.state.elements.length).toBe(5);
    expect(set.state.truncation.textTruncated).toBe(true);
    expect(set.state.page.text.length).toBeGreaterThan(0);
    expect(set.state.page.text.length).toBeLessThan(observation.text.length);
    expect(observation.text.startsWith(set.state.page.text.slice(0, 200))).toBe(true);
  });

  it('then compacts element detail and finally drops below the retained elements', () => {
    const elements = Array.from({ length: 30 }, (_, index) => buttonAt(index + 1));
    const observation = makeObservation({ elements, text: '' });
    const offers = clickOffers(elements);
    const build = (options: {
      readonly maxRequestBytes: number;
      readonly maxOptions?: number;
    }): TaskQuestionSet =>
      buildActionQuestions(actionRequest({ observation, offers }), { rotate: false, ...options });
    const all = build({ maxRequestBytes: 40000 });
    expect(all.state.elements.length).toBe(30);
    const sizeAll = estimateRequestBytes(all, MODEL);
    const retainedFloor = build({ maxRequestBytes: 40000, maxOptions: 14 });
    expect(retainedFloor.state.elements.length).toBe(12);
    const sizeFloor = estimateRequestBytes(retainedFloor, MODEL);
    expect(sizeFloor).toBeLessThan(sizeAll);

    // Between the two sizes: elements are dropped, the detail of the kept ones is not.
    const between = build({ maxRequestBytes: Math.floor((sizeAll + sizeFloor) / 2) });
    expect(between.state.elements.length).toBeGreaterThan(12);
    expect(between.state.elements.length).toBeLessThan(30);
    expect(between.state.elements.some(element => element.label.length > 60)).toBe(true);

    // Just below the retained floor: all 12 elements stay and their detail is compacted.
    const compact = build({ maxRequestBytes: sizeFloor - 500 });
    expect(estimateRequestBytes(compact, MODEL)).toBeLessThanOrEqual(sizeFloor - 500);
    expect(compact.state.elements.length).toBe(12);
    for (const element of compact.state.elements) {
      expect(element.label.length).toBeLessThanOrEqual(60);
      expect(element.options).toBeUndefined();
    }

    // Far below: fewer than the retained 12, still in priority order, and criteria follow the state.
    const starved = build({ maxRequestBytes: 3500 });
    expect(estimateRequestBytes(starved, MODEL)).toBeLessThanOrEqual(3500);
    expect(starved.state.elements.length).toBeGreaterThanOrEqual(1);
    expect(starved.state.elements.length).toBeLessThan(12);
    expect(stateIds(starved)).toEqual(
      elements.slice(0, starved.state.elements.length).map(e => e.id)
    );
    const kept = keysOf(questionOf(starved, 'click_target')).filter(
      key => key !== TASK_NONE_APPROPRIATE
    );
    expect(kept).toEqual(stateIds(starved));
  });

  it('builds the smallest request it can when even that is over the budget, so the caller sees it is over', () => {
    const set = buildActionQuestions(bigRequest(50), { maxRequestBytes: 1500 });
    expect(set.state.elements.length).toBe(1);
    expect(set.state.page.text).toBe('');
    expect(estimateRequestBytes(set, MODEL)).toBeGreaterThan(1500);
    expect(set.state.truncation.elementsOmitted).toBe(49);
    expect(set.state.truncation.textTruncated).toBe(true);
  });

  it('never builds a one-option evidence question when there is nothing to cite', () => {
    const set = buildCompletionQuestions(
      completionRequest({ observation: makeObservation({ elements: [] }), collectedEvidence: [] })
    );
    expect(Object.keys(set.questions)).toEqual(['completion', 'answer']);
    expect(set.state.elements).toEqual([]);
    for (const key of Object.keys(set.questions)) {
      expect(keysOf(questionOf(set, key)).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('ranks the members of a modal dialog first, whether the dialog lists them or the element names the dialog', () => {
    const inView = Array.from({ length: 12 }, (_, index) =>
      buttonAt(index + 1, { inViewport: true })
    );
    const listed = buttonAt(13, { inViewport: false });
    const named = buttonAt(14, { inViewport: false, dialogId: 'd1' });
    const elements = [...inView, listed, named];
    const build = (modal: boolean): readonly string[] =>
      stateIds(
        buildActionQuestions(
          actionRequest({
            observation: makeObservation({
              elements,
              dialogs: [{ id: 'd1', modal, label: 'Sign in', elementIds: ['t13'] }],
            }),
            offers: clickOffers(elements),
          }),
          { maxOptions: 12, rotate: false }
        )
      );
    expect(build(true)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't13', 't14']);
    expect(build(false)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']);
  });

  it('keeps a page with no elements buildable: nothing to drop, nothing to refuse', () => {
    const observation = makeObservation({ elements: [], text: 'Empty page' });
    const offers: TaskOffers = { operations: ['WAIT', 'DONE', 'BLOCKED'], targets: {} };
    const set = buildActionQuestions(actionRequest({ observation, offers }));
    expect(Object.keys(set.questions)).toEqual(['operation']);
    expect(keysOf(questionOf(set, 'operation')).sort()).toEqual(['BLOCKED', 'DONE', 'WAIT']);
  });

  it('trims every stage to its budget', () => {
    const observation = bigObservation(250);
    const target = must(observation.elements[10], 't11');
    const candidates: TaskCandidateView[] = Array.from({ length: 100 }, (_, index) => ({
      id: `c${String(index + 1)}`,
      source: 'input',
      label: `input number ${String(index + 1)} ${'padding '.repeat(30)}`,
      preview: `value ${String(index + 1)} ${'padding '.repeat(30)}`,
      sensitive: false,
    }));
    const evidence = Array.from({ length: 8 }, (_, index) => ({
      id: `e${String(index + 1)}`,
      ledgerSeq: index,
      url: `${FIXTURE_ORIGIN}/p${String(index)}`,
      label: `Passage ${String(index + 1)}`,
      text: 'evidence '.repeat(80),
    }));
    const sets = [
      buildArgumentQuestions(argumentRequest({ observation, target, candidates })),
      buildCompletionQuestions(completionRequest({ observation, collectedEvidence: evidence })),
    ];
    for (const set of sets) {
      expect(estimateRequestBytes(set, MODEL)).toBeLessThanOrEqual(30000);
      expect(set.state.truncation.elementsOmitted).toBeGreaterThan(0);
    }
    const [, completion] = sets;
    const evidenceIds = keysOf(questionOf(must(completion, 'completion set'), 'evidence_1')).filter(
      key => key.startsWith('e')
    );
    expect(evidenceIds.length).toBeGreaterThan(0);
  });

  it('keeps the evidence criteria in step with the evidence the state carries', () => {
    const set = buildCompletionQuestions(completionRequest({ observation: bigObservation(250) }));
    const shown = (set.state.collectedEvidence ?? []).map(item => item.id);
    for (const key of ['evidence_1', 'evidence_2']) {
      const ids = keysOf(questionOf(set, key));
      expect(ids).toEqual(expect.arrayContaining(shown));
      const elements = ids.filter(id => id.startsWith('t'));
      expect([...elements].sort(byNumber)).toEqual([...stateIds(set)].sort(byNumber));
    }
  });
});

function byNumber(left: string, right: string): number {
  return Number(left.slice(1)) - Number(right.slice(1));
}

describe('budget boundaries and caps', () => {
  it('keeps the whole request when the budget equals its size, and trims at one byte less', () => {
    // The builders measure with a 64 character model name so a longer versioned id still fits.
    const allowance = 'm'.repeat(64);
    const request = bigRequest(20);
    const full = buildActionQuestions(request, { maxRequestBytes: 40000 });
    const size = estimateRequestBytes(full, allowance);
    expect(size).toBeGreaterThan(5000);
    expect(size).toBeLessThan(TASK_TYPESAFE_DEFAULTS.maxRequestBytes);
    expect(full.state.elements).toHaveLength(20);
    const exact = buildActionQuestions(request, { maxRequestBytes: size });
    expect(exact).toEqual(full);
    const tighter = buildActionQuestions(request, { maxRequestBytes: size - 1 });
    expect(estimateRequestBytes(tighter, allowance)).toBeLessThanOrEqual(size - 1);
    expect(tighter).not.toEqual(full);
  });

  it('keeps the whole state when the state budget equals its size, and trims at one byte less', () => {
    const request = bigRequest(20);
    const full = buildActionQuestions(request, { maxRequestBytes: 40000 });
    const stateBytes = bytesOf(JSON.stringify(full.state));
    const exact = buildActionQuestions(
      { ...request, maxStateBytes: stateBytes },
      {
        maxRequestBytes: 40000,
      }
    );
    expect(exact).toEqual(full);
    const tighter = buildActionQuestions(
      { ...request, maxStateBytes: stateBytes - 1 },
      {
        maxRequestBytes: 40000,
      }
    );
    expect(bytesOf(JSON.stringify(tighter.state))).toBeLessThanOrEqual(stateBytes - 1);
    expect(tighter).not.toEqual(full);
  });

  it('caps what the state shows of inputs, notices and validation lines, keeping the first ones in order', () => {
    const inputs: TaskInputSummary[] = Array.from({ length: 60 }, (_, index) => ({
      path: `field${String(index)}`,
      sensitive: false,
      preview: `v${String(index)}`,
    }));
    const observation = pageObservation({
      notices: Array.from({ length: 15 }, (_, index) => ({
        kind: 'status' as const,
        text: `Notice ${String(index)}`,
      })),
      validation: Array.from({ length: 15 }, (_, index) => ({
        source: 'dom' as const,
        text: `Problem ${String(index)}`,
      })),
    });
    const sets = [
      buildActionQuestions(actionRequest({ observation, inputs })),
      buildArgumentQuestions(argumentRequest({ observation, inputs })),
      buildCompletionQuestions(completionRequest({ observation, inputs })),
    ];
    for (const set of sets) {
      expect(set.state.inputs.map(input => input.path)).toEqual(
        Array.from({ length: 40 }, (_, index) => `field${String(index)}`)
      );
      expect(set.state.notices).toHaveLength(10);
      expect(set.state.notices[9]).toBe('status: Notice 9');
      expect(set.state.validation).toHaveLength(10);
      expect(set.state.validation[9]).toBe('Problem 9');
    }
  });

  it('caps a history detail at 200 characters and the expected states at twenty', () => {
    const history: TaskHistoryEntry[] = [{ step: 1, kind: 'action', detail: 'd'.repeat(500) }];
    const action = buildActionQuestions(actionRequest({ history }));
    expect(action.state.recentActions[0]?.detail).toHaveLength(200);
    const expected = Array.from({ length: 30 }, (_, index) => ({
      label: `Field ${String(index)}`,
      kind: 'field_value' as const,
      expected: `v${String(index)}`,
      sensitive: false,
      status: 'holds' as const,
    }));
    const completion = buildCompletionQuestions(completionRequest({ expected }));
    expect(completion.state.expected).toHaveLength(20);
    expect(completion.state.expected?.[19]?.label).toBe('Field 19');
  });

  it('never exceeds maxOptions criteria in an evidence question, the collected evidence counted', () => {
    const observation = bigObservation(30);
    const collectedEvidence = Array.from({ length: 8 }, (_, index) => ({
      id: `e${String(index + 1)}`,
      ledgerSeq: index,
      url: `${FIXTURE_ORIGIN}/passage/${String(index)}`,
      label: `Passage ${String(index)}`,
      text: 'A short passage.',
    }));
    for (const maxOptions of [12, 20, 60]) {
      const set = buildCompletionQuestions(completionRequest({ observation, collectedEvidence }), {
        maxOptions,
        maxRequestBytes: 40000,
        rotate: false,
      });
      for (const key of Object.keys(set.questions)) {
        expect(keysOf(questionOf(set, key)).length).toBeLessThanOrEqual(maxOptions);
      }
      const cited = keysOf(questionOf(set, 'evidence_1')).filter(id => /^e\d+$/.test(id));
      expect(cited).toHaveLength(8);
    }
  });
});

describe('estimateRequestBytes and estimateRequestTokens', () => {
  const sample = (title: string): TaskQuestionSet => ({
    stage: 'action',
    state: {
      task: 'goal',
      page: { url: 'https://example.test/', title, text: '' },
      elements: [],
      pageControls: { scroll: { directions: [] }, waitDurationsMs: [] },
      notices: [],
      validation: [],
      inputs: [],
      recentActions: [],
      truncation: { elementsOmitted: 0, textTruncated: false },
    },
    questions: {
      operation: {
        type: 'choice',
        instructions: { goal: 'goal', rules: 'r' },
        criteria: { DONE: 'd', BLOCKED: 'b' },
      },
    },
  });

  it('is the UTF-8 length of JSON.stringify({ model, state, questions })', () => {
    const lone = String.fromCharCode(0xd83d);
    const titles = [
      'plain',
      'café',
      '日本語',
      String.fromCodePoint(0x1f600),
      `mixed ${String.fromCodePoint(0x1f600)} café 日 "quoted" \\ back \n newline`,
      `lone ${lone} surrogate`,
      '',
    ];
    for (const title of titles) {
      const set = sample(title);
      for (const model of [MODEL, 'jev-1.13.0', '']) {
        const expected = Buffer.byteLength(
          JSON.stringify({ model, state: set.state, questions: set.questions }),
          'utf8'
        );
        expect(estimateRequestBytes(set, model)).toBe(expected);
      }
    }
  });

  it('grows with the model name and with multibyte text', () => {
    const base = estimateRequestBytes(sample('x'), 'm');
    expect(estimateRequestBytes(sample('x'), 'mmmm')).toBe(base + 3);
    expect(estimateRequestBytes(sample('日'), 'm')).toBe(base + 2);
    expect(estimateRequestBytes(sample(String.fromCodePoint(0x1f600)), 'm')).toBe(base + 3);
  });

  it('matches a real built request byte for byte', () => {
    for (const set of allQuestionSets()) {
      const expected = Buffer.byteLength(
        JSON.stringify({ model: MODEL, state: set.state, questions: set.questions }),
        'utf8'
      );
      expect(estimateRequestBytes(set, MODEL)).toBe(expected);
    }
  });

  it('estimates tokens as ceil(bytes / 1.9), never bytes / 4', () => {
    expect(TASK_TYPESAFE_LIMITS.bytesPerToken).toBe(1.9);
    expect(estimateRequestTokens(0)).toBe(0);
    expect(estimateRequestTokens(1)).toBe(1);
    expect(estimateRequestTokens(39953)).toBe(Math.ceil(39953 / 1.9));
    expect(estimateRequestTokens(39953)).toBe(21028);
    expect(estimateRequestTokens(30000)).toBe(15790);
    expect(estimateRequestTokens(971)).toBe(Math.ceil(971 / 1.9));
    expect(estimateRequestTokens(1000)).toBeGreaterThan(1000 / 4 + 100);
    expect(estimateRequestTokens(-5)).toBe(0);
    expect(estimateRequestTokens(Number.NaN)).toBe(0);
  });

  it('estimates the proven-good 39953 byte request within 2 percent of the 21271 tokens the API counted', () => {
    const estimate = estimateRequestTokens(39953);
    expect(Math.abs(estimate - 21271) / 21271).toBeLessThan(0.02);
  });
});

describe('library strings', () => {
  const SITE_WORDS = [
    'amazon',
    'ebay',
    'flipkart',
    'shopify',
    'walmart',
    'etsy',
    'breeze',
    'juspay',
    'typesafe',
    'paypal',
    'google',
    'facebook',
  ];
  const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
    ['url', /https?:\/\//],
    ['selector', /[#.][a-z][\w-]*\s*[{>]/],
    ['step count', /\bstep\s*\d/i],
    ['ordering hint', /\b(first|second|third|last|then|next|before)\b/i],
    ['site word', new RegExp(`\\b(${SITE_WORDS.join('|')})\\b`, 'i')],
  ];
  const violations = (text: string): string[] =>
    FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

  const libraryStrings = (set: TaskQuestionSet): string[] => {
    const found: string[] = [];
    for (const key of Object.keys(set.questions)) {
      const question = questionOf(set, key);
      for (const [name, value] of Object.entries(question.instructions)) {
        if (name !== 'goal') {
          found.push(value);
        }
      }
      const libraryCriteria =
        key === 'operation' ||
        key.startsWith('commitment') ||
        key === 'completion' ||
        key === 'answer';
      for (const [criterion, value] of Object.entries(question.criteria)) {
        if (
          libraryCriteria ||
          criterion === TASK_NONE_APPROPRIATE ||
          criterion === TASK_PAGE_TARGET_ID
        ) {
          found.push(typeof value === 'string' ? value : JSON.stringify(value));
        } else if (typeof value !== 'string' && value['operationHint'] !== undefined) {
          found.push(value['operationHint']);
        }
      }
    }
    return found;
  };

  it('detects each forbidden pattern in a planted string (positive controls)', () => {
    expect(violations('see https://example.test/x')).toContain('url');
    expect(violations('use #submit > span')).toContain('selector');
    expect(violations('click .btn-primary {')).toContain('selector');
    expect(violations('do step 3 now')).toContain('step count');
    expect(violations('pick the first one')).toContain('ordering hint');
    expect(violations('open Amazon')).toContain('site word');
    expect(violations('Spends money or places an order.')).toEqual([]);
  });

  it('contains no URL, selector, step count, ordering hint or site word in any library-authored string', () => {
    const offers: TaskOffers = {
      operations: [
        'READ',
        'CLICK',
        'NAVIGATE',
        'FILL',
        'SELECT',
        'SET_CHECKED',
        'PRESS',
        'SCROLL',
        'WAIT',
        'SUBMIT',
        'DONE',
        'BLOCKED',
      ],
      targets: { ...PAGE_OFFERS.targets, PRESS: ['t3'] },
    };
    const sets = [
      buildActionQuestions(actionRequest({ offers })),
      buildArgumentQuestions(argumentRequest()),
      buildCommitmentQuestions(commitmentRequest(), 'forward'),
      buildCommitmentQuestions(commitmentRequest(), 'reverse'),
      buildCompletionQuestions(completionRequest()),
    ];
    let scanned = 0;
    for (const set of sets) {
      for (const text of libraryStrings(set)) {
        expect({ text, violations: violations(text) }).toEqual({ text, violations: [] });
        scanned += 1;
      }
    }
    expect(scanned).toBeGreaterThan(60);
  });

  it('leaves the rules of the four stages free of the same patterns', () => {
    const rules = new Set(
      allQuestionSets().flatMap(set =>
        Object.keys(set.questions).map(key => questionOf(set, key).instructions['rules'])
      )
    );
    expect(rules.size).toBeGreaterThanOrEqual(4);
    for (const text of rules) {
      expect(typeof text).toBe('string');
      expect(violations(text ?? '')).toEqual([]);
    }
  });
});

describe('DOM independence', () => {
  it('uses no browser global in request.ts', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'agent', 'request.ts'), 'utf8');
    const pattern =
      /\b(window|document|navigator|location|HTMLElement|HTMLInputElement|Element|MutationObserver|getComputedStyle|localStorage|sessionStorage|requestAnimationFrame|TextEncoder)\b|instanceof +Node\b/;
    expect(pattern.exec(source)).toBeNull();
    expect(/\bconsole\./.test(source)).toBe(false);
    expect(typeof window).toBe('undefined');
  });
});
