/*
 * Typed, deterministic, JSON-safe samples of the TaskAgent contract types, plus counter-based ids and clocks
 * and in-memory fakes of the host, the decider and the action executor.
 *
 * - Everything is DOM-free: tests/helpers-smoke.test.ts scans this file for browser globals.
 * - Samples describe one coherent page. makePageElements() is the page (t1 button, t2 link, t3 text field,
 *   t4 checkbox, t5 select, t6 submit button, t7 passage, t8 password field); the default observation holds
 *   t1 only, and every default command targets the element of this page that offers its operation, with the
 *   scope and signature of the default observation, so a command, a ledger entry and an observation built
 *   with defaults agree with each other.
 * - No key of a sample holds `undefined`: roundTrip(sample) deep-equals sample (contract rule 7).
 * - Overrides are shallow, except `state` (elements), `redaction` (capabilities) and the field maps noted on
 *   each builder. Ids are `<prefix>_<hex>` (contract rule 4).
 * - A checkpoint's `integrity` is a well-formed placeholder, not a valid MAC: tests that exercise
 *   verification must take checkpoints from the agent.
 */
import type {
  ActionCommand,
  ExecutionOptions,
  ExecutionResult,
  TaskActionDecision,
  TaskActionExecutor,
  TaskArgumentDecision,
  TaskBudgetUsage,
  TaskCallContext,
  TaskChooseActionRequest,
  TaskChooseArgumentRequest,
  TaskCheckpoint,
  TaskClassifyCommitmentRequest,
  TaskCommand,
  TaskCommandRequest,
  TaskCommitmentDecision,
  TaskCommonCommand,
  TaskCompletionDecision,
  TaskDecider,
  TaskDeciderError,
  TaskDeciderErrorCode,
  TaskDeciderResult,
  TaskDecisionStage,
  TaskElement,
  TaskElementState,
  TaskElementSummary,
  TaskExchange,
  TaskExecutionEffect,
  TaskExecutionOutcome,
  TaskExecutionStatus,
  TaskForm,
  TaskHost,
  TaskHostCapabilities,
  TaskHostCommand,
  TaskHostError,
  TaskHostResult,
  TaskIdFactory,
  TaskIdPrefix,
  TaskLedgerEntry,
  TaskLocation,
  TaskNormalizedAuthorization,
  TaskObservation,
  TaskObservationSummary,
  TaskObserveRequest,
  TaskOutcomeFields,
  TaskRedactedCommand,
  TaskRequest,
  TaskSessionId,
  TaskSnapshotScope,
  TaskTargetRef,
  TaskVerifyCompletionRequest,
} from '@/types';
import {
  TASK_DEFAULT_SETTLE,
  TASK_DEFAULT_TIMEOUTS,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_LIMITS,
  TASK_TYPESAFE_LIMITS,
  TASK_WAIT_DURATIONS_MS,
} from '@/types';

export const FIXTURE_ORIGIN = 'https://shop.example.test';
export const FIXTURE_URL = `${FIXTURE_ORIGIN}/cart`;
export const FIXTURE_START = 1_700_000_000_000;

export const FIXTURE_IDS = {
  run: 'run_000000000001',
  session: 'ses_000000000001',
  snapshot: 'snap_000000000001',
  document: 'doc_000000000001',
  request: 'req_000000000001',
  checkpoint: 'ck_000000000001',
} as const;

const PASSAGE_TEXT = 'Orders ship in two days.';

// ---------------------------------------------------------------------------------------------
// Ids, clocks, JSON
// ---------------------------------------------------------------------------------------------

