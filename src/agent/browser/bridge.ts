import { AutomationEngine } from '@/core/AutomationEngine';
import {
  TASK_BRIDGE_GLOBAL,
  TASK_BRIDGE_PROTOCOL,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_LIMITS,
  TASK_WAIT_DURATIONS_MS,
} from '@/types';
import type {
  ActionCommand,
  ExecutionOptions,
  TaskBridgeEndpoint,
  TaskBridgeEnvelope,
  TaskBridgeHandle,
  TaskBridgeInstallOptions,
  TaskBridgeResponse,
  TaskCancelAck,
  TaskCommandRequest,
  TaskExecutionOutcome,
  TaskHost,
  TaskHostCapabilities,
  TaskHostError,
  TaskIdFactory,
  TaskInstallBridgeFn,
} from '@/types';
import { createRedactor } from '@/utils/redact';
import { createAutomationTaskHost } from './AutomationTaskHost';

type ActiveCall = {
  readonly controller: AbortController;
  started: boolean;
  committed: boolean;
};

type BridgeState = {
  readonly active: Map<string, ActiveCall>;
  readonly bySignal: Map<AbortSignal, ActiveCall>;
  readonly tombstones: Set<string>;
  readonly finished: Set<string>;
  ready: boolean;
  disposed: boolean;
};

