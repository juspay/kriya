import { TASK_BRIDGE_PROTOCOL, TASK_DEFAULT_SETTLE, TASK_DEFAULT_TIMEOUTS } from '@/types';
import type {
  Redactor,
  RemoteTaskHostConfig,
  TaskBridgeEnvelope,
  TaskBridgeHello,
  TaskBridgeMethod,
  TaskBridgePayloads,
  TaskCommandRequest,
  TaskCreateRemoteHostFn,
  TaskExecutionEffect,
  TaskExecutionOutcome,
  TaskExecutionStatus,
  TaskHost,
  TaskHostCapabilities,
  TaskHostError,
  TaskHostErrorCode,
  TaskHostResult,
  TaskIdFactory,
  TaskLocation,
  TaskNavigationInfo,
  TaskObservation,
  TaskObserveRequest,
  TaskOutcomeCode,
  TaskReadback,
  TaskStaleReason,
  TaskTransport,
  TaskTransportCall,
  TaskTransportLostReason,
} from '@/types';
import { createRedactor } from '@/utils/redact';

const DEFAULT_CALL_TIMEOUT_MS = 10000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15000;
const DEFAULT_CANCEL_GRACE_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_OBSERVE_RETRIES = 2;
/** Added on top of the command's own budget so the bridge's outcome wins the race against the transport. */
const EXECUTE_TIMEOUT_MARGIN_MS = 2000;
/** A `timeout` probes once for a different document and does not wait for one. */
const PROBE_TIMEOUT_MS = 0;
const MAX_MESSAGE_CHARS = 500;
const MAX_LABEL_CHARS = 64;
const MAX_REMEMBERED_URLS = 16;

/** Exhaustive over TaskOutcomeCode: a code added to ErrorCode stops this file compiling instead of being dropped. */
const OUTCOME_CODES: Readonly<Record<TaskOutcomeCode, true>> = {
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

const HOST_ERROR_CODES: readonly TaskHostErrorCode[] = [
  'HOST_DISPOSED',
  'HOST_UNAVAILABLE',
  'HOST_INCAPABLE',
  'DOCUMENT_CHANGED',
  'DOCUMENT_LOST',
  'TIMEOUT',
  'CANCELLED',
  'PROTOCOL_ERROR',
  'UNSUPPORTED',
  'OBSERVE_FAILED',
  'INTERNAL',
];

const LOST_REASONS: readonly TaskTransportLostReason[] = [
  'navigated',
  'closed',
  'timeout',
  'error',
];

const STALE_REASONS: readonly TaskStaleReason[] = [
  'unknown_snapshot',
  'superseded_snapshot',
  'session_released',
  'document_changed',
  'element_missing',
  'element_detached',
  'signature_changed',
  'option_changed',
  'structure_changed',
  'url_changed',
];

const EFFECTS_BY_STATUS: Readonly<Record<TaskExecutionStatus, readonly TaskExecutionEffect[]>> = {
  applied: ['applied', 'none'],
  noop_already_satisfied: ['none'],
  rejected_stale: ['none'],
  rejected_invalid: ['none'],
  rejected_scope: ['none'],
  failed: ['none', 'applied'],
  uncertain: ['uncertain'],
  navigated: ['applied', 'uncertain'],
};

const MSG_DISPOSED = 'The remote task host is disposed.';
const MSG_CANCELLED = 'The call was cancelled.';
const MSG_NOT_SENT_CANCELLED = 'Execution was cancelled before anything was sent.';
const MSG_SCOPE = 'The page origin is outside the allowed origins; nothing was sent.';
const MSG_LOCATION = 'The controller location could not be confirmed; nothing was sent.';
const MSG_ORIGIN_MISMATCH = 'The page reports an origin that differs from the controller location.';
const MSG_PROTOCOL = 'The bridge answered outside the protocol.';
const MSG_OUTCOME = 'The bridge answered with a malformed outcome.';
const MSG_NO_DOCUMENT = 'The command names no document; nothing was sent.';
const MSG_NO_TRANSPORT = 'No transport was configured.';
const MSG_GRACE = 'The command did not answer within the cancel grace period.';

// ---------------------------------------------------------------------------------------------
// File-private shapes
// ---------------------------------------------------------------------------------------------

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

type Failure = { readonly ok: false; readonly error: TaskHostError };

/** What a response reduces to after protocol validation. Error text is already scrubbed. */
type Reply =
  | { readonly ok: true; readonly documentId: string; readonly value: unknown }
  | { readonly ok: false; readonly documentId: string; readonly error: TaskHostError };

type LostCall = {
  readonly kind: 'lost';
  readonly reason: TaskTransportLostReason;
  /** Scrubbed. */
  readonly message: string;
};

type Sent =
  | { readonly kind: 'reply'; readonly reply: Reply }
  | LostCall
  | { readonly kind: 'invalid' };

type HostState = {
  hello: TaskBridgeHello | undefined;
  documentLost: boolean;
  disposed: boolean;
  /** Redacted urls by document id; bounded. Only the source of `fromUrl`. */
  readonly urls: Map<string, string>;
  readonly sessions: Set<string>;
  readonly observations: Map<
    string,
    Pick<TaskObservation, 'sessionId' | 'snapshotId' | 'documentId' | 'url'>
  >;
};

type HostContext = {
  readonly transport: TaskTransport;
  readonly callTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly cancelGraceMs: number;
  readonly pollIntervalMs: number;
  readonly createId: TaskIdFactory;
  readonly clock: () => number;
  readonly sleep: SleepFn;
  readonly redactor: Redactor;
  readonly state: HostState;
};

type HelloAttempt =
  | { readonly ok: true; readonly hello: TaskBridgeHello }
  | { readonly ok: false; readonly error: TaskHostError; readonly transient: boolean };

type NextDocument =
  | { readonly kind: 'found'; readonly hello: TaskBridgeHello }
  | { readonly kind: 'none' }
  | { readonly kind: 'aborted' };

type VerifiedDocument = {
  readonly hello: TaskBridgeHello;
  readonly location: TaskLocation | undefined;
};

type ObserveStep =
  | { readonly kind: 'done'; readonly result: TaskHostResult<TaskObservation> }
  | { readonly kind: 'retry'; readonly error: TaskHostError };

type ExecFrame = {
  readonly ctx: HostContext;
  readonly request: TaskCommandRequest;
  readonly signal: AbortSignal | undefined;
  readonly requestId: string;
  readonly started: number;
  /** Knows the FILL value of this request (R12b). */
  readonly redactor: Redactor;
};

type ExecuteSettled =
  | { readonly kind: 'sent'; readonly sent: Sent }
  | { readonly kind: 'grace_expired' };

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

const isHostErrorCode = (value: unknown): value is TaskHostErrorCode =>
  typeof value === 'string' && (HOST_ERROR_CODES as readonly string[]).includes(value);

const isLostReason = (value: unknown): value is TaskTransportLostReason =>
  typeof value === 'string' && (LOST_REASONS as readonly string[]).includes(value);

const isStatus = (value: unknown): value is TaskExecutionStatus =>
  typeof value === 'string' && Object.keys(EFFECTS_BY_STATUS).includes(value);

const isOutcomeCode = (value: unknown): value is TaskOutcomeCode =>
  typeof value === 'string' && Object.keys(OUTCOME_CODES).includes(value);

const isEffect = (value: unknown): value is TaskExecutionEffect =>
  value === 'none' || value === 'applied' || value === 'uncertain';

/** A function call, so TypeScript does not keep a stale narrowing of `signal.aborted` across awaits. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const positiveOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const nonNegativeOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const capText = (text: string): string =>
  text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;

const failure = (code: TaskHostErrorCode, message: string, retryable: boolean): Failure => ({
  ok: false,
  error: { code, message, retryable },
});

const succeed = <T>(value: T): TaskHostResult<T> => ({ ok: true, value });

const defaultClock = (): number => Date.now();

const defaultCreateId: TaskIdFactory = prefix => {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
};

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>(resolve => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener('abort', finish, { once: true });
  });

/** A host built without a usable transport answers every call as a failed transport instead of throwing. */
const NO_TRANSPORT: TaskTransport = {
  invoke: async () => ({ kind: 'lost', reason: 'error', message: MSG_NO_TRANSPORT }),
};

const usableTransport = (value: unknown): TaskTransport =>
  isRecord(value) && typeof value.invoke === 'function' ? (value as TaskTransport) : NO_TRANSPORT;

const createContext = (input: RemoteTaskHostConfig): HostContext => {
  const config: Partial<RemoteTaskHostConfig> = isRecord(input) ? input : {};
  return {
    transport: usableTransport(config.transport),
    callTimeoutMs: positiveOr(config.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS),
    navigationTimeoutMs: nonNegativeOr(config.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS),
    cancelGraceMs: nonNegativeOr(config.cancelGraceMs, DEFAULT_CANCEL_GRACE_MS),
    pollIntervalMs: positiveOr(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    createId: config.createId ?? defaultCreateId,
    clock: config.clock ?? defaultClock,
    sleep: config.sleep ?? defaultSleep,
    redactor: createRedactor(),
    state: {
      hello: undefined,
      documentLost: false,
      disposed: false,
      urls: new Map<string, string>(),
      sessions: new Set<string>(),
      observations: new Map(),
    },
  };
};

const callOptions = (timeoutMs: number, signal?: AbortSignal): TaskTransportCall =>
  signal === undefined ? { timeoutMs } : { signal, timeoutMs };

const describeThrown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : '';
};

/** The injected sleep may reject or ignore its signal: either way the wait is over. */
const sleepSafe = async (ctx: HostContext, ms: number, signal?: AbortSignal): Promise<void> => {
  try {
    await ctx.sleep(ms, signal);
  } catch {
    // a failing sleep only ends the wait early
  }
};

const rememberUrl = (state: HostState, documentId: string, url: string): void => {
  state.urls.delete(documentId);
  state.urls.set(documentId, url);
  while (state.urls.size > MAX_REMEMBERED_URLS) {
    const oldest = state.urls.keys().next();
    if (oldest.done === true) {
      return;
    }
    state.urls.delete(oldest.value);
  }
};

/** The cached hello belongs to one document: any other live document id invalidates it. */
const noteDocument = (state: HostState, documentId: string): void => {
  if (state.hello !== undefined && state.hello.documentId !== documentId) {
    state.hello = undefined;
  }
};

const adoptHello = (ctx: HostContext, hello: TaskBridgeHello): void => {
  ctx.state.hello = hello;
  rememberUrl(ctx.state, hello.documentId, ctx.redactor.redactUrl(hello.url));
};

const isUsableHello = (hello: TaskBridgeHello): boolean => hello.ready && hello.isTop;

// ---------------------------------------------------------------------------------------------
// Transport: envelopes and validated replies
// ---------------------------------------------------------------------------------------------

const buildEnvelope = <M extends TaskBridgeMethod>(
  ctx: HostContext,
  method: M,
  payload: TaskBridgePayloads[M],
  expectDocumentId?: string
): TaskBridgeEnvelope => {
  const base = { protocol: TASK_BRIDGE_PROTOCOL, callId: ctx.createId('req'), method, payload };
  return (
    expectDocumentId === undefined ? base : { ...base, expectDocumentId }
  ) as TaskBridgeEnvelope;
};

const readError = (value: unknown, redactor: Redactor): TaskHostError | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    code: isHostErrorCode(value.code) ? value.code : 'INTERNAL',
    message: typeof value.message === 'string' ? capText(redactor.scrub(value.message)) : '',
    retryable: value.retryable === true,
  };
};

