/** @jest-environment node */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTypeSafeTaskDecider } from '@/agent/typesafe';
import {
  buildActionQuestions,
  estimateRequestBytes,
  estimateRequestTokens,
  questionRotations,
} from '@/agent/request';
import {
  TASK_LIMITS,
  TASK_NONE_APPROPRIATE,
  TASK_PAGE_TARGET_ID,
  TASK_TYPESAFE_DEFAULTS,
} from '@/types';
import type {
  TaskCallContext,
  TaskChooseActionRequest,
  TaskChooseArgumentRequest,
  TaskClassifyCommitmentRequest,
  TaskCreateTypeSafeDeciderFn,
  TaskDecider,
  TaskDeciderErrorCode,
  TaskDeciderResult,
  TaskElement,
  TaskExchange,
  TaskHttp,
  TaskHttpRequest,
  TaskHttpResponse,
  TaskOffers,
  TaskVerifyCompletionRequest,
  TypeSafeTaskDeciderConfig,
} from '@/types';
import {
  FIXTURE_ORIGIN,
  makeCapabilities,
  makeCommand,
  makeElement,
  makeForm,
  makeObservation,
  makePageElements,
  makeRedactedCommand,
  makeSubmitButton,
  makeTextField,
  signatureFor,
  summarizeElement,
} from './helpers/agent-fixtures';

export const seamConformance: TaskCreateTypeSafeDeciderFn = createTypeSafeTaskDecider;

const GOAL = 'Find the cheapest blue umbrella and add it to the cart';
const KEY = `tsk-${randomUUID()}-${randomUUID()}`;
const ECHO = `echoed-page-text-${randomUUID()}`;
const REQUEST_ID = 'req_0123456789abcdef0123456789abcdef';

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
};

