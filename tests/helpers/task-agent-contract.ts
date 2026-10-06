import { createTaskAgent } from '@/agent/TaskAgent';
import type {
  TaskActionDecision,
  TaskAgentOptions,
  TaskApprovalRequest,
  TaskApprovalResolution,
  TaskArgumentDecision,
  TaskChooseArgumentRequest,
  TaskPolicy,
  TaskResult,
} from '@/types';
import type { FakeDeciderScript, FakeHostOptions } from './agent-fixtures';
import {
  counterIds,
  deciderOk,
  makeActionDecision,
  makeClock,
  makeFakeDecider,
  makeFakeHost,
} from './agent-fixtures';

export function terminal(operation: 'DONE' | 'BLOCKED'): TaskActionDecision {
  return makeActionDecision({ operation, target: { kind: 'not_applicable' } });
}

export function action(operation: TaskActionDecision['operation'], id: string): TaskActionDecision {
  return makeActionDecision({ operation, target: { kind: 'target', id } });
}

export function chooseCandidate(
  request: TaskChooseArgumentRequest,
  matches: (candidate: TaskChooseArgumentRequest['candidates'][number]) => boolean
): ReturnType<typeof deciderOk<TaskArgumentDecision>> {
  const candidate = request.candidates.find(matches);
  if (candidate === undefined) {
    throw new Error('contract scenario requires an offered candidate');
  }
  return deciderOk('argument', {
    kind: 'candidate',
    candidateId: candidate.id,
    confidence: 0.99,
  });
}

export function setup(
  script: FakeDeciderScript,
  hostOptions: FakeHostOptions = {},
  options: TaskAgentOptions = {},
  policy?: TaskPolicy
) {
  const fakeHost = makeFakeHost(hostOptions);
  const fakeDecider = makeFakeDecider(script);
  const agent = createTaskAgent({
    host: fakeHost.host,
    decider: fakeDecider.decider,
    ...(policy === undefined ? {} : { policy }),
    options: { clock: makeClock(), createId: counterIds(), ...options },
  });
  return { agent, fakeHost, fakeDecider };
}

export function requireStatus<S extends TaskResult['status']>(
  result: TaskResult,
  status: S
): Extract<TaskResult, { readonly status: S }> {
  if (result.status !== status) {
    const detail =
      result.status === 'failed'
        ? result.error.code
        : result.status === 'blocked'
          ? result.reason
          : result.status;
    throw new Error(`expected ${status}, received ${result.status} (${detail})`);
  }
  expect(result.status).toBe(status);
  return result as Extract<TaskResult, { readonly status: S }>;
}

export function approvalResolution(
  approval: TaskApprovalRequest,
  overrides: Partial<TaskApprovalResolution> = {}
): TaskApprovalResolution {
  return {
    approvalId: approval.id,
    nonce: approval.nonce,
    digest: approval.digest,
    contextDigest: approval.contextDigest,
    decision: 'approve',
    scope: 'once',
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function secretValue(): string {
  return String.fromCharCode(115, 101, 99, 114, 101, 116, 45, 52, 56, 99, 50, 100, 55);
}