const readReply = (
  envelope: TaskBridgeEnvelope,
  raw: unknown,
  redactor: Redactor
): Reply | null => {
  if (
    !isRecord(raw) ||
    raw.protocol !== TASK_BRIDGE_PROTOCOL ||
    raw.callId !== envelope.callId ||
    raw.method !== envelope.method ||
    !isNonEmptyString(raw.documentId)
  ) {
    return null;
  }
  if (raw.ok === true) {
    return { ok: true, documentId: raw.documentId, value: raw.value };
  }
  if (raw.ok === false) {
    const error = readError(raw.error, redactor);
    return error === null ? null : { ok: false, documentId: raw.documentId, error };
  }
  return null;
};

const lostCall = (
  reason: TaskTransportLostReason,
  message: string,
  redactor: Redactor
): LostCall => ({ kind: 'lost', reason, message: capText(redactor.scrub(message)) });

/** Never rejects and never returns unscrubbed transport text. */
const transmit = async (
  ctx: HostContext,
  envelope: TaskBridgeEnvelope,
  call: TaskTransportCall,
  redactor: Redactor
): Promise<Sent> => {
  let result: unknown;
  try {
    result = await ctx.transport.invoke(envelope, call);
  } catch (error) {
    return lostCall('error', describeThrown(error), redactor);
  }
  if (!isRecord(result)) {
    return { kind: 'invalid' };
  }
  if (result.kind === 'lost') {
    const reason = isLostReason(result.reason) ? result.reason : 'error';
    return lostCall(reason, typeof result.message === 'string' ? result.message : '', redactor);
  }
  if (result.kind === 'response') {
    const reply = readReply(envelope, result.response, redactor);
    return reply === null ? { kind: 'invalid' } : { kind: 'reply', reply };
  }
  return { kind: 'invalid' };
};

