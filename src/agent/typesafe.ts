import {
  TASK_ANSWER_CHOICES,
  TASK_COMPLETION_VERDICTS,
  TASK_CALLER_CONTEXT_ONLY,
  TASK_DEFAULT_CONFIDENCE,
  TASK_NONE_APPROPRIATE,
  TASK_REQUIRED_UNAVAILABLE,
  TASK_KEEP_CURRENT,
  TASK_QUESTION_KEYS,
  TASK_OPERATIONS,
  TASK_LIMITS,
  TASK_TYPESAFE_DEFAULTS,
  TASK_TYPESAFE_LIMITS,
  TASK_TYPESAFE_MODEL_PREFIX,
  TASK_UNTRUSTED_DATA_RULE,
  isTaskCommitmentClass,
  isTaskOperation,
  taskTargetQuestionKey,
} from '@/types';
import type {
  ChoiceQuestion,
  TaskActionDecision,
  TaskAnswerChoice,
  TaskArgumentDecision,
  TaskCallContext,
  TaskChooseActionRequest,
  TaskChooseArgumentRequest,
  TaskClassifyCommitmentRequest,
  TaskCommitmentClass,
  TaskCommitmentDecision,
  TaskCompletionDecision,
  TaskCompletionVerdict,
  TaskCreateTypeSafeDeciderFn,
  TaskDecider,
  TaskDeciderError,
  TaskDeciderErrorCode,
  TaskDeciderResult,
  TaskDecisionStage,
  TaskExchange,
  TaskExchangeAttempt,
  TaskExchangeUsage,
  TaskHttp,
  TaskHttpRequest,
  TaskQuestionBuildOptions,
  TaskQuestionSet,
  TaskRetryPolicy,
  TaskTargetChoice,
  TaskVerifyCompletionRequest,
  TypeSafeTaskDeciderConfig,
} from '@/types';
import { sanitizeUntrustedText } from '@/utils/sanitize';
import { createRedactor } from '@/utils/redact';
import {
  assertGoalPreserved,
  buildActionQuestions,
  buildArgumentQuestions,
  buildCommitmentQuestions,
  buildCompletionQuestions,
  estimateRequestBytes,
  estimateRequestTokens,
  questionRotations,
} from './request';

type Answer = { readonly choice: string; readonly confidence: number };
type Answers = Readonly<Record<string, Answer>>;

type Parsed<T> =
  | { readonly ok: true; readonly decision: T }
  | { readonly ok: false; readonly error: TaskDeciderError };

/** One decision call: the questions to ask and how to read the answers. */
type Plan<T> = {
  readonly stage: TaskDecisionStage;
  readonly set: TaskQuestionSet;
  readonly goal: string;
  readonly step: number;
  readonly parse: (answers: Answers) => Parsed<T>;
};

type Runtime = {
  readonly endpoint: string | undefined;
  readonly model: string;
  readonly modelPrefixes: readonly string[] | undefined;
  readonly clauseSplitValid: boolean;
  readonly http: TaskHttp;
  readonly timeoutMs: number;
  readonly retry: TaskRetryPolicy;
  readonly maxRequestBytes: number;
  readonly build: TaskQuestionBuildOptions;
  readonly confirmCommitment: boolean;
  readonly rotate: boolean;
  readonly allowBrowserKey: boolean;
  readonly credential: () => string;
  readonly scrubCredentialText: (value: string) => string;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random: () => number;
  readonly clock: () => number;
};

type Validated = {
  readonly model: string;
  readonly usage: TaskExchangeUsage | undefined;
  readonly answers: Answers;
};

type Reading =
  | { readonly kind: 'invalid'; readonly status?: number; readonly requestId?: string }
  | {
      readonly kind: 'ok';
      readonly status: number;
      readonly requestId?: string;
      readonly body: unknown;
    }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly requestId?: string;
      readonly detail: ErrorDetail;
      readonly retryAfterMs?: number;
    };

type ErrorDetail = { readonly errorType?: string; readonly questionId?: string };

type Attempt<T> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly requestId?: string;
      readonly decision: T;
      readonly validated: Validated;
    }
  | {
      readonly ok: false;
      readonly error: TaskDeciderError;
      readonly status?: number;
      readonly requestId?: string;
      readonly retryAfterMs?: number;
      readonly validated?: undefined;
    };

type Outcome<T> =
  | { readonly ok: true; readonly decision: T; readonly validated: Validated }
  | { readonly ok: false; readonly error: TaskDeciderError };

type Meta = { readonly status?: number; readonly requestId?: string };

type SendResult<T> = {
  readonly outcome: Outcome<T>;
  readonly meta: Meta;
  readonly log: readonly TaskExchangeAttempt[];
};

type Telemetry = {
  readonly attemptLog: readonly TaskExchangeAttempt[];
  readonly startedAt: number;
  readonly requestBytes: number;
  readonly goalVerified: boolean;
  readonly validated?: Validated;
  readonly error?: TaskDeciderError;
};

