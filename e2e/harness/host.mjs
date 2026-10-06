const BRIDGE_GLOBAL = '__kriyaTaskBridge';
const DEFAULT_CALL_TIMEOUT_MS = 10000;
const DEFAULT_WAIT_TIMEOUT_MS = 15000;
const WAIT_POLLING_MS = 25;
// setTimeout fires after 1 ms (and prints a warning) above this value.
const MAX_TIMER_MS = 2 ** 31 - 1;
const MESSAGE_LIMIT = 300;
const WITHHELD = '[message withheld]';

const NAVIGATED =
  /Execution context was destroyed|Frame was detached|frame got detached|Navigation interrupted the evaluation|Cannot find context with specified id|Inspected target navigated or closed/i;
const CLOSED =
  /Target page, context or browser has been closed|Target closed|browser has been closed/i;
const EVALUATE_TIMEOUT = /Timeout \d+ms exceeded/i;

const FIXED_MESSAGES = {
  navigated: 'the document was replaced during the call',
  closed: 'the page was closed',
  timeout: 'the call timed out',
};

/** Maps a page.evaluate rejection to a transport lost reason (never inspects page content). */
export function classifyEvaluateError(error) {
  const text = String(error?.message ?? error);
  if (CLOSED.test(text)) {
    return 'closed';
  }
  if (NAVIGATED.test(text)) {
    return 'navigated';
  }
  if (EVALUATE_TIMEOUT.test(text)) {
    return 'timeout';
  }
  return 'error';
}

async function invokeInPage({ name, envelope }) {
  const bridge = globalThis[name];
  if (bridge === undefined || bridge === null || typeof bridge.invoke !== 'function') {
    return { missing: true };
  }
  return { response: await bridge.invoke(envelope) };
}

function readyDocumentInPage({ name, previous }) {
  const bridge = globalThis[name];
  if (bridge === undefined || bridge === null || bridge.ready !== true) {
    return false;
  }
  const id = bridge.documentId;
  if (typeof id !== 'string' || id.length === 0 || id === previous) {
    return false;
  }
  return { documentId: id };
}

function normalizeScrub(redact) {
  if (typeof redact === 'function') {
    return redact;
  }
  if (redact !== null && typeof redact === 'object' && typeof redact.scrub === 'function') {
    return text => redact.scrub(text);
  }
  return text => text;
}

const positive = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMER_MS)
    : fallback;

/**
 * TaskTransport over a Playwright page (contract 12.4). invoke never rejects; location comes from
 * page.url(), never from the page; no payload is ever logged. Messages are first line only, capped
 * and passed through `redact`. `onTrace` receives value-free lines; the envelope is attached only
 * when the caller also supplies `redactEnvelope`.
 */