/** `<prefix>_<12 hex>`, one counter per prefix starting at 1. */
export function counterIds(): TaskIdFactory {
  const counters = new Map<TaskIdPrefix, number>();
  return prefix => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next.toString(16).padStart(12, '0')}`;
  };
}

/** Returns `start`, then start + 1, start + 2, ... one step per call. */
export function makeClock(start: number = FIXTURE_START): () => number {
  let next = start;
  return () => {
    const current = next;
    next += 1;
    return current;
  };
}

export type ManualClock = {
  readonly now: () => number;
  /** Returns the new time. */
  readonly advance: (ms: number) => number;
  readonly set: (ms: number) => void;
};

/** Stands still until advanced: for wall-time budgets, expiry and TTL tests. */
export function makeManualClock(start: number = FIXTURE_START): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance: ms => {
      current += ms;
      return current;
    },
    set: ms => {
      current = ms;
    },
  };
}

export function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainData(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep copy of plain data (arrays and plain objects, cycles kept as cycles) that keeps `undefined` values and
 * own `__proto__` keys, which a JSON round trip would drop or turn into null. Anything else (functions, class
 * instances) is shared.
 */
function cloneData<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const known = seen.get(value);
  if (known !== undefined) {
    return known as T;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    seen.set(value, items);
    for (const item of value) {
      items.push(cloneData(item, seen));
    }
    return items as T;
  }
  if (!isPlainData(value)) {
    return value;
  }
  const source = value as Readonly<Record<string, unknown>>;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: cloneData(source[key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}

function hexOf(text: string, width: number): string {
  const hex = Array.from(text, char => (char.codePointAt(0) ?? 0).toString(16).padStart(2, '0'));
  return hex.join('').slice(0, width).padEnd(width, '0');
}

const SECOND_FNV_SEED = 0x9747b28c;

/**
 * `sg_<16 hex>` derived from the id; distinct ids get distinct signatures. Ids of up to 8 Latin-1 characters
 * (every `t<n>` of a real page) are spelled out in hex so a signature can be read back; any other id is
 * mixed with two 32-bit FNV hashes, so a long or exotic id never collides with a neighbour.
 */
export function signatureFor(id: string): string {
  const codes = Array.from(id, char => char.codePointAt(0) ?? 0);
  const spelled =
    codes.length > 0 && codes.length <= 8 && codes.every(code => code > 0 && code < 256);
  return `sg_${spelled ? hexOf(id, 16) : fnv1a(id) + fnv1a(id, SECOND_FNV_SEED)}`;
}

function digestFor(text: string): string {
  return `dg_${hexOf(text, 32)}`;
}

function fnv1a(text: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return FIXTURE_ORIGIN;
  }
}

// ---------------------------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------------------------

export type ElementOverrides = Partial<Omit<TaskElement, 'state'>> & {
  readonly state?: Partial<TaskElementState>;
};

const DEFAULT_STATE: TaskElementState = {
  disabled: false,
  readOnly: false,
  required: false,
  invalid: false,
  focused: false,
};

/** A clickable button `t1`. The signature follows the id unless given. `state` is merged. */
export function makeElement(overrides: ElementOverrides = {}): TaskElement {
  const { state, ...rest } = overrides;
  const id = rest.id ?? 't1';
  return {
    id,
    signature: signatureFor(id),
    role: 'button',
    kind: 'button',
    label: 'Continue',
    sensitive: false,
    inViewport: true,
    operations: ['CLICK'],
    ...rest,
    state: { ...DEFAULT_STATE, ...state },
  };
}

function preset(base: ElementOverrides, overrides: ElementOverrides): TaskElement {
  return makeElement({ ...base, ...overrides, state: { ...base.state, ...overrides.state } });
}

/** `t2`. A link offers NAVIGATE, never CLICK. */
export function makeLink(overrides: ElementOverrides = {}): TaskElement {
  return preset(
    {
      id: 't2',
      role: 'link',
      kind: 'link',
      label: 'Help',
      href: `${FIXTURE_ORIGIN}/help`,
      operations: ['NAVIGATE'],
    },
    overrides
  );
}

/** `t3`. */
export function makeTextField(overrides: ElementOverrides = {}): TaskElement {
  return preset(
    {
      id: 't3',
      role: 'textbox',
      kind: 'text_input',
      label: 'Name',
      inputType: 'text',
      operations: ['FILL', 'PRESS'],
      state: { value: '' },
    },
    overrides
  );
}

/** `t4`. */
export function makeCheckbox(overrides: ElementOverrides = {}): TaskElement {
  return preset(
    {
      id: 't4',
      role: 'checkbox',
      kind: 'checkbox',
      label: 'Subscribe',
      operations: ['SET_CHECKED'],
      state: { checked: false },
    },
    overrides
  );
}

/** `t5`, options `t5.1` (selected) and `t5.2`; option ids follow an overridden element id. */
export function makeSelectField(overrides: ElementOverrides = {}): TaskElement {
  const id = overrides.id ?? 't5';
  return preset(
    {
      id,
      role: 'combobox',
      kind: 'select',
      label: 'Country',
      operations: ['SELECT'],
      options: [
        { id: `${id}.1`, label: 'India', value: 'in', selected: true, disabled: false },
        { id: `${id}.2`, label: 'France', value: 'fr', selected: false, disabled: false },
      ],
      state: { value: 'in' },
    },
    overrides
  );
}

/** `t6`. A submit control offers SUBMIT, never CLICK, and carries the structural form hint. */
export function makeSubmitButton(overrides: ElementOverrides = {}): TaskElement {
  return preset(
    {
      id: 't6',
      role: 'button',
      kind: 'button',
      label: 'Submit',
      operations: ['SUBMIT'],
      formId: 'f1',
      formTarget: { action: `${FIXTURE_ORIGIN}/submit`, method: 'POST' },
      commitHints: [{ class: 'FORM_SUBMIT', basis: 'submit_control' }],
    },
    overrides
  );
}

/** `t7`. */
export function makePassage(overrides: ElementOverrides = {}): TaskElement {
  return preset(
    {
      id: 't7',
      role: 'paragraph',
      kind: 'passage',
      label: 'Shipping policy',
      text: PASSAGE_TEXT,
      operations: ['READ'],
    },
    overrides
  );
}

/** `t8`. Structurally sensitive: no READ, no text, never a real value. */
export function makeSensitiveField(overrides: ElementOverrides = {}): TaskElement {
  return preset(
    {
      id: 't8',
      role: 'textbox',
      kind: 'text_input',
      label: 'Password',
      inputType: 'password',
      sensitive: true,
      operations: ['FILL'],
      state: { value: '' },
    },
    overrides
  );
}

/** The sample page: t1 to t8, unique ids and signatures. */
export function makePageElements(): readonly TaskElement[] {
  return [
    makeElement(),
    makeLink(),
    makeTextField(),
    makeCheckbox(),
    makeSelectField(),
    makeSubmitButton(),
    makePassage(),
    makeSensitiveField(),
  ];
}

export function makeForm(overrides: Partial<TaskForm> = {}): TaskForm {
  return {
    id: 'f1',
    method: 'POST',
    action: `${FIXTURE_ORIGIN}/submit`,
    fieldIds: ['t3'],
    submitterIds: ['t6'],
    invalidFieldIds: [],
    implicitSubmit: true,
    ...overrides,
  };
}

export function summarizeElement(element: TaskElement): TaskElementSummary {
  return {
    id: element.id,
    signature: element.signature,
    role: element.role,
    kind: element.kind,
    label: element.label,
    sensitive: element.sensitive,
    ...(element.twins === undefined ? {} : { twins: element.twins }),
    ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
    ...(element.href === undefined ? {} : { href: element.href }),
    ...(element.formId === undefined ? {} : { formId: element.formId }),
  };
}

// ---------------------------------------------------------------------------------------------
// Observation, capabilities
// ---------------------------------------------------------------------------------------------

export function makeScope(overrides: Partial<TaskSnapshotScope> = {}): TaskSnapshotScope {
  return {
    sessionId: FIXTURE_IDS.session,
    snapshotId: FIXTURE_IDS.snapshot,
    documentId: FIXTURE_IDS.document,
    ...overrides,
  };
}

/** Reference to `t1` of the default observation unless overridden. */
export function makeTargetRef(overrides: Partial<TaskTargetRef> = {}): TaskTargetRef {
  return {
    sessionId: FIXTURE_IDS.session,
    snapshotId: FIXTURE_IDS.snapshot,
    targetId: 't1',
    signature: signatureFor('t1'),
    ...overrides,
  };
}

function fingerprintOf(
  content: Pick<TaskObservation, 'url' | 'text' | 'elements' | 'notices'>
): string {
  return fnv1a(
    JSON.stringify([
      content.url,
      content.elements.map(element => [element.signature, element.state]),
      content.notices,
      content.text,
    ])
  );
}

/**
 * One element (`t1`), an idle complete page. The origin follows an overridden url, and the fingerprint
 * follows url, element signatures and states, notices and text unless it is given.
 */
export function makeObservation(overrides: Partial<TaskObservation> = {}): TaskObservation {
  const url = overrides.url ?? FIXTURE_URL;
  const content: Omit<TaskObservation, 'fingerprint'> = {
    ...makeScope(),
    sequence: 1,
    observedAt: FIXTURE_START,
    url,
    origin: originOf(url),
    title: 'Fixture page',
    text: 'Fixture page text',
    page: {
      readyState: 'complete',
      busy: false,
      scroll: { directions: [], top: 0, max: 0 },
      viewport: { width: 1024, height: 768 },
    },
    elements: [makeElement()],
    forms: [],
    notices: [],
    dialogs: [],
    validation: [],
    truncation: { elementsDropped: 0, optionsDropped: 0, textTruncated: false },
    unobserved: {
      iframes: 0,
      shadowRoots: 0,
      canvases: 0,
      contentEditable: 0,
      multiSelects: 0,
      externalTargets: 0,
    },
    ...overrides,
  };
  return { ...content, fingerprint: overrides.fingerprint ?? fingerprintOf(content) };
}

export function summarizeObservation(observation: TaskObservation): TaskObservationSummary {
  return {
    sessionId: observation.sessionId,
    snapshotId: observation.snapshotId,
    documentId: observation.documentId,
    sequence: observation.sequence,
    observedAt: observation.observedAt,
    url: observation.url,
    title: observation.title,
    fingerprint: observation.fingerprint,
    elementCount: observation.elements.length,
  };
}

export type CapabilityOverrides = Partial<Omit<TaskHostCapabilities, 'redaction'>> & {
  readonly redaction?: Partial<TaskHostCapabilities['redaction']>;
};

/** A fully capable custom host. `redaction` is merged; arrays are fresh copies of the constants. */
export function makeCapabilities(overrides: CapabilityOverrides = {}): TaskHostCapabilities {
  const { redaction, ...rest } = overrides;
  return {
    hostKind: 'custom',
    protocol: 'fixture.v1',
    operations: [...TASK_HOST_OPERATIONS],
    persistsAcrossNavigation: true,
    detectsNavigation: true,
    cancellation: 'cooperative',
    strictTargets: true,
    scrollContainers: true,
    implicitSubmitDetection: true,
    authoritativeLocation: true,
    isolatedWorld: false,
    maxElements: TASK_LIMITS.observedElements,
    keys: [...TASK_KEYS],
    waitDurationsMs: [...TASK_WAIT_DURATIONS_MS],
    ...rest,
    redaction: { observations: true, executionEvents: true, ...redaction },
  };
}

// ---------------------------------------------------------------------------------------------
// Commands, requests, outcomes
// ---------------------------------------------------------------------------------------------

type TargetOperation = Exclude<TaskCommand['operation'], 'SCROLL' | 'WAIT'>;

const SAMPLE_TARGET_IDS: Readonly<Record<TargetOperation, string>> = {
  READ: 't7',
  CLICK: 't1',
  NAVIGATE: 't2',
  FILL: 't3',
  PRESS: 't3',
  SET_CHECKED: 't4',
  SELECT: 't5',
  SUBMIT: 't6',
};

function sampleTarget(operation: TargetOperation): TaskTargetRef {
  const targetId = SAMPLE_TARGET_IDS[operation];
  return makeTargetRef({ targetId, signature: signatureFor(targetId) });
}

function defaultCommonCommand(operation: TaskCommonCommand['operation']): TaskCommonCommand {
  switch (operation) {
    case 'READ':
    case 'CLICK':
    case 'NAVIGATE':
    case 'SUBMIT':
      return { operation, target: sampleTarget(operation) };
    case 'SELECT':
      return { operation, target: sampleTarget(operation), optionId: 't5.2' };
    case 'SET_CHECKED':
      return { operation, target: sampleTarget(operation), checked: true };
    case 'PRESS':
      return { operation, target: sampleTarget(operation), key: 'Enter' };
    case 'SCROLL':
      return { operation, direction: 'DOWN' };
    case 'WAIT':
      return { operation, durationMs: 500 };
  }
}

function defaultCommand(operation: TaskCommand['operation']): TaskCommand {
  if (operation === 'FILL') {
    return {
      operation,
      target: sampleTarget(operation),
      value: { source: 'input', path: 'name' },
    };
  }
  return defaultCommonCommand(operation);
}

type CommandOf<O extends TaskCommand['operation']> = TaskCommand & { readonly operation: O };
type HostCommandOf<O extends TaskHostCommand['operation']> = TaskHostCommand & {
  readonly operation: O;
};

/** Reference-form command on the sample page; overrides are typed per operation. */
export function makeCommand<O extends TaskCommand['operation']>(
  operation: O,
  overrides: Partial<CommandOf<O>> = {}
): CommandOf<O> {
  return { ...defaultCommand(operation), ...overrides } as CommandOf<O>;
}

/** Host-form command: only FILL differs from makeCommand (raw value and sensitivity flag). */
export function makeHostCommand<O extends TaskHostCommand['operation']>(
  operation: O,
  overrides: Partial<HostCommandOf<O>> = {}
): HostCommandOf<O> {
  const base: TaskHostCommand =
    operation === 'FILL'
      ? {
          operation,
          target: sampleTarget(operation),
          value: 'Ada Lovelace',
          sensitive: false,
        }
      : defaultCommonCommand(operation as TaskCommonCommand['operation']);
  return { ...base, ...overrides } as HostCommandOf<O>;
}

/** A CLICK on t1 of the default snapshot, with the run's default execution timeout and settle. */
export function makeCommandRequest(
  overrides: Partial<TaskCommandRequest> = {}
): TaskCommandRequest {
  return {
    requestId: FIXTURE_IDS.request,
    scope: makeScope(),
    command: makeHostCommand('CLICK'),
    allowedOrigins: [FIXTURE_ORIGIN],
    timeoutMs: TASK_DEFAULT_TIMEOUTS.executionMs,
    settle: { ...TASK_DEFAULT_SETTLE },
    ...overrides,
  };
}

export function makeRedactedCommand(
  overrides: Partial<TaskRedactedCommand> = {}
): TaskRedactedCommand {
  return {
    command: makeCommand('CLICK'),
    target: summarizeElement(makeElement()),
    ...overrides,
  };
}

type OutcomeOf<S extends TaskExecutionStatus> = TaskExecutionOutcome & { readonly status: S };

const VALID_OUTCOME_PAIRS: Readonly<Record<TaskExecutionStatus, readonly TaskExecutionEffect[]>> = {
  applied: ['applied', 'none'],
  noop_already_satisfied: ['none'],
  rejected_stale: ['none'],
  rejected_invalid: ['none'],
  rejected_scope: ['none'],
  failed: ['none', 'applied'],
  uncertain: ['uncertain'],
  navigated: ['applied', 'uncertain'],
};

/**
 * Only the pairs the contract allows compile (and a JavaScript caller gets an Error). `status` and `effect`
 * cannot be overridden.
 */
export function makeOutcome<S extends TaskExecutionStatus, E extends OutcomeOf<S>['effect']>(
  status: S,
  effect: E,
  overrides: Partial<TaskOutcomeFields> = {}
): TaskExecutionOutcome {
  const allowed: readonly TaskExecutionEffect[] = Object.prototype.hasOwnProperty.call(
    VALID_OUTCOME_PAIRS,
    status
  )
    ? VALID_OUTCOME_PAIRS[status]
    : [];
  if (!allowed.includes(effect)) {
    throw new Error(`invalid outcome pair: ${status} / ${effect}`);
  }
  return {
    requestId: FIXTURE_IDS.request,
    durationMs: 5,
    ...overrides,
    status,
    effect,
  } as TaskExecutionOutcome;
}

export function makeLedgerEntry(overrides: Partial<TaskLedgerEntry> = {}): TaskLedgerEntry {
  return {
    seq: 1,
    step: 1,
    command: makeRedactedCommand(),
    digest: digestFor('CLICK:t1'),
    effects: ['interact'],
    status: 'applied',
    effect: 'applied',
    postconditions: [],
    scope: makeScope(),
    observationSequence: 1,
    observationOrdinal: 1,
    url: FIXTURE_URL,
    startedAt: FIXTURE_START,
    finishedAt: FIXTURE_START + 5,
    navigated: false,
    ...overrides,
  };
}

export function makeExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    status: 'completed',
    timestamp: FIXTURE_START,
    effect: 'applied',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Requests and checkpoints
// ---------------------------------------------------------------------------------------------

export function makeRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return { goal: 'Open the help page', startUrl: FIXTURE_URL, ...overrides };
}

export function makeBudgetUsage(overrides: Partial<TaskBudgetUsage> = {}): TaskBudgetUsage {
  return {
    steps: 0,
    modelCalls: 0,
    staleRetries: 0,
    noProgress: 0,
    uncertainEffects: 0,
    prematureDone: 0,
    invalidDecisions: 0,
    rejectedCommands: 0,
    deciderFailures: 0,
    hostFailures: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

export function makeNormalizedAuthorization(
  overrides: Partial<TaskNormalizedAuthorization> = {}
): TaskNormalizedAuthorization {
  return {
    operations: [...TASK_HOST_OPERATIONS],
    origins: [FIXTURE_ORIGIN],
    grants: [],
    assumeUnclassifiedRoutine: false,
    ...overrides,
  };
}

/** A run paused for input before its first step. See the module note about `integrity`. */
export function makeCheckpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    version: 1,
    id: FIXTURE_IDS.checkpoint,
    runId: FIXTURE_IDS.run,
    sessionId: FIXTURE_IDS.session,
    createdAt: FIXTURE_START,
    request: {
      goal: makeRequest().goal,
      startUrl: FIXTURE_URL,
      inputs: {},
      inputDeclarations: [],
      sensitivePaths: [],
      authorization: makeNormalizedAuthorization(),
      options: {},
    },
    step: 0,
    usage: makeBudgetUsage(),
    ledger: [],
    history: [],
    startOrigin: FIXTURE_ORIGIN,
    locationTrust: 'authoritative',
    consumedApprovalIds: [],
    integrity: `sha256:${hexOf('fixture-checkpoint', 64)}`,
    pending: {
      kind: 'needs_input',
      requirements: [
        {
          id: 'r1',
          kind: 'argument',
          slot: 'value',
          operation: 'FILL',
          description: 'Value for the name field',
          reason: 'no_candidates',
        },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Decider results
// ---------------------------------------------------------------------------------------------

export function makeExchange(
  stage: TaskDecisionStage,
  overrides: Partial<TaskExchange> = {}
): TaskExchange {
  const requestBytes = 1234;
  return {
    stage,
    provider: 'fake',
    attempts: 1,
    attemptLog: [{ attempt: 1, status: 200, latencyMs: 1 }],
    latencyMs: 1,
    requestBytes,
    estimatedInputTokens: Math.ceil(requestBytes / TASK_TYPESAFE_LIMITS.bytesPerToken),
    goalVerified: true,
    ...overrides,
  };
}

export function deciderOk<T>(
  stage: TaskDecisionStage,
  decision: T,
  exchange: Partial<TaskExchange> = {}
): TaskDeciderResult<T> {
  return { ok: true, decision, exchange: makeExchange(stage, exchange) };
}

const RETRYABLE_DECIDER_CODES: readonly TaskDeciderErrorCode[] = [
  'TIMEOUT',
  'NETWORK',
  'HTTP_ERROR',
  'RATE_LIMITED',
];

export function deciderFail(
  code: TaskDeciderErrorCode = 'NETWORK',
  overrides: Partial<TaskDeciderError> = {}
): TaskDeciderResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: `fixture decider failure ${code}`,
      retryable: RETRYABLE_DECIDER_CODES.includes(code),
      ...overrides,
    },
  };
}

/** CLICK on t1 with confidence 0.9 everywhere (confidence = min of the two, as the contract says). */
export function makeActionDecision(
  overrides: Partial<TaskActionDecision> = {}
): TaskActionDecision {
  return {
    operation: 'CLICK',
    target: { kind: 'target', id: 't1' },
    confidence: 0.9,
    operationConfidence: 0.9,
    targetConfidence: 0.9,
    ...overrides,
  };
}

type CandidateDecision = Extract<TaskArgumentDecision, { readonly kind: 'candidate' }>;

export function makeArgumentDecision(
  overrides: Partial<CandidateDecision> = {}
): CandidateDecision {
  return { kind: 'candidate', candidateId: 'c1', confidence: 0.9, ...overrides };
}

export function makeNoArgumentDecision(confidence = 0.9): TaskArgumentDecision {
  return { kind: 'none_appropriate', confidence };
}

export function makeCommitmentDecision(
  overrides: Partial<TaskCommitmentDecision> = {}
): TaskCommitmentDecision {
  return { commitment: 'NONE', confidence: 0.9, agreement: 'single', ...overrides };
}

export function makeCompletionDecision(
  overrides: Partial<TaskCompletionDecision> = {}
): TaskCompletionDecision {
  return { verdict: 'SATISFIED', confidence: 0.95, evidenceTargetIds: ['t1'], ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

export type HostScriptError = { readonly error: TaskHostError };

export type FakeHostOptions = {
  /** Default makeCapabilities(). An `{ error }` makes the capabilities call fail. */
  readonly capabilities?: TaskHostCapabilities | HostScriptError;
  /** Served in order; the last entry repeats. Default: one makeObservation(). */
  readonly observations?: readonly (TaskObservation | HostScriptError)[];
  /** Consumed in order, then the honest default per operation. */
  readonly outcomes?: readonly (
    TaskExecutionOutcome | ((request: TaskCommandRequest) => TaskExecutionOutcome)
  )[];
  /**
   * Default: the url and origin of the observation served last (the first scripted one before any is
   * served), so a navigation script stays coherent. Only present on the host when authoritative.
   */
  readonly location?: TaskLocation | (() => TaskHostResult<TaskLocation>);
  /** Give every served observation the request's session, a fresh snapshot id and a rising sequence. Default true. */
  readonly restamp?: boolean;
  /** Answer with the request's requestId whatever the script says. Default true. */
  readonly stampRequestId?: boolean;
  /** Provide TaskHost.release. Default true. */
  readonly release?: boolean;
  readonly createId?: TaskIdFactory;
};

export type FakeHost = {
  readonly host: TaskHost;
  readonly calls: {
    readonly order: readonly string[];
    readonly capabilities: readonly (AbortSignal | undefined)[];
    readonly location: readonly (AbortSignal | undefined)[];
    readonly observe: readonly TaskObserveRequest[];
    readonly execute: readonly TaskCommandRequest[];
    readonly release: readonly TaskSessionId[];
    readonly dispose: readonly number[];
  };
};

function defaultOutcome(request: TaskCommandRequest): TaskExecutionOutcome {
  const { requestId, command } = request;
  switch (command.operation) {
    case 'READ':
      return makeOutcome('applied', 'none', {
        requestId,
        readback: { kind: 'read', text: PASSAGE_TEXT },
      });
    case 'WAIT':
      return makeOutcome('applied', 'none', {
        requestId,
        readback: { kind: 'wait', waitedMs: command.durationMs },
      });
    default:
      return makeOutcome('applied', 'applied', { requestId });
  }
}

function locationOf(observation: TaskObservation): TaskLocation | undefined {
  return typeof observation.url === 'string' && typeof observation.origin === 'string'
    ? { url: observation.url, origin: observation.origin }
    : undefined;
}

function cancelled(message: string): TaskHostError {
  return { code: 'CANCELLED', message, retryable: false };
}

function malformedObserveRequest(request: TaskObserveRequest): string | undefined {
  if (typeof request !== 'object' || request === null) {
    return 'the request is not an object';
  }
  if (typeof request.sessionId !== 'string' || request.sessionId === '') {
    return 'sessionId must be a non-empty string';
  }
  const { minSequence } = request;
  if (minSequence !== undefined && !(Number.isSafeInteger(minSequence) && minSequence >= 0)) {
    return 'minSequence must be a non-negative safe integer';
  }
  return undefined;
}

/**
 * An in-memory TaskHost for coordinator and bridge tests. It serves scripted observations (restamped like a
 * real host by default), records every call, refuses a malformed observe request, and answers an aborted
 * signal with a cancellation without consuming its script. Everything it serves is a deep copy, as if it had
 * crossed the JSON transport, so a consumer cannot change the script or a later page.
 *
 * Deliberately lenient: `execute` does not check the request's scope, targets or allowedOrigins against the
 * pages served, because a coordinator test scripts the outcome it wants. A test that must prove what the
 * coordinator sent asserts on `calls.execute`.
 */
export function makeFakeHost(options: FakeHostOptions = {}): FakeHost {
  const capabilities = options.capabilities ?? makeCapabilities();
  const observations = options.observations ?? [makeObservation()];
  const outcomes = options.outcomes ?? [];
  const createId = options.createId ?? counterIds();
  const restamp = options.restamp ?? true;
  const stampRequestId = options.stampRequestId ?? true;
  const order: string[] = [];
  const capabilityCalls: Array<AbortSignal | undefined> = [];
  const locationCalls: Array<AbortSignal | undefined> = [];
  const observeCalls: TaskObserveRequest[] = [];
  const executeCalls: TaskCommandRequest[] = [];
  const releaseCalls: TaskSessionId[] = [];
  const disposeCalls: number[] = [];
  let observeIndex = 0;
  let executeIndex = 0;
  let sequence = 0;
  let lastServed: TaskLocation | undefined;

  const first = observations[0];
  const defaultLocation: TaskLocation =
    first !== undefined && !('error' in first)
      ? { url: first.url, origin: first.origin }
      : { url: FIXTURE_URL, origin: FIXTURE_ORIGIN };

  const observe: TaskHost['observe'] = async (request, signal) => {
    order.push('observe');
    observeCalls.push(request);
    if (signal?.aborted === true) {
      return { ok: false, error: cancelled('fake host: observe aborted') };
    }
    const malformed = malformedObserveRequest(request);
    if (malformed !== undefined) {
      return {
        ok: false,
        error: {
          code: 'PROTOCOL_ERROR',
          message: `fake host: malformed observe request: ${malformed}`,
          retryable: false,
        },
      };
    }
    const entry = observations[Math.min(observeIndex, observations.length - 1)];
    observeIndex += 1;
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: 'OBSERVE_FAILED',
          message: 'fake host: no observation scripted',
          retryable: false,
        },
      };
    }
    if ('error' in entry) {
      return { ok: false, error: entry.error };
    }
    const page = cloneData(entry);
    if (restamp) {
      sequence = Math.max(sequence + 1, (request.minSequence ?? 0) + 1);
      const stamped: TaskObservation = {
        ...page,
        sessionId: request.sessionId,
        snapshotId: createId('snap'),
        sequence,
      };
      lastServed = locationOf(stamped) ?? lastServed;
      return { ok: true, value: stamped };
    }
    lastServed = locationOf(page) ?? lastServed;
    return { ok: true, value: page };
  };

  const execute: TaskHost['execute'] = async (request, signal) => {
    order.push('execute');
    executeCalls.push(request);
    if (signal?.aborted === true) {
      return makeOutcome('failed', 'none', {
        requestId: request.requestId,
        code: 'EXECUTION_CANCELLED',
        message: 'fake host: execute aborted',
      });
    }
    const entry = outcomes[executeIndex];
    executeIndex += 1;
    const scripted =
      entry === undefined
        ? defaultOutcome(request)
        : typeof entry === 'function'
          ? entry(request)
          : entry;
    const outcome = cloneData(scripted);
    return stampRequestId ? { ...outcome, requestId: request.requestId } : outcome;
  };

  const locate: NonNullable<TaskHost['location']> = async signal => {
    order.push('location');
    locationCalls.push(signal);
    const configured = options.location ?? lastServed ?? defaultLocation;
    return typeof configured === 'function' ? configured() : { ok: true, value: { ...configured } };
  };

  const host: TaskHost = {
    capabilities: async signal => {
      order.push('capabilities');
      capabilityCalls.push(signal);
      return 'error' in capabilities
        ? { ok: false, error: capabilities.error }
        : { ok: true, value: cloneData(capabilities) };
    },
    ...('error' in capabilities || !capabilities.authoritativeLocation ? {} : { location: locate }),
    observe,
    execute,
    ...(options.release === false
      ? {}
      : {
          release: async (sessionId: TaskSessionId): Promise<void> => {
            order.push('release');
            releaseCalls.push(sessionId);
          },
        }),
    dispose: async () => {
      order.push('dispose');
      disposeCalls.push(order.length);
    },
  };

  return {
    host,
    calls: {
      order,
      capabilities: capabilityCalls,
      location: locationCalls,
      observe: observeCalls,
      execute: executeCalls,
      release: releaseCalls,
      dispose: disposeCalls,
    },
  };
}

export type ScriptedDecision<Request, Decision> =
  | TaskDeciderResult<Decision>
  | ((request: Request, context: TaskCallContext) => TaskDeciderResult<Decision>);

export type FakeDeciderScript = {
  readonly chooseAction?: readonly ScriptedDecision<TaskChooseActionRequest, TaskActionDecision>[];
  readonly chooseArgument?: readonly ScriptedDecision<
    TaskChooseArgumentRequest,
    TaskArgumentDecision
  >[];
  /** Present on the decider only when scripted: its absence has a meaning (fail closed). */
  readonly classifyCommitment?: readonly ScriptedDecision<
    TaskClassifyCommitmentRequest,
    TaskCommitmentDecision
  >[];
  readonly verifyCompletion?: readonly ScriptedDecision<
    TaskVerifyCompletionRequest,
    TaskCompletionDecision
  >[];
};

export type DeciderCall<Request> = {
  readonly request: Request;
  readonly context: TaskCallContext;
};

export type FakeDecider = {
  readonly decider: TaskDecider;
  readonly calls: {
    readonly chooseAction: readonly DeciderCall<TaskChooseActionRequest>[];
    readonly chooseArgument: readonly DeciderCall<TaskChooseArgumentRequest>[];
    readonly classifyCommitment: readonly DeciderCall<TaskClassifyCommitmentRequest>[];
    readonly verifyCompletion: readonly DeciderCall<TaskVerifyCompletionRequest>[];
  };
};

function scriptedStage<Request, Decision>(
  name: string,
  script: readonly ScriptedDecision<Request, Decision>[],
  record: DeciderCall<Request>[]
): (request: Request, context: TaskCallContext) => Promise<TaskDeciderResult<Decision>> {
  let index = 0;
  return async (request, context) => {
    record.push({ request, context });
    const entry = script[index];
    index += 1;
    if (entry === undefined) {
      return deciderFail('UNSUPPORTED', {
        message: `fake decider script exhausted for ${name} (call ${index})`,
      });
    }
    return typeof entry === 'function' ? entry(request, context) : entry;
  };
}

/**
 * A TaskDecider that plays scripted results per stage and records every request and context. A stage whose
 * script ran out answers an UNSUPPORTED error, so an under-scripted test fails visibly instead of inventing
 * a decision.
 */
export function makeFakeDecider(script: FakeDeciderScript = {}): FakeDecider {
  const calls = {
    chooseAction: [] as DeciderCall<TaskChooseActionRequest>[],
    chooseArgument: [] as DeciderCall<TaskChooseArgumentRequest>[],
    classifyCommitment: [] as DeciderCall<TaskClassifyCommitmentRequest>[],
    verifyCompletion: [] as DeciderCall<TaskVerifyCompletionRequest>[],
  };
  const decider: TaskDecider = {
    chooseAction: scriptedStage('chooseAction', script.chooseAction ?? [], calls.chooseAction),
    chooseArgument: scriptedStage(
      'chooseArgument',
      script.chooseArgument ?? [],
      calls.chooseArgument
    ),
    ...(script.classifyCommitment === undefined
      ? {}
      : {
          classifyCommitment: scriptedStage(
            'classifyCommitment',
            script.classifyCommitment,
            calls.classifyCommitment
          ),
        }),
    verifyCompletion: scriptedStage(
      'verifyCompletion',
      script.verifyCompletion ?? [],
      calls.verifyCompletion
    ),
  };
  return { decider, calls };
}

export type ExecutorCall = {
  readonly action: ActionCommand;
  readonly options?: ExecutionOptions;
};

export type FakeExecutor = {
  readonly executor: TaskActionExecutor;
  readonly calls: readonly ExecutorCall[];
};

/** A TaskActionExecutor that records calls and plays scripted results, then succeeds with effect applied. */
export function makeFakeExecutor(
  script: readonly (
    ExecutionResult | ((action: ActionCommand, options?: ExecutionOptions) => ExecutionResult)
  )[] = []
): FakeExecutor {
  const calls: ExecutorCall[] = [];
  let index = 0;
  const executor: TaskActionExecutor = {
    executeAction: async (action, options) => {
      calls.push({ action, options });
      const entry = script[index];
      index += 1;
      if (entry === undefined) {
        return makeExecutionResult();
      }
      return typeof entry === 'function' ? entry(action, options) : entry;
    },
  };
  return { executor, calls };
}