const PROVIDER = 'typesafe';
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
// The name of the browser realm global is built in code so this module contains no reference to it.
const REALM_PROBE = 'docu' + 'ment';
const PROBABILITY_TOLERANCE = 0.02;
const ARGMAX_TOLERANCE = 1e-6;
const MODEL_CHARS = 64;
const MODEL_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]+-$/;
const MODEL_PREFIX_MAX_LENGTH = 64;
const MODEL_PREFIX_MAX_ENTRIES = 8;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const RETRYABLE_CODES: readonly TaskDeciderErrorCode[] = [
  'TIMEOUT',
  'RATE_LIMITED',
  'HTTP_ERROR',
  'NETWORK',
];
const ERROR_TYPES: readonly string[] = [
  'max_tokens_exceeded',
  'api_usage_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'overloaded_error',
  'api_error',
  'invalid_request_error',
];

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (record: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

const stripUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const nonNegative = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const failure = (
  code: TaskDeciderErrorCode,
  message: string,
  retryable: boolean,
  status?: number
): TaskDeciderError => ({
  code,
  message,
  retryable,
  ...(status === undefined ? {} : { status }),
});

const safeRequestId = (value: string | null): string | undefined =>
  value !== null && REQUEST_ID_PATTERN.test(value) ? value : undefined;

const readHeader = (response: unknown, name: string): string | null => {
  try {
    const header = (response as { readonly header?: unknown }).header;
    if (typeof header !== 'function') {
      return null;
    }
    const value: unknown = (header as (name: string) => unknown).call(response, name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const parseDecimal = (text: string | null): number | undefined => {
  const trimmed = text?.trim();
  if (trimmed === undefined || !DECIMAL_PATTERN.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
};

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const validateEndpoint = (
  raw: string | undefined,
  allowedHosts: readonly string[] | undefined
): string | undefined => {
  const text = raw === undefined ? TASK_TYPESAFE_DEFAULTS.endpoint : raw;
  if (typeof text !== 'string') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    return undefined;
  }
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
  if (!secure && !loopback) {
    return undefined;
  }
  if (allowedHosts !== undefined) {
    const allowed = allowedHosts.map(host => String(host).toLowerCase());
    if (
      !allowed.includes(url.hostname.toLowerCase()) &&
      !allowed.includes(url.host.toLowerCase())
    ) {
      return undefined;
    }
  }
  return url.href;
};

const makeCredential =
  (apiKey: string | (() => string), remember: (value: string) => void): (() => string) =>
  () => {
    try {
      const raw: unknown = typeof apiKey === 'function' ? apiKey() : apiKey;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value !== '') {
        remember(value);
      }
      return value;
    } catch {
      return '';
    }
  };

const resolveRetry = (partial: Partial<TaskRetryPolicy> | undefined): TaskRetryPolicy => {
  const defaults = TASK_TYPESAFE_DEFAULTS.retry;
  return {
    maxRetries: Math.floor(nonNegative(partial?.maxRetries, defaults.maxRetries)),
    baseDelayMs: nonNegative(partial?.baseDelayMs, defaults.baseDelayMs),
    maxDelayMs: nonNegative(partial?.maxDelayMs, defaults.maxDelayMs),
    jitter: clamp(nonNegative(partial?.jitter, defaults.jitter), 0, 1),
    maxRetryAfterMs: nonNegative(partial?.maxRetryAfterMs, defaults.maxRetryAfterMs),
  };
};

const resolveModelPrefixes = (raw: unknown): readonly string[] | undefined => {
  if (raw === undefined) {
    return [TASK_TYPESAFE_MODEL_PREFIX];
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MODEL_PREFIX_MAX_ENTRIES) {
    return undefined;
  }
  const entries: readonly unknown[] = raw;
  const prefixes = entries.filter(
    (entry): entry is string =>
      typeof entry === 'string' &&
      entry.length <= MODEL_PREFIX_MAX_LENGTH &&
      MODEL_PREFIX_PATTERN.test(entry)
  );
  return prefixes.length === entries.length ? prefixes : undefined;
};

const defaultHttp: TaskHttp = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, Authorization: `Bearer ${init.credential()}` },
    body: init.body,
    // A redirect must never carry the key to another host.
    redirect: 'error',
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
  return {
    ok: response.ok,
    status: response.status,
    header: name => response.headers.get(name),
    json: () => response.json() as Promise<unknown>,
  };
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>(resolve => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

const createRuntime = (config: TypeSafeTaskDeciderConfig): Runtime => {
  let credentialRedactor = createRedactor();
  const credential = makeCredential(config.apiKey, value => {
    credentialRedactor = credentialRedactor.withSecrets([value]);
  });
  const maxOptions = positive(config.maxOptions);
  const evidenceQuestions = positive(config.evidenceQuestions);
  const clauseSplit = config.completionClauseSplit;
  const maxRequestBytes = Math.min(
    positive(config.maxRequestBytes) ?? TASK_TYPESAFE_DEFAULTS.maxRequestBytes,
    TASK_TYPESAFE_LIMITS.requestBytesCeiling
  );
  const rotate = config.rotateOptions !== false;
  return {
    endpoint: validateEndpoint(config.endpoint, config.allowedHosts),
    model:
      typeof config.model === 'string' && config.model !== ''
        ? config.model
        : TASK_TYPESAFE_DEFAULTS.model,
    modelPrefixes: resolveModelPrefixes(config.allowedModelPrefixes),
    clauseSplitValid:
      clauseSplit === undefined || clauseSplit === 'punctuation' || clauseSplit === 'conjunction',
    http: config.http ?? defaultHttp,
    timeoutMs: positive(config.timeoutMs) ?? TASK_TYPESAFE_DEFAULTS.timeoutMs,
    retry: resolveRetry(config.retry),
    maxRequestBytes,
    build: {
      maxRequestBytes,
      rotate,
      clauseSplit: clauseSplit === 'conjunction' ? 'conjunction' : 'punctuation',
      ...(maxOptions === undefined
        ? {}
        : { maxOptions: Math.min(Math.floor(maxOptions), TASK_TYPESAFE_LIMITS.apiMaxOptions) }),
      ...(evidenceQuestions === undefined
        ? {}
        : { evidenceQuestions: Math.floor(evidenceQuestions) }),
    },
    confirmCommitment: config.confirmCommitment !== false,
    rotate,
    allowBrowserKey: config.allowBrowserKey === true,
    credential,
    scrubCredentialText: value => credentialRedactor.scrub(value),
    sleep: config.sleep ?? defaultSleep,
    random: config.random ?? Math.random,
    clock: config.clock ?? Date.now,
  };
};

// ---------------------------------------------------------------------------------------------
// Response reading and validation (no raw body or thrown value ever leaves this module)
// ---------------------------------------------------------------------------------------------

const askedQuestion = (detail: string, asked: readonly string[]): string | undefined => {
  const tokens = detail.split(/[^A-Za-z0-9_]+/).reverse();
  return tokens.find(token => asked.includes(token));
};

const readDetail = (body: unknown, asked: readonly string[]): ErrorDetail => {
  if (!isRecord(body)) {
    return {};
  }
  const detail = own(body, 'detail');
  if (typeof detail === 'string') {
    const questionId = askedQuestion(detail, asked);
    return questionId === undefined ? {} : { questionId };
  }
  if (isRecord(detail)) {
    const errorType = own(detail, 'error_type');
    return typeof errorType === 'string' && ERROR_TYPES.includes(errorType) ? { errorType } : {};
  }
  return {};
};

const readRetryAfter = (response: unknown, policy: TaskRetryPolicy): number | undefined => {
  const milliseconds = parseDecimal(readHeader(response, 'retry-after-ms'));
  if (milliseconds !== undefined) {
    return Math.min(milliseconds, policy.maxRetryAfterMs);
  }
  const seconds = parseDecimal(readHeader(response, 'retry-after'));
  return seconds === undefined ? undefined : Math.min(seconds * 1000, policy.maxRetryAfterMs);
};

const readJson = async (
  response: unknown
): Promise<{ readonly ok: boolean; readonly body: unknown }> => {
  try {
    const json = (response as { readonly json?: unknown }).json;
    if (typeof json !== 'function') {
      return { ok: false, body: undefined };
    }
    return { ok: true, body: await (json as () => Promise<unknown>).call(response) };
  } catch {
    return { ok: false, body: undefined };
  }
};

const readResponse = async (
  response: unknown,
  runtime: Runtime,
  asked: readonly string[]
): Promise<Reading> => {
  if (!isRecord(response)) {
    return { kind: 'invalid' };
  }
  const status = response['status'];
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return { kind: 'invalid' };
  }
  const proposedId = safeRequestId(readHeader(response, 'x-typesafe-request-id'));
  const requestId =
    proposedId !== undefined && runtime.scrubCredentialText(proposedId) === proposedId
      ? proposedId
      : undefined;
  const base = requestId === undefined ? {} : { requestId };
  if (status >= 200 && status < 300) {
    if (response['ok'] === false) {
      return { kind: 'invalid', status, ...base };
    }
    const json = await readJson(response);
    return json.ok
      ? { kind: 'ok', status, body: json.body, ...base }
      : { kind: 'invalid', status, ...base };
  }
  const detail =
    status === 400 || status === 422
      ? readDetail((await readJson(response)).body, asked)
      : ({} as ErrorDetail);
  const retryAfterMs = readRetryAfter(response, runtime.retry);
  return {
    kind: 'rejected',
    status,
    detail,
    ...base,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
};

const withRequestId = (message: string, requestId: string | undefined): string =>
  requestId === undefined ? message : `${message} [request ${requestId}]`;

const errorFromStatus = (
  status: number,
  detail: ErrorDetail,
  requestId: string | undefined
): TaskDeciderError => {
  const at = (message: string): string => withRequestId(message, requestId);
  if (status === 401 || status === 403) {
    return failure(
      'UNAUTHORIZED',
      at(`TypeSafe refused the credentials (HTTP ${String(status)})`),
      false,
      status
    );
  }
  if (status === 408) {
    return failure('TIMEOUT', at('TypeSafe reported a timeout (HTTP 408)'), true, status);
  }
  if (status === 429) {
    return failure('RATE_LIMITED', at('TypeSafe rate limit reached (HTTP 429)'), true, status);
  }
  if (status >= 500 && status < 600) {
    return failure(
      'HTTP_ERROR',
      at(`TypeSafe server error (HTTP ${String(status)})`),
      true,
      status
    );
  }
  if (status === 400 && detail.errorType === 'max_tokens_exceeded') {
    return failure(
      'REQUEST_TOO_LARGE',
      at('TypeSafe rejected the request as too large (HTTP 400, max_tokens_exceeded)'),
      false,
      status
    );
  }
  if (status >= 400 && status < 500) {
    const parts = [
      `HTTP ${String(status)}`,
      ...(detail.errorType === undefined ? [] : [detail.errorType]),
      ...(detail.questionId === undefined ? [] : [`question ${detail.questionId}`]),
    ];
    return failure(
      'INVALID_REQUEST',
      at(`TypeSafe rejected the request (${parts.join(', ')})`),
      false,
      status
    );
  }
  return failure(
    'HTTP_ERROR',
    at(`TypeSafe returned an unexpected status (HTTP ${String(status)})`),
    false,
    status
  );
};

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const invalidAnswer = (key: string, what: string): TaskDeciderError =>
  failure('INVALID_RESPONSE', `TypeSafe answer for question ${key} ${what}`, false);

/** Key-set equality, range, sum within 0.02 of 1 and argmax, as the guide adapter did. */
const checkProbabilities = (
  key: string,
  choice: string,
  probabilities: unknown,
  criteria: readonly string[]
): TaskDeciderError | undefined => {
  if (!isRecord(probabilities)) {
    return invalidAnswer(key, 'has no probabilities');
  }
  const received = Object.keys(probabilities);
  if (received.length !== criteria.length || criteria.some(name => !received.includes(name))) {
    return invalidAnswer(key, 'has probabilities that do not match the offered choices');
  }
  let total = 0;
  let highest = 0;
  for (const name of criteria) {
    const probability = own(probabilities, name);
    if (!isProbability(probability)) {
      return invalidAnswer(key, 'has a probability outside 0 to 1');
    }
    total += probability;
    highest = Math.max(highest, probability);
  }
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) {
    return invalidAnswer(key, 'has probabilities that do not sum to 1');
  }
  const chosen = own(probabilities, choice);
  if (typeof chosen !== 'number' || chosen < highest - ARGMAX_TOLERANCE) {
    return invalidAnswer(key, 'chose an option that is not the most probable');
  }
  return undefined;
};

const checkAnswer = (
  key: string,
  value: unknown,
  criteria: readonly string[]
): Answer | TaskDeciderError => {
  if (!isRecord(value)) {
    return failure(
      'INVALID_RESPONSE',
      `TypeSafe response is missing the answer for question ${key}`,
      false
    );
  }
  const choice = own(value, 'choice');
  if (typeof choice !== 'string') {
    return invalidAnswer(key, 'has no choice');
  }
  if (!criteria.includes(choice)) {
    return failure(
      'CHOICE_NOT_OFFERED',
      `TypeSafe chose an option that was not offered for question ${key}`,
      false
    );
  }
  const confidence = own(value, 'confidence');
  if (!isProbability(confidence)) {
    return invalidAnswer(key, 'has a confidence outside 0 to 1');
  }
  const problem = checkProbabilities(key, choice, own(value, 'probabilities'), criteria);
  return problem ?? { choice, confidence };
};

const readUsage = (value: unknown): TaskExchangeUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = own(value, 'input_tokens');
  const output = own(value, 'output_tokens');
  const valid = (count: unknown): count is number =>
    typeof count === 'number' && Number.isFinite(count) && count >= 0;
  return valid(input) && valid(output) ? { inputTokens: input, outputTokens: output } : undefined;
};

const validateBody = (
  body: unknown,
  asked: Readonly<Record<string, ChoiceQuestion>>,
  modelPrefixes: readonly string[]
): Validated | TaskDeciderError => {
  if (!isRecord(body)) {
    return failure('INVALID_RESPONSE', 'TypeSafe response was not a JSON object', false);
  }
  const model = own(body, 'model');
  if (typeof model !== 'string' || !modelPrefixes.some(prefix => model.startsWith(prefix))) {
    return failure(
      'INVALID_RESPONSE',
      'TypeSafe response did not come from an allowed model',
      false
    );
  }
  const answers = own(body, 'answers');
  if (!isRecord(answers)) {
    return failure('INVALID_RESPONSE', 'TypeSafe response has no answers', false);
  }
  const checked: Record<string, Answer> = {};
  for (const [key, question] of Object.entries(asked)) {
    const answer = checkAnswer(key, own(answers, key), Object.keys(question.criteria));
    if ('code' in answer) {
      return answer;
    }
    checked[key] = answer;
  }
  return {
    model: sanitizeUntrustedText(model, MODEL_CHARS),
    usage: readUsage(own(body, 'usage')),
    answers: checked,
  };
};

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

const ABORTED = Symbol('aborted');

// A function, so the flag is read afresh after every await instead of staying narrowed.
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Settles when the work settles or the signal aborts, whichever is first, so a transport that ignores the signal cannot hang a call. */
const raceAbort = <V>(signal: AbortSignal, work: () => Promise<V>): Promise<V> =>
  new Promise<V>((resolve, reject) => {
    if (signal.aborted) {
      reject(ABORTED);
      return;
    }
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });

type Guarded = {
  readonly timedOut: () => boolean;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
};

/** The caller's signal joined with the per-attempt timeout; `dispose` clears the timer and the listener. */
const guardAttempt = (runtime: Runtime, caller: AbortSignal | undefined): Guarded => {
  const controller = new AbortController();
  let expired = false;
  const forward = (): void => controller.abort();
  if (caller?.aborted === true) {
    controller.abort();
  } else {
    caller?.addEventListener('abort', forward, { once: true });
  }
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, runtime.timeoutMs);
  return {
    timedOut: () => expired,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', forward);
    },
  };
};