function succeeded<T>(result: TaskDeciderResult<T>): {
  readonly decision: T;
  readonly exchange: TaskExchange;
} {
  if (!result.ok) {
    throw new Error(`expected a decision, got ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function failed(result: TaskDeciderResult<unknown>): {
  readonly error: Extract<TaskDeciderResult<unknown>, { readonly ok: false }>['error'];
  readonly exchange?: TaskExchange;
} {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const PAGE_OFFERS: TaskOffers = {
  operations: ['READ', 'CLICK', 'FILL', 'SCROLL', 'WAIT', 'DONE', 'BLOCKED'],
  targets: { READ: ['t7'], CLICK: ['t1'], FILL: ['t3', 't8'], SCROLL: [TASK_PAGE_TARGET_ID] },
};

const actionRequest = (
  overrides: Partial<TaskChooseActionRequest> = {}
): TaskChooseActionRequest => ({
  goal: GOAL,
  step: 0,
  observation: makeObservation({ elements: makePageElements() }),
  offers: PAGE_OFFERS,
  capabilities: makeCapabilities(),
  inputs: [],
  history: [],
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

const argumentRequest = (
  overrides: Partial<TaskChooseArgumentRequest> = {}
): TaskChooseArgumentRequest => ({
  goal: GOAL,
  step: 0,
  observation: makeObservation({ elements: makePageElements() }),
  operation: 'FILL',
  target: makeTextField(),
  slot: 'value',
  candidates: [
    {
      id: 'c1',
      source: 'goal_span',
      label: 'Goal text',
      preview: 'blue umbrella',
      sensitive: false,
    },
    { id: 'c2', source: 'input', label: 'email', preview: 'a@example.test', sensitive: false },
  ],
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
  observation: makeObservation({ elements: makePageElements() }),
  command: makeRedactedCommand({
    command: makeCommand('SUBMIT'),
    target: summarizeElement(makeSubmitButton()),
  }),
  target: makeSubmitButton(),
  form: makeForm(),
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

const completionRequest = (
  overrides: Partial<TaskVerifyCompletionRequest> = {}
): TaskVerifyCompletionRequest => ({
  goal: GOAL,
  step: 2,
  observation: makeObservation({ elements: makePageElements() }),
  history: [],
  inputs: [],
  evidenceSlots: 2,
  collectedEvidence: [],
  expected: [],
  expectAnswer: true,
  maxStateBytes: TASK_LIMITS.modelStateBytes,
  ...overrides,
});

const context = (overrides: Partial<TaskCallContext> = {}): TaskCallContext => ({
  goal: GOAL,
  step: 0,
  runId: 'run_000000000001',
  callIndex: 1,
  ...overrides,
});

const buttonAt = (index: number): TaskElement =>
  makeElement({
    id: `t${String(index)}`,
    signature: signatureFor(`t${String(index)}`),
    label: `Product number ${String(index)} ${'lorem ipsum '.repeat(12)}`,
    href: `${FIXTURE_ORIGIN}/products/${String(index)}`,
    region: 'Results',
  });

const bigActionRequest = (count: number, overrides: Partial<TaskChooseActionRequest> = {}) => {
  const elements = Array.from({ length: count }, (_, index) => buttonAt(index + 1));
  return actionRequest({
    observation: makeObservation({ elements, text: 'Search results page. '.repeat(280) }),
    offers: {
      operations: ['CLICK', 'DONE', 'BLOCKED'],
      targets: { CLICK: elements.map(element => element.id) },
    },
    ...overrides,
  });
};

// ---------------------------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------------------------

type AnswerOptions = {
  /** question key to chosen criterion; every other question answers its first criterion. */
  readonly choices?: Readonly<Record<string, string>>;
  readonly confidence?: number | Readonly<Record<string, number>>;
  readonly model?: unknown;
  readonly usage?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Edits the response body after it was built, to make it malformed. */
  readonly mutate?: (body: Record<string, unknown>) => unknown;
};

type Step =
  | {
      readonly respond: number;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly jsonThrows?: boolean;
    }
  | { readonly answer: AnswerOptions }
  | { readonly throws: unknown }
  | { readonly hang: true };

type FakeCall = { readonly url: string; readonly init: TaskHttpRequest };
type FakeHttp = { readonly fn: TaskHttp; readonly calls: FakeCall[] };

function parseBody(body: string): Record<string, unknown> {
  return asRecord(JSON.parse(body));
}

function answerBody(requestBody: string, options: AnswerOptions): unknown {
  const questions = asRecord(parseBody(requestBody)['questions']);
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const criteria = Object.keys(asRecord(asRecord(question)['criteria']));
    const choice = options.choices?.[key] ?? must(criteria[0], `criterion of ${key}`);
    const probabilities = Object.fromEntries(
      [...criteria].reverse().map(criterion => [criterion, criterion === choice ? 1 : 0])
    );
    const confidence =
      typeof options.confidence === 'number'
        ? options.confidence
        : (options.confidence?.[key] ?? 1);
    answers[key] = { type: 'choice', choice, confidence, probabilities };
  }
  const body: Record<string, unknown> = {
    model: 'model' in options ? options.model : 'jev-1.13.0',
    answers,
    usage: 'usage' in options ? options.usage : { input_tokens: 1234, output_tokens: 56 },
  };
  return options.mutate === undefined ? body : options.mutate(body);
}

function toResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  jsonThrows: boolean
): TaskHttpResponse {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    header: name => lower[name.toLowerCase()] ?? null,
    json: () =>
      jsonThrows
        ? Promise.reject(new SyntaxError(`Unexpected token ${ECHO}`))
        : Promise.resolve(body),
  };
}

function fakeHttp(steps: readonly Step[]): FakeHttp {
  const calls: FakeCall[] = [];
  const fn: TaskHttp = (url, init) => {
    const step = must(steps[Math.min(calls.length, steps.length - 1)], 'step');
    calls.push({ url, init });
    if ('throws' in step) {
      return Promise.reject(step.throws);
    }
    if ('hang' in step) {
      return new Promise<TaskHttpResponse>(() => undefined);
    }
    if ('answer' in step) {
      return Promise.resolve(
        toResponse(200, answerBody(init.body, step.answer), step.answer.headers ?? {}, false)
      );
    }
    return Promise.resolve(
      toResponse(step.respond, step.body ?? {}, step.headers ?? {}, step.jsonThrows === true)
    );
  };
  return { fn, calls };
}

type Harness = {
  readonly decider: TaskDecider;
  readonly http: FakeHttp;
  readonly sleeps: number[];
  readonly sleepSignals: (AbortSignal | undefined)[];
};

function harness(
  steps: readonly Step[],
  overrides: Partial<TypeSafeTaskDeciderConfig> = {},
  random: () => number = () => 0
): Harness {
  const http = fakeHttp(steps);
  const sleeps: number[] = [];
  const sleepSignals: (AbortSignal | undefined)[] = [];
  let now = 0;
  const decider = createTypeSafeTaskDecider({
    apiKey: KEY,
    http: http.fn,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      sleepSignals.push(signal);
      return Promise.resolve();
    },
    random,
    clock: () => {
      now += 5;
      return now;
    },
    ...overrides,
  });
  return { decider, http, sleeps, sleepSignals };
}

const ANSWER_CLICK: Step = { answer: { choices: { operation: 'CLICK', click_target: 't1' } } };

const callOf = (calls: readonly FakeCall[], index: number): FakeCall =>
  must(calls[index], `call ${String(index)}`);

const leaks = (value: unknown, secret: string = KEY): boolean =>
  JSON.stringify(value, (_, inner: unknown) =>
    typeof inner === 'function' ? undefined : inner
  ).includes(secret);

// ---------------------------------------------------------------------------------------------
// Stage parsing
// ---------------------------------------------------------------------------------------------

describe('createTypeSafeTaskDecider: shape', () => {
  it('returns all four stages, classifyCommitment included', () => {
    const { decider } = harness([ANSWER_CLICK]);
    expect(typeof decider.chooseAction).toBe('function');
    expect(typeof decider.chooseArgument).toBe('function');
    expect(typeof decider.classifyCommitment).toBe('function');
    expect(typeof decider.verifyCompletion).toBe('function');
  });

  it('does not touch the network or the key when it is created', () => {
    const http = fakeHttp([ANSWER_CLICK]);
    let reads = 0;
    createTypeSafeTaskDecider({
      apiKey: () => {
        reads += 1;
        return KEY;
      },
      http: http.fn,
    });
    expect(reads).toBe(0);
    expect(http.calls.length).toBe(0);
  });
});

describe('stage 1: chooseAction parse', () => {
  it('maps the operation and target answers, confidence being the smaller of the two', async () => {
    const { decider, http } = harness([
      {
        answer: {
          choices: { operation: 'CLICK', click_target: 't1' },
          confidence: { operation: 0.9, click_target: 0.7 },
        },
      },
    ]);
    const { decision, exchange } = succeeded(
      await decider.chooseAction(actionRequest(), context())
    );
    expect(decision).toEqual({
      operation: 'CLICK',
      target: { kind: 'target', id: 't1' },
      confidence: 0.7,
      operationConfidence: 0.9,
      targetConfidence: 0.7,
    });
    expect(http.calls.length).toBe(1);
    expect(exchange.stage).toBe('action');
    expect(exchange.answers?.['operation']).toEqual({ choice: 'CLICK', confidence: 0.9 });
    expect(exchange.answers?.['click_target']).toEqual({ choice: 't1', confidence: 0.7 });
  });

  it('asks every question in one call and requires an answer for each', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    await decider.chooseAction(actionRequest(), context());
    const sent = parseBody(callOf(http.calls, 0).init.body);
    expect(Object.keys(asRecord(sent['questions'])).sort()).toEqual(
      ['click_target', 'fill_target', 'operation', 'read_target', 'scroll_target'].sort()
    );
    expect(Object.keys(sent).sort()).toEqual(['model', 'questions', 'state']);
    expect(asRecord(sent['state'])['task']).toBe(GOAL);
  });

  it.each(['DONE', 'BLOCKED', 'WAIT'] as const)('%s needs no target', async operation => {
    const { decider } = harness([
      { answer: { choices: { operation }, confidence: { operation: 0.8 } } },
    ]);
    const { decision } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(decision).toEqual({
      operation,
      target: { kind: 'not_applicable' },
      confidence: 0.8,
      operationConfidence: 0.8,
    });
  });

  it('maps NONE_APPROPRIATE for a target to none_appropriate, keeping both confidences', async () => {
    const { decider } = harness([
      {
        answer: {
          choices: { operation: 'FILL', fill_target: TASK_NONE_APPROPRIATE },
          confidence: { operation: 0.95, fill_target: 0.6 },
        },
      },
    ]);
    const { decision } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(decision).toEqual({
      operation: 'FILL',
      target: { kind: 'none_appropriate' },
      confidence: 0.6,
      operationConfidence: 0.95,
      targetConfidence: 0.6,
    });
  });

  it('can choose the whole page as a scroll target', async () => {
    const { decider } = harness([
      { answer: { choices: { operation: 'SCROLL', scroll_target: TASK_PAGE_TARGET_ID } } },
    ]);
    const { decision } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(decision.target).toEqual({ kind: 'target', id: TASK_PAGE_TARGET_ID });
  });

  it('rejects a response that answers only the questions it needs', async () => {
    const { decider } = harness([
      {
        answer: {
          choices: { operation: 'CLICK', click_target: 't1' },
          mutate: body => {
            delete asRecord(body['answers'])['fill_target'];
            return body;
          },
        },
      },
    ]);
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('INVALID_RESPONSE');
    expect(result.error.message).toContain('fill_target');
  });
});

describe('stage 2: chooseArgument parse', () => {
  it('preserves missing-value and rejection-testing semantics for actual validation judgments', async () => {
    const needed = harness([
      {
        answer: {
          choices: { argument_applicability: 'REQUIRED', argument: TASK_NONE_APPROPRIATE },
          confidence: { argument_applicability: 0.95, argument: 0.9 },
        },
      },
    ]);
    const result = succeeded(
      await needed.decider.chooseArgument(argumentRequest({ purpose: 'validation' }), context())
    );
    expect(result.decision).toEqual({ kind: 'required_unavailable', confidence: 0.9 });
    const rejectionTest = harness([
      {
        answer: {
          choices: { argument_applicability: 'UNRELATED', argument: 'c1' },
          confidence: { argument_applicability: 0.95, argument: 0.1 },
        },
      },
    ]);
    const observedRejection = succeeded(
      await rejectionTest.decider.chooseArgument(
        argumentRequest({ purpose: 'validation' }),
        context()
      )
    );
    expect(observedRejection.decision).toEqual({ kind: 'none_appropriate', confidence: 0.95 });
  });

  it('ignores an unused weak activation branch only after an unrelated scope judgment', async () => {
    const { decider } = harness([
      {
        answer: {
          choices: { argument_applicability: 'UNRELATED', argument: 'c1' },
          confidence: { argument_applicability: 0.95, argument: 0.05 },
        },
      },
    ]);
    const result = succeeded(
      await decider.chooseArgument(argumentRequest({ purpose: 'activation' }), context())
    );
    expect(result.decision).toEqual({ kind: 'none_appropriate', confidence: 0.95 });
    const related = harness([
      {
        answer: {
          choices: { argument_applicability: 'REQUIRED', argument: TASK_NONE_APPROPRIATE },
          confidence: { argument_applicability: 0.9, argument: 0.8 },
        },
      },
    ]);
    const unusedSubmission = succeeded(
      await related.decider.chooseArgument(argumentRequest({ purpose: 'activation' }), context())
    );
    expect(unusedSubmission.decision).toEqual({ kind: 'none_appropriate', confidence: 0.8 });
  });

  it('returns the selected observed group member and preserves group sentinel meanings', async () => {
    const members = [makeTextField({ id: 't31' }), makeTextField({ id: 't32' })];
    const candidates = members.map(member => ({
      id: member.id,
      source: 'protocol' as const,
      label: member.label,
      sensitive: false,
    }));
    for (const [choice, expected] of [
      ['t32', { kind: 'candidate', candidateId: 't32', confidence: 0.9 }],
      ['KEEP_CURRENT', { kind: 'keep_current', confidence: 0.9 }],
      ['REQUIRED_UNAVAILABLE', { kind: 'required_unavailable', confidence: 0.9 }],
      [TASK_NONE_APPROPRIATE, { kind: 'none_appropriate', confidence: 0.9 }],
    ] as const) {
      const { decider, http } = harness([
        { answer: { choices: { argument: choice }, confidence: 0.9 } },
      ]);
      const result = succeeded(
        await decider.chooseArgument(
          argumentRequest({ purpose: 'group', group: { id: 'observed', members }, candidates }),
          context()
        )
      );
      expect(result.decision).toEqual(expected);
      expect(
        Object.keys(asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']))
      ).toEqual(['argument']);
    }
  });

  it('refuses an oversized group instead of silently dropping observed alternatives', async () => {
    const members = Array.from({ length: 15 }, (_, index) =>
      makeTextField({ id: `t${String(index + 30)}` })
    );
    const { decider, http } = harness([{ answer: {} }], { maxOptions: 12 });
    const result = failed(
      await decider.chooseArgument(
        argumentRequest({
          purpose: 'group',
          group: { id: 'observed', members },
          candidates: members.map(member => ({
            id: member.id,
            source: 'protocol',
            label: member.label,
            sensitive: false,
          })),
        }),
        context()
      )
    );
    expect(result.error.code).toBe('REQUEST_TOO_LARGE');
    expect(http.calls).toHaveLength(0);
  });

  it('ignores unused value uncertainty for an unrelated requirement', async () => {
    const { decider } = harness([
      {
        answer: {
          choices: { argument_applicability: 'UNRELATED', argument: 'c2' },
          confidence: { argument_applicability: 0.95, argument: 0.2 },
        },
      },
    ]);
    const result = succeeded(
      await decider.chooseArgument(argumentRequest({ purpose: 'requirement' }), context())
    );
    expect(result.decision).toEqual({ kind: 'none_appropriate', confidence: 0.95 });
  });

  it('distinguishes uncertain relevance from an unrelated control', async () => {
    const { decider } = harness([
      {
        answer: {
          choices: { argument_applicability: 'UNCERTAIN', argument: 'c2' },
          confidence: { argument_applicability: 0.9, argument: 0.95 },
        },
      },
    ]);
    const result = succeeded(
      await decider.chooseArgument(argumentRequest({ purpose: 'requirement' }), context())
    );
    expect(result.decision).toEqual({ kind: 'uncertain_requirement', confidence: 0.9 });
  });

  it('requires both relevance and value confidence, and treats missing required data separately', async () => {
    for (const [choice, expected] of [
      ['c2', { kind: 'candidate', candidateId: 'c2', confidence: 0.7 }],
      [TASK_NONE_APPROPRIATE, { kind: 'required_unavailable', confidence: 0.7 }],
    ] as const) {
      const { decider } = harness([
        {
          answer: {
            choices: { argument_applicability: 'REQUIRED', argument: choice },
            confidence: { argument_applicability: 0.7, argument: 0.9 },
          },
        },
      ]);
      const result = succeeded(
        await decider.chooseArgument(argumentRequest({ purpose: 'requirement' }), context())
      );
      expect(result.decision).toEqual(expected);
    }
  });

  it('maps a chosen candidate and the none option', async () => {
    const chosen = harness([{ answer: { choices: { argument: 'c2' }, confidence: 0.8 } }]);
    const first = succeeded(await chosen.decider.chooseArgument(argumentRequest(), context()));
    expect(first.decision).toEqual({ kind: 'candidate', candidateId: 'c2', confidence: 0.8 });
    expect(first.exchange.stage).toBe('argument');
    const none = harness([
      { answer: { choices: { argument: TASK_NONE_APPROPRIATE }, confidence: 0.65 } },
    ]);
    const second = succeeded(await none.decider.chooseArgument(argumentRequest(), context()));
    expect(second.decision).toEqual({ kind: 'none_appropriate', confidence: 0.65 });
  });

  it('never sends a question for zero candidates', async () => {
    const { decider, http } = harness([{ answer: {} }]);
    const result = failed(
      await decider.chooseArgument(argumentRequest({ candidates: [] }), context())
    );
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(result.error.retryable).toBe(false);
    expect(http.calls.length).toBe(0);
  });
});

describe('stage 3: classifyCommitment', () => {
  const classes = (forward: string, reverse: string): Step => ({
    answer: {
      choices: {
        commitment: forward,
        commitment_reverse: reverse,
        commitment_presence: 'NO_COMMITMENT',
      },
      confidence: { commitment: 0.9, commitment_reverse: 0.7, commitment_presence: 0.8 },
    },
  });

  it('asks the same question twice in one call, in forward and in reversed key order', async () => {
    const { decider, http } = harness([classes('PURCHASE', 'PURCHASE')]);
    await decider.classifyCommitment?.(commitmentRequest({ step: 3 }), context({ step: 3 }));
    expect(http.calls.length).toBe(1);
    const questions = asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']);
    expect(Object.keys(questions)).toEqual([
      'commitment',
      'commitment_reverse',
      'commitment_presence',
    ]);
    const forward = Object.keys(asRecord(asRecord(questions['commitment'])['criteria']));
    const reverse = Object.keys(asRecord(asRecord(questions['commitment_reverse'])['criteria']));
    expect(reverse).toEqual([...forward].reverse());
    expect(forward.length).toBe(8);
    expect(asRecord(questions['commitment'])['instructions']).toEqual(
      asRecord(questions['commitment_reverse'])['instructions']
    );
  });

  it('agrees when both orders give the same class, confidence being the smaller', async () => {
    const { decider } = harness([classes('PURCHASE', 'PURCHASE')]);
    const { decision, exchange } = succeeded(
      await must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context())
    );
    expect(decision).toEqual({ commitment: 'PURCHASE', confidence: 0.7, agreement: 'agreed' });
    expect(exchange.stage).toBe('commitment');
  });

  it('lets the non-NONE class win when only one order says NONE, and reports the disagreement', async () => {
    for (const [forward, reverse, expected] of [
      ['NONE', 'DELETE', 'DELETE'],
      ['SEND', 'NONE', 'SEND'],
    ] as const) {
      const { decider } = harness([classes(forward, reverse)]);
      const { decision } = succeeded(
        await must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context())
      );
      expect(decision).toEqual({ commitment: expected, confidence: 0.7, agreement: 'disagreed' });
    }
  });

  it('makes two different non-NONE classes OTHER_COMMITMENT', async () => {
    const { decider } = harness([classes('PURCHASE', 'DELETE')]);
    const { decision } = succeeded(
      await must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context())
    );
    expect(decision).toEqual({
      commitment: 'OTHER_COMMITMENT',
      confidence: 0.7,
      agreement: 'disagreed',
      alternatives: ['PURCHASE', 'DELETE'],
    });
  });

  it('accepts NONE from both orders as agreement', async () => {
    const { decider } = harness([classes('NONE', 'NONE')]);
    const { decision } = succeeded(
      await must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context())
    );
    expect(decision).toEqual({ commitment: 'NONE', confidence: 0.7, agreement: 'agreed' });
  });

  it('uses the presence fallback only for diffuse NONE agreement, preserving concrete classes', async () => {
    for (const [forward, reverse, presence, expected] of [
      ['NONE', 'NONE', 'POSSIBLE_COMMITMENT', 'OTHER_COMMITMENT'],
      ['NONE', 'PURCHASE', 'NO_COMMITMENT', 'PURCHASE'],
    ] as const) {
      const { decider } = harness([
        {
          answer: {
            choices: {
              commitment: forward,
              commitment_reverse: reverse,
              commitment_presence: presence,
            },
            confidence: { commitment: 0.4, commitment_reverse: 0.4, commitment_presence: 0.9 },
          },
        },
      ]);
      const result = succeeded(
        await must(decider.classifyCommitment, 'classifier')(commitmentRequest(), context())
      );
      expect(result.decision.commitment).toBe(expected);
    }
    const { decider } = harness([
      {
        answer: {
          choices: {
            commitment: 'NONE',
            commitment_reverse: 'NONE',
            commitment_presence: 'NO_COMMITMENT',
          },
          confidence: { commitment: 0.95, commitment_reverse: 0.95, commitment_presence: 0.2 },
        },
      },
    ]);
    const result = succeeded(
      await must(decider.classifyCommitment, 'classifier')(commitmentRequest(), context())
    );
    expect(result.decision).toEqual({
      commitment: 'NONE',
      confidence: 0.95,
      agreement: 'agreed',
    });
  });

  it('repeats the classification once when only a coin-flip presence answer escalated', async () => {
    const weak = (presence: string, presenceConfidence: number): Step => ({
      answer: {
        choices: {
          commitment: 'NONE',
          commitment_reverse: 'NONE',
          commitment_presence: presence,
        },
        confidence: {
          commitment: 0.4,
          commitment_reverse: 0.4,
          commitment_presence: presenceConfidence,
        },
      },
    });
    for (const [steps, expected, calls] of [
      [[weak('POSSIBLE_COMMITMENT', 0.2), weak('NO_COMMITMENT', 0.8)], 'NONE', 2],
      [
        [weak('POSSIBLE_COMMITMENT', 0.2), weak('POSSIBLE_COMMITMENT', 0.25)],
        'OTHER_COMMITMENT',
        2,
      ],
      [[weak('POSSIBLE_COMMITMENT', 0.9)], 'OTHER_COMMITMENT', 1],
    ] as const) {
      const { decider, http } = harness([...steps]);
      const result = succeeded(
        await must(decider.classifyCommitment, 'classifier')(commitmentRequest(), context())
      );
      expect(result.decision.commitment).toBe(expected);
      expect(http.calls).toHaveLength(calls);
    }
  });

  it('uses the caller commitment floor to decide whether the fallback is applicable', async () => {
    const step: Step = {
      answer: {
        choices: {
          commitment: 'NONE',
          commitment_reverse: 'NONE',
          commitment_presence: 'NO_COMMITMENT',
        },
        confidence: { commitment: 0.8, commitment_reverse: 0.7, commitment_presence: 0.9 },
      },
    };
    for (const [confidenceFloor, expected] of [
      [0.7, 0.7],
      [0.8, 0.9],
    ] as const) {
      const { decider } = harness([step]);
      const result = succeeded(
        await must(decider.classifyCommitment, 'classifier')(
          commitmentRequest({ confidenceFloor }),
          context()
        )
      );
      expect(result.decision.confidence).toBe(expected);
      expect(result.decision.commitment).toBe('NONE');
    }
  });

  it('asks once and reports a single answer when confirmation is off', async () => {
    const { decider, http } = harness(
      [{ answer: { choices: { commitment: 'FORM_SUBMIT' }, confidence: 0.85 } }],
      { confirmCommitment: false }
    );
    const { decision } = succeeded(
      await must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context())
    );
    expect(decision).toEqual({ commitment: 'FORM_SUBMIT', confidence: 0.85, agreement: 'single' });
    expect(Object.keys(asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']))).toEqual([
      'commitment',
    ]);
  });

  it('records the same rotation offset for both orders', async () => {
    const { decider } = harness([classes('NONE', 'NONE')]);
    const { exchange } = succeeded(
      await must(decider.classifyCommitment, 'classifyCommitment')(
        commitmentRequest({ step: 5 }),
        context({ step: 5 })
      )
    );
    expect(exchange.rotations).toEqual({
      commitment: 5,
      commitment_reverse: 5,
      commitment_presence: 1,
    });
  });
});

describe('stage 4: verifyCompletion parse', () => {
  it('derives all unresolved-control receipts from real asked atoms in one call with veto and minimum confidence', async () => {
    const elements = [makeElement({ id: 'u1' }), makeElement({ id: 'u2' })];
    const observation = makeObservation({ elements });
    const unresolvedControls = elements.map(element => ({
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      targetId: element.id,
      signature: element.signature,
    }));
    for (const verdict of ['SATISFIED', 'NOT_SATISFIED', 'UNCERTAIN'] as const) {
      const { decider, http } = harness([
        {
          answer: {
            choices: {
              completion: 'SATISFIED',
              completion_part_2: 'SATISFIED',
              completion_part_3: verdict,
            },
            confidence: { completion: 0.95, completion_part_2: 0.82, completion_part_3: 0.62 },
          },
        },
      ]);
      const result = succeeded(
        await decider.verifyCompletion(
          completionRequest({ observation, unresolvedControls, expectAnswer: false }),
          context()
        )
      );
      expect(http.calls).toHaveLength(1);
      expect(result.decision.verdict).toBe(verdict);
      expect(result.decision.confidence).toBe(0.62);
      expect(result.decision.unresolvedControlStates).toEqual([
        { target: unresolvedControls[0], verdict: 'SATISFIED', confidence: 0.82 },
        { target: unresolvedControls[1], verdict, confidence: 0.62 },
      ]);
      expect(result.exchange.answers?.['completion_part_3']).toEqual({
        choice: verdict,
        confidence: 0.62,
      });
    }
  });

  it('refuses stale, orphan, duplicate and oversized unresolved-ref arrays before transport', async () => {
    const element = makeElement();
    const observation = makeObservation({ elements: [element] });
    const target = {
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      targetId: element.id,
      signature: element.signature,
    };
    const cases = [
      [{ ...target, sessionId: 'stale' }],
      [{ ...target, snapshotId: 'stale' }],
      [{ ...target, signature: 'stale' }],
      [{ ...target, targetId: 'orphan' }],
      [target, target],
      Array.from({ length: TASK_LIMITS.expectedStates + 1 }, () => target),
    ];
    for (const unresolvedControls of cases) {
      const { decider, http } = harness([]);
      const result = failed(
        await decider.verifyCompletion(
          completionRequest({ observation, unresolvedControls }),
          context()
        )
      );
      expect(['INVALID_REQUEST', 'REQUEST_TOO_LARGE']).toContain(result.error.code);
      expect(http.calls).toHaveLength(0);
    }
  });

  it('never substitutes caller context or a missing answer for an unresolved-control proof', async () => {
    const element = makeElement();
    const observation = makeObservation({ elements: [element] });
    const unresolvedControls = [
      {
        sessionId: observation.sessionId,
        snapshotId: observation.snapshotId,
        targetId: element.id,
        signature: element.signature,
      },
    ];
    const request = completionRequest({ observation, unresolvedControls, expectAnswer: false });
    const unoffered = harness([
      {
        answer: {
          choices: { completion: 'SATISFIED', completion_part_2: 'CALLER_CONTEXT_ONLY' },
          confidence: 0.99,
        },
      },
    ]);
    expect(failed(await unoffered.decider.verifyCompletion(request, context())).error.code).toBe(
      'CHOICE_NOT_OFFERED'
    );
    const missing = harness([
      {
        answer: {
          mutate: body => {
            const answers = asRecord(body['answers']);
            delete answers['completion_part_2'];
            return body;
          },
        },
      },
    ]);
    const result = failed(await missing.decider.verifyCompletion(request, context()));
    expect(result.error.code).toBe('INVALID_RESPONSE');
    expect(missing.http.calls).toHaveLength(1);
  });

  it('aggregates actual blank-field omission judgments in the same call at their real confidence', async () => {
    const request = completionRequest({
      expectAnswer: false,
      submittedControls: [
        {
          ledgerSeq: 7,
          origin: FIXTURE_ORIGIN,
          label: 'Actual blank field',
          kind: 'text_input',
          observedEmptyAtSubmission: true,
        },
      ],
    });
    for (const choice of ['NOT_SATISFIED', 'UNCERTAIN', 'SATISFIED'] as const) {
      const { decider, http } = harness([
        {
          answer: {
            choices: { completion: 'SATISFIED', completion_part_2: choice },
            confidence: { completion: 0.95, completion_part_2: 0.61 },
          },
        },
      ]);
      const result = succeeded(await decider.verifyCompletion(request, context()));
      expect(result.decision.verdict).toBe(choice);
      expect(result.decision.confidence).toBe(0.61);
      expect(http.calls).toHaveLength(1);
      const questions = asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']);
      expect(questions['completion_part_2']).toBeDefined();
      expect(result.exchange.answers?.['completion_part_2']?.choice).toBe(choice);
    }
  });

  it('rejects caller-context escape for actual blank-field omission constraints', async () => {
    const request = completionRequest({
      expectAnswer: false,
      submittedControls: [
        {
          ledgerSeq: 7,
          origin: FIXTURE_ORIGIN,
          label: 'Actual blank field',
          kind: 'text_input',
          observedEmptyAtSubmission: true,
        },
      ],
    });
    const { decider } = harness([
      {
        answer: {
          choices: { completion: 'SATISFIED', completion_part_2: 'CALLER_CONTEXT_ONLY' },
          confidence: 0.99,
        },
      },
    ]);
    const result = failed(await decider.verifyCompletion(request, context()));
    expect(result.error.code).toBe('CHOICE_NOT_OFFERED');
  });

  it('uses actual caller-context judgment confidence while retaining operational clause verdicts', async () => {
    const goal = 'This is for a friend, enable the requested option.';
    const { decider } = harness([
      {
        answer: {
          choices: { completion: 'CALLER_CONTEXT_ONLY', completion_part_2: 'SATISFIED' },
          confidence: { completion: 0.94, completion_part_2: 0.87 },
        },
      },
    ]);
    const result = succeeded(
      await decider.verifyCompletion(
        completionRequest({ goal, expectAnswer: false }),
        context({ goal })
      )
    );
    expect(result.decision.verdict).toBe('SATISFIED');
    expect(result.decision.confidence).toBe(0.87);
    expect(result.exchange.answers?.['completion']?.choice).toBe('CALLER_CONTEXT_ONLY');
    const failedConstraint = harness([
      {
        answer: {
          choices: { completion: 'CALLER_CONTEXT_ONLY', completion_part_2: 'NOT_SATISFIED' },
          confidence: 0.9,
        },
      },
    ]);
    const constrained = succeeded(
      await failedConstraint.decider.verifyCompletion(
        completionRequest({ goal, expectAnswer: false }),
        context({ goal })
      )
    );
    expect(constrained.decision.verdict).toBe('NOT_SATISFIED');
  });

  it('rejects caller-context results on informational verification where the choice is not offered', async () => {
    const { decider } = harness([
      { answer: { choices: { completion: 'CALLER_CONTEXT_ONLY' }, confidence: 0.99 } },
    ]);
    const result = failed(
      await decider.verifyCompletion(completionRequest({ expectAnswer: true }), context())
    );
    expect(result.error.code).toBe('CHOICE_NOT_OFFERED');
  });

  it('requires every literal completion clause and preserves the least confidence', async () => {
    const request = completionRequest({
      goal: 'Update my address, keep notifications enabled. Stop before payment.',
      expectAnswer: false,
    });
    for (const choice of ['NOT_SATISFIED', 'UNCERTAIN', 'SATISFIED'] as const) {
      const { decider, http } = harness([
        {
          answer: {
            choices: {
              completion: 'SATISFIED',
              completion_part_2: choice,
              completion_part_3: 'SATISFIED',
            },
            confidence: { completion: 0.95, completion_part_2: 0.7, completion_part_3: 0.8 },
          },
        },
      ]);
      const result = succeeded(
        await decider.verifyCompletion(request, context({ goal: request.goal }))
      );
      expect(result.decision.verdict).toBe(choice);
      expect(result.decision.confidence).toBe(0.7);
      const sent = asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']);
      expect(Object.keys(sent)).toEqual([
        'completion',
        'completion_part_2',
        'completion_part_3',
        'evidence_1',
        'evidence_2',
      ]);
    }
  });

  it('maps the verdict, the answer and the cited evidence ids', async () => {
    const { decider, http } = harness([
      {
        answer: {
          choices: { completion: 'SATISFIED', answer: 'YES', evidence_1: 't3', evidence_2: 't7' },
          confidence: { completion: 0.9, answer: 0.8 },
        },
      },
    ]);
    const { decision, exchange } = succeeded(
      await decider.verifyCompletion(completionRequest(), context())
    );
    expect(decision).toEqual({
      verdict: 'SATISFIED',
      confidence: 0.9,
      evidenceTargetIds: ['t3', 't7'],
      answer: { choice: 'YES', confidence: 0.8 },
    });
    expect(exchange.stage).toBe('completion');
    expect(Object.keys(asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']))).toEqual([
      'completion',
      'answer',
      'evidence_1',
      'evidence_2',
    ]);
  });

  it('deduplicates the evidence ids and removes NONE_APPROPRIATE', async () => {
    const same = harness([
      { answer: { choices: { completion: 'NOT_SATISFIED', evidence_1: 't3', evidence_2: 't3' } } },
    ]);
    expect(
      succeeded(await same.decider.verifyCompletion(completionRequest(), context())).decision
        .evidenceTargetIds
    ).toEqual(['t3']);
    const none = harness([
      {
        answer: {
          choices: { completion: 'UNCERTAIN', evidence_1: TASK_NONE_APPROPRIATE, evidence_2: 't4' },
        },
      },
    ]);
    expect(
      succeeded(await none.decider.verifyCompletion(completionRequest(), context())).decision
        .evidenceTargetIds
    ).toEqual(['t4']);
    const nothing = harness([
      {
        answer: {
          choices: {
            completion: 'UNCERTAIN',
            evidence_1: TASK_NONE_APPROPRIATE,
            evidence_2: TASK_NONE_APPROPRIATE,
          },
        },
      },
    ]);
    expect(
      succeeded(await nothing.decider.verifyCompletion(completionRequest(), context())).decision
        .evidenceTargetIds
    ).toEqual([]);
  });

  it('cites collected evidence ids and honours the configured number of evidence questions', async () => {
    const request = completionRequest({
      collectedEvidence: [
        {
          id: 'e1',
          ledgerSeq: 1,
          url: `${FIXTURE_ORIGIN}/help`,
          label: 'Shipping',
          text: 'Two days.',
        },
      ],
    });
    const { decider, http } = harness(
      [
        {
          answer: {
            choices: {
              completion: 'SATISFIED',
              evidence_1: 'e1',
              evidence_2: 't3',
              evidence_3: 't4',
            },
          },
        },
      ],
      { evidenceQuestions: 3 }
    );
    const { decision } = succeeded(await decider.verifyCompletion(request, context()));
    expect(decision.evidenceTargetIds).toEqual(['e1', 't3', 't4']);
    expect(
      Object.keys(asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']))
    ).toContain('evidence_3');
  });

  it('asks no answer question, and returns none, when no answer is expected', async () => {
    const { decider, http } = harness([
      { answer: { choices: { completion: 'SATISFIED', evidence_1: 't3', evidence_2: 't3' } } },
    ]);
    const { decision } = succeeded(
      await decider.verifyCompletion(completionRequest({ expectAnswer: false }), context())
    );
    expect(decision.answer).toBeUndefined();
    expect(
      Object.keys(asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']))
    ).not.toContain('answer');
  });
});

// ---------------------------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------------------------

describe('response validation', () => {
  const argumentWith = async (options: AnswerOptions): Promise<TaskDeciderResult<unknown>> => {
    const { decider } = harness([{ answer: { choices: { argument: 'c1' }, ...options } }]);
    return decider.chooseArgument(argumentRequest(), context());
  };
  const editAnswer =
    (edit: (answer: Record<string, unknown>) => void) => (body: Record<string, unknown>) => {
      edit(asRecord(asRecord(body['answers'])['argument']));
      return body;
    };
  const probabilitiesOf = (answer: Record<string, unknown>): Record<string, unknown> =>
    asRecord(answer['probabilities']);

  it('accepts probabilities in any key order, and ignores unknown extra fields', async () => {
    const result = await argumentWith({
      mutate: body => ({
        ...body,
        extra: { anything: ECHO },
        answers: {
          argument: {
            ...asRecord(asRecord(body['answers'])['argument']),
            note: 'ignored',
            probabilities: Object.fromEntries(
              Object.entries(
                probabilitiesOf(asRecord(asRecord(body['answers'])['argument']))
              ).reverse()
            ),
          },
          unrelated: { choice: 'x' },
        },
      }),
    });
    expect(succeeded(result).decision).toEqual({
      kind: 'candidate',
      candidateId: 'c1',
      confidence: 1,
    });
  });

  it.each([
    [
      'a probability key missing',
      (a: Record<string, unknown>) => {
        delete probabilitiesOf(a)['c2'];
      },
    ],
    [
      'an unknown probability key',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c9'] = 0;
      },
    ],
    [
      'a negative probability',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c2'] = -0.5;
        probabilitiesOf(a)['c1'] = 1.5;
      },
    ],
    [
      'a probability above one',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c1'] = 1.2;
      },
    ],
    [
      'a string probability',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c2'] = '0';
      },
    ],
    [
      'probabilities summing to 0.5',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c1'] = 0.5;
      },
    ],
    [
      'probabilities summing to 1.021',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c1'] = 1;
        probabilitiesOf(a)['c2'] = 0.021;
      },
    ],
    [
      'probabilities summing to 0.979',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c1'] = 0.979;
      },
    ],
    [
      'a choice that is not the argmax',
      (a: Record<string, unknown>) => {
        probabilitiesOf(a)['c1'] = 0.2;
        probabilitiesOf(a)['c2'] = 0.8;
      },
    ],
    [
      'probabilities that are not an object',
      (a: Record<string, unknown>) => {
        a['probabilities'] = [1, 0];
      },
    ],
    [
      'missing probabilities',
      (a: Record<string, unknown>) => {
        delete a['probabilities'];
      },
    ],
    [
      'a confidence above one',
      (a: Record<string, unknown>) => {
        a['confidence'] = 1.2;
      },
    ],
    [
      'a negative confidence',
      (a: Record<string, unknown>) => {
        a['confidence'] = -0.1;
      },
    ],
    [
      'a string confidence',
      (a: Record<string, unknown>) => {
        a['confidence'] = 'high';
      },
    ],
    [
      'a null confidence',
      (a: Record<string, unknown>) => {
        a['confidence'] = null;
      },
    ],
    [
      'missing confidence',
      (a: Record<string, unknown>) => {
        delete a['confidence'];
      },
    ],
    [
      'a numeric choice',
      (a: Record<string, unknown>) => {
        a['choice'] = 1;
      },
    ],
    [
      'a missing choice',
      (a: Record<string, unknown>) => {
        delete a['choice'];
      },
    ],
  ])('is INVALID_RESPONSE for %s', async (_name, edit) => {
    const result = failed(await argumentWith({ mutate: editAnswer(edit) }));
    expect(result.error.code).toBe('INVALID_RESPONSE');
    expect(result.error.retryable).toBe(false);
    expect(result.exchange?.error).toBe(result.error.message);
    expect(result.exchange?.httpStatus).toBe(200);
    expect(result.exchange?.answers).toBeUndefined();
  });

  it('draws the sum tolerance at 0.02: 1.019 and 0.981 pass, 1.021 and 0.979 do not', async () => {
    const passes = async (c1: number, c2: number): Promise<boolean> => {
      const result = await argumentWith({
        mutate: editAnswer(a => {
          probabilitiesOf(a)['c1'] = c1;
          probabilitiesOf(a)['c2'] = c2;
        }),
      });
      return result.ok;
    };
    expect(await passes(1, 0.019)).toBe(true);
    expect(await passes(0.981, 0)).toBe(true);
    expect(await passes(1, 0.021)).toBe(false);
    expect(await passes(0.979, 0)).toBe(false);
  });

  it('draws the argmax tolerance at 1e-6: a tie passes, a clear loser does not', async () => {
    const tie = await argumentWith({
      mutate: editAnswer(a => {
        probabilitiesOf(a)['c1'] = 0.5;
        probabilitiesOf(a)['c2'] = 0.5;
      }),
    });
    expect(tie.ok).toBe(true);
    const loser = await argumentWith({
      mutate: editAnswer(a => {
        probabilitiesOf(a)['c1'] = 0.49;
        probabilitiesOf(a)['c2'] = 0.51;
      }),
    });
    expect(failed(loser).error.code).toBe('INVALID_RESPONSE');
  });

  it('is CHOICE_NOT_OFFERED for a choice outside the asked criteria, inherited property names included', async () => {
    for (const choice of ['c9', 'constructor', '__proto__', 'toString', 'NONE']) {
      const result = failed(
        await argumentWith({
          mutate: editAnswer(a => {
            a['choice'] = choice;
          }),
        })
      );
      expect(result.error.code).toBe('CHOICE_NOT_OFFERED');
      expect(result.error.retryable).toBe(false);
    }
    const operation = harness([{ answer: { choices: { operation: 'PRESS' } } }]);
    expect(
      failed(await operation.decider.chooseAction(actionRequest(), context())).error.code
    ).toBe('CHOICE_NOT_OFFERED');
  });

  it('is INVALID_RESPONSE when an asked question has no answer, or the answers are not an object', async () => {
    for (const mutate of [
      (body: Record<string, unknown>) => ({ ...body, answers: {} }),
      (body: Record<string, unknown>) => ({ ...body, answers: [] }),
      (body: Record<string, unknown>) => ({ ...body, answers: null }),
      (body: Record<string, unknown>) => ({ ...body, answers: 'text' }),
      (body: Record<string, unknown>) => ({ model: body['model'], usage: body['usage'] }),
      () => [],
      () => ({}),
    ]) {
      const result = failed(await argumentWith({ mutate }));
      expect(result.error.code).toBe('INVALID_RESPONSE');
    }
  });

  it('is INVALID_RESPONSE for a model without the jev- prefix, or a missing or non-string model', async () => {
    for (const model of [
      'gpt-4o',
      'claude-3',
      'JEV-1.13.0',
      '',
      ' jev-1',
      42,
      null,
      undefined,
      { name: 'jev-1' },
    ]) {
      const result = failed(await argumentWith({ model }));
      expect(result.error.code).toBe('INVALID_RESPONSE');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('accepts exactly the families in allowedModelPrefixes, which replace the default', async () => {
    const answeredBy = async (model: string, prefixes: readonly string[]) => {
      const { decider } = harness([{ answer: { choices: { argument: 'c1' }, model } }], {
        allowedModelPrefixes: prefixes,
      });
      return decider.chooseArgument(argumentRequest(), context());
    };
    expect(succeeded(await answeredBy('xor-1.1', ['xor-'])).exchange.model).toBe('xor-1.1');
    succeeded(await answeredBy('jev-1.13.0', ['xor-', 'jev-']));
    succeeded(await answeredBy('xor-1.1', ['xor-', 'jev-']));
    succeeded(await answeredBy('ab-1', ['ab-']));
    const longest = `${'a'.repeat(63)}-`;
    succeeded(await answeredBy(`${longest}1`, [longest]));
    for (const [model, prefixes] of [
      ['jev-1.13.0', ['xor-']],
      ['XOR-1.1', ['xor-']],
      ['xor1.1', ['xor-']],
      ['gpt-4o', ['xor-', 'jev-']],
    ] as const) {
      const result = failed(await answeredBy(model, prefixes));
      expect(result.error.code).toBe('INVALID_RESPONSE');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('accepts a namespaced prefix while retaining exact family matching', async () => {
    const { decider, http } = harness(
      [
        { answer: { choices: { argument: 'c1' }, model: 'org/model-1' } },
        { answer: { choices: { argument: 'c1' }, model: 'other/model-1' } },
      ],
      { allowedModelPrefixes: ['org/model-'] }
    );
    expect(
      succeeded(await decider.chooseArgument(argumentRequest(), context())).exchange.model
    ).toBe('org/model-1');
    expect(failed(await decider.chooseArgument(argumentRequest(), context())).error.code).toBe(
      'INVALID_RESPONSE'
    );
    expect(http.calls).toHaveLength(2);
  });

  it('refuses every call, sending nothing, when allowedModelPrefixes is not valid', async () => {
    const invalid: readonly unknown[] = [
      [],
      [''],
      ['x'],
      ['x-'],
      ['xor'],
      [' xor-'],
      ['xor- '],
      ['xor-', 5],
      ['xor-', null],
      ['étude-'],
      ['org/model name-'],
      ['/org/model-'],
      [`${'a'.repeat(64)}-`],
      Array.from({ length: 9 }, (_, index) => `m${String(index)}-`),
      'xor-',
      null,
    ];
    for (const prefixes of invalid) {
      const { decider, http } = harness([ANSWER_CLICK], {
        allowedModelPrefixes: prefixes as readonly string[],
      });
      const result = failed(await decider.chooseArgument(argumentRequest(), context()));
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.retryable).toBe(false);
      expect(http.calls.length).toBe(0);
    }
  });

  it('copies allowedModelPrefixes at construction, so a later edit cannot widen it', async () => {
    const prefixes = ['jev-'];
    const { decider } = harness([{ answer: { choices: { argument: 'c1' }, model: 'xor-1.1' } }], {
      allowedModelPrefixes: prefixes,
    });
    prefixes.push('xor-');
    const result = failed(await decider.chooseArgument(argumentRequest(), context()));
    expect(result.error.code).toBe('INVALID_RESPONSE');
  });

  it('records the resolved versioned model, never the requested alias', async () => {
    const { decider } = harness([{ answer: { choices: { argument: 'c1' }, model: 'jev-1.13.0' } }]);
    const { exchange } = succeeded(await decider.chooseArgument(argumentRequest(), context()));
    expect(exchange.requestedModel).toBe('jev-latest');
    expect(exchange.model).toBe('jev-1.13.0');
    const pinned = harness([{ answer: { choices: { argument: 'c1' }, model: 'jev-1.13.0' } }], {
      model: 'jev-1.13.0',
    });
    const second = succeeded(await pinned.decider.chooseArgument(argumentRequest(), context()));
    expect(second.exchange.requestedModel).toBe('jev-1.13.0');
    expect(parseBody(callOf(pinned.http.calls, 0).init.body)['model']).toBe('jev-1.13.0');
  });

  it('is INVALID_RESPONSE, without a retry, when the body is not JSON', async () => {
    const { decider, http, sleeps } = harness([{ respond: 200, jsonThrows: true }]);
    const result = failed(await decider.chooseArgument(argumentRequest(), context()));
    expect(result.error.code).toBe('INVALID_RESPONSE');
    expect(http.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(ECHO);
  });

  it('captures usage and ignores a malformed usage block', async () => {
    const good = harness([
      {
        answer: { choices: { argument: 'c1' }, usage: { input_tokens: 21271, output_tokens: 42 } },
      },
    ]);
    expect(
      succeeded(await good.decider.chooseArgument(argumentRequest(), context())).exchange.usage
    ).toEqual({
      inputTokens: 21271,
      outputTokens: 42,
    });
    for (const usage of [
      undefined,
      null,
      'x',
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 'a' },
      [],
    ]) {
      const bad = harness([{ answer: { choices: { argument: 'c1' }, usage } }]);
      const { exchange } = succeeded(
        await bad.decider.chooseArgument(argumentRequest(), context())
      );
      expect(exchange.usage).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Errors, retry, backoff
// ---------------------------------------------------------------------------------------------

describe('HTTP error mapping', () => {
  const echoBody = (detail: unknown): unknown => ({
    detail,
    input: { state: { page: { text: ECHO } } },
  });

  it.each([
    [401, 'UNAUTHORIZED', false, 1],
    [403, 'UNAUTHORIZED', false, 1],
    [408, 'TIMEOUT', true, 3],
    [429, 'RATE_LIMITED', true, 3],
    [500, 'HTTP_ERROR', true, 3],
    [502, 'HTTP_ERROR', true, 3],
    [503, 'HTTP_ERROR', true, 3],
    [529, 'HTTP_ERROR', true, 3],
    [599, 'HTTP_ERROR', true, 3],
    [400, 'INVALID_REQUEST', false, 1],
    [404, 'INVALID_REQUEST', false, 1],
    [409, 'INVALID_REQUEST', false, 1],
    [413, 'INVALID_REQUEST', false, 1],
    [422, 'INVALID_REQUEST', false, 1],
  ] as const)(
    'maps %i to %s (retryable %s) with %i call(s)',
    async (status, code, retryable, calls) => {
      const { decider, http } = harness([{ respond: status, body: echoBody('whatever') }]);
      const result = failed(await decider.chooseAction(actionRequest(), context()));
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(retryable);
      expect(result.error.status).toBe(status);
      expect(result.error.message).toContain(String(status));
      expect(http.calls.length).toBe(calls);
      expect(result.exchange?.attempts).toBe(calls);
      expect(result.exchange?.httpStatus).toBe(status);
      expect(JSON.stringify(result)).not.toContain(ECHO);
    }
  );

  it('never retries 400, 401, 403 or 422, however often the policy would allow', async () => {
    for (const status of [400, 401, 403, 422, 404]) {
      const { decider, http, sleeps } = harness([{ respond: status, body: {} }], {
        retry: { maxRetries: 9 },
      });
      await decider.chooseAction(actionRequest(), context());
      expect(http.calls.length).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('maps a 422 with an array detail without echoing any of it', async () => {
    const detail = [
      { type: 'missing', loc: ['body', 'state'], msg: 'Field required', input: { page: ECHO } },
    ];
    const { decider } = harness([
      { respond: 422, body: { detail }, headers: { 'x-typesafe-request-id': REQUEST_ID } },
    ]);
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(result.error.message).toContain('422');
    expect(result.error.message).toContain(REQUEST_ID);
    expect(result.error.message).not.toContain('Field required');
    expect(JSON.stringify(result)).not.toContain(ECHO);
  });

  it('maps 400 max_tokens_exceeded to REQUEST_TOO_LARGE without a retry', async () => {
    const { decider, http, sleeps } = harness([
      { respond: 400, body: { detail: { error_type: 'max_tokens_exceeded' } } },
    ]);
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('REQUEST_TOO_LARGE');
    expect(result.error.retryable).toBe(false);
    expect(result.error.status).toBe(400);
    expect(http.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('names the question a string detail points at, and only if it was asked', async () => {
    const named = harness([
      {
        respond: 400,
        body: { detail: 'Choice question must have at least one choice: fill_target' },
      },
    ]);
    const first = failed(await named.decider.chooseAction(actionRequest(), context()));
    expect(first.error.code).toBe('INVALID_REQUEST');
    expect(first.error.message).toContain('fill_target');
    const foreign = harness([
      { respond: 400, body: { detail: `Choice question must have at least one choice: ${ECHO}` } },
    ]);
    const second = failed(await foreign.decider.chooseAction(actionRequest(), context()));
    expect(second.error.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(second)).not.toContain(ECHO);
  });

  it('puts a known error_type into the message and drops an unknown one', async () => {
    const known = harness([
      {
        respond: 400,
        body: { detail: { error_type: 'api_usage_error', message: `Invalid request. ${ECHO}` } },
      },
    ]);
    const first = failed(await known.decider.chooseAction(actionRequest(), context()));
    expect(first.error.code).toBe('INVALID_REQUEST');
    expect(first.error.message).toContain('api_usage_error');
    expect(first.error.message).not.toContain(ECHO);
    const unknown = harness([{ respond: 400, body: { detail: { error_type: ECHO } } }]);
    const second = failed(await unknown.decider.chooseAction(actionRequest(), context()));
    expect(JSON.stringify(second)).not.toContain(ECHO);
  });

  it('survives error bodies of every shape, a response without a body, and a throwing header reader', async () => {
    for (const body of [
      null,
      'text',
      42,
      [],
      [ECHO],
      { detail: null },
      { detail: 5 },
      { detail: [null, 1] },
    ]) {
      const { decider } = harness([{ respond: 400, body }]);
      const result = failed(await decider.chooseAction(actionRequest(), context()));
      expect(result.error.code).toBe('INVALID_REQUEST');
    }
    const brokenBody = harness([{ respond: 422, jsonThrows: true }]);
    expect(
      failed(await brokenBody.decider.chooseAction(actionRequest(), context())).error.code
    ).toBe('INVALID_REQUEST');
    const http: TaskHttp = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        header: () => {
          throw new Error(`header failure ${KEY}`);
        },
        json: () => Promise.resolve({}),
      });
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http,
      sleep: () => Promise.resolve(),
    });
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('HTTP_ERROR');
    expect(leaks(result)).toBe(false);
  });

  it('treats a response that is not an object as INVALID_RESPONSE', async () => {
    for (const response of [undefined, null, 'ok', 7]) {
      const http = (() => Promise.resolve(response)) as unknown as TaskHttp;
      const decider = createTypeSafeTaskDecider({ apiKey: KEY, http });
      const result = failed(await decider.chooseAction(actionRequest(), context()));
      expect(result.error.code).toBe('INVALID_RESPONSE');
    }
  });

  it('treats a redirect or informational status as a non-retryable HTTP_ERROR', async () => {
    for (const status of [301, 302, 304, 100]) {
      const { decider, http } = harness([{ respond: status, body: {} }]);
      const result = failed(await decider.chooseAction(actionRequest(), context()));
      expect(result.error.code).toBe('HTTP_ERROR');
      expect(result.error.retryable).toBe(false);
      expect(http.calls.length).toBe(1);
    }
  });
});

describe('retry and backoff', () => {
  it('retries a 503 once and succeeds, recording both attempts', async () => {
    const { decider, http, sleeps } = harness([
      { respond: 503, body: {}, headers: { 'x-typesafe-request-id': 'req_first' } },
      {
        answer: {
          choices: { operation: 'CLICK', click_target: 't1' },
          headers: { 'x-typesafe-request-id': 'req_second' },
        },
      },
    ]);
    const { exchange } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(http.calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(exchange.attempts).toBe(2);
    expect(exchange.attemptLog).toEqual([
      {
        attempt: 1,
        status: 503,
        latencyMs: 5,
        requestId: 'req_first',
        errorCode: 'HTTP_ERROR',
        delayMs: 500,
      },
      { attempt: 2, status: 200, latencyMs: 5, requestId: 'req_second' },
    ]);
    expect(exchange.requestId).toBe('req_second');
    expect(exchange.httpStatus).toBe(200);
  });

  it('makes at most two retries by default: three calls, delays 500 and 1000', async () => {
    const { decider, http, sleeps } = harness([{ respond: 500, body: {} }]);
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(http.calls.length).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(result.exchange?.attemptLog.map(attempt => attempt.delayMs)).toEqual([
      500,
      1000,
      undefined,
    ]);
    expect(result.exchange?.attempts).toBe(3);
  });

  it('honours maxRetries, including 0', async () => {
    for (const [maxRetries, calls] of [
      [0, 1],
      [1, 2],
      [4, 5],
    ] as const) {
      const { decider, http } = harness([{ respond: 500, body: {} }], { retry: { maxRetries } });
      await decider.chooseAction(actionRequest(), context());
      expect(http.calls.length).toBe(calls);
    }
  });

  it('subtracts up to 25 percent jitter from the injected random', async () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { decider, sleeps } = harness([{ respond: 500, body: {} }], {}, () => random);
      await decider.chooseAction(actionRequest(), context());
      expect(sleeps).toEqual([500 - 500 * 0.25 * random, 1000 - 1000 * 0.25 * random]);
      for (const [index, delay] of sleeps.entries()) {
        const base = 500 * 2 ** index;
        expect(delay).toBeGreaterThanOrEqual(base * 0.75);
        expect(delay).toBeLessThanOrEqual(base);
      }
    }
  });

  it('doubles from 0.5 s and caps at 5 s', async () => {
    const { decider, sleeps } = harness([{ respond: 500, body: {} }], { retry: { maxRetries: 6 } });
    await decider.chooseAction(actionRequest(), context());
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  it('takes the policy from the config', async () => {
    const { decider, sleeps } = harness([{ respond: 500, body: {} }], {
      retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 250, jitter: 0 },
    });
    await decider.chooseAction(actionRequest(), context());
    expect(sleeps).toEqual([100, 200, 250]);
  });

  it('survives nonsense in the retry config by falling back to the defaults', async () => {
    const { decider, sleeps, http } = harness([{ respond: 500, body: {} }], {
      retry: {
        maxRetries: Number.NaN,
        baseDelayMs: -5,
        maxDelayMs: Number.NaN,
        jitter: 7,
        maxRetryAfterMs: -1,
      },
    });
    await decider.chooseAction(actionRequest(), context());
    expect(http.calls.length).toBe(3);
    for (const [index, delay] of sleeps.entries()) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(500 * 2 ** index);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('honours Retry-After in seconds up to 60 seconds', async () => {
    const cases: readonly (readonly [string, number])[] = [
      ['3', 3000],
      ['0', 0],
      ['59', 59000],
      ['60', 60000],
      ['120', 60000],
      ['1.5', 1500],
    ];
    for (const [header, expected] of cases) {
      const { decider, sleeps } = harness([
        { respond: 429, body: {}, headers: { 'Retry-After': header } },
        ANSWER_CLICK,
      ]);
      succeeded(await decider.chooseAction(actionRequest(), context()));
      expect(sleeps).toEqual([expected]);
    }
  });

  it('prefers retry-after-ms, and caps it too', async () => {
    const both = harness([
      { respond: 503, body: {}, headers: { 'retry-after-ms': '250', 'retry-after': '9' } },
      ANSWER_CLICK,
    ]);
    succeeded(await both.decider.chooseAction(actionRequest(), context()));
    expect(both.sleeps).toEqual([250]);
    const capped = harness([
      { respond: 503, body: {}, headers: { 'retry-after-ms': '900000' } },
      ANSWER_CLICK,
    ]);
    succeeded(await capped.decider.chooseAction(actionRequest(), context()));
    expect(capped.sleeps).toEqual([60000]);
  });

  it('caps Retry-After at the configured maximum', async () => {
    const { decider, sleeps } = harness(
      [{ respond: 429, body: {}, headers: { 'retry-after': '5' } }, ANSWER_CLICK],
      { retry: { maxRetryAfterMs: 1000 } }
    );
    succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(sleeps).toEqual([1000]);
  });

  it('falls back to the backoff for an unusable Retry-After', async () => {
    for (const header of ['soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '-3', '', 'NaN', 'Infinity']) {
      const { decider, sleeps } = harness([
        { respond: 429, body: {}, headers: { 'retry-after': header } },
        ANSWER_CLICK,
      ]);
      succeeded(await decider.chooseAction(actionRequest(), context()));
      expect(sleeps).toEqual([500]);
    }
  });

  it('retries 408 and network failures, then succeeds', async () => {
    const timeout = harness([{ respond: 408, body: {} }, ANSWER_CLICK]);
    succeeded(await timeout.decider.chooseAction(actionRequest(), context()));
    expect(timeout.http.calls.length).toBe(2);
    const network = harness([
      { throws: new TypeError('fetch failed') },
      { throws: new TypeError('fetch failed') },
      ANSWER_CLICK,
    ]);
    const { exchange } = succeeded(await network.decider.chooseAction(actionRequest(), context()));
    expect(network.http.calls.length).toBe(3);
    expect(exchange.attemptLog.map(attempt => attempt.errorCode)).toEqual([
      'NETWORK',
      'NETWORK',
      undefined,
    ]);
    expect(exchange.attemptLog.map(attempt => attempt.status)).toEqual([undefined, undefined, 200]);
  });

  it('gives up on persistent network failure as NETWORK, retryable, after three calls', async () => {
    const { decider, http } = harness([{ throws: new TypeError('fetch failed') }]);
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error).toEqual(expect.objectContaining({ code: 'NETWORK', retryable: true }));
    expect(result.error.status).toBeUndefined();
    expect(http.calls.length).toBe(3);
  });

  it('passes the caller signal to every sleep', async () => {
    const controller = new AbortController();
    const { decider, sleepSignals } = harness([{ respond: 500, body: {} }]);
    await decider.chooseAction(actionRequest(), context({ signal: controller.signal }));
    expect(sleepSignals.length).toBe(2);
    expect(sleepSignals.every(signal => signal === controller.signal)).toBe(true);
  });

  it('uses the real default sleep and random when none are injected', async () => {
    const http = fakeHttp([{ respond: 503, body: {} }, ANSWER_CLICK]);
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http: http.fn,
      retry: { baseDelayMs: 1, maxDelayMs: 2, jitter: 0.25 },
    });
    const started = Date.now();
    succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(http.calls.length).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('attemptLog, exchange telemetry', () => {
  it('records status, latency, request id, error code and delay for every attempt', async () => {
    const { decider } = harness([
      {
        respond: 429,
        body: {},
        headers: { 'x-typesafe-request-id': 'req_aaa', 'retry-after': '2' },
      },
      { respond: 503, body: {}, headers: { 'x-typesafe-request-id': 'req_bbb' } },
      {
        answer: {
          choices: { operation: 'CLICK', click_target: 't1' },
          headers: { 'x-typesafe-request-id': 'req_ccc' },
        },
      },
    ]);
    const { exchange } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(exchange.attemptLog).toEqual([
      {
        attempt: 1,
        status: 429,
        latencyMs: 5,
        requestId: 'req_aaa',
        errorCode: 'RATE_LIMITED',
        delayMs: 2000,
      },
      {
        attempt: 2,
        status: 503,
        latencyMs: 5,
        requestId: 'req_bbb',
        errorCode: 'HTTP_ERROR',
        delayMs: 1000,
      },
      { attempt: 3, status: 200, latencyMs: 5, requestId: 'req_ccc' },
    ]);
    expect(exchange.attempts).toBe(exchange.attemptLog.length);
    expect(exchange.requestId).toBe('req_ccc');
    expect(exchange.latencyMs).toBeGreaterThan(0);
    expect(exchange.provider).toBe('typesafe');
  });

  it('captures the x-typesafe-request-id header on success and failure, and drops one that is not an id', async () => {
    const ok = harness([
      {
        answer: {
          choices: { operation: 'CLICK', click_target: 't1' },
          headers: { 'X-TypeSafe-Request-Id': REQUEST_ID },
        },
      },
    ]);
    expect(
      succeeded(await ok.decider.chooseAction(actionRequest(), context())).exchange.requestId
    ).toBe(REQUEST_ID);
    const bad = harness([
      { respond: 401, body: {}, headers: { 'x-typesafe-request-id': REQUEST_ID } },
    ]);
    expect(
      failed(await bad.decider.chooseAction(actionRequest(), context())).exchange?.requestId
    ).toBe(REQUEST_ID);
    for (const header of [
      'has spaces',
      `evil\nheader`,
      'x'.repeat(200),
      `<script>`,
      ECHO + ' ' + KEY,
    ]) {
      const odd = harness([
        {
          answer: {
            choices: { operation: 'CLICK', click_target: 't1' },
            headers: { 'x-typesafe-request-id': header },
          },
        },
      ]);
      const { exchange } = succeeded(await odd.decider.chooseAction(actionRequest(), context()));
      expect(exchange.requestId).toBeUndefined();
      expect(JSON.stringify(exchange)).not.toContain(header);
    }
  });

  it('records requestBytes, estimatedInputTokens, goalVerified and the offsets it sent', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    const request = actionRequest({ step: 3 });
    const { exchange } = succeeded(await decider.chooseAction(request, context({ step: 3 })));
    const sent = callOf(http.calls, 0).init.body;
    expect(exchange.requestBytes).toBe(Buffer.byteLength(sent, 'utf8'));
    expect(exchange.estimatedInputTokens).toBe(estimateRequestTokens(exchange.requestBytes));
    expect(exchange.estimatedInputTokens).toBe(Math.ceil(exchange.requestBytes / 1.9));
    expect(exchange.goalVerified).toBe(true);
    const parsed = parseBody(sent);
    const expectedSet = buildActionQuestions(request);
    expect(exchange.requestBytes).toBe(estimateRequestBytes(expectedSet, 'jev-latest'));
    expect(exchange.rotations).toEqual(
      questionRotations(
        { stage: 'action', state: expectedSet.state, questions: expectedSet.questions },
        3,
        true
      )
    );
    expect(Object.keys(exchange.rotations ?? {})).toEqual(
      Object.keys(asRecord(parsed['questions']))
    );
    expect(exchange.rotations?.['operation']).toBe(3 % 4);
    expect(exchange.request).toBeUndefined();
  });

  it('records offsets of 0 when rotation is off, and still sends criteria in page order', async () => {
    const { decider, http } = harness([ANSWER_CLICK], { rotateOptions: false });
    const { exchange } = succeeded(
      await decider.chooseAction(actionRequest({ step: 3 }), context({ step: 3 }))
    );
    for (const offset of Object.values(exchange.rotations ?? {})) {
      expect(offset).toBe(0);
    }
    const questions = asRecord(parseBody(callOf(http.calls, 0).init.body)['questions']);
    expect(Object.keys(asRecord(asRecord(questions['fill_target'])['criteria']))).toEqual([
      't3',
      't8',
      TASK_NONE_APPROPRIATE,
    ]);
  });

  it('records every stage, requested model and byte estimate on a failure that happened after the request was built', async () => {
    const { decider } = harness([{ respond: 401, body: {} }]);
    const { exchange } = failed(await decider.chooseAction(actionRequest(), context()));
    const kept = must(exchange, 'exchange');
    expect(kept.stage).toBe('action');
    expect(kept.requestedModel).toBe('jev-latest');
    expect(kept.requestBytes).toBeGreaterThan(0);
    expect(kept.estimatedInputTokens).toBeGreaterThan(0);
    expect(kept.goalVerified).toBe(true);
    expect(kept.error).toContain('401');
    expect(kept.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Abort and timeout
// ---------------------------------------------------------------------------------------------

describe('abort and timeout', () => {
  it('is CANCELLED without a call when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { decider, http } = harness([ANSWER_CLICK]);
    const result = failed(
      await decider.chooseAction(actionRequest(), context({ signal: controller.signal }))
    );
    expect(result.error.code).toBe('CANCELLED');
    expect(result.error.retryable).toBe(false);
    expect(http.calls.length).toBe(0);
  });

  it('is CANCELLED, once, when the caller aborts mid-flight, even if the transport ignores the signal', async () => {
    const controller = new AbortController();
    const { decider, http, sleeps } = harness([{ hang: true }]);
    setTimeout(() => controller.abort(), 15);
    const started = Date.now();
    const result = failed(
      await decider.chooseAction(actionRequest(), context({ signal: controller.signal }))
    );
    expect(result.error.code).toBe('CANCELLED');
    expect(result.error.retryable).toBe(false);
    expect(http.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(callOf(http.calls, 0).init.signal?.aborted).toBe(true);
  });

  it('is CANCELLED when the transport rejects because the signal aborted', async () => {
    const controller = new AbortController();
    const http: TaskHttp = (_url, init) =>
      new Promise<TaskHttpResponse>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMExceptionLike()), {
          once: true,
        });
      });
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http,
      sleep: () => Promise.resolve(),
    });
    setTimeout(() => controller.abort(), 10);
    const result = failed(
      await decider.chooseAction(actionRequest(), context({ signal: controller.signal }))
    );
    expect(result.error.code).toBe('CANCELLED');
  });

  it('stops retrying when the caller aborts during the backoff', async () => {
    const controller = new AbortController();
    const http = fakeHttp([{ respond: 503, body: {} }]);
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http: http.fn,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    const result = failed(
      await decider.chooseAction(actionRequest(), context({ signal: controller.signal }))
    );
    expect(result.error.code).toBe('CANCELLED');
    expect(http.calls.length).toBe(1);
  });

  it('times out a hung attempt with TIMEOUT, retries it, and succeeds when the next attempt answers', async () => {
    const { decider, http, sleeps } = harness([{ hang: true }, ANSWER_CLICK], { timeoutMs: 20 });
    const { exchange } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(http.calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(exchange.attemptLog[0]).toEqual(
      expect.objectContaining({ attempt: 1, errorCode: 'TIMEOUT', delayMs: 500 })
    );
    expect(exchange.attemptLog[0]?.status).toBeUndefined();
    expect(callOf(http.calls, 0).init.signal?.aborted).toBe(true);
    expect(callOf(http.calls, 1).init.signal?.aborted).toBe(false);
  });

  it('returns TIMEOUT, retryable, after three timed-out attempts; a caller abort is never retried', async () => {
    const timedOut = harness([{ hang: true }], { timeoutMs: 15 });
    const result = failed(await timedOut.decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('TIMEOUT');
    expect(result.error.retryable).toBe(true);
    expect(timedOut.http.calls.length).toBe(3);
    const controller = new AbortController();
    const aborted = harness([{ hang: true }], { timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 10);
    const cancelled = failed(
      await aborted.decider.chooseAction(actionRequest(), context({ signal: controller.signal }))
    );
    expect(cancelled.error.code).toBe('CANCELLED');
    expect(aborted.http.calls.length).toBe(1);
  });

  it('applies the per-call timeout to reading the body as well', async () => {
    const http: TaskHttp = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        header: () => null,
        json: () => new Promise<unknown>(() => undefined),
      });
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http,
      timeoutMs: 15,
      retry: { maxRetries: 0 },
    });
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('TIMEOUT');
  });

  it('gives every request a signal and a positive timeout, the default being 20 s', async () => {
    const defaults = harness([ANSWER_CLICK]);
    await defaults.decider.chooseAction(actionRequest(), context());
    const init = callOf(defaults.http.calls, 0).init;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.timeoutMs).toBe(TASK_TYPESAFE_DEFAULTS.timeoutMs);
    expect(init.timeoutMs).toBe(20000);
    const custom = harness([ANSWER_CLICK], { timeoutMs: 1234 });
    await custom.decider.chooseAction(actionRequest(), context());
    expect(callOf(custom.http.calls, 0).init.timeoutMs).toBe(1234);
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const odd = harness([ANSWER_CLICK], { timeoutMs });
      await odd.decider.chooseAction(actionRequest(), context());
      expect(callOf(odd.http.calls, 0).init.timeoutMs).toBe(20000);
    }
  });

  it('joins the caller signal with the per-attempt one: every attempt has a fresh signal', async () => {
    const { decider, http } = harness([{ respond: 500, body: {} }]);
    const controller = new AbortController();
    await decider.chooseAction(actionRequest(), context({ signal: controller.signal }));
    const signals = http.calls.map(call => call.init.signal);
    expect(signals.length).toBe(3);
    expect(new Set(signals).size).toBe(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    expect(controller.signal.aborted).toBe(false);
  });

  it('gives every stage the same transport contract', async () => {
    const steps: readonly Step[] = [
      { answer: { choices: { argument: 'c1', commitment: 'NONE', commitment_reverse: 'NONE' } } },
    ];
    const argument = harness(steps);
    await argument.decider.chooseArgument(argumentRequest(), context());
    const commitment = harness(steps);
    await commitment.decider.classifyCommitment?.(commitmentRequest(), context());
    const completion = harness([{ answer: { choices: { completion: 'SATISFIED' } } }]);
    await completion.decider.verifyCompletion(completionRequest(), context());
    for (const calls of [argument.http.calls, commitment.http.calls, completion.http.calls]) {
      const call = callOf(calls, 0);
      expect(call.url).toBe(TASK_TYPESAFE_DEFAULTS.endpoint);
      expect(call.init.method).toBe('POST');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.timeoutMs).toBeGreaterThan(0);
      expect(typeof call.init.credential).toBe('function');
    }
  });
});

class DOMExceptionLike extends Error {
  constructor() {
    super('The operation was aborted');
    this.name = 'AbortError';
  }
}

// ---------------------------------------------------------------------------------------------
// Key boundary
// ---------------------------------------------------------------------------------------------

describe('key boundary', () => {
  it('hands an injected transport no Authorization header and no enumerable key', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    await decider.chooseAction(actionRequest(), context());
    const init = callOf(http.calls, 0).init;
    expect(Object.keys(init.headers).map(name => name.toLowerCase())).not.toContain(
      'authorization'
    );
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(typeof init.credential).toBe('function');
    expect(init.credential()).toBe(KEY);
    expect(leaks(init)).toBe(false);
    expect(JSON.stringify(init)).not.toContain(KEY);
    expect(init.body).not.toContain(KEY);
    for (const value of Object.values(init)) {
      if (typeof value !== 'function') {
        expect(String(JSON.stringify(value) ?? '')).not.toContain(KEY);
      }
    }
  });

  it('trims the key, whether given as a string or a function, and reads it per attempt through credential()', async () => {
    let reads = 0;
    const padded = `  ${KEY}\n`;
    const { decider, http } = harness([ANSWER_CLICK], {
      apiKey: () => {
        reads += 1;
        return padded;
      },
    });
    await decider.chooseAction(actionRequest(), context());
    expect(callOf(http.calls, 0).init.credential()).toBe(KEY);
    expect(reads).toBeGreaterThan(0);
    const stringKey = harness([ANSWER_CLICK], { apiKey: padded });
    await stringKey.decider.chooseAction(actionRequest(), context());
    expect(callOf(stringKey.http.calls, 0).init.credential()).toBe(KEY);
  });

  it('is INVALID_REQUEST, with no call, for an empty or unreadable key', async () => {
    const keys: readonly TypeSafeTaskDeciderConfig['apiKey'][] = [
      '',
      '   ',
      '\n\t',
      () => '',
      () => '  ',
      () => {
        throw new Error(`key store down ${ECHO}`);
      },
      (() => 42) as unknown as () => string,
      42 as unknown as string,
      undefined as unknown as string,
      null as unknown as string,
    ];
    for (const apiKey of keys) {
      const { decider, http } = harness([ANSWER_CLICK], { apiKey });
      const result = failed(await decider.chooseAction(actionRequest(), context()));
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.retryable).toBe(false);
      expect(http.calls.length).toBe(0);
      expect(JSON.stringify(result)).not.toContain(ECHO);
    }
  });

  it('never puts the key into an error, an exchange, a thrown value or a message, on any failure path', async () => {
    const throwsWithHeaders = (): never => {
      const error = new Error(`request failed: Authorization: Bearer ${KEY}`);
      Object.assign(error, {
        headers: { Authorization: `Bearer ${KEY}` },
        config: { headers: { Authorization: `Bearer ${KEY}` } },
        cause: new Error(KEY),
      });
      throw error;
    };
    const scenarios: readonly (readonly [string, Step | TaskHttp, TaskDeciderErrorCode])[] = [
      ['network', { throws: new Error(`socket hang up ${KEY}`) }, 'NETWORK'],
      ['string thrown', { throws: `Bearer ${KEY}` }, 'NETWORK'],
      ['object thrown', { throws: { authorization: KEY } }, 'NETWORK'],
      ['sync throw with headers', throwsWithHeaders as unknown as TaskHttp, 'NETWORK'],
      [
        'invalid response',
        { respond: 200, body: { model: KEY, answers: KEY, echo: KEY } },
        'INVALID_RESPONSE',
      ],
      ['bad json', { respond: 200, jsonThrows: true }, 'INVALID_RESPONSE'],
      ['400', { respond: 400, body: { detail: `Bearer ${KEY}`, input: KEY } }, 'INVALID_REQUEST'],
      [
        '401',
        { respond: 401, body: { detail: { error_type: KEY, message: KEY } } },
        'UNAUTHORIZED',
      ],
      [
        '422',
        { respond: 422, body: { detail: [{ input: { Authorization: KEY } }] } },
        'INVALID_REQUEST',
      ],
      [
        '429',
        { respond: 429, body: KEY, headers: { 'retry-after': KEY, 'x-typesafe-request-id': KEY } },
        'RATE_LIMITED',
      ],
      ['500', { respond: 500, body: { message: KEY } }, 'HTTP_ERROR'],
    ];
    for (const [name, scenario, code] of scenarios) {
      const decider =
        typeof scenario === 'function'
          ? createTypeSafeTaskDecider({
              apiKey: KEY,
              http: scenario,
              sleep: () => Promise.resolve(),
            })
          : harness([scenario]).decider;
      const result = failed(await decider.chooseAction(actionRequest(), context()));
      expect({ name, code: result.error.code }).toEqual({ name, code });
      expect({ name, leaked: leaks(result) }).toEqual({ name, leaked: false });
      expect('cause' in result.error).toBe(false);
      expect(Object.keys(result.error).sort()).toEqual(
        Object.keys(result.error).includes('status')
          ? ['code', 'message', 'retryable', 'status']
          : ['code', 'message', 'retryable']
      );
    }
  });

  it('never puts the key into a successful exchange either', async () => {
    const { decider } = harness([ANSWER_CLICK]);
    const result = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(leaks(result)).toBe(false);
  });

  it('keeps a key that a custom transport embeds in its own error out of every output', async () => {
    const http: TaskHttp = async (_url, init) => {
      const failure = new Error(`boom ${init.credential()}`);
      Object.assign(failure, { headers: { Authorization: `Bearer ${init.credential()}` } });
      throw failure;
    };
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http,
      sleep: () => Promise.resolve(),
    });
    for (const call of [
      decider.chooseAction(actionRequest(), context()),
      decider.chooseArgument(argumentRequest(), context()),
      must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context()),
      decider.verifyCompletion(completionRequest(), context()),
    ]) {
      const result = failed(await call);
      expect(result.error.code).toBe('NETWORK');
      expect(leaks(result)).toBe(false);
    }
  });

  it('refuses every call in a browser realm unless the caller said it is a trusted page', async () => {
    const name = ['docu', 'ment'].join('');
    const { decider, http } = harness([ANSWER_CLICK]);
    const trusted = harness([ANSWER_CLICK], { allowBrowserKey: true });
    expect(Reflect.has(globalThis, name)).toBe(false);
    Reflect.set(globalThis, name, {});
    try {
      for (const call of [
        decider.chooseAction(actionRequest(), context()),
        decider.chooseArgument(argumentRequest(), context()),
        must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context()),
        decider.verifyCompletion(completionRequest(), context()),
      ]) {
        const result = failed(await call);
        expect(result.error.code).toBe('INVALID_REQUEST');
        expect(result.error.retryable).toBe(false);
        expect(leaks(result)).toBe(false);
      }
      expect(http.calls.length).toBe(0);
      succeeded(await trusted.decider.chooseAction(actionRequest(), context()));
      expect(trusted.http.calls.length).toBe(1);
    } finally {
      Reflect.deleteProperty(globalThis, name);
    }
    expect(Reflect.has(globalThis, name)).toBe(false);
    succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(http.calls.length).toBe(1);
  });
});

describe('the default fetch transport', () => {
  type FetchInit = {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly redirect: string;
    readonly signal: AbortSignal;
  };
  const realFetch = globalThis.fetch;
  const fetched: { url: string; init: FetchInit }[] = [];

  const stubFetch = (respond: (url: string, init: FetchInit) => Promise<Response>): void => {
    fetched.length = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (url: string, init: FetchInit): Promise<Response> => {
        fetched.push({ url, init });
        return respond(url, init);
      },
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: realFetch,
    });
  });

  const okResponse = (init: FetchInit): Response =>
    new Response(
      JSON.stringify(
        answerBody(init.body, { choices: { operation: 'CLICK', click_target: 't1' } })
      ),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-typesafe-request-id': REQUEST_ID },
      }
    );

  it('posts to the endpoint with redirect "error", the signal, and the key only in the Authorization header', async () => {
    stubFetch((_url, init) => Promise.resolve(okResponse(init)));
    const decider = createTypeSafeTaskDecider({ apiKey: `  ${KEY} ` });
    const { decision, exchange } = succeeded(
      await decider.chooseAction(actionRequest(), context())
    );
    expect(decision.operation).toBe('CLICK');
    expect(exchange.requestId).toBe(REQUEST_ID);
    expect(exchange.model).toBe('jev-1.13.0');
    expect(fetched.length).toBe(1);
    const call = must(fetched[0], 'fetch call');
    expect(call.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.init.body).not.toContain(KEY);
    expect(JSON.stringify({ ...call.init, headers: undefined, signal: undefined })).not.toContain(
      KEY
    );
    expect(leaks({ decision, exchange })).toBe(false);
  });

  it('reads the key through a function once per attempt', async () => {
    let reads = 0;
    let calls = 0;
    stubFetch((_url, init) => {
      calls += 1;
      return Promise.resolve(calls === 1 ? new Response('{}', { status: 503 }) : okResponse(init));
    });
    const decider = createTypeSafeTaskDecider({
      apiKey: () => {
        reads += 1;
        return KEY;
      },
      sleep: () => Promise.resolve(),
    });
    succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(fetched.length).toBe(2);
    // one read for the emptiness check of the call, one per attempt that sent the header
    expect(reads).toBe(3);
    for (const call of fetched) {
      expect(call.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    }
  });

  it('maps a failing fetch (a redirect is a fetch error) to NETWORK without the key, and retries it', async () => {
    stubFetch(() => Promise.reject(new TypeError(`redirect mode is set to error: ${KEY}`)));
    const decider = createTypeSafeTaskDecider({ apiKey: KEY, sleep: () => Promise.resolve() });
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('NETWORK');
    expect(fetched.length).toBe(3);
    expect(leaks(result)).toBe(false);
  });

  it('maps a real Response with an error status and an unparseable body', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(`not json ${ECHO}`, {
          status: 400,
          headers: { 'x-typesafe-request-id': REQUEST_ID },
        })
      )
    );
    const decider = createTypeSafeTaskDecider({ apiKey: KEY });
    const result = failed(await decider.chooseAction(actionRequest(), context()));
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(result.error.message).toContain(REQUEST_ID);
    expect(JSON.stringify(result)).not.toContain(ECHO);
    expect(fetched.length).toBe(1);
  });

  it('aborts the fetch signal when the caller aborts', async () => {
    let seen: AbortSignal | undefined;
    stubFetch((_url, init) => {
      seen = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMExceptionLike()), { once: true });
      });
    });
    const controller = new AbortController();
    const decider = createTypeSafeTaskDecider({ apiKey: KEY });
    setTimeout(() => controller.abort(), 10);
    const result = failed(
      await decider.chooseAction(actionRequest(), context({ signal: controller.signal }))
    );
    expect(result.error.code).toBe('CANCELLED');
    expect(seen?.aborted).toBe(true);
  });

  it('refuses without calling fetch when the endpoint is not allowed', async () => {
    stubFetch((_url, init) => Promise.resolve(okResponse(init)));
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      endpoint: 'http://api.example.test/v1',
    });
    expect(failed(await decider.chooseAction(actionRequest(), context())).error.code).toBe(
      'INVALID_REQUEST'
    );
    expect(fetched.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Endpoint rules
// ---------------------------------------------------------------------------------------------

describe('endpoint rules', () => {
  const attempt = async (
    endpoint: string | undefined,
    overrides: Partial<TypeSafeTaskDeciderConfig> = {}
  ): Promise<{ readonly result: TaskDeciderResult<unknown>; readonly calls: number }> => {
    const { decider, http } = harness([ANSWER_CLICK], {
      ...(endpoint === undefined ? {} : { endpoint }),
      ...overrides,
    });
    const result = await decider.chooseAction(actionRequest(), context());
    return { result, calls: http.calls.length };
  };

  it.each([
    'http://api.example.test/v1/systemone',
    'http://localhost.evil.test/v1',
    'http://127.0.0.1.evil.test/v1',
    'http://10.0.0.5/v1',
    'http://0.0.0.0/v1',
    'ftp://api.typesafe.ai/v1',
    'ws://api.typesafe.ai/v1',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
    '//api.typesafe.ai/v1',
    'https://user:pw@api.typesafe.ai/v1',
    'https://user@api.typesafe.ai/v1',
  ])('refuses %j without sending', async endpoint => {
    const { result, calls } = await attempt(endpoint);
    const error = failed(result).error;
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.retryable).toBe(false);
    expect(calls).toBe(0);
    expect(error.message).not.toContain('pw@');
    expect(error.message).not.toContain(endpoint === '' ? '\u0000' : endpoint);
  });

  it.each([
    'https://api.typesafe.ai/v1/systemone',
    'https://example.test/anything',
    'http://localhost/v1',
    'http://localhost:8080/v1',
    'http://127.0.0.1:9/v1',
    'http://[::1]:9/v1',
    'HTTP://LOCALHOST:8080/v1',
  ])('allows %s', async endpoint => {
    const { result, calls } = await attempt(endpoint);
    succeeded(result);
    expect(calls).toBe(1);
  });

  it('uses the default endpoint when none is configured', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    await decider.chooseAction(actionRequest(), context());
    expect(callOf(http.calls, 0).url).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('requires the host to be in allowedHosts when the list is set', async () => {
    const refused = await attempt('https://evil.example.test/v1', {
      allowedHosts: ['api.typesafe.ai'],
    });
    expect(failed(refused.result).error.code).toBe('INVALID_REQUEST');
    expect(refused.calls).toBe(0);
    const allowed = await attempt(undefined, { allowedHosts: ['api.typesafe.ai'] });
    succeeded(allowed.result);
    const upper = await attempt(undefined, { allowedHosts: ['API.TypeSafe.AI'] });
    succeeded(upper.result);
    const withPort = await attempt('http://localhost:8080/v1', {
      allowedHosts: ['localhost:8080'],
    });
    succeeded(withPort.result);
    const bareHost = await attempt('http://localhost:8080/v1', { allowedHosts: ['localhost'] });
    succeeded(bareHost.result);
    const suffix = await attempt('https://api.typesafe.ai.evil.test/v1', {
      allowedHosts: ['api.typesafe.ai'],
    });
    expect(failed(suffix.result).error.code).toBe('INVALID_REQUEST');
    const prefix = await attempt('https://evil-api.typesafe.ai/v1', {
      allowedHosts: ['api.typesafe.ai'],
    });
    expect(failed(prefix.result).error.code).toBe('INVALID_REQUEST');
  });

  it('fails closed on an empty allowedHosts list, and still applies the scheme rule inside the list', async () => {
    const empty = await attempt(undefined, { allowedHosts: [] });
    expect(failed(empty.result).error.code).toBe('INVALID_REQUEST');
    expect(empty.calls).toBe(0);
    const insecure = await attempt('http://api.example.test/v1', {
      allowedHosts: ['api.example.test'],
    });
    expect(failed(insecure.result).error.code).toBe('INVALID_REQUEST');
    expect(insecure.calls).toBe(0);
  });

  it('refuses every call of every stage, not only the first', async () => {
    const { decider, http } = harness([ANSWER_CLICK], { endpoint: 'http://api.example.test/v1' });
    for (const call of [
      decider.chooseAction(actionRequest(), context()),
      decider.chooseArgument(argumentRequest(), context()),
      must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context()),
      decider.verifyCompletion(completionRequest(), context()),
      decider.chooseAction(actionRequest(), context()),
    ]) {
      expect(failed(await call).error.code).toBe('INVALID_REQUEST');
    }
    expect(http.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Size, options, goal, robustness
// ---------------------------------------------------------------------------------------------

describe('request size and options', () => {
  const sentBytes = (http: FakeHttp): number =>
    Buffer.byteLength(callOf(http.calls, 0).init.body, 'utf8');
  const sentQuestions = (http: FakeHttp): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      Object.entries(asRecord(parseBody(callOf(http.calls, 0).init.body)['questions'])).map(
        ([key, value]) => [key, asRecord(value)]
      )
    );

  it('sends at most the 30000 byte default', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    const { exchange } = succeeded(await decider.chooseAction(bigActionRequest(250), context()));
    expect(sentBytes(http)).toBeLessThanOrEqual(30000);
    expect(sentBytes(http)).toBeGreaterThan(28000);
    expect(exchange.requestBytes).toBe(sentBytes(http));
  });

  it('clamps a configured maxRequestBytes to 40000', async () => {
    const { decider, http } = harness([ANSWER_CLICK], {
      maxRequestBytes: 10_000_000,
      maxOptions: 255,
    });
    succeeded(await decider.chooseAction(bigActionRequest(400), context()));
    expect(sentBytes(http)).toBeLessThanOrEqual(40000);
    expect(sentBytes(http)).toBeGreaterThan(36000);
  });

  it('honours a smaller maxRequestBytes, and falls back to the default for a bad one', async () => {
    const small = harness([ANSWER_CLICK], { maxRequestBytes: 8000 });
    succeeded(await small.decider.chooseAction(bigActionRequest(250), context()));
    expect(sentBytes(small.http)).toBeLessThanOrEqual(8000);
    for (const maxRequestBytes of [0, -5, Number.NaN]) {
      const odd = harness([ANSWER_CLICK], { maxRequestBytes });
      succeeded(await odd.decider.chooseAction(bigActionRequest(250), context()));
      expect(sentBytes(odd.http)).toBeLessThanOrEqual(30000);
      expect(sentBytes(odd.http)).toBeGreaterThan(28000);
    }
  });

  it('is REQUEST_TOO_LARGE, without a call and without a retry, when even the smallest request is over the budget', async () => {
    const { decider, http, sleeps } = harness([ANSWER_CLICK], { maxRequestBytes: 1500 });
    const result = failed(await decider.chooseAction(bigActionRequest(50), context()));
    expect(result.error.code).toBe('REQUEST_TOO_LARGE');
    expect(result.error.retryable).toBe(false);
    expect(http.calls.length).toBe(0);
    expect(sleeps).toEqual([]);
    expect(result.exchange?.attempts).toBe(0);
    expect(result.exchange?.requestBytes).toBeGreaterThan(1500);
  });

  it('is REQUEST_TOO_LARGE for a goal whose copies alone exceed the budget, and never shortens the goal', async () => {
    const goal = 'x'.repeat(12000);
    const { decider, http } = harness([ANSWER_CLICK]);
    const result = failed(
      await decider.chooseAction(bigActionRequest(40, { goal }), context({ goal }))
    );
    expect(result.error.code).toBe('REQUEST_TOO_LARGE');
    expect(http.calls.length).toBe(0);
    expect(result.exchange?.goalVerified).toBe(true);
  });

  it('sends the whole goal at the 1500 byte limit in every question', async () => {
    const goal = 'u'.repeat(TASK_LIMITS.goalBytes);
    const { decider, http } = harness([ANSWER_CLICK]);
    succeeded(await decider.chooseAction(actionRequest({ goal }), context({ goal })));
    const body = parseBody(callOf(http.calls, 0).init.body);
    expect(asRecord(body['state'])['task']).toBe(goal);
    for (const question of Object.values(sentQuestions(http))) {
      expect(asRecord(question['instructions'])['goal']).toBe(goal);
    }
  });

  it('clamps maxOptions to the API limit of 255 and honours smaller values', async () => {
    const wide = harness([ANSWER_CLICK], { maxOptions: 5000, maxRequestBytes: 10_000_000 });
    succeeded(await wide.decider.chooseAction(bigActionRequest(400), context()));
    for (const question of Object.values(sentQuestions(wide.http))) {
      expect(Object.keys(asRecord(question['criteria'])).length).toBeLessThanOrEqual(255);
    }
    const narrow = harness([ANSWER_CLICK], { maxOptions: 20 });
    succeeded(await narrow.decider.chooseAction(bigActionRequest(400), context()));
    for (const question of Object.values(sentQuestions(narrow.http))) {
      expect(Object.keys(asRecord(question['criteria'])).length).toBeLessThanOrEqual(20);
    }
    const clickCriteria = Object.keys(
      asRecord(sentQuestions(narrow.http)['click_target']?.['criteria'])
    );
    expect(clickCriteria.length).toBe(19);
    for (const maxOptions of [0, Number.NaN, -3]) {
      const odd = harness([ANSWER_CLICK], { maxOptions });
      succeeded(await odd.decider.chooseAction(bigActionRequest(400), context()));
      const count = Object.keys(
        asRecord(sentQuestions(odd.http)['click_target']?.['criteria'])
      ).length;
      expect(count).toBeLessThanOrEqual(TASK_TYPESAFE_DEFAULTS.maxOptions);
      expect(count).toBeGreaterThan(20);
    }
  });

  it('passes evidenceQuestions through to the completion request', async () => {
    const { decider, http } = harness([{ answer: { choices: { completion: 'SATISFIED' } } }], {
      evidenceQuestions: 4,
    });
    succeeded(await decider.verifyCompletion(completionRequest(), context()));
    expect(
      Object.keys(sentQuestions(http)).filter(key => key.startsWith('evidence_'))
    ).toHaveLength(4);
  });
});

describe('goal and robustness', () => {
  it('is GOAL_MISMATCH, with nothing sent, when the context goal differs from the request goal', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    for (const call of [
      decider.chooseAction(actionRequest(), context({ goal: `${GOAL} ` })),
      decider.chooseArgument(argumentRequest(), context({ goal: GOAL.toUpperCase() })),
      must(decider.classifyCommitment, 'classifyCommitment')(
        commitmentRequest(),
        context({ goal: '' })
      ),
      decider.verifyCompletion(completionRequest(), context({ goal: 'another' })),
    ]) {
      const result = failed(await call);
      expect(result.error.code).toBe('GOAL_MISMATCH');
      expect(result.error.retryable).toBe(false);
      expect(result.exchange?.goalVerified).toBe(false);
    }
    expect(http.calls.length).toBe(0);
  });

  it('sets goalVerified and sends the literal goal in state.task and every question', async () => {
    const goal = `  Buy "umbrella" é ${String.fromCodePoint(0x1f600)}\n and stop  `;
    const { decider, http } = harness([ANSWER_CLICK]);
    const { exchange } = succeeded(
      await decider.chooseAction(actionRequest({ goal }), context({ goal }))
    );
    expect(exchange.goalVerified).toBe(true);
    const body = parseBody(callOf(http.calls, 0).init.body);
    expect(asRecord(body['state'])['task']).toBe(goal);
    for (const question of Object.values(asRecord(body['questions']))) {
      expect(asRecord(asRecord(question)['instructions'])['goal']).toBe(goal);
    }
  });

  it('never throws and never rejects, whatever it is given', async () => {
    const { decider } = harness([ANSWER_CLICK]);
    const garbage: readonly unknown[] = [undefined, null, 5, 'text', [], {}, { goal: GOAL }];
    for (const bad of garbage) {
      for (const call of [
        () => decider.chooseAction(bad as TaskChooseActionRequest, context()),
        () => decider.chooseArgument(bad as TaskChooseArgumentRequest, context()),
        () =>
          must(decider.classifyCommitment, 'classifyCommitment')(
            bad as TaskClassifyCommitmentRequest,
            context()
          ),
        () => decider.verifyCompletion(bad as TaskVerifyCompletionRequest, context()),
      ]) {
        const result = await call();
        expect(result.ok).toBe(false);
      }
    }
    for (const badContext of [undefined, null, 7, {}]) {
      const result = await decider.chooseAction(
        actionRequest(),
        badContext as unknown as TaskCallContext
      );
      expect(result.ok).toBe(false);
    }
    const noElements = await decider.chooseAction(
      actionRequest({ observation: null as unknown as TaskChooseActionRequest['observation'] }),
      context()
    );
    expect(noElements.ok).toBe(false);
  });

  it('survives a transport that throws synchronously, rejects with a non-error, or returns garbage', async () => {
    const transports: readonly TaskHttp[] = [
      () => {
        throw new Error('sync');
      },
      () => Promise.reject('plain string'),
      () => Promise.reject(undefined),
      () => Promise.resolve({ ok: true, status: 200 } as unknown as TaskHttpResponse),
      () =>
        Promise.resolve({
          ok: true,
          status: 'x',
          header: () => null,
          json: () => Promise.resolve({}),
        } as unknown as TaskHttpResponse),
    ];
    for (const http of transports) {
      const decider = createTypeSafeTaskDecider({
        apiKey: KEY,
        http,
        sleep: () => Promise.resolve(),
      });
      const result = await decider.chooseAction(actionRequest(), context());
      expect(result.ok).toBe(false);
    }
  });

  it('survives a sleep and a random that misbehave', async () => {
    const http = fakeHttp([{ respond: 503, body: {} }, ANSWER_CLICK]);
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http: http.fn,
      sleep: () => Promise.reject(new Error('sleep broke')),
      random: () => Number.NaN,
    });
    succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(http.calls.length).toBe(2);
    const randomOutOfRange = harness([{ respond: 503, body: {} }, ANSWER_CLICK], {}, () => 7);
    succeeded(await randomOutOfRange.decider.chooseAction(actionRequest(), context()));
    for (const delay of randomOutOfRange.sleeps) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });

  it('works with the real clock when none is injected', async () => {
    const http = fakeHttp([ANSWER_CLICK]);
    const decider = createTypeSafeTaskDecider({ apiKey: KEY, http: http.fn });
    const { exchange } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(exchange.latencyMs).toBeGreaterThanOrEqual(0);
    expect(exchange.attemptLog[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles concurrent calls independently', async () => {
    const { decider, http } = harness([ANSWER_CLICK]);
    const results = await Promise.all([
      decider.chooseAction(actionRequest(), context()),
      decider.chooseAction(actionRequest({ step: 1 }), context({ step: 1 })),
      decider.chooseAction(actionRequest({ step: 2 }), context({ step: 2 })),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(http.calls.length).toBe(3);
  });
});

describe('real timers behind the default sleep and the attempt guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits exactly the Retry-After seconds, caps a huge one at 60 seconds, and leaves no timer behind', async () => {
    const http = fakeHttp([
      { respond: 429, headers: { 'retry-after': '3' } },
      { respond: 429, headers: { 'retry-after': '99999' } },
      ANSWER_CLICK,
    ]);
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http: http.fn,
      timeoutMs: 1_000_000,
      random: () => 0,
    });
    const promise = decider.chooseAction(actionRequest(), context());
    await jest.advanceTimersByTimeAsync(2999);
    expect(http.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(http.calls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(http.calls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    const { exchange } = succeeded(await promise);
    expect(http.calls).toHaveLength(3);
    expect(exchange.attemptLog.map(attempt => attempt.delayMs)).toEqual([3000, 60_000, undefined]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops waiting the moment the caller aborts during a backoff, and clears every timer', async () => {
    const controller = new AbortController();
    const http = fakeHttp([{ respond: 503 }]);
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      http: http.fn,
      timeoutMs: 1_000_000,
      random: () => 0,
    });
    let settled = false;
    const promise = decider
      .chooseAction(actionRequest(), context({ signal: controller.signal }))
      .then(result => {
        settled = true;
        return result;
      });
    await jest.advanceTimersByTimeAsync(100);
    expect(http.calls).toHaveLength(1);
    expect(settled).toBe(false);
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const { error, exchange } = failed(await promise);
    expect(error.code).toBe('CANCELLED');
    expect(http.calls).toHaveLength(1);
    expect(exchange?.attempts).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the attempt timer of a call that finished, whatever the outcome', async () => {
    for (const step of [ANSWER_CLICK, { respond: 401 }, { throws: new Error('boom') }] as const) {
      const http = fakeHttp([step]);
      const decider = createTypeSafeTaskDecider({
        apiKey: KEY,
        http: http.fn,
        timeoutMs: 1_000_000,
        retry: { maxRetries: 0 },
      });
      await decider.chooseAction(actionRequest(), context());
      expect(jest.getTimerCount()).toBe(0);
    }
  });
});

describe('the request budget boundary', () => {
  it('sends a request of exactly maxRequestBytes and refuses it at one byte less, with no call', async () => {
    const classify = (decider: TaskDecider) =>
      must(decider.classifyCommitment, 'classifyCommitment')(commitmentRequest(), context());
    const probe = harness([ANSWER_CLICK]);
    await classify(probe.decider);
    const size = Buffer.byteLength(callOf(probe.http.calls, 0).init.body, 'utf8');
    const exact = harness([ANSWER_CLICK], { maxRequestBytes: size });
    const sent = await classify(exact.decider);
    expect(exact.http.calls).toHaveLength(1);
    expect(sent.exchange?.requestBytes).toBe(size);
    const tight = harness([ANSWER_CLICK], { maxRequestBytes: size - 1 });
    const { error } = failed(await classify(tight.decider));
    expect(error.code).toBe('REQUEST_TOO_LARGE');
    expect(tight.http.calls).toHaveLength(0);
  });
});

describe('hostile bodies beyond the table', () => {
  it('is INVALID_RESPONSE, without a retry, when a 2xx response says it is not ok', async () => {
    let calls = 0;
    const decider = createTypeSafeTaskDecider({
      apiKey: KEY,
      sleep: () => Promise.resolve(),
      http: (_url, init) => {
        calls += 1;
        return Promise.resolve({
          ok: false,
          status: 200,
          header: () => null,
          json: () => Promise.resolve(answerBody(init.body, {})),
        });
      },
    });
    const { error } = failed(await decider.chooseAction(actionRequest(), context()));
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(error.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it('ignores an own __proto__ key among the answers and rejects one among the probabilities, merging neither', async () => {
    const choices = { operation: 'CLICK', click_target: 't1' };
    const viaAnswers = harness([
      {
        answer: {
          choices,
          mutate: body =>
            JSON.parse(
              JSON.stringify(body).replace(
                '"answers":{',
                '"answers":{"__proto__":{"choice":"CLICK"},'
              )
            ) as unknown,
        },
      },
    ]);
    const accepted = succeeded(await viaAnswers.decider.chooseAction(actionRequest(), context()));
    expect(accepted.decision.operation).toBe('CLICK');
    expect(({} as Record<string, unknown>)['choice']).toBeUndefined();
    const viaProbabilities = harness([
      {
        answer: {
          choices,
          mutate: body =>
            JSON.parse(
              JSON.stringify(body).replace('"probabilities":{', '"probabilities":{"__proto__":0,')
            ) as unknown,
        },
      },
    ]);
    const { error } = failed(
      await viaProbabilities.decider.chooseAction(actionRequest(), context())
    );
    expect(error.code).toBe('INVALID_RESPONSE');
  });
});

describe('clock robustness', () => {
  it('does not strand the per-attempt timer when the clock throws as an attempt starts', async () => {
    jest.useFakeTimers();
    try {
      let reads = 0;
      const http = fakeHttp([ANSWER_CLICK]);
      const decider = createTypeSafeTaskDecider({
        apiKey: KEY,
        http: http.fn,
        clock: () => {
          reads += 1;
          if (reads === 2) {
            throw new Error('clock broke');
          }
          return reads;
        },
      });
      const { error } = failed(await decider.chooseAction(actionRequest(), context()));
      expect(error.code).toBe('INVALID_REQUEST');
      expect(http.calls).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never records a negative latency, for an attempt or for the exchange, when the clock runs backwards', async () => {
    let now = 1000;
    const { decider } = harness([ANSWER_CLICK], { clock: () => (now -= 100) });
    const { exchange } = succeeded(await decider.chooseAction(actionRequest(), context()));
    expect(exchange.attemptLog.length).toBeGreaterThan(0);
    for (const attempt of exchange.attemptLog) {
      expect(attempt.latencyMs).toBe(0);
    }
    expect(exchange.latencyMs).toBe(0);
  });
});

describe('DOM independence of the adapter', () => {
  it('uses no browser global, no node: import and no console in typesafe.ts, and builds the realm probe name in code', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'agent', 'typesafe.ts'), 'utf8');
    const pattern =
      /\b(window|document|navigator|location|HTMLElement|HTMLInputElement|Element|MutationObserver|getComputedStyle|localStorage|sessionStorage|requestAnimationFrame|TextEncoder)\b|instanceof +Node\b/;
    expect(pattern.exec(source)).toBeNull();
    expect(/\bconsole\./.test(source)).toBe(false);
    expect(/from 'node:/.test(source)).toBe(false);
    expect(/\brequire\(/.test(source)).toBe(false);
    expect(source).toContain("'docu'");
    expect(typeof window).toBe('undefined');
  });
});
