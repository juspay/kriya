import { installTaskBridge } from '@/agent/browser/bridge';
import { TASK_BRIDGE_PROTOCOL, TASK_LIMITS } from '@/types';
import type {
  TaskBridgeEnvelope,
  TaskBridgeHandle,
  TaskCommandRequest,
  TaskHostCommand,
  TaskObservation,
} from '@/types';
import { counterIds } from './helpers/agent-fixtures';
import { mountHtml, resetDom } from './helpers/domHarness';

let names = 0;
const handles: TaskBridgeHandle[] = [];
const origin = window.location.origin;

function install(): TaskBridgeHandle {
  names += 1;
  const handle = installTaskBridge({
    globalName: `__bridge_test_${names}`,
    createId: counterIds(),
    settle: { quietMs: 0, maxMs: 0 },
  });
  document.dispatchEvent(new Event('DOMContentLoaded'));
  handles.push(handle);
  return handle;
}

async function observe(handle: TaskBridgeHandle): Promise<TaskObservation> {
  const response = await handle.endpoint.invoke({
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: `req_observe_${names}`,
    method: 'observe',
    payload: { sessionId: 'ses_test', options: { settle: { quietMs: 0, maxMs: 0 } } },
  });
  if (!response.ok || response.method !== 'observe') {
    throw new Error('Expected observation');
  }
  return response.value;
}

function command(observation: TaskObservation, value: TaskHostCommand): TaskCommandRequest {
  return {
    requestId: 'req_command',
    scope: {
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      documentId: observation.documentId,
    },
    command: value,
    allowedOrigins: [origin],
    timeoutMs: 1000,
    settle: { quietMs: 0, maxMs: 0 },
  };
}

function execute(
  payload: TaskCommandRequest,
  callId = 'req_execute'
): TaskBridgeEnvelope<'execute'> {
  return { protocol: TASK_BRIDGE_PROTOCOL, callId, method: 'execute', payload };
}

beforeEach(() => resetDom());
afterEach(() => {
  handles.splice(0).forEach(handle => handle.dispose());
  resetDom();
});

test('installs a frozen endpoint with a permanent property and is idempotent', () => {
  const handle = install();
  expect(handle.installed).toBe(true);
  const property = Object.getOwnPropertyDescriptor(globalThis, `__bridge_test_${names}`);
  expect(property).toMatchObject({ writable: false, configurable: false, enumerable: false });
  expect(Object.isFrozen(handle.endpoint)).toBe(true);
  expect(installTaskBridge({ globalName: `__bridge_test_${names}` })).toBe(handle);
});

test('refuses a preexisting page property without reading its getter or replacing it', async () => {
  names += 1;
  const getter = jest.fn(() => ({ invoke: jest.fn() }));
  Object.defineProperty(globalThis, `__bridge_test_${names}`, { get: getter, configurable: true });
  // Under jest's jsdom on Node 20 the vm layer itself calls an accessor on a bare Reflect.has; Node 22+ does not.
  // Measure that engine cost first so the assertion is about the bridge, not the Node version.
  Reflect.has(globalThis, `__bridge_test_${names}`);
  const engineReads = getter.mock.calls.length;
  getter.mockClear();
  const handle = installTaskBridge({ globalName: `__bridge_test_${names}` });
  expect(handle.installed).toBe(false);
  expect(getter.mock.calls.length).toBeLessThanOrEqual(engineReads);
  const response = await handle.endpoint.invoke({
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: 'req_hello',
    method: 'hello',
    payload: {},
  });
  expect(response).toMatchObject({ ok: false, error: { code: 'HOST_UNAVAILABLE' } });
});

test('hello reports readiness, top frame, matching protocol and a stable document id', async () => {
  const handle = install();
  const response = await handle.endpoint.invoke({
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: 'req_hello',
    method: 'hello',
    payload: {},
  });
  expect(response).toMatchObject({
    ok: true,
    documentId: handle.documentId,
    value: { ready: true, isTop: true, capabilities: { protocol: TASK_BRIDGE_PROTOCOL } },
  });
  expect(JSON.parse(JSON.stringify(response))).toEqual(response);
});

test('observes and executes an exact fill through the real AutomationEngine', async () => {
  mountHtml('<label>Name <input name="name" value="old"></label>');
  const handle = install();
  const snapshot = await observe(handle);
  const target = snapshot.elements.find(element => element.operations.includes('FILL'));
  expect(target).toBeDefined();
  if (target === undefined) return;
  const response = await handle.endpoint.invoke(
    execute(
      command(snapshot, {
        operation: 'FILL',
        target: {
          sessionId: snapshot.sessionId,
          snapshotId: snapshot.snapshotId,
          targetId: target.id,
          signature: target.signature,
        },
        value: 'new',
        sensitive: false,
      })
    )
  );
  expect(response).toMatchObject({ ok: true, value: { status: 'applied', effect: 'applied' } });
  expect(document.querySelector('input')?.value).toBe('new');
});