const abortedError = (runtime: Runtime, guard: Guarded): TaskDeciderError =>
  guard.timedOut()
    ? failure('TIMEOUT', `TypeSafe call timed out after ${String(runtime.timeoutMs)} ms`, true)
    : failure('CANCELLED', 'TypeSafe call was cancelled', false);

const finishAttempt = <T>(
  reading: Reading,
  plan: Plan<T>,
  modelPrefixes: readonly string[]
): Attempt<T> => {
  const requestId = reading.requestId === undefined ? {} : { requestId: reading.requestId };
  const status = reading.status === undefined ? {} : { status: reading.status };
  if (reading.kind === 'invalid') {
    const message = withRequestId('TypeSafe response was unusable', reading.requestId);
    return {
      ok: false,
      error: failure('INVALID_RESPONSE', message, false),
      ...status,
      ...requestId,
    };
  }
  if (reading.kind === 'rejected') {
    return {
      ok: false,
      error: errorFromStatus(reading.status, reading.detail, reading.requestId),
      ...status,
      ...requestId,
      ...(reading.retryAfterMs === undefined ? {} : { retryAfterMs: reading.retryAfterMs }),
    };
  }
  const validated = validateBody(reading.body, plan.set.questions, modelPrefixes);
  if ('code' in validated) {
    const error = { ...validated, message: withRequestId(validated.message, reading.requestId) };
    return { ok: false, error, ...status, ...requestId };
  }
  const parsed = plan.parse(validated.answers);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, ...status, ...requestId };
  }
  return { ok: true, status: reading.status, ...requestId, decision: parsed.decision, validated };
};

