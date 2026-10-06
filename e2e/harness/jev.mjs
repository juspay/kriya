import { createHash } from 'node:crypto';

export const REDACTED = '[REDACTED]';
export const UNREDACTABLE = '[UNREDACTABLE]';
export const DEFAULT_JEV_CONCURRENCY = 3;

const GATE_KEY = Symbol.for('kriya.e2e.jev.process-gate');
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30000;
// Node timers and AbortSignal.timeout fire after 1 ms above this value (and AbortSignal.timeout
// throws above 2 ** 32 - 1), so a hostile timeoutMs must be clamped before it reaches one.
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_TRACKED_BODIES = 256;
const MAX_DEEP_DEPTH = 64;
const MIN_SUBSTRING_LENGTH = 4;
const SENSITIVE_HEADER = /authorization|cookie|api[-_]?key|x-api|token|secret|credential|password/i;
const AUTHORIZATION_NAME = /^authorization$/i;
const REQUEST_ID_HEADER = 'x-typesafe-request-id';
const RETRYABLE_STATUS = status => status === 408 || status === 429 || status >= 500;

function failure(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

const abortedError = () => failure('AbortError', 'Jev request aborted');
const timeoutError = () => failure('TimeoutError', 'Jev request timed out');
const networkError = () => failure('NetworkError', 'Jev request failed');

/**
 * Counting gate: at most maxInFlight tasks run at once, the rest wait in FIFO order. A waiting task
 * whose signal aborts leaves the queue without ever taking a slot.
 */
export function createJevGate({ maxInFlight = DEFAULT_JEV_CONCURRENCY } = {}) {
  const assertLimit = value => {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError('Jev gate limit must be a positive integer');
    }
  };
  assertLimit(maxInFlight);
  let limit = maxInFlight;
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const queue = [];

  const pump = () => {
    while (inFlight < limit && queue.length > 0) {
      queue.shift().start();
    }
  };

  const release = () => {
    inFlight -= 1;
    pump();
  };

  const run = (task, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError());
        return;
      }
      const waiter = {
        start: () => {
          signal?.removeEventListener('abort', waiter.onAbort);
          inFlight += 1;
          started += 1;
          peak = Math.max(peak, inFlight);
          (async () => task())().then(
            value => {
              release();
              resolve(value);
            },
            error => {
              release();
              reject(error);
            }
          );
        },
        onAbort: () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) {
            queue.splice(index, 1);
          }
          reject(abortedError());
        },
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      queue.push(waiter);
      pump();
    });

  return {
    run,
    setMaxInFlight: value => {
      assertLimit(value);
      limit = value;
      pump();
    },
    get maxInFlight() {
      return limit;
    },
    get inFlight() {
      return inFlight;
    },
    get queued() {
      return queue.length;
    },
    get peak() {
      return peak;
    },
    get started() {
      return started;
    },
  };
}

/** One gate per process, shared by every scenario and every copy of this module. */
export function getProcessGate(limit) {
  const existing = globalThis[GATE_KEY];
  const gate = existing ?? createJevGate({ maxInFlight: DEFAULT_JEV_CONCURRENCY });
  if (existing === undefined) {
    Object.defineProperty(globalThis, GATE_KEY, { value: gate, enumerable: false });
  }
  if (limit !== undefined) {
    gate.setMaxInFlight(limit);
  }
  return gate;
}

function resolveGate(gate) {
  if (gate === undefined || gate === null) {
    return getProcessGate();
  }
  if (typeof gate === 'number') {
    return getProcessGate(gate);
  }
  if (typeof gate === 'object' && typeof gate.run === 'function') {
    return gate;
  }
  throw new TypeError('gate must be a Jev gate, a limit, or undefined');
}

function collectStrings(input, into, depth) {
  if (typeof input === 'string') {
    into.push(input);
  } else if (typeof input === 'number' && Number.isFinite(input)) {
    into.push(String(input));
  } else if (depth < 4 && input !== null && typeof input === 'object') {
    const items =
      Symbol.iterator in input
        ? [...input]
        : Object.values(/** @type {Record<string, unknown>} */ (input));
    for (const item of items) {
      collectStrings(item, into, depth + 1);
    }
  }
  return into;
}