export function createPlaywrightTransport({
  page,
  redact,
  redactEnvelope,
  onTrace,
  bridgeGlobal = BRIDGE_GLOBAL,
}) {
  const scrubText = normalizeScrub(redact);

  const scrub = text => {
    try {
      const out = scrubText(String(text).split('\n')[0] ?? '');
      return typeof out === 'string' ? out.slice(0, MESSAGE_LIMIT) : WITHHELD;
    } catch {
      return WITHHELD;
    }
  };

  const lost = (reason, message) => ({ kind: 'lost', reason, message });

  const lostFromError = error => {
    const reason = classifyEvaluateError(error);
    return lost(
      reason,
      reason === 'error' ? scrub(error?.message ?? error) : FIXED_MESSAGES[reason]
    );
  };

  const fromValue = value => {
    if (value !== null && typeof value === 'object' && value.missing === true) {
      return lost('error', 'bridge not installed');
    }
    const response = value?.response;
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      return lost('error', 'malformed bridge response');
    }
    return { kind: 'response', response };
  };

  const trace = (envelope, result, startedAt) => {
    if (typeof onTrace !== 'function') {
      return;
    }
    const line = {
      method: envelope?.method,
      callId: envelope?.callId,
      kind: result.kind,
      ms: Math.round(performance.now() - startedAt),
      ...(result.kind === 'lost' ? { reason: result.reason } : {}),
    };
    try {
      if (typeof redactEnvelope === 'function') {
        line.envelope = redactEnvelope(envelope);
      }
      onTrace(line);
    } catch {
      // a failing trace sink must not change the call result
    }
  };

  // The first statement that can reach the page is page.evaluate itself: Playwright sends evaluate
  // calls in call order, so an envelope sent later never overtakes an earlier one.
  const dispatch = async (envelope, call) => {
    const method = envelope?.method;
    const signal = call?.signal;
    const timeoutMs = positive(call?.timeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    // A cancel must always reach the page. An execute that was aborted before sending is never sent.
    const honorAbort = method !== 'cancel';
    const abortsWhileWaiting = honorAbort && method !== 'execute';

    if (page.isClosed()) {
      return lost('closed', FIXED_MESSAGES.closed);
    }
    if (honorAbort && signal?.aborted === true) {
      return lost('error', 'aborted before send');
    }
    const pending = page
      .evaluate(invokeInPage, { name: bridgeGlobal, envelope })
      .then(fromValue, lostFromError);
    let timer;
    let onAbort;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(lost('timeout', FIXED_MESSAGES.timeout)), timeoutMs);
    });
    const racers = [pending, timeout];
    if (abortsWhileWaiting && signal !== undefined) {
      racers.push(
        new Promise(resolve => {
          onAbort = () => resolve(lost('error', 'aborted while waiting'));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      );
    }
    try {
      return await Promise.race(racers);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  };

  const invoke = async (envelope, call) => {
    const startedAt = performance.now();
    let result;
    try {
      result = await dispatch(envelope, call);
    } catch (error) {
      result = lostFromError(error);
    }
    trace(envelope, result, startedAt);
    return result;
  };

  const readLocation = async () => {
    if (page.isClosed()) {
      return {
        ok: false,
        error: { code: 'DOCUMENT_LOST', message: FIXED_MESSAGES.closed, retryable: false },
      };
    }
    const url = page.url();
    try {
      return { ok: true, value: { url, origin: new URL(url).origin } };
    } catch {
      return {
        ok: false,
        error: { code: 'HOST_UNAVAILABLE', message: 'page url unavailable', retryable: true },
      };
    }
  };

  const location = async () => {
    try {
      return await readLocation();
    } catch {
      return {
        ok: false,
        error: { code: 'HOST_UNAVAILABLE', message: 'page url unavailable', retryable: true },
      };
    }
  };

  const awaitDocument = async ({ previousDocumentId, timeoutMs, signal } = {}) => {
    if (page.isClosed() || signal?.aborted === true) {
      return null;
    }
    const wait = page
      .waitForFunction(
        readyDocumentInPage,
        { name: bridgeGlobal, previous: previousDocumentId ?? null },
        { timeout: positive(timeoutMs, DEFAULT_WAIT_TIMEOUT_MS), polling: WAIT_POLLING_MS }
      )
      .then(
        async handle => {
          const value = await handle.jsonValue().catch(() => null);
          await handle.dispose().catch(() => undefined);
          return value;
        },
        () => null
      );
    let onAbort;
    const racers = [wait];
    if (signal !== undefined) {
      racers.push(
        new Promise(resolve => {
          onAbort = () => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
        })
      );
    }
    let found;
    try {
      found = await Promise.race(racers);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
    }
    if (found === null || typeof found?.documentId !== 'string' || found.documentId.length === 0) {
      return null;
    }
    return { documentId: found.documentId, url: page.url(), ready: true };
  };

  const waitForDocument = async input => {
    try {
      return await awaitDocument(input);
    } catch {
      return null;
    }
  };

  const refresh = async (input, call = {}) => {
    if (call.signal?.aborted || page.isClosed()) {
      return {
        ok: false,
        error: { code: 'CANCELLED', message: 'independent read cancelled', retryable: false },
      };
    }
    const url = page.url();
    if (url !== input.url || !input.allowedOrigins.includes(new URL(url).origin)) {
      return {
        ok: false,
        error: {
          code: 'DOCUMENT_CHANGED',
          message: 'independent read outside scope',
          retryable: false,
        },
      };
    }
    try {
      await page.goto(url, {
        waitUntil: 'load',
        timeout: positive(call.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS),
      });
      if (call.signal?.aborted) {
        return {
          ok: false,
          error: { code: 'CANCELLED', message: 'independent read cancelled', retryable: false },
        };
      }
      const found = await waitForDocument({ timeoutMs: call.timeoutMs, signal: call.signal });
      return found
        ? { ok: true, value: found }
        : {
            ok: false,
            error: {
              code: 'OBSERVE_FAILED',
              message: 'independent view unavailable',
              retryable: true,
            },
          };
    } catch {
      return {
        ok: false,
        error: { code: 'OBSERVE_FAILED', message: 'independent read failed', retryable: true },
      };
    }
  };

  return {
    invoke,
    concurrent: true,
    location,
    waitForDocument,
    refresh,
    close: async () => undefined,
  };
}