const attemptOnce = async <T>(
  runtime: Runtime,
  plan: Plan<T>,
  body: string,
  caller: AbortSignal | undefined
): Promise<{ readonly attempt: Attempt<T>; readonly latencyMs: number }> => {
  // Read before the guard exists: a clock that throws must not strand the guard's timer.
  const started = runtime.clock();
  const guard = guardAttempt(runtime, caller);
  const endpoint = runtime.endpoint ?? '';
  const init: TaskHttpRequest = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credential: runtime.credential,
    body,
    signal: guard.signal,
    timeoutMs: runtime.timeoutMs,
  };
  const asked = Object.keys(plan.set.questions);
  let attempt: Attempt<T>;
  try {
    const reading = await raceAbort(guard.signal, async () =>
      readResponse(await runtime.http(endpoint, init), runtime, asked)
    );
    attempt = finishAttempt(reading, plan, runtime.modelPrefixes ?? []);
    if (
      attempt.ok &&
      runtime.scrubCredentialText(attempt.validated.model) !== attempt.validated.model
    ) {
      attempt = {
        ok: false,
        error: failure('INVALID_RESPONSE', 'TypeSafe returned invalid model metadata', false),
      };
    }
  } catch (thrown) {
    // The thrown value is never read: it can carry request headers.
    attempt =
      thrown === ABORTED || guard.signal.aborted
        ? { ok: false, error: abortedError(runtime, guard) }
        : {
            ok: false,
            error: failure('NETWORK', 'TypeSafe request failed before a response arrived', true),
          };
  } finally {
    guard.dispose();
  }
  return { attempt, latencyMs: Math.max(0, runtime.clock() - started) };
};