const lostError = (lost: LostCall): TaskHostError => {
  const detail = (text: string): string =>
    lost.message === '' ? text : `${text}: ${lost.message}`;
  switch (lost.reason) {
    case 'navigated':
      return {
        code: 'DOCUMENT_LOST',
        message: detail('The document was replaced during the call'),
        retryable: true,
      };
    case 'closed':
      return {
        code: 'HOST_UNAVAILABLE',
        message: detail('The page or browser was closed'),
        retryable: false,
      };
    case 'timeout':
      return { code: 'TIMEOUT', message: detail('The call timed out'), retryable: true };
    default:
      return {
        code: 'HOST_UNAVAILABLE',
        message: detail('The transport failed'),
        retryable: true,
      };
  }
};

// ---------------------------------------------------------------------------------------------
// hello and document tracking
// ---------------------------------------------------------------------------------------------

const readHello = (value: unknown): TaskBridgeHello | null => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.documentId) ||
    typeof value.url !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.ready !== 'boolean' ||
    typeof value.isTop !== 'boolean' ||
    !isRecord(value.capabilities) ||
    value.capabilities.protocol !== TASK_BRIDGE_PROTOCOL ||
    !Array.isArray(value.capabilities.operations) ||
    !isRecord(value.capabilities.redaction)
  ) {
    return null;
  }
  return value as TaskBridgeHello;
};

const fetchHello = async (ctx: HostContext, signal?: AbortSignal): Promise<HelloAttempt> => {
  const envelope = buildEnvelope(ctx, 'hello', {});
  const sent = await transmit(ctx, envelope, callOptions(ctx.callTimeoutMs, signal), ctx.redactor);
  if (sent.kind === 'lost') {
    return { ok: false, error: lostError(sent), transient: true };
  }
  if (sent.kind === 'invalid') {
    return {
      ok: false,
      error: failure('PROTOCOL_ERROR', MSG_PROTOCOL, false).error,
      transient: false,
    };
  }
  if (!sent.reply.ok) {
    return { ok: false, error: sent.reply.error, transient: sent.reply.error.retryable };
  }
  const hello = readHello(sent.reply.value);
  if (hello === null) {
    return {
      ok: false,
      error: failure('PROTOCOL_ERROR', MSG_PROTOCOL, false).error,
      transient: false,
    };
  }
  return { ok: true, hello };
};

/**
 * A document that is ready and top, from the cache or from polling hello until `navigationTimeoutMs`.
 * `fresh` skips the cache (after a lost call, a DOCUMENT_CHANGED or an origin doubt).
 */
const ensureDocument = async (
  ctx: HostContext,
  signal: AbortSignal | undefined,
  fresh: boolean
): Promise<TaskHostResult<TaskBridgeHello>> => {
  const cached = ctx.state.hello;
  if (!fresh && cached !== undefined) {
    return succeed(cached);
  }
  ctx.state.hello = undefined;
  const deadline = ctx.clock() + ctx.navigationTimeoutMs;
  const maxAttempts = Math.ceil(ctx.navigationTimeoutMs / ctx.pollIntervalMs) + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isAborted(signal)) {
      return failure('CANCELLED', MSG_CANCELLED, false);
    }
    const attemptResult = await fetchHello(ctx, signal);
    if (isAborted(signal)) {
      return failure('CANCELLED', MSG_CANCELLED, false);
    }
    if (attemptResult.ok && isUsableHello(attemptResult.hello)) {
      adoptHello(ctx, attemptResult.hello);
      return succeed(attemptResult.hello);
    }
    if (!attemptResult.ok && !attemptResult.transient) {
      return { ok: false, error: attemptResult.error };
    }
    if (ctx.clock() >= deadline) {
      break;
    }
    await sleepSafe(ctx, ctx.pollIntervalMs, signal);
  }
  return failure('DOCUMENT_LOST', 'No ready document answered the bridge.', true);
};

