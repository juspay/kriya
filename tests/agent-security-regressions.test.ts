/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { createTypeSafeTaskDecider } from '@/agent/typesafe';
import {
  buildArgumentQuestions,
  buildCompletionQuestions,
  estimateRequestBytes,
} from '@/agent/request';
import { createRemoteTaskHost } from '@/agent/RemoteTaskHost';
import { TASK_BRIDGE_PROTOCOL } from '@/types';
import type {
  TaskBridgeEnvelope,
  TaskBridgeResponse,
  TaskChooseActionRequest,
  TaskChooseArgumentRequest,
  TaskVerifyCompletionRequest,
  TaskTransport,
} from '@/types';
import {
  deciderOk,
  makeCapabilities,
  makeCommandRequest,
  makeElement,
  makeForm,
  makeTextField,
  makeObservation,
} from './helpers/agent-fixtures';

import {
  action,
  approvalResolution,
  requireStatus,
  setup,
  terminal,
} from './helpers/task-agent-contract';

const request: TaskChooseActionRequest = {
  goal: 'Check the current status.',
  step: 0,
  observation: makeObservation(),
  offers: { operations: ['DONE', 'BLOCKED'], targets: {} },
  capabilities: makeCapabilities(),
  inputs: [],
  history: [],
  maxStateBytes: 22000,
};

test.each([200, 400, 401, 429, 500])(
  'credential echoed in a response header never leaves the adapter (HTTP %i)',
  async status => {
    const secret = `probe_${randomUUID().slice(0, 12)}`;
    const decider = createTypeSafeTaskDecider({
      apiKey: secret,
      retry: { maxRetries: 0 },
      http: async () => ({
        ok: status === 200,
        status,
        header: () => secret,
        json: async () => ({}),
      }),
    });
    const result = await decider.chooseAction(request, {
      goal: request.goal,
      step: 0,
      runId: 'run_security',
      callIndex: 1,
    });
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(result.exchange?.requestId).toBeUndefined();
    expect(result.exchange?.attemptLog.every(attempt => attempt.requestId === undefined)).toBe(
      true
    );
  }
);

test('a credential in caller goal or model config is rejected before the HTTP boundary', async () => {
  const secret = `probe_${randomUUID().slice(0, 12)}`;
  const http = jest.fn();
  const decider = createTypeSafeTaskDecider({ apiKey: secret, http });
  const goal = `Check ${secret}`;
  const result = await decider.chooseAction(
    { ...request, goal },
    { goal, step: 0, runId: 'run_security', callIndex: 1 }
  );
  expect(result.ok).toBe(false);
  expect(http).not.toHaveBeenCalled();
  expect(JSON.stringify(result).includes(secret)).toBe(false);
});

test('a host advertising no cancellation waits for the truthful execute outcome', async () => {
  const observation = makeObservation();
  const command = makeCommandRequest();
  const capabilities = makeCapabilities({ protocol: TASK_BRIDGE_PROTOCOL, cancellation: 'none' });
  const calls: string[] = [];
  let finish: (response: TaskBridgeResponse<'execute'>) => void = () => undefined;
  const pending = new Promise<TaskBridgeResponse<'execute'>>(resolve => {
    finish = resolve;
  });
  const response = (envelope: TaskBridgeEnvelope, value: unknown): TaskBridgeResponse =>
    ({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: envelope.callId,
      documentId: observation.documentId,
      method: envelope.method,
      ok: true,
      value,
    }) as TaskBridgeResponse;
  const transport: TaskTransport = {
    concurrent: true,
    invoke: async envelope => {
      calls.push(envelope.method);
      if (envelope.method === 'hello')
        return {
          kind: 'response',
          response: response(envelope, {
            documentId: observation.documentId,
            url: observation.url,
            origin: observation.origin,
            ready: true,
            isTop: true,
            capabilities,
          }),
        };
      if (envelope.method === 'execute')
        return {
          kind: 'response',
          response: await pending.then(value => ({ ...value, callId: envelope.callId })),
        };
      return { kind: 'response', response: response(envelope, null) };
    },
  };
  const host = createRemoteTaskHost({ transport, cancelGraceMs: 1 });
  expect(await host.capabilities()).toMatchObject({ ok: true, value: { cancellation: 'none' } });
  const controller = new AbortController();
  const execution = host.execute(command, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(calls).not.toContain('cancel');
  finish({
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: 'req_test',
    documentId: observation.documentId,
    method: 'execute',
    ok: true,
    value: { requestId: command.requestId, status: 'applied', effect: 'applied', durationMs: 15 },
  });
  expect(await execution).toMatchObject({ status: 'applied', effect: 'applied' });
  await host.dispose();
});

test.each(['agreed', 'disagreed'] as const)(
  'a low-confidence commitment keeps its explicit class (%s)',
  async agreement => {
    const scenario = setup({
      chooseAction: [
        deciderOk('action', action('CLICK', 't1')),
        deciderOk('action', terminal('BLOCKED')),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'DELETE', confidence: 0.1, agreement }),
      ],
    });
    const result = await scenario.agent.run({
      goal: 'Remove the test item.',
      authorization: { effects: ['delete'] },
    });
    expect(scenario.fakeHost.calls.execute).toHaveLength(1);
    expect(result.ledger[0]?.effects).toContain('delete');
    expect(result.ledger[0]?.effects).not.toContain('other_commitment');
    expect(Object.keys(scenario.fakeHost.calls.execute[0]?.scope ?? {}).sort()).toEqual([
      'documentId',
      'sessionId',
      'snapshotId',
    ]);
  }
);