const backoffDelay = (runtime: Runtime, retryIndex: number): number => {
  const { baseDelayMs, maxDelayMs, jitter } = runtime.retry;
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** retryIndex);
  let draw = 0;
  try {
    const drawn = runtime.random();
    draw = Number.isFinite(drawn) ? clamp(drawn, 0, 1) : 0;
  } catch {
    draw = 0;
  }
  return raw - raw * jitter * draw;
};

const pause = async (
  runtime: Runtime,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> => {
  try {
    await runtime.sleep(ms, signal);
  } catch {
    // A sleep that fails only shortens the wait; the attempt budget still bounds the loop.
  }
};

const logEntry = (
  attempt: Attempt<unknown>,
  number: number,
  latencyMs: number
): TaskExchangeAttempt =>
  stripUndefined({
    attempt: number,
    status: attempt.status,
    latencyMs,
    requestId: attempt.requestId,
    errorCode: attempt.ok ? undefined : attempt.error.code,
  });

const cancelled = (): Outcome<never> => ({
  ok: false,
  error: failure('CANCELLED', 'TypeSafe call was cancelled', false),
});

/** Sends the request, retrying what the contract allows. Returns the outcome and one log entry per attempt. */
const send = async <T>(
  runtime: Runtime,
  plan: Plan<T>,
  context: TaskCallContext
): Promise<SendResult<T>> => {
  const body = JSON.stringify({
    model: runtime.model,
    state: plan.set.state,
    questions: plan.set.questions,
  });
  const maxAttempts = runtime.retry.maxRetries + 1;
  const log: TaskExchangeAttempt[] = [];
  let meta: Meta = {};
  for (let number = 1; number <= maxAttempts; number += 1) {
    if (isAborted(context.signal)) {
      return { outcome: cancelled(), meta, log };
    }
    const { attempt, latencyMs } = await attemptOnce(runtime, plan, body, context.signal);
    const entry = logEntry(attempt, number, latencyMs);
    meta = stripUndefined({ status: attempt.status, requestId: attempt.requestId });
    if (attempt.ok) {
      log.push(entry);
      return {
        outcome: { ok: true, decision: attempt.decision, validated: attempt.validated },
        meta,
        log,
      };
    }
    const retry =
      attempt.error.retryable &&
      RETRYABLE_CODES.includes(attempt.error.code) &&
      number < maxAttempts;
    if (!retry) {
      log.push(entry);
      return { outcome: { ok: false, error: attempt.error }, meta, log };
    }
    const delayMs = attempt.retryAfterMs ?? backoffDelay(runtime, number - 1);
    log.push({ ...entry, delayMs });
    await pause(runtime, delayMs, context.signal);
    if (isAborted(context.signal)) {
      return { outcome: cancelled(), meta, log };
    }
  }
  return { outcome: cancelled(), meta, log };
};

// ---------------------------------------------------------------------------------------------
// One decision call
// ---------------------------------------------------------------------------------------------

const exchangeFor = (
  runtime: Runtime,
  plan: Plan<unknown>,
  telemetry: Telemetry,
  last: Meta
): TaskExchange => {
  const { validated } = telemetry;
  const requestBytes = telemetry.requestBytes;
  return stripUndefined({
    stage: plan.stage,
    provider: PROVIDER,
    requestedModel: runtime.model,
    model: validated?.model,
    requestId: last.requestId,
    attempts: telemetry.attemptLog.length,
    attemptLog: telemetry.attemptLog,
    httpStatus: last.status,
    latencyMs: Math.max(0, runtime.clock() - telemetry.startedAt),
    usage: validated?.usage,
    requestBytes,
    estimatedInputTokens: estimateRequestTokens(requestBytes),
    rotations: questionRotations(plan.set, plan.step, runtime.rotate),
    goalVerified: telemetry.goalVerified,
    answers:
      validated === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(validated.answers).map(([key, answer]) => [
              key,
              { choice: answer.choice, confidence: answer.confidence },
            ])
          ),
    error: telemetry.error?.message,
  });
};

