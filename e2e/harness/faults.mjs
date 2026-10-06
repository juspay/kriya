/**
 * Fault injection for scenarios of kind 'fault' (e2e/harness, plain Node ESM, no imports).
 *
 * Everything this module does is a LABELLED, SCRIPTED fault: the wrappers around the real TaskDecider
 * and the real TaskHost replace or delay exactly one call, record that they did so (in `notes` and through
 * the recorder), and pass every other call through untouched. Nothing here is live verification and nothing
 * here reaches into the coordinator: only the public TaskDecider and TaskHost shapes are used.
 *
 *   applyInjection({ decider, host, page, scenario, recorder }) -> { decider, host, notes, report }
 *
 * Decider modes (counted per chooseAction call, `atDecision`, 1-based):
 *   prematureDone    chooseAction #n answers DONE (target not_applicable, confidence 0.99) instead of the model.
 *   invalidTarget    chooseAction #n names a target id that was not offered (an observed element that is not
 *                    offered for the operation when one exists, else a fabricated id).
 *   invalidArgument  armed at decision n: the first chooseArgument call made at or after decision n names a
 *                    candidate id that was not offered. Exactly once (a decision n without an argument stage
 *                    leaves it armed for the next argument question; the note records both numbers).
 *   noneAppropriate  chooseAction #n answers a target operation with the none_appropriate target choice.
 *                    `stage: 'argument'` instead poisons the first chooseArgument at or after decision n.
 *   slow             chooseAction #n waits `ms` (default 30000), honoring context.signal, then asks the real
 *                    decider. An abort during the wait returns the CANCELLED error result, as the real adapter
 *                    does for an aborted fetch, and the real decider is never asked.
 *   throw            chooseAction #n rejects (default) or, with `style: 'result'`, returns an error result.
 *                    The contract (0.3, 6.1) says the coordinator wraps decider calls in try/catch and maps a
 *                    failure to deciderFailures++ then re-observes: the next call is the retry.
 *
 * Host modes (counted per execute call, `atExecution`, 1-based):
 *   staleBeforeExecute  immediately before forwarding execute #n the target element (found from the last
 *                       observation: role, kind, accessible name) is replaced by a fresh equivalent clone
 *                       (form state copied), so the node the host holds is detached. When the target cannot be
 *                       found (no observation, a page-level command) every control of the page is replaced
 *                       instead (strategy 'controls', never a container: clones keep no listeners).
 *   contextDestroyed    a full navigation of the page to its own URL (fragment dropped). `timing: 'during'`
 *                       (default) arms an in-page one-shot trap so the navigation starts at the first input,
 *                       click, key or submit event of the forwarded execute (a scroll event for SCROLL); if execute produced none,
 *                       the navigation happens right after it returns (`navigationPhase: 'after_execute'`).
 *                       `timing: 'before'` navigates before execute is forwarded.
 *   lostAfterCommit     execute #n really runs, then the outcome is replaced by what RemoteTaskHost reports for
 *                       a lost transport (contract 12.3): uncertain / uncertain / DOCUMENT_LOST.
 *   timeoutAfterCommit  as above with the timeout mapping: uncertain / uncertain / EXECUTION_TIMEOUT.
 *   slowObserve         the first observe call after execute #n has started waits `ms` (default 3000),
 *                       honoring the signal (CANCELLED host error on abort), then asks the real host.
 *
 * Recorder: a function, or an object with record(entry), note(entry) or push(entry). Entries are JSON-safe
 * copies of the notes; a recorder that throws never changes the run.
 *
 * Misconfiguration (unknown mode, bad count, an inject on a live scenario, a missing page) throws at apply
 * time: a fault scenario that silently injected nothing would report a pass that proves nothing. A wrapper
 * adds no rejection of its own, except decider mode 'throw' (reject style), which is the point of that mode;
 * a rejection of the real decider or host (a contract violation) passes through unchanged.
 */

export const DECIDER_FAULT_MODES = Object.freeze([
  'prematureDone',
  'invalidTarget',
  'invalidArgument',
  'slow',
  'throw',
  'noneAppropriate',
]);

export const HOST_FAULT_MODES = Object.freeze([
  'staleBeforeExecute',
  'contextDestroyed',
  'lostAfterCommit',
  'timeoutAfterCommit',
  'slowObserve',
]);

export const FAULT_LABEL = 'FAULT_INJECTION';

const DEFAULT_SLOW_DECIDER_MS = 30000;
const DEFAULT_SLOW_OBSERVE_MS = 3000;
const MAX_DELAY_MS = 600000;
const HIGH_CONFIDENCE = 0.99;
const KEPT_SNAPSHOTS = 4;
const PAGE_CALL_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 8000;

// Copy of TASK_TARGET_OPERATIONS (src/types/agent.ts); the harness never imports from src/.
const TARGET_OPERATIONS = Object.freeze([
  'READ',
  'CLICK',
  'NAVIGATE',
  'FILL',
  'SELECT',
  'SET_CHECKED',
  'PRESS',
  'SUBMIT',
]);

