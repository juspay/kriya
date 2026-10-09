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

/** Invoke the page bridge, reporting a missing callable separately from a bridge response. */
async function invokeInPage({ name, envelope }) {
  const bridge = globalThis[name];
  if (bridge === undefined || bridge === null || typeof bridge.invoke !== 'function') {
    return { missing: true };
  }
  return { response: await bridge.invoke(envelope) };
}

/** Accept only a ready bridge with a nonempty document id different from the previous realm. */
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

/** Adapt a redaction function or scrub-method object to the transport's text-only sink. */
function normalizeScrub(redact) {
  if (typeof redact === 'function') {
    return redact;
  }
  if (redact !== null && typeof redact === 'object' && typeof redact.scrub === 'function') {
    return text => redact.scrub(text);
  }
  return text => text;
}

/** Clamp positive finite delays to the timer limit; use the default for invalid input. */
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

  /** Redact and bound the first message line, withholding text when the redactor fails. */
  const scrub = text => {
    try {
      const out = scrubText(String(text).split('\n')[0] ?? '');
      return typeof out === 'string' ? out.slice(0, MESSAGE_LIMIT) : WITHHELD;
    } catch {
      return WITHHELD;
    }
  };

  const lost = (reason, message) => ({ kind: 'lost', reason, message });

  /** Map controller failures to fixed lifecycle messages or a scrubbed generic error. */
  const lostFromError = error => {
    const reason = classifyEvaluateError(error);
    return lost(
      reason,
      reason === 'error' ? scrub(error?.message ?? error) : FIXED_MESSAGES[reason]
    );
  };

  /** Forward only object bridge responses and normalize missing or malformed answers. */
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

  /** Emit timing metadata; include an envelope only through caller-supplied redaction. */
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

  /**
   * Send in Playwright call order with a bounded timeout. Always forward cancel; an execute
   * aborted before sending stays unsent, while a sent execute keeps waiting for its reply.
   */
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

  /** Return a transport result for dispatch failures and emit one trace per call. */
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

  /** Read the authoritative controller URL and origin without evaluating page content. */
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

  /** Normalize unreadable or malformed controller URLs to HOST_UNAVAILABLE results. */
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

  /** Wait abortably for a new ready bridge document and dispose every received page handle. */
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

  /** Return null for document-wait failures instead of rejecting across the transport boundary. */
  const waitForDocument = async input => {
    try {
      return await awaitDocument(input);
    } catch {
      return null;
    }
  };

  /** Reload the same authorized URL as an independent GET, returning structured read failures. */
  const refresh = async (input, call = {}) => {
    if (call.signal?.aborted || page.isClosed()) {
      return {
        ok: false,
        error: { code: 'CANCELLED', message: 'independent read cancelled', retryable: false },
      };
    }
    const current = await location();
    if (!current.ok) {
      return current;
    }
    if (current.value.url !== input.url || !input.allowedOrigins.includes(current.value.origin)) {
      return {
        ok: false,
        error: {
          code: 'DOCUMENT_CHANGED',
          message: 'independent read outside scope',
          retryable: false,
        },
      };
    }
    const routePattern = '**/*';
    let scopeBlocked = false;
    const expectedNetworkUrl = new URL(input.url);
    expectedNetworkUrl.hash = '';
    /** Constrain main-frame navigation to the authorized URL and forbid POST bodies or redirects. */
    const forceGet = async route => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
        await route.fallback();
        return;
      }
      if (call.signal?.aborted || page.isClosed()) {
        await route.abort('aborted');
        return;
      }
      const networkUrl = new URL(request.url());
      networkUrl.hash = '';
      if (
        !input.allowedOrigins.includes(networkUrl.origin) ||
        networkUrl.href !== expectedNetworkUrl.href
      ) {
        scopeBlocked = true;
        await route.abort('blockedbyclient');
        return;
      }
      const headers = { ...request.headers() };
      delete headers['content-type'];
      delete headers['content-length'];
      const response = await route.fetch({
        method: 'GET',
        postData: '',
        headers,
        maxRedirects: 0,
        timeout: Math.min(
          positive(call.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS),
          DEFAULT_WAIT_TIMEOUT_MS
        ),
      });
      if (response.status() >= 300 && response.status() < 400) {
        scopeBlocked = true;
        await route.abort('blockedbyclient');
        return;
      }
      await route.fulfill({ response });
    };
    try {
      // Reload creates a new realm even for a hash route. Interception makes it an
      // independent GET, including when the current document came from a POST.
      const previous = await page.evaluate(readyDocumentInPage, {
        name: bridgeGlobal,
        previous: null,
      });
      if (!previous?.documentId) {
        return {
          ok: false,
          error: {
            code: 'OBSERVE_FAILED',
            message: 'independent bridge unavailable',
            retryable: true,
          },
        };
      }
      const timeoutMs = Math.min(
        positive(call.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS),
        DEFAULT_WAIT_TIMEOUT_MS
      );
      await page.route(routePattern, forceGet);
      if (call.signal?.aborted || page.isClosed()) {
        return {
          ok: false,
          error: { code: 'CANCELLED', message: 'independent read cancelled', retryable: false },
        };
      }
      if (page.url() !== input.url) {
        return {
          ok: false,
          error: {
            code: 'DOCUMENT_CHANGED',
            message: 'independent read outside scope',
            retryable: false,
          },
        };
      }
      await page.reload({
        waitUntil: 'load',
        timeout: timeoutMs,
      });
      if (scopeBlocked) {
        return {
          ok: false,
          error: {
            code: 'DOCUMENT_CHANGED',
            message: 'independent redirect outside scope',
            retryable: false,
          },
        };
      }
      if (call.signal?.aborted) {
        return {
          ok: false,
          error: { code: 'CANCELLED', message: 'independent read cancelled', retryable: false },
        };
      }
      const found = await waitForDocument({
        previousDocumentId: previous.documentId,
        timeoutMs,
        signal: call.signal,
      });
      if (found && (found.url !== input.url || page.url() !== input.url)) {
        return {
          ok: false,
          error: {
            code: 'DOCUMENT_CHANGED',
            message: 'independent view changed',
            retryable: false,
          },
        };
      }
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
        error: call.signal?.aborted
          ? { code: 'CANCELLED', message: 'independent read cancelled', retryable: false }
          : scopeBlocked
            ? {
                code: 'DOCUMENT_CHANGED',
                message: 'independent read outside scope',
                retryable: false,
              }
            : { code: 'OBSERVE_FAILED', message: 'independent read failed', retryable: true },
      };
    } finally {
      await page.unroute(routePattern, forceGet).catch(() => undefined);
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