test('document mismatch rejects an execute without changing the target', async () => {
  mountHtml('<input aria-label="Name" value="old">');
  const handle = install();
  const snapshot = await observe(handle);
  const target = snapshot.elements.find(element => element.operations.includes('FILL'));
  if (target === undefined) throw new Error('Missing field');
  const envelope = execute(
    command(snapshot, {
      operation: 'FILL',
      target: {
        sessionId: snapshot.sessionId,
        snapshotId: snapshot.snapshotId,
        targetId: target.id,
        signature: target.signature,
      },
      value: 'new',
      sensitive: false,
    })
  );
  const response = await handle.endpoint.invoke({ ...envelope, expectDocumentId: 'doc_other' });
  expect(response).toMatchObject({
    ok: true,
    value: { status: 'rejected_stale', effect: 'none', staleReason: 'document_changed' },
  });
  expect(document.querySelector('input')?.value).toBe('old');
  const observation = await handle.endpoint.invoke({
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: 'req_observe_other',
    method: 'observe',
    payload: { sessionId: 'ses_test' },
    expectDocumentId: 'doc_other',
  });
  expect(observation).toMatchObject({ ok: false, error: { code: 'DOCUMENT_CHANGED' } });
});

test('unknown cancellation creates a tombstone and prevents an overtaken execute', async () => {
  const handle = install();
  const snapshot = await observe(handle);
  expect(
    await handle.endpoint.invoke({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: 'req_cancel',
      method: 'cancel',
      payload: { targetCallId: 'req_late' },
    })
  ).toMatchObject({ ok: true, value: { found: false, phase: 'unknown' } });
  const response = await handle.endpoint.invoke(
    execute(command(snapshot, { operation: 'WAIT', durationMs: 100 }), 'req_late')
  );
  expect(response).toMatchObject({
    ok: true,
    value: { status: 'failed', code: 'EXECUTION_CANCELLED', effect: 'none' },
  });
});

test('finished ids are remembered by envelope call id rather than command request id', async () => {
  const handle = install();
  const snapshot = await observe(handle);
  await handle.endpoint.invoke(
    execute(command(snapshot, { operation: 'WAIT', durationMs: 0 }), 'req_finished')
  );
  expect(
    await handle.endpoint.invoke({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: 'req_cancel',
      method: 'cancel',
      payload: { targetCallId: 'req_finished' },
    })
  ).toMatchObject({ ok: true, value: { found: true, phase: 'finished' } });
  expect(
    await handle.endpoint.invoke(
      execute(command(snapshot, { operation: 'WAIT', durationMs: 0 }), 'req_finished')
    )
  ).toMatchObject({ ok: true, value: { status: 'rejected_invalid', effect: 'none' } });
});

test('bounded tombstones retain recent cancellations', async () => {
  const handle = install();
  const snapshot = await observe(handle);
  for (let i = 0; i <= TASK_LIMITS.bridgeTombstones; i += 1) {
    await handle.endpoint.invoke({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: `req_cancel_${i}`,
      method: 'cancel',
      payload: { targetCallId: `req_late_${i}` },
    });
  }
  expect(
    await handle.endpoint.invoke(
      execute(
        command(snapshot, { operation: 'WAIT', durationMs: 0 }),
        `req_late_${TASK_LIMITS.bridgeTombstones}`
      )
    )
  ).toMatchObject({ ok: true, value: { code: 'EXECUTION_CANCELLED', effect: 'none' } });
});

test('release invalidates held snapshot targets and dispose permanently disables the endpoint', async () => {
  mountHtml('<input aria-label="Name">');
  const handle = install();
  const snapshot = await observe(handle);
  const target = snapshot.elements.find(element => element.operations.includes('FILL'));
  if (target === undefined) throw new Error('Missing field');
  await handle.endpoint.invoke({
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: 'req_release',
    method: 'release',
    payload: { sessionId: snapshot.sessionId },
  });
  expect(
    await handle.endpoint.invoke(
      execute(
        command(snapshot, {
          operation: 'FILL',
          target: {
            sessionId: snapshot.sessionId,
            snapshotId: snapshot.snapshotId,
            targetId: target.id,
            signature: target.signature,
          },
          value: 'new',
          sensitive: false,
        })
      )
    )
  ).toMatchObject({ ok: true, value: { status: 'rejected_stale', effect: 'none' } });
  handle.dispose();
  expect(handle.endpoint.ready).toBe(false);
  expect(installTaskBridge({ globalName: `__bridge_test_${names}` })).toBe(handle);
  expect(
    await handle.endpoint.invoke({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: 'req_hello',
      method: 'hello',
      payload: {},
    })
  ).toMatchObject({ ok: false, error: { code: 'HOST_DISPOSED' } });
});

test('malformed envelopes and cyclic JSON resolve a structured failure', async () => {
  const handle = install();
  expect(await handle.endpoint.invoke(null as unknown as TaskBridgeEnvelope)).toMatchObject({
    ok: false,
    error: { code: 'PROTOCOL_ERROR' },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(
    await handle.endpoint.invoke({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: 'req_cycle',
      method: 'hello',
      payload: cyclic as Readonly<Record<string, never>>,
    })
  ).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
});