/** The reasons a request is never sent, in the order they are checked. */
const refusal = (
  runtime: Runtime,
  plan: Plan<unknown>,
  goalMatches: boolean,
  requestBytes: number
): TaskDeciderError | undefined => {
  if (!goalMatches || !assertGoalPreserved(plan.set, plan.goal).ok) {
    return failure('GOAL_MISMATCH', 'The request goal differs from the goal of the run', false);
  }
  if (Reflect.has(globalThis, REALM_PROBE) && !runtime.allowBrowserKey) {
    return failure(
      'INVALID_REQUEST',
      'TypeSafe refuses to run where a page realm could read the key',
      false
    );
  }
  if (runtime.endpoint === undefined) {
    return failure('INVALID_REQUEST', 'TypeSafe endpoint is not allowed', false);
  }
  if (runtime.modelPrefixes === undefined) {
    return failure('INVALID_REQUEST', 'TypeSafe allowed model prefixes are not valid', false);
  }
  if (!runtime.clauseSplitValid) {
    return failure('INVALID_REQUEST', 'TypeSafe completion clause split is not valid', false);
  }
  if (runtime.credential() === '') {
    return failure('INVALID_REQUEST', 'TypeSafe API key is empty', false);
  }
  if (
    runtime.scrubCredentialText(JSON.stringify({ model: runtime.model, ...plan.set })) !==
    JSON.stringify({ model: runtime.model, ...plan.set })
  ) {
    return failure(
      'INVALID_REQUEST',
      'TypeSafe refuses a request containing its credential',
      false
    );
  }
  const questions = Object.entries(plan.set.questions);
  if (questions.length === 0) {
    return failure('INVALID_REQUEST', 'TypeSafe has no question to ask', false);
  }
  const thin = questions.find(([, question]) => Object.keys(question.criteria).length < 2);
  if (thin !== undefined) {
    return failure(
      'INVALID_REQUEST',
      `TypeSafe question ${thin[0]} has fewer than two options`,
      false
    );
  }
  if (
    questions.some(
      ([, question]) =>
        Object.keys(question.criteria).length >
        Math.max(
          TASK_OPERATIONS.length,
          runtime.build.maxOptions ?? TASK_TYPESAFE_DEFAULTS.maxOptions
        )
    )
  ) {
    return failure(
      'REQUEST_TOO_LARGE',
      'TypeSafe choice exceeds the configured option limit',
      false
    );
  }
  if (requestBytes > runtime.maxRequestBytes) {
    return failure(
      'REQUEST_TOO_LARGE',
      'TypeSafe request is larger than the configured limit',
      false
    );
  }
  return undefined;
};

const execute = async <T>(
  runtime: Runtime,
  plan: Plan<T>,
  context: TaskCallContext
): Promise<TaskDeciderResult<T>> => {
  const startedAt = runtime.clock();
  if (typeof context !== 'object' || context === null || typeof plan.goal !== 'string') {
    return {
      ok: false,
      error: failure('INVALID_REQUEST', 'TypeSafe call has no usable context', false),
    };
  }
  const goalMatches = context.goal === plan.goal;
  const requestBytes = estimateRequestBytes(plan.set, runtime.model);
  const base = {
    startedAt,
    requestBytes,
    goalVerified: goalMatches && assertGoalPreserved(plan.set, plan.goal).ok,
  };
  const refused = refusal(runtime, plan, goalMatches, requestBytes);
  if (refused !== undefined) {
    const telemetry: Telemetry = { ...base, attemptLog: [], error: refused };
    return { ok: false, error: refused, exchange: exchangeFor(runtime, plan, telemetry, {}) };
  }
  const { outcome, meta, log } = await send(runtime, plan, context);
  if (outcome.ok) {
    const telemetry: Telemetry = { ...base, attemptLog: log, validated: outcome.validated };
    return {
      ok: true,
      decision: outcome.decision,
      exchange: exchangeFor(runtime, plan, telemetry, meta),
    };
  }
  const telemetry: Telemetry = { ...base, attemptLog: log, error: outcome.error };
  return { ok: false, error: outcome.error, exchange: exchangeFor(runtime, plan, telemetry, meta) };
};

// ---------------------------------------------------------------------------------------------
// Reading the answers of each stage
// ---------------------------------------------------------------------------------------------

const answerOf = (answers: Answers, key: string): Answer | undefined =>
  Object.prototype.hasOwnProperty.call(answers, key) ? answers[key] : undefined;

const invalidDecision = (what: string): Parsed<never> => ({
  ok: false,
  error: failure('INVALID_RESPONSE', `TypeSafe answers did not form a decision: ${what}`, false),
});

const parseAction = (answers: Answers): Parsed<TaskActionDecision> => {
  const operationAnswer = answerOf(answers, TASK_QUESTION_KEYS.operation);
  if (operationAnswer === undefined || !isTaskOperation(operationAnswer.choice)) {
    return invalidDecision('no operation');
  }
  const operation = operationAnswer.choice;
  const operationConfidence = operationAnswer.confidence;
  if (operation === 'DONE' || operation === 'BLOCKED' || operation === 'WAIT') {
    const target: TaskTargetChoice = { kind: 'not_applicable' };
    return {
      ok: true,
      decision: { operation, target, confidence: operationConfidence, operationConfidence },
    };
  }
  const targetAnswer = answerOf(answers, taskTargetQuestionKey(operation));
  if (targetAnswer === undefined) {
    return invalidDecision('no target question for the chosen operation');
  }
  const target: TaskTargetChoice =
    targetAnswer.choice === TASK_NONE_APPROPRIATE
      ? { kind: 'none_appropriate' }
      : { kind: 'target', id: targetAnswer.choice };
  return {
    ok: true,
    decision: {
      operation,
      target,
      confidence: Math.min(operationConfidence, targetAnswer.confidence),
      operationConfidence,
      targetConfidence: targetAnswer.confidence,
    },
  };
};