const waitForDocumentSafe = async (
  ctx: HostContext,
  previous: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<unknown> => {
  const { transport } = ctx;
  if (transport.waitForDocument === undefined) {
    return undefined;
  }
  try {
    return await transport.waitForDocument({
      previousDocumentId: previous,
      timeoutMs: Math.max(1, timeoutMs),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return null;
  }
};

const isNewReadyDocument = (info: unknown, previous: string): boolean =>
  isRecord(info) &&
  isNonEmptyString(info.documentId) &&
  info.documentId !== previous &&
  info.ready === true;

/**
 * Waits for a ready, top document whose id differs from `previous`: through the transport's
 * `waitForDocument` when it has one (then confirmed with hello), else by polling hello.
 */
const awaitNextDocument = async (
  ctx: HostContext,
  previous: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<NextDocument> => {
  const deadline = ctx.clock() + timeoutMs;
  const maxAttempts = Math.ceil(timeoutMs / ctx.pollIntervalMs) + 1;
  const accelerated = ctx.transport.waitForDocument !== undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isAborted(signal)) {
      return { kind: 'aborted' };
    }
    let candidate = true;
    if (accelerated) {
      const info = await waitForDocumentSafe(ctx, previous, deadline - ctx.clock(), signal);
      if (isAborted(signal)) {
        return { kind: 'aborted' };
      }
      if (info === null) {
        return { kind: 'none' };
      }
      candidate = isNewReadyDocument(info, previous);
    }
    if (candidate) {
      const polled = await fetchHello(ctx, signal);
      if (isAborted(signal)) {
        return { kind: 'aborted' };
      }
      if (polled.ok && isUsableHello(polled.hello) && polled.hello.documentId !== previous) {
        adoptHello(ctx, polled.hello);
        return { kind: 'found', hello: polled.hello };
      }
    }
    if (ctx.clock() >= deadline) {
      break;
    }
    await sleepSafe(ctx, ctx.pollIntervalMs, signal);
  }
  return { kind: 'none' };
};

// ---------------------------------------------------------------------------------------------
// Authoritative location
// ---------------------------------------------------------------------------------------------

/** An empty origin is no confirmation: it would equal another empty origin and any empty allow-list entry. */
const readLocation = (value: unknown): TaskLocation | null =>
  isRecord(value) && typeof value.url === 'string' && isNonEmptyString(value.origin)
    ? { url: value.url, origin: value.origin }
    : null;

/** Raw controller location (url not yet redacted). Callers decide what to do with a failure. */
const controllerLocation = async (
  ctx: HostContext,
  signal: AbortSignal | undefined
): Promise<TaskHostResult<TaskLocation>> => {
  const { transport } = ctx;
  if (transport.location === undefined) {
    return failure('UNSUPPORTED', 'The transport has no authoritative location.', false);
  }
  let result: unknown;
  try {
    result = await transport.location(callOptions(ctx.callTimeoutMs, signal));
  } catch (error) {
    const detail = capText(ctx.redactor.scrub(describeThrown(error)));
    return failure(
      'HOST_UNAVAILABLE',
      detail === '' ? 'The controller location could not be read.' : detail,
      true
    );
  }
  if (isRecord(result) && result.ok === true) {
    const location = readLocation(result.value);
    return location === null
      ? failure('PROTOCOL_ERROR', 'The controller location is malformed.', false)
      : succeed(location);
  }
  if (isRecord(result) && result.ok === false) {
    const error = readError(result.error, ctx.redactor);
    return error === null ? failure('PROTOCOL_ERROR', MSG_PROTOCOL, false) : { ok: false, error };
  }
  return failure('PROTOCOL_ERROR', 'The controller location is malformed.', false);
};

// ---------------------------------------------------------------------------------------------
// capabilities, location, observe
// ---------------------------------------------------------------------------------------------

const preflight = (ctx: HostContext, signal: AbortSignal | undefined): Failure | null => {
  if (ctx.state.disposed) {
    return failure('HOST_DISPOSED', MSG_DISPOSED, false);
  }
  if (ctx.transport === NO_TRANSPORT) {
    return failure('HOST_UNAVAILABLE', MSG_NO_TRANSPORT, false);
  }
  return isAborted(signal) ? failure('CANCELLED', MSG_CANCELLED, false) : null;
};

const guardResult = async <T>(
  run: () => Promise<TaskHostResult<T>>
): Promise<TaskHostResult<T>> => {
  try {
    return await run();
  } catch {
    return failure('INTERNAL', 'The remote host failed unexpectedly.', false);
  }
};

const mergeCapabilities = (
  ctx: HostContext,
  reported: TaskHostCapabilities
): TaskHostCapabilities => ({
  ...reported,
  hostKind: 'remote',
  persistsAcrossNavigation: true,
  detectsNavigation: true,
  authoritativeLocation: ctx.transport.location !== undefined,
  freshStateObservations:
    ctx.transport.location !== undefined && ctx.transport.refresh !== undefined,
  cancellation:
    ctx.transport.concurrent !== false && reported.cancellation === 'cooperative'
      ? 'cooperative'
      : 'none',
});

const readCapabilities = async (
  ctx: HostContext,
  signal: AbortSignal | undefined
): Promise<TaskHostResult<TaskHostCapabilities>> => {
  const blocked = preflight(ctx, signal);
  if (blocked !== null) {
    return blocked;
  }
  const ensured = await ensureDocument(ctx, signal, false);
  return ensured.ok ? succeed(mergeCapabilities(ctx, ensured.value.capabilities)) : ensured;
};

const locationLive = async (
  ctx: HostContext,
  signal: AbortSignal | undefined
): Promise<TaskHostResult<TaskLocation>> => {
  const blocked = preflight(ctx, signal);
  if (blocked !== null) {
    return blocked;
  }
  const located = await controllerLocation(ctx, signal);
  if (!located.ok) {
    return located;
  }
  const hello = await fetchHello(ctx, signal);
  if (isAborted(signal)) {
    return failure('CANCELLED', MSG_CANCELLED, false);
  }
  if (hello.ok && hello.hello.origin !== located.value.origin) {
    return failure('PROTOCOL_ERROR', MSG_ORIGIN_MISMATCH, false);
  }
  if (!hello.ok && !hello.transient) {
    return { ok: false, error: hello.error };
  }
  return succeed({
    url: ctx.redactor.redactUrl(located.value.url),
    origin: located.value.origin,
  });
};

/**
 * The document to observe: ready, and (with an authoritative location) on the origin the controller
 * sees. A stale hello gets one refresh before an origin difference counts as a lying page.
 */
const verifyDocument = async (
  ctx: HostContext,
  signal: AbortSignal | undefined,
  fresh: boolean
): Promise<TaskHostResult<VerifiedDocument>> => {
  const ensured = await ensureDocument(ctx, signal, fresh);
  if (!ensured.ok) {
    return ensured;
  }
  if (ctx.transport.location === undefined) {
    return succeed({ hello: ensured.value, location: undefined });
  }
  const located = await controllerLocation(ctx, signal);
  if (!located.ok) {
    return located;
  }
  if (located.value.origin === ensured.value.origin) {
    return succeed({ hello: ensured.value, location: located.value });
  }
  const refreshed = await ensureDocument(ctx, signal, true);
  if (!refreshed.ok) {
    return refreshed;
  }
  return refreshed.value.origin === located.value.origin
    ? succeed({ hello: refreshed.value, location: located.value })
    : failure('PROTOCOL_ERROR', MSG_ORIGIN_MISMATCH, false);
};

const redactElementUrls = (element: unknown, redactUrl: (url: string) => string): unknown => {
  if (!isRecord(element)) {
    return element;
  }
  const { href, formTarget } = element;
  const target =
    isRecord(formTarget) && typeof formTarget.action === 'string'
      ? { ...formTarget, action: redactUrl(formTarget.action) }
      : undefined;
  if (typeof href !== 'string' && target === undefined) {
    return element;
  }
  return {
    ...element,
    ...(typeof href === 'string' ? { href: redactUrl(href) } : {}),
    ...(target === undefined ? {} : { formTarget: target }),
  };
};

const redactFormUrl = (form: unknown, redactUrl: (url: string) => string): unknown =>
  isRecord(form) && typeof form.action === 'string'
    ? { ...form, action: redactUrl(form.action) }
    : form;

/** The page redacts its own urls; a page that does not (or lies) never reaches the coordinator with one. */
const redactObservationUrls = (
  observation: TaskObservation,
  redactUrl: (url: string) => string
): TaskObservation => ({
  ...observation,
  url: redactUrl(observation.url),
  elements: observation.elements.map(
    element => redactElementUrls(element, redactUrl) as TaskObservation['elements'][number]
  ),
  forms: Array.isArray(observation.forms)
    ? observation.forms.map(
        form => redactFormUrl(form, redactUrl) as TaskObservation['forms'][number]
      )
    : observation.forms,
});

const readObservation = (value: unknown): TaskObservation | null =>
  isRecord(value) &&
  isNonEmptyString(value.documentId) &&
  typeof value.url === 'string' &&
  typeof value.origin === 'string' &&
  Array.isArray(value.elements)
    ? (value as TaskObservation)
    : null;

const observeOnce = async (
  ctx: HostContext,
  request: TaskObserveRequest,
  signal: AbortSignal | undefined,
  fresh: boolean
): Promise<ObserveStep> => {
  const verified = await verifyDocument(ctx, signal, fresh);
  if (!verified.ok) {
    return { kind: 'done', result: verified };
  }
  const { hello, location } = verified.value;
  if (isAborted(signal)) {
    return { kind: 'done', result: failure('CANCELLED', MSG_CANCELLED, false) };
  }
  const envelope = buildEnvelope(ctx, 'observe', request, hello.documentId);
  const sent = await transmit(ctx, envelope, callOptions(ctx.callTimeoutMs, signal), ctx.redactor);
  if (isAborted(signal)) {
    return { kind: 'done', result: failure('CANCELLED', MSG_CANCELLED, false) };
  }
  if (sent.kind === 'invalid') {
    return { kind: 'done', result: failure('PROTOCOL_ERROR', MSG_PROTOCOL, false) };
  }
  if (sent.kind === 'lost') {
    ctx.state.hello = undefined;
    const error = lostError(sent);
    return error.retryable
      ? { kind: 'retry', error }
      : { kind: 'done', result: { ok: false, error } };
  }
  noteDocument(ctx.state, sent.reply.documentId);
  if (!sent.reply.ok) {
    const { error } = sent.reply;
    return error.code === 'DOCUMENT_CHANGED'
      ? { kind: 'retry', error: { ...error, retryable: true } }
      : { kind: 'done', result: { ok: false, error } };
  }
  const observation = readObservation(sent.reply.value);
  if (observation === null) {
    return {
      kind: 'done',
      result: failure('PROTOCOL_ERROR', 'The observation is malformed.', false),
    };
  }
  if (location !== undefined && observation.origin !== location.origin) {
    return { kind: 'done', result: failure('PROTOCOL_ERROR', MSG_ORIGIN_MISMATCH, false) };
  }
  const redacted = redactObservationUrls(observation, ctx.redactor.redactUrl);
  rememberUrl(ctx.state, redacted.documentId, redacted.url);
  ctx.state.observations.delete(request.sessionId);
  ctx.state.observations.set(request.sessionId, {
    sessionId: redacted.sessionId,
    snapshotId: redacted.snapshotId,
    documentId: redacted.documentId,
    url: redacted.url,
  });
  while (ctx.state.observations.size > MAX_REMEMBERED_URLS) {
    const oldest = ctx.state.observations.keys().next();
    if (oldest.done) {
      break;
    }
    ctx.state.observations.delete(oldest.value);
  }
  return { kind: 'done', result: succeed(redacted) };
};

const observeLive = async (
  ctx: HostContext,
  request: TaskObserveRequest,
  signal: AbortSignal | undefined
): Promise<TaskHostResult<TaskObservation>> => {
  const blocked = preflight(ctx, signal);
  if (blocked !== null) {
    return blocked;
  }
  if (request.freshState) {
    const refreshed = await refreshState(ctx, request, signal);
    if (!refreshed.ok) {
      return refreshed;
    }
  }
  const pageRequest: TaskObserveRequest = {
    sessionId: request.sessionId,
    ...(request.minSequence === undefined ? {} : { minSequence: request.minSequence }),
    ...(request.options === undefined ? {} : { options: request.options }),
  };
  if (typeof request.sessionId === 'string') {
    ctx.state.sessions.add(request.sessionId);
  }
  if (ctx.state.documentLost) {
    ctx.state.documentLost = false;
    return failure('DOCUMENT_LOST', 'No document became ready after the navigation.', true);
  }
  let lastError: TaskHostError = {
    code: 'OBSERVE_FAILED',
    message: 'The observation failed.',
    retryable: true,
  };
  for (let attempt = 0; attempt <= MAX_OBSERVE_RETRIES; attempt += 1) {
    const step = await observeOnce(ctx, pageRequest, signal, attempt > 0);
    if (step.kind === 'done') {
      return step.result;
    }
    lastError = step.error;
  }
  return { ok: false, error: lastError };
};

const refreshState = async (
  ctx: HostContext,
  request: TaskObserveRequest,
  signal?: AbortSignal
): Promise<TaskHostResult<TaskBridgeHello>> => {
  const fresh = request.freshState;
  const previous = ctx.state.observations.get(request.sessionId);
  if (!fresh || !previous || !ctx.transport.refresh || !ctx.transport.location) {
    return failure('HOST_INCAPABLE', 'Independent saved-state observation is unavailable.', false);
  }
  if (
    fresh.scope.sessionId !== request.sessionId ||
    fresh.scope.snapshotId !== previous.snapshotId ||
    fresh.scope.documentId !== previous.documentId
  ) {
    return failure('DOCUMENT_CHANGED', 'The independent read refers to an old observation.', false);
  }
  const located = await controllerLocation(ctx, signal);
  if (!located.ok) {
    return located;
  }
  if (
    !fresh.allowedOrigins.includes(located.value.origin) ||
    !/^https?:$/.test(new URL(located.value.url).protocol) ||
    ctx.redactor.redactUrl(located.value.url) !== previous.url
  ) {
    return failure('DOCUMENT_CHANGED', 'The current view is outside the observed scope.', false);
  }
  const current = await verifyDocument(ctx, signal, true);
  if (!current.ok) {
    return current;
  }
  if (current.value.hello.documentId !== previous.documentId) {
    return failure(
      'DOCUMENT_CHANGED',
      'The current document changed before the independent read.',
      false
    );
  }
  if (isAborted(signal)) {
    return failure('CANCELLED', MSG_CANCELLED, false);
  }
  const read = await ctx.transport.refresh(
    { url: located.value.url, allowedOrigins: fresh.allowedOrigins },
    callOptions(ctx.navigationTimeoutMs, signal)
  );
  if (!read.ok) {
    return failure(
      HOST_ERROR_CODES.includes(read.error.code) ? read.error.code : 'OBSERVE_FAILED',
      'The independent read failed.',
      read.error.retryable
    );
  }
  ctx.state.hello = undefined;
  const next = await verifyDocument(ctx, signal, true);
  if (!next.ok) {
    return next;
  }
  if (
    next.value.hello.documentId === previous.documentId ||
    !fresh.allowedOrigins.includes(next.value.hello.origin) ||
    ctx.redactor.redactUrl(next.value.hello.url) !== previous.url
  ) {
    return failure(
      'DOCUMENT_CHANGED',
      'The independent read did not produce an authorized new document.',
      false
    );
  }
  return succeed(next.value.hello);
};

// ---------------------------------------------------------------------------------------------
// execute: outcomes
// ---------------------------------------------------------------------------------------------

const elapsed = (frame: ExecFrame): number => Math.max(0, frame.ctx.clock() - frame.started);

const messageField = (message: string | undefined): { readonly message?: string } =>
  message === undefined || message === '' ? {} : { message };

const failedNone = (
  frame: ExecFrame,
  code: TaskOutcomeCode,
  message?: string
): TaskExecutionOutcome => ({
  requestId: frame.requestId,
  status: 'failed',
  effect: 'none',
  code,
  ...messageField(message),
  durationMs: elapsed(frame),
});

const rejectedScope = (frame: ExecFrame): TaskExecutionOutcome => ({
  requestId: frame.requestId,
  status: 'rejected_scope',
  effect: 'none',
  code: 'PERMISSION_DENIED',
  message: MSG_SCOPE,
  durationMs: elapsed(frame),
});

/** A command without the document it was observed on would reach whatever document is live. */
const rejectedInvalid = (frame: ExecFrame): TaskExecutionOutcome => ({
  requestId: frame.requestId,
  status: 'rejected_invalid',
  effect: 'none',
  code: 'INVALID_ACTION',
  message: MSG_NO_DOCUMENT,
  durationMs: elapsed(frame),
});

const uncertainOutcome = (
  frame: ExecFrame,
  code: TaskOutcomeCode,
  message?: string
): TaskExecutionOutcome => ({
  requestId: frame.requestId,
  status: 'uncertain',
  effect: 'uncertain',
  code,
  ...messageField(message),
  durationMs: elapsed(frame),
});

const navigatedOutcome = (
  frame: ExecFrame,
  next: TaskBridgeHello,
  fromUrl: string
): TaskExecutionOutcome => {
  return {
    requestId: frame.requestId,
    status: 'navigated',
    effect: 'uncertain',
    navigation: {
      kind: 'document',
      fromDocumentId: frame.request.scope.documentId,
      toDocumentId: next.documentId,
      fromUrl: frame.redactor.redactUrl(fromUrl),
      toUrl: frame.redactor.redactUrl(next.url),
      realmLost: true,
    },
    durationMs: elapsed(frame),
  };
};

const executeCode = (code: TaskHostErrorCode): TaskOutcomeCode => {
  if (code === 'TIMEOUT') {
    return 'EXECUTION_TIMEOUT';
  }
  return code === 'CANCELLED' ? 'EXECUTION_CANCELLED' : code;
};

const outcomeFromError = (frame: ExecFrame, error: TaskHostError): TaskExecutionOutcome =>
  error.code === 'HOST_UNAVAILABLE'
    ? failedNone(frame, 'HOST_UNAVAILABLE', error.message)
    : uncertainOutcome(frame, executeCode(error.code), error.message);

/** Navigation is optional; a present but malformed one (null result) makes the outcome invalid. */
const readNavigation = (
  frame: ExecFrame,
  value: unknown
): TaskNavigationInfo | undefined | null => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    (value.kind !== 'document' && value.kind !== 'same_document') ||
    value.fromDocumentId !== frame.request.scope.documentId ||
    typeof value.fromUrl !== 'string' ||
    typeof value.realmLost !== 'boolean' ||
    (value.toDocumentId !== undefined && typeof value.toDocumentId !== 'string') ||
    (value.toUrl !== undefined && typeof value.toUrl !== 'string')
  ) {
    return null;
  }
  const { redactUrl } = frame.redactor;
  return {
    kind: value.kind,
    fromDocumentId: value.fromDocumentId,
    ...(typeof value.toDocumentId === 'string' ? { toDocumentId: value.toDocumentId } : {}),
    fromUrl: redactUrl(value.fromUrl),
    ...(typeof value.toUrl === 'string' ? { toUrl: redactUrl(value.toUrl) } : {}),
    realmLost: value.realmLost,
  };
};

