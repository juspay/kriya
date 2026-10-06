/** @jest-environment node */
import { createResearchRequest, toResearchResult } from '@/agent/research';
import { computeOffers } from '@/agent/commands';
import { summarizeObservation } from '@/agent/verify';
import { TASK_RESEARCH_PROFILE } from '@/types';
import type { TaskCompletion, TaskResult, TaskResultBase } from '@/types';
import {
  makeBudgetUsage,
  makeCapabilities,
  makeCheckpoint,
  makeLedgerEntry,
  makeObservation,
  makePageElements,
} from './helpers/agent-fixtures';

const observation = makeObservation({ elements: makePageElements() });
const base: TaskResultBase = {
  runId: 'run_1',
  sessionId: 'ses_1',
  goal: 'Can this service deliver?',
  steps: 2,
  stats: {
    usage: makeBudgetUsage(),
    modelLatencyMs: 0,
    actions: { applied: 0, noop: 0, rejected: 0, failed: 0, uncertain: 0, navigated: 0 },
  },
  ledger: [],
  exchanges: [],
  warnings: [],
  startedAt: 0,
  finishedAt: 1,
  lastEffect: 'none',
  unresolvedUncertain: [],
};
const completion: TaskCompletion = {
  mode: 'answered',
  effected: false,
  answered: true,
  basis: 'model_only',
  evidence: [],
  actionsExecuted: 0,
  verifierConfidence: 0.9,
  verifiedAt: 1,
  verifiedSnapshot: summarizeObservation(observation),
  postconditions: [],
  resolvedUncertain: [],
  unresolvedUncertain: [],
  unobserved: observation.unobserved,
};

test('research request keeps the literal question and legacy defaults', () => {
  const request = createResearchRequest('Is this available?');
  expect(request).toMatchObject({
    goal: 'Is this available?',
    profile: TASK_RESEARCH_PROFILE,
    expect: { answer: true },
    options: { confidence: { completion: 0.6, action: 0 }, budgets: { maxSteps: 24 } },
  });
  expect(request.authorization).toBeUndefined();
  expect(
    createResearchRequest('A question', {
      allowedOrigins: ['https://example.test'],
      minConfidence: 0.8,
      minActionConfidence: 0.2,
      maxSteps: 7,
    })
  ).toMatchObject({
    authorization: { origins: ['https://example.test'] },
    options: { confidence: { completion: 0.8, action: 0.2 }, budgets: { maxSteps: 7 } },
  });
});

test('research capabilities do not offer write or interactive commands', () => {
  const offers = computeOffers({
    observation,
    capabilities: makeCapabilities(),
    allowedOperations: TASK_RESEARCH_PROFILE.operations,
    exclude: [],
    allowRunLoss: false,
  });
  expect(offers.operations).not.toEqual(
    expect.arrayContaining(['CLICK', 'FILL', 'SUBMIT', 'SELECT', 'SET_CHECKED', 'PRESS'])
  );
  expect(
    offers.operations.every(operation =>
      ['READ', 'NAVIGATE', 'SCROLL', 'WAIT', 'DONE', 'BLOCKED'].includes(operation)
    )
  ).toBe(true);
});

test.each(['YES', 'NO'] as const)(
  'completed informational %s retains legacy answer polarity',
  value => {
    const converted = toResearchResult({
      ...base,
      status: 'completed',
      completion,
      answer: { value, confidence: 0.9 },
    });
    expect(converted).toMatchObject({
      ok: value === 'YES',
      status: value === 'YES' ? 'success' : 'failure',
      answer: value,
      confidence: 0.9,
      steps: 2,
    });
  }
);

test('completed without an answer is a research failure', () => {
  expect(toResearchResult({ ...base, status: 'completed', completion })).toMatchObject({
    ok: false,
    status: 'failure',
    answer: 'UNKNOWN',
    error: expect.any(String),
  });
});

const failures: TaskResult[] = [
  { ...base, status: 'blocked', reason: 'MODEL_BLOCKED', message: 'Cannot determine it.' },
  {
    ...base,
    status: 'failed',
    error: { code: 'HOST_FAILED', message: 'Host unavailable.', retryable: false },
  },
  { ...base, status: 'needs_input', checkpoint: makeCheckpoint(), requirements: [] },
];
test.each(failures)('$status maps to UNKNOWN failure', result => {
  expect(toResearchResult(result)).toMatchObject({
    ok: false,
    status: 'failure',
    answer: 'UNKNOWN',
    error: expect.any(String),
  });
});

test('cancellation maps to legacy cancelled status', () => {
  expect(toResearchResult({ ...base, status: 'cancelled', during: 'decision' })).toMatchObject({
    ok: false,
    status: 'cancelled',
  });
});

test('READ evidence is preserved in ledger order', () => {
  const first = makeLedgerEntry({
    command: {
      command: {
        operation: 'READ',
        target: { sessionId: 'ses_1', snapshotId: 'snap_1', targetId: 't1', signature: 'sg_1' },
      },
    },
    readback: { kind: 'read', text: 'First passage' },
    url: 'https://example.test/first',
  });
  const second = {
    ...first,
    seq: 2,
    url: 'https://example.test/second',
    readback: { kind: 'read' as const, text: 'Second passage' },
  };
  expect(
    toResearchResult({ ...base, ledger: [first, second], status: 'cancelled', during: 'idle' })
      .evidence
  ).toEqual([
    { url: first.url, text: 'First passage' },
    { url: second.url, text: 'Second passage' },
  ]);
});