function variantsOf(value) {
  const trimmed = value.trim();
  const encoded = encodeURIComponent(value);
  const found = [
    value,
    trimmed,
    JSON.stringify(value).slice(1, -1),
    encoded,
    encoded.replace(/%20/g, '+'),
  ];
  if (/^[\d\s-]+$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 8) {
      const groups = digits.match(/.{1,4}/g) ?? [];
      found.push(digits, groups.join(' '), groups.join('-'));
    }
  }
  return found.filter(text => text.length >= MIN_SUBSTRING_LENGTH);
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function createValueRedactor(source) {
  const learned = new Set();
  let cacheKey = '';
  let cacheValue = { variants: [], pattern: null, exact: new Set() };

  const current = () => {
    const raw = typeof source === 'function' ? source() : source;
    const values = [...collectStrings(raw, [], 0), ...learned].filter(
      value => value.trim().length > 0
    );
    const key = values.join('\u0000');
    if (key !== cacheKey) {
      const variants = [...new Set(values.flatMap(variantsOf))].sort((a, b) => b.length - a.length);
      cacheKey = key;
      cacheValue = {
        variants,
        pattern: variants.length > 0 ? new RegExp(variants.map(escapeRegExp).join('|'), 'g') : null,
        exact: new Set(values.flatMap(value => [value, value.trim()])),
      };
    }
    return cacheValue;
  };

  const redactString = text => {
    const { pattern, exact } = current();
    if (exact.has(text) || exact.has(text.trim())) {
      return REDACTED;
    }
    return pattern === null ? text : text.replace(pattern, REDACTED);
  };

  const redactDeep = (input, depth = 0) => {
    if (typeof input === 'string') {
      return redactString(input);
    }
    if (depth >= MAX_DEEP_DEPTH) {
      return '[TRUNCATED]';
    }
    if (Array.isArray(input)) {
      return input.map(item => {
        const next = redactDeep(item, depth + 1);
        return next === undefined ? null : next;
      });
    }
    if (input !== null && typeof input === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(input)) {
        const next = redactDeep(value, depth + 1);
        if (next !== undefined) {
          Object.defineProperty(out, redactString(key), {
            value: next,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return out;
    }
    if (typeof input === 'function' || typeof input === 'bigint' || typeof input === 'symbol') {
      return undefined;
    }
    return input;
  };

  const hasResidue = text => {
    const { pattern } = current();
    if (pattern === null) {
      return false;
    }
    pattern.lastIndex = 0;
    return pattern.test(text);
  };

  return { redactString, redactDeep, hasResidue, learn: value => learned.add(value) };
}

function createSink(recorder) {
  if (recorder === undefined || recorder === null) {
    return () => undefined;
  }
  if (typeof recorder === 'function') {
    return entry => recorder(entry);
  }
  if (typeof recorder.record === 'function') {
    return entry => recorder.record(entry);
  }
  if (typeof recorder.push === 'function') {
    return entry => recorder.push(entry);
  }
  if (typeof recorder.write === 'function') {
    const all = [];
    return entry => {
      all.push(entry);
      return recorder.write('jev-calls.json', all.slice());
    };
  }
  throw new TypeError('recorder must be a function or expose record, push or write');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function sanitizeHeaders(headers, redactString) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    Object.defineProperty(out, name, {
      value: SENSITIVE_HEADER.test(name) ? REDACTED : redactString(String(value)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The default fetch path: the only code that reads the credential. The key goes into the
 * Authorization header of this one request and nowhere else; `learn` only feeds the redactor.
 */
export async function defaultFetchSend({ url, init, signal, learn }) {
  const headers = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (!AUTHORIZATION_NAME.test(name)) {
      headers[name] = value;
    }
  }
  if (typeof init.credential === 'function') {
    const key = init.credential();
    if (typeof key === 'string' && key.length > 0) {
      learn?.(key);
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return fetch(url, {
    method: init.method,
    headers,
    body: init.body,
    signal,
    redirect: 'error',
  });
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Only values this module produced itself survive: nothing from the exchange is kept as text. */
function withheldEntry(entry) {
  return {
    at: typeof entry.at === 'string' ? entry.at : null,
    url: UNREDACTABLE,
    attempt: Number.isInteger(entry.attempt) ? entry.attempt : null,
    requestHeaders: {},
    request: UNREDACTABLE,
    response: UNREDACTABLE,
    model: null,
    requestId: null,
    latency: Number.isFinite(entry.latency) ? entry.latency : null,
    status: Number.isInteger(entry.status) ? entry.status : null,
    ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
  };
}

/**
 * TaskHttp that sends through the gate, records every attempt (redacted) and returns the response.
 * It never retries: 429/5xx and network errors go back to the caller (the adapter owns retries).
 *
 * @param {{
 *   gate?: unknown,
 *   recorder?: unknown,
 *   redactValues?: unknown,
 *   send?: (input: { url: string, init: object, signal: AbortSignal, learn: (v: string) => void }) => Promise<Response>,
 *   defaultTimeoutMs?: number,
 * }} [options]
 */
export function createRecordingHttp({
  gate,
  recorder,
  redactValues = [],
  send = defaultFetchSend,
  defaultTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
} = {}) {
  const activeGate = resolveGate(gate);
  const fallbackTimeoutMs =
    Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0
      ? defaultTimeoutMs
      : DEFAULT_ATTEMPT_TIMEOUT_MS;
  const sink = createSink(recorder);
  const redactor = createValueRedactor(redactValues);
  const entries = [];
  const bodies = new Map();
  const stats = { sent: 0, failed: 0, recordErrors: 0 };

  const nextAttempt = key => {
    const prior = bodies.get(key);
    return prior !== undefined && prior.retryable ? prior.count + 1 : 1;
  };

  const remember = (key, count, retryable) => {
    bodies.delete(key);
    bodies.set(key, { count, retryable });
    if (bodies.size > MAX_TRACKED_BODIES) {
      bodies.delete(bodies.keys().next().value);
    }
  };

  const record = entry => {
    let safe;
    try {
      const redacted = redactor.redactDeep({
        ...entry,
        requestHeaders: sanitizeHeaders(entry.requestHeaders, redactor.redactString),
      });
      safe = redactor.hasResidue(JSON.stringify(redacted))
        ? { ...redacted, request: UNREDACTABLE, response: UNREDACTABLE }
        : redacted;
    } catch {
      // A redaction source that throws must never decide what gets recorded or what the caller sees.
      stats.recordErrors += 1;
      safe = withheldEntry(entry);
    }
    entries.push(safe);
    try {
      Promise.resolve(sink(safe)).catch(() => {
        stats.recordErrors += 1;
      });
    } catch {
      stats.recordErrors += 1;
    }
  };

  const http = async (url, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const bodyKey = sha256Hex(bodyText);
    const attempt = nextAttempt(bodyKey);
    const parsedBody = parseJson(bodyText);
    const request = parsedBody.ok ? parsedBody.value : bodyText;
    const timeoutMs = Math.min(
      Number.isFinite(init?.timeoutMs) && init.timeoutMs > 0 ? init.timeoutMs : fallbackTimeoutMs,
      MAX_TIMER_MS
    );
    const callerSignal = init?.signal;
    const base = () => ({
      at: new Date().toISOString(),
      url,
      attempt,
      requestHeaders: init?.headers,
      request,
    });

    let dispatched = false;
    let startedAt = 0;
    let timeoutSignal;
    let exchange;
    try {
      exchange = await activeGate.run(async () => {
        dispatched = true;
        startedAt = performance.now();
        timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal =
          callerSignal === undefined
            ? timeoutSignal
            : AbortSignal.any([callerSignal, timeoutSignal]);
        const response = await send({ url, init, signal, learn: redactor.learn });
        const text = await response.text();
        return { response, text };
      }, callerSignal);
    } catch {
      // The adapter joins its own per-attempt timer into the signal it hands over, so a signal that
      // aborted with a TimeoutError reason is a timeout (retryable), not a caller abort.
      const kind = callerSignal?.aborted
        ? callerSignal.reason?.name === 'TimeoutError'
          ? 'timeout'
          : 'aborted'
        : timeoutSignal?.aborted
          ? 'timeout'
          : 'network';
      if (dispatched) {
        stats.failed += 1;
        remember(bodyKey, attempt, kind !== 'aborted');
        record({
          ...base(),
          response: null,
          model: null,
          requestId: null,
          latency: Math.round(performance.now() - startedAt),
          status: null,
          error: kind,
        });
      }
      throw kind === 'aborted'
        ? abortedError()
        : kind === 'timeout'
          ? timeoutError()
          : networkError();
    }

    const latency = Math.round(performance.now() - startedAt);
    const { response, text } = exchange;
    const parsed = parseJson(text);
    const payload = parsed.ok ? parsed.value : null;
    const model =
      payload !== null && typeof payload === 'object' && typeof payload.model === 'string'
        ? payload.model
        : null;
    const headerOf = name => {
      const value = response.headers?.get?.(String(name));
      return value === undefined ? null : value;
    };
    stats.sent += 1;
    remember(bodyKey, attempt, RETRYABLE_STATUS(response.status));
    record({
      ...base(),
      response: payload,
      model,
      requestId: headerOf(REQUEST_ID_HEADER),
      latency,
      status: response.status,
      retryAfter: headerOf('retry-after'),
    });

    return {
      ok: response.ok === true,
      status: response.status,
      header: headerOf,
      json: async () => {
        const again = parseJson(text);
        if (!again.ok) {
          throw failure('InvalidResponse', 'Jev response is not JSON');
        }
        return again.value;
      },
    };
  };

  Object.defineProperties(http, {
    recorded: { value: () => entries.slice() },
    stats: { value: () => ({ ...stats }) },
  });
  return http;
}