const INVALID = Symbol('invalid readback field');

/** Returns the field as it is allowed to leave this host, or INVALID. */
type FieldRule = (value: unknown) => unknown;

type FieldRules = readonly (readonly [string, FieldRule])[];

type ReadbackShape = { readonly required: FieldRules; readonly optional: FieldRules };

const flag: FieldRule = value => (typeof value === 'boolean' ? value : INVALID);

const nullableFlag: FieldRule = value =>
  value === null || typeof value === 'boolean' ? value : INVALID;

const count: FieldRule = value =>
  typeof value === 'number' && Number.isFinite(value) ? value : INVALID;

const checkedState: FieldRule = value =>
  typeof value === 'boolean' || value === 'mixed' ? value : INVALID;

const oneOf =
  (...allowed: readonly string[]): FieldRule =>
  value =>
    typeof value === 'string' && allowed.includes(value) ? value : INVALID;

const control = oneOf('native', 'aria');

const submitInfo: FieldRule = value =>
  isRecord(value) &&
  typeof value.event === 'boolean' &&
  typeof value.invalidControls === 'number' &&
  Number.isFinite(value.invalidControls) &&
  typeof value.defaultPrevented === 'boolean'
    ? {
        event: value.event,
        invalidControls: value.invalidControls,
        defaultPrevented: value.defaultPrevented,
      }
    : INVALID;