test('a same-origin form destination change requires a fresh approval', async () => {
  const target = makeElement({ formId: 'f1' });
  const first = makeObservation({
    elements: [target],
    forms: [makeForm({ id: 'f1', action: 'https://shop.example.test/first', fieldIds: [] })],
  });
  const second = {
    ...first,
    forms: [makeForm({ id: 'f1', action: 'https://shop.example.test/second', fieldIds: [] })],
  };
  const scenario = setup(
    {
      chooseAction: [
        deciderOk('action', action('CLICK', 't1')),
        deciderOk('action', action('CLICK', 't1')),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'SEND', confidence: 0.99, agreement: 'single' }),
        deciderOk('commitment', { commitment: 'SEND', confidence: 0.99, agreement: 'single' }),
      ],
    },
    { observations: [first, second] }
  );
  const paused = requireStatus(
    await scenario.agent.run({ goal: 'Send the test form.' }),
    'awaiting_approval'
  );
  expect(paused.approval.context.structural.destination?.action).toBe(
    'https://shop.example.test/first'
  );
  const resumed = await scenario.agent.resume({
    checkpoint: paused.checkpoint,
    resolution: { kind: 'approval', resolution: approvalResolution(paused.approval) },
  });
  expect(resumed.status).toBe('awaiting_approval');
  expect(scenario.fakeHost.calls.execute).toHaveLength(0);
  if (resumed.status === 'awaiting_approval') {
    expect(resumed.approval.contextDigest).not.toBe(paused.approval.contextDigest);
    expect(resumed.approval.context.structural.destination?.action).toBe(
      'https://shop.example.test/second'
    );
  }
});

test('argument requests trim candidate criteria to the configured byte budget', () => {
  const target = makeTextField();
  const argument: TaskChooseArgumentRequest = {
    goal: 'Set the name.',
    step: 1,
    observation: makeObservation({ elements: [target] }),
    operation: 'FILL',
    target,
    slot: 'value',
    inputs: [],
    history: [],
    maxStateBytes: 22000,
    candidates: Array.from({ length: 50 }, (_, index) => ({
      id: `c${index + 1}`,
      source: 'input' as const,
      label: 'Candidate name ' + index,
      preview: 'ordinary value '.repeat(5) + index,
      sensitive: false,
    })),
  };
  const set = buildArgumentQuestions(argument, { maxRequestBytes: 2000 });
  expect(estimateRequestBytes(set, 'jev-1.13.0')).toBeLessThanOrEqual(2000);
  const choices = Object.keys(set.questions['argument']?.criteria ?? {});
  expect(choices).toContain('NONE_APPROPRIATE');
  expect(choices.length).toBeGreaterThanOrEqual(2);
  expect(choices.length).toBeLessThan(51);
  expect(set.questions['argument']?.instructions).toMatchObject({
    goal: argument.goal,
    target: target.id,
  });
});

test('diverged non-sensitive observations survive the verifier projection', () => {
  const expected = [
    {
      label: 'Name',
      kind: 'field_value' as const,
      expected: 'Original',
      observed: 'Changed',
      sensitive: false,
      status: 'diverged' as const,
    },
  ];
  const target = makeTextField();
  const verify: TaskVerifyCompletionRequest = {
    goal: 'Check the name.',
    step: 1,
    observation: makeObservation({ elements: [target] }),
    inputs: [],
    evidenceSlots: 1,
    history: [],
    collectedEvidence: [],
    expected,
    maxStateBytes: 22000,
  };
  const set = buildCompletionQuestions(verify);
  const serialized = JSON.stringify(set.state);
  expect(serialized).toContain('Changed');
  expect(serialized).toContain('Original');
  const sensitive = buildCompletionQuestions({
    ...verify,
    expected: expected.map(item => ({ ...item, sensitive: true, expected: true })),
  });
  expect(JSON.stringify(sensitive.state)).not.toContain('Changed');
});