function defaultId(prefix: Parameters<TaskIdFactory>[0]): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `${prefix}_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}

function unavailableCapabilities(): TaskHostCapabilities {
  return {
    hostKind: 'in_page',
    protocol: TASK_BRIDGE_PROTOCOL,
    operations: [],
    persistsAcrossNavigation: false,
    detectsNavigation: true,
    cancellation: 'cooperative',
    redaction: { observations: true, executionEvents: true },
    strictTargets: true,
    scrollContainers: true,
    implicitSubmitDetection: true,
    authoritativeLocation: true,
    isolatedWorld: false,
    maxElements: TASK_LIMITS.observedElements,
    keys: TASK_KEYS,
    waitDurationsMs: TASK_WAIT_DURATIONS_MS,
  };
}

function protocolError(
  message: string,
  code: TaskHostError['code'] = 'PROTOCOL_ERROR'
): TaskHostError {
  return { code, message, retryable: code === 'HOST_UNAVAILABLE' || code === 'DOCUMENT_CHANGED' };
}

function errorResponse(
  envelope: TaskBridgeEnvelope,
  documentId: string,
  error: TaskHostError
): TaskBridgeResponse {
  return {
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: typeof envelope?.callId === 'string' ? envelope.callId : '',
    documentId,
    method: envelope?.method ?? 'hello',
    ok: false,
    error,
  };
}

function executeResponse(
  envelope: TaskBridgeEnvelope<'execute'>,
  documentId: string,
  outcome: TaskExecutionOutcome
): TaskBridgeResponse<'execute'> {
  return {
    protocol: TASK_BRIDGE_PROTOCOL,
    callId: envelope.callId,
    documentId,
    method: 'execute',
    ok: true,
    value: outcome,
  };
}

function remember(set: Set<string>, id: string, limit: number): void {
  set.add(id);
  if (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}

function validEnvelope(envelope: TaskBridgeEnvelope): boolean {
  return (
    envelope !== null &&
    typeof envelope === 'object' &&
    envelope.protocol === TASK_BRIDGE_PROTOCOL &&
    typeof envelope.callId === 'string' &&
    envelope.callId.length > 0 &&
    envelope.callId.length <= 160 &&
    ['hello', 'observe', 'execute', 'cancel', 'release', 'dispose'].includes(envelope.method) &&
    envelope.payload !== null &&
    typeof envelope.payload === 'object' &&
    !Array.isArray(envelope.payload)
  );
}

function cancelCall(state: BridgeState, id: string): TaskCancelAck {
  const active = state.active.get(id);
  if (active !== undefined) {
    const phase = active.committed
      ? 'after_commit'
      : active.started
        ? 'before_commit'
        : 'not_started';
    active.controller.abort();
    return { found: true, phase };
  }
  if (state.finished.has(id)) {
    return { found: true, phase: 'finished' };
  }
  remember(state.tombstones, id, TASK_LIMITS.bridgeTombstones);
  return { found: false, phase: 'unknown' };
}

function rejectedExecution(
  request: TaskCommandRequest,
  status: 'failed' | 'rejected_stale' | 'rejected_invalid',
  code: 'EXECUTION_CANCELLED' | 'TARGET_STALE' | 'INVALID_ACTION'
): TaskExecutionOutcome {
  return {
    requestId: typeof request?.requestId === 'string' ? request.requestId : '',
    status,
    code,
    effect: 'none',
    durationMs: 0,
    ...(status === 'rejected_stale' ? { staleReason: 'document_changed' as const } : {}),
  };
}

function failureHandle(documentId: string): TaskBridgeHandle {
  return {
    installed: false,
    documentId,
    endpoint: Object.freeze({
      protocol: TASK_BRIDGE_PROTOCOL,
      documentId,
      ready: false,
      invoke: async envelope =>
        errorResponse(
          envelope,
          documentId,
          protocolError('The bridge is unavailable.', 'HOST_UNAVAILABLE')
        ),
    }),
    dispose: () => undefined,
  };
}

/** Installs one execution endpoint for this document, without taking over an existing page global. */
function installBridge(
  options: TaskBridgeInstallOptions<HTMLElement>,
  installed: WeakMap<object, TaskBridgeHandle>
): TaskBridgeHandle {
  const BuiltinObject = Object;
  const BuiltinPromise = Promise;
  const BuiltinMap = Map;
  const BuiltinJSON = JSON;
  const createId = options.createId ?? defaultId;
  let documentId: string;
  try {
    documentId = createId('doc');
  } catch {
    documentId = defaultId('doc');
  }
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.top !== window) {
    return failureHandle(documentId);
  }
  const name = options.globalName ?? TASK_BRIDGE_GLOBAL;
  if (Reflect.has(globalThis, name)) {
    const descriptor = BuiltinObject.getOwnPropertyDescriptor(globalThis, name);
    const existing: unknown = descriptor?.value;
    if (existing !== null && typeof existing === 'object') {
      const ownHandle = installed.get(existing);
      if (ownHandle !== undefined) {
        return ownHandle;
      }
    }
    return failureHandle(documentId);
  }
  const state: BridgeState = {
    active: new BuiltinMap(),
    bySignal: new BuiltinMap(),
    tombstones: new Set(),
    finished: new Set(),
    ready: false,
    disposed: false,
  };
  const engine = new AutomationEngine({
    debugMode: false,
    screenshotOnError: false,
    formDetectionEnabled: false,
    contextCaptureEnabled: false,
    redactor: createRedactor(),
  });
  const host = createAutomationTaskHost({
    executor: {
      executeAction: async (action: ActionCommand, executionOptions?: ExecutionOptions) => {
        const entry =
          executionOptions?.signal === undefined
            ? undefined
            : state.bySignal.get(executionOptions.signal);
        if (entry !== undefined) {
          entry.started = true;
        }
        return engine.executeAction(action, {
          ...executionOptions,
          onCommit: () => {
            if (entry !== undefined) {
              entry.committed = true;
            }
            executionOptions?.onCommit?.();
          },
        });
      },
    },
    documentId,
    createId,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.settle === undefined ? {} : { settle: options.settle }),
    ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
    ...(options.operations === undefined ? {} : { operations: options.operations }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const dispose = (): void => {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    state.ready = false;
    document.removeEventListener('DOMContentLoaded', initialize);
    for (const call of state.active.values()) {
      call.controller.abort();
    }
    void host.dispose().catch(() => undefined);
    try {
      engine.dispose();
    } catch {
      // Disposal is best effort; the endpoint remains permanently unavailable.
    }
  };
  const initialize = (): void => {
    if (state.disposed || state.ready) {
      return;
    }
    try {
      engine.initialize();
      state.ready = true;
    } catch {
      state.ready = false;
    }
  };
  const invoke = async (envelope: TaskBridgeEnvelope): Promise<TaskBridgeResponse> => {
    try {
      if (!validEnvelope(envelope)) {
        return errorResponse(envelope, documentId, protocolError('Invalid bridge envelope.'));
      }
      if (state.disposed) {
        return errorResponse(
          envelope,
          documentId,
          protocolError('The bridge is disposed.', 'HOST_DISPOSED')
        );
      }
      // Snapshot the JSON envelope so a caller cannot modify it during an asynchronous call.
      const stable = BuiltinJSON.parse(BuiltinJSON.stringify(envelope)) as TaskBridgeEnvelope;
      return await dispatchBridge({ envelope: stable, documentId, state, host, dispose, options });
    } catch {
      return errorResponse(
        envelope,
        documentId,
        protocolError('The bridge call failed.', 'INTERNAL')
      );
    }
  };
  const endpoint: TaskBridgeEndpoint = {
    protocol: TASK_BRIDGE_PROTOCOL,
    documentId,
    get ready(): boolean {
      return state.ready && !state.disposed;
    },
    invoke: (envelope: TaskBridgeEnvelope) => BuiltinPromise.resolve().then(() => invoke(envelope)),
  };
  const handle: TaskBridgeHandle = BuiltinObject.freeze({
    installed: true,
    documentId,
    endpoint,
    dispose,
  });
  try {
    BuiltinObject.defineProperty(globalThis, name, {
      value: BuiltinObject.freeze(endpoint),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    dispose();
    return failureHandle(documentId);
  }
  installed.set(endpoint, handle);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
  return handle;
}

type DispatchContext = {
  readonly envelope: TaskBridgeEnvelope;
  readonly documentId: string;
  readonly state: BridgeState;
  readonly host: TaskHost;
  readonly dispose: () => void;
  readonly options: TaskBridgeInstallOptions<HTMLElement>;
};

async function dispatchBridge(context: DispatchContext): Promise<TaskBridgeResponse> {
  const { envelope, documentId, state, host, dispose, options } = context;
  const fields = { protocol: TASK_BRIDGE_PROTOCOL, callId: envelope.callId, documentId } as const;
  if (envelope.method === 'hello') {
    const capabilities = await host.capabilities();
    const redactor = createRedactor();
    return {
      ...fields,
      method: 'hello',
      ok: true,
      value: {
        documentId,
        url: redactor.redactUrl(window.location.href),
        origin: window.location.origin,
        ready: state.ready,
        isTop: window.top === window,
        capabilities: {
          ...(capabilities.ok ? capabilities.value : unavailableCapabilities()),
          isolatedWorld: options.isolatedWorld ?? false,
          operations: capabilities.ok ? capabilities.value.operations : TASK_HOST_OPERATIONS,
        },
      },
    };
  }
  if (envelope.method === 'cancel') {
    if (
      typeof envelope.payload.targetCallId !== 'string' ||
      envelope.payload.targetCallId.length === 0
    ) {
      return errorResponse(envelope, documentId, protocolError('Invalid cancellation id.'));
    }
    return {
      ...fields,
      method: 'cancel',
      ok: true,
      value: cancelCall(state, envelope.payload.targetCallId),
    };
  }
  if (envelope.method === 'release') {
    await host.release?.(envelope.payload.sessionId);
    return { ...fields, method: 'release', ok: true, value: null };
  }
  if (envelope.method === 'dispose') {
    dispose();
    return { ...fields, method: 'dispose', ok: true, value: null };
  }
  if (envelope.method === 'execute') {
    return executeBridge(context, envelope);
  }
  if (!state.ready) {
    return errorResponse(
      envelope,
      documentId,
      protocolError('The bridge is not ready.', 'HOST_UNAVAILABLE')
    );
  }
  if (envelope.expectDocumentId !== undefined && envelope.expectDocumentId !== documentId) {
    return errorResponse(
      envelope,
      documentId,
      protocolError('The document changed.', 'DOCUMENT_CHANGED')
    );
  }
  const observed = await host.observe(envelope.payload);
  return observed.ok
    ? { ...fields, method: 'observe', ok: true, value: observed.value }
    : errorResponse(envelope, documentId, observed.error);
}

async function executeBridge(
  context: DispatchContext,
  envelope: TaskBridgeEnvelope<'execute'>
): Promise<TaskBridgeResponse<'execute'>> {
  const { state, documentId, host } = context;
  if (state.active.has(envelope.callId) || state.finished.has(envelope.callId)) {
    return executeResponse(
      envelope,
      documentId,
      rejectedExecution(envelope.payload, 'rejected_invalid', 'INVALID_ACTION')
    );
  }
  const entry: ActiveCall = { controller: new AbortController(), started: false, committed: false };
  state.active.set(envelope.callId, entry);
  state.bySignal.set(entry.controller.signal, entry);
  try {
    if (state.tombstones.has(envelope.callId)) {
      return executeResponse(
        envelope,
        documentId,
        rejectedExecution(envelope.payload, 'failed', 'EXECUTION_CANCELLED')
      );
    }
    if (!state.ready) {
      return {
        protocol: TASK_BRIDGE_PROTOCOL,
        callId: envelope.callId,
        documentId,
        method: 'execute',
        ok: false,
        error: protocolError('The bridge is not ready.', 'HOST_UNAVAILABLE'),
      };
    }
    if (envelope.expectDocumentId !== undefined && envelope.expectDocumentId !== documentId) {
      return executeResponse(
        envelope,
        documentId,
        rejectedExecution(envelope.payload, 'rejected_stale', 'TARGET_STALE')
      );
    }
    const outcome = await host.execute(envelope.payload, entry.controller.signal);
    return executeResponse(envelope, documentId, outcome);
  } finally {
    state.active.delete(envelope.callId);
    state.bySignal.delete(entry.controller.signal);
    remember(state.finished, envelope.callId, TASK_LIMITS.bridgeFinishedCalls);
  }
}

/** The ownership registry is private to this installer; page properties cannot forge its entries. */
export const installTaskBridge: TaskInstallBridgeFn<HTMLElement> = /* @__PURE__ */ (() => {
  const installed = new WeakMap<object, TaskBridgeHandle>();
  return options => {
    try {
      return installBridge(options ?? {}, installed);
    } catch {
      return failureHandle(defaultId('doc'));
    }
  };
})();