/** Only the fields of the contract's ActionOutcome: a page cannot carry text in a readback. */
const readbackShape = (
  kind: string,
  label: FieldRule,
  withLength: boolean
): ReadbackShape | undefined => {
  switch (kind) {
    case 'click':
      return { required: [['defaultPrevented', flag]], optional: [['submit', submitInfo]] };
    case 'fill':
      return {
        required: [
          ['tag', label],
          ['inputType', label],
          ['changed', flag],
          ['matched', flag],
        ],
        optional: withLength
          ? [
              ['length', count],
              ['empty', flag],
            ]
          : [['empty', flag]],
      };
    case 'select':
      return {
        required: [
          ['control', control],
          ['index', count],
          ['changed', flag],
          ['matched', nullableFlag],
        ],
        optional: [],
      };
    case 'setChecked':
      return {
        required: [
          ['control', control],
          ['before', checkedState],
          ['after', checkedState],
          ['changed', flag],
          ['matched', flag],
        ],
        optional: [],
      };
    case 'scroll':
      return {
        required: [
          ['moved', flag],
          ['before', count],
          ['after', count],
          ['max', count],
          ['atTop', flag],
          ['atBottom', flag],
        ],
        optional: [['reason', oneOf('edge', 'blocked')]],
      };
    case 'press':
      return {
        required: [
          ['defaultPrevented', flag],
          ['defaultAction', oneOf('implicit_submit', 'activate', 'none')],
        ],
        optional: [['submit', submitInfo]],
      };
    case 'wait':
      return { required: [['waitedMs', count]], optional: [] };
    default:
      return undefined;
  }
};

const pickFields = (
  source: Readonly<Record<string, unknown>>,
  rules: FieldRules,
  required: boolean
): readonly (readonly [string, unknown])[] | null => {
  const picked: (readonly [string, unknown])[] = [];
  for (const [key, rule] of rules) {
    const raw = source[key];
    if (raw === undefined && !required) {
      continue;
    }
    const checked = rule(raw);
    if (checked === INVALID) {
      return null;
    }
    picked.push([key, checked]);
  }
  return picked;
};

/** A sensitive FILL reports `empty` only: a length is an oracle for the typed value (R15). Only an explicit false is plain. */
const isSensitiveFill = (request: TaskCommandRequest): boolean =>
  isRecord(request.command) &&
  request.command.operation === 'FILL' &&
  request.command.sensitive !== false;

