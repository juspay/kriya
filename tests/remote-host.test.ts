/** @jest-environment node */
import { randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createRemoteTaskHost } from '@/agent/RemoteTaskHost';
import { TASK_BRIDGE_PROTOCOL } from '@/types';
import type {
  RemoteTaskHostConfig,
  TaskBridgeEnvelope,
  TaskBridgeHello,
  TaskBridgeMethod,
  TaskCommandRequest,
  TaskCreateRemoteHostFn,
  TaskDocumentInfo,
  TaskExecutionOutcome,
  TaskHost,
  TaskHostError,
  TaskHostResult,
  TaskIdFactory,
  TaskObserveRequest,
  TaskOutcomeCode,
  TaskTransport,
  TaskTransportCall,
  TaskTransportLostReason,
  TaskTransportResult,
} from '@/types';
import { createRedactor, redactEnvelope } from '@/utils/redact';
import {
  FIXTURE_IDS,
  FIXTURE_ORIGIN,
  FIXTURE_URL,
  makeCapabilities,
  makeCommandRequest,
  makeElement,
  makeForm,
  makeHostCommand,
  makeObservation,
  makeOutcome,
  makeScope,
  roundTrip,
} from './helpers/agent-fixtures';

export const seamConformance: { readonly createRemoteTaskHost: TaskCreateRemoteHostFn } = {
  createRemoteTaskHost,
};

// ---------------------------------------------------------------------------------------------
// Scripted fake transport, deterministic timers
// ---------------------------------------------------------------------------------------------

const DOC_A = FIXTURE_IDS.document;
const DOC_B = 'doc_000000000002';
const SESSION = FIXTURE_IDS.session;
const EVIL_ORIGIN = 'https://evil.example.test';
const OBSERVE_REQUEST: TaskObserveRequest = { sessionId: SESSION, minSequence: 3 };

type Recorded = { readonly envelope: TaskBridgeEnvelope; readonly call: TaskTransportCall };
type Rejection = { readonly reject: unknown };
type HandlerResult = TaskTransportResult | Rejection;
type Handler = (
  envelope: TaskBridgeEnvelope,
  call: TaskTransportCall,
  index: number
) => HandlerResult | Promise<HandlerResult>;
type Script = Partial<Record<TaskBridgeMethod, Handler>>;

const isRejection = (value: HandlerResult): value is Rejection =>
  typeof value === 'object' && value !== null && 'reject' in value;

const wire = (envelope: TaskBridgeEnvelope, fields: Record<string, unknown>): TaskTransportResult =>
  ({
    kind: 'response',
    response: {
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: envelope.callId,
      documentId: DOC_A,
      method: envelope.method,
      ...fields,
    },
  }) as unknown as TaskTransportResult;

const reply = (
  envelope: TaskBridgeEnvelope,
  value: unknown,
  documentId: string = DOC_A
): TaskTransportResult => wire(envelope, { documentId, ok: true, value });

const replyError = (
  envelope: TaskBridgeEnvelope,
  error: { readonly code: string; readonly message?: string; readonly retryable?: boolean },
  documentId: string = DOC_A
): TaskTransportResult =>
  wire(envelope, {
    documentId,
    ok: false,
    error: { message: 'page error', retryable: false, ...error },
  });

const lost = (reason: TaskTransportLostReason, message?: string): TaskTransportResult =>
  message === undefined ? { kind: 'lost', reason } : { kind: 'lost', reason, message };

const rejects = (reason: unknown): Rejection => ({ reject: reason });

const helloValue = (overrides: Partial<TaskBridgeHello> = {}): TaskBridgeHello => ({
  documentId: DOC_A,
  url: FIXTURE_URL,
  origin: FIXTURE_ORIGIN,
  ready: true,
  isTop: true,
  capabilities: makeCapabilities({
    hostKind: 'in_page',
    protocol: TASK_BRIDGE_PROTOCOL,
    persistsAcrossNavigation: false,
    detectsNavigation: false,
    authoritativeLocation: false,
  }),
  ...overrides,
});

const replyHello = (envelope: TaskBridgeEnvelope, hello: TaskBridgeHello): TaskTransportResult =>
  reply(envelope, hello, hello.documentId);

const DEFAULT_HANDLERS: Readonly<Record<TaskBridgeMethod, Handler>> = {
  hello: envelope => replyHello(envelope, helloValue()),
  observe: envelope => reply(envelope, makeObservation()),
  execute: envelope => reply(envelope, makeOutcome('applied', 'applied')),
  cancel: envelope => reply(envelope, { found: true, phase: 'before_commit' }),
  release: envelope => reply(envelope, null),
  dispose: envelope => reply(envelope, null),
};

const sequence =
  (...handlers: readonly Handler[]): Handler =>
  (envelope, call, index) => {
    const handler = handlers[Math.min(index, handlers.length - 1)] ?? DEFAULT_HANDLERS.hello;
    return handler(envelope, call, index);
  };

type FakeTransport = {
  readonly transport: TaskTransport;
  readonly calls: Recorded[];
  readonly count: (method: TaskBridgeMethod) => number;
  readonly envelopes: (method: TaskBridgeMethod) => TaskBridgeEnvelope[];
  readonly recorded: (method: TaskBridgeMethod) => Recorded[];
};

const makeTransport = (script: Script = {}, extras: Partial<TaskTransport> = {}): FakeTransport => {
  const calls: Recorded[] = [];
  const counts = new Map<TaskBridgeMethod, number>();
  const invoke: TaskTransport['invoke'] = async (envelope, call) => {
    calls.push({ envelope, call });
    const index = counts.get(envelope.method) ?? 0;
    counts.set(envelope.method, index + 1);
    const handler = script[envelope.method] ?? DEFAULT_HANDLERS[envelope.method];
    const result = await handler(envelope, call, index);
    if (isRejection(result)) {
      throw result.reject;
    }
    return result;
  };
  const recorded = (method: TaskBridgeMethod): Recorded[] =>
    calls.filter(entry => entry.envelope.method === method);
  return {
    transport: { invoke, ...extras },
    calls,
    count: method => recorded(method).length,
    envelopes: method => recorded(method).map(entry => entry.envelope),
    recorded,
  };
};

const flush = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

type Timers = {
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly advance: (ms: number) => Promise<void>;
  readonly slept: number[];
  /** Sleeps that have neither ended nor been aborted. */
  readonly outstanding: () => number;
};

/** Every sleep ends at once and moves the clock by its duration: polling loops run instantly. */
const autoTimers = (): Timers => {
  let now = 0;
  const slept: number[] = [];
  return {
    clock: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    },
    advance: async ms => {
      now += ms;
    },
    slept,
    outstanding: () => 0,
  };
};

/** A sleep ends only when advance() reaches it (or its signal aborts). */
const manualTimers = (): Timers => {
  type Waiter = { readonly at: number; readonly resolve: () => void };
  let now = 0;
  let waiters: Waiter[] = [];
  const slept: number[] = [];
  return {
    clock: () => now,
    sleep: (ms, signal) =>
      new Promise<void>(resolve => {
        slept.push(ms);
        const waiter: Waiter = { at: now + ms, resolve };
        waiters.push(waiter);
        signal?.addEventListener(
          'abort',
          () => {
            waiters = waiters.filter(candidate => candidate !== waiter);
            resolve();
          },
          { once: true }
        );
      }),
    advance: async ms => {
      now += ms;
      const due = waiters.filter(waiter => waiter.at <= now).sort((a, b) => a.at - b.at);
      waiters = waiters.filter(waiter => waiter.at > now);
      due.forEach(waiter => waiter.resolve());
      await flush();
    },
    slept,
    outstanding: () => waiters.length,
  };
};

const callIds = (): TaskIdFactory => {
  let next = 0;
  return prefix => {
    next += 1;
    return `${prefix}_${(0xc0de00000000 + next).toString(16)}`;
  };
};

type BuildOptions = {
  readonly transport?: Partial<TaskTransport>;
  readonly config?: Partial<RemoteTaskHostConfig>;
  readonly timers?: Timers;
};

type Built = { readonly host: TaskHost; readonly fake: FakeTransport; readonly timers: Timers };

const build = (script: Script = {}, options: BuildOptions = {}): Built => {
  const fake = makeTransport(script, options.transport);
  const timers = options.timers ?? autoTimers();
  const host = createRemoteTaskHost({
    transport: fake.transport,
    createId: callIds(),
    clock: timers.clock,
    sleep: timers.sleep,
    ...options.config,
  });
  return { host, fake, timers };
};

const ok = <T>(result: TaskHostResult<T>): T => {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
};

const err = <T>(result: TaskHostResult<T>): TaskHostError => {
  if (result.ok) {
    throw new Error('expected an error result');
  }
  return result.error;
};

const track = <T>(promise: Promise<T>): { settled: boolean } => {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
};

const freshHex = (): string => randomBytes(8).toString('hex');
const freshSecret = (): string => `Zq-${freshHex()}-Mx`;

const fillRequest = (
  value: string,
  overrides: Partial<TaskCommandRequest> = {}
): TaskCommandRequest =>
  makeCommandRequest({
    command: makeHostCommand('FILL', { value, sensitive: true }),
    ...overrides,
  });

const locationAt =
  (url: string, origin: string): NonNullable<TaskTransport['location']> =>
  async () => ({ ok: true, value: { url, origin } });

const hasUndefinedValue = (value: unknown): boolean => {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasUndefinedValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasUndefinedValue);
  }
  return false;
};

const REDACTED_MARK = '[REDACTED]';