const parseArgument =
  (purpose: TaskChooseArgumentRequest['purpose']) =>
  (answers: Answers): Parsed<TaskArgumentDecision> => {
    const answer = answerOf(answers, TASK_QUESTION_KEYS.argument);
    if (answer === undefined) {
      return invalidDecision('no argument');
    }
    const applicability = answerOf(answers, TASK_QUESTION_KEYS.argumentApplicability);
    if (applicability?.choice === 'UNRELATED') {
      return {
        ok: true,
        decision: { kind: 'none_appropriate', confidence: applicability.confidence },
      };
    }
    if (applicability?.choice === 'UNCERTAIN') {
      return {
        ok: true,
        decision: { kind: 'uncertain_requirement', confidence: applicability.confidence },
      };
    }
    if (applicability !== undefined && applicability.choice !== 'REQUIRED') {
      return invalidDecision('no usable requirement applicability');
    }
    const confidence =
      applicability === undefined
        ? answer.confidence
        : Math.min(applicability.confidence, answer.confidence);
    return {
      ok: true,
      decision:
        answer.choice === TASK_NONE_APPROPRIATE
          ? {
              kind:
                applicability && (purpose === 'requirement' || purpose === 'validation')
                  ? 'required_unavailable'
                  : 'none_appropriate',
              confidence,
            }
          : answer.choice === TASK_REQUIRED_UNAVAILABLE
            ? { kind: 'required_unavailable', confidence }
            : answer.choice === TASK_KEEP_CURRENT
              ? { kind: 'keep_current', confidence }
              : { kind: 'candidate', candidateId: answer.choice, confidence },
    };
  };

const mergeCommitment = (
  forward: TaskCommitmentClass,
  reverse: TaskCommitmentClass,
  confidence: number
): TaskCommitmentDecision => {
  if (forward === reverse) {
    return { commitment: forward, confidence, agreement: 'agreed' };
  }
  if (forward === 'NONE' || reverse === 'NONE') {
    return {
      commitment: forward === 'NONE' ? reverse : forward,
      confidence,
      agreement: 'disagreed',
    };
  }
  return {
    commitment: 'OTHER_COMMITMENT',
    alternatives: [forward, reverse],
    confidence,
    agreement: 'disagreed',
  };
};

/** Both orders said NONE and only a below-floor presence answer escalated: that single weak signal is asked once more and the repeat decides unless it escalates again. */
const isWeakPresenceEscalation = (
  decision: TaskCommitmentDecision,
  confidenceFloor: number
): boolean =>
  decision.commitment === 'OTHER_COMMITMENT' &&
  decision.agreement === 'disagreed' &&
  decision.alternatives === undefined &&
  decision.confidence < confidenceFloor;

const parseCommitment =
  (confirm: boolean, confidenceFloor: number) =>
  (answers: Answers): Parsed<TaskCommitmentDecision> => {
    const forward = answerOf(answers, TASK_QUESTION_KEYS.commitment);
    if (forward === undefined || !isTaskCommitmentClass(forward.choice)) {
      return invalidDecision('no commitment class');
    }
    if (!confirm) {
      return {
        ok: true,
        decision: {
          commitment: forward.choice,
          confidence: forward.confidence,
          agreement: 'single',
        },
      };
    }
    const reverse = answerOf(answers, TASK_QUESTION_KEYS.commitmentReverse);
    if (reverse === undefined || !isTaskCommitmentClass(reverse.choice)) {
      return invalidDecision('no reversed commitment class');
    }
    const presence = answerOf(answers, TASK_QUESTION_KEYS.commitmentPresence);
    if (
      forward.choice === 'NONE' &&
      reverse.choice === 'NONE' &&
      Math.min(forward.confidence, reverse.confidence) < confidenceFloor &&
      presence
    ) {
      return {
        ok: true,
        decision: {
          commitment: presence.choice === 'NO_COMMITMENT' ? 'NONE' : 'OTHER_COMMITMENT',
          confidence: presence.confidence,
          agreement: presence.choice === 'NO_COMMITMENT' ? 'agreed' : 'disagreed',
        },
      };
    }
    return {
      ok: true,
      decision: mergeCommitment(
        forward.choice,
        reverse.choice,
        Math.min(forward.confidence, reverse.confidence)
      ),
    };
  };

const isVerdict = (choice: string): choice is TaskCompletionVerdict =>
  (TASK_COMPLETION_VERDICTS as readonly string[]).includes(choice);

const isAnswerChoice = (choice: string): choice is TaskAnswerChoice =>
  (TASK_ANSWER_CHOICES as readonly string[]).includes(choice);

const parseCompletion =
  (allowCallerContext: boolean, set: TaskQuestionSet) =>
  (answers: Answers): Parsed<TaskCompletionDecision> => {
    const validVerdict = (choice: string): boolean =>
      isVerdict(choice) || (allowCallerContext && choice === TASK_CALLER_CONTEXT_ONLY);
    const verdict = answerOf(answers, TASK_QUESTION_KEYS.completion);
    if (verdict === undefined || !validVerdict(verdict.choice)) {
      return invalidDecision('no completion verdict');
    }
    const parts = Object.entries(answers)
      .filter(
        ([key]) =>
          key === TASK_QUESTION_KEYS.completion ||
          key.startsWith(TASK_QUESTION_KEYS.completionPartPrefix)
      )
      .map(([, answer]) => answer);
    if (parts.some(part => !validVerdict(part.choice))) {
      return invalidDecision('no usable completion requirement verdict');
    }
    const unresolvedControlStates: NonNullable<
      TaskCompletionDecision['unresolvedControlStates']
    >[number][] = [];
    const controls = set.state.unresolvedControls ?? [];
    const atoms = Object.entries(set.questions).filter(
      ([, question]) => question.instructions['unresolvedControlIndex'] !== undefined
    );
    if (atoms.length !== controls.length) {
      return invalidDecision('incomplete unresolved control questions');
    }
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      const atom = atoms.filter(
        ([, question]) => question.instructions['unresolvedControlIndex'] === String(index)
      );
      const answer = atom.length === 1 ? answerOf(answers, atom[0]?.[0] ?? '') : undefined;
      if (control === undefined || answer === undefined || !isVerdict(answer.choice)) {
        return invalidDecision('no actual unresolved control verdict');
      }
      unresolvedControlStates.push({
        target: { ...control.target },
        verdict: answer.choice,
        confidence: answer.confidence,
      });
    }
    const combined = parts.some(part => part.choice === 'NOT_SATISFIED')
      ? 'NOT_SATISFIED'
      : parts.some(part => part.choice === 'UNCERTAIN')
        ? 'UNCERTAIN'
        : 'SATISFIED';
    const answer = answerOf(answers, TASK_QUESTION_KEYS.answer);
    if (answer !== undefined && !isAnswerChoice(answer.choice)) {
      return invalidDecision('no usable answer');
    }
    const evidence = Object.keys(answers)
      .filter(key => key.startsWith(TASK_QUESTION_KEYS.evidencePrefix))
      .map(key => answerOf(answers, key)?.choice)
      .filter(
        (choice): choice is string => choice !== undefined && choice !== TASK_NONE_APPROPRIATE
      );
    return {
      ok: true,
      decision: {
        verdict: combined,
        confidence: Math.min(...parts.map(part => part.confidence)),
        evidenceTargetIds: [...new Set(evidence)],
        ...(controls.length > 0 ? { unresolvedControlStates } : {}),
        ...(answer === undefined || !isAnswerChoice(answer.choice)
          ? {}
          : { answer: { choice: answer.choice, confidence: answer.confidence } }),
      },
    };
  };

