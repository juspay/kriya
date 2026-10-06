import { randomBytes } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';
import { createRemoteTaskHost } from '@/agent/RemoteTaskHost';
import { createTaskAgent } from '@/agent/TaskAgent';
import { installTaskBridge } from '@/agent/browser/bridge';
import { AutomationEngine } from '@/core/AutomationEngine';
import { TASK_BRIDGE_PROTOCOL, TASK_LIMITS } from '@/types';
import type {
  TaskBridgeEnvelope,
  TaskBridgeHandle,
  TaskBridgeInstallOptions,
  TaskBridgeResponse,
  TaskCommandRequest,
  TaskHost,
  TaskHostCommand,
  TaskObservation,
  TaskTargetRef,
  TaskTransport,
  TaskTransportResult,
} from '@/types';
import {
  counterIds,
  deciderOk,
  makeActionDecision,
  makeCommitmentDecision,
  makeCompletionDecision,
  makeFakeDecider,
  roundTrip,
} from './helpers/agent-fixtures';
import { installLayoutStubs, mountHtml, resetDom, setViewport } from './helpers/domHarness';

let globalNames = 0;
const handles: TaskBridgeHandle[] = [];
const remotes: TaskHost[] = [];
const ids = counterIds();
const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');

type Metadata = {
  readonly method: string;
  readonly callId: string;
  readonly requestId?: string;
  readonly targetCallId?: string;
  readonly cancelPhase?: string;
};
type Harness = {
  current: TaskBridgeHandle;
  readonly transport: TaskTransport;
  readonly metadata: Metadata[];
  resetObservationSequence: boolean;
  replace: (html: string, url: string) => TaskBridgeHandle;
};