const readReadback = (frame: ExecFrame, value: unknown): TaskReadback | undefined => {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return undefined;
  }
  if (value.kind === 'read') {
    return typeof value.text === 'string'
      ? { kind: 'read', text: frame.redactor.scrub(value.text) }
      : undefined;
  }
  const label: FieldRule = field =>
    typeof field === 'string'
      ? field.length > MAX_LABEL_CHARS
        ? INVALID
        : frame.redactor.scrub(field)
      : INVALID;
  const shape = readbackShape(value.kind, label, !isSensitiveFill(frame.request));
  if (shape === undefined) {
    return undefined;
  }
  const required = pickFields(value, shape.required, true);
  const optional = pickFields(value, shape.optional, false);
  return required === null || optional === null
    ? undefined
    : (Object.fromEntries([['kind', value.kind], ...required, ...optional]) as TaskReadback);
};

const readOutcome = (frame: ExecFrame, value: unknown): TaskExecutionOutcome | null => {
  if (!isRecord(value)) {
    return null;
  }
  const { status, effect } = value;
  if (!isStatus(status) || !isEffect(effect) || !EFFECTS_BY_STATUS[status].includes(effect)) {
    return null;
  }
  const navigation = readNavigation(frame, value.navigation);
  if (navigation === null) {
    return null;
  }
  const readback = readReadback(frame, value.readback);
  const code = value.code;
  const message = value.message;
  const staleReason = value.staleReason;
  return {
    requestId: frame.requestId,
    status,
    effect,
    ...(isOutcomeCode(code) ? { code } : {}),
    ...(typeof message === 'string' ? messageField(capText(frame.redactor.scrub(message))) : {}),
    ...(typeof staleReason === 'string' &&
    (STALE_REASONS as readonly string[]).includes(staleReason)
      ? { staleReason: staleReason as TaskStaleReason }
      : {}),
    ...(readback === undefined ? {} : { readback }),
    ...(navigation === undefined ? {} : { navigation }),
    durationMs: Math.max(0, finiteOr(value.durationMs, elapsed(frame))),
  } as TaskExecutionOutcome;
};

const mapLost = async (frame: ExecFrame, lost: LostCall): Promise<TaskExecutionOutcome> => {
  const { ctx, signal } = frame;
  const previous = frame.request.scope.documentId;
  const detail = (text: string): string =>
    lost.message === '' ? text : `${text}: ${lost.message}`;
  if (lost.reason === 'navigated' || lost.reason === 'timeout') {
    const waitMs = lost.reason === 'navigated' ? ctx.navigationTimeoutMs : PROBE_TIMEOUT_MS;
    // Read before waiting: adopting the next document may push the old one out of the bounded map.
    const fromUrl = ctx.state.urls.get(previous) ?? '';
    const next = await awaitNextDocument(ctx, previous, waitMs, signal);
    if (next.kind === 'found') {
      return navigatedOutcome(frame, next.hello, fromUrl);
    }
    if (lost.reason === 'timeout') {
      return uncertainOutcome(
        frame,
        'EXECUTION_TIMEOUT',
        detail('The command did not answer in time')
      );
    }
    // An abort only stops the wait; the next observe is not told the document is gone.
    ctx.state.documentLost = next.kind === 'none';
    return uncertainOutcome(
      frame,
      'DOCUMENT_LOST',
      detail('The document was replaced and no new document became ready')
    );
  }
  return uncertainOutcome(frame, 'DOCUMENT_LOST', detail('The page connection was lost'));
};

const finishSent = async (frame: ExecFrame, sent: Sent): Promise<TaskExecutionOutcome> => {
  if (sent.kind === 'invalid') {
    return uncertainOutcome(frame, 'PROTOCOL_ERROR', MSG_PROTOCOL);
  }
  if (sent.kind === 'lost') {
    // Whatever the old document answered last no longer describes the page.
    frame.ctx.state.hello = undefined;
    return mapLost(frame, sent);
  }
  noteDocument(frame.ctx.state, sent.reply.documentId);
  if (!sent.reply.ok) {
    return outcomeFromError(frame, sent.reply.error);
  }
  return (
    readOutcome(frame, sent.reply.value) ?? uncertainOutcome(frame, 'PROTOCOL_ERROR', MSG_OUTCOME)
  );
};

// ---------------------------------------------------------------------------------------------
// execute: gates, abort protocol
// ---------------------------------------------------------------------------------------------

/**
 * No execute leaves the host unless the controller's own location is on the run's allow list. Fails
 * closed: an unreadable location blocks the send too (a FILL value must never reach an unconfirmed page).
 */
const checkOrigin = async (frame: ExecFrame): Promise<TaskExecutionOutcome | null> => {
  const { ctx, request, signal } = frame;
  if (ctx.transport.location === undefined) {
    return null;
  }
  const located = await controllerLocation(ctx, signal);
  if (isAborted(signal)) {
    return failedNone(frame, 'EXECUTION_CANCELLED', MSG_NOT_SENT_CANCELLED);
  }
  if (!located.ok) {
    return failedNone(frame, 'HOST_UNAVAILABLE', MSG_LOCATION);
  }
  const allowed =
    Array.isArray(request.allowedOrigins) && request.allowedOrigins.includes(located.value.origin);
  return allowed ? null : rejectedScope(frame);
};

const sendCancel = (ctx: HostContext, targetCallId: string): void => {
  try {
    const envelope = buildEnvelope(ctx, 'cancel', { targetCallId });
    const timeoutMs = Math.max(1, Math.min(ctx.callTimeoutMs, ctx.cancelGraceMs));
    void transmit(ctx, envelope, callOptions(timeoutMs), ctx.redactor).catch(() => undefined);
  } catch {
    // cancel is best effort: the grace period still bounds the wait
  }
};

type AbortWatch = { readonly aborted: Promise<void>; readonly stop: () => void };