// Events the executor dispatches while it performs a command. SCROLL is the only operation whose own
// event is a scroll: for the others a scroll event can come from scrollIntoView before the activation.
const TRAP_EVENTS_DEFAULT = Object.freeze([
  'pointerdown',
  'mousedown',
  'click',
  'input',
  'change',
  'keydown',
  'submit',
]);
const TRAP_EVENTS_SCROLL = Object.freeze(['scroll']);
const NO_EVENT_OPERATIONS = new Set(['READ', 'WAIT']);

function trapEventsFor(operation) {
  if (operation === 'SCROLL') {
    return TRAP_EVENTS_SCROLL;
  }
  return NO_EVENT_OPERATIONS.has(operation) ? [] : TRAP_EVENTS_DEFAULT;
}
const TRAP_HANDLE_KEY = 'kriya.e2e.faults.navigationTrap';

const DECIDER_KEYS = ['mode', 'atDecision', 'ms', 'style', 'stage'];
const HOST_KEYS = ['mode', 'atExecution', 'ms', 'timing', 'operation'];

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const isPositiveInteger = value => Number.isSafeInteger(value) && value >= 1;

function validateDelay(config, errors, where) {
  if (config.ms === undefined) {
    return;
  }
  if (typeof config.ms !== 'number' || !Number.isFinite(config.ms) || config.ms < 0) {
    errors.push(`${where}.ms must be a finite number >= 0`);
  } else if (config.ms > MAX_DELAY_MS) {
    errors.push(`${where}.ms must be <= ${MAX_DELAY_MS}`);
  }
}

function validateDeciderConfig(config) {
  if (!isPlainObject(config)) {
    return ['inject.decider must be an object'];
  }
  const errors = [];
  for (const key of Object.keys(config)) {
    if (!DECIDER_KEYS.includes(key)) {
      errors.push(`inject.decider.${key} is not a known option`);
    }
  }
  if (!DECIDER_FAULT_MODES.includes(config.mode)) {
    errors.push(`inject.decider.mode must be one of ${DECIDER_FAULT_MODES.join(', ')}`);
  }
  if (!isPositiveInteger(config.atDecision)) {
    errors.push('inject.decider.atDecision must be an integer >= 1');
  }
  validateDelay(config, errors, 'inject.decider');
  if (config.ms !== undefined && config.mode !== 'slow') {
    errors.push('inject.decider.ms is only valid for mode slow');
  }
  if (config.style !== undefined && (config.mode !== 'throw' || !isStyle(config.style))) {
    errors.push("inject.decider.style is only valid for mode throw: 'reject' or 'result'");
  }
  if (config.stage !== undefined && (config.mode !== 'noneAppropriate' || !isStage(config.stage))) {
    errors.push(
      "inject.decider.stage is only valid for mode noneAppropriate: 'action' or 'argument'"
    );
  }
  return errors;
}

const isStyle = value => value === 'reject' || value === 'result';
const isStage = value => value === 'action' || value === 'argument';

function validateHostConfig(config) {
  if (!isPlainObject(config)) {
    return ['inject.host must be an object'];
  }
  const errors = [];
  for (const key of Object.keys(config)) {
    if (!HOST_KEYS.includes(key)) {
      errors.push(`inject.host.${key} is not a known option`);
    }
  }
  if (!HOST_FAULT_MODES.includes(config.mode)) {
    errors.push(`inject.host.mode must be one of ${HOST_FAULT_MODES.join(', ')}`);
  }
  if (!isPositiveInteger(config.atExecution)) {
    errors.push('inject.host.atExecution must be an integer >= 1');
  }
  if (
    config.operation !== undefined &&
    (!['lostAfterCommit', 'timeoutAfterCommit'].includes(config.mode) ||
      !TARGET_OPERATIONS.includes(config.operation) ||
      ['READ', 'NAVIGATE'].includes(config.operation))
  ) {
    errors.push(
      'inject.host.operation is only an observed target operation for after-commit faults'
    );
  }
  validateDelay(config, errors, 'inject.host');
  if (config.ms !== undefined && config.mode !== 'slowObserve') {
    errors.push('inject.host.ms is only valid for mode slowObserve');
  }
  if (
    config.timing !== undefined &&
    (config.mode !== 'contextDestroyed' ||
      (config.timing !== 'before' && config.timing !== 'during'))
  ) {
    errors.push("inject.host.timing is only valid for mode contextDestroyed: 'before' or 'during'");
  }
  return errors;
}