function install(options: TaskBridgeInstallOptions<HTMLElement> = {}): TaskBridgeHandle {
  globalNames += 1;
  const result = installTaskBridge({
    globalName: `__remote_bridge_test_${globalNames}`,
    createId: ids,
    settle: { quietMs: 0, maxMs: 10 },
    ...options,
  });
  document.dispatchEvent(new Event('DOMContentLoaded'));
  expect(result.installed).toBe(true);
  handles.push(result);
  return result;
}
function harness(html: string, options: TaskBridgeInstallOptions<HTMLElement> = {}): Harness {
  mountHtml(html);
  const state: Harness = {
    current: install(options),
    metadata: [],
    resetObservationSequence: false,
    replace: (nextHtml, url) => {
      // This swaps real endpoints in ONE jsdom realm. It simulates document loss; it is not hard-navigation proof.
      document.body.innerHTML = '';
      window.history.pushState(null, '', url);
      mountHtml(nextHtml);
      state.current = install(options);
      return state.current;
    },
    transport: {
      concurrent: true,
      invoke: async envelope => {
        const endpoint = state.current;
        const incoming = roundTrip(envelope);
        state.metadata.push({
          method: incoming.method,
          callId: incoming.callId,
          ...(incoming.method === 'execute' ? { requestId: incoming.payload.requestId } : {}),
          ...(incoming.method === 'cancel' ? { targetCallId: incoming.payload.targetCallId } : {}),
        });
        const response = await endpoint.endpoint.invoke(incoming);
        if (incoming.method === 'cancel' && response.ok && response.method === 'cancel') {
          state.metadata.push({
            method: 'cancel_ack',
            callId: incoming.callId,
            cancelPhase: response.value.phase,
          });
        }
        if (incoming.method === 'execute' && endpoint !== state.current) {
          return { kind: 'lost', reason: 'navigated' };
        }
        if (state.resetObservationSequence && response.ok && response.method === 'observe') {
          // Explicit fault injection: sequence is audit data; coordinator freshness must use its ordinal.
          return {
            kind: 'response',
            response: roundTrip({ ...response, value: { ...response.value, sequence: 1 } }),
          };
        }
        return { kind: 'response', response: roundTrip(response) };
      },
      location: async () => ({
        ok: true,
        value: { url: window.location.href, origin: window.location.origin },
      }),
      waitForDocument: async input =>
        state.current.documentId !== input.previousDocumentId && state.current.endpoint.ready
          ? { documentId: state.current.documentId, url: window.location.href, ready: true }
          : null,
    },
  };
  return state;
}
function remote(state: Harness): TaskHost {
  const result = createRemoteTaskHost({
    transport: state.transport,
    createId: counterIds(),
    callTimeoutMs: 1000,
    navigationTimeoutMs: 1000,
    cancelGraceMs: 1000,
    pollIntervalMs: 5,
  });
  remotes.push(result);
  return result;
}
async function observe(target: TaskHost, sessionId = 'ses_remote'): Promise<TaskObservation> {
  const result = await target.observe({
    sessionId,
    options: { settle: { quietMs: 0, maxMs: 10 } },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected a remote observation.');
  }
  return result.value;
}
function ref(observation: TaskObservation, label: string): TaskTargetRef {
  const entry = observation.elements.find(element => element.label === label);
  if (!entry) {
    throw new Error('Expected an observed target.');
  }
  return {
    sessionId: observation.sessionId,
    snapshotId: observation.snapshotId,
    targetId: entry.id,
    signature: entry.signature,
  };
}
function command(
  observation: TaskObservation,
  value: TaskHostCommand,
  overrides: Partial<TaskCommandRequest> = {}
): TaskCommandRequest {
  return {
    requestId: ids('req'),
    scope: {
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      documentId: observation.documentId,
    },
    command: value,
    allowedOrigins: [window.location.origin],
    timeoutMs: 1000,
    settle: { quietMs: 0, maxMs: 10 },
    ...overrides,
  };
}
function envelope<M extends TaskBridgeEnvelope['method']>(
  method: M,
  payload: Extract<TaskBridgeEnvelope, { method: M }>['payload'],
  callId = ids('req')
): TaskBridgeEnvelope {
  return { protocol: TASK_BRIDGE_PROTOCOL, method, payload, callId } as TaskBridgeEnvelope;
}
async function direct(
  handle: TaskBridgeHandle,
  input: TaskBridgeEnvelope
): Promise<TaskBridgeResponse> {
  return handle.endpoint.invoke(roundTrip(input));
}
function expectExecute(
  response: TaskBridgeResponse
): Extract<TaskBridgeResponse, { method: 'execute'; ok: true }> {
  expect(response).toMatchObject({ ok: true, method: 'execute' });
  if (!response.ok || response.method !== 'execute') {
    throw new Error('Expected an execute response.');
  }
  return response;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder });
  resetDom();
  installLayoutStubs();
  setViewport({ width: 1000, height: 900, scrollHeight: 1800 });
});
afterEach(async () => {
  await Promise.all(remotes.splice(0).map(target => target.dispose()));
  handles.splice(0).forEach(handle => handle.dispose());
  jest.restoreAllMocks();
  if (originalTextEncoder) {
    Object.defineProperty(globalThis, 'TextEncoder', originalTextEncoder);
  } else {
    Reflect.deleteProperty(globalThis, 'TextEncoder');
  }
  resetDom();
});