describe('independent saved-state observations', () => {
  test.each([false, true])('requires a genuinely new document (no-op refresh: %s)', async noop => {
    let documentId: string = DOC_A;
    const refresh = jest.fn(async () => {
      if (!noop) documentId = DOC_B;
      return { ok: true as const, value: { documentId: DOC_B, url: FIXTURE_URL, ready: true } };
    });
    const fake = makeTransport(
      {
        hello: envelope => replyHello(envelope, helloValue({ documentId })),
        observe: envelope =>
          reply(envelope, makeObservation({ sessionId: SESSION, documentId }), documentId),
      },
      { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN), refresh }
    );
    const host = createRemoteTaskHost({ transport: fake.transport });
    const observed = await host.observe(OBSERVE_REQUEST);
    if (!observed.ok) throw new Error('initial observation unavailable');
    const scope = {
      sessionId: SESSION,
      snapshotId: observed.value.snapshotId,
      documentId: observed.value.documentId,
    };
    const refused = await host.observe({
      ...OBSERVE_REQUEST,
      freshState: { scope: { ...scope, snapshotId: 'old' }, allowedOrigins: [FIXTURE_ORIGIN] },
    });
    expect(refused.ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    const outside = await host.observe({
      ...OBSERVE_REQUEST,
      freshState: { scope, allowedOrigins: [EVIL_ORIGIN] },
    });
    expect(outside.ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    const result = await host.observe({
      ...OBSERVE_REQUEST,
      freshState: { scope, allowedOrigins: [FIXTURE_ORIGIN] },
    });
    expect(result.ok).toBe(!noop);
    expect(refresh).toHaveBeenCalledTimes(1);
    if (result.ok) expect(result.value.documentId).toBe(DOC_B);
    expect(fake.envelopes('observe').every(envelope => !('freshState' in envelope.payload))).toBe(
      true
    );
    await host.dispose();
  });
});

/** Independent exhaustive spec of TaskOutcomeCode: tsc fails here when the union grows or shrinks. */
const OUTCOME_CODE_TABLE: Readonly<Record<TaskOutcomeCode, true>> = {
  INVALID_ACTION: true,
  ELEMENT_NOT_FOUND: true,
  FORM_NOT_REGISTERED: true,
  FORM_NOT_FOUND: true,
  FIELD_NOT_FOUND: true,
  EXECUTION_TIMEOUT: true,
  EXECUTION_FAILED: true,
  NETWORK_ERROR: true,
  PERMISSION_DENIED: true,
  INVALID_CONFIGURATION: true,
  SCREENSHOT_FAILED: true,
  VALIDATION_FAILED: true,
  BROWSER_NOT_SUPPORTED: true,
  EXECUTION_CANCELLED: true,
  TARGET_STALE: true,
  TARGET_AMBIGUOUS: true,
  TARGET_DISABLED: true,
  TARGET_OBSCURED: true,
  NOT_EDITABLE: true,
  NOT_CHECKABLE: true,
  OPTION_NOT_FOUND: true,
  OPTION_AMBIGUOUS: true,
  OPTION_DISABLED: true,
  UNSUPPORTED_STATE: true,
  READBACK_MISMATCH: true,
  HOST_DISPOSED: true,
  HOST_UNAVAILABLE: true,
  HOST_INCAPABLE: true,
  DOCUMENT_CHANGED: true,
  DOCUMENT_LOST: true,
  PROTOCOL_ERROR: true,
  UNSUPPORTED: true,
  OBSERVE_FAILED: true,
  INTERNAL: true,
};

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

describe('createRemoteTaskHost construction', () => {
  it('makes no transport call and sets no timer while it is created', () => {
    const { fake, timers } = build();
    expect(fake.calls).toHaveLength(0);
    expect(timers.slept).toHaveLength(0);
  });

  it('implements location exactly when the transport does', () => {
    expect(build().host.location).toBeUndefined();
    const withLocation = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    expect(typeof withLocation.host.location).toBe('function');
  });

  it('exposes the host surface: capabilities, observe, execute, release, dispose', () => {
    const { host } = build();
    expect(typeof host.capabilities).toBe('function');
    expect(typeof host.observe).toBe('function');
    expect(typeof host.execute).toBe('function');
    expect(typeof host.release).toBe('function');
    expect(typeof host.dispose).toBe('function');
  });

  it('does not close the transport it was given', async () => {
    const close = jest.fn(async () => undefined);
    const { host } = build({}, { transport: { close } });
    await host.capabilities();
    await host.dispose();
    expect(close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------------------------

describe('capabilities', () => {
  it('sends one hello envelope: protocol constant, unique callId, empty payload, default timeout', async () => {
    const { host, fake } = build();
    ok(await host.capabilities());
    expect(fake.calls).toHaveLength(1);
    const first = fake.calls[0];
    expect(first?.envelope).toEqual({
      protocol: TASK_BRIDGE_PROTOCOL,
      callId: 'req_c0de00000001',
      method: 'hello',
      payload: {},
    });
    expect(first?.call.timeoutMs).toBe(10000);
  });

  it('gives every transport call the configured callTimeoutMs', async () => {
    const { host, fake } = build({}, { config: { callTimeoutMs: 1234 } });
    ok(await host.capabilities());
    expect(fake.calls[0]?.call.timeoutMs).toBe(1234);
  });

  it('uses the default createId (req_<12 hex>) with a distinct callId for every envelope', async () => {
    const fake = makeTransport({}, { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) });
    const host = createRemoteTaskHost({ transport: fake.transport });
    ok(await host.capabilities());
    ok(await host.observe(OBSERVE_REQUEST));
    await host.execute(makeCommandRequest());
    await host.execute(makeCommandRequest());
    await host.release?.(SESSION);
    const ids = fake.calls.map(entry => entry.envelope.callId);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    ids.forEach(id => expect(id).toMatch(/^req_[0-9a-f]{12}$/));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports hostKind remote and overrides persistence and navigation detection', async () => {
    const page = makeCapabilities({
      hostKind: 'in_page',
      protocol: TASK_BRIDGE_PROTOCOL,
      persistsAcrossNavigation: false,
      detectsNavigation: false,
      authoritativeLocation: false,
    });
    const { host } = build({ hello: env => replyHello(env, helloValue({ capabilities: page })) });
    const capabilities = ok(await host.capabilities());
    expect(capabilities.hostKind).toBe('remote');
    expect(capabilities.persistsAcrossNavigation).toBe(true);
    expect(capabilities.detectsNavigation).toBe(true);
    expect(capabilities.protocol).toBe(TASK_BRIDGE_PROTOCOL);
  });

  it('takes authoritativeLocation from the transport, not from the page', async () => {
    const lying = makeCapabilities({ protocol: TASK_BRIDGE_PROTOCOL, authoritativeLocation: true });
    const hello: Script = { hello: env => replyHello(env, helloValue({ capabilities: lying })) };
    expect(ok(await build(hello).host.capabilities()).authoritativeLocation).toBe(false);
    const located = build(hello, {
      transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) },
    });
    expect(ok(await located.host.capabilities()).authoritativeLocation).toBe(true);
    const honest = makeCapabilities({
      protocol: TASK_BRIDGE_PROTOCOL,
      authoritativeLocation: false,
    });
    const overridden = build(
      { hello: env => replyHello(env, helloValue({ capabilities: honest })) },
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    expect(ok(await overridden.host.capabilities()).authoritativeLocation).toBe(true);
  });

  it('keeps the reported cancellation unless the transport is not concurrent', async () => {
    const cooperative = makeCapabilities({
      protocol: TASK_BRIDGE_PROTOCOL,
      cancellation: 'cooperative',
    });
    const none = makeCapabilities({ protocol: TASK_BRIDGE_PROTOCOL, cancellation: 'none' });
    const script = (capabilities: ReturnType<typeof makeCapabilities>): Script => ({
      hello: env => replyHello(env, helloValue({ capabilities })),
    });
    expect(ok(await build(script(cooperative)).host.capabilities()).cancellation).toBe(
      'cooperative'
    );
    expect(
      ok(await build(script(cooperative), { transport: { concurrent: true } }).host.capabilities())
        .cancellation
    ).toBe('cooperative');
    expect(ok(await build(script(none)).host.capabilities()).cancellation).toBe('none');
    expect(
      ok(await build(script(cooperative), { transport: { concurrent: false } }).host.capabilities())
        .cancellation
    ).toBe('none');
    expect(
      ok(await build(script(none), { transport: { concurrent: false } }).host.capabilities())
        .cancellation
    ).toBe('none');
  });

  it('passes redaction, strictTargets and the other page flags through as reported', async () => {
    const page = makeCapabilities({
      protocol: TASK_BRIDGE_PROTOCOL,
      strictTargets: false,
      redaction: { observations: false, executionEvents: true },
      isolatedWorld: true,
      scrollContainers: false,
      implicitSubmitDetection: false,
      maxElements: 77,
    });
    const { host } = build({ hello: env => replyHello(env, helloValue({ capabilities: page })) });
    const capabilities = ok(await host.capabilities());
    expect(capabilities.strictTargets).toBe(false);
    expect(capabilities.redaction).toEqual({ observations: false, executionEvents: true });
    expect(capabilities.isolatedWorld).toBe(true);
    expect(capabilities.scrollContainers).toBe(false);
    expect(capabilities.implicitSubmitDetection).toBe(false);
    expect(capabilities.maxElements).toBe(77);
    expect(capabilities.operations).toEqual(page.operations);
    expect(capabilities.keys).toEqual(page.keys);
  });

  it('is JSON-safe', async () => {
    const { host } = build();
    const capabilities = ok(await host.capabilities());
    expect(roundTrip(capabilities)).toEqual(capabilities);
    expect(hasUndefinedValue(capabilities)).toBe(false);
  });

  it('caches hello per document: a second capabilities call sends no envelope', async () => {
    const { host, fake } = build();
    ok(await host.capabilities());
    ok(await host.capabilities());
    expect(fake.count('hello')).toBe(1);
  });

  it('waits for ready: polls hello every pollIntervalMs until the document is ready', async () => {
    const { host, fake, timers } = build({
      hello: sequence(
        env => replyHello(env, helloValue({ ready: false })),
        env => replyHello(env, helloValue({ ready: false })),
        env => replyHello(env, helloValue())
      ),
    });
    ok(await host.capabilities());
    expect(fake.count('hello')).toBe(3);
    expect(timers.slept).toEqual([50, 50]);
  });

  it('honors a configured pollIntervalMs', async () => {
    const { host, timers } = build(
      {
        hello: sequence(
          env => replyHello(env, helloValue({ ready: false })),
          env => replyHello(env, helloValue())
        ),
      },
      { config: { pollIntervalMs: 7 } }
    );
    ok(await host.capabilities());
    expect(timers.slept).toEqual([7]);
  });

  it('waits for isTop as well as ready', async () => {
    const { host, fake } = build({
      hello: sequence(
        env => replyHello(env, helloValue({ isTop: false })),
        env => replyHello(env, helloValue())
      ),
    });
    ok(await host.capabilities());
    expect(fake.count('hello')).toBe(2);
  });

  it('gives up after navigationTimeoutMs with a retryable DOCUMENT_LOST', async () => {
    const { host, fake } = build(
      { hello: env => replyHello(env, helloValue({ ready: false })) },
      { config: { navigationTimeoutMs: 200, pollIntervalMs: 50 } }
    );
    const error = err(await host.capabilities());
    expect(error).toMatchObject({ code: 'DOCUMENT_LOST', retryable: true });
    expect(fake.count('hello')).toBe(5);
  });

  it('terminates against a clock that never moves (bounded attempts)', async () => {
    const frozen: Timers = { ...autoTimers(), clock: () => 0, sleep: async () => undefined };
    const { host, fake } = build(
      { hello: env => replyHello(env, helloValue({ ready: false })) },
      { timers: frozen, config: { navigationTimeoutMs: 200, pollIntervalMs: 50 } }
    );
    const error = err(await host.capabilities());
    expect(error.code).toBe('DOCUMENT_LOST');
    expect(fake.count('hello')).toBe(5);
  });

  it.each<[string, TaskTransportLostReason]>([
    ['a navigation in flight', 'navigated'],
    ['a timeout', 'timeout'],
    ['a transport error', 'error'],
    ['a closed page', 'closed'],
  ])('treats hello lost by %s as transient and polls on', async (_name, reason) => {
    const { host, fake } = build({
      hello: sequence(
        () => lost(reason, 'blip'),
        env => replyHello(env, helloValue())
      ),
    });
    ok(await host.capabilities());
    expect(fake.count('hello')).toBe(2);
  });

  it('handles a rejecting transport as a lost call and recovers', async () => {
    const { host, fake } = build({
      hello: sequence(
        () => rejects(new Error('socket hang up')),
        env => replyHello(env, helloValue())
      ),
    });
    ok(await host.capabilities());
    expect(fake.count('hello')).toBe(2);
  });

  it('survives a transport that throws synchronously', async () => {
    const transport: TaskTransport = {
      invoke: () => {
        throw new Error('sync boom');
      },
    };
    const timers = autoTimers();
    const host = createRemoteTaskHost({
      transport,
      createId: callIds(),
      clock: timers.clock,
      sleep: timers.sleep,
      navigationTimeoutMs: 100,
      pollIntervalMs: 50,
    });
    const error = err(await host.capabilities());
    expect(error.code).toBe('DOCUMENT_LOST');
  });

  it('polls through a retryable page error, but not through a non-retryable one', async () => {
    const retryable = build({
      hello: sequence(
        env => replyError(env, { code: 'HOST_UNAVAILABLE', retryable: true }),
        env => replyHello(env, helloValue())
      ),
    });
    ok(await retryable.host.capabilities());
    expect(retryable.fake.count('hello')).toBe(2);

    const hijacked = build({
      hello: env => replyError(env, { code: 'HOST_UNAVAILABLE', retryable: false }),
    });
    expect(err(await hijacked.host.capabilities())).toMatchObject({
      code: 'HOST_UNAVAILABLE',
      retryable: false,
    });
    expect(hijacked.fake.count('hello')).toBe(1);

    const disposed = build({
      hello: env => replyError(env, { code: 'HOST_DISPOSED', retryable: false }),
    });
    expect(err(await disposed.host.capabilities()).code).toBe('HOST_DISPOSED');
    expect(disposed.fake.count('hello')).toBe(1);
  });

  const MALFORMED_HELLOS: readonly (readonly [string, Handler])[] = [
    ['an empty documentId', env => reply(env, helloValue({ documentId: '' }))],
    ['a numeric documentId', env => reply(env, { ...helloValue(), documentId: 42 })],
    ['a missing documentId', env => reply(env, { ...helloValue(), documentId: undefined })],
    [
      'a capabilities protocol mismatch',
      env =>
        reply(env, helloValue({ capabilities: makeCapabilities({ protocol: 'kriya.task.v0' }) })),
    ],
    [
      'a envelope protocol mismatch',
      env => wire(env, { protocol: 'kriya.task.v2', ok: true, value: helloValue() }),
    ],
    [
      'a foreign callId',
      env => wire(env, { callId: 'req_foreign', ok: true, value: helloValue() }),
    ],
    ['a foreign method', env => wire(env, { method: 'observe', ok: true, value: helloValue() })],
    [
      'an empty response documentId',
      env => wire(env, { documentId: '', ok: true, value: helloValue() }),
    ],
    ['a non-object value', env => reply(env, 'hello')],
    ['a null value', env => reply(env, null)],
    ['a non-boolean ready', env => reply(env, { ...helloValue(), ready: 'yes' })],
    ['a missing origin', env => reply(env, { ...helloValue(), origin: undefined })],
    [
      'capabilities without operations',
      env => reply(env, { ...helloValue(), capabilities: { protocol: TASK_BRIDGE_PROTOCOL } }),
    ],
    ['a garbage transport result', () => ({ kind: 'nonsense' }) as unknown as TaskTransportResult],
    ['a null transport result', () => null as unknown as TaskTransportResult],
  ];

  it.each(MALFORMED_HELLOS)('answers PROTOCOL_ERROR for %s, once', async (_name, handler) => {
    const { host, fake } = build({ hello: handler });
    const error = err(await host.capabilities());
    expect(error.code).toBe('PROTOCOL_ERROR');
    expect(fake.count('hello')).toBe(1);
  });

  it('answers CANCELLED without a transport call for an aborted signal', async () => {
    const { host, fake } = build();
    const controller = new AbortController();
    controller.abort();
    expect(err(await host.capabilities(controller.signal)).code).toBe('CANCELLED');
    expect(fake.calls).toHaveLength(0);
  });

  it('answers CANCELLED when the signal aborts while hello is in flight', async () => {
    const controller = new AbortController();
    const { host, fake } = build({
      hello: (_env, call) =>
        new Promise<TaskTransportResult>(resolve => {
          call.signal?.addEventListener('abort', () => resolve(lost('error')), { once: true });
        }),
    });
    const pending = host.capabilities(controller.signal);
    await flush();
    controller.abort();
    expect(err(await pending).code).toBe('CANCELLED');
    expect(fake.count('hello')).toBe(1);
  });

  it('hands the caller signal to the hello call', async () => {
    const controller = new AbortController();
    const { host, fake } = build();
    ok(await host.capabilities(controller.signal));
    expect(fake.calls[0]?.call.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------------------------
// location
// ---------------------------------------------------------------------------------------------

describe('location', () => {
  const located = (
    url: string = FIXTURE_URL,
    origin: string = FIXTURE_ORIGIN,
    script: Script = {}
  ): Built => build(script, { transport: { location: locationAt(url, origin) } });

  const locationOf = (built: Built): NonNullable<TaskHost['location']> => {
    const fn = built.host.location;
    if (fn === undefined) {
      throw new Error('host has no location');
    }
    return fn;
  };

  it('returns the controller location with its url redacted and the origin intact', async () => {
    const token = `${freshHex()}${freshHex()}${freshHex()}`;
    const url = `https://user:pw@shop.example.test/cart?session_token=${token}&page=2#frag`;
    const built = located(url, FIXTURE_ORIGIN);
    const value = ok(await locationOf(built)());
    expect(value.origin).toBe(FIXTURE_ORIGIN);
    expect(value.url).toBe(createRedactor().redactUrl(url));
    expect(value.url).not.toContain(token);
    expect(value.url).not.toContain('user:pw');
    expect(value.url).not.toContain('#frag');
    expect(value.url).toContain('page=2');
  });

  it('compares the controller origin with a fresh hello every time', async () => {
    const built = located();
    ok(await locationOf(built)());
    ok(await locationOf(built)());
    expect(built.fake.count('hello')).toBe(2);
  });

  it('is PROTOCOL_ERROR when the page reports a different origin, naming no content', async () => {
    const built = located(FIXTURE_URL, FIXTURE_ORIGIN, {
      hello: env => replyHello(env, helloValue({ origin: EVIL_ORIGIN })),
    });
    const error = err(await locationOf(built)());
    expect(error.code).toBe('PROTOCOL_ERROR');
    expect(error.message).not.toContain('evil');
    expect(error.message).not.toContain('shop.example');
  });

  it('still answers the controller location while the page has no ready hello', async () => {
    const built = located(FIXTURE_URL, FIXTURE_ORIGIN, {
      hello: () => lost('navigated'),
    });
    expect(ok(await locationOf(built)()).origin).toBe(FIXTURE_ORIGIN);
  });

  it('reports a broken hello (not a transient one) as PROTOCOL_ERROR', async () => {
    const built = located(FIXTURE_URL, FIXTURE_ORIGIN, {
      hello: env => reply(env, helloValue({ documentId: '' })),
    });
    expect(err(await locationOf(built)()).code).toBe('PROTOCOL_ERROR');
  });

  it('passes a failing controller location through as the error', async () => {
    const secret = freshSecret();
    const built = build(
      {},
      {
        transport: {
          location: async () => ({
            ok: false,
            error: {
              code: 'INTERNAL',
              message: `page.url() failed near ${secret}`,
              retryable: true,
            },
          }),
        },
      }
    );
    const error = err(await locationOf(built)());
    expect(error.code).toBe('INTERNAL');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('page.url() failed');
    expect(built.fake.count('hello')).toBe(0);
  });

  it('handles a rejecting location as an error result', async () => {
    const built = build(
      {},
      {
        transport: {
          location: async () => {
            throw new Error('cdp detached');
          },
        },
      }
    );
    const error = err(await locationOf(built)());
    expect(error.code).toBe('HOST_UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('answers a malformed controller location as PROTOCOL_ERROR', async () => {
    const built = build(
      {},
      {
        transport: {
          location: (async () => ({ ok: true, value: { url: 5 } })) as unknown as NonNullable<
            TaskTransport['location']
          >,
        },
      }
    );
    expect(err(await locationOf(built)()).code).toBe('PROTOCOL_ERROR');
  });

  it('gives the location call the configured timeout and the signal', async () => {
    const seen: TaskTransportCall[] = [];
    const controller = new AbortController();
    const built = build(
      {},
      {
        config: { callTimeoutMs: 4321 },
        transport: {
          location: async call => {
            seen.push(call);
            return { ok: true, value: { url: FIXTURE_URL, origin: FIXTURE_ORIGIN } };
          },
        },
      }
    );
    ok(await locationOf(built)(controller.signal));
    expect(seen[0]?.timeoutMs).toBe(4321);
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it('answers CANCELLED for an aborted signal and HOST_DISPOSED after dispose', async () => {
    const built = located();
    const controller = new AbortController();
    controller.abort();
    expect(err(await locationOf(built)(controller.signal)).code).toBe('CANCELLED');
    await built.host.dispose();
    expect(err(await locationOf(built)()).code).toBe('HOST_DISPOSED');
  });
});

// ---------------------------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------------------------

describe('observe', () => {
  it('ensures a document, then sends observe with expectDocumentId and the request as payload', async () => {
    const { host, fake } = build();
    const observation = ok(await host.observe(OBSERVE_REQUEST));
    expect(observation.documentId).toBe(DOC_A);
    expect(fake.calls.map(entry => entry.envelope.method)).toEqual(['hello', 'observe']);
    const envelope = fake.envelopes('observe')[0];
    expect(envelope?.protocol).toBe(TASK_BRIDGE_PROTOCOL);
    expect(envelope?.payload).toEqual(OBSERVE_REQUEST);
    expect(envelope?.expectDocumentId).toBe(DOC_A);
    expect(fake.recorded('observe')[0]?.call.timeoutMs).toBe(10000);
  });

  it('does not mutate the request it forwards', async () => {
    const request: TaskObserveRequest = {
      sessionId: SESSION,
      minSequence: 9,
      options: { includeText: true },
    };
    const before = JSON.stringify(request);
    const { host } = build();
    ok(await host.observe(request));
    expect(JSON.stringify(request)).toBe(before);
  });

  it('reuses the cached hello across observations of one document', async () => {
    const { host, fake } = build();
    ok(await host.observe(OBSERVE_REQUEST));
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(1);
    expect(fake.count('observe')).toBe(2);
  });

  it('redacts the observation url and returns the rest unchanged', async () => {
    const token = `${freshHex()}${freshHex()}${freshHex()}`;
    const raw = makeObservation({ url: `${FIXTURE_ORIGIN}/cart?api_token=${token}#section` });
    const { host } = build({ observe: env => reply(env, raw) });
    const observation = ok(await host.observe(OBSERVE_REQUEST));
    expect(observation.url).toBe(createRedactor().redactUrl(raw.url));
    expect(observation.url).not.toContain(token);
    expect(observation.url).not.toContain('#section');
    expect({ ...observation, url: raw.url }).toEqual(raw);
  });

  it('refreshes hello and retries on DOCUMENT_CHANGED, tracking the new document id', async () => {
    const { host, fake } = build({
      hello: sequence(
        env => replyHello(env, helloValue()),
        env => replyHello(env, helloValue({ documentId: DOC_B }))
      ),
      observe: sequence(
        env => replyError(env, { code: 'DOCUMENT_CHANGED', retryable: true }, DOC_B),
        env => reply(env, makeObservation({ documentId: DOC_B }), DOC_B)
      ),
    });
    const observation = ok(await host.observe(OBSERVE_REQUEST));
    expect(observation.documentId).toBe(DOC_B);
    expect(fake.envelopes('observe').map(envelope => envelope.expectDocumentId)).toEqual([
      DOC_A,
      DOC_B,
    ]);
    expect(fake.count('hello')).toBe(2);
  });

  it('retries a lost observe call after refreshing hello', async () => {
    const { host, fake } = build({
      observe: sequence(
        () => lost('navigated'),
        env => reply(env, makeObservation())
      ),
    });
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('observe')).toBe(2);
    expect(fake.count('hello')).toBe(2);
  });

  it('retries a rejecting transport as a lost call', async () => {
    const { host, fake } = build({
      observe: sequence(
        () => rejects(new Error('Execution context was destroyed')),
        env => reply(env, makeObservation())
      ),
    });
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('observe')).toBe(2);
  });

  it('retries at most twice: three observe calls, then the last error', async () => {
    const { host, fake } = build({
      observe: env =>
        replyError(env, { code: 'DOCUMENT_CHANGED', message: 'moved', retryable: true }, DOC_B),
    });
    const error = err(await host.observe(OBSERVE_REQUEST));
    expect(error).toMatchObject({ code: 'DOCUMENT_CHANGED', retryable: true });
    expect(fake.count('observe')).toBe(3);
    expect(fake.count('hello')).toBe(3);
  });

  it('retries a persistently lost observe at most twice', async () => {
    const { host, fake } = build({ observe: () => lost('timeout') });
    const error = err(await host.observe(OBSERVE_REQUEST));
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
    expect(fake.count('observe')).toBe(3);
  });

  it('does not retry a closed page', async () => {
    const { host, fake } = build({
      observe: () => lost('closed', 'Target page, context or browser has been closed'),
    });
    const error = err(await host.observe(OBSERVE_REQUEST));
    expect(error.retryable).toBe(false);
    expect(fake.count('observe')).toBe(1);
  });

  it('returns another page error at once, keeping code and retryable and scrubbing the message', async () => {
    const { host, fake } = build({
      observe: env =>
        replyError(env, { code: 'OBSERVE_FAILED', message: 'could not observe', retryable: true }),
    });
    const error = err(await host.observe(OBSERVE_REQUEST));
    expect(error).toEqual({
      code: 'OBSERVE_FAILED',
      message: 'could not observe',
      retryable: true,
    });
    expect(fake.count('observe')).toBe(1);
  });

  it('turns an unknown page error code into INTERNAL', async () => {
    const { host } = build({ observe: env => replyError(env, { code: 'WEIRD_CODE' }) });
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('INTERNAL');
  });

  it('answers PROTOCOL_ERROR for a protocol mismatch or a malformed observation', async () => {
    const mismatch = build({
      observe: env => wire(env, { protocol: 'kriya.task.v2', ok: true, value: makeObservation() }),
    });
    expect(err(await mismatch.host.observe(OBSERVE_REQUEST)).code).toBe('PROTOCOL_ERROR');
    expect(mismatch.fake.count('observe')).toBe(1);
    for (const value of [null, 'page', { url: 5 }, { ...makeObservation(), elements: 'none' }]) {
      const malformed = build({ observe: env => reply(env, value) });
      expect(err(await malformed.host.observe(OBSERVE_REQUEST)).code).toBe('PROTOCOL_ERROR');
    }
  });

  it('answers CANCELLED for an aborted signal without a transport call', async () => {
    const { host, fake } = build();
    const controller = new AbortController();
    controller.abort();
    expect(err(await host.observe(OBSERVE_REQUEST, controller.signal)).code).toBe('CANCELLED');
    expect(fake.calls).toHaveLength(0);
  });

  it('answers CANCELLED when the signal aborts mid-call and does not retry', async () => {
    const controller = new AbortController();
    const { host, fake } = build({
      observe: (_env, call) =>
        new Promise<TaskTransportResult>(resolve => {
          call.signal?.addEventListener('abort', () => resolve(lost('error')), { once: true });
        }),
    });
    const pending = host.observe(OBSERVE_REQUEST, controller.signal);
    await flush();
    controller.abort();
    expect(err(await pending).code).toBe('CANCELLED');
    expect(fake.count('observe')).toBe(1);
  });

  it('answers HOST_DISPOSED after dispose without a transport call', async () => {
    const { host, fake } = build();
    await host.dispose();
    const before = fake.calls.length;
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('HOST_DISPOSED');
    expect(fake.calls).toHaveLength(before);
  });

  describe('with an authoritative location', () => {
    it('observes when the controller origin equals the hello origin', async () => {
      const seen = jest.fn(locationAt(FIXTURE_URL, FIXTURE_ORIGIN));
      const { host, fake } = build({}, { transport: { location: seen } });
      ok(await host.observe(OBSERVE_REQUEST));
      expect(fake.count('observe')).toBe(1);
      expect(seen).toHaveBeenCalledTimes(1);
    });

    it('is PROTOCOL_ERROR, sending no observe, when the page lies about its origin', async () => {
      const { host, fake } = build(
        { hello: env => replyHello(env, helloValue({ origin: EVIL_ORIGIN })) },
        { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
      );
      const error = err(await host.observe(OBSERVE_REQUEST));
      expect(error.code).toBe('PROTOCOL_ERROR');
      expect(error.message).not.toContain('evil');
      expect(fake.count('observe')).toBe(0);
      expect(fake.count('hello')).toBe(2);
    });

    it('refreshes a stale hello once: a legitimate cross-origin navigation is not an error', async () => {
      const second = 'https://other.example.test';
      let controllerOrigin = FIXTURE_ORIGIN;
      const { host, fake } = build(
        {
          hello: sequence(
            env => replyHello(env, helloValue()),
            env =>
              replyHello(env, helloValue({ documentId: DOC_B, origin: second, url: `${second}/` }))
          ),
          observe: sequence(
            env => reply(env, makeObservation()),
            env => reply(env, makeObservation({ documentId: DOC_B, url: `${second}/` }), DOC_B)
          ),
        },
        {
          transport: {
            location: async () => ({
              ok: true,
              value: { url: `${controllerOrigin}/`, origin: controllerOrigin },
            }),
          },
        }
      );
      ok(await host.observe(OBSERVE_REQUEST));
      controllerOrigin = second;
      const observation = ok(await host.observe(OBSERVE_REQUEST));
      expect(observation.documentId).toBe(DOC_B);
      expect(fake.count('hello')).toBe(2);
      expect(fake.envelopes('observe')[1]?.expectDocumentId).toBe(DOC_B);
    });

    it('returns a failing controller location as the error and sends no observe', async () => {
      const { host, fake } = build(
        {},
        {
          transport: {
            location: async () => ({
              ok: false,
              error: { code: 'HOST_UNAVAILABLE', message: 'no page', retryable: true },
            }),
          },
        }
      );
      expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('HOST_UNAVAILABLE');
      expect(fake.count('observe')).toBe(0);
    });

    it('rejects an observation whose origin disagrees with the controller', async () => {
      const lying = makeObservation({ url: `${EVIL_ORIGIN}/phish` });
      const { host } = build(
        { observe: env => reply(env, lying) },
        { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
      );
      const error = err(await host.observe(OBSERVE_REQUEST));
      expect(error.code).toBe('PROTOCOL_ERROR');
      expect(JSON.stringify(error)).not.toContain('phish');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// execute: envelope, outcome handling
// ---------------------------------------------------------------------------------------------

describe('execute', () => {
  it('sends one execute envelope: expectDocumentId from the scope, timeout formula, request payload', async () => {
    const request = makeCommandRequest({
      scope: makeScope({ documentId: DOC_B }),
      timeoutMs: 3000,
      settle: { quietMs: 100, maxMs: 500 },
    });
    const { host, fake } = build();
    await host.execute(request);
    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0];
    expect(sent?.envelope.method).toBe('execute');
    expect(sent?.envelope.payload).toEqual(request);
    expect(sent?.envelope.expectDocumentId).toBe(DOC_B);
    expect(sent?.call.timeoutMs).toBe(5500);
  });

  it('uses the default timeout budget: executionMs + settle.maxMs + 2000', async () => {
    const { host, fake } = build();
    await host.execute(makeCommandRequest());
    expect(fake.recorded('execute')[0]?.call.timeoutMs).toBe(8000 + 2000 + 2000);
  });

  it('gives a repeated send of one command a new callId and keeps its requestId', async () => {
    const request = makeCommandRequest();
    const { host, fake } = build();
    await host.execute(request);
    await host.execute(request);
    const [first, second] = fake.envelopes('execute');
    expect(first?.callId).not.toBe(second?.callId);
    expect((first?.payload as TaskCommandRequest).requestId).toBe(request.requestId);
    expect((second?.payload as TaskCommandRequest).requestId).toBe(request.requestId);
  });

  it('delivers the raw FILL value to the page, while redactEnvelope hides it from logs', async () => {
    const secret = freshSecret();
    const { host, fake } = build();
    await host.execute(fillRequest(secret));
    const envelope = fake.envelopes('execute')[0];
    expect(JSON.stringify(envelope)).toContain(secret);
    expect(JSON.stringify(redactEnvelope(envelope as TaskBridgeEnvelope))).not.toContain(secret);
  });

  const VALID_OUTCOMES: readonly (readonly [string, TaskExecutionOutcome])[] = [
    [
      'applied/applied',
      makeOutcome('applied', 'applied', { readback: { kind: 'click', defaultPrevented: false } }),
    ],
    [
      'applied/none',
      makeOutcome('applied', 'none', { readback: { kind: 'read', text: 'Orders ship soon' } }),
    ],
    ['noop_already_satisfied/none', makeOutcome('noop_already_satisfied', 'none')],
    [
      'rejected_stale/none',
      makeOutcome('rejected_stale', 'none', { staleReason: 'document_changed' }),
    ],
    ['rejected_invalid/none', makeOutcome('rejected_invalid', 'none', { code: 'INVALID_ACTION' })],
    ['rejected_scope/none', makeOutcome('rejected_scope', 'none', { code: 'PERMISSION_DENIED' })],
    [
      'failed/none',
      makeOutcome('failed', 'none', { code: 'TARGET_DISABLED', message: 'disabled' }),
    ],
    ['failed/applied', makeOutcome('failed', 'applied', { code: 'READBACK_MISMATCH' })],
    ['uncertain/uncertain', makeOutcome('uncertain', 'uncertain', { code: 'EXECUTION_TIMEOUT' })],
    [
      'navigated/applied',
      makeOutcome('navigated', 'applied', {
        navigation: {
          kind: 'same_document',
          fromDocumentId: DOC_A,
          fromUrl: `${FIXTURE_ORIGIN}/cart`,
          toUrl: `${FIXTURE_ORIGIN}/cart?step=2`,
          realmLost: false,
        },
      }),
    ],
    [
      'navigated/uncertain',
      makeOutcome('navigated', 'uncertain', {
        navigation: {
          kind: 'document',
          fromDocumentId: DOC_A,
          toDocumentId: DOC_B,
          fromUrl: `${FIXTURE_ORIGIN}/cart`,
          toUrl: `${FIXTURE_ORIGIN}/orders`,
          realmLost: true,
        },
      }),
    ],
  ];

  it.each(VALID_OUTCOMES)('returns the page outcome %s as is', async (_name, sent) => {
    const request = makeCommandRequest();
    const { host } = build({ execute: env => reply(env, sent) });
    const outcome = await host.execute(request);
    expect(outcome).toEqual(sent);
    expect(hasUndefinedValue(outcome)).toBe(false);
  });

  it('drops fields the contract does not define, so a page cannot smuggle text through', async () => {
    const secret = freshSecret();
    const sent = { ...makeOutcome('applied', 'applied'), debug: secret, extra: { value: secret } };
    const { host } = build({ execute: env => reply(env, sent) });
    const outcome = await host.execute(fillRequest(secret));
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(Object.keys(outcome).sort()).toEqual(['durationMs', 'effect', 'requestId', 'status']);
  });

  it('fills in requestId and durationMs when the page omits them', async () => {
    const request = makeCommandRequest({ requestId: 'req_commandid01' });
    const { host } = build({
      execute: env => reply(env, { status: 'applied', effect: 'applied' }),
    });
    const outcome = await host.execute(request);
    expect(outcome.requestId).toBe('req_commandid01');
    expect(typeof outcome.durationMs).toBe('number');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('scrubs the FILL value from an outcome message and redacts navigation urls', async () => {
    const secret = freshSecret();
    const token = `${freshHex()}${freshHex()}${freshHex()}`;
    const sent = makeOutcome('navigated', 'applied', {
      message: `field rejected ${secret}`,
      navigation: {
        kind: 'same_document',
        fromDocumentId: DOC_A,
        fromUrl: `https://u:p@shop.example.test/a?access_token=${token}#x`,
        toUrl: `${FIXTURE_ORIGIN}/search?q=${encodeURIComponent(secret)}`,
        realmLost: false,
      },
    });
    const { host } = build({ execute: env => reply(env, sent) });
    const outcome = await host.execute(fillRequest(secret));
    const json = JSON.stringify(outcome);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(encodeURIComponent(secret));
    expect(json).not.toContain(token);
    expect(json).not.toContain('u:p@');
    expect(outcome.message).toContain(REDACTED_MARK);
    expect(outcome.navigation?.toUrl).toContain(REDACTED_MARK);
  });

  it('scrubs the FILL value from READ text too', async () => {
    const secret = freshSecret();
    const sent = makeOutcome('applied', 'none', {
      readback: { kind: 'read', text: `echo ${secret}` },
    });
    const { host } = build({ execute: env => reply(env, sent) });
    const outcome = await host.execute(fillRequest(secret));
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('maps ok:false HOST_UNAVAILABLE to failed/none and every other error to uncertain', async () => {
    const unavailable = build({
      execute: env =>
        replyError(env, { code: 'HOST_UNAVAILABLE', message: 'not ready', retryable: true }),
    });
    expect(await unavailable.host.execute(makeCommandRequest())).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'HOST_UNAVAILABLE',
      message: 'not ready',
    });
    for (const code of ['INTERNAL', 'OBSERVE_FAILED', 'PROTOCOL_ERROR', 'DOCUMENT_LOST']) {
      const other = build({ execute: env => replyError(env, { code }) });
      expect(await other.host.execute(makeCommandRequest())).toMatchObject({
        status: 'uncertain',
        effect: 'uncertain',
        code,
      });
    }
  });

  it('reports page TIMEOUT and CANCELLED errors under the execute codes', async () => {
    const timeout = build({ execute: env => replyError(env, { code: 'TIMEOUT' }) });
    expect(await timeout.host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_TIMEOUT',
    });
    const cancelled = build({ execute: env => replyError(env, { code: 'CANCELLED' }) });
    expect(await cancelled.host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_CANCELLED',
    });
  });

  it('scrubs the FILL value from an ok:false error message', async () => {
    const secret = freshSecret();
    const { host } = build({
      execute: env => replyError(env, { code: 'INTERNAL', message: `bad value ${secret} here` }),
    });
    const outcome = await host.execute(fillRequest(secret));
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(outcome.message).toContain(REDACTED_MARK);
  });

  it('answers uncertain/PROTOCOL_ERROR when the execute response violates the protocol', async () => {
    const mismatches: readonly Handler[] = [
      env =>
        wire(env, {
          protocol: 'kriya.task.v2',
          ok: true,
          value: makeOutcome('applied', 'applied'),
        }),
      env =>
        wire(env, { callId: 'req_foreign', ok: true, value: makeOutcome('applied', 'applied') }),
      env => wire(env, { method: 'observe', ok: true, value: makeOutcome('applied', 'applied') }),
      env => wire(env, { documentId: '', ok: true, value: makeOutcome('applied', 'applied') }),
      () => ({ kind: 'nonsense' }) as unknown as TaskTransportResult,
    ];
    for (const handler of mismatches) {
      const { host, fake } = build({ execute: handler });
      expect(await host.execute(makeCommandRequest())).toMatchObject({
        status: 'uncertain',
        effect: 'uncertain',
        code: 'PROTOCOL_ERROR',
      });
      expect(fake.count('execute')).toBe(1);
    }
  });

  it.each<[string, unknown]>([
    ['an impossible pair applied/uncertain', { status: 'applied', effect: 'uncertain' }],
    ['noop_already_satisfied/applied', { status: 'noop_already_satisfied', effect: 'applied' }],
    ['failed/uncertain', { status: 'failed', effect: 'uncertain' }],
    ['uncertain/none', { status: 'uncertain', effect: 'none' }],
    ['rejected_stale/applied', { status: 'rejected_stale', effect: 'applied' }],
    ['navigated/none', { status: 'navigated', effect: 'none' }],
    ['an unknown status', { status: 'done', effect: 'applied' }],
    ['an unknown effect', { status: 'applied', effect: 'maybe' }],
    ['a missing effect', { status: 'applied' }],
    ['a non-object value', 'applied'],
    ['a null value', null],
    [
      'a malformed navigation',
      { status: 'navigated', effect: 'uncertain', navigation: { kind: 'teleport' } },
    ],
  ])('answers uncertain/PROTOCOL_ERROR for %s', async (_name, value) => {
    const { host } = build({ execute: env => reply(env, value) });
    expect(await host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'PROTOCOL_ERROR',
    });
  });

  it('never rejects: a request that is not an object is a failed/none outcome', async () => {
    const { host, fake } = build();
    const outcome = await host.execute(undefined as unknown as TaskCommandRequest);
    expect(outcome).toMatchObject({ status: 'failed', effect: 'none', code: 'INTERNAL' });
    expect(fake.calls).toHaveLength(0);
  });

  it('never rejects: a throwing createId before the send is failed/none and sends nothing', async () => {
    const secret = freshSecret();
    const fake = makeTransport();
    const host = createRemoteTaskHost({
      transport: fake.transport,
      createId: () => {
        throw new Error(secret);
      },
    });
    const outcome = await host.execute(fillRequest(secret));
    expect(outcome).toMatchObject({ status: 'failed', effect: 'none', code: 'INTERNAL' });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(fake.calls).toHaveLength(0);
  });

  it('never rejects: a rejecting or synchronously throwing transport is uncertain/DOCUMENT_LOST', async () => {
    const secret = freshSecret();
    const rejecting = build({ execute: () => rejects(new Error(`reset while typing ${secret}`)) });
    const first = await rejecting.host.execute(fillRequest(secret));
    expect(first).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    expect(JSON.stringify(first)).not.toContain(secret);

    const throwing: TaskTransport = {
      invoke: () => {
        throw new Error(`sync ${secret}`);
      },
    };
    const host = createRemoteTaskHost({ transport: throwing, createId: callIds() });
    const second = await host.execute(fillRequest(secret));
    expect(second).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    expect(JSON.stringify(second)).not.toContain(secret);
  });

  it('answers failed/EXECUTION_CANCELLED with no transport call for an aborted signal', async () => {
    const { host, fake } = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    const controller = new AbortController();
    controller.abort();
    const outcome = await host.execute(makeCommandRequest(), controller.signal);
    expect(outcome).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'EXECUTION_CANCELLED',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('answers failed/HOST_DISPOSED with no transport call after dispose', async () => {
    const { host, fake } = build();
    await host.dispose();
    const before = fake.calls.length;
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({ status: 'failed', effect: 'none', code: 'HOST_DISPOSED' });
    expect(fake.calls).toHaveLength(before);
  });

  it('keeps tracking: a changed live documentId makes the next observe refresh hello', async () => {
    const { host, fake } = build({
      hello: sequence(
        env => replyHello(env, helloValue()),
        env => replyHello(env, helloValue({ documentId: DOC_B }))
      ),
      execute: env =>
        reply(
          env,
          makeOutcome('rejected_stale', 'none', { staleReason: 'document_changed' }),
          DOC_B
        ),
      observe: sequence(
        env => reply(env, makeObservation()),
        env => reply(env, makeObservation({ documentId: DOC_B }), DOC_B)
      ),
    });
    ok(await host.observe(OBSERVE_REQUEST));
    await host.execute(makeCommandRequest());
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(2);
    expect(fake.envelopes('observe')[1]?.expectDocumentId).toBe(DOC_B);
  });

  it('keeps the cached hello when the execute response names the same document', async () => {
    const { host, fake } = build();
    ok(await host.observe(OBSERVE_REQUEST));
    await host.execute(makeCommandRequest());
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// execute: authoritative location gate
// ---------------------------------------------------------------------------------------------

describe('execute with an authoritative location', () => {
  const withLocation = (origin: string, script: Script = {}): Built =>
    build(script, { transport: { location: locationAt(`${origin}/page`, origin) } });

  it('sends the execute when the controller origin is allowed', async () => {
    const { host, fake } = withLocation(FIXTURE_ORIGIN);
    const outcome = await host.execute(makeCommandRequest({ allowedOrigins: [FIXTURE_ORIGIN] }));
    expect(outcome.status).toBe('applied');
    expect(fake.count('execute')).toBe(1);
  });

  it('finds the origin anywhere in a longer allow list', async () => {
    const { host, fake } = withLocation(FIXTURE_ORIGIN);
    await host.execute(
      makeCommandRequest({
        allowedOrigins: ['https://a.example.test', FIXTURE_ORIGIN, 'https://b.example.test'],
      })
    );
    expect(fake.count('execute')).toBe(1);
  });

  it('rejects_scope/PERMISSION_DENIED and sends nothing when the origin is outside, FILL above all', async () => {
    const secret = freshSecret();
    const { host, fake } = withLocation(EVIL_ORIGIN);
    const outcome = await host.execute(fillRequest(secret, { allowedOrigins: [FIXTURE_ORIGIN] }));
    expect(outcome).toMatchObject({
      status: 'rejected_scope',
      effect: 'none',
      code: 'PERMISSION_DENIED',
    });
    expect(fake.calls).toHaveLength(0);
    const json = JSON.stringify(outcome);
    expect(json).not.toContain('evil');
    expect(json).not.toContain(secret);
  });

  it.each<[string, string]>([
    ['a different port', `${FIXTURE_ORIGIN}:8443`],
    ['a different scheme', 'http://shop.example.test'],
    ['a different host', 'https://shop.example.org'],
    ['a sub-domain', 'https://www.shop.example.test'],
  ])('compares origins exactly: %s is outside', async (_name, origin) => {
    const { host, fake } = withLocation(origin);
    const outcome = await host.execute(makeCommandRequest({ allowedOrigins: [FIXTURE_ORIGIN] }));
    expect(outcome.status).toBe('rejected_scope');
    expect(fake.count('execute')).toBe(0);
  });

  it('rejects when the allow list is empty', async () => {
    const { host, fake } = withLocation(FIXTURE_ORIGIN);
    const outcome = await host.execute(makeCommandRequest({ allowedOrigins: [] }));
    expect(outcome.status).toBe('rejected_scope');
    expect(fake.count('execute')).toBe(0);
  });

  it('sends nothing when the controller location cannot be read: failed/none', async () => {
    const failing = build(
      {},
      {
        transport: {
          location: async () => ({
            ok: false,
            error: { code: 'INTERNAL', message: 'detached', retryable: true },
          }),
        },
      }
    );
    expect(await failing.host.execute(makeCommandRequest())).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'HOST_UNAVAILABLE',
    });
    expect(failing.fake.calls).toHaveLength(0);

    const rejecting = build(
      {},
      {
        transport: {
          location: async () => {
            throw new Error('cdp closed');
          },
        },
      }
    );
    expect(await rejecting.host.execute(makeCommandRequest())).toMatchObject({
      status: 'failed',
      effect: 'none',
    });
    expect(rejecting.fake.calls).toHaveLength(0);
  });

  it('sends nothing when the signal aborts while the location is pending', async () => {
    const gate = deferred<TaskHostResult<{ url: string; origin: string }>>();
    const { host, fake } = build({}, { transport: { location: () => gate.promise } });
    const controller = new AbortController();
    const pending = host.execute(makeCommandRequest(), controller.signal);
    await flush();
    controller.abort();
    gate.resolve({ ok: true, value: { url: FIXTURE_URL, origin: FIXTURE_ORIGIN } });
    expect(await pending).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'EXECUTION_CANCELLED',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('does not gate a transport that has no location, whatever the allow list says', async () => {
    const { host, fake } = build();
    await host.execute(makeCommandRequest({ allowedOrigins: [] }));
    expect(fake.count('execute')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// execute: lost mappings
// ---------------------------------------------------------------------------------------------

describe('execute when the transport loses the call', () => {
  const nextDocument =
    (overrides: Partial<TaskBridgeHello> = {}): Handler =>
    env =>
      replyHello(
        env,
        helloValue({ documentId: DOC_B, url: `${FIXTURE_ORIGIN}/orders`, ...overrides })
      );

  it('navigated and the next document is confirmed: navigated/uncertain with the transition', async () => {
    const token = `${freshHex()}${freshHex()}${freshHex()}`;
    const cartUrl = `${FIXTURE_ORIGIN}/cart?session_token=${token}`;
    const ordersUrl = `https://u:p@shop.example.test/orders?auth_token=${token}#done`;
    const { host, fake } = build({
      hello: sequence(env => replyHello(env, helloValue()), nextDocument({ url: ordersUrl })),
      observe: env => reply(env, makeObservation({ url: cartUrl })),
      execute: () => lost('navigated', 'Execution context was destroyed'),
    });
    ok(await host.observe(OBSERVE_REQUEST));
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({
      status: 'navigated',
      effect: 'uncertain',
      navigation: {
        kind: 'document',
        realmLost: true,
        fromDocumentId: DOC_A,
        toDocumentId: DOC_B,
      },
    });
    const redactor = createRedactor();
    expect(outcome.navigation?.fromUrl).toBe(redactor.redactUrl(cartUrl));
    expect(outcome.navigation?.toUrl).toBe(redactor.redactUrl(ordersUrl));
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(JSON.stringify(outcome)).not.toContain('u:p@');
    expect(fake.count('execute')).toBe(1);
    expect(hasUndefinedValue(outcome)).toBe(false);
    expect(roundTrip(outcome)).toEqual(outcome);
  });

  it('adopts the confirmed document: the next observe needs no hello', async () => {
    const { host, fake } = build({
      hello: sequence(env => replyHello(env, helloValue()), nextDocument()),
      observe: sequence(
        env => reply(env, makeObservation()),
        env => reply(env, makeObservation({ documentId: DOC_B }), DOC_B)
      ),
      execute: () => lost('navigated'),
    });
    ok(await host.observe(OBSERVE_REQUEST));
    await host.execute(makeCommandRequest());
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(2);
    expect(fake.envelopes('observe')[1]?.expectDocumentId).toBe(DOC_B);
  });

  it('scrubs the FILL value from the remembered from url too', async () => {
    const secret = freshSecret();
    const earlier = `${FIXTURE_ORIGIN}/search?q=${encodeURIComponent(secret)}`;
    const { host } = build({
      hello: nextDocument(),
      observe: env => reply(env, makeObservation({ url: earlier })),
      execute: () => lost('navigated'),
    });
    ok(await host.observe(OBSERVE_REQUEST));
    const outcome = await host.execute(fillRequest(secret));
    expect(outcome.status).toBe('navigated');
    expect(outcome.navigation?.fromUrl).toContain(REDACTED_MARK);
    expect(JSON.stringify(outcome)).not.toContain(encodeURIComponent(secret));
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('has an empty fromUrl when no url of the old document was ever seen', async () => {
    const { host } = build({ hello: nextDocument(), execute: () => lost('navigated') });
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome.status).toBe('navigated');
    expect(outcome.navigation?.fromUrl).toBe('');
  });

  it('polls hello until the next document is ready and top', async () => {
    const { host, fake } = build({
      hello: sequence(
        nextDocument({ ready: false }),
        nextDocument({ isTop: false }),
        nextDocument()
      ),
      execute: () => lost('navigated'),
    });
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome.status).toBe('navigated');
    expect(fake.count('hello')).toBe(3);
  });

  it('does not take the old document for the next one: uncertain/DOCUMENT_LOST after navigationTimeoutMs', async () => {
    const { host, fake } = build(
      {
        hello: env => replyHello(env, helloValue()),
        execute: () => lost('navigated'),
      },
      { config: { navigationTimeoutMs: 200, pollIntervalMs: 50 } }
    );
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    expect(fake.count('hello')).toBe(5);
    expect(fake.count('execute')).toBe(1);
  });

  it('after an unconfirmed navigation the next observe answers DOCUMENT_LOST (retryable) once, with no call', async () => {
    const { host, fake } = build(
      { hello: env => replyHello(env, helloValue()), execute: () => lost('navigated') },
      { config: { navigationTimeoutMs: 100, pollIntervalMs: 50 } }
    );
    await host.execute(makeCommandRequest());
    const before = fake.calls.length;
    const first = await host.observe(OBSERVE_REQUEST);
    expect(err(first)).toMatchObject({ code: 'DOCUMENT_LOST', retryable: true });
    expect(fake.calls).toHaveLength(before);
    ok(await host.observe(OBSERVE_REQUEST));
  });

  it('a confirmed navigation leaves no DOCUMENT_LOST behind', async () => {
    const { host } = build({ hello: nextDocument(), execute: () => lost('navigated') });
    await host.execute(makeCommandRequest());
    ok(await host.observe(OBSERVE_REQUEST));
  });

  it('uses waitForDocument when the transport has one, naming the previous document', async () => {
    const waitForDocument = jest.fn(
      async (input: {
        readonly previousDocumentId?: string;
        readonly timeoutMs: number;
        readonly signal?: AbortSignal;
      }): Promise<TaskDocumentInfo | null> => ({
        documentId: DOC_B,
        url: `${FIXTURE_ORIGIN}/orders`,
        ready: true,
      })
    );
    const { host, fake } = build(
      { hello: nextDocument(), execute: () => lost('navigated') },
      { transport: { waitForDocument }, config: { navigationTimeoutMs: 4321 } }
    );
    const outcome = await host.execute(
      makeCommandRequest({ scope: makeScope({ documentId: DOC_A }) })
    );
    expect(outcome).toMatchObject({
      status: 'navigated',
      effect: 'uncertain',
      navigation: { toDocumentId: DOC_B },
    });
    expect(waitForDocument).toHaveBeenCalledTimes(1);
    expect(waitForDocument.mock.calls[0]?.[0]).toMatchObject({
      previousDocumentId: DOC_A,
      timeoutMs: 4321,
    });
    expect(fake.count('hello')).toBe(1);
  });

  it('waitForDocument resolving null is uncertain/DOCUMENT_LOST without polling hello', async () => {
    const waitForDocument = jest.fn(async (): Promise<TaskDocumentInfo | null> => null);
    const { host, fake } = build(
      { execute: () => lost('navigated') },
      { transport: { waitForDocument } }
    );
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    expect(fake.count('hello')).toBe(0);
  });

  it('a rejecting waitForDocument is the same as null, never an exception', async () => {
    const waitForDocument = jest.fn(async (): Promise<TaskDocumentInfo | null> => {
      throw new Error('page gone');
    });
    const { host } = build(
      { execute: () => lost('navigated') },
      { transport: { waitForDocument } }
    );
    expect(await host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
  });

  it('ignores a waitForDocument answer that is the old document, polling on', async () => {
    const answers: (TaskDocumentInfo | null)[] = [
      { documentId: DOC_A, url: FIXTURE_URL, ready: true },
      { documentId: DOC_B, url: `${FIXTURE_ORIGIN}/orders`, ready: true },
    ];
    const waitForDocument = jest.fn(
      async (): Promise<TaskDocumentInfo | null> => answers.shift() ?? null
    );
    const { host } = build(
      { hello: nextDocument(), execute: () => lost('navigated') },
      { transport: { waitForDocument } }
    );
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome.status).toBe('navigated');
    expect(waitForDocument).toHaveBeenCalledTimes(2);
  });

  it.each<[string, TaskTransportLostReason]>([
    ['closed', 'closed'],
    ['error', 'error'],
  ])('lost %s is uncertain/DOCUMENT_LOST and is not retried', async (_name, reason) => {
    const { host, fake } = build({ execute: () => lost(reason, 'gone') });
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    expect(fake.count('execute')).toBe(1);
    expect(fake.count('hello')).toBe(0);
  });

  it('lost timeout without a new document is uncertain/EXECUTION_TIMEOUT', async () => {
    const { host, fake } = build({
      hello: env => replyHello(env, helloValue()),
      execute: () => lost('timeout'),
    });
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_TIMEOUT',
    });
    expect(fake.count('execute')).toBe(1);
  });

  it('lost timeout that leaves the observe path alone: no DOCUMENT_LOST flag for the next observe', async () => {
    const { host } = build({ execute: () => lost('timeout') });
    await host.execute(makeCommandRequest());
    ok(await host.observe(OBSERVE_REQUEST));
  });

  it('lost timeout with a different document present is navigated, as for a hard navigation in flight', async () => {
    const { host, fake } = build({
      hello: nextDocument(),
      execute: () => lost('timeout'),
    });
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({
      status: 'navigated',
      effect: 'uncertain',
      navigation: { kind: 'document', realmLost: true, fromDocumentId: DOC_A, toDocumentId: DOC_B },
    });
    expect(fake.count('execute')).toBe(1);
  });

  it('lost timeout consults waitForDocument too', async () => {
    const waitForDocument = jest.fn(
      async (): Promise<TaskDocumentInfo | null> => ({
        documentId: DOC_B,
        url: `${FIXTURE_ORIGIN}/orders`,
        ready: true,
      })
    );
    const { host } = build(
      { hello: nextDocument(), execute: () => lost('timeout') },
      { transport: { waitForDocument } }
    );
    expect((await host.execute(makeCommandRequest())).status).toBe('navigated');
    expect(waitForDocument.mock.calls[0]).toBeDefined();
  });

  it('never retries a lost call: one execute envelope for every lost reason', async () => {
    for (const reason of ['navigated', 'closed', 'timeout', 'error'] as const) {
      const { host, fake } = build(
        { execute: () => lost(reason), hello: nextDocument() },
        { config: { navigationTimeoutMs: 100, pollIntervalMs: 50 } }
      );
      await host.execute(makeCommandRequest());
      expect(fake.count('execute')).toBe(1);
    }
  });

  it('echoes of the FILL value in a lost message never reach the outcome, in any encoding', async () => {
    const plain = freshSecret();
    const quoted = `say "${freshHex()}" \\ done`;
    const spaced = `p@ss w0rd/${freshHex()}`;
    for (const secret of [plain, quoted, spaced]) {
      const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
      for (const reason of ['navigated', 'closed', 'timeout', 'error'] as const) {
        const { host } = build(
          {
            execute: () => lost(reason, `transport said: ${variants.join(' | ')}`),
            hello: nextDocument(),
          },
          { config: { navigationTimeoutMs: 100, pollIntervalMs: 50 } }
        );
        const outcome = await host.execute(fillRequest(secret));
        const text = JSON.stringify(outcome);
        for (const variant of variants) {
          expect(text).not.toContain(variant);
          expect(text).not.toContain(JSON.stringify(variant).slice(1, -1));
        }
      }
    }
  });

  it('keeps the scrubbed lost message for diagnosis', async () => {
    const secret = freshSecret();
    const { host } = build({ execute: () => lost('error', `proxy refused ${secret} (502)`) });
    const outcome = await host.execute(fillRequest(secret));
    expect(outcome.message).toContain('proxy refused');
    expect(outcome.message).toContain(REDACTED_MARK);
    expect(outcome.message).toContain('(502)');
  });

  it('answers for a rejecting transport as for a lost error', async () => {
    const { host } = build({
      execute: () => rejects(new Error('Target page, context or browser has been closed')),
    });
    expect(await host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
  });

  it('does not wait for a next document once the signal has aborted', async () => {
    const controller = new AbortController();
    const { host, fake } = build(
      {
        hello: env => replyHello(env, helloValue()),
        execute: () => {
          controller.abort();
          return lost('navigated');
        },
      },
      { transport: { concurrent: false } }
    );
    const outcome = await host.execute(makeCommandRequest(), controller.signal);
    expect(outcome).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    expect(fake.count('hello')).toBe(0);
    // The wait was cut short by the abort, not exhausted: the next observe is not told the page is gone.
    ok(await host.observe(OBSERVE_REQUEST));
  });
});

// ---------------------------------------------------------------------------------------------
// execute: abort and the cancel protocol
// ---------------------------------------------------------------------------------------------

describe('abort during execute', () => {
  type Gate = Deferred<(envelope: TaskBridgeEnvelope) => TaskTransportResult>;

  const gatedExecute =
    (gate: Gate): Handler =>
    env =>
      gate.promise.then(make => make(env));

  const setup = (options: BuildOptions = {}, script: Script = {}) => {
    const gate: Gate = deferred();
    const timers = options.timers ?? manualTimers();
    const built = build({ execute: gatedExecute(gate), ...script }, { ...options, timers });
    const controller = new AbortController();
    const request = makeCommandRequest();
    const pending = built.host.execute(request, controller.signal);
    return { ...built, timers, gate, controller, request, pending, state: track(pending) };
  };

  it('sends cancel while the execute is pending, naming the callId of the in-flight envelope', async () => {
    const { fake, gate, controller, pending } = setup();
    await flush();
    expect(fake.count('execute')).toBe(1);
    expect(fake.count('cancel')).toBe(0);
    controller.abort();
    await flush();
    const execute = fake.envelopes('execute')[0];
    const cancel = fake.envelopes('cancel')[0];
    expect(cancel?.payload).toEqual({ targetCallId: execute?.callId });
    expect(cancel?.callId).not.toBe(execute?.callId);
    expect(cancel?.expectDocumentId).toBeUndefined();
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    await pending;
  });

  it('gives the cancel its own short timeout and no aborted signal', async () => {
    const { fake, gate, controller, pending } = setup();
    await flush();
    controller.abort();
    await flush();
    const cancel = fake.recorded('cancel')[0];
    expect(cancel?.call.timeoutMs).toBe(2000);
    expect(cancel?.call.signal).toBeUndefined();
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    await pending;
  });

  it('bounds the cancel timeout by callTimeoutMs when that is shorter than the grace', async () => {
    const { fake, gate, controller, pending } = setup({
      config: { callTimeoutMs: 300, cancelGraceMs: 2000 },
    });
    await flush();
    controller.abort();
    await flush();
    expect(fake.recorded('cancel')[0]?.call.timeoutMs).toBe(300);
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    await pending;
  });

  it('never hands the caller signal to the execute invoke, so an abort cannot drop the response', async () => {
    const { fake, gate, controller, pending } = setup();
    await flush();
    const call = fake.recorded('execute')[0]?.call;
    expect(call?.signal).not.toBe(controller.signal);
    controller.abort();
    await flush();
    expect(call?.signal?.aborted ?? false).toBe(false);
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    await pending;
  });

  it('returns a truthful before-commit outcome that arrives within the grace: failed/EXECUTION_CANCELLED/none', async () => {
    const { gate, controller, pending, timers } = setup();
    await flush();
    controller.abort();
    await flush();
    await timers.advance(1999);
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    expect(await pending).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'EXECUTION_CANCELLED',
    });
  });

  it('returns a truthful after-commit outcome as is: uncertain/EXECUTION_CANCELLED/uncertain', async () => {
    const { gate, controller, pending } = setup();
    await flush();
    controller.abort();
    await flush();
    gate.resolve(env =>
      reply(
        env,
        makeOutcome('uncertain', 'uncertain', {
          code: 'EXECUTION_CANCELLED',
          message: 'after commit',
        })
      )
    );
    expect(await pending).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_CANCELLED',
      message: 'after commit',
    });
  });

  it('returns the normal outcome when the execute finished before the cancel could act', async () => {
    const { gate, controller, pending } = setup();
    await flush();
    controller.abort();
    await flush();
    gate.resolve(env => reply(env, makeOutcome('applied', 'applied')));
    expect(await pending).toMatchObject({ status: 'applied', effect: 'applied' });
  });

  it('without any response: uncertain/EXECUTION_CANCELLED/uncertain exactly when the grace has passed', async () => {
    const { controller, pending, state, timers } = setup();
    await flush();
    controller.abort();
    await flush();
    expect(timers.slept).toEqual([2000]);
    await timers.advance(1999);
    expect(state.settled).toBe(false);
    await timers.advance(1);
    expect(await pending).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_CANCELLED',
    });
  });

  it('honors a configured cancelGraceMs', async () => {
    const { controller, pending, state, timers } = setup({ config: { cancelGraceMs: 500 } });
    await flush();
    controller.abort();
    await flush();
    expect(timers.slept).toEqual([500]);
    await timers.advance(499);
    expect(state.settled).toBe(false);
    await timers.advance(1);
    expect((await pending).status).toBe('uncertain');
  });

  it('aborts the internal invoke signal once the grace expires, and ignores a late response', async () => {
    const { fake, gate, controller, pending, timers } = setup();
    await flush();
    controller.abort();
    await flush();
    await timers.advance(2000);
    await pending;
    expect(fake.recorded('execute')[0]?.call.signal?.aborted).toBe(true);
    gate.resolve(env => reply(env, makeOutcome('applied', 'applied')));
    await flush();
  });

  it('a late lost call inside the grace still maps like any lost call', async () => {
    const { gate, controller, pending } = setup();
    await flush();
    controller.abort();
    await flush();
    gate.resolve(() => lost('closed', 'page closed'));
    expect(await pending).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
  });

  it('survives a cancel that is itself lost, rejected or answered with garbage', async () => {
    const handlers: readonly Handler[] = [
      () => lost('timeout'),
      () => rejects(new Error('cancel failed')),
      () => ({ kind: 'nonsense' }) as unknown as TaskTransportResult,
    ];
    for (const cancel of handlers) {
      const { gate, controller, pending, timers } = setup({}, { cancel });
      await flush();
      controller.abort();
      await flush();
      await timers.advance(2000);
      expect(await pending).toMatchObject({ status: 'uncertain', code: 'EXECUTION_CANCELLED' });
      gate.resolve(env => reply(env, makeOutcome('applied', 'applied')));
    }
  });

  it('removes its abort listener after a normal finish (a later abort sends no cancel)', async () => {
    const gate: Gate = deferred();
    const { host, fake } = build({ execute: gatedExecute(gate) }, { timers: manualTimers() });
    const controller = new AbortController();
    const pending = host.execute(makeCommandRequest(), controller.signal);
    await flush();
    gate.resolve(env => reply(env, makeOutcome('applied', 'applied')));
    await pending;
    controller.abort();
    await flush();
    expect(fake.count('cancel')).toBe(0);
  });

  it('with a non-concurrent transport sends no cancel and waits for the outcome', async () => {
    const { fake, gate, controller, pending, state, timers } = setup({
      transport: { concurrent: false },
    });
    await flush();
    controller.abort();
    await flush();
    await timers.advance(60000);
    expect(state.settled).toBe(false);
    expect(fake.count('cancel')).toBe(0);
    expect(timers.slept).toEqual([]);
    gate.resolve(env =>
      reply(env, makeOutcome('uncertain', 'uncertain', { code: 'EXECUTION_TIMEOUT' }))
    );
    expect(await pending).toMatchObject({ status: 'uncertain', code: 'EXECUTION_TIMEOUT' });
  });

  it('with a non-concurrent transport the bounded transport timeout still ends the wait', async () => {
    const { gate, controller, pending } = setup({
      transport: { concurrent: false },
      timers: autoTimers(),
    });
    await flush();
    controller.abort();
    await flush();
    gate.resolve(() => lost('timeout'));
    expect(await pending).toMatchObject({ status: 'uncertain', code: 'EXECUTION_TIMEOUT' });
  });

  it('an abort before the call still short-circuits on a non-concurrent transport', async () => {
    const { host, fake } = build({}, { transport: { concurrent: false } });
    const controller = new AbortController();
    controller.abort();
    expect(await host.execute(makeCommandRequest(), controller.signal)).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'EXECUTION_CANCELLED',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('scrubs the FILL value from messages produced during the cancel path', async () => {
    const secret = freshSecret();
    const gate: Gate = deferred();
    const timers = manualTimers();
    const { host } = build({ execute: gatedExecute(gate) }, { timers });
    const controller = new AbortController();
    const pending = host.execute(fillRequest(secret), controller.signal);
    await flush();
    controller.abort();
    await flush();
    gate.resolve(() => lost('error', `connection reset while typing ${secret}`));
    const outcome = await pending;
    expect(JSON.stringify(outcome)).not.toContain(secret);
    await timers.advance(5000);
  });
});

// ---------------------------------------------------------------------------------------------
// release and dispose
// ---------------------------------------------------------------------------------------------

describe('release', () => {
  it('sends a bridge release with the session id and resolves', async () => {
    const { host, fake } = build();
    await expect(host.release?.(SESSION)).resolves.toBeUndefined();
    const envelope = fake.envelopes('release')[0];
    expect(envelope?.protocol).toBe(TASK_BRIDGE_PROTOCOL);
    expect(envelope?.payload).toEqual({ sessionId: SESSION });
    expect(fake.recorded('release')[0]?.call.timeoutMs).toBe(10000);
  });

  it('never throws: lost, rejected, garbage or a throwing createId are all ignored', async () => {
    const handlers: readonly Handler[] = [
      () => lost('closed'),
      () => rejects(new Error('boom')),
      () => ({ kind: 'nonsense' }) as unknown as TaskTransportResult,
      env => replyError(env, { code: 'INTERNAL' }),
    ];
    for (const release of handlers) {
      const { host } = build({ release });
      await expect(host.release?.(SESSION)).resolves.toBeUndefined();
    }
    const host = createRemoteTaskHost({
      transport: makeTransport().transport,
      createId: () => {
        throw new Error('no ids');
      },
    });
    await expect(host.release?.(SESSION)).resolves.toBeUndefined();
  });

  it('still releases when the run was cancelled: an aborted signal is not forwarded', async () => {
    const { host, fake } = build();
    const controller = new AbortController();
    controller.abort();
    await host.release?.(SESSION, controller.signal);
    expect(fake.count('release')).toBe(1);
    expect(fake.recorded('release')[0]?.call.signal).toBeUndefined();
  });

  it('forwards a live signal', async () => {
    const { host, fake } = build();
    const controller = new AbortController();
    await host.release?.(SESSION, controller.signal);
    expect(fake.recorded('release')[0]?.call.signal).toBe(controller.signal);
  });

  it('sends nothing after dispose', async () => {
    const { host, fake } = build();
    await host.dispose();
    const before = fake.calls.length;
    await host.release?.(SESSION);
    expect(fake.calls).toHaveLength(before);
  });
});

describe('dispose', () => {
  it('releases the sessions it observed, then sends dispose, and does not close the transport', async () => {
    const close = jest.fn(async () => undefined);
    const { host, fake } = build({}, { transport: { close } });
    ok(await host.observe({ sessionId: SESSION }));
    ok(await host.observe({ sessionId: 'ses_000000000002' }));
    await host.dispose();
    const methods = fake.calls.map(entry => entry.envelope.method);
    expect(methods.slice(-3)).toEqual(['release', 'release', 'dispose']);
    expect(fake.envelopes('release').map(envelope => envelope.payload)).toEqual([
      { sessionId: SESSION },
      { sessionId: 'ses_000000000002' },
    ]);
    expect(fake.envelopes('dispose')[0]?.payload).toEqual({});
    expect(close).not.toHaveBeenCalled();
  });

  it('does not release a session that was released already', async () => {
    const { host, fake } = build();
    ok(await host.observe({ sessionId: SESSION }));
    await host.release?.(SESSION);
    await host.dispose();
    expect(fake.count('release')).toBe(1);
    expect(fake.count('dispose')).toBe(1);
  });

  it('sends only dispose when nothing was observed', async () => {
    const { host, fake } = build();
    await host.dispose();
    expect(fake.calls.map(entry => entry.envelope.method)).toEqual(['dispose']);
  });

  it('marks the host disposed: every later call answers HOST_DISPOSED without a transport call', async () => {
    const { host, fake } = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    await host.dispose();
    const before = fake.calls.length;
    expect(err(await host.capabilities()).code).toBe('HOST_DISPOSED');
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('HOST_DISPOSED');
    const locate = host.location;
    expect(err(await (locate?.() ?? Promise.reject(new Error('no location')))).code).toBe(
      'HOST_DISPOSED'
    );
    expect(await host.execute(makeCommandRequest())).toMatchObject({ code: 'HOST_DISPOSED' });
    expect(fake.calls).toHaveLength(before);
  });

  it('is idempotent', async () => {
    const { host, fake } = build();
    await host.dispose();
    const before = fake.calls.length;
    await host.dispose();
    expect(fake.calls).toHaveLength(before);
  });

  it('never rejects, whatever the transport does', async () => {
    const handlers: readonly Handler[] = [
      () => lost('closed'),
      () => rejects(new Error('boom')),
      () => ({ kind: 'nonsense' }) as unknown as TaskTransportResult,
    ];
    for (const handler of handlers) {
      const { host } = build({ release: handler, dispose: handler });
      ok(await host.observe({ sessionId: SESSION }));
      await expect(host.dispose()).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Payloads are never logged
// ---------------------------------------------------------------------------------------------

describe('logging and leakage', () => {
  it('writes nothing to the console during a full session with a FILL value and a cancel', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = methods.map(method =>
      jest.spyOn(console, method).mockImplementation(() => undefined)
    );
    try {
      const secret = freshSecret();
      const timers = manualTimers();
      const gate: Deferred<(envelope: TaskBridgeEnvelope) => TaskTransportResult> = deferred();
      const { host } = build(
        { execute: env => gate.promise.then(make => make(env)) },
        { timers, transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
      );
      await host.capabilities();
      await host.observe(OBSERVE_REQUEST);
      const controller = new AbortController();
      const pending = host.execute(fillRequest(secret), controller.signal);
      await flush();
      controller.abort();
      await flush();
      gate.resolve(() => lost('error', `echo ${secret}`));
      await pending;
      await timers.advance(5000);
      await host.release?.(SESSION);
      await host.dispose();
      spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });

  it('keeps the FILL value out of every non-execute envelope and every returned value', async () => {
    const secret = freshSecret();
    const { host, fake } = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    const results: unknown[] = [];
    results.push(await host.capabilities());
    results.push(await host.observe(OBSERVE_REQUEST));
    results.push(await host.execute(fillRequest(secret)));
    results.push(await host.release?.(SESSION));
    await host.dispose();
    for (const entry of fake.calls) {
      if (entry.envelope.method !== 'execute') {
        expect(JSON.stringify(entry)).not.toContain(secret);
      }
    }
    expect(JSON.stringify(results)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------------------------
// JSON safety of everything the host produces
// ---------------------------------------------------------------------------------------------

describe('JSON safety', () => {
  it('every outcome and result survives a JSON round trip with no undefined values', async () => {
    const lostKinds = ['navigated', 'closed', 'timeout', 'error'] as const;
    const outcomes: unknown[] = [];
    for (const reason of lostKinds) {
      const { host } = build(
        {
          execute: () => lost(reason),
          hello: env => replyHello(env, helloValue({ documentId: DOC_B })),
        },
        { config: { navigationTimeoutMs: 100, pollIntervalMs: 50 } }
      );
      outcomes.push(await host.execute(makeCommandRequest()));
    }
    const { host } = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    outcomes.push(await host.capabilities());
    outcomes.push(await host.observe(OBSERVE_REQUEST));
    outcomes.push(await host.location?.());
    outcomes.push(await host.execute(makeCommandRequest()));
    for (const value of outcomes) {
      expect(hasUndefinedValue(value)).toBe(false);
      expect(roundTrip(value)).toEqual(value);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

describe('configuration', () => {
  const INVALID: readonly (readonly [string, number])[] = [
    ['NaN', Number.NaN],
    ['negative', -5],
    ['infinite', Number.POSITIVE_INFINITY],
  ];

  it.each([...INVALID, ['zero', 0] as const])(
    'falls back to the default callTimeoutMs for a %s value',
    async (_name, value) => {
      const { host, fake } = build({}, { config: { callTimeoutMs: value } });
      ok(await host.capabilities());
      expect(fake.calls[0]?.call.timeoutMs).toBe(10000);
    }
  );

  it.each([...INVALID, ['zero', 0] as const])(
    'falls back to the default pollIntervalMs for a %s value',
    async (_name, value) => {
      const { host, timers } = build(
        {
          hello: sequence(
            env => replyHello(env, helloValue({ ready: false })),
            env => replyHello(env, helloValue())
          ),
        },
        { config: { pollIntervalMs: value } }
      );
      ok(await host.capabilities());
      expect(timers.slept).toEqual([50]);
    }
  );

  it.each(INVALID)(
    'falls back to the default navigationTimeoutMs for a %s value',
    async (_name, value) => {
      const waitForDocument = jest.fn(async (): Promise<TaskDocumentInfo | null> => null);
      const { host } = build(
        { execute: () => lost('navigated') },
        { transport: { waitForDocument }, config: { navigationTimeoutMs: value } }
      );
      await host.execute(makeCommandRequest());
      expect(waitForDocument.mock.calls[0]).toBeDefined();
      expect((waitForDocument.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
        timeoutMs: 15000,
      });
    }
  );

  it('honors a navigationTimeoutMs of zero: one look for the next document, no waiting', async () => {
    const { host, fake, timers } = build(
      { hello: env => replyHello(env, helloValue()), execute: () => lost('navigated') },
      { config: { navigationTimeoutMs: 0 } }
    );
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({ status: 'uncertain', code: 'DOCUMENT_LOST' });
    expect(fake.count('hello')).toBe(1);
    expect(timers.slept).toEqual([]);
  });

  it.each(INVALID)(
    'falls back to the default cancelGraceMs for a %s value',
    async (_name, value) => {
      const gate: Deferred<(envelope: TaskBridgeEnvelope) => TaskTransportResult> = deferred();
      const timers = manualTimers();
      const { host } = build(
        { execute: env => gate.promise.then(make => make(env)) },
        { timers, config: { cancelGraceMs: value } }
      );
      const controller = new AbortController();
      const pending = host.execute(makeCommandRequest(), controller.signal);
      await flush();
      controller.abort();
      await flush();
      expect(timers.slept).toEqual([2000]);
      await timers.advance(2000);
      await pending;
    }
  );

  it('honors a cancelGraceMs of zero, with a one millisecond cancel timeout', async () => {
    const gate: Deferred<(envelope: TaskBridgeEnvelope) => TaskTransportResult> = deferred();
    const timers = manualTimers();
    const { host, fake } = build(
      { execute: env => gate.promise.then(make => make(env)) },
      { timers, config: { cancelGraceMs: 0 } }
    );
    const controller = new AbortController();
    const pending = host.execute(makeCommandRequest(), controller.signal);
    await flush();
    controller.abort();
    await flush();
    expect(timers.slept).toEqual([0]);
    expect(fake.recorded('cancel')[0]?.call.timeoutMs).toBe(1);
    await timers.advance(0);
    expect(await pending).toMatchObject({ status: 'uncertain', code: 'EXECUTION_CANCELLED' });
  });

  it('falls back to the default execution budget for numbers that are not finite', async () => {
    const { host, fake } = build();
    await host.execute(
      makeCommandRequest({ timeoutMs: Number.NaN, settle: { quietMs: 1, maxMs: Number.NaN } })
    );
    expect(fake.recorded('execute')[0]?.call.timeoutMs).toBe(8000 + 2000 + 2000);
  });

  it('treats an allowedOrigins that is not a list as an empty list', async () => {
    const { host, fake } = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    const outcome = await host.execute({
      ...makeCommandRequest(),
      allowedOrigins: FIXTURE_ORIGIN as unknown as readonly string[],
    });
    expect(outcome.status).toBe('rejected_scope');
    expect(fake.count('execute')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation of everything the page says
// ---------------------------------------------------------------------------------------------

describe('validation of page answers', () => {
  const HELLO_DEFECTS: readonly (readonly [string, unknown])[] = [
    ['a non-string url', { ...helloValue(), url: 5 }],
    ['a non-boolean isTop', { ...helloValue(), isTop: 'yes' }],
    ['a missing ready', { ...helloValue(), ready: undefined }],
    ['capabilities that are not an object', { ...helloValue(), capabilities: 'all' }],
    [
      'capabilities without a redaction record',
      { ...helloValue(), capabilities: { ...helloValue().capabilities, redaction: undefined } },
    ],
  ];

  it.each(HELLO_DEFECTS)('rejects a hello with %s as PROTOCOL_ERROR', async (_name, value) => {
    const { host } = build({ hello: env => reply(env, value) });
    expect(err(await host.capabilities()).code).toBe('PROTOCOL_ERROR');
  });

  const OBSERVATION_DEFECTS: readonly (readonly [string, unknown])[] = [
    ['an empty documentId', { ...makeObservation(), documentId: '' }],
    ['a missing origin', { ...makeObservation(), origin: undefined }],
    ['a missing url', { ...makeObservation(), url: undefined }],
    ['null elements', { ...makeObservation(), elements: null }],
  ];

  it.each(OBSERVATION_DEFECTS)('rejects an observation with %s', async (_name, value) => {
    const { host } = build({ observe: env => reply(env, value) });
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('PROTOCOL_ERROR');
  });

  const goodNavigation = {
    kind: 'document',
    fromDocumentId: DOC_A,
    toDocumentId: DOC_B,
    fromUrl: `${FIXTURE_ORIGIN}/a`,
    toUrl: `${FIXTURE_ORIGIN}/b`,
    realmLost: true,
  };

  const NAVIGATION_DEFECTS: readonly (readonly [string, unknown])[] = [
    ['a missing kind', { ...goodNavigation, kind: undefined }],
    ['an empty fromDocumentId', { ...goodNavigation, fromDocumentId: '' }],
    ['a numeric fromDocumentId', { ...goodNavigation, fromDocumentId: 7 }],
    ['a numeric fromUrl', { ...goodNavigation, fromUrl: 7 }],
    ['a non-boolean realmLost', { ...goodNavigation, realmLost: 'yes' }],
    ['a numeric toDocumentId', { ...goodNavigation, toDocumentId: 7 }],
    ['a numeric toUrl', { ...goodNavigation, toUrl: 7 }],
    ['a string instead of a record', 'document'],
  ];

  it.each(NAVIGATION_DEFECTS)(
    'rejects an outcome with navigation %s',
    async (_name, navigation) => {
      const { host } = build({
        execute: env => reply(env, { status: 'navigated', effect: 'uncertain', navigation }),
      });
      expect(await host.execute(makeCommandRequest())).toMatchObject({
        status: 'uncertain',
        code: 'PROTOCOL_ERROR',
      });
    }
  );

  it('accepts a complete navigation and treats a null or absent one as none', async () => {
    const complete = build({
      execute: env =>
        reply(env, { status: 'navigated', effect: 'uncertain', navigation: goodNavigation }),
    });
    expect((await complete.host.execute(makeCommandRequest())).navigation).toEqual(goodNavigation);
    const none = build({
      execute: env => reply(env, { status: 'navigated', effect: 'applied', navigation: null }),
    });
    const outcome = await none.host.execute(makeCommandRequest());
    expect(outcome.status).toBe('navigated');
    expect('navigation' in outcome).toBe(false);
  });

  it('keeps optional navigation fields absent when the page omits them', async () => {
    const minimal = {
      kind: 'same_document',
      fromDocumentId: DOC_A,
      fromUrl: `${FIXTURE_ORIGIN}/a`,
      realmLost: false,
    };
    const { host } = build({
      execute: env => reply(env, { status: 'navigated', effect: 'applied', navigation: minimal }),
    });
    const navigation = (await host.execute(makeCommandRequest())).navigation;
    expect(navigation).toEqual(minimal);
    expect(Object.keys(navigation ?? {}).sort()).toEqual(Object.keys(minimal).sort());
  });

  const outcomeWith = (fields: Record<string, unknown>): Script => ({
    execute: env => reply(env, { status: 'applied', effect: 'applied', ...fields }),
  });

  it.each<[string, unknown]>([
    ['lower case', 'target_stale'],
    ['punctuated', 'BAD CODE!'],
    ['empty', ''],
    ['numeric', 7],
    ['starting with a digit', '1ERROR'],
    ['longer than 64 characters', `A${'B'.repeat(64)}`],
  ])('drops an outcome code that is %s', async (_name, code) => {
    const { host } = build(outcomeWith({ code }));
    expect('code' in (await host.execute(makeCommandRequest()))).toBe(false);
  });

  it.each(Object.keys(OUTCOME_CODE_TABLE))('keeps the known outcome code %s', async code => {
    const { host } = build(outcomeWith({ code }));
    expect((await host.execute(makeCommandRequest())).code).toBe(code);
  });

  it.each<[string, unknown]>([
    ['well shaped but unknown', 'SOMETHING_NEW'],
    ['the host-level TIMEOUT, which an execute outcome never reports', 'TIMEOUT'],
    ['the host-level CANCELLED, which an execute outcome never reports', 'CANCELLED'],
    ['a prototype name', '__proto__'],
    ['an inherited name', 'toString'],
    ['a known code in lower case', 'target_stale'],
    ['a known code with a suffix', 'TARGET_STALE2'],
  ])('drops an outcome code that is %s', async (_name, code) => {
    const { host } = build(outcomeWith({ code }));
    expect('code' in (await host.execute(makeCommandRequest()))).toBe(false);
  });

  it('drops an unknown staleReason and keeps a known one', async () => {
    const unknown = build(outcomeWith({ staleReason: 'felt_like_it' }));
    expect('staleReason' in (await unknown.host.execute(makeCommandRequest()))).toBe(false);
    const known = build(outcomeWith({ staleReason: 'url_changed' }));
    expect((await known.host.execute(makeCommandRequest())).staleReason).toBe('url_changed');
  });

  it('drops a message that is not text or is empty', async () => {
    for (const message of [7, '', null]) {
      const { host } = build(outcomeWith({ message }));
      expect('message' in (await host.execute(makeCommandRequest()))).toBe(false);
    }
  });

  it('drops a readback that is not a record with a kind, and a read without text', async () => {
    for (const readback of [
      'text',
      7,
      null,
      {},
      { kind: 5 },
      { kind: 'read' },
      { kind: 'read', text: 5 },
    ]) {
      const { host } = build(outcomeWith({ readback }));
      expect('readback' in (await host.execute(makeCommandRequest()))).toBe(false);
    }
  });

  it('keeps an action readback record untouched', async () => {
    const readback = {
      kind: 'fill',
      tag: 'input',
      inputType: 'text',
      empty: false,
      changed: true,
      matched: true,
    };
    const { host } = build(outcomeWith({ readback }));
    expect((await host.execute(makeCommandRequest())).readback).toEqual(readback);
  });

  it('computes durationMs when the page gives none usable, and never reports a negative one', async () => {
    for (const durationMs of [undefined, 'long', Number.NaN, null, -5]) {
      const { host } = build(outcomeWith({ durationMs }));
      const outcome = await host.execute(makeCommandRequest());
      expect(Number.isFinite(outcome.durationMs)).toBe(true);
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
    const { host } = build(outcomeWith({ durationMs: 321 }));
    expect((await host.execute(makeCommandRequest())).durationMs).toBe(321);
  });

  it('uses the request id for an outcome whose requestId is not text', async () => {
    const { host } = build(outcomeWith({ requestId: 12 }));
    const outcome = await host.execute(makeCommandRequest({ requestId: 'req_mine00000001' }));
    expect(outcome.requestId).toBe('req_mine00000001');
  });

  it('truncates a long transport message in the outcome', async () => {
    const { host } = build({ execute: () => lost('error', 'x'.repeat(2000)) });
    const outcome = await host.execute(makeCommandRequest());
    expect((outcome.message ?? '').length).toBeLessThan(700);
    expect(outcome.message).not.toContain('x'.repeat(501));
  });

  it('truncates a long page error message', async () => {
    const { host } = build({
      observe: env => replyError(env, { code: 'OBSERVE_FAILED', message: 'y'.repeat(2000) }),
    });
    const error = err(await host.observe(OBSERVE_REQUEST));
    expect(error.message.length).toBeLessThanOrEqual(500);
  });

  it('reads retryable strictly and a non-text message as empty', async () => {
    const { host } = build({
      observe: env =>
        wire(env, { ok: false, error: { code: 'OBSERVE_FAILED', message: 9, retryable: 'true' } }),
    });
    expect(err(await host.observe(OBSERVE_REQUEST))).toEqual({
      code: 'OBSERVE_FAILED',
      message: '',
      retryable: false,
    });
  });

  it('treats an ok:false answer without an error record as a protocol violation', async () => {
    const { host } = build({ observe: env => wire(env, { ok: false }) });
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('PROTOCOL_ERROR');
    const execute = build({ execute: env => wire(env, { ok: false, error: 'boom' }) });
    expect(await execute.host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      code: 'PROTOCOL_ERROR',
    });
  });

  it('treats an answer whose ok is neither true nor false as a protocol violation', async () => {
    const { host } = build({ observe: env => wire(env, { ok: 'yes', value: makeObservation() }) });
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('PROTOCOL_ERROR');
  });

  it('treats an unknown lost reason as a transport error', async () => {
    const { host } = build({
      execute: () => ({ kind: 'lost', reason: 'weird' }) as unknown as TaskTransportResult,
    });
    expect(await host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
    const observe = build({
      observe: () => ({ kind: 'lost', reason: 'weird' }) as unknown as TaskTransportResult,
    });
    const error = err(await observe.host.observe(OBSERVE_REQUEST));
    expect(error).toMatchObject({ code: 'HOST_UNAVAILABLE', retryable: true });
  });

  it('scrubs a thrown string and ignores a thrown value that is not text', async () => {
    const secret = freshSecret();
    const text = build({ execute: () => rejects(`socket closed after ${secret}`) });
    const first = await text.host.execute(fillRequest(secret));
    expect(first.message).toContain(REDACTED_MARK);
    expect(JSON.stringify(first)).not.toContain(secret);
    const number = build({ execute: () => rejects(42) });
    expect(await number.host.execute(makeCommandRequest())).toMatchObject({
      status: 'uncertain',
      code: 'DOCUMENT_LOST',
    });
  });

  it('is robust to a hello that wraps null capabilities fields', async () => {
    const { host } = build({
      hello: env => reply(env, { ...helloValue(), capabilities: null }),
    });
    expect(err(await host.capabilities()).code).toBe('PROTOCOL_ERROR');
  });
});

// ---------------------------------------------------------------------------------------------
// Observe error mapping and document tracking
// ---------------------------------------------------------------------------------------------

describe('observe error mapping', () => {
  it('maps a lost navigation to a retryable DOCUMENT_LOST and a lost transport to HOST_UNAVAILABLE', async () => {
    const navigated = build({ observe: () => lost('navigated') });
    expect(err(await navigated.host.observe(OBSERVE_REQUEST))).toMatchObject({
      code: 'DOCUMENT_LOST',
      retryable: true,
    });
    const broken = build({ observe: () => lost('error', 'proxy reset') });
    const error = err(await broken.host.observe(OBSERVE_REQUEST));
    expect(error).toMatchObject({ code: 'HOST_UNAVAILABLE', retryable: true });
    expect(error.message).toContain('proxy reset');
    const closed = build({ observe: () => lost('closed') });
    expect(err(await closed.host.observe(OBSERVE_REQUEST)).code).toBe('HOST_UNAVAILABLE');
  });

  it('retries DOCUMENT_CHANGED even when the page marks it not retryable, and reports it retryable', async () => {
    const { host, fake } = build({
      observe: env => replyError(env, { code: 'DOCUMENT_CHANGED', retryable: false }, DOC_B),
    });
    const error = err(await host.observe(OBSERVE_REQUEST));
    expect(error).toMatchObject({ code: 'DOCUMENT_CHANGED', retryable: true });
    expect(fake.count('observe')).toBe(3);
  });

  it('follows a changed live documentId reported with another page error', async () => {
    const { host, fake } = build({
      hello: sequence(
        env => replyHello(env, helloValue()),
        env => replyHello(env, helloValue({ documentId: DOC_B }))
      ),
      observe: sequence(
        env => replyError(env, { code: 'OBSERVE_FAILED', retryable: true }, DOC_B),
        env => reply(env, makeObservation({ documentId: DOC_B }), DOC_B)
      ),
    });
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('OBSERVE_FAILED');
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(2);
    expect(fake.envelopes('observe')[1]?.expectDocumentId).toBe(DOC_B);
  });

  it('records the session of every observe, so dispose can release it even after a failure', async () => {
    const { host, fake } = build({ observe: env => replyError(env, { code: 'OBSERVE_FAILED' }) });
    await host.observe({ sessionId: 'ses_failedsession' });
    await host.dispose();
    expect(fake.envelopes('release').map(envelope => envelope.payload)).toEqual([
      { sessionId: 'ses_failedsession' },
    ]);
  });

  it('answers HOST_DISPOSED before CANCELLED when both apply', async () => {
    const { host } = build();
    await host.dispose();
    const controller = new AbortController();
    controller.abort();
    expect(err(await host.capabilities(controller.signal)).code).toBe('HOST_DISPOSED');
    expect(await host.execute(makeCommandRequest(), controller.signal)).toMatchObject({
      code: 'HOST_DISPOSED',
    });
  });

  it('turns an unexpected failure inside a host call into an INTERNAL result, never a rejection', async () => {
    const fake = makeTransport({}, { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) });
    const host = createRemoteTaskHost({
      transport: fake.transport,
      createId: () => {
        throw new Error('no ids');
      },
    });
    expect(err(await host.capabilities()).code).toBe('INTERNAL');
    expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('INTERNAL');
    const locate = host.location;
    expect(err(await (locate?.() ?? Promise.reject(new Error('no location')))).code).toBe(
      'INTERNAL'
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('survives an injected sleep that rejects', async () => {
    const { host, fake } = build(
      {
        hello: sequence(
          env => replyHello(env, helloValue({ ready: false })),
          env => replyHello(env, helloValue())
        ),
      },
      {
        config: {
          sleep: async () => {
            throw new Error('timer broke');
          },
        },
      }
    );
    ok(await host.capabilities());
    expect(fake.count('hello')).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Navigation waiting, bounded memory, abort plumbing
// ---------------------------------------------------------------------------------------------

describe('navigation waiting', () => {
  const nextDoc: Handler = env =>
    replyHello(env, helloValue({ documentId: DOC_B, url: `${FIXTURE_ORIGIN}/orders` }));

  it('terminates a navigated wait against a clock that never moves', async () => {
    const frozen: Timers = { ...autoTimers(), clock: () => 0, sleep: async () => undefined };
    const { host, fake } = build(
      { hello: env => replyHello(env, helloValue()), execute: () => lost('navigated') },
      { timers: frozen, config: { navigationTimeoutMs: 200, pollIntervalMs: 50 } }
    );
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome.status).toBe('uncertain');
    expect(fake.count('hello')).toBe(5);
  });

  it('a lost timeout looks once for a different document and never sleeps', async () => {
    const { host, fake, timers } = build({
      hello: env => replyHello(env, helloValue()),
      execute: () => lost('timeout'),
    });
    await host.execute(makeCommandRequest());
    expect(fake.count('hello')).toBe(1);
    expect(timers.slept).toEqual([]);
  });

  it('a lost timeout asks waitForDocument for one millisecond, never for zero (zero means forever)', async () => {
    const waitForDocument = jest.fn(async (): Promise<TaskDocumentInfo | null> => null);
    const { host } = build({ execute: () => lost('timeout') }, { transport: { waitForDocument } });
    await host.execute(makeCommandRequest());
    expect((waitForDocument.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ timeoutMs: 1 });
  });

  it('hands the caller signal to waitForDocument', async () => {
    const controller = new AbortController();
    const waitForDocument = jest.fn(async (): Promise<TaskDocumentInfo | null> => null);
    const { host } = build(
      { execute: () => lost('navigated') },
      { transport: { waitForDocument, concurrent: false } }
    );
    await host.execute(makeCommandRequest(), controller.signal);
    expect((waitForDocument.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      signal: controller.signal,
    });
  });

  it('keeps asking waitForDocument while it answers a document that is not ready', async () => {
    const answers: TaskDocumentInfo[] = [
      { documentId: DOC_B, url: `${FIXTURE_ORIGIN}/orders`, ready: false },
      { documentId: DOC_B, url: `${FIXTURE_ORIGIN}/orders`, ready: true },
    ];
    const waitForDocument = jest.fn(
      async (): Promise<TaskDocumentInfo | null> => answers.shift() ?? null
    );
    const { host } = build(
      { hello: nextDoc, execute: () => lost('navigated') },
      { transport: { waitForDocument } }
    );
    expect((await host.execute(makeCommandRequest())).status).toBe('navigated');
    expect(waitForDocument).toHaveBeenCalledTimes(2);
  });

  it('confirms a waitForDocument answer with hello: a hello that is not usable does not count', async () => {
    const waitForDocument = jest.fn(
      async (): Promise<TaskDocumentInfo | null> => ({
        documentId: DOC_B,
        url: FIXTURE_URL,
        ready: true,
      })
    );
    const { host, fake } = build(
      {
        hello: sequence(
          env => replyHello(env, helloValue({ documentId: DOC_B, isTop: false })),
          nextDoc
        ),
        execute: () => lost('navigated'),
      },
      { transport: { waitForDocument } }
    );
    expect((await host.execute(makeCommandRequest())).status).toBe('navigated');
    expect(fake.count('hello')).toBe(2);
  });

  it('keeps at most 16 remembered urls: the oldest document is forgotten first', async () => {
    const run = async (observations: number): Promise<string | undefined> => {
      let sequenceNumber = 0;
      const { host } = build({
        hello: sequence(env => replyHello(env, helloValue()), nextDoc),
        observe: env => {
          const index = sequenceNumber;
          sequenceNumber += 1;
          return reply(
            env,
            makeObservation({ documentId: `doc_${index}`, url: `${FIXTURE_ORIGIN}/page/${index}` })
          );
        },
        execute: () => lost('navigated'),
      });
      for (let index = 0; index < observations; index += 1) {
        ok(await host.observe(OBSERVE_REQUEST));
      }
      const outcome = await host.execute(
        makeCommandRequest({ scope: makeScope({ documentId: 'doc_0' }) })
      );
      return outcome.navigation?.fromUrl;
    };
    expect(await run(16)).toBe(`${FIXTURE_ORIGIN}/page/0`);
    expect(await run(17)).toBe('');
  });

  it('forgets the least recently seen document, not the first one seen: a document observed again stays', async () => {
    const order = [...Array.from({ length: 16 }, (_, index) => index), 0, 16];
    let position = 0;
    const { host } = build({
      hello: sequence(env => replyHello(env, helloValue()), nextDoc),
      observe: env => {
        const id = order[position] ?? 0;
        position += 1;
        return reply(
          env,
          makeObservation({
            documentId: `doc_${id}`,
            url: `${FIXTURE_ORIGIN}/page/${id}/v${position}`,
          })
        );
      },
      execute: () => lost('navigated'),
    });
    for (let index = 0; index < order.length; index += 1) {
      ok(await host.observe(OBSERVE_REQUEST));
    }
    const kept = await host.execute(
      makeCommandRequest({ scope: makeScope({ documentId: 'doc_0' }) })
    );
    expect(kept.navigation?.fromUrl).toBe(`${FIXTURE_ORIGIN}/page/0/v17`);
    const dropped = await host.execute(
      makeCommandRequest({ scope: makeScope({ documentId: 'doc_1' }) })
    );
    expect(dropped.navigation?.fromUrl).toBe('');
  });
});

describe('abort plumbing', () => {
  type Gate = Deferred<(envelope: TaskBridgeEnvelope) => TaskTransportResult>;

  const startExecute = (options: BuildOptions = {}, script: Script = {}) => {
    const gate: Gate = deferred();
    const timers = options.timers ?? manualTimers();
    const built = build(
      { execute: env => gate.promise.then(make => make(env)), ...script },
      { ...options, timers }
    );
    const controller = new AbortController();
    const pending = built.host.execute(makeCommandRequest(), controller.signal);
    return { ...built, timers, gate, controller, pending };
  };

  it('leaves no abort listener behind after a normal finish', async () => {
    const { gate, controller, pending } = startExecute();
    await flush();
    expect(getEventListeners(controller.signal, 'abort').length).toBeGreaterThan(0);
    gate.resolve(env => reply(env, makeOutcome('applied', 'applied')));
    await pending;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('leaves no abort listener and no pending sleep after a response inside the grace', async () => {
    const { gate, controller, pending, timers } = startExecute();
    await flush();
    controller.abort();
    await flush();
    expect(timers.outstanding()).toBe(1);
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    await pending;
    expect(timers.outstanding()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('leaves no listener after the grace expires', async () => {
    const { controller, pending, timers } = startExecute();
    await flush();
    controller.abort();
    await flush();
    await timers.advance(2000);
    await pending;
    expect(timers.outstanding()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('sends the cancel when the transport itself aborts the signal while taking the call', async () => {
    const controller = new AbortController();
    const gate: Gate = deferred();
    const timers = manualTimers();
    const { host, fake } = build(
      {
        execute: env => {
          controller.abort();
          return gate.promise.then(make => make(env));
        },
      },
      { timers }
    );
    const pending = host.execute(makeCommandRequest(), controller.signal);
    await flush();
    const execute = fake.envelopes('execute')[0];
    expect(fake.envelopes('cancel')[0]?.payload).toEqual({ targetCallId: execute?.callId });
    gate.resolve(env => reply(env, makeOutcome('failed', 'none', { code: 'EXECUTION_CANCELLED' })));
    await pending;
  });

  it('still waits out the grace when the cancel envelope cannot even be built', async () => {
    const gate: Gate = deferred();
    const timers = manualTimers();
    const fake = makeTransport({ execute: env => gate.promise.then(make => make(env)) });
    let issued = 0;
    const host = createRemoteTaskHost({
      transport: fake.transport,
      clock: timers.clock,
      sleep: timers.sleep,
      createId: prefix => {
        issued += 1;
        if (issued > 1) {
          throw new Error('out of ids');
        }
        return `${prefix}_c0de00000001`;
      },
    });
    const controller = new AbortController();
    const pending = host.execute(makeCommandRequest(), controller.signal);
    await flush();
    controller.abort();
    await flush();
    expect(fake.count('cancel')).toBe(0);
    await timers.advance(2000);
    expect(await pending).toMatchObject({ status: 'uncertain', code: 'EXECUTION_CANCELLED' });
  });

  it('a failure after the send is uncertain/INTERNAL, a failure before it failed/none', async () => {
    let calls = 0;
    const fake = makeTransport({ execute: () => lost('closed') });
    const host = createRemoteTaskHost({
      transport: fake.transport,
      createId: callIds(),
      clock: () => {
        calls += 1;
        if (calls > 1) {
          throw new Error('clock failed');
        }
        return 0;
      },
    });
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({ status: 'uncertain', effect: 'uncertain', code: 'INTERNAL' });
    expect(outcome.durationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Durations and the real default clock, timer and id source
// ---------------------------------------------------------------------------------------------

describe('durations', () => {
  it('measures durationMs with the injected clock, from the start of the call', async () => {
    let now = 1000;
    const { host } = build(
      {
        execute: () => {
          now += 40;
          return lost('closed');
        },
      },
      { config: { clock: () => now } }
    );
    expect((await host.execute(makeCommandRequest())).durationMs).toBe(40);
  });

  it('never reports a negative duration when the clock goes backwards', async () => {
    let now = 1000;
    const { host } = build(
      {
        execute: () => {
          now -= 10;
          return lost('closed');
        },
      },
      { config: { clock: () => now } }
    );
    expect((await host.execute(makeCommandRequest())).durationMs).toBe(0);
  });
});

describe('default timers and ids', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const useFakeTimers = (): void => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  };

  it('sleeps exactly pollIntervalMs on a real timer and keeps polling afterwards', async () => {
    useFakeTimers();
    const fake = makeTransport({
      hello: sequence(
        env => replyHello(env, helloValue({ ready: false })),
        env => replyHello(env, helloValue())
      ),
    });
    const host = createRemoteTaskHost({
      transport: fake.transport,
      createId: callIds(),
      pollIntervalMs: 1000,
    });
    const pending = host.capabilities();
    await flush();
    expect(fake.count('hello')).toBe(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(fake.count('hello')).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    ok(await pending);
    expect(fake.count('hello')).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ends a default sleep at once when its signal aborts, and clears the timer', async () => {
    useFakeTimers();
    const fake = makeTransport({ hello: env => replyHello(env, helloValue({ ready: false })) });
    const host = createRemoteTaskHost({
      transport: fake.transport,
      createId: callIds(),
      pollIntervalMs: 5000,
      navigationTimeoutMs: 60000,
    });
    const controller = new AbortController();
    const pending = host.capabilities(controller.signal);
    await flush();
    expect(jest.getTimerCount()).toBe(1);
    controller.abort();
    expect(err(await pending).code).toBe('CANCELLED');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses Date.now as the default clock for durations and deadlines', async () => {
    useFakeTimers();
    jest.setSystemTime(5_000_000);
    const fake = makeTransport({
      execute: () => {
        jest.setSystemTime(5_000_250);
        return lost('closed');
      },
    });
    const host = createRemoteTaskHost({ transport: fake.transport, createId: callIds() });
    expect((await host.execute(makeCommandRequest())).durationMs).toBe(250);
  });

  it('draws default ids from crypto when it exists and falls back to Math.random without it', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const fake = makeTransport();
      const host = createRemoteTaskHost({ transport: fake.transport });
      ok(await host.capabilities());
      ok(await host.observe(OBSERVE_REQUEST));
      const ids = fake.calls.map(entry => entry.envelope.callId);
      ids.forEach(id => expect(id).toMatch(/^req_[0-9a-f]{12}$/));
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'crypto');
      } else {
        Object.defineProperty(globalThis, 'crypto', descriptor);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// R12: every URL the host receives is redacted, including those nested in an observation
// ---------------------------------------------------------------------------------------------

describe('nested observation urls', () => {
  const secretQuery = (): string => `${freshHex()}${freshHex()}${freshHex()}`;

  it('redacts element hrefs, element form targets and form actions', async () => {
    const token = secretQuery();
    const dirty = (path: string): string =>
      `https://user:pw@shop.example.test${path}?access_token=${token}&keep=1#frag`;
    const raw = makeObservation({
      elements: [
        makeElement({ id: 't1', href: dirty('/a') }),
        makeElement({ id: 't2', formTarget: { action: dirty('/submit'), method: 'POST' } }),
        makeElement({ id: 't3' }),
      ],
      forms: [makeForm({ action: dirty('/form') })],
    });
    const { host } = build({ observe: env => reply(env, raw) });
    const observation = ok(await host.observe(OBSERVE_REQUEST));
    const json = JSON.stringify(observation);
    expect(json).not.toContain(token);
    expect(json).not.toContain('user:pw');
    expect(json).not.toContain('#frag');
    const redactor = createRedactor();
    expect(observation.elements[0]?.href).toBe(redactor.redactUrl(dirty('/a')));
    expect(observation.elements[1]?.formTarget).toEqual({
      action: redactor.redactUrl(dirty('/submit')),
      method: 'POST',
    });
    expect(observation.forms[0]?.action).toBe(redactor.redactUrl(dirty('/form')));
    expect(observation.elements[0]?.href).toContain('keep=1');
    expect('href' in (observation.elements[2] ?? {})).toBe(false);
    expect('formTarget' in (observation.elements[2] ?? {})).toBe(false);
  });

  it('leaves every other field of the observation, ids and signatures included, untouched', async () => {
    const raw = makeObservation({
      elements: [makeElement({ id: 't1', href: `${FIXTURE_ORIGIN}/a` })],
      forms: [makeForm()],
    });
    const { host } = build({ observe: env => reply(env, raw) });
    expect(ok(await host.observe(OBSERVE_REQUEST))).toEqual(raw);
  });

  it('does not mutate the object the transport returned', async () => {
    const token = secretQuery();
    const raw = makeObservation({
      elements: [makeElement({ id: 't1', href: `${FIXTURE_ORIGIN}/a?auth_token=${token}` })],
    });
    const before = JSON.stringify(raw);
    const { host } = build({ observe: env => reply(env, raw) });
    ok(await host.observe(OBSERVE_REQUEST));
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('redacts the hello url used as the from url of a navigation', async () => {
    const token = secretQuery();
    const { host } = build({
      hello: sequence(
        env => replyHello(env, helloValue({ url: `${FIXTURE_ORIGIN}/start?api_token=${token}` })),
        env => replyHello(env, helloValue({ documentId: DOC_B, url: `${FIXTURE_ORIGIN}/next` }))
      ),
      execute: () => lost('navigated'),
    });
    ok(await host.capabilities());
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome.navigation?.fromUrl).toBe(`${FIXTURE_ORIGIN}/start?api_token=[REDACTED]`);
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  it('tolerates elements and forms that are not records', async () => {
    const raw = {
      ...makeObservation(),
      elements: [null, 5, makeElement({ id: 't1' })],
      forms: [null],
    };
    const { host } = build({ observe: env => reply(env, raw) });
    const observation = ok(await host.observe(OBSERVE_REQUEST));
    expect(observation.elements).toHaveLength(3);
  });
});

describe('cached hello after a lost execute', () => {
  it.each<[string, TaskTransportLostReason]>([
    ['closed', 'closed'],
    ['error', 'error'],
    ['timeout', 'timeout'],
  ])('is dropped after lost %s, so the next observe asks hello again', async (_name, reason) => {
    const { host, fake } = build({ execute: () => lost(reason) });
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(1);
    await host.execute(makeCommandRequest());
    const afterExecute = fake.count('hello');
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(afterExecute + 1);
  });

  it('is kept after a normal outcome', async () => {
    const { host, fake } = build();
    ok(await host.observe(OBSERVE_REQUEST));
    await host.execute(makeCommandRequest());
    ok(await host.observe(OBSERVE_REQUEST));
    expect(fake.count('hello')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Every status/effect pair of the contract, accepted or refused
// ---------------------------------------------------------------------------------------------

describe('status and effect pairs', () => {
  const VALID: Readonly<Record<string, readonly string[]>> = {
    applied: ['applied', 'none'],
    noop_already_satisfied: ['none'],
    rejected_stale: ['none'],
    rejected_invalid: ['none'],
    rejected_scope: ['none'],
    failed: ['none', 'applied'],
    uncertain: ['uncertain'],
    navigated: ['applied', 'uncertain'],
  };
  const PAIRS: readonly (readonly [string, string, boolean])[] = Object.keys(VALID).flatMap(
    status =>
      ['none', 'applied', 'uncertain'].map(
        effect => [status, effect, (VALID[status] ?? []).includes(effect)] as const
      )
  );

  it.each(PAIRS)('%s with effect %s is accepted: %s', async (status, effect, accepted) => {
    const { host } = build({ execute: env => reply(env, { status, effect }) });
    const outcome = await host.execute(makeCommandRequest());
    if (accepted) {
      expect({ status: outcome.status, effect: outcome.effect }).toEqual({ status, effect });
      expect(outcome.code).toBeUndefined();
    } else {
      expect(outcome).toMatchObject({
        status: 'uncertain',
        effect: 'uncertain',
        code: 'PROTOCOL_ERROR',
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial review of m3b: gaps the first pass left open
// ---------------------------------------------------------------------------------------------

describe('an abort that lands before the send', () => {
  type CountingSignal = { readonly signal: AbortSignal; readonly reads: () => number };

  /** Reports `aborted` from its `abortFromRead`-th read on: models an abort landing at one exact await. */
  const countingSignal = (abortFromRead: number): CountingSignal => {
    let reads = 0;
    const target = new EventTarget();
    Object.defineProperty(target, 'aborted', {
      get: () => {
        reads += 1;
        return reads >= abortFromRead;
      },
    });
    return { signal: target as unknown as AbortSignal, reads: () => reads };
  };

  const withLocation = {
    transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) },
  } satisfies BuildOptions;

  it.each<[string, BuildOptions]>([
    ['without an authoritative location', {}],
    ['with an authoritative location', withLocation],
  ])(
    'sends nothing when the signal aborts right after execute() was called, %s',
    async (_n, options) => {
      const { host, fake } = build({}, options);
      const controller = new AbortController();
      const pending = host.execute(makeCommandRequest(), controller.signal);
      controller.abort();
      expect(await pending).toMatchObject({
        status: 'failed',
        effect: 'none',
        code: 'EXECUTION_CANCELLED',
      });
      expect(fake.count('execute')).toBe(0);
      expect(fake.count('cancel')).toBe(0);
    }
  );

  it.each<[string, BuildOptions]>([
    ['without an authoritative location', {}],
    ['with an authoritative location', withLocation],
  ])(
    'never sends the execute once any check before the send saw an abort, %s',
    async (_n, options) => {
      let readsAtSend = -1;
      const baseline = countingSignal(Number.POSITIVE_INFINITY);
      const measured = build(
        {
          execute: env => {
            readsAtSend = baseline.reads();
            return reply(env, makeOutcome('applied', 'applied'));
          },
        },
        options
      );
      expect((await measured.host.execute(makeCommandRequest(), baseline.signal)).status).toBe(
        'applied'
      );
      // a control that measured nothing would pass the loop below for the wrong reason
      expect(readsAtSend).toBeGreaterThanOrEqual(2);

      for (let abortFromRead = 1; abortFromRead <= readsAtSend; abortFromRead += 1) {
        const { host, fake } = build({}, options);
        const probe = countingSignal(abortFromRead);
        const outcome = await host.execute(makeCommandRequest(), probe.signal);
        expect(outcome).toMatchObject({ status: 'failed', effect: 'none' });
        expect(fake.count('execute')).toBe(0);
      }
    }
  );

  it('observe: an abort that lands after the origin check sends no observe envelope', async () => {
    const gate = deferred<TaskHostResult<{ url: string; origin: string }>>();
    const { host, fake } = build({}, { transport: { location: () => gate.promise } });
    const controller = new AbortController();
    const pending = host.observe(OBSERVE_REQUEST, controller.signal);
    await flush();
    controller.abort();
    gate.resolve({ ok: true, value: { url: FIXTURE_URL, origin: FIXTURE_ORIGIN } });
    expect(err(await pending).code).toBe('CANCELLED');
    expect(fake.count('observe')).toBe(0);
  });

  it('capabilities: an abort during a poll sleep ends the wait without another hello', async () => {
    const timers = manualTimers();
    const { host, fake } = build(
      { hello: envelope => replyHello(envelope, helloValue({ ready: false })) },
      { timers }
    );
    const controller = new AbortController();
    const pending = host.capabilities(controller.signal);
    await flush();
    expect(fake.count('hello')).toBe(1);
    controller.abort();
    expect(err(await pending).code).toBe('CANCELLED');
    expect(fake.count('hello')).toBe(1);
  });
});

describe('an outcome cannot carry text past the scrub', () => {
  it('drops an outcome code that echoes the FILL value, and keeps an ordinary one', async () => {
    const secret = 'HUNTER2X';
    const echoed = build({
      execute: env => reply(env, { status: 'failed', effect: 'none', code: secret }),
    });
    const outcome = await echoed.host.execute(fillRequest(secret));
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect('code' in outcome).toBe(false);

    const embedded = build({
      execute: env => reply(env, { status: 'failed', effect: 'none', code: `X_${secret}_Y` }),
    });
    expect('code' in (await embedded.host.execute(fillRequest(secret)))).toBe(false);

    const ordinary = build({
      execute: env => reply(env, { status: 'failed', effect: 'none', code: 'TARGET_DISABLED' }),
    });
    expect((await ordinary.host.execute(fillRequest(secret))).code).toBe('TARGET_DISABLED');
  });

  it.each<[string, string]>([
    ['target', 'TARGET_STALE'],
    ['fail', 'EXECUTION_FAILED'],
    ['TIMEOUT', 'EXECUTION_TIMEOUT'],
    ['denied', 'PERMISSION_DENIED'],
  ])('keeps a known code when the typed value %j is a word inside it', async (typed, code) => {
    const { host } = build({
      execute: env => reply(env, { status: 'failed', effect: 'none', code }),
    });
    expect((await host.execute(fillRequest(typed))).code).toBe(code);
  });

  it("always answers with the request's own id, whatever id the page puts on the outcome", async () => {
    const secret = freshSecret();
    for (const requestId of [secret, 'req_somebodyelse', '', 7]) {
      const { host } = build({
        execute: env => reply(env, { status: 'applied', effect: 'applied', requestId }),
      });
      const outcome = await host.execute(fillRequest(secret, { requestId: 'req_commandid01' }));
      expect(outcome.requestId).toBe('req_commandid01');
      expect(JSON.stringify(outcome)).not.toContain(secret);
    }
  });

  it('refuses a navigation that claims to start on another document than the command ran on', async () => {
    for (const fromDocumentId of [DOC_B, 'doc_000000000099']) {
      const { host } = build({
        execute: env =>
          reply(env, {
            status: 'navigated',
            effect: 'applied',
            navigation: {
              kind: 'same_document',
              fromDocumentId,
              fromUrl: `${FIXTURE_ORIGIN}/a`,
              realmLost: false,
            },
          }),
      });
      expect(
        await host.execute(makeCommandRequest({ scope: makeScope({ documentId: DOC_A }) }))
      ).toMatchObject({
        status: 'uncertain',
        effect: 'uncertain',
        code: 'PROTOCOL_ERROR',
      });
    }
  });

  type ReadbackCase = readonly [string, Record<string, unknown>];

  const VALID_READBACKS: readonly ReadbackCase[] = [
    ['click', { kind: 'click', defaultPrevented: false }],
    [
      'click with submit',
      {
        kind: 'click',
        defaultPrevented: true,
        submit: { event: true, invalidControls: 2, defaultPrevented: false },
      },
    ],
    [
      'fill',
      {
        kind: 'fill',
        tag: 'input',
        inputType: 'text',
        length: 12,
        empty: false,
        changed: true,
        matched: true,
      },
    ],
    ['select', { kind: 'select', control: 'native', index: 2, changed: true, matched: null }],
    ['select aria', { kind: 'select', control: 'aria', index: 0, changed: false, matched: true }],
    [
      'setChecked',
      {
        kind: 'setChecked',
        control: 'aria',
        before: 'mixed',
        after: true,
        changed: true,
        matched: true,
      },
    ],
    [
      'scroll',
      {
        kind: 'scroll',
        moved: false,
        reason: 'edge',
        before: 0,
        after: 0,
        max: 800,
        atTop: true,
        atBottom: false,
      },
    ],
    [
      'press',
      {
        kind: 'press',
        defaultPrevented: false,
        defaultAction: 'implicit_submit',
        submit: { event: false, invalidControls: 0, defaultPrevented: false },
      },
    ],
    ['wait', { kind: 'wait', waitedMs: 250 }],
  ];

  const REQUIRED: Readonly<Record<string, readonly string[]>> = {
    click: ['defaultPrevented'],
    fill: ['tag', 'inputType', 'changed', 'matched'],
    select: ['control', 'index', 'changed', 'matched'],
    setChecked: ['control', 'before', 'after', 'changed', 'matched'],
    scroll: ['moved', 'before', 'after', 'max', 'atTop', 'atBottom'],
    press: ['defaultPrevented', 'defaultAction'],
    wait: ['waitedMs'],
  };

  const readbackOf = async (
    readback: unknown,
    request: TaskCommandRequest = makeCommandRequest()
  ): Promise<unknown> => {
    const { host } = build({
      execute: env => reply(env, { status: 'applied', effect: 'applied', readback }),
    });
    return (await host.execute(request)).readback;
  };

  it.each(VALID_READBACKS)('keeps a complete %s readback exactly', async (_name, readback) => {
    expect(await readbackOf(readback)).toEqual(readback);
  });

  it.each(VALID_READBACKS)('drops every field %s does not define', async (_name, readback) => {
    const kept = await readbackOf({ ...readback, leak: 'text', nested: { deep: 'text' } });
    expect(kept).toEqual(readback);
  });

  it.each(VALID_READBACKS)(
    'drops the readback when a field of %s has the wrong type',
    async (_n, readback) => {
      for (const key of Object.keys(readback).filter(field => field !== 'kind')) {
        expect(await readbackOf({ ...readback, [key]: { wrong: 'type' } })).toBeUndefined();
      }
    }
  );

  it.each(Object.entries(REQUIRED))(
    'drops a %s readback that misses a required field',
    async (kind, fields) => {
      const complete = VALID_READBACKS.find(([, record]) => record.kind === kind)?.[1] ?? {};
      for (const field of fields) {
        const { [field]: _removed, ...incomplete } = complete;
        expect(await readbackOf(incomplete)).toBeUndefined();
      }
    }
  );

  it('accepts a readback without its optional fields', async () => {
    expect(
      await readbackOf({ kind: 'press', defaultPrevented: true, defaultAction: 'none' })
    ).toEqual({
      kind: 'press',
      defaultPrevented: true,
      defaultAction: 'none',
    });
    expect(
      await readbackOf({
        kind: 'fill',
        tag: 'textarea',
        inputType: 'textarea',
        changed: false,
        matched: false,
      })
    ).toEqual({
      kind: 'fill',
      tag: 'textarea',
      inputType: 'textarea',
      changed: false,
      matched: false,
    });
  });

  it('refuses values outside the enumerations and non-finite numbers', async () => {
    const select = { kind: 'select', control: 'native', index: 1, changed: true, matched: true };
    expect(await readbackOf({ ...select, control: 'custom' })).toBeUndefined();
    expect(await readbackOf({ ...select, index: Number.NaN })).toBeUndefined();
    expect(await readbackOf({ ...select, matched: 'yes' })).toBeUndefined();
    const checked = {
      kind: 'setChecked',
      control: 'native',
      before: false,
      after: true,
      changed: true,
      matched: true,
    };
    expect(await readbackOf({ ...checked, before: 'maybe' })).toBeUndefined();
    const scroll = VALID_READBACKS.find(([name]) => name === 'scroll')?.[1] ?? {};
    expect(await readbackOf({ ...scroll, reason: 'because' })).toBeUndefined();
    const press = { kind: 'press', defaultPrevented: false, defaultAction: 'launch' };
    expect(await readbackOf(press)).toBeUndefined();
    const submit = { event: true, invalidControls: 'two', defaultPrevented: false };
    expect(await readbackOf({ kind: 'click', defaultPrevented: false, submit })).toBeUndefined();
  });

  it('refuses a submit record whose count is not a finite number', async () => {
    for (const invalidControls of [Number.NaN, Number.POSITIVE_INFINITY, '2', null]) {
      const submit = { event: true, invalidControls, defaultPrevented: false };
      expect(await readbackOf({ kind: 'click', defaultPrevented: false, submit })).toBeUndefined();
    }
  });

  it('rebuilds the nested submit record without its extra fields', async () => {
    const kept = await readbackOf({
      kind: 'click',
      defaultPrevented: false,
      submit: { event: true, invalidControls: 1, defaultPrevented: true, note: 'text' },
    });
    expect(kept).toEqual({
      kind: 'click',
      defaultPrevented: false,
      submit: { event: true, invalidControls: 1, defaultPrevented: true },
    });
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'drag', ''])(
    'drops a readback of kind %j',
    async kind => {
      expect(await readbackOf({ kind, defaultPrevented: false })).toBeUndefined();
    }
  );

  it('keeps the length of a plain FILL and drops it from a sensitive one', async () => {
    const fill = {
      kind: 'fill',
      tag: 'input',
      inputType: 'password',
      length: 9,
      empty: false,
      changed: true,
      matched: true,
    };
    const plain = makeCommandRequest({
      command: makeHostCommand('FILL', { value: 'plain text', sensitive: false }),
    });
    expect(await readbackOf(fill, plain)).toEqual(fill);
    const sensitive = (await readbackOf(fill, fillRequest(freshSecret()))) as Record<
      string,
      unknown
    >;
    expect('length' in sensitive).toBe(false);
    expect(sensitive).toEqual({
      kind: 'fill',
      tag: 'input',
      inputType: 'password',
      empty: false,
      changed: true,
      matched: true,
    });
  });

  it('treats a FILL command that does not say whether it is sensitive as sensitive', async () => {
    const fill = {
      kind: 'fill',
      tag: 'input',
      inputType: 'text',
      length: 4,
      changed: true,
      matched: true,
    };
    const unmarked = makeCommandRequest({
      command: { ...makeHostCommand('FILL', { value: 'abcd' }), sensitive: undefined } as never,
    });
    expect('length' in ((await readbackOf(fill, unmarked)) as Record<string, unknown>)).toBe(false);
  });

  it('keeps the length of a readback that belongs to a command other than FILL', async () => {
    const fill = {
      kind: 'fill',
      tag: 'input',
      inputType: 'text',
      length: 3,
      changed: true,
      matched: true,
    };
    expect(await readbackOf(fill, makeCommandRequest())).toEqual(fill);
  });

  it('scrubs the FILL value out of the tag and the input type, and refuses a long one', async () => {
    const secret = freshSecret();
    const echoed = (await readbackOf(
      { kind: 'fill', tag: secret, inputType: `type-${secret}`, changed: true, matched: true },
      fillRequest(secret)
    )) as Record<string, string>;
    expect(JSON.stringify(echoed)).not.toContain(secret);
    expect(echoed.tag).toContain(REDACTED_MARK);
    expect(echoed.inputType).toContain(REDACTED_MARK);
    const long = (length: number): Record<string, unknown> => ({
      kind: 'fill',
      tag: 'a'.repeat(length),
      inputType: 'text',
      changed: true,
      matched: true,
    });
    expect(await readbackOf(long(64))).toBeDefined();
    expect(await readbackOf(long(65))).toBeUndefined();
  });
});

describe('a command that names no document', () => {
  it.each<[string, unknown]>([
    ['an empty documentId', ''],
    ['a missing documentId', undefined],
    ['a numeric documentId', 7],
    ['a null documentId', null],
  ])('is rejected_invalid/INVALID_ACTION and never sent with %s', async (_name, documentId) => {
    const { host, fake } = build();
    const outcome = await host.execute(
      makeCommandRequest({ scope: { ...makeScope(), documentId: documentId as string } })
    );
    expect(outcome).toMatchObject({
      status: 'rejected_invalid',
      effect: 'none',
      code: 'INVALID_ACTION',
    });
    expect(fake.calls).toHaveLength(0);
    expect(hasUndefinedValue(outcome)).toBe(false);
  });

  it('does not let an invalid command through a transport that has an authoritative location', async () => {
    const { host, fake } = build(
      {},
      { transport: { location: locationAt(FIXTURE_URL, FIXTURE_ORIGIN) } }
    );
    const outcome = await host.execute(
      makeCommandRequest({ scope: { ...makeScope(), documentId: '' } })
    );
    expect(outcome.status).toBe('rejected_invalid');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('execution budget', () => {
  it('uses the default for a negative timeoutMs or settle.maxMs, never a zero or negative timeout', async () => {
    const negativeTimeout = build();
    await negativeTimeout.host.execute(
      makeCommandRequest({ timeoutMs: -5000, settle: { quietMs: 10, maxMs: 500 } })
    );
    expect(negativeTimeout.fake.recorded('execute')[0]?.call.timeoutMs).toBe(8000 + 500 + 2000);

    const negativeSettle = build();
    await negativeSettle.host.execute(
      makeCommandRequest({ timeoutMs: 3000, settle: { quietMs: 10, maxMs: -1 } })
    );
    expect(negativeSettle.fake.recorded('execute')[0]?.call.timeoutMs).toBe(3000 + 2000 + 2000);

    const bothNegative = build();
    await bothNegative.host.execute(
      makeCommandRequest({ timeoutMs: -4000, settle: { quietMs: 10, maxMs: -2000 } })
    );
    expect(bothNegative.fake.recorded('execute')[0]?.call.timeoutMs).toBe(8000 + 2000 + 2000);
  });

  it('keeps a zero timeoutMs: the settle budget and the margin still bound the call', async () => {
    const { host, fake } = build();
    await host.execute(makeCommandRequest({ timeoutMs: 0, settle: { quietMs: 10, maxMs: 0 } }));
    expect(fake.recorded('execute')[0]?.call.timeoutMs).toBe(2000);
  });
});

describe('a host built from a broken config or driven by hostile inputs', () => {
  it.each<[string, unknown]>([
    ['no config', undefined],
    ['null', null],
    ['an empty config', {}],
    ['a config whose transport is null', { transport: null }],
    ['a transport without invoke', { transport: {} }],
  ])(
    'never throws for %s and answers HOST_UNAVAILABLE without a transport call',
    async (_n, config) => {
      const host = createRemoteTaskHost(config as RemoteTaskHostConfig);
      expect(err(await host.capabilities())).toMatchObject({
        code: 'HOST_UNAVAILABLE',
        retryable: false,
      });
      expect(err(await host.observe(OBSERVE_REQUEST)).code).toBe('HOST_UNAVAILABLE');
      expect(await host.execute(makeCommandRequest())).toMatchObject({
        status: 'failed',
        effect: 'none',
        code: 'HOST_UNAVAILABLE',
      });
      await expect(host.release?.(SESSION)).resolves.toBeUndefined();
      await expect(host.dispose()).resolves.toBeUndefined();
      expect('location' in host).toBe(false);
    }
  );

  it('release never rejects, not even for a signal that throws when read', async () => {
    const { host } = build();
    const hostile = {
      get aborted(): boolean {
        throw new Error('hostile signal');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    await expect(host.release?.(SESSION, hostile)).resolves.toBeUndefined();
  });

  it('execute never rejects for a request that throws when it is read', async () => {
    const { host, fake } = build();
    const hostile = {
      get requestId(): string {
        throw new Error('hostile request');
      },
    } as unknown as TaskCommandRequest;
    expect(await host.execute(hostile)).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'INTERNAL',
      requestId: '',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('execute never rejects when the signal throws when read, and sends nothing it cannot cancel', async () => {
    const { host } = build();
    const hostile = {
      get aborted(): boolean {
        throw new Error('hostile signal');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const outcome = await host.execute(makeCommandRequest(), hostile);
    expect(['failed', 'uncertain']).toContain(outcome.status);
  });
});

describe('observe retry refreshes hello', () => {
  it('asks hello again before the second attempt even when the page names the document it was sent to', async () => {
    const { host, fake } = build({
      hello: sequence(
        env => replyHello(env, helloValue({ documentId: DOC_A })),
        env => replyHello(env, helloValue({ documentId: DOC_B }))
      ),
      observe: sequence(
        env => replyError(env, { code: 'DOCUMENT_CHANGED' }, DOC_A),
        env => reply(env, makeObservation({ documentId: DOC_B }), DOC_B)
      ),
    });
    expect(ok(await host.observe(OBSERVE_REQUEST)).documentId).toBe(DOC_B);
    expect(fake.count('hello')).toBe(2);
    expect(fake.envelopes('observe').map(envelope => envelope.expectDocumentId)).toEqual([
      DOC_A,
      DOC_B,
    ]);
  });
});

describe('lost, then a late hello', () => {
  it('reports the lost document once, then observes the document that became ready late', async () => {
    const timers = autoTimers();
    const { host, fake } = build(
      {
        execute: () => lost('navigated'),
        hello: (envelope, _call, index) =>
          replyHello(
            envelope,
            helloValue({ documentId: DOC_B, ready: index >= 12, url: `${FIXTURE_ORIGIN}/late` })
          ),
        observe: envelope => reply(envelope, makeObservation({ documentId: DOC_B }), DOC_B),
      },
      { timers, config: { navigationTimeoutMs: 100, pollIntervalMs: 10 } }
    );
    const outcome = await host.execute(makeCommandRequest());
    expect(outcome).toMatchObject({ status: 'uncertain', code: 'DOCUMENT_LOST' });
    const first = await host.observe(OBSERVE_REQUEST);
    expect(err(first)).toMatchObject({ code: 'DOCUMENT_LOST', retryable: true });
    expect(fake.count('observe')).toBe(0);
    const second = await host.observe(OBSERVE_REQUEST);
    expect(ok(second).documentId).toBe(DOC_B);
    expect(fake.envelopes('observe')).toHaveLength(1);
    expect(fake.envelopes('observe')[0]?.expectDocumentId).toBe(DOC_B);
  });
});

describe('the controller location', () => {
  it.each<[string, unknown]>([
    ['an empty origin', { url: FIXTURE_URL, origin: '' }],
    ['a missing origin', { url: FIXTURE_URL }],
    ['a numeric origin', { url: FIXTURE_URL, origin: 7 }],
  ])('is PROTOCOL_ERROR for %s, and a command is never sent on it', async (_name, value) => {
    const { host, fake } = build(
      {},
      { transport: { location: async () => ({ ok: true, value }) as never } }
    );
    expect(err(await (host.location as () => Promise<TaskHostResult<unknown>>)()).code).toBe(
      'PROTOCOL_ERROR'
    );
    expect(await host.execute(makeCommandRequest({ allowedOrigins: [''] }))).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'HOST_UNAVAILABLE',
    });
    expect(fake.count('execute')).toBe(0);
  });
});