/** Pure check of a scenario's `inject` block. */
export function validateInjection(inject) {
  if (!isPlainObject(inject)) {
    return { ok: false, errors: ['inject must be an object with a decider and/or host block'] };
  }
  const errors = [];
  for (const key of Object.keys(inject)) {
    if (key !== 'decider' && key !== 'host') {
      errors.push(`inject.${key} is not a known block`);
    }
  }
  if (inject.decider === undefined && inject.host === undefined) {
    errors.push('inject needs a decider block, a host block, or both');
  }
  if (inject.decider !== undefined) {
    errors.push(...validateDeciderConfig(inject.decider));
  }
  if (inject.host !== undefined) {
    errors.push(...validateHostConfig(inject.host));
  }
  return { ok: errors.length === 0, errors };
}

function normalizeDeciderSpec(config) {
  const base = { layer: 'decider', mode: config.mode, at: config.atDecision, stage: 'action' };
  switch (config.mode) {
    case 'slow':
      return { ...base, ms: config.ms ?? DEFAULT_SLOW_DECIDER_MS };
    case 'throw':
      return { ...base, style: config.style ?? 'reject' };
    case 'noneAppropriate':
      return { ...base, stage: config.stage ?? 'action' };
    case 'invalidArgument':
      return { ...base, stage: 'argument' };
    default:
      return base;
  }
}

function normalizeHostSpec(config) {
  const base = {
    layer: 'host',
    mode: config.mode,
    at: config.atExecution,
    ...(config.operation === undefined ? {} : { operation: config.operation }),
  };
  switch (config.mode) {
    case 'slowObserve':
      return { ...base, ms: config.ms ?? DEFAULT_SLOW_OBSERVE_MS };
    case 'contextDestroyed':
      return { ...base, timing: config.timing ?? 'during' };
    default:
      return base;
  }
}

const countKey = spec => (spec.layer === 'decider' ? 'atDecision' : 'atExecution');

function describeSpec(spec) {
  const where = `${spec.layer === 'decider' ? 'decision' : 'execution'} ${spec.at}`;
  return `${FAULT_LABEL}: ${spec.layer} mode ${spec.mode} scripted at ${where}; labelled fault injection, not live verification`;
}

// ---------------------------------------------------------------------------------------------
// Notes and recorder
// ---------------------------------------------------------------------------------------------

const jsonCopy = value => JSON.parse(JSON.stringify(value));

function sendToRecorder(recorder, entry) {
  try {
    let returned;
    if (typeof recorder === 'function') {
      returned = recorder(entry);
    } else if (recorder && typeof recorder.record === 'function') {
      returned = recorder.record(entry);
    } else if (recorder && typeof recorder.note === 'function') {
      returned = recorder.note(entry);
    } else if (recorder && typeof recorder.push === 'function') {
      returned = recorder.push(entry);
    }
    if (returned && typeof returned.then === 'function') {
      // An async recorder that rejects would otherwise end the process as an unhandled rejection.
      returned.then(undefined, () => {});
    }
  } catch {
    // A recorder must never change the run it observes.
  }
}

function createNotes({ recorder, scenarioId }) {
  const notes = [];
  const startedAt = Date.now();
  const emit = entry => {
    const note = jsonCopy({
      seq: notes.length + 1,
      type: 'fault_injection',
      label: FAULT_LABEL,
      live: false,
      scenarioId: scenarioId ?? null,
      elapsedMs: Date.now() - startedAt,
      ...entry,
    });
    notes.push(note);
    sendToRecorder(recorder, jsonCopy(note));
    return note;
  };
  return { notes, emit };
}

function configuredNote(spec) {
  const { layer, mode, at, ...extras } = spec;
  return {
    event: 'configured',
    layer,
    mode,
    [countKey(spec)]: at,
    ...extras,
    description: describeSpec(spec),
  };
}