describe('real bridge, host and remote host over serializable jsdom transport', () => {
  test('remote capabilities and exact fill cross JSON transport without losing target scope', async () => {
    const state = harness('<input aria-label="Name"><input aria-label="Other">');
    const target = remote(state);
    expect(await target.capabilities()).toMatchObject({
      ok: true,
      value: {
        hostKind: 'remote',
        persistsAcrossNavigation: true,
        authoritativeLocation: true,
        strictTargets: true,
      },
    });
    const snapshot = await observe(target);
    const result = await target.execute(
      command(snapshot, {
        operation: 'FILL',
        target: ref(snapshot, 'Name'),
        value: 'Requested',
        sensitive: false,
      })
    );
    expect(result).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'fill', matched: true },
    });
    expect((document.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('Requested');
    expect((document.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('');
    expect(roundTrip(result)).toEqual(result);
    expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
  });

  test('SPA transition preserves document and session while making the old target stale', async () => {
    const state = harness('<button>Move</button><p>Evidence</p>');
    document
      .querySelector('button')
      ?.addEventListener('click', () => window.history.pushState(null, '', '/spa#view'));
    const target = remote(state);
    const first = await observe(target);
    const request = command(first, { operation: 'CLICK', target: ref(first, 'Move') });
    expect(await target.execute(request)).toMatchObject({
      status: 'navigated',
      effect: 'applied',
      navigation: { kind: 'same_document', realmLost: false },
    });
    expect(await target.execute(request)).toMatchObject({
      status: 'rejected_stale',
      effect: 'none',
      staleReason: 'url_changed',
    });
    const second = await observe(target, first.sessionId);
    expect(second.documentId).toBe(first.documentId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  test('simulated document endpoint replacement reports realm loss and a restarted observer sequence', async () => {
    const state = harness('<a href="/destination">Next</a>');
    let activations = 0;
    document.querySelector('a')?.addEventListener('click', event => {
      event.preventDefault();
      activations += 1;
      state.replace('<p>Destination loaded</p>', '/destination');
    });
    const target = remote(state);
    await observe(target);
    const first = await observe(target);
    const result = await target.execute(
      command(first, { operation: 'NAVIGATE', target: ref(first, 'Next') })
    );
    expect(result).toMatchObject({
      status: 'navigated',
      effect: 'uncertain',
      navigation: {
        kind: 'document',
        realmLost: true,
        fromDocumentId: first.documentId,
        toDocumentId: state.current.documentId,
      },
    });
    expect(activations).toBe(1);
    const second = await observe(target, first.sessionId);
    expect(second.documentId).not.toBe(first.documentId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sequence).toBe(1);
    expect(second.sequence).toBeLessThan(first.sequence);
    expect(second.text).toContain('Destination loaded');
    expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
  });

  test('scripted coordinator completes after simulated document replacement with explicit sequence-reset fault', async () => {
    const state = harness('<a href="/destination">Next</a>');
    document.querySelector('a')?.addEventListener('click', event => {
      event.preventDefault();
      state.replace('<p>Destination loaded</p>', '/destination');
      state.resetObservationSequence = true;
    });
    const target = remote(state);
    const scripted = makeFakeDecider({
      chooseAction: [
        request =>
          deciderOk(
            'action',
            makeActionDecision({
              operation: 'NAVIGATE',
              target: {
                kind: 'target',
                id: request.observation.elements.find(item => item.label === 'Next')?.id ?? '',
              },
            })
          ),
        deciderOk(
          'action',
          makeActionDecision({ operation: 'DONE', target: { kind: 'not_applicable' } })
        ),
      ],
      classifyCommitment: [deciderOk('commitment', makeCommitmentDecision())],
      verifyCompletion: [
        request =>
          deciderOk(
            'completion',
            makeCompletionDecision({
              evidenceTargetIds: [
                request.observation.elements.find(item => item.kind === 'passage')?.id ?? '',
              ],
            })
          ),
      ],
    });
    const agent = createTaskAgent({
      host: target,
      decider: scripted.decider,
      options: { createId: counterIds() },
    });
    const result = await agent.run({
      goal: 'Open the next page and inspect the destination.',
      authorization: { origins: [window.location.origin] },
      options: { settle: { quietMs: 0, maxMs: 10 }, captureTrace: true },
    });
    expect({
      status: result.status,
      error: result.status === 'failed' ? result.error : undefined,
    }).toEqual({ status: 'completed', error: undefined });
    if (result.status !== 'completed') {
      throw new Error('Expected completion.');
    }
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({
      status: 'navigated',
      effect: 'uncertain',
    });
    expect(result.unresolvedUncertain).toEqual([]);
    expect(result.completion.resolvedUncertain).toContainEqual(
      expect.objectContaining({ seq: 1, by: 'transition' })
    );
    expect(scripted.calls.verifyCompletion[0]?.request.observation.sequence).toBe(1);
    expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
  });

  test('release clears only the named session across the remote boundary', async () => {
    const state = harness('<p>Evidence</p>');
    const target = remote(state);
    const first = await observe(target, 'ses_first');
    const second = await observe(target, 'ses_second');
    await target.release?.(first.sessionId);
    expect(
      await target.execute(command(first, { operation: 'READ', target: ref(first, 'Evidence') }))
    ).toMatchObject({ status: 'rejected_stale', effect: 'none', staleReason: 'session_released' });
    expect(
      await target.execute(command(second, { operation: 'READ', target: ref(second, 'Evidence') }))
    ).toMatchObject({
      status: 'applied',
      effect: 'none',
      readback: { kind: 'read', text: 'Evidence' },
    });
  });

  test('run origins permit a cross-origin link while an install ceiling can deny it', async () => {
    const state = harness('<a href="https://checkout.example/next">Next</a>', {
      allowedOrigins: [window.location.origin],
    });
    document.querySelector('a')?.addEventListener('click', event => event.preventDefault());
    const target = remote(state);
    const snapshot = await observe(target);
    expect(
      await target.execute(
        command(
          snapshot,
          { operation: 'NAVIGATE', target: ref(snapshot, 'Next') },
          { allowedOrigins: [window.location.origin, 'https://checkout.example'] }
        )
      )
    ).toMatchObject({ status: 'rejected_scope', effect: 'none' });
    const allowed = harness('<a href="https://checkout.example/next">Allowed next</a>');
    Array.from(document.querySelectorAll('a'))
      .slice(-1)[0]
      ?.addEventListener('click', event => event.preventDefault());
    const allowedRemote = remote(allowed);
    const allowedSnapshot = await observe(allowedRemote);
    expect(
      await allowedRemote.execute(
        command(
          allowedSnapshot,
          { operation: 'NAVIGATE', target: ref(allowedSnapshot, 'Allowed next') },
          { allowedOrigins: [window.location.origin, 'https://checkout.example'] }
        )
      )
    ).toMatchObject({ status: 'applied', effect: 'applied' });
  });
});

describe('real bridge cancellation and replay boundaries', () => {
  test('remote cancellation of a real WAIT is before_commit and leaves effect none', async () => {
    const state = harness('<p>Evidence</p>');
    const target = remote(state);
    const snapshot = await observe(target);
    const original = AutomationEngine.prototype.executeAction;
    let notify: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      notify = resolve;
    });
    let forwarded: AbortSignal | undefined;
    jest.spyOn(AutomationEngine.prototype, 'executeAction').mockImplementation(function (
      this: AutomationEngine,
      action,
      options
    ) {
      forwarded = options?.signal;
      notify();
      return original.call(this, action, options);
    });
    const controller = new AbortController();
    const pending = target.execute(
      command(snapshot, { operation: 'WAIT', durationMs: 250 }),
      controller.signal
    );
    await started;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', effect: 'none', code: 'EXECUTION_CANCELLED' });
    expect(forwarded?.aborted).toBe(true);
    expect(
      state.metadata.some(
        item => item.method === 'cancel_ack' && item.cancelPhase === 'before_commit'
      )
    ).toBe(true);
    const executeId = state.metadata.find(item => item.method === 'execute')?.callId;
    expect(state.metadata.find(item => item.method === 'cancel')?.targetCallId).toBe(executeId);
  });

  test('remote cancellation after a real sensitive setter is after_commit and uncertain', async () => {
    const state = harness('<input type="password" aria-label="Password">');
    const target = remote(state);
    const snapshot = await observe(target);
    const secret = randomBytes(24).toString('hex');
    let notify: () => void = () => undefined;
    const changed = new Promise<void>(resolve => {
      notify = resolve;
    });
    document.querySelector('input')?.addEventListener('input', notify, { once: true });
    const controller = new AbortController();
    const pending = target.execute(
      command(
        snapshot,
        { operation: 'FILL', target: ref(snapshot, 'Password'), value: secret, sensitive: true },
        { settle: { quietMs: 100, maxMs: 200 } }
      ),
      controller.signal
    );
    await changed;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_CANCELLED',
    });
    expect(
      state.metadata.some(
        item => item.method === 'cancel_ack' && item.cancelPhase === 'after_commit'
      )
    ).toBe(true);
    expect((document.querySelector('input') as HTMLInputElement).value === secret).toBe(true);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(JSON.stringify(state.metadata).includes(secret)).toBe(false);
    expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
  });

  test('a cancel tombstone blocks a later real fill without crossing a mutation boundary', async () => {
    const state = harness('<input aria-label="Name">');
    const target = remote(state);
    const snapshot = await observe(target);
    const lateId = ids('req');
    const cancelled = await direct(state.current, envelope('cancel', { targetCallId: lateId }));
    expect(cancelled).toMatchObject({ ok: true, value: { found: false, phase: 'unknown' } });
    const response = expectExecute(
      await direct(
        state.current,
        envelope(
          'execute',
          command(snapshot, {
            operation: 'FILL',
            target: ref(snapshot, 'Name'),
            value: 'Requested',
            sensitive: false,
          }),
          lateId
        )
      )
    );
    expect(response.value).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'EXECUTION_CANCELLED',
    });
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(await direct(state.current, envelope('cancel', { targetCallId: lateId }))).toMatchObject(
      { ok: true, value: { found: true, phase: 'finished' } }
    );
  });

  test('duplicate callId never repeats a real click, while distinct callIds sharing requestId remain distinct', async () => {
    const state = harness('<button>Act</button>');
    let count = 0;
    document.querySelector('button')?.addEventListener('click', () => {
      count += 1;
    });
    const target = remote(state);
    const snapshot = await observe(target);
    const payload = command(
      snapshot,
      { operation: 'CLICK', target: ref(snapshot, 'Act') },
      { requestId: 'req_shared', settle: { quietMs: 20, maxMs: 40 } }
    );
    const input = envelope('execute', payload);
    const responses = await Promise.all([
      direct(state.current, input),
      direct(state.current, input),
    ]);
    expect(
      responses
        .map(expectExecute)
        .map(response => response.value.status)
        .sort()
    ).toEqual(['applied', 'rejected_invalid']);
    expect(count).toBe(1);
    expect(expectExecute(await direct(state.current, input)).value).toMatchObject({
      status: 'rejected_invalid',
      effect: 'none',
    });
    expect(count).toBe(1);
    expect(
      expectExecute(await direct(state.current, envelope('execute', payload))).value
    ).toMatchObject({ status: 'applied', effect: 'applied' });
    expect(count).toBe(2);
  });

  test('finished and tombstone memories respect their documented bounds', async () => {
    const state = harness('<p>Evidence</p><input aria-label="Name">');
    const target = remote(state);
    const snapshot = await observe(target);
    const read = command(snapshot, { operation: 'READ', target: ref(snapshot, 'Evidence') });
    const finished: string[] = [];
    for (let index = 0; index <= TASK_LIMITS.bridgeFinishedCalls; index += 1) {
      const id = ids('req');
      finished.push(id);
      expect(
        expectExecute(await direct(state.current, envelope('execute', read, id))).value.status
      ).toBe('applied');
    }
    expect(
      await direct(state.current, envelope('cancel', { targetCallId: finished[0] as string }))
    ).toMatchObject({ ok: true, value: { found: false, phase: 'unknown' } });
    expect(
      await direct(
        state.current,
        envelope('cancel', { targetCallId: finished[finished.length - 1] as string })
      )
    ).toMatchObject({ ok: true, value: { found: true, phase: 'finished' } });
    const tombstones: string[] = [];
    for (let index = 0; index <= TASK_LIMITS.bridgeTombstones; index += 1) {
      const id = ids('req');
      tombstones.push(id);
      expect(await direct(state.current, envelope('cancel', { targetCallId: id }))).toMatchObject({
        ok: true,
        value: { found: false, phase: 'unknown' },
      });
    }
    const fill = command(snapshot, {
      operation: 'FILL',
      target: ref(snapshot, 'Name'),
      value: 'Requested',
      sensitive: false,
    });
    expect(
      expectExecute(
        await direct(
          state.current,
          envelope('execute', fill, tombstones[tombstones.length - 1] as string)
        )
      ).value
    ).toMatchObject({ status: 'failed', effect: 'none', code: 'EXECUTION_CANCELLED' });
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(
      expectExecute(await direct(state.current, envelope('execute', fill, tombstones[0] as string)))
        .value
    ).toMatchObject({ status: 'applied', effect: 'applied' });
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('Requested');
  });

  test('bridge engine disables legacy capture and screenshot paths and supplies a redactor', async () => {
    const state = harness('<button>Act</button>');
    const target = remote(state);
    const snapshot = await observe(target);
    const original = AutomationEngine.prototype.executeAction;
    let settings: unknown;
    jest.spyOn(AutomationEngine.prototype, 'executeAction').mockImplementation(function (
      this: AutomationEngine,
      action,
      options
    ) {
      const config = this.getConfig();
      settings = {
        debug: config.debugMode,
        screenshots: config.screenshotOnError,
        forms: config.formDetectionEnabled,
        context: config.contextCaptureEnabled,
        redactor: config.redactor !== undefined,
      };
      return original.call(this, action, options);
    });
    expect(
      await target.execute(command(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }))
    ).toMatchObject({ status: 'applied' });
    expect(settings).toEqual({
      debug: false,
      screenshots: false,
      forms: false,
      context: false,
      redactor: true,
    });
  });
});