// ---------------------------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------------------------

const internalFailure = <T>(): TaskDeciderResult<T> => ({
  ok: false,
  error: failure('INVALID_REQUEST', 'TypeSafe adapter could not build a request', false),
});

const guarded = async <T>(
  work: () => Promise<TaskDeciderResult<T>>
): Promise<TaskDeciderResult<T>> => {
  try {
    return await work();
  } catch {
    return internalFailure<T>();
  }
};

/** Forward and reversed order of one commitment question, asked together in one request. */
const commitmentSet = (
  runtime: Runtime,
  request: TaskClassifyCommitmentRequest
): TaskQuestionSet => {
  const forward = buildCommitmentQuestions(request, 'forward', runtime.build);
  if (!runtime.confirmCommitment) {
    return forward;
  }
  const reverse = buildCommitmentQuestions(request, 'reverse', runtime.build);
  const first = forward.questions[TASK_QUESTION_KEYS.commitment];
  const second = reverse.questions[TASK_QUESTION_KEYS.commitment];
  const presenceCriteria = {
    NO_COMMITMENT:
      'Only observes, opens a view, reveals controls or prepares fields for a separate submission. No immediate lasting effect or transmission.',
    POSSIBLE_COMMITMENT:
      'Immediately sends, saves, spends, publishes, changes account state or removes data, or its effect is unclear.',
  };
  return {
    ...forward,
    questions:
      first === undefined || second === undefined
        ? {}
        : {
            [TASK_QUESTION_KEYS.commitment]: first,
            [TASK_QUESTION_KEYS.commitmentReverse]: second,
            [TASK_QUESTION_KEYS.commitmentPresence]: {
              type: 'choice',
              instructions: {
                ...first.instructions,
                rules: `${TASK_UNTRUSTED_DATA_RULE} Does this specific operation have a lasting effect or send data? A field change in a form prepares a draft unless this control saves immediately. Judge the proposed operation, not the eventual goal.`,
              },
              criteria:
                runtime.rotate && Math.floor(Math.max(0, request.step)) % 2 === 1
                  ? Object.fromEntries(Object.entries(presenceCriteria).reverse())
                  : presenceCriteria,
            },
          },
  };
};

export const createTypeSafeTaskDecider: TaskCreateTypeSafeDeciderFn = (config): TaskDecider => {
  let runtime: Runtime;
  try {
    runtime = createRuntime(config);
  } catch {
    runtime = createRuntime({ apiKey: '', endpoint: '' });
  }
  const live = runtime;
  return {
    supportsRequirements: true,
    chooseAction: (request: TaskChooseActionRequest, context) =>
      guarded(() =>
        execute(
          live,
          {
            stage: 'action',
            set: buildActionQuestions(request, live.build),
            goal: request.goal,
            step: request.step,
            parse: parseAction,
          },
          context
        )
      ),
    chooseArgument: (request, context) =>
      guarded(() =>
        execute(
          live,
          {
            stage: 'argument',
            set: buildArgumentQuestions(request, live.build),
            goal: request.goal,
            step: request.step,
            parse: parseArgument(request.purpose),
          },
          context
        )
      ),
    classifyCommitment: (request, context) =>
      guarded(async () => {
        const floor = isProbability(request.confidenceFloor)
          ? request.confidenceFloor
          : TASK_DEFAULT_CONFIDENCE.commitment;
        const classify = () =>
          execute(
            live,
            {
              stage: 'commitment',
              set: commitmentSet(live, request),
              goal: request.goal,
              step: request.step,
              parse: parseCommitment(live.confirmCommitment, floor),
            },
            context
          );
        const first = await classify();
        if (!first.ok || !isWeakPresenceEscalation(first.decision, floor)) {
          return first;
        }
        const second = await classify();
        return second.ok && !isWeakPresenceEscalation(second.decision, floor) ? second : first;
      }),
    verifyCompletion: (request: TaskVerifyCompletionRequest, context) =>
      guarded(() => {
        const set = buildCompletionQuestions(request, live.build);
        const controls = request.unresolvedControls ?? [];
        if (controls.length > TASK_LIMITS.expectedStates) {
          return Promise.resolve({
            ok: false as const,
            error: failure(
              'REQUEST_TOO_LARGE',
              'Unresolved controls exceed the complete-projection limit',
              false
            ),
          });
        }
        if (controls.length > 0 && set.state.unresolvedControls?.length !== controls.length) {
          return Promise.resolve({
            ok: false as const,
            error: failure(
              'INVALID_REQUEST',
              'Unresolved controls cannot all bind to the current observation',
              false
            ),
          });
        }
        return execute(
          live,
          {
            stage: 'completion',
            set,
            goal: request.goal,
            step: request.step,
            parse: parseCompletion(request.expectAnswer === false, set),
          },
          context
        );
      }),
  };
};