function firedNote(spec, ordinal, details) {
  return {
    event: 'fired',
    layer: spec.layer,
    mode: spec.mode,
    [countKey(spec)]: spec.at,
    [spec.layer === 'decider' ? 'decision' : 'execution']: ordinal,
    ...details,
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Resolves 'elapsed' or 'aborted'. Clears its timer and listener whichever comes first. */
function sleepWithSignal(ms, signal) {
  return new Promise(resolve => {
    if (signal && signal.aborted) {
      resolve('aborted');
      return;
    }
    const canListen = signal && typeof signal.addEventListener === 'function';
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve('aborted');
    };
    timer = setTimeout(() => {
      if (canListen) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve('elapsed');
    }, ms);
    if (canListen) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Notes land in evidence files that are scanned for secrets, and Playwright error text quotes the page URL
// (a query string can hold anything), so a recorded error never carries a URL.
const shortMessage = error =>
  String(error && error.message ? error.message : error)
    .split('\n')[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
    .slice(0, 160);

// Strings a host reports (status, effect, code, operation) are enumerations by contract. A note keeps one
// only when it looks like one, so a misbehaving host cannot route free text into the evidence.
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const safeToken = value => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : 'unrecognized';
};

const stripFragment = url => String(url).split('#')[0];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function firstTargetOperation(offers) {
  const offered = Array.isArray(offers && offers.operations) ? offers.operations : [];
  const targetOps = offered.filter(op => TARGET_OPERATIONS.includes(op));
  if (targetOps.includes('CLICK')) {
    return 'CLICK';
  }
  return targetOps[0] ?? 'CLICK';
}

function fabricateId(prefix, taken, start) {
  let n = start;
  while (taken.has(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}

function syntheticExchange(stage, request, context) {
  return {
    stage,
    provider: 'fault-injection',
    attempts: 1,
    attemptLog: [{ attempt: 1, latencyMs: 0 }],
    latencyMs: 0,
    requestBytes: 0,
    estimatedInputTokens: 0,
    goalVerified:
      typeof request?.goal === 'string' && typeof context?.goal === 'string'
        ? request.goal === context.goal
        : false,
  };
}

// ---------------------------------------------------------------------------------------------
// Decider wrapper
// ---------------------------------------------------------------------------------------------

function buildOkResult(stage, request, context, decision) {
  return { ok: true, decision, exchange: syntheticExchange(stage, request, context) };
}

function prematureDoneResult(request, context) {
  return buildOkResult('action', request, context, {
    operation: 'DONE',
    target: { kind: 'not_applicable' },
    confidence: HIGH_CONFIDENCE,
    operationConfidence: HIGH_CONFIDENCE,
  });
}

function invalidTargetResult(request, context) {
  const operation = firstTargetOperation(request.offers);
  const offeredIds = new Set(
    Array.isArray(request.offers?.targets?.[operation]) ? request.offers.targets[operation] : []
  );
  const observedIds = (
    Array.isArray(request.observation?.elements) ? request.observation.elements : []
  )
    .map(element => element && element.id)
    .filter(id => typeof id === 'string');
  const unoffered = observedIds.find(id => !offeredIds.has(id));
  const taken = new Set([...offeredIds, ...observedIds]);
  const id = unoffered ?? fabricateId('t', taken, 9001);
  const result = buildOkResult('action', request, context, {
    operation,
    target: { kind: 'target', id },
    confidence: HIGH_CONFIDENCE,
    operationConfidence: HIGH_CONFIDENCE,
    targetConfidence: HIGH_CONFIDENCE,
  });
  return {
    result,
    details: {
      operation,
      targetId: safeToken(id),
      targetKind: unoffered ? 'observed_unoffered' : 'fabricated',
    },
  };
}

function noneAppropriateActionResult(request, context) {
  const operation = firstTargetOperation(request.offers);
  const result = buildOkResult('action', request, context, {
    operation,
    target: { kind: 'none_appropriate' },
    confidence: HIGH_CONFIDENCE,
    operationConfidence: HIGH_CONFIDENCE,
    targetConfidence: HIGH_CONFIDENCE,
  });
  return { result, details: { operation } };
}

function invalidArgumentResult(request, context) {
  const taken = new Set(
    (Array.isArray(request.candidates) ? request.candidates : [])
      .map(candidate => candidate && candidate.id)
      .filter(id => typeof id === 'string')
  );
  const candidateId = fabricateId('c', taken, 9001);
  const result = buildOkResult('argument', request, context, {
    kind: 'candidate',
    candidateId,
    confidence: HIGH_CONFIDENCE,
  });
  return { result, details: { candidateId, slot: safeToken(request.slot) } };
}

function noneAppropriateArgumentResult(request, context) {
  const result = buildOkResult('argument', request, context, {
    kind: 'none_appropriate',
    confidence: HIGH_CONFIDENCE,
  });
  return { result, details: { slot: safeToken(request.slot) } };
}

const cancelledError = message => ({
  ok: false,
  error: { code: 'CANCELLED', message, retryable: false },
});

function wrapDecider(decider, spec, emit) {
  const state = { decisions: 0, fired: false };

  const fire = (ordinal, details) => {
    state.fired = true;
    emit(firedNote(spec, ordinal, details));
  };

  const chooseAction = async (request, context) => {
    state.decisions += 1;
    const ordinal = state.decisions;
    if (spec.stage !== 'action' || ordinal !== spec.at || state.fired) {
      return decider.chooseAction(request, context);
    }
    switch (spec.mode) {
      case 'prematureDone':
        fire(ordinal, { replacedWith: 'DONE' });
        return prematureDoneResult(request, context);
      case 'invalidTarget': {
        const { result, details } = invalidTargetResult(request, context);
        fire(ordinal, details);
        return result;
      }
      case 'noneAppropriate': {
        const { result, details } = noneAppropriateActionResult(request, context);
        fire(ordinal, { ...details, replacedWith: 'none_appropriate' });
        return result;
      }
      case 'throw':
        fire(ordinal, { style: spec.style });
        if (spec.style === 'result') {
          return {
            ok: false,
            error: {
              code: 'NETWORK',
              message: 'fault injection: scripted decider failure',
              retryable: true,
            },
          };
        }
        throw new Error(`fault injection: scripted decider throw at decision ${ordinal}`);
      case 'slow': {
        fire(ordinal, { delayMs: spec.ms });
        const waited = await sleepWithSignal(spec.ms, context && context.signal);
        emit({
          event: 'slow_finished',
          layer: 'decider',
          mode: 'slow',
          decision: ordinal,
          outcome: waited === 'aborted' ? 'cancelled_during_delay' : 'elapsed_then_forwarded',
        });
        if (waited === 'aborted') {
          return cancelledError('fault injection: decider call cancelled while delayed');
        }
        return decider.chooseAction(request, context);
      }
      default:
        return decider.chooseAction(request, context);
    }
  };

  const chooseArgument = async (request, context) => {
    if (spec.stage !== 'argument' || state.fired || state.decisions < spec.at) {
      return decider.chooseArgument(request, context);
    }
    const build =
      spec.mode === 'invalidArgument' ? invalidArgumentResult : noneAppropriateArgumentResult;
    const { result, details } = build(request, context);
    fire(state.decisions, {
      ...details,
      armedAtDecision: spec.at,
      firedAtDecision: state.decisions,
      replacedWith: spec.mode === 'invalidArgument' ? 'candidate_not_offered' : 'none_appropriate',
    });
    return result;
  };

  const wrapped = {
    chooseAction,
    chooseArgument,
    verifyCompletion: (...args) => decider.verifyCompletion(...args),
  };
  if (typeof decider.classifyCommitment === 'function') {
    wrapped.classifyCommitment = (...args) => decider.classifyCommitment(...args);
  }
  return Object.freeze(wrapped);
}

// ---------------------------------------------------------------------------------------------
// Page-side functions (serialized by Playwright: each must be self-contained)
// ---------------------------------------------------------------------------------------------

function replaceWithCloneInPage(descriptor) {
  const norm = value =>
    String(value === null || value === undefined ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const nameOf = el => {
    const aria = el.getAttribute('aria-label');
    if (aria) {
      return aria;
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map(id => {
          const ref = document.getElementById(id);
          return ref ? ref.textContent : '';
        })
        .join(' ');
      if (text.trim()) {
        return text;
      }
    }
    if (el.labels && el.labels.length > 0) {
      return Array.from(el.labels)
        .map(label => label.textContent)
        .join(' ');
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
      return el.value;
    }
    return (
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.textContent ||
      ''
    );
  };

  const role = el => (el.getAttribute('role') || '').toLowerCase();
  const inputType = el =>
    el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
  const affinity = {
    button: el =>
      el.tagName === 'BUTTON' ||
      role(el) === 'button' ||
      (el.tagName === 'INPUT' && ['button', 'submit', 'reset', 'image'].includes(inputType(el))),
    link: el => el.tagName === 'A' || role(el) === 'link',
    text_input: el =>
      role(el) === 'textbox' ||
      (el.tagName === 'INPUT' &&
        !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(inputType(el))),
    textarea: el => el.tagName === 'TEXTAREA' || role(el) === 'textbox',
    select: el => el.tagName === 'SELECT' || role(el) === 'listbox',
    checkbox: el => inputType(el) === 'checkbox' || role(el) === 'checkbox',
    radio: el => inputType(el) === 'radio' || role(el) === 'radio',
    switch: el => role(el) === 'switch' || inputType(el) === 'checkbox',
    tab: el => role(el) === 'tab',
    menuitem: el => role(el) === 'menuitem',
    option: el => el.tagName === 'OPTION' || role(el) === 'option',
    combobox: el => role(el) === 'combobox' || el.tagName === 'SELECT' || el.tagName === 'INPUT',
  };

  const isControl = el => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const controlsOf = el =>
    [el, ...Array.from(el.querySelectorAll('input,textarea,select'))].filter(isControl);

  const copyState = (original, copy) => {
    const from = controlsOf(original);
    const to = controlsOf(copy);
    from.forEach((source, index) => {
      const target = to[index];
      if (!target) {
        return;
      }
      if (source.tagName === 'SELECT') {
        Array.from(source.options).forEach((option, optionIndex) => {
          if (target.options[optionIndex]) {
            target.options[optionIndex].selected = option.selected;
          }
        });
      } else if (source.type === 'checkbox' || source.type === 'radio') {
        target.checked = source.checked;
        target.indeterminate = source.indeterminate;
      } else if (source.type !== 'file') {
        target.value = source.value;
      }
    });
  };

  const replaceOne = el => {
    const copy = el.cloneNode(true);
    copyState(el, copy);
    const hadFocus = document.activeElement === el;
    el.replaceWith(copy);
    if (hadFocus && typeof copy.focus === 'function') {
      copy.focus({ preventScroll: true });
    }
    return copy.isConnected;
  };

  const outermost = list =>
    list.filter(el => !list.some(other => other !== el && other.contains(el)));

  const STRICT_CONTROL_SELECTOR =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],' +
    '[role=menuitem],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=listbox]';

  let strategy = 'controls';
  let matches = 0;
  let targets = [];
  if (descriptor && descriptor.label) {
    const want = norm(descriptor.label);
    const all = Array.from(
      document.querySelectorAll(
        'a,button,input,select,textarea,summary,label,option,[role],[tabindex],[contenteditable],[onclick]'
      )
    );
    const byName = all.filter(el => {
      const got = norm(nameOf(el));
      if (!got) {
        return false;
      }
      return (
        got === want ||
        (want.length >= 8 && got.startsWith(want)) ||
        (got.length >= 8 && want.startsWith(got))
      );
    });
    const check = affinity[descriptor.kind];
    const byKind = check ? byName.filter(check) : byName;
    const picked = byKind.length > 0 ? byKind : byName;
    matches = picked.length;
    if (matches > 0) {
      strategy = 'target';
      targets = outermost(picked);
    }
  }
  if (strategy === 'controls') {
    // Never a container: an app attaches its own listeners and caches its roots (a form's submit handler,
    // a mounted app node), and a clone keeps none of them, so replacing a container would break the app
    // instead of staling a reference. A control is the one thing a held reference can be about.
    const root = document.body || document.documentElement;
    targets = outermost(Array.from(root.querySelectorAll(STRICT_CONTROL_SELECTOR)));
  }

  const tags = Array.from(new Set(targets.map(el => el.tagName)));
  const replaced = targets.map(replaceOne).filter(Boolean).length;
  return { strategy, matches, tags, replaced, attempted: targets.length };
}

function armNavigationTrapInPage(arg) {
  const handleKey = Symbol.for(arg.handleKey);
  const existing = window[handleKey];
  if (existing && typeof existing.disarm === 'function') {
    existing.disarm();
  }
  let done = false;
  const disarm = () => {
    done = true;
    arg.events.forEach(name => window.removeEventListener(name, handler, true));
    try {
      delete window[handleKey];
    } catch {
      window[handleKey] = undefined;
    }
  };
  function handler() {
    if (done) {
      return;
    }
    disarm();
    console.debug(arg.token);
    window.location.assign(window.location.href.split('#')[0]);
  }
  arg.events.forEach(name =>
    window.addEventListener(name, handler, { capture: true, passive: true })
  );
  Object.defineProperty(window, handleKey, { value: { disarm }, configurable: true });
  return { timeOrigin: performance.timeOrigin };
}

function readTimeOriginInPage() {
  return performance.timeOrigin;
}

// ---------------------------------------------------------------------------------------------
// Host wrapper
// ---------------------------------------------------------------------------------------------

function elementIndex(observation) {
  const index = new Map();
  for (const element of Array.isArray(observation?.elements) ? observation.elements : []) {
    if (element && typeof element.id === 'string') {
      index.set(element.id, element);
    }
  }
  return index;
}

function describeTarget(request, snapshots) {
  const target = request?.command?.target;
  if (!target || typeof target.targetId !== 'string') {
    return { descriptor: null, reason: 'command_has_no_target' };
  }
  const index = snapshots.get(target.snapshotId);
  if (!index) {
    return { descriptor: null, reason: 'snapshot_not_observed' };
  }
  const element = index.get(target.targetId);
  if (!element) {
    return { descriptor: null, reason: 'element_not_in_snapshot' };
  }
  return {
    descriptor: {
      kind: element.kind,
      role: element.role,
      label: typeof element.label === 'string' ? element.label : '',
    },
    reason: 'described',
  };
}

async function waitForNewDocument(page, previousTimeOrigin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await withTimeout(
        page.evaluate(readTimeOriginInPage),
        1000,
        'time origin read'
      );
      if (current !== previousTimeOrigin) {
        return true;
      }
    } catch {
      // The context is being replaced: poll again.
    }
    await sleep(25);
  }
  return false;
}

async function navigateToOwnUrl(page) {
  try {
    await page.goto(stripFragment(page.url()), {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: shortMessage(error) };
  }
}

function wrapHost({ host, spec, page, emit }) {
  const state = {
    executions: 0,
    executionFired: false,
    observeFired: false,
    snapshots: new Map(),
  };

  const rememberObservation = result => {
    if (spec.mode !== 'staleBeforeExecute' || !result || result.ok !== true) {
      return;
    }
    const observation = result.value;
    if (!observation || typeof observation.snapshotId !== 'string') {
      return;
    }
    state.snapshots.set(observation.snapshotId, elementIndex(observation));
    while (state.snapshots.size > KEPT_SNAPSHOTS) {
      state.snapshots.delete(state.snapshots.keys().next().value);
    }
  };

  const observe = async (request, signal) => {
    if (spec.mode === 'slowObserve' && !state.observeFired && state.executions >= spec.at) {
      state.observeFired = true;
      emit(firedNote(spec, state.executions, { delayMs: spec.ms, delayed: 'observe' }));
      const waited = await sleepWithSignal(spec.ms, signal);
      emit({
        event: 'slow_finished',
        layer: 'host',
        mode: 'slowObserve',
        execution: state.executions,
        outcome: waited === 'aborted' ? 'cancelled_during_delay' : 'elapsed_then_forwarded',
      });
      if (waited === 'aborted') {
        return {
          ok: false,
          error: {
            code: 'CANCELLED',
            message: 'fault injection: observe cancelled while delayed',
            retryable: false,
          },
        };
      }
    }
    const result = await host.observe(request, signal);
    rememberObservation(result);
    return result;
  };

  const runStale = async (request, signal, ordinal) => {
    const { descriptor, reason } = describeTarget(request, state.snapshots);
    let outcome;
    try {
      outcome = await withTimeout(
        page.evaluate(replaceWithCloneInPage, descriptor),
        PAGE_CALL_TIMEOUT_MS,
        'DOM replacement'
      );
    } catch (error) {
      outcome = {
        strategy: 'none',
        matches: 0,
        tags: [],
        replaced: 0,
        attempted: 0,
        error: shortMessage(error),
      };
    }
    emit(
      firedNote(spec, ordinal, {
        operation: safeToken(request?.command?.operation),
        targetId: safeToken(request?.command?.target?.targetId),
        descriptor: reason,
        strategy: outcome.strategy,
        matches: outcome.matches,
        replaced: outcome.replaced,
        attempted: outcome.attempted,
        tags: outcome.tags,
        applied: outcome.replaced > 0 && outcome.error === undefined,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      })
    );
    return host.execute(request, signal);
  };

  const runContextBefore = async (request, signal, ordinal) => {
    const navigation = await navigateToOwnUrl(page);
    emit(
      firedNote(spec, ordinal, {
        timing: 'before',
        navigationPhase: 'before_execute',
        applied: navigation.ok,
        ...(navigation.ok ? {} : { error: navigation.error }),
      })
    );
    return host.execute(request, signal);
  };

  const runContextDuring = async (request, signal, ordinal) => {
    const token = `kriya-e2e-fault-nav-${ordinal}-${Date.now().toString(36)}`;
    const events = trapEventsFor(request?.command?.operation);
    let trapFired = false;
    const onConsole = message => {
      if (message.text() === token) {
        trapFired = true;
      }
    };
    page.on('console', onConsole);
    let timeOrigin = null;
    let armError;
    if (events.length > 0) {
      try {
        const armed = await withTimeout(
          page.evaluate(armNavigationTrapInPage, { token, events, handleKey: TRAP_HANDLE_KEY }),
          PAGE_CALL_TIMEOUT_MS,
          'navigation trap arming'
        );
        timeOrigin = armed.timeOrigin;
      } catch (error) {
        armError = shortMessage(error);
      }
    }
    let outcome;
    let executeError;
    try {
      outcome = await host.execute(request, signal);
    } catch (error) {
      executeError = error;
    }
    await sleep(40);
    page.off('console', onConsole);
    let phase;
    let applied;
    let error = armError;
    if (trapFired) {
      phase = 'during';
      applied =
        timeOrigin === null
          ? true
          : await waitForNewDocument(page, timeOrigin, NAVIGATION_TIMEOUT_MS);
    } else {
      const navigation = await navigateToOwnUrl(page);
      phase = 'after_execute';
      applied = navigation.ok;
      error = error ?? (navigation.ok ? undefined : navigation.error);
    }
    emit(
      firedNote(spec, ordinal, {
        timing: 'during',
        navigationPhase: phase,
        trapEvents: events.length,
        executeStatus: safeToken(outcome?.status),
        executeEffect: safeToken(outcome?.effect),
        applied,
        ...(error === undefined ? {} : { error }),
      })
    );
    if (executeError !== undefined) {
      throw executeError;
    }
    return outcome;
  };

  const runLost = async (request, signal, ordinal) => {
    const startedAt = Date.now();
    let real;
    let realRejected = false;
    try {
      real = await host.execute(request, signal);
    } catch {
      realRejected = true;
    }
    const timedOut = spec.mode === 'timeoutAfterCommit';
    const synthetic = {
      requestId: request.requestId,
      status: 'uncertain',
      effect: 'uncertain',
      code: timedOut ? 'EXECUTION_TIMEOUT' : 'DOCUMENT_LOST',
      message: timedOut
        ? 'fault injection: execution timed out after the command was sent'
        : 'fault injection: response lost after the command was sent',
      durationMs: Date.now() - startedAt,
    };
    emit(
      firedNote(spec, ordinal, {
        operation: safeToken(request?.command?.operation),
        reported: { status: synthetic.status, effect: synthetic.effect, code: synthetic.code },
        realStatus: safeToken(real?.status),
        realEffect: safeToken(real?.effect),
        realCode: safeToken(real?.code),
        realRejected,
      })
    );
    return synthetic;
  };

  const execute = async (request, signal) => {
    state.executions += 1;
    const ordinal = state.executions;
    const selected =
      spec.operation === undefined
        ? ordinal === spec.at
        : ordinal >= spec.at && request?.command?.operation === spec.operation;
    if (!selected || state.executionFired) {
      return host.execute(request, signal);
    }
    state.executionFired = true;
    switch (spec.mode) {
      case 'staleBeforeExecute':
        return runStale(request, signal, ordinal);
      case 'contextDestroyed':
        return spec.timing === 'before'
          ? runContextBefore(request, signal, ordinal)
          : runContextDuring(request, signal, ordinal);
      case 'lostAfterCommit':
      case 'timeoutAfterCommit':
        return runLost(request, signal, ordinal);
      default:
        return host.execute(request, signal);
    }
  };

  const wrapped = {
    capabilities: (...args) => host.capabilities(...args),
    observe,
    execute,
    dispose: (...args) => host.dispose(...args),
  };
  if (typeof host.location === 'function') {
    wrapped.location = (...args) => host.location(...args);
  }
  if (typeof host.release === 'function') {
    wrapped.release = (...args) => host.release(...args);
  }
  return Object.freeze(wrapped);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const isDecider = value =>
  value &&
  typeof value.chooseAction === 'function' &&
  typeof value.chooseArgument === 'function' &&
  typeof value.verifyCompletion === 'function';

const isHost = value =>
  value &&
  typeof value.capabilities === 'function' &&
  typeof value.observe === 'function' &&
  typeof value.execute === 'function' &&
  typeof value.dispose === 'function';

const isPage = value =>
  value &&
  typeof value.evaluate === 'function' &&
  typeof value.goto === 'function' &&
  typeof value.url === 'function' &&
  typeof value.on === 'function' &&
  typeof value.off === 'function';

const PAGE_MODES = new Set(['staleBeforeExecute', 'contextDestroyed']);

function fail(scenario, message) {
  const id = scenario && typeof scenario.id === 'string' ? scenario.id : '(unnamed)';
  return new Error(`faults: scenario ${id}: ${message}`);
}

/**
 * @returns {{ decider: object, host: object, notes: object[], report: () => object }}
 *   `notes` is a live array: configuration notes first, then one note per injection when it fires.
 */
export function applyInjection({ decider, host, page, scenario, recorder } = {}) {
  const noReport = () => ({ configured: [], fired: [], unfired: [], notes: [] });
  if (!scenario || scenario.kind !== 'fault') {
    if (scenario && scenario.inject !== undefined) {
      throw fail(
        scenario,
        `has an inject block but kind is ${String(scenario.kind)}; injection never applies to a live scenario`
      );
    }
    return { decider, host, notes: [], report: noReport };
  }
  const checked = validateInjection(scenario.inject);
  if (!checked.ok) {
    throw fail(scenario, checked.errors.join('; '));
  }
  const deciderSpec = scenario.inject.decider
    ? normalizeDeciderSpec(scenario.inject.decider)
    : null;
  const hostSpec = scenario.inject.host ? normalizeHostSpec(scenario.inject.host) : null;
  if (deciderSpec && !isDecider(decider)) {
    throw fail(
      scenario,
      'inject.decider needs a TaskDecider (chooseAction, chooseArgument, verifyCompletion)'
    );
  }
  if (hostSpec && !isHost(host)) {
    throw fail(scenario, 'inject.host needs a TaskHost (capabilities, observe, execute, dispose)');
  }
  if (hostSpec && PAGE_MODES.has(hostSpec.mode) && !isPage(page)) {
    throw fail(scenario, `host mode ${hostSpec.mode} needs the Playwright page`);
  }

  const { notes, emit } = createNotes({ recorder, scenarioId: scenario.id });
  const specs = [deciderSpec, hostSpec].filter(Boolean);
  for (const spec of specs) {
    emit(configuredNote(spec));
  }
  const wrappedDecider = deciderSpec ? wrapDecider(decider, deciderSpec, emit) : decider;
  const wrappedHost = hostSpec ? wrapHost({ host, spec: hostSpec, page, emit }) : host;

  const report = () => {
    const fired = notes.filter(note => note.event === 'fired');
    const key = spec => `${spec.layer}:${spec.mode}`;
    const firedKeys = new Set(fired.map(note => `${note.layer}:${note.mode}`));
    const describe = spec => ({ layer: spec.layer, mode: spec.mode, [countKey(spec)]: spec.at });
    return jsonCopy({
      configured: specs.map(describe),
      fired: specs.filter(spec => firedKeys.has(key(spec))).map(describe),
      unfired: specs.filter(spec => !firedKeys.has(key(spec))).map(describe),
      notes,
    });
  };

  return { decider: wrappedDecider, host: wrappedHost, notes, report };
}