describe('coordinator approval security through a real remote bridge (scripted decider)', () => {
  test('changing only a redacted form-action token must void an earlier approval before submission', async () => {
    const initialToken = randomBytes(24).toString('hex');
    const changedToken = randomBytes(24).toString('hex');
    const state = harness(
      `<form action="/commit?token=${initialToken}"><button data-kriya-commit="purchase">Purchase</button></form><p>Prepared request</p>`
    );
    let submissions = 0;
    let changedDestination = false;
    document.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault();
      submissions += 1;
      changedDestination =
        new URL((event.target as HTMLFormElement).action).searchParams.get('token') ===
        changedToken;
    });
    const scripted = makeFakeDecider({
      chooseAction: [
        request =>
          deciderOk(
            'action',
            makeActionDecision({
              operation: 'SUBMIT',
              target: {
                kind: 'target',
                id: request.observation.elements.find(item => item.label === 'Purchase')?.id ?? '',
              },
            })
          ),
        request =>
          deciderOk(
            'action',
            makeActionDecision({
              operation: 'SUBMIT',
              target: {
                kind: 'target',
                id: request.observation.elements.find(item => item.label === 'Purchase')?.id ?? '',
              },
            })
          ),
      ],
      classifyCommitment: [
        deciderOk('commitment', makeCommitmentDecision({ commitment: 'PURCHASE' })),
        deciderOk('commitment', makeCommitmentDecision({ commitment: 'PURCHASE' })),
      ],
    });
    const agent = createTaskAgent({
      host: remote(state),
      decider: scripted.decider,
      options: { createId: counterIds() },
    });
    const paused = await agent.run({
      goal: 'Submit the prepared purchase.',
      authorization: { origins: [window.location.origin] },
      options: { settle: { quietMs: 0, maxMs: 10 }, captureTrace: true },
    });
    expect(paused.status).toBe('awaiting_approval');
    if (paused.status !== 'awaiting_approval') {
      throw new Error('Expected a concrete approval.');
    }
    expect(submissions).toBe(0);
    expect(JSON.stringify(paused).includes(initialToken)).toBe(false);
    (document.querySelector('form') as HTMLFormElement).action = `/commit?token=${changedToken}`;
    const resumed = await agent.resume({
      checkpoint: roundTrip(paused.checkpoint),
      resolution: {
        kind: 'approval',
        resolution: {
          approvalId: paused.approval.id,
          nonce: paused.approval.nonce,
          digest: paused.approval.digest,
          contextDigest: paused.approval.contextDigest,
          decision: 'approve',
          scope: 'once',
        },
      },
    });
    expect({ status: resumed.status, submissions, changedDestination }).toEqual({
      status: 'awaiting_approval',
      submissions: 0,
      changedDestination: false,
    });
    expect(resumed.trace?.some(event => event.type === 'approval' && event.phase === 'void')).toBe(
      true
    );
  });
});