const watchAbort = (signal: AbortSignal): AbortWatch => {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<void>(resolve => {
    onAbort = resolve;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { aborted, stop: () => signal.removeEventListener('abort', onAbort) };
};

/**
 * Waits for the in-flight execute. A caller abort cannot be serialized, so the host sends `cancel`
 * naming the envelope's callId and keeps waiting for the real outcome up to `cancelGraceMs`. A
 * transport that is not concurrent would queue the cancel behind its execute: it waits for the outcome.
 */
const awaitExecute = async (
  frame: ExecFrame,
  pending: Promise<Sent>,
  callId: string,
  internal: AbortController
): Promise<ExecuteSettled> => {
  const { ctx, signal } = frame;
  if (
    signal === undefined ||
    ctx.transport.concurrent === false ||
    ctx.state.hello?.capabilities.cancellation === 'none'
  ) {
    return { kind: 'sent', sent: await pending };
  }
  const watch = watchAbort(signal);
  const first = await Promise.race([
    pending.then(sent => ({ tag: 'sent' as const, sent })),
    watch.aborted.then(() => ({ tag: 'aborted' as const })),
  ]);
  watch.stop();
  if (first.tag === 'sent') {
    return { kind: 'sent', sent: first.sent };
  }
  sendCancel(ctx, callId);
  const graceTimer = new AbortController();
  const second = await Promise.race([
    pending.then(sent => ({ tag: 'sent' as const, sent })),
    sleepSafe(ctx, ctx.cancelGraceMs, graceTimer.signal).then(() => ({ tag: 'grace' as const })),
  ]);
  graceTimer.abort();
  if (second.tag === 'sent') {
    return { kind: 'sent', sent: second.sent };
  }
  internal.abort();
  return { kind: 'grace_expired' };
};

const requestIdOf = (request: unknown): string =>
  isRecord(request) && typeof request.requestId === 'string' ? request.requestId : '';

/** For the last-resort path: reading a hostile request must not make the outcome itself reject. */
const requestIdOrEmpty = (request: unknown): string => {
  try {
    return requestIdOf(request);
  } catch {
    return '';
  }
};

const fillValueOf = (request: unknown): string | undefined => {
  if (!isRecord(request) || !isRecord(request.command)) {
    return undefined;
  }
  const { operation, value } = request.command;
  return operation === 'FILL' && typeof value === 'string' ? value : undefined;
};

const executeTimeoutMs = (request: TaskCommandRequest): number =>
  nonNegativeOr(request.timeoutMs, TASK_DEFAULT_TIMEOUTS.executionMs) +
  nonNegativeOr(request.settle?.maxMs, TASK_DEFAULT_SETTLE.maxMs) +
  EXECUTE_TIMEOUT_MARGIN_MS;

const runExecute = async (
  ctx: HostContext,
  request: TaskCommandRequest,
  signal: AbortSignal | undefined,
  progress: { sent: boolean }
): Promise<TaskExecutionOutcome> => {
  const fill = fillValueOf(request);
  const frame: ExecFrame = {
    ctx,
    request,
    signal,
    requestId: requestIdOf(request),
    started: ctx.clock(),
    redactor: fill === undefined ? ctx.redactor : ctx.redactor.withSecrets([fill]),
  };
  if (ctx.state.disposed) {
    return failedNone(frame, 'HOST_DISPOSED', MSG_DISPOSED);
  }
  if (ctx.transport === NO_TRANSPORT) {
    return failedNone(frame, 'HOST_UNAVAILABLE', MSG_NO_TRANSPORT);
  }
  if (isAborted(signal)) {
    return failedNone(frame, 'EXECUTION_CANCELLED', MSG_NOT_SENT_CANCELLED);
  }
  const documentId = request.scope.documentId;
  if (!isNonEmptyString(documentId)) {
    return rejectedInvalid(frame);
  }
  const blocked = await checkOrigin(frame);
  if (blocked !== null) {
    return blocked;
  }
  // The await above is a window in which the caller may abort: nothing is sent after that.
  if (isAborted(signal)) {
    return failedNone(frame, 'EXECUTION_CANCELLED', MSG_NOT_SENT_CANCELLED);
  }
  const envelope = buildEnvelope(ctx, 'execute', request, documentId);
  const internal = new AbortController();
  const call = callOptions(executeTimeoutMs(request), internal.signal);
  progress.sent = true;
  const pending = transmit(ctx, envelope, call, frame.redactor);
  const settled = await awaitExecute(frame, pending, envelope.callId, internal);
  return settled.kind === 'sent'
    ? finishSent(frame, settled.sent)
    : uncertainOutcome(frame, 'EXECUTION_CANCELLED', MSG_GRACE);
};

/** Never rejects. A failure before the send is `failed/none`; after it nothing is known: `uncertain`. */
const executeLive = async (
  ctx: HostContext,
  request: TaskCommandRequest,
  signal: AbortSignal | undefined
): Promise<TaskExecutionOutcome> => {
  const progress = { sent: false };
  try {
    return await runExecute(ctx, request, signal, progress);
  } catch {
    const outcome = {
      requestId: requestIdOrEmpty(request),
      code: 'INTERNAL' as const,
      message: 'The remote host failed unexpectedly.',
      durationMs: 0,
    };
    return progress.sent
      ? { ...outcome, status: 'uncertain', effect: 'uncertain' }
      : { ...outcome, status: 'failed', effect: 'none' };
  }
};

// ---------------------------------------------------------------------------------------------
// release, dispose
// ---------------------------------------------------------------------------------------------

const sendBestEffort = async <M extends 'release' | 'dispose'>(
  ctx: HostContext,
  method: M,
  payload: TaskBridgePayloads[M],
  signal?: AbortSignal
): Promise<void> => {
  try {
    const envelope = buildEnvelope(ctx, method, payload);
    await transmit(ctx, envelope, callOptions(ctx.callTimeoutMs, signal), ctx.redactor);
  } catch {
    // a failed release or dispose changes nothing for the caller
  }
};

const releaseSession = async (
  ctx: HostContext,
  sessionId: string,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (ctx.state.disposed) {
    return;
  }
  ctx.state.sessions.delete(sessionId);
  ctx.state.observations.delete(sessionId);
  // A cancelled run still frees its snapshots: an already aborted signal would drop the call.
  await sendBestEffort(ctx, 'release', { sessionId }, isAborted(signal) ? undefined : signal);
};

const disposeHost = async (ctx: HostContext): Promise<void> => {
  if (ctx.state.disposed) {
    return;
  }
  ctx.state.disposed = true;
  for (const sessionId of [...ctx.state.sessions]) {
    await sendBestEffort(ctx, 'release', { sessionId });
  }
  ctx.state.sessions.clear();
  ctx.state.observations.clear();
  await sendBestEffort(ctx, 'dispose', {});
};

// ---------------------------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------------------------

/**
 * TaskHost over a serializable transport (contract 12.3). It trusts nothing the page says about its origin:
 * with an authoritative transport location the page's hello and observation origins are checked against it,
 * and no execute is sent unless that location is on the run's allow list. Never logs or stores payloads.
 */
export const createRemoteTaskHost: TaskCreateRemoteHostFn = config => {
  const ctx = createContext(config);
  const host: TaskHost = {
    capabilities: signal => guardResult(() => readCapabilities(ctx, signal)),
    observe: (request, signal) => guardResult(() => observeLive(ctx, request, signal)),
    execute: (request, signal) => executeLive(ctx, request, signal),
    release: (sessionId, signal) => releaseSession(ctx, sessionId, signal).catch(() => undefined),
    dispose: () => disposeHost(ctx).catch(() => undefined),
  };
  return ctx.transport.location === undefined
    ? host
    : { ...host, location: signal => guardResult(() => locationLive(ctx, signal)) };
};