test('a preexisting wrapper of a legitimate endpoint cannot claim idempotent installation', async () => {
  const state = harness('<p>Evidence</p>');
  const original = state.current;
  globalNames += 1;
  const name = `__remote_bridge_wrapper_${globalNames}`;
  const wrapper = {
    ...original.endpoint,
    invoke: async () => {
      throw new Error('An unrelated page wrapper must not execute.');
    },
  };
  for (const symbol of Object.getOwnPropertySymbols(original.endpoint)) {
    const descriptor = Object.getOwnPropertyDescriptor(original.endpoint, symbol);
    if (descriptor) {
      Object.defineProperty(wrapper, symbol, descriptor);
    }
  }
  Object.defineProperty(globalThis, name, { configurable: true, value: wrapper });
  try {
    const rejected = installTaskBridge({ globalName: name, createId: ids });
    expect(rejected.installed).toBe(false);
    expect(Object.getOwnPropertyDescriptor(globalThis, name)?.value === wrapper).toBe(true);
    expect(await rejected.endpoint.invoke(envelope('hello', {}))).toMatchObject({
      ok: false,
      error: { code: 'HOST_UNAVAILABLE' },
    });
    const installedName = `__remote_bridge_test_${globalNames - 1}`;
    expect(installTaskBridge({ globalName: installedName })).toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
  } finally {
    Reflect.deleteProperty(globalThis, name);
  }
});

test('an approved Enter submission executes once and replay is refused before transport execution', async () => {
  const state = harness(
    '<form action="/save"><input aria-label="Name" value="Prepared"><button>Save</button></form><p>Result pending</p>'
  );
  let submissions = 0;
  document.querySelector('form')?.addEventListener('submit', event => {
    event.preventDefault();
    submissions += 1;
    (document.querySelector('p') as HTMLElement).textContent = 'Submission observed';
  });
  const scripted = makeFakeDecider({
    chooseAction: [
      request =>
        deciderOk(
          'action',
          makeActionDecision({
            operation: 'PRESS',
            target: {
              kind: 'target',
              id: request.observation.elements.find(item => item.label === 'Name')?.id ?? '',
            },
          })
        ),
      deciderOk(
        'action',
        makeActionDecision({ operation: 'DONE', target: { kind: 'not_applicable' } })
      ),
    ],
    chooseArgument: [
      request =>
        deciderOk('argument', {
          kind: 'candidate',
          candidateId: request.candidates.find(item => item.label === 'Press Enter')?.id ?? '',
          confidence: 1,
        }),
    ],
    classifyCommitment: [deciderOk('commitment', makeCommitmentDecision({ commitment: 'NONE' }))],
    verifyCompletion: [
      request =>
        deciderOk(
          'completion',
          makeCompletionDecision({
            evidenceTargetIds: [
              request.observation.elements.find(item => item.kind === 'passage')?.id ?? '',
            ],
          })
        ),
    ],
  });
  const agent = createTaskAgent({
    host: remote(state),
    decider: scripted.decider,
    options: {
      createId: counterIds(),
      verifier: async () => ({ verdict: submissions === 1 ? 'SATISFIED' : 'NOT_SATISFIED' }),
    },
  });
  const paused = await agent.run({
    goal: 'Submit the prepared form.',
    authorization: { origins: [window.location.origin] },
    options: { settle: { quietMs: 0, maxMs: 10 }, captureTrace: true },
  });
  expect(paused.status).toBe('awaiting_approval');
  if (paused.status !== 'awaiting_approval') {
    throw new Error('Expected an equivalent-submission approval.');
  }
  expect(paused.approval.effects).toContain('form_submit');
  expect(submissions).toBe(0);
  const resume = {
    checkpoint: roundTrip(paused.checkpoint),
    resolution: {
      kind: 'approval' as const,
      resolution: {
        approvalId: paused.approval.id,
        nonce: paused.approval.nonce,
        digest: paused.approval.digest,
        contextDigest: paused.approval.contextDigest,
        decision: 'approve' as const,
        scope: 'once' as const,
      },
    },
  };
  const tampered = {
    ...resume.checkpoint,
    request: {
      ...resume.checkpoint.request,
      authorization: {
        ...resume.checkpoint.request.authorization,
        origins: [window.location.origin, 'https://unapproved.example'],
      },
    },
  };
  expect(await agent.resume({ ...resume, checkpoint: tampered })).toMatchObject({
    status: 'failed',
    error: { code: 'CHECKPOINT_INVALID' },
  });
  expect(submissions).toBe(0);
  expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(0);
  const result = await agent.resume(resume);
  expect(result.status).toBe('completed');
  expect(submissions).toBe(1);
  expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
  expect(await agent.resume(resume)).toMatchObject({
    status: 'failed',
    error: { code: 'APPROVAL_CONSUMED' },
  });
  expect(submissions).toBe(1);
  expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
});

test('a rejected concurrent resume cannot release the active resume snapshot', async () => {
  const state = harness('<form action="/save"><button>Save</button></form><p>Prepared result</p>');
  let submissions = 0;
  document.querySelector('form')?.addEventListener('submit', event => {
    event.preventDefault();
    submissions += 1;
    (document.querySelector('p') as HTMLElement).textContent = 'Submission observed';
  });
  let notify: () => void = () => undefined;
  let continueExecution: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    notify = resolve;
  });
  const barrier = new Promise<void>(resolve => {
    continueExecution = resolve;
  });
  const scripted = makeFakeDecider({
    chooseAction: [
      request =>
        deciderOk(
          'action',
          makeActionDecision({
            operation: 'SUBMIT',
            target: {
              kind: 'target',
              id: request.observation.elements.find(item => item.label === 'Save')?.id ?? '',
            },
          })
        ),
      deciderOk(
        'action',
        makeActionDecision({ operation: 'DONE', target: { kind: 'not_applicable' } })
      ),
    ],
    classifyCommitment: [deciderOk('commitment', makeCommitmentDecision({ commitment: 'NONE' }))],
    verifyCompletion: [
      request =>
        deciderOk(
          'completion',
          makeCompletionDecision({
            evidenceTargetIds: [
              request.observation.elements.find(item => item.kind === 'passage')?.id ?? '',
            ],
          })
        ),
    ],
  });
  const agent = createTaskAgent({
    host: remote(state),
    decider: scripted.decider,
    options: {
      createId: counterIds(),
      beforeExecute: async () => {
        notify();
        await barrier;
      },
      verifier: async () => ({ verdict: submissions === 1 ? 'SATISFIED' : 'NOT_SATISFIED' }),
    },
  });
  const paused = await agent.run({
    goal: 'Submit the prepared form.',
    authorization: { origins: [window.location.origin] },
    options: { settle: { quietMs: 0, maxMs: 10 } },
  });
  expect(paused.status).toBe('awaiting_approval');
  if (paused.status !== 'awaiting_approval') {
    throw new Error('Expected a submission approval.');
  }
  const resume = {
    checkpoint: roundTrip(paused.checkpoint),
    resolution: {
      kind: 'approval' as const,
      resolution: {
        approvalId: paused.approval.id,
        nonce: paused.approval.nonce,
        digest: paused.approval.digest,
        contextDigest: paused.approval.contextDigest,
        decision: 'approve' as const,
        scope: 'once' as const,
      },
    },
  };
  const first = agent.resume(resume);
  await entered;
  const second = await agent.resume(resume);
  continueExecution();
  expect(second).toMatchObject({ status: 'failed', error: { code: 'RUN_IN_PROGRESS' } });
  const result = await first;
  expect({ status: result.status, submissions }).toEqual({ status: 'completed', submissions: 1 });
  expect(state.metadata.filter(item => item.method === 'execute')).toHaveLength(1);
});
