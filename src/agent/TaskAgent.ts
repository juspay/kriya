import type {
  Redactor,
  TaskAgentConfig,
  TaskAgent,
  TaskCreateAgentFn,
  TaskRequest,
  TaskResumeRequest,
  TaskResult,
  TaskResultBase,
  TaskFailureCode,
  TaskBlockedReason,
  TaskRunOptions,
  TaskBudgets,
  TaskConfidenceFloors,
  TaskDeciderConfidenceProfile,
  TaskBudgetUsage,
  TaskObservation,
  TaskHostCapabilities,
  TaskNormalizedAuthorization,
  TaskInputs,
  TaskInputDeclaration,
  TaskInputLeaf,
  TaskLedgerEntry,
  TaskHistoryEntry,
  TaskExchange,
  TaskEvent,
  TaskEventBody,
  TaskWarning,
  TaskPending,
  TaskCheckpoint,
  TaskPageEvidence,
  TaskSubmittedControl,
  TaskExpectedState,
  TaskGoalRequirement,
  TaskGoalRequirementView,
  TaskOffers,
  TaskRequirement,
  TaskCommand,
  TaskArgumentCandidate,
  TaskArgumentDecision,
  TaskActionDecision,
  TaskArgumentView,
  TaskEffectKind,
  TaskApprovedOnce,
  TaskApprovalRequest,
  TaskDeciderResult,
  TaskDecisionStage,
  TaskCallContext,
  TaskMaterialized,
  TaskResolvedValue,
  TaskExecutionOutcome,
  TaskGateReport,
  TaskIdPrefix,
  TaskOfferExclusion,
  TaskElement,
  TaskVerifierResult,
  TaskCompletionDecision,
  TaskHostOperation,
  TaskPendingCommitment,
  TaskRedactedCommand,
  TaskTargetRef,
} from '@/types';
import {
  TASK_DEFAULT_BUDGETS,
  TASK_DEFAULT_CONFIDENCE,
  TASK_DEFAULT_SETTLE,
  TASK_DEFAULT_TIMEOUTS,
  TASK_DEFAULT_RUN_GRANT_USES,
  TASK_LIMITS,
  TASK_BRIDGE_PROTOCOL,
  TASK_PAGE_TARGET_ID,
  TASK_REDACTED,
  isTaskHostOperation,
  isTaskCommitmentEffect,
  isTaskCommitmentClass,
} from '@/types';
import { derivedId, sha256Hex, hmacSha256Hex, stableStringify } from '@/utils/hash';
import { createRedactor } from '@/utils/redact';
import { sanitizeUntrustedText } from '@/utils/sanitize';
import {
  computeOffers,
  describeArgument,
  compileCommand,
  commandDigest,
  commitContext,
  contextDigest,
  redactCommand,
  toHostCommand,
} from './commands';
import {
  flattenInputs,
  inputRules,
  summarizeInputs,
  buildCandidates,
  candidateViews,
  argumentView,
  argumentAvailable,
  materializeArgument,
  mergeInputs,
  splitSensitiveInputs,
  hasUnsafeKey,
} from './resolver';
import {
  createTaskPolicy,
  normalizeAuthorization,
  addRunGrants,
  consumeGrants,
  mergeEffects,
  effectForCommitment,
  allCommitmentsGranted,
} from './policy';
import {
  normalizeOutcome,
  createLedgerEntry,
  derivePostconditions,
  resolveUncertain,
  pendingCommitments,
  collectEvidence,
  checkPostconditions,
  expectedStates,
  evaluateLocalGate,
  evaluateFullGate,
  completionFromReport,
  needsPersistenceEvidence,
  summarizeObservation,
  historyFromLedger,
  argumentSubmittedControls,
  distinctSubmittedControls,
  executedEffects,
  isObservedHistoryEntry,
} from './verify';
import { goalRequirementKey, goalRequirementHolds } from './requirements';
import { copyConfidenceProfile } from './confidence';
import { createProgressTracker } from './progress';

/** A choice below this confidence did not hold a majority of the model's probability mass. */
const MAJORITY_CONFIDENCE = 0.5;

type MutableUsage = {
  -readonly [K in keyof TaskBudgetUsage]: TaskBudgetUsage[K];
};
type During = 'idle' | 'observation' | 'decision' | 'action';
type Boundary<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly reason: 'cancelled' | 'timeout' | 'error';
      readonly message: string;
    };
type RunState = {
  request: TaskRequest;
  runId: string;
  sessionId: string;
  startedAt: number;
  activeAt: number;
  priorElapsed: number;
  options: TaskRunOptions;
  budgets: TaskBudgets;
  floors: TaskConfidenceFloors;
  usage: MutableUsage;
  inputs: TaskInputs;
  declarations: readonly TaskInputDeclaration[];
  leaves: readonly TaskInputLeaf[];
  sensitivePaths: readonly string[];
  redactor: Redactor;
  ledger: TaskLedgerEntry[];
  history: TaskHistoryEntry[];
  exchanges: TaskExchange[];
  trace: TaskEvent[];
  warnings: TaskWarning[];
  auth?: TaskNormalizedAuthorization;
  caps?: TaskHostCapabilities;
  observation?: TaskObservation;
  initialPage?: TaskPageEvidence;
  submittedControls: TaskSubmittedControl[];
  independentDocumentId?: string;
  goalRequirements: Map<string, TaskGoalRequirement>;
  groupDocuments: Map<string, string>;
  ordinal: number;
  startOrigin: string;
  locationTrust: 'authoritative' | 'page_reported';
  during: During;
  controller: AbortController;
  eventSeq: number;
  exclusions: TaskOfferExclusion[];
  exclusionFingerprint?: string;
  repeats: Set<string>;
  progressFingerprint?: string;
  progressDiagnostics?: ReturnType<typeof createProgressTracker>;
  completionProbe?: string;
  failedCompletionContext?: string;
  blockedCompletionContext?: string;
  validationAssessed: Set<string>;
  viewRestored: Set<string>;
  blockedConfirmed: Set<string>;
  resampled: Set<string>;
  unresolvedRequirements: Map<string, { readonly context: string; readonly ledgerSeq: number }>;
  primarySubmissionSeq: number;
  pendingApproval?: Extract<
    TaskPending,
    {
      readonly kind: 'awaiting_approval';
    }
  >;
  approvalResolution?: Extract<
    TaskResumeRequest['resolution'],
    {
      readonly kind: 'approval';
    }
  >['resolution'];
  consumed: Set<string>;
  resolvedEvents: Set<string>;
  terminal?: TaskResult;
};
const zeroUsage = (): MutableUsage => ({
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
});
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Boundary call failed.';
const originOf = (url: string | undefined): string | undefined => {
  if (typeof url !== 'string') {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};
const jsonData = (value: unknown, seen: Set<object> = new Set(), depth = 0): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || depth > 64 || seen.has(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  seen.add(value);
  const valid = Object.values(value).every(item => jsonData(item, seen, depth + 1));
  seen.delete(value);
  return valid;
};
const descriptionValid = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === 'string' &&
    !/[\r\n]/.test(value) &&
    Array.from(value).length <= TASK_LIMITS.descriptionChars &&
    sanitizeUntrustedText(value) === value);
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validProgressOption = (options: TaskRunOptions | undefined): boolean =>
  options?.captureProgressDiagnostics === undefined ||
  typeof options.captureProgressDiagnostics === 'boolean';
const validOptions = (options: TaskRunOptions | undefined): boolean =>
  options === undefined ||
  (jsonData(options) &&
    !hasUnsafeKey(options) &&
    validProgressOption(options) &&
    Object.values(options.budgets ?? {}).every(finiteNonnegative) &&
    Object.values(options.confidence ?? {}).every(
      value => finiteNonnegative(value) && value <= 1
    ) &&
    [
      options.executionTimeoutMs,
      options.observeTimeoutMs,
      options.approvalTtlMs,
      options.minEvidence,
    ].every(value => value === undefined || finiteNonnegative(value)) &&
    (!options.settle || Object.values(options.settle).every(finiteNonnegative)));
const normalizeOptions = (
  request: TaskRequest,
  configured?: TaskRunOptions,
  confidenceProfile?: TaskDeciderConfidenceProfile
): TaskRunOptions => {
  const options = { ...configured, ...request.options };
  return {
    ...options,
    budgets: {
      ...TASK_DEFAULT_BUDGETS,
      ...request.profile?.budgets,
      ...configured?.budgets,
      ...request.options?.budgets,
    },
    confidence: {
      ...TASK_DEFAULT_CONFIDENCE,
      ...confidenceProfile?.floors,
      ...request.profile?.confidence,
      ...configured?.confidence,
      ...request.options?.confidence,
    },
    minEvidence: options.minEvidence ?? request.profile?.minEvidence ?? 1,
    settle: options.settle ?? TASK_DEFAULT_SETTLE,
    executionTimeoutMs: options.executionTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.executionMs,
    observeTimeoutMs: options.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs,
    approvalTtlMs: options.approvalTtlMs ?? TASK_DEFAULT_TIMEOUTS.approvalTtlMs,
  };
};
const tightenOptions = (base: TaskRunOptions, patch: TaskRunOptions = {}): TaskRunOptions => {
  const budgets = { ...TASK_DEFAULT_BUDGETS, ...base.budgets };
  const confidence = { ...TASK_DEFAULT_CONFIDENCE, ...base.confidence };
  for (const key of Object.keys(budgets) as (keyof TaskBudgets)[]) {
    budgets[key] = Math.min(budgets[key], patch.budgets?.[key] ?? budgets[key]);
  }
  for (const key of Object.keys(confidence) as (keyof TaskConfidenceFloors)[]) {
    confidence[key] = Math.max(confidence[key], patch.confidence?.[key] ?? confidence[key]);
  }
  return {
    ...base,
    ...patch,
    budgets,
    confidence,
    minEvidence: Math.max(base.minEvidence ?? 1, patch.minEvidence ?? base.minEvidence ?? 1),
    allowUncertainCompletion:
      base.allowUncertainCompletion === true && (patch.allowUncertainCompletion ?? true),
    allowUnverifiedLocation:
      base.allowUnverifiedLocation === true && (patch.allowUnverifiedLocation ?? true),
    allowRunLoss: base.allowRunLoss === true && (patch.allowRunLoss ?? true),
    requireGroundedCompletion:
      base.requireGroundedCompletion === true || patch.requireGroundedCompletion === true,
    executionTimeoutMs: Math.min(
      base.executionTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.executionMs,
      patch.executionTimeoutMs ?? Infinity
    ),
    observeTimeoutMs: Math.min(
      base.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs,
      patch.observeTimeoutMs ?? Infinity
    ),
    approvalTtlMs: Math.min(
      base.approvalTtlMs ?? TASK_DEFAULT_TIMEOUTS.approvalTtlMs,
      patch.approvalTtlMs ?? Infinity
    ),
    includePageText: base.includePageText !== false && patch.includePageText !== false,
    inputPreviews: base.inputPreviews !== false && patch.inputPreviews !== false,
  };
};
const scrubObservation = (
  observation: TaskObservation,
  redactor: Redactor,
  includeText: boolean
): TaskObservation => {
  const clean = (text: string, limit: number = TASK_LIMITS.labelChars): string =>
    sanitizeUntrustedText(redactor.scrub(text), limit);
  return {
    ...observation,
    url: redactor.redactUrl(observation.url),
    title: clean(observation.title),
    text: includeText ? clean(observation.text, TASK_LIMITS.observedTextChars) : '',
    elements: observation.elements.map(element => ({
      ...element,
      label: clean(element.label),
      ...(element.description === undefined ? {} : { description: clean(element.description) }),
      ...(element.inputName === undefined ? {} : { inputName: clean(element.inputName) }),
      ...(element.contexts === undefined
        ? {}
        : { contexts: element.contexts.map(context => clean(context)) }),
      ...(element.autocomplete === undefined ? {} : { autocomplete: clean(element.autocomplete) }),
      ...(element.text === undefined
        ? {}
        : {
            text: element.sensitive ? undefined : clean(element.text, TASK_LIMITS.passageChars),
          }),
      ...(element.region === undefined ? {} : { region: clean(element.region) }),
      ...(element.href === undefined ? {} : { href: redactor.redactUrl(element.href) }),
      ...(element.formTarget === undefined
        ? {}
        : {
            formTarget: {
              ...element.formTarget,
              action: redactor.redactUrl(element.formTarget.action),
            },
          }),
      state: {
        ...element.state,
        ...(element.state.value === undefined
          ? {}
          : {
              value:
                element.sensitive && element.state.value !== ''
                  ? redactor.replacement
                  : redactor.scrubDeep(element.state.value),
            }),
      },
      ...(element.options === undefined
        ? {}
        : {
            options: element.options.map(option => ({
              ...option,
              label: clean(option.label),
              ...(option.value === undefined ? {} : { value: redactor.scrubDeep(option.value) }),
            })),
          }),
      operations: element.sensitive
        ? element.operations.filter(operation => operation !== 'READ')
        : element.operations,
    })),
    forms: observation.forms.map(form => ({
      ...form,
      ...(form.name === undefined ? {} : { name: clean(form.name) }),
      ...(form.action === undefined ? {} : { action: redactor.redactUrl(form.action) }),
    })),
    notices: observation.notices.map(notice => ({
      ...notice,
      text: clean(notice.text, TASK_LIMITS.passageChars),
    })),
    dialogs: observation.dialogs.map(dialog => ({ ...dialog, label: clean(dialog.label) })),
    validation: observation.validation.map(message => ({
      ...message,
      text: clean(message.text, TASK_LIMITS.passageChars),
    })),
  };
};
const PRIOR_CONTINUATION_MARKER = 'Coordinator prior effects require the issuing agent instance.';
const STRUCTURAL_STRING_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'kind',
  'status',
  'outcome',
  'effect',
  'lastEffect',
  'effects',
  'operation',
  'operations',
  'direction',
  'directions',
  'keys',
  'slots',
  'inputTypes',
  'elementKinds',
  'source',
  'sources',
  'slot',
  'class',
  'method',
  'key',
  'token',
  'role',
  'inputType',
  'independentDocumentId',
  'controlId',
  'representation',
  'tag',
  'control',
  'stage',
  'agreement',
  'verdict',
  'code',
  'errorCode',
  'staleReason',
  'during',
  'by',
  'retiredBy',
  'basis',
  'mode',
  'phase',
  'skipped',
  'defaultAction',
  'protocol',
  'hostKind',
  'trust',
  'locationTrust',
  'choice',
  'path',
  'sensitivePaths',
  'provider',
  'model',
  'requestedModel',
  'signatures',
  'failures',
]);
const isReferenceField = (key: string): boolean =>
  ['id', 'signature', 'fingerprint', 'digest', 'nonce', 'integrity'].includes(key) ||
  key.endsWith('Id') ||
  key.endsWith('Ids') ||
  key.endsWith('Digest');
const isStructuredReason = (parent: Readonly<Record<string, unknown>> | undefined): boolean =>
  parent !== undefined &&
  (parent.status === 'blocked' ||
    parent.kind === 'scroll' ||
    parent.kind === 'argument' ||
    parent.kind === 'sensitive_input' ||
    parent.verdict === 'allow' ||
    parent.verdict === 'deny' ||
    parent.verdict === 'require_approval' ||
    ('contextDigest' in parent && 'expiresAt' in parent));

// Typed records and caller data have different string semantics. In particular a caller's `status`
// field is data, while a ledger's status is a discriminator that must remain executable on resume.
const safeUrls = <T>(value: T, redactor: Redactor, mode: 'typed' | 'data' = 'typed'): T => {
  const ancestors = new Set<object>();
  const visit = (
    item: unknown,
    key = '',
    data = mode === 'data',
    parent?: Readonly<Record<string, unknown>>
  ): unknown => {
    if (typeof item === 'string') {
      if (
        !data &&
        (key === 'goal' ||
          key === 'task' ||
          isReferenceField(key) ||
          STRUCTURAL_STRING_FIELDS.has(key) ||
          (key === 'reason' && isStructuredReason(parent)) ||
          (key === 'detail' && item === PRIOR_CONTINUATION_MARKER) ||
          (key === 'text' &&
            parent !== undefined &&
            (parent.source === 'goal_literal' || parent.source === 'goal_span') &&
            typeof parent.start === 'number' &&
            typeof parent.end === 'number') ||
          (key === 'value' &&
            parent !== undefined &&
            typeof parent.confidence === 'number' &&
            (item === 'YES' || item === 'NO')))
      ) {
        return item;
      }
      return /(?:url|href)$/i.test(key) || key === 'action' || key === 'origin' || key === 'origins'
        ? redactor.redactUrl(item)
        : redactor.scrub(item);
    }
    if (item === null || typeof item !== 'object') {
      return item;
    }
    if (ancestors.has(item)) {
      return '[Circular]';
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return item.map(child => visit(child, key, data, parent));
      }
      const record = item as Readonly<Record<string, unknown>>;
      return Object.fromEntries(
        Object.entries(record).map(([name, child]) => [
          name,
          visit(
            child,
            name,
            data ||
              (name === 'inputs' &&
                child !== null &&
                typeof child === 'object' &&
                !Array.isArray(child)),
            record
          ),
        ])
      );
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value) as T;
};
const hasCommitment = (effects: readonly TaskEffectKind[]): boolean =>
  effects.some(isTaskCommitmentEffect);
class CoordinatorRuntime {
  private readonly _confidenceProfile: TaskDeciderConfidenceProfile | undefined;
  private readonly _confidenceProfileInvalid: boolean;
  constructor(private readonly _config: TaskAgentConfig) {
    let profile: TaskDeciderConfidenceProfile | undefined;
    let invalid = false;
    try {
      const marker = Object.getOwnPropertyDescriptor(_config.decider, 'initializationError');
      invalid =
        marker === undefined
          ? 'initializationError' in _config.decider
          : !('value' in marker) || marker.value !== undefined;
      const descriptor = Object.getOwnPropertyDescriptor(_config.decider, 'confidenceProfile');
      if (descriptor === undefined) {
        invalid ||= 'confidenceProfile' in _config.decider;
      } else if (!('value' in descriptor)) {
        invalid = true;
      } else if (descriptor.value !== undefined) {
        profile = copyConfidenceProfile(descriptor.value as unknown);
        invalid ||= profile === undefined;
      }
    } catch {
      invalid = true;
    }
    this._confidenceProfile = profile;
    this._confidenceProfileInvalid = invalid;
  }
  private readonly _clock = (): number => {
    try {
      const now = (this._config.options?.clock ?? Date.now)();
      return finiteNonnegative(now) ? now : Date.now();
    } catch {
      return Date.now();
    }
  };
  private _idCounter = 0;
  private readonly _createId = (prefix: TaskIdPrefix): string => {
    try {
      const configured = this._config.options?.createId?.(prefix);
      if (typeof configured === 'string' && configured.length > 0) {
        return configured;
      }
      const bytes = new Uint8Array(16);
      if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
        return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      }
    } catch {
      /* A caller seam must not reject run/resume. */
    }
    this._idCounter += 1;
    return derivedId(prefix, `${this._clock()}|${this._idCounter}|${Math.random()}`);
  };
  private _active: RunState | undefined;
  private readonly _registry = new Map<string, string>();
  private readonly _checkpointPriorEffects = new Map<string, TaskRequest['priorEffects']>();
  private readonly _consumedApprovals = new Set<string>();
  private readonly _defaultPolicy = createTaskPolicy();
  private readonly _policy = this._config.policy ?? this._defaultPolicy;
  private readonly _emit = (state: RunState, body: TaskEventBody): void => {
    state.eventSeq += 1;
    const cleanBody =
      body.type === 'run_started'
        ? { ...body, goal: state.request.goal }
        : safeUrls(body, state.redactor);
    const event: TaskEvent = {
      ...cleanBody,
      seq: state.eventSeq,
      at: this._clock(),
      runId: state.runId,
      step: state.usage.steps,
    };
    if (state.options.captureTrace) {
      state.trace.push(event);
    }
    try {
      this._config.options?.onEvent?.(event);
    } catch {
      /* Observers cannot change execution. */
    }
  };
  private readonly _elapsed = (state: RunState): number =>
    state.priorElapsed + Math.max(0, this._clock() - state.activeAt);
  private readonly _resolutions = (state: RunState) =>
    state.observation
      ? resolveUncertain(state.ledger, state.observation).filter(
          resolution =>
            resolution.by === 'caller' ||
            state.ledger.some(
              entry => entry.seq === resolution.seq && entry.observationOrdinal < state.ordinal
            )
        )
      : state.ledger.flatMap(entry => (entry.resolution ? [entry.resolution] : []));
  private readonly _unresolved = (state: RunState): readonly number[] => {
    const resolved = new Set(this._resolutions(state).map(resolution => resolution.seq));
    return state.ledger
      .filter(entry => entry.effect === 'uncertain' && !resolved.has(entry.seq))
      .map(entry => entry.seq);
  };
  private readonly _updateResolutions = (state: RunState): void => {
    for (const resolution of this._resolutions(state)) {
      const key = stableStringify(resolution);
      if (!state.resolvedEvents.has(key)) {
        state.resolvedEvents.add(key);
        this._emit(state, { type: 'effect_resolved', ...resolution });
      }
    }
    const pending = new Set(this._unresolved(state));
    state.usage.uncertainEffects = state.ledger.filter(
      entry =>
        pending.has(entry.seq) && !hasCommitment(entry.effects) && entry.status !== 'navigated'
    ).length;
  };
  private readonly _base = (state: RunState): TaskResultBase => {
    state.usage.elapsedMs = this._elapsed(state);
    const count = (status: TaskExecutionOutcome['status']): number =>
      state.ledger.filter(entry => entry.status === status).length;
    return {
      runId: state.runId,
      sessionId: state.sessionId,
      goal: state.request.goal,
      steps: state.usage.steps,
      stats: {
        usage: { ...state.usage },
        modelLatencyMs: state.exchanges.reduce((sum, exchange) => sum + exchange.latencyMs, 0),
        actions: {
          applied: count('applied'),
          noop: count('noop_already_satisfied'),
          rejected: state.ledger.filter(entry => entry.status.startsWith('rejected_')).length,
          failed: count('failed'),
          uncertain: count('uncertain'),
          navigated: count('navigated'),
        },
      },
      ledger: safeUrls(state.ledger, state.redactor),
      exchanges: safeUrls(state.exchanges, state.redactor),
      warnings: safeUrls(state.warnings, state.redactor),
      ...(state.progressDiagnostics
        ? { progressDiagnostics: state.progressDiagnostics.snapshot() }
        : {}),
      ...(this._confidenceProfile
        ? {
            confidenceProfile: {
              kind: this._confidenceProfile.kind,
              calibrated: this._confidenceProfile.calibrated,
              floors: { ...state.floors },
            },
          }
        : {}),
      startedAt: state.startedAt,
      finishedAt: this._clock(),
      ...(state.observation ? { finalObservation: summarizeObservation(state.observation) } : {}),
      lastEffect: state.ledger[state.ledger.length - 1]?.effect ?? 'none',
      unresolvedUncertain: this._unresolved(state),
      ...(state.options.captureTrace ? { trace: [...state.trace] } : {}),
    };
  };
  private readonly _sign = (checkpoint: Omit<TaskCheckpoint, 'integrity'>): string => {
    const text = stableStringify(checkpoint);
    return this._config.options?.checkpointKey === undefined
      ? `sha256:${sha256Hex(text)}`
      : `hmac_sha256:${hmacSha256Hex(this._config.options.checkpointKey, text)}`;
  };
  private readonly _checkpoint = (state: RunState, pending: TaskPending): TaskCheckpoint => {
    const split = splitSensitiveInputs(state.inputs, state.leaves);
    const draft: Omit<TaskCheckpoint, 'integrity'> = {
      version: 1,
      id: this._createId('ck'),
      runId: state.runId,
      sessionId: state.sessionId,
      createdAt: this._clock(),
      request: {
        goal: state.request.goal,
        ...(state.request.startUrl
          ? { startUrl: state.redactor.redactUrl(state.request.startUrl) }
          : {}),
        inputs: safeUrls(split.inputs, state.redactor, 'data'),
        inputDeclarations: safeUrls(state.declarations, state.redactor),
        sensitivePaths: [...new Set([...split.paths, ...state.sensitivePaths])],
        authorization:
          state.auth ??
          normalizeAuthorization(undefined, state.startOrigin, state.caps ?? fallbackCapabilities),
        ...(state.request.expect ? { expect: state.request.expect } : {}),
        ...(state.request.profile ? { profile: state.request.profile } : {}),
        options: state.options,
      },
      step: state.usage.steps,
      usage: { ...state.usage, elapsedMs: this._elapsed(state) },
      ledger: safeUrls(state.ledger, state.redactor),
      history: safeUrls(
        [
          ...state.history,
          ...(state.request.priorEffects?.length
            ? [
                {
                  step: 0,
                  kind: state.request.priorEffects.some(entry => entry.resolution === 'unknown')
                    ? ('uncertain' as const)
                    : ('action' as const),
                  detail: PRIOR_CONTINUATION_MARKER,
                },
              ]
            : []),
        ],
        state.redactor
      ),
      startOrigin: state.startOrigin,
      locationTrust: state.locationTrust,
      consumedApprovalIds: [...state.consumed],
      ...(state.observation ? { lastObservation: summarizeObservation(state.observation) } : {}),
      pending: safeUrls(pending, state.redactor),
      ...(state.initialPage ? { initialPage: safeUrls(state.initialPage, state.redactor) } : {}),
      ...(state.independentDocumentId
        ? { independentDocumentId: state.independentDocumentId }
        : {}),
      goalRequirements: safeUrls([...state.goalRequirements.values()], state.redactor),
      submittedControls: safeUrls(state.submittedControls, state.redactor),
      primarySubmissionSeq: state.primarySubmissionSeq,
    };
    const integrity = this._sign(draft);
    this._registry.set(draft.id, integrity);
    this._checkpointPriorEffects.set(
      draft.id,
      state.request.priorEffects?.map(entry => ({ ...entry, effects: [...entry.effects] }))
    );
    while (this._registry.size > TASK_LIMITS.checkpointRegistry) {
      const oldest = this._registry.keys().next().value;
      if (oldest !== undefined) {
        this._registry.delete(oldest);
        this._checkpointPriorEffects.delete(oldest);
      }
    }
    return { ...draft, integrity };
  };
  private readonly _uncertainCheckpoint = (
    state: RunState
  ): {
    readonly checkpoint?: TaskCheckpoint;
  } => {
    const entries = this._unresolved(state);
    return entries.length
      ? { checkpoint: this._checkpoint(state, { kind: 'uncertain_effect', entries }) }
      : {};
  };
  private readonly _fail = (
    state: RunState,
    code: TaskFailureCode,
    message: string
  ): TaskResult => ({
    ...this._base(state),
    status: 'failed',
    error: { code, message: state.redactor.scrub(message), retryable: false },
    ...this._uncertainCheckpoint(state),
  });
  private readonly _block = (
    state: RunState,
    reason: TaskBlockedReason,
    message: string,
    budget?: keyof TaskBudgets
  ): TaskResult => ({
    ...this._base(state),
    status: 'blocked',
    reason,
    message: state.redactor.scrub(message),
    ...(budget ? { budget } : {}),
    ...this._uncertainCheckpoint(state),
  });
  private readonly _cancelled = (state: RunState): TaskResult => ({
    ...this._base(state),
    status: 'cancelled',
    during: state.during,
    ...this._uncertainCheckpoint(state),
  });
  private readonly _needsInput = (
    state: RunState,
    requirements: readonly TaskRequirement[]
  ): TaskResult => {
    const clean = safeUrls(requirements, state.redactor);
    return {
      ...this._base(state),
      status: 'needs_input',
      requirements: clean,
      checkpoint: this._checkpoint(state, { kind: 'needs_input', requirements: clean }),
    };
  };
  private readonly _budgetExceeded = (
    state: RunState,
    budget: keyof TaskBudgets,
    used: number
  ): TaskResult => {
    this._emit(state, { type: 'budget', budget, used, limit: state.budgets[budget] });
    return this._block(state, 'BUDGET_EXHAUSTED', `The ${budget} budget is exhausted.`, budget);
  };
  private readonly _wallOrCancel = (state: RunState): TaskResult | undefined =>
    state.controller.signal.aborted
      ? this._cancelled(state)
      : this._elapsed(state) > state.budgets.maxWallTimeMs
        ? this._budgetExceeded(state, 'maxWallTimeMs', this._elapsed(state))
        : undefined;
  private readonly _occurrence = (
    state: RunState,
    counter: keyof MutableUsage,
    limit: keyof TaskBudgets,
    reason: TaskBlockedReason,
    message: string
  ): TaskResult | undefined => {
    state.usage[counter] += 1;
    return state.usage[counter] > state.budgets[limit]
      ? this._block(state, reason, message)
      : undefined;
  };
  private readonly _boundary = async <T>(
    state: RunState,
    call: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    waitForCancellation = false
  ): Promise<Boundary<T>> => {
    const controller = new AbortController();
    const parent = state.controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    const stop = new Promise<Boundary<T>>(resolve => {
      listener = () => {
        controller.abort(parent.reason);
        if (!waitForCancellation) {
          resolve({ ok: false, reason: 'cancelled', message: 'Run cancelled.' });
        }
      };
      parent.addEventListener('abort', listener, { once: true });
      if (parent.aborted) {
        listener();
      }
      timer = setTimeout(
        () => {
          controller.abort('Task boundary timed out.');
          resolve({ ok: false, reason: 'timeout', message: 'Boundary call timed out.' });
        },
        Math.max(0, timeoutMs)
      );
    });
    const work = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted && !waitForCancellation) {
          return { ok: false, reason: 'cancelled', message: 'Run cancelled.' } as Boundary<T>;
        }
        return call(controller.signal).then(value => ({ ok: true, value }) as Boundary<T>);
      })
      .catch((error: unknown): Boundary<T> => ({
        ok: false,
        reason: 'error',
        message: state.redactor.scrub(errorText(error)),
      }));
    try {
      return await Promise.race([work, stop]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (listener) {
        parent.removeEventListener('abort', listener);
      }
    }
  };
  private readonly _deciderCall = async <T>(
    state: RunState,
    stage: TaskDecisionStage,
    call: (context: TaskCallContext) => Promise<TaskDeciderResult<T>>,
    retryCommitment = false
  ): Promise<TaskDeciderResult<T> | undefined> => {
    const stopped = this._wallOrCancel(state);
    if (stopped) {
      state.terminal = stopped;
      return undefined;
    }
    if (state.usage.modelCalls >= state.budgets.maxModelCalls) {
      state.terminal = this._budgetExceeded(state, 'maxModelCalls', state.usage.modelCalls);
      return undefined;
    }
    state.usage.modelCalls += 1;
    state.during = 'decision';
    this._emit(state, { type: 'deciding', stage });
    const result = await this._boundary(
      state,
      signal =>
        call({
          signal,
          goal: state.request.goal,
          step: state.usage.steps,
          runId: state.runId,
          callIndex: state.usage.modelCalls,
        }),
      state.options.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs
    );
    const value: TaskDeciderResult<T> = result.ok
      ? result.value
      : {
          ok: false,
          error: {
            code:
              result.reason === 'cancelled'
                ? 'CANCELLED'
                : result.reason === 'timeout'
                  ? 'TIMEOUT'
                  : 'NETWORK',
            message: result.message,
            retryable: true,
          },
        };
    if (value.exchange) {
      const { request: requestBody, ...summary } = value.exchange;
      const exchange = safeUrls(
        {
          ...summary,
          ...(state.options.captureExchanges && requestBody ? { request: requestBody } : {}),
        },
        state.redactor
      );
      state.exchanges.push(exchange);
      this._emit(state, { type: 'exchange', exchange });
    }
    if (state.controller.signal.aborted || (!value.ok && value.error.code === 'CANCELLED')) {
      state.terminal = this._cancelled(state);
      return undefined;
    }
    if (!value.ok) {
      state.usage.deciderFailures += 1;
      if (state.usage.deciderFailures > state.budgets.maxDeciderFailures) {
        state.terminal = this._fail(state, 'DECIDER_FAILED', value.error.message);
      }
      const error = value.error;
      const transientStatus =
        error.status === undefined
          ? error.code !== 'HTTP_ERROR'
          : error.status === 408 ||
            error.status === 429 ||
            (error.status >= 500 && error.status < 600);
      if (
        retryCommitment &&
        stage === 'commitment' &&
        !state.terminal &&
        error.retryable &&
        transientStatus &&
        (error.code === 'TIMEOUT' ||
          error.code === 'NETWORK' ||
          error.code === 'RATE_LIMITED' ||
          error.code === 'HTTP_ERROR')
      ) {
        return this._deciderCall(state, stage, call);
      }
    } else {
      state.usage.deciderFailures = 0;
    }
    return value;
  };
  private readonly _checkCapabilities = (
    state: RunState,
    caps: TaskHostCapabilities
  ): TaskResult | undefined => {
    const sensitive = state.leaves.some(leaf => leaf.sensitive);
    if (
      !caps.strictTargets ||
      !caps.redaction.observations ||
      (caps.hostKind !== 'custom' && caps.protocol !== TASK_BRIDGE_PROTOCOL) ||
      (sensitive &&
        (!caps.redaction.executionEvents ||
          (!caps.authoritativeLocation && !state.options.allowUnverifiedLocation))) ||
      (caps.authoritativeLocation && !this._config.host.location)
    ) {
      return this._fail(state, 'HOST_INCAPABLE', 'The host lacks required safety capabilities.');
    }
    return undefined;
  };
  private readonly _readCapabilities = async (state: RunState): Promise<boolean> => {
    const result = await this._boundary(
      state,
      signal => this._config.host.capabilities(signal),
      state.options.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs
    );
    if (!result.ok || !result.value.ok) {
      state.terminal = state.controller.signal.aborted
        ? this._cancelled(state)
        : this._fail(
            state,
            'HOST_FAILED',
            result.ok && !result.value.ok
              ? result.value.error.message
              : !result.ok
                ? result.message
                : 'Capabilities unavailable.'
          );
      return false;
    }
    state.caps = result.value.value;
    state.terminal = this._checkCapabilities(state, state.caps);
    return !state.terminal;
  };
  private readonly _location = async (state: RunState): Promise<string | undefined> => {
    if (!state.caps?.authoritativeLocation || !this._config.host.location) {
      return undefined;
    }
    const result = await this._boundary(
      state,
      signal =>
        this._config.host.location
          ? this._config.host.location(signal)
          : Promise.resolve({
              ok: false as const,
              error: {
                code: 'HOST_INCAPABLE' as const,
                message: 'Location unavailable.',
                retryable: false,
              },
            }),
      state.options.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs
    );
    if (!result.ok || !result.value.ok) {
      state.terminal = state.controller.signal.aborted
        ? this._cancelled(state)
        : this._fail(state, 'HOST_FAILED', 'Authoritative location is unavailable.');
      return undefined;
    }
    return result.value.value.origin;
  };
  private readonly _observe = async (
    state: RunState,
    freshState = false
  ): Promise<TaskObservation | undefined> => {
    state.during = 'observation';
    const caps = state.caps;
    const result = await this._boundary(
      state,
      signal =>
        this._config.host.observe(
          {
            sessionId: state.sessionId,
            minSequence: state.observation?.sequence ?? 0,
            ...(freshState && state.observation
              ? {
                  freshState: {
                    scope: {
                      sessionId: state.sessionId,
                      snapshotId: state.observation.snapshotId,
                      documentId: state.observation.documentId,
                    },
                    allowedOrigins: state.auth?.origins ?? [],
                  },
                }
              : {}),
            options: {
              settle: state.options.settle,
              includeText: state.options.includePageText !== false,
              maxElements: Math.min(
                caps?.maxElements ?? TASK_LIMITS.observedElements,
                TASK_LIMITS.observedElements
              ),
            },
          },
          signal
        ),
      state.options.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs
    );
    if (state.controller.signal.aborted) {
      state.terminal = this._cancelled(state);
      return undefined;
    }
    if (!result.ok || !result.value.ok) {
      state.usage.hostFailures += 1;
      if (state.usage.hostFailures > state.budgets.maxHostFailures) {
        state.terminal = this._fail(
          state,
          'HOST_FAILED',
          result.ok && !result.value.ok
            ? result.value.error.message
            : !result.ok
              ? result.message
              : 'Observation unavailable.'
        );
      }
      return undefined;
    }
    const observation = scrubObservation(
      result.value.value,
      state.redactor,
      state.options.includePageText !== false
    );
    const previous = state.observation;
    state.observation = observation;
    state.initialPage ??= {
      url: observation.url,
      title: observation.title,
      text: observation.text,
      controls: observation.elements
        .filter(
          element =>
            element.operations.includes('FILL') ||
            element.operations.includes('SET_CHECKED') ||
            element.operations.includes('SELECT') ||
            element.state.pressed !== undefined
        )
        .slice(0, 40)
        .map(element => ({
          kind: element.kind,
          label: element.label,
          ...(element.region !== undefined ? { region: element.region } : {}),
          ...(element.landmark !== undefined ? { landmark: element.landmark } : {}),
          ...(element.contexts !== undefined ? { contexts: element.contexts } : {}),
          ...(element.sensitive
            ? {}
            : {
                ...(element.state.value !== undefined ? { value: element.state.value } : {}),
                ...(element.state.checked !== undefined ? { checked: element.state.checked } : {}),
                ...(element.state.pressed !== undefined ? { pressed: element.state.pressed } : {}),
              }),
        })),
    };
    if (freshState && previous && previous.documentId !== observation.documentId) {
      state.independentDocumentId = observation.documentId;
      state.history.push({
        step: state.usage.steps,
        kind: 'observation',
        pageChanged: true,
        detail:
          'An independent read loaded a new view. Earlier view-only actions may be needed again.',
      });
    }
    state.ordinal += 1;
    state.usage.hostFailures = 0;
    if (
      previous &&
      previous.documentId !== observation.documentId &&
      !(await this._readCapabilities(state))
    ) {
      return undefined;
    }
    const currentOrigin = await this._location(state);
    if (state.terminal) {
      return undefined;
    }
    if (currentOrigin !== undefined) {
      this._emit(state, {
        type: 'location',
        trust: 'authoritative',
        origin: currentOrigin,
        matched: currentOrigin === observation.origin,
      });
      if (currentOrigin !== observation.origin) {
        state.terminal = this._block(
          state,
          'ORIGIN_UNVERIFIED',
          'The reported page origin differs from the authoritative location.'
        );
        return undefined;
      }
    }
    if (!state.auth) {
      state.startOrigin = originOf(state.request.startUrl) ?? currentOrigin ?? observation.origin;
      state.locationTrust = currentOrigin === undefined ? 'page_reported' : 'authoritative';
      state.auth = normalizeAuthorization(
        state.request.authorization,
        state.startOrigin,
        state.caps ?? fallbackCapabilities
      );
      if (state.request.profile) {
        state.auth = {
          ...state.auth,
          operations: state.auth.operations.filter(operation =>
            state.request.profile?.operations.includes(operation)
          ),
          grants: state.request.profile.id === 'research' ? [] : state.auth.grants,
        };
      }
    }
    if (!state.auth.origins.includes(observation.origin)) {
      state.terminal = this._block(
        state,
        'ORIGIN_LEFT_SCOPE',
        'The page left the authorized origins.'
      );
      return undefined;
    }
    try {
      state.progressDiagnostics?.observe(observation);
    } catch {
      state.progressDiagnostics = undefined;
    }
    this._emit(state, {
      type: 'observed',
      snapshot: summarizeObservation(observation),
      ordinal: state.ordinal,
      changed: previous?.fingerprint !== observation.fingerprint,
    });
    this._updateResolutions(state);
    if (state.progressFingerprint !== undefined) {
      state.usage.noProgress =
        state.progressFingerprint === observation.fingerprint ? state.usage.noProgress + 1 : 0;
      state.progressFingerprint = undefined;
      if (state.usage.noProgress > state.budgets.maxNoProgress) {
        state.terminal = this._block(
          state,
          'NO_PROGRESS',
          'Executed actions produced no observed progress.'
        );
        return undefined;
      }
    }
    if (state.exclusionFingerprint !== observation.fingerprint) {
      state.exclusions = [];
      state.exclusionFingerprint = observation.fingerprint;
    }
    return observation;
  };
  private readonly _requirement = (
    state: RunState,
    operation: TaskHostOperation,
    element: TaskElement | undefined,
    reason: TaskRequirement['reason'],
    slot?: TaskRequirement['slot']
  ): TaskResult =>
    this._needsInput(state, [
      {
        id: this._createId('req'),
        kind: 'argument',
        operation,
        ...(slot ? { slot } : {}),
        ...(element ? { target: element } : {}),
        description: `Provide an authorized argument for ${operation}${element ? ` on ${element.label}` : ''}.`,
        reason,
        ...(slot === 'option'
          ? { options: element?.options?.map(option => option.label) ?? [] }
          : {}),
      },
    ]);
  private readonly _rejectDecision = (
    state: RunState,
    operation: TaskHistoryEntry['operation'],
    element: TaskElement | undefined,
    detail: string
  ): TaskResult | undefined => {
    state.history.push({
      step: state.usage.steps,
      kind: 'rejected_decision',
      operation,
      ...(element ? { target: element.label } : {}),
      detail,
    });
    return this._occurrence(
      state,
      'invalidDecisions',
      'maxInvalidDecisions',
      'MODEL_UNCERTAIN',
      'The model repeatedly selected unusable commands.'
    );
  };
  private readonly _history = (
    state: RunState,
    keep: (entry: TaskHistoryEntry) => boolean = () => true
  ): readonly TaskHistoryEntry[] =>
    [...historyFromLedger(state.ledger, TASK_LIMITS.historyEntries), ...state.history.filter(keep)]
      .sort((left, right) => left.step - right.step)
      .slice(-TASK_LIMITS.historyEntries);
  private readonly _inputSummaries = (state: RunState) =>
    safeUrls(
      summarizeInputs(state.leaves, { previews: state.options.inputPreviews !== false }),
      state.redactor
    );
  private readonly _goalRequirementKey = (
    element: TaskElement,
    observation: TaskObservation
  ): string => {
    const key = goalRequirementKey(element, observation);
    return element.kind === 'radio' && element.controlId
      ? sha256Hex(
          stableStringify({ key, control: element.controlId, document: observation.documentId })
        )
      : key;
  };

  private readonly _expected = (
    state: RunState,
    observation: TaskObservation
  ): readonly TaskExpectedState[] =>
    safeUrls(
      expectedStates(
        state.ledger,
        checkPostconditions(state.ledger, observation),
        TASK_LIMITS.expectedStates
      ),
      state.redactor
    );

  private readonly _exclusiveGroupId = (element: TaskElement): string | undefined =>
    element.kind === 'radio' &&
    element.groupId &&
    (element.inputType === 'radio' || element.groupId.startsWith('aria:'))
      ? element.groupId
      : undefined;

  private readonly _radioChoices = (members: readonly TaskElement[]): readonly TaskElement[] => {
    const controls = new Map<string, TaskElement>();
    for (const member of members) {
      const key = member.controlId ?? member.id;
      const existing = controls.get(key);
      if (!existing || (member.inputType === 'radio' && existing.inputType !== 'radio')) {
        controls.set(key, member);
      }
    }
    return [...controls.values()];
  };

  private readonly _groupKey = (
    observation: TaskObservation,
    members: readonly TaskElement[]
  ): string => {
    const first = members[0];
    const form = observation.forms.find(candidate => candidate.id === first?.formId);
    return (
      'group:' +
      sha256Hex(
        stableStringify({
          origin: observation.origin,
          title: observation.title,
          form: form ? { name: form.name, method: form.method, action: form.action } : undefined,
          name: first?.inputName,
          region: first?.region,
          landmark: first?.landmark,
          contexts: first?.contexts,
          choices: this._radioChoices(members).map(member => ({
            label: member.label,
            kind: member.kind,
            code: member.sensitive ? undefined : member.state.value,
            disabled: member.state.disabled,
          })),
        })
      )
    );
  };

  private readonly _cacheRadioGroup = (
    state: RunState,
    observation: TaskObservation,
    members: readonly TaskElement[],
    marker: string,
    decision: TaskArgumentDecision,
    selected?: TaskElement
  ): void => {
    for (const member of members) {
      const key = this._goalRequirementKey(member, observation);
      const selectedView =
        selected &&
        (member.controlId && selected.controlId
          ? member.controlId === selected.controlId
          : member.id === selected.id);
      state.goalRequirements.set(key, {
        key,
        operation: 'SET_CHECKED',
        label: member.label,
        sensitive: member.sensitive,
        confidence: decision.confidence,
        assessedUrl: observation.url,
        assessedAtLedgerSeq: state.ledger.length,
        ...(decision.kind === 'keep_current' && member.state.checked !== undefined
          ? { preserve: { checked: member.state.checked } }
          : {}),
        ...(selected
          ? {
              argument: {
                source: 'protocol',
                slot: 'checked',
                token: selectedView ? 'CHECKED' : 'UNCHECKED',
              },
              preview: selectedView ? 'Selected' : 'Not selected',
            }
          : decision.kind === 'required_unavailable'
            ? { unavailable: true }
            : {}),
      });
    }
    state.goalRequirements.set(marker, {
      key: marker,
      operation: 'SET_CHECKED',
      label: 'Exclusive choice group',
      sensitive: false,
      confidence: decision.confidence,
      ...(decision.kind === 'required_unavailable' ? { unavailable: true } : {}),
    });
    state.groupDocuments.set(marker, observation.documentId);
  };

  private readonly _assessRadioGroups = async (
    state: RunState,
    observation: TaskObservation
  ): Promise<boolean> => {
    if (!state.auth?.operations.includes('SET_CHECKED')) {
      return true;
    }
    const groups = new Map<string, TaskElement[]>();
    for (const element of observation.elements) {
      const id = this._exclusiveGroupId(element);
      if (id) {
        groups.set(id, [...(groups.get(id) ?? []), element]);
      }
    }
    const offers = computeOffers({
      observation,
      capabilities: state.caps ?? fallbackCapabilities,
      allowedOperations: state.auth.operations,
      exclude: this._offerExclusions(state, observation),
      allowRunLoss: state.options.allowRunLoss === true,
    });
    for (const [id, members] of groups) {
      const marker = this._groupKey(observation, members);
      if (
        state.groupDocuments.get(marker) === observation.documentId &&
        state.goalRequirements.has(marker) &&
        members.every(
          member =>
            state.goalRequirements.has(this._goalRequirementKey(member, observation)) &&
            !this._peripheralReceiptStale(state, observation, member) &&
            !this._unrelatedToggleReceiptStale(state, observation, member)
        )
      ) {
        continue;
      }
      const choices = this._radioChoices(members);
      const candidates: TaskArgumentCandidate[] = choices
        .filter(member =>
          members.some(
            view =>
              (view.controlId && member.controlId
                ? view.controlId === member.controlId
                : view.id === member.id) && offers.targets.SET_CHECKED?.includes(view.id)
          )
        )
        .map(member => ({
          id: member.id,
          source: 'protocol',
          label: member.label,
          sensitive: member.sensitive,
          ...(member.state.value !== undefined && !member.sensitive
            ? { code: member.state.value }
            : {}),
          ref: { source: 'protocol', slot: 'checked', token: 'CHECKED' },
        }));
      const result = await this._deciderCall(state, 'argument', context =>
        this._config.decider.chooseArgument(
          {
            purpose: 'group',
            group: { id, members: choices },
            goal: state.request.goal,
            step: state.usage.steps,
            observation,
            operation: 'SET_CHECKED',
            target: choices[0],
            slot: 'checked',
            candidates,
            goalRequirements: this._goalViews(state, observation),
            submittedControls: safeUrls(state.submittedControls, state.redactor),
            expected: this._expected(state, observation),
            inputs: this._inputSummaries(state),
            history: this._history(state),
            maxStateBytes: TASK_LIMITS.modelStateBytes,
          },
          context
        )
      );
      if (!result?.ok || state.terminal) {
        return false;
      }
      const decision = result.decision;
      if (
        !Number.isFinite(decision.confidence) ||
        decision.confidence < state.floors.argument ||
        decision.confidence > 1 ||
        decision.kind === 'uncertain_requirement'
      ) {
        state.terminal = this._rejectUncertainRequirement(state, 'SET_CHECKED', choices[0]);
        return false;
      }
      let selected: TaskElement | undefined;
      if (decision.kind === 'candidate') {
        selected = choices.find(
          member =>
            member.id === decision.candidateId &&
            candidates.some(candidate => candidate.id === member.id)
        );
      } else if (decision.kind === 'keep_current') {
        const current = choices.filter(member => member.state.checked === true);
        if (current.length === 1) {
          selected = current[0];
        }
      }
      if ((decision.kind === 'candidate' || decision.kind === 'keep_current') && !selected) {
        state.terminal = this._rejectUncertainRequirement(state, 'SET_CHECKED', choices[0]);
        return false;
      }
      this._cacheRadioGroup(state, observation, members, marker, decision, selected);
    }
    return true;
  };

  private readonly _goalViews = (
    state: RunState,
    observation: TaskObservation
  ): readonly TaskGoalRequirementView[] =>
    safeUrls(
      observation.elements.flatMap(element => {
        const requirement = state.goalRequirements.get(
          this._goalRequirementKey(element, observation)
        );
        if (!requirement?.argument && !requirement?.unavailable && !requirement?.preserve) {
          return [];
        }
        return [
          {
            targetId: element.id,
            operation: requirement.operation,
            desired: requirement.sensitive
              ? requirement.label
              : (requirement.preview ?? requirement.label),
            satisfied:
              !requirement.unavailable &&
              (!requirement.activationWitness ||
                this._activationWitnessMatches(state, observation, element, requirement)) &&
              goalRequirementHolds(requirement, element, {
                goal: state.request.goal,
                inputs: state.inputs,
                declarations: state.declarations,
                ledger: state.ledger,
              }),
          },
        ];
      }),
      state.redactor
    );

  private readonly _validatedEmptyField = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement
  ): boolean => {
    if (
      !element.formId ||
      !element.operations.includes('FILL') ||
      !element.state.invalid ||
      element.state.value !== '' ||
      !observation.validation.some(
        message =>
          message.targetId === element.id && (message.source === 'aria' || message.source === 'dom')
      )
    ) {
      return false;
    }
    const submitted = [...state.ledger]
      .reverse()
      .find(
        entry =>
          entry.command.command.operation === 'SUBMIT' ||
          (entry.command.command.operation === 'PRESS' &&
            entry.command.command.key === 'Enter' &&
            entry.effects.includes('form_submit'))
      );
    return (
      !!submitted &&
      submitted.effect !== 'none' &&
      submitted.command.target?.formId === element.formId &&
      originOf(submitted.url) === observation.origin &&
      (submitted.scope.documentId === observation.documentId ||
        submitted.afterDocumentId === observation.documentId)
    );
  };

  private readonly _completionContext = (state: RunState, observation: TaskObservation): string =>
    sha256Hex(
      stableStringify({
        document: observation.documentId,
        fingerprint: observation.fingerprint,
        evidence: collectEvidence(state.ledger, TASK_LIMITS.collectedEvidence),
      })
    );

  private readonly _deferPeripheralAssessment = (
    state: RunState,
    observation: TaskObservation
  ): boolean => {
    const offers = this._guardGoalOffers(
      state,
      observation,
      computeOffers({
        observation,
        capabilities: state.caps ?? fallbackCapabilities,
        allowedOperations: state.auth?.operations ?? [],
        exclude: this._offerExclusions(state, observation),
        allowRunLoss: state.options.allowRunLoss === true,
      })
    );
    return observation.elements.some(element => {
      const requirement = state.goalRequirements.get(
        this._goalRequirementKey(element, observation)
      );
      return (
        element.landmark !== 'footer' &&
        requirement?.argument !== undefined &&
        requirement.confidence !== undefined &&
        Number.isFinite(requirement.confidence) &&
        requirement.confidence >= state.floors.argument &&
        requirement.confidence <= 1 &&
        offers.operations.includes(requirement.operation) &&
        offers.targets[requirement.operation]?.includes(element.id) &&
        !goalRequirementHolds(requirement, element, {
          goal: state.request.goal,
          inputs: state.inputs,
          declarations: state.declarations,
          ledger: state.ledger,
        })
      );
    });
  };

  private readonly _peripheralReceiptStale = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement
  ): boolean => {
    const receipt = state.goalRequirements.get(this._goalRequirementKey(element, observation));
    return (
      element.landmark === 'footer' &&
      receipt !== undefined &&
      (receipt.assessedAtLedgerSeq ?? 0) < state.primarySubmissionSeq
    );
  };

  private readonly _unrelatedToggleReceiptStale = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement
  ): boolean => {
    const receipt = state.goalRequirements.get(this._goalRequirementKey(element, observation));
    return (
      !!receipt?.assessedUrl &&
      receipt.assessedUrl !== observation.url &&
      (receipt.operation === 'SET_CHECKED' ||
        (receipt.operation === 'CLICK' && element.state.pressed !== undefined)) &&
      !receipt.argument &&
      !receipt.preserve &&
      !receipt.unavailable &&
      state.ledger.some(
        entry =>
          entry.seq > (receipt.assessedAtLedgerSeq ?? state.ledger.length) &&
          (entry.status === 'applied' || entry.status === 'navigated') &&
          (entry.command.command.operation === 'NAVIGATE' || entry.status === 'navigated')
      )
    );
  };

  private readonly _publicFormControlsDigest = (
    observation: TaskObservation,
    formId: string
  ): string | undefined => {
    const form = observation.forms.find(candidate => candidate.id === formId);
    if (
      !form?.fieldIds.length ||
      form.fieldIds.length > TASK_LIMITS.expectedStates * 2 ||
      new Set(form.fieldIds).size !== form.fieldIds.length ||
      observation.truncation.elementsDropped > 0 ||
      observation.truncation.optionsDropped > 0
    ) {
      return undefined;
    }
    const groups = new Map<string, { readonly semantics: string; readonly signatures: string[] }>();
    const signatures = new Set<string>();
    for (const id of form.fieldIds) {
      const field = observation.elements.find(element => element.id === id);
      if (
        !field ||
        field.formId !== formId ||
        field.sensitive ||
        field.state.valueTruncated === true ||
        (field.twins ?? 1) !== 1 ||
        signatures.has(field.signature) ||
        stableStringify([field.label, field.state.value, field.options]).includes(TASK_REDACTED)
      ) {
        return undefined;
      }
      signatures.add(field.signature);
      const semantics = stableStringify({
        kind: field.kind,
        role: field.role,
        label: field.label,
        name: field.inputName,
        inputType: field.inputType,
        autocomplete: field.autocomplete,
        value: field.state.value,
        checked: field.state.checked,
        selected: field.state.selected,
        pressed: field.state.pressed,
        disabled: field.state.disabled,
        required: field.state.required,
        invalid: field.state.invalid,
        readOnly: field.state.readOnly,
        formNoValidate: field.formNoValidate,
        options: field.options?.map(option => ({
          label: option.label,
          value: option.value,
          groupLabel: option.groupLabel,
          selected: option.selected,
          disabled: option.disabled,
        })),
      });
      const identity = field.controlId ?? field.signature;
      const group = groups.get(identity);
      if (group && group.semantics !== semantics) {
        return undefined;
      }
      groups.set(identity, {
        semantics,
        signatures: [...(group?.signatures ?? []), field.signature],
      });
    }
    if (groups.size > TASK_LIMITS.expectedStates) {
      return undefined;
    }
    return sha256Hex(
      stableStringify(
        [...groups.values()]
          .map(group => ({
            semantics: group.semantics,
            signatures: [...group.signatures].sort(),
          }))
          .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      )
    );
  };

  private readonly _validActivationWitness = (
    value: unknown
  ): value is NonNullable<TaskGoalRequirement['activationWitness']> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const witness = value as NonNullable<TaskGoalRequirement['activationWitness']>;
    return (
      Number.isSafeInteger(witness.ledgerSeq) &&
      witness.ledgerSeq > 0 &&
      typeof witness.origin === 'string' &&
      originOf(witness.origin) === witness.origin &&
      typeof witness.submitterSignature === 'string' &&
      witness.submitterSignature.length > 0 &&
      typeof witness.formAction === 'string' &&
      originOf(witness.formAction) === witness.origin &&
      !witness.formAction.includes(TASK_REDACTED) &&
      witness.formMethod === 'GET' &&
      typeof witness.publicControlsDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(witness.publicControlsDigest)
    );
  };

  private readonly _activationWitnessMatches = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement,
    requirement: TaskGoalRequirement
  ): boolean => {
    const witness = requirement.activationWitness;
    if (!this._validActivationWitness(witness)) {
      return false;
    }
    const form = observation.forms.find(candidate => candidate.id === element.formId);
    const digest = form && this._publicFormControlsDigest(observation, form.id);
    const entry = witness && state.ledger.find(candidate => candidate.seq === witness.ledgerSeq);
    return !!(
      witness &&
      requirement.activated &&
      requirement.operation === 'SUBMIT' &&
      requirement.argument?.source === 'protocol' &&
      requirement.argument.token === 'CHECKED' &&
      requirement.confidence !== undefined &&
      Number.isFinite(requirement.confidence) &&
      requirement.confidence >= state.floors.argument &&
      requirement.confidence <= 1 &&
      witness.origin === observation.origin &&
      witness.submitterSignature === element.signature &&
      observation.elements.filter(candidate => candidate.signature === element.signature).length ===
        1 &&
      (element.twins ?? 1) === 1 &&
      element.operations.includes('SUBMIT') &&
      form?.method === 'GET' &&
      form.action === witness.formAction &&
      form.method === witness.formMethod &&
      element.formTarget?.action === witness.formAction &&
      element.formTarget.method === witness.formMethod &&
      originOf(form.action) === observation.origin &&
      !form.action.includes(TASK_REDACTED) &&
      entry?.command.command.operation === 'SUBMIT' &&
      entry.command.target?.signature === witness.submitterSignature &&
      entry.status === 'navigated' &&
      entry.navigated &&
      entry.effect !== 'none' &&
      entry.afterDocumentId === observation.documentId &&
      entry.afterDocumentId !== entry.scope.documentId &&
      entry.afterUrl === observation.url &&
      originOf(entry.url) === witness.origin &&
      entry.effects.every(effect => !isTaskCommitmentEffect(effect) || effect === 'form_submit') &&
      digest !== undefined &&
      digest === witness.publicControlsDigest
    );
  };

  private readonly _carryActivatedRequirement = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement
  ): void => {
    const key = this._goalRequirementKey(element, observation);
    const cached = state.goalRequirements.get(key);
    if (
      cached?.activationWitness &&
      !this._activationWitnessMatches(state, observation, element, cached)
    ) {
      state.goalRequirements.delete(key);
    }
    if (state.goalRequirements.has(key)) {
      return;
    }
    const prior = [...state.goalRequirements.values()].find(requirement =>
      this._activationWitnessMatches(state, observation, element, requirement)
    );
    if (prior) {
      state.goalRequirements.set(key, { ...prior, key });
      state.unresolvedRequirements.delete(key);
    }
  };

  private readonly _createActivationWitness = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement,
    requirement: TaskGoalRequirement,
    ledgerSeq: number
  ): TaskGoalRequirement['activationWitness'] => {
    const form = observation.forms.find(candidate => candidate.id === element.formId);
    const entry = state.ledger.find(candidate => candidate.seq === ledgerSeq);
    const digest = form && this._publicFormControlsDigest(observation, form.id);
    if (
      !digest ||
      !form ||
      form.method !== 'GET' ||
      !element.formTarget ||
      element.formTarget.action !== form.action ||
      element.formTarget.method !== form.method ||
      form.action.includes(TASK_REDACTED) ||
      originOf(form.action) !== observation.origin ||
      element.sensitive ||
      (element.twins ?? 1) !== 1 ||
      observation.elements.filter(candidate => candidate.signature === element.signature).length !==
        1 ||
      requirement.operation !== 'SUBMIT' ||
      requirement.argument?.source !== 'protocol' ||
      requirement.argument.token !== 'CHECKED' ||
      requirement.confidence === undefined ||
      !Number.isFinite(requirement.confidence) ||
      requirement.confidence < state.floors.argument ||
      requirement.confidence > 1 ||
      entry?.command.command.operation !== 'SUBMIT' ||
      entry.command.target?.signature !== element.signature ||
      entry.status !== 'navigated' ||
      !entry.navigated ||
      entry.effect === 'none' ||
      !entry.afterDocumentId ||
      entry.afterDocumentId === entry.scope.documentId ||
      !entry.afterUrl ||
      originOf(entry.afterUrl) !== observation.origin ||
      entry.effects.some(effect => isTaskCommitmentEffect(effect) && effect !== 'form_submit')
    ) {
      return undefined;
    }
    return {
      ledgerSeq,
      origin: observation.origin,
      submitterSignature: element.signature,
      formAction: form.action,
      formMethod: form.method,
      publicControlsDigest: digest,
    };
  };

  private readonly _requirementContext = (observation: TaskObservation): string =>
    `${observation.documentId}|${observation.fingerprint}`;

  private readonly _unresolvedRequirementElements = (
    state: RunState,
    observation: TaskObservation
  ): readonly TaskElement[] =>
    observation.elements.filter(element =>
      state.unresolvedRequirements.has(this._goalRequirementKey(element, observation))
    );

  private readonly _unresolvedControlRefs = (
    state: RunState,
    observation: TaskObservation
  ): readonly TaskTargetRef[] | undefined => {
    const elements = this._unresolvedRequirementElements(state, observation);
    if (
      elements.length > TASK_LIMITS.expectedStates ||
      new Set(elements.map(element => element.id)).size !== elements.length
    ) {
      return undefined;
    }
    return elements.map(element => ({
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      targetId: element.id,
      signature: element.signature,
    }));
  };

  private readonly _unresolvedCompletionProven = (
    state: RunState,
    expected: readonly TaskTargetRef[],
    decision: TaskCompletionDecision
  ): boolean => {
    const reported = decision.unresolvedControlStates ?? [];
    if (!Array.isArray(reported) || reported.length !== expected.length) {
      return false;
    }
    const proven = new Set<string>();
    for (const receipt of reported) {
      if (
        !receipt ||
        !receipt.target ||
        receipt.verdict !== 'SATISFIED' ||
        !Number.isFinite(receipt.confidence) ||
        receipt.confidence < state.floors.completion ||
        receipt.confidence > 1
      ) {
        return false;
      }
      const ref = expected.find(
        target =>
          target.sessionId === receipt.target.sessionId &&
          target.snapshotId === receipt.target.snapshotId &&
          target.targetId === receipt.target.targetId &&
          target.signature === receipt.target.signature
      );
      if (!ref || proven.has(ref.targetId)) {
        return false;
      }
      proven.add(ref.targetId);
    }
    return proven.size === expected.length;
  };

  private readonly _safeScopeNavigation = (
    observation: TaskObservation,
    element: TaskElement
  ): boolean =>
    (element.landmark === 'main' || element.landmark === 'aside') &&
    !element.sensitive &&
    !element.commitHints?.length &&
    originOf(element.href) === observation.origin;

  private readonly _hasPreparatoryCommitMarker = (element: TaskElement): boolean =>
    element.commitHints?.some(
      hint => hint.basis !== 'implicit_submit_field' && hint.basis !== 'submit_control'
    ) === true;

  private readonly _resolvedFormProgress = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement
  ): boolean => {
    if (
      !element.formId ||
      this._unresolvedRequirementElements(state, observation).some(
        unknown => unknown.formId === element.formId
      )
    ) {
      return false;
    }
    const fields = observation.elements.filter(
      field =>
        field.formId === element.formId &&
        field.operations.some(operation => ['FILL', 'SELECT', 'SET_CHECKED'].includes(operation))
    );
    const context = {
      goal: state.request.goal,
      inputs: state.inputs,
      declarations: state.declarations,
      ledger: state.ledger,
    };
    return (
      fields.every(field => {
        const receipt = state.goalRequirements.get(this._goalRequirementKey(field, observation));
        return (
          receipt?.assessedUrl !== undefined &&
          !receipt.unavailable &&
          ((!receipt.argument && !receipt.preserve) ||
            goalRequirementHolds(receipt, field, context))
        );
      }) &&
      observation.elements.some(submitter => {
        const receipt = state.goalRequirements.get(
          this._goalRequirementKey(submitter, observation)
        );
        return (
          submitter.formId === element.formId &&
          submitter.operations.includes('SUBMIT') &&
          !submitter.commitHints?.some(hint => hint.class !== 'FORM_SUBMIT') &&
          receipt?.operation === 'SUBMIT' &&
          receipt.argument?.source === 'protocol' &&
          receipt.argument.token === 'CHECKED' &&
          !receipt.activated &&
          receipt.confidence !== undefined &&
          Number.isFinite(receipt.confidence) &&
          receipt.confidence >= state.floors.argument &&
          receipt.confidence <= 1
        );
      })
    );
  };

  private readonly _canDeferUncertainRequirement = (
    state: RunState,
    observation: TaskObservation
  ): boolean => {
    const offers = this._guardGoalOffers(
      state,
      observation,
      computeOffers({
        observation,
        capabilities: state.caps ?? fallbackCapabilities,
        allowedOperations: state.auth?.operations ?? [],
        exclude: this._offerExclusions(state, observation),
        allowRunLoss: state.options.allowRunLoss === true,
      })
    );
    const preparation = this._nextPreparation(state, observation, offers);
    return (
      (!!preparation && !this._hasPreparatoryCommitMarker(preparation.element)) ||
      observation.elements.some(
        element =>
          offers.targets.SUBMIT?.includes(element.id) &&
          this._resolvedFormProgress(state, observation, element)
      ) ||
      observation.elements.some(
        element =>
          offers.targets.NAVIGATE?.includes(element.id) &&
          this._safeScopeNavigation(observation, element)
      )
    );
  };

  private readonly _requiresResolvedCommitmentScope = (
    state: RunState,
    observation: TaskObservation,
    command: TaskCommand,
    element: TaskElement | undefined,
    effects: readonly TaskEffectKind[]
  ): boolean => {
    const independentlyScopedFormSubmit =
      !!element &&
      (command.operation === 'SUBMIT' ||
        (command.operation === 'PRESS' && command.key === 'Enter')) &&
      effects.every(effect => !isTaskCommitmentEffect(effect) || effect === 'form_submit') &&
      this._resolvedFormProgress(state, observation, element);
    return (
      effects.includes('purchase') ||
      (hasCommitment(effects) &&
        !independentlyScopedFormSubmit &&
        this._unresolvedRequirementElements(state, observation).length > 0)
    );
  };

  private readonly _deferUncertainRequirement = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement
  ): boolean => {
    if (!this._canDeferUncertainRequirement(state, observation)) {
      return false;
    }
    const key = this._goalRequirementKey(element, observation);
    state.goalRequirements.delete(key);
    state.unresolvedRequirements.set(key, {
      context: this._requirementContext(observation),
      ledgerSeq: state.ledger.length,
    });
    return true;
  };

  /** A candidate that would replace a field's existing, non-placeholder value with a different one. */
  private readonly _rewritesCurrentValue = (
    element: TaskElement,
    operation: TaskHostOperation,
    candidates: readonly TaskArgumentCandidate[],
    decision: TaskArgumentDecision
  ): boolean => {
    if (decision.kind !== 'candidate' || element.sensitive) {
      return false;
    }
    const candidate = candidates.find(item => item.id === decision.candidateId);
    const current = element.state.value ?? '';
    if (candidate === undefined || current === '') {
      return false;
    }
    if (operation === 'SELECT') {
      const selected = element.options?.find(option => option.selected);
      return (
        candidate.ref.source === 'observed_option' &&
        selected !== undefined &&
        selected.id !== candidate.ref.optionId
      );
    }
    return (
      operation === 'FILL' &&
      candidate.preview !== undefined &&
      candidate.preview.trim().toLowerCase() !== current.trim().toLowerCase()
    );
  };

  /**
   * One independent sample is taken when a requirement judgment is just under the argument floor, when a choice that
   * rewrites an existing value rests on less than a majority of confidence, or when a relevant, empty, non-sensitive text
   * field was left empty although supplied data could fill it.
   */
  private readonly _wantsSecondOpinion = (
    state: RunState,
    element: TaskElement,
    operation: TaskHostOperation,
    candidates: readonly TaskArgumentCandidate[],
    decision: TaskArgumentDecision
  ): boolean =>
    (Number.isFinite(decision.confidence) && decision.confidence < state.floors.argument) ||
    (Number.isFinite(decision.confidence) &&
      decision.confidence < MAJORITY_CONFIDENCE &&
      this._rewritesCurrentValue(element, operation, candidates, decision)) ||
    (decision.kind === 'keep_current' &&
      Number.isFinite(decision.confidence) &&
      decision.confidence >= state.floors.argument &&
      operation === 'FILL' &&
      !element.sensitive &&
      (element.state.value ?? '') === '' &&
      candidates.some(candidate => candidate.source === 'input'));

  private readonly _needsRewriteConfirmation = (
    state: RunState,
    element: TaskElement,
    operation: TaskHostOperation,
    candidates: readonly TaskArgumentCandidate[],
    decision: TaskArgumentDecision
  ): boolean =>
    decision.kind === 'candidate' &&
    Number.isFinite(decision.confidence) &&
    decision.confidence >= state.floors.argument &&
    decision.confidence < MAJORITY_CONFIDENCE &&
    this._rewritesCurrentValue(element, operation, candidates, decision);

  /**
   * The decision to use after a second sample. The second replaces the first only when it clears the unchanged floor and
   * agrees, or fills with supplied data more confidently than the first kept the field empty. A below-majority rewrite of an
   * existing value stands only when the second sample agrees; a second that keeps the value wins, and any other second
   * leaves the requirement uncertain.
   */
  private readonly _afterSecondOpinion = (
    state: RunState,
    element: TaskElement,
    operation: TaskHostOperation,
    candidates: readonly TaskArgumentCandidate[],
    first: TaskArgumentDecision,
    second: TaskArgumentDecision
  ): TaskArgumentDecision => {
    const secondClears =
      Number.isFinite(second.confidence) &&
      second.confidence >= state.floors.argument &&
      second.confidence <= 1;
    if (
      first.kind === 'candidate' &&
      this._needsRewriteConfirmation(state, element, operation, candidates, first)
    ) {
      if (secondClears && second.kind === 'candidate' && second.candidateId === first.candidateId) {
        return first;
      }
      if (
        secondClears &&
        (second.kind === 'keep_current' ||
          (second.kind === 'candidate' &&
            !this._rewritesCurrentValue(element, operation, candidates, second)))
      ) {
        return second;
      }
      return { kind: 'uncertain_requirement', confidence: first.confidence };
    }
    if (!secondClears) {
      return first;
    }
    if (first.kind === 'keep_current' && first.confidence >= state.floors.argument) {
      return second.kind === 'candidate' &&
        second.confidence > first.confidence &&
        candidates.some(
          candidate => candidate.id === second.candidateId && candidate.source === 'input'
        )
        ? second
        : first;
    }
    return first.kind === second.kind &&
      (first.kind !== 'candidate' ||
        (second.kind === 'candidate' && first.candidateId === second.candidateId))
      ? second
      : first;
  };

  private readonly _assessRequirements = async (
    state: RunState,
    observation: TaskObservation
  ): Promise<boolean> => {
    if (!this._config.decider.supportsRequirements) {
      return true;
    }
    let groupsAssessed = false;
    const priority = (element: TaskElement): number =>
      element.landmark === 'footer'
        ? 6
        : (element.operations.includes('FILL') || element.operations.includes('SELECT') ? 0 : 3) +
          (element.landmark === 'main' ? 0 : 1);
    const elements = [...observation.elements].sort((a, b) => priority(a) - priority(b));
    for (const element of elements) {
      if (priority(element) >= 3 && !groupsAssessed) {
        if (!(await this._assessRadioGroups(state, observation))) {
          return false;
        }
        groupsAssessed = true;
      }
      if (
        this._exclusiveGroupId(element) ||
        (element.landmark === 'footer' && this._deferPeripheralAssessment(state, observation))
      ) {
        continue;
      }
      const operation = element.operations.includes('SUBMIT')
        ? 'SUBMIT'
        : element.operations.includes('FILL')
          ? 'FILL'
          : element.kind === 'select' && element.operations.includes('SELECT')
            ? 'SELECT'
            : element.operations.includes('SET_CHECKED')
              ? 'SET_CHECKED'
              : element.state.pressed !== undefined && element.operations.includes('CLICK')
                ? 'CLICK'
                : undefined;
      if (!operation || !state.auth?.operations.includes(operation)) {
        continue;
      }
      const key = this._goalRequirementKey(element, observation);
      if (operation === 'SUBMIT') {
        this._carryActivatedRequirement(state, observation, element);
      }
      const unresolved = state.unresolvedRequirements.get(key);
      const progressed =
        unresolved &&
        state.ledger.some(
          entry =>
            entry.seq > unresolved.ledgerSeq &&
            (entry.status === 'applied' || entry.status === 'navigated') &&
            (entry.effect === 'applied' || entry.navigated)
        );
      if (
        unresolved &&
        (unresolved.context === this._requirementContext(observation) || !progressed)
      ) {
        if (this._canDeferUncertainRequirement(state, observation)) {
          continue;
        }
        state.terminal = this._rejectUncertainRequirement(state, operation, element);
        return false;
      }
      const validation =
        operation === 'FILL' && this._validatedEmptyField(state, observation, element);
      if (
        state.goalRequirements.has(key) &&
        !this._peripheralReceiptStale(state, observation, element) &&
        !this._unrelatedToggleReceiptStale(state, observation, element) &&
        (!validation || state.validationAssessed.has(key))
      ) {
        continue;
      }
      const slot = operation === 'FILL' ? 'value' : operation === 'SELECT' ? 'option' : 'checked';
      let pool = buildCandidates({
        goal: state.request.goal,
        operation: operation === 'CLICK' || operation === 'SUBMIT' ? 'SET_CHECKED' : operation,
        slot,
        element,
        observation,
        capabilities: state.caps ?? fallbackCapabilities,
        leaves: state.leaves,
        resolvers: this._config.options?.resolvers ?? [],
        origins: state.auth.origins,
        previews: state.options.inputPreviews !== false,
        limit: TASK_LIMITS.candidates,
      });
      if (operation === 'SUBMIT') {
        pool = {
          ...pool,
          candidates: pool.candidates.filter(
            candidate => candidate.ref.source === 'protocol' && candidate.ref.token === 'CHECKED'
          ),
        };
      }
      if (!pool.candidates.length) {
        state.goalRequirements.set(key, {
          key,
          operation,
          label: element.label,
          sensitive: element.sensitive,
        });
        continue;
      }
      const ask = () =>
        this._deciderCall(state, 'argument', context =>
          this._config.decider.chooseArgument(
            {
              purpose:
                operation === 'SUBMIT' ? 'activation' : validation ? 'validation' : 'requirement',
              goal: state.request.goal,
              step: state.usage.steps,
              observation,
              operation,
              target: element,
              slot,
              candidates:
                operation === 'SUBMIT'
                  ? candidateViews(pool).map(candidate => ({
                      ...candidate,
                      label: 'Activate this form as part of the task',
                    }))
                  : candidateViews(pool),
              goalRequirements: this._goalViews(state, observation),
              submittedControls: safeUrls(
                argumentSubmittedControls(state.submittedControls),
                state.redactor
              ),
              expected: this._expected(state, observation),
              inputs: this._inputSummaries(state),
              history: this._history(state),
              maxStateBytes: TASK_LIMITS.modelStateBytes,
            },
            context
          )
        );
      let result = await ask();
      const sampleKey = `${key}|${observation.documentId}`;
      const requiresConfirmation =
        result?.ok &&
        this._needsRewriteConfirmation(state, element, operation, pool.candidates, result.decision);
      if (
        result?.ok &&
        !state.terminal &&
        (requiresConfirmation ||
          (!state.resampled.has(sampleKey) &&
            this._wantsSecondOpinion(state, element, operation, pool.candidates, result.decision)))
      ) {
        state.resampled.add(sampleKey);
        const second = await ask();
        if (second?.ok) {
          const decision = this._afterSecondOpinion(
            state,
            element,
            operation,
            pool.candidates,
            result.decision,
            second.decision
          );
          if (decision === second.decision) {
            result = second;
          } else if (decision !== result.decision) {
            result = { ...result, decision };
          }
        } else if (requiresConfirmation) {
          result = {
            ...result,
            decision: { kind: 'uncertain_requirement', confidence: result.decision.confidence },
          };
        }
      }
      if (!result?.ok || state.terminal) {
        return false;
      }
      const decision = result.decision;
      if (
        !Number.isFinite(decision.confidence) ||
        decision.confidence < state.floors.argument ||
        decision.confidence > 1
      ) {
        if (this._deferUncertainRequirement(state, observation, element)) {
          continue;
        }
        state.terminal = this._rejectDecision(
          state,
          operation,
          element,
          'The requirement judgment was insufficiently confident.'
        );
        return false;
      }
      if (decision.kind === 'uncertain_requirement') {
        if (this._deferUncertainRequirement(state, observation, element)) {
          continue;
        }
        state.terminal = this._rejectUncertainRequirement(state, operation, element);
        return false;
      }
      state.unresolvedRequirements.delete(key);
      if (validation) {
        state.validationAssessed.add(key);
      }
      if (decision.kind === 'keep_current') {
        const preserve = {
          ...(element.state.value !== undefined ? { value: element.state.value } : {}),
          ...(element.state.checked !== undefined ? { checked: element.state.checked } : {}),
          ...(element.state.selected !== undefined ? { selected: element.state.selected } : {}),
          ...(element.state.pressed !== undefined ? { pressed: element.state.pressed } : {}),
        };
        state.goalRequirements.set(key, {
          key,
          operation,
          label: element.label,
          sensitive: element.sensitive,
          preserve,
          assessedUrl: observation.url,
          assessedAtLedgerSeq: state.ledger.length,
        });
        continue;
      }
      if (decision.kind === 'required_unavailable') {
        state.goalRequirements.set(key, {
          key,
          operation,
          label: element.label,
          sensitive: element.sensitive,
          unavailable: true,
          confidence: decision.confidence,
          assessedUrl: observation.url,
          assessedAtLedgerSeq: state.ledger.length,
        });
        continue;
      }
      const chosenId = decision.kind === 'candidate' ? decision.candidateId : undefined;
      const chosen =
        decision.kind === 'candidate'
          ? pool.candidates.find(candidate => candidate.id === chosenId)
          : undefined;
      if (result.decision.kind === 'candidate' && !chosen) {
        state.terminal = this._rejectDecision(
          state,
          operation,
          element,
          'The requirement candidate was not offered.'
        );
        return false;
      }
      const chosenRef = chosen?.ref;
      const optionValue =
        chosenRef?.source === 'observed_option' && !chosen?.sensitive && !element.sensitive
          ? element.options?.find(option => option.id === chosenRef.optionId)?.value
          : undefined;
      state.goalRequirements.set(key, {
        key,
        operation,
        label: element.label,
        sensitive: chosen?.sensitive === true || element.sensitive,
        assessedUrl: observation.url,
        assessedAtLedgerSeq: state.ledger.length,
        ...(chosen && result.decision.confidence >= state.floors.argument
          ? {
              confidence: result.decision.confidence,
              argument: chosen.ref,
              ...(chosen.preview !== undefined && !chosen.sensitive && !element.sensitive
                ? { preview: chosen.preview }
                : {}),
              ...(slot === 'option'
                ? {
                    optionLabel: chosen.label,
                    ...(optionValue !== undefined ? { optionValue } : {}),
                  }
                : {}),
            }
          : {}),
      });
    }
    return groupsAssessed || (await this._assessRadioGroups(state, observation));
  };

  private readonly _guardGoalOffers = (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers
  ): TaskOffers => {
    const missing = this._goalViews(state, observation).filter(view => !view.satisfied);
    const unresolved = this._unresolvedRequirementElements(state, observation);
    const targets = { ...offers.targets };
    for (const operation of [
      'FILL',
      'SELECT',
      'SET_CHECKED',
      'CLICK',
      'PRESS',
      'SUBMIT',
    ] as const) {
      targets[operation] = targets[operation]?.filter(id => {
        const element = observation.elements.find(candidate => candidate.id === id);
        if (!element) {
          return false;
        }
        const requirement = state.goalRequirements.get(
          this._goalRequirementKey(element, observation)
        );
        const independentFormAction =
          (operation === 'SUBMIT' || operation === 'PRESS') &&
          this._resolvedFormProgress(state, observation, element);
        // A pressed-state toggle with a confident, uncommitting receipt is the same safety class as SET_CHECKED.
        const confidentToggleClick =
          operation === 'CLICK' &&
          element.state.pressed !== undefined &&
          !element.commitHints?.length &&
          requirement?.operation === 'CLICK' &&
          requirement.argument !== undefined &&
          requirement.confidence !== undefined &&
          Number.isFinite(requirement.confidence) &&
          requirement.confidence >= state.floors.argument &&
          requirement.confidence <= 1;
        if (
          unresolved.length > 0 &&
          (unresolved.some(unknown => unknown.id === element.id) ||
            (independentFormAction
              ? !!element.commitHints?.some(hint => hint.class !== 'FORM_SUBMIT')
              : (['CLICK', 'PRESS', 'SUBMIT'].includes(operation) && !confidentToggleClick) ||
                this._hasPreparatoryCommitMarker(element) ||
                !requirement?.argument ||
                requirement.confidence === undefined ||
                requirement.confidence < state.floors.argument))
        ) {
          return false;
        }
        if (
          this._exclusiveGroupId(element) &&
          requirement?.argument?.source === 'protocol' &&
          requirement.argument.token === 'UNCHECKED' &&
          ['SET_CHECKED', 'CLICK', 'PRESS'].includes(operation)
        ) {
          return false;
        }
        if (!requirement || (operation !== requirement.operation && operation !== 'PRESS')) {
          return true;
        }
        if (!requirement.argument && !requirement.preserve) {
          return false;
        }
        return (
          operation === 'PRESS' ||
          !goalRequirementHolds(requirement, element, {
            goal: state.request.goal,
            inputs: state.inputs,
            declarations: state.declarations,
            ledger: state.ledger,
          })
        );
      });
    }
    const submitters = (targets.SUBMIT ?? []).filter(id => {
      const form = observation.elements.find(element => element.id === id)?.formId;
      return !missing.some(
        view =>
          view.operation !== 'SUBMIT' &&
          observation.elements.find(element => element.id === view.targetId)?.formId === form
      );
    });
    if (unresolved.length > 0) {
      targets.NAVIGATE = targets.NAVIGATE?.filter(id => {
        const element = observation.elements.find(candidate => candidate.id === id);
        return !!element && this._safeScopeNavigation(observation, element);
      });
    }
    return {
      operations: offers.operations.filter(
        operation =>
          !(
            operation === 'DONE' &&
            (missing.length ||
              unresolved.length ||
              (this._config.decider.supportsRequirements === true &&
                state.failedCompletionContext === this._completionContext(state, observation)))
          ) && !(operation === 'SUBMIT' && !submitters.length)
      ),
      targets: { ...targets, SUBMIT: submitters },
    };
  };
  private readonly _rejectGate = (
    state: RunState,
    report: TaskGateReport
  ): TaskResult | undefined => {
    if (state.observation) {
      state.failedCompletionContext = this._completionContext(state, state.observation);
    }
    const codes = report.failures.map(failure => failure.code);
    this._emit(state, { type: 'done_gate', passed: false, failures: codes });
    if (codes.length > 0 && codes.every(code => code === 'UNRESOLVED_UNCERTAIN_EFFECT')) {
      return this._block(state, 'UNCERTAIN_EFFECT', 'An earlier action has an unresolved effect.');
    }
    state.history.push({
      step: state.usage.steps,
      kind: 'premature_done',
      operation: 'DONE',
      detail: codes.join(', '),
    });
    return this._occurrence(
      state,
      'prematureDone',
      'maxPrematureDone',
      'COMPLETION_NOT_VERIFIED',
      'Completion proposals repeatedly failed verification.'
    );
  };
  private readonly _gate = async (state: RunState): Promise<TaskResult | undefined> => {
    let independentRead = false;
    let observation = await this._observe(state);
    if (!observation) {
      return state.terminal;
    }
    independentRead =
      state.independentDocumentId === observation.documentId &&
      !needsPersistenceEvidence({ observation, ledger: state.ledger });
    if (
      !this._config.options?.verifier &&
      state.caps?.freshStateObservations &&
      state.auth?.operations.includes('NAVIGATE') &&
      needsPersistenceEvidence({ observation, ledger: state.ledger })
    ) {
      const previousDocument = observation.documentId;
      observation = await this._observe(state, true);
      if (!observation) {
        return state.terminal;
      }
      independentRead = observation.documentId !== previousDocument;
    }
    if (
      this._config.decider.supportsRequirements &&
      !(await this._assessRadioGroups(state, observation))
    ) {
      return state.terminal;
    }
    const collected = collectEvidence(state.ledger, TASK_LIMITS.collectedEvidence);
    const unresolvedControls = this._unresolvedControlRefs(state, observation);
    if (
      unresolvedControls === undefined ||
      this._goalViews(state, observation).some(requirement => !requirement.satisfied)
    ) {
      return this._rejectGate(state, {
        ...evaluateLocalGate({
          goal: state.request.goal,
          observation,
          observationOrdinal: state.ordinal,
          receivedAt: this._clock(),
          ledger: state.ledger,
          collected,
          floors: state.floors,
          minEvidence: state.options.minEvidence ?? 1,
          allowUncertainCompletion: state.options.allowUncertainCompletion === true,
          requireGrounded: state.options.requireGroundedCompletion === true,
        }),
        passed: false,
        failures: [{ code: 'GOAL_REQUIREMENT_UNMET' }],
      });
    }
    const gateInput = {
      goal: state.request.goal,
      observation,
      observationOrdinal: state.ordinal,
      receivedAt: this._clock(),
      ledger: state.ledger,
      collected,
      expect: state.request.expect ?? state.request.profile?.expect,
      floors: state.floors,
      minEvidence: state.options.minEvidence ?? 1,
      allowUncertainCompletion: state.options.allowUncertainCompletion === true,
      requireGrounded: state.options.requireGroundedCompletion === true,
    };
    const local = evaluateLocalGate(gateInput);
    if (!local.passed) {
      return this._rejectGate(state, local);
    }
    const verified = await this._deciderCall<TaskCompletionDecision>(state, 'completion', context =>
      this._config.decider.verifyCompletion(
        {
          goal: state.request.goal,
          step: state.usage.steps,
          observation,
          history: this._history(state, isObservedHistoryEntry),
          inputs: this._inputSummaries(state),
          evidenceSlots: 2,
          collectedEvidence: collected,
          expected: this._expected(state, observation),
          expectAnswer: (state.request.expect ?? state.request.profile?.expect)?.answer,
          maxStateBytes: TASK_LIMITS.modelStateBytes,
          independentRead,
          goalRequirements: this._goalViews(state, observation),
          submittedControls: safeUrls(
            distinctSubmittedControls(state.submittedControls),
            state.redactor
          ),
          executedEffects: executedEffects(state.ledger),
          unresolvedControls,
          ...(state.initialPage
            ? { initialPage: safeUrls(state.initialPage, state.redactor) }
            : {}),
        },
        context
      )
    );
    if (!verified || !verified.ok) {
      this._emit(state, { type: 'done_gate', passed: false, failures: ['DECIDER_UNAVAILABLE'] });
      if (verified && !verified.ok) {
        state.completionProbe = undefined;
      }
      return state.terminal;
    }
    if (!this._unresolvedCompletionProven(state, unresolvedControls, verified.decision)) {
      return this._rejectGate(state, {
        ...local,
        passed: false,
        failures: [{ code: 'GOAL_REQUIREMENT_UNMET' }],
      });
    }
    let verifier: TaskVerifierResult | undefined;
    if (this._config.options?.verifier) {
      const hook = this._config.options.verifier;
      const result = await this._boundary(
        state,
        signal => hook({ goal: state.request.goal, observation, ledger: state.ledger, signal }),
        TASK_DEFAULT_TIMEOUTS.hookMs
      );
      verifier = result.ok
        ? safeUrls(result.value, state.redactor)
        : { verdict: 'UNCERTAIN', reason: 'The caller verifier did not return a verdict.' };
    }
    const stopped = this._wallOrCancel(state);
    if (stopped) {
      return stopped;
    }
    const full = evaluateFullGate({
      ...gateInput,
      decision: verified.decision,
      ...(verifier ? { verifier } : {}),
    });
    if (!full.passed) {
      return this._rejectGate(state, full);
    }
    this._emit(state, { type: 'done_gate', passed: true, failures: [], mode: full.mode });
    return {
      ...this._base(state),
      status: 'completed',
      completion: completionFromReport(full, state.ledger, observation, this._clock()),
      ...(full.answer ? { answer: full.answer } : {}),
    };
  };
  private readonly _goalCommitCheck = (
    state: RunState,
    observation: TaskObservation,
    command: TaskCommand,
    element?: TaskElement,
    purchase = false
  ): { readonly rejected: boolean; readonly result?: TaskResult } => {
    const missing = this._goalViews(state, observation).some(
      requirement =>
        !requirement.satisfied &&
        requirement.operation !== 'SUBMIT' &&
        (purchase ||
          observation.elements.find(candidate => candidate.id === requirement.targetId)?.formId ===
            element?.formId)
    );
    const unresolved = this._unresolvedRequirementElements(state, observation).some(
      unknown => purchase || unknown.formId === element?.formId
    );
    return missing || unresolved
      ? {
          rejected: true,
          result: this._rejectDecision(
            state,
            command.operation,
            element,
            'The commitment still has unsatisfied goal requirements.'
          ),
        }
      : { rejected: false };
  };
  private readonly _rejectUncertainRequirement = (
    state: RunState,
    operation: TaskHostOperation,
    element?: TaskElement
  ): TaskResult | undefined =>
    this._rejectDecision(
      state,
      operation,
      element,
      'The model could not establish whether this control is required.'
    );

  private readonly _missingRequiredInput = (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers,
    exhausted = false
  ): TaskResult | undefined => {
    const unavailable = observation.elements.find(element => {
      const requirement = state.goalRequirements.get(
        this._goalRequirementKey(element, observation)
      );
      return (
        requirement?.unavailable &&
        requirement.confidence !== undefined &&
        requirement.confidence >= state.floors.argument
      );
    });
    if (!unavailable) {
      return undefined;
    }
    const concrete = this._goalViews(state, observation).some(view => {
      const element = observation.elements.find(candidate => candidate.id === view.targetId);
      const requirement =
        element && state.goalRequirements.get(this._goalRequirementKey(element, observation));
      return (
        !view.satisfied &&
        !!requirement?.argument &&
        view.operation !== 'SUBMIT' &&
        offers.operations.includes(view.operation) &&
        offers.targets[view.operation]?.includes(view.targetId)
      );
    });
    if (concrete) {
      return undefined;
    }
    const related = (element: TaskElement): boolean =>
      (unavailable.formId !== undefined && element.formId === unavailable.formId) ||
      (unavailable.region !== undefined && element.region === unavailable.region) ||
      (unavailable.dialogId !== undefined && element.dialogId === unavailable.dialogId);
    const parent = observation.elements.some(
      element =>
        (unavailable.landmark === 'footer' &&
          element.landmark === 'main' &&
          offers.targets.NAVIGATE?.includes(element.id)) ||
        (related(element) &&
          ((element.state.expanded === false && offers.targets.CLICK?.includes(element.id)) ||
            offers.targets.NAVIGATE?.includes(element.id) ||
            (['SELECT', 'SET_CHECKED'] as const).some(operation => {
              const requirement = state.goalRequirements.get(
                this._goalRequirementKey(element, observation)
              );
              return offers.targets[operation]?.includes(element.id) && !requirement;
            })))
    );
    return parent && !exhausted ? undefined : this._modelBlocked(state, observation);
  };

  private readonly _verifyReady = async (
    state: RunState,
    observation: TaskObservation,
    afterProgress = false
  ): Promise<TaskResult | undefined> => {
    const requirements = this._goalViews(state, observation);
    const postconditions = checkPostconditions(state.ledger, observation);
    const progressed = state.ledger.some(
      entry =>
        (entry.status === 'applied' || entry.status === 'navigated') &&
        ((entry.effect === 'applied' &&
          entry.effects.some(effect => !['read', 'scroll', 'wait'].includes(effect))) ||
          collectEvidence(state.ledger, TASK_LIMITS.collectedEvidence).some(
            evidence => evidence.ledgerSeq === entry.seq
          ))
    );
    const context = this._completionContext(state, observation);
    if (
      (!afterProgress || progressed) &&
      this._unresolvedControlRefs(state, observation) !== undefined &&
      (requirements.length > 0 || (afterProgress && postconditions.length > 0)) &&
      requirements.every(requirement => requirement.satisfied) &&
      state.blockedCompletionContext !== context
    ) {
      const local = evaluateLocalGate({
        goal: state.request.goal,
        observation,
        observationOrdinal: state.ordinal,
        receivedAt: this._clock(),
        ledger: state.ledger,
        collected: collectEvidence(state.ledger, TASK_LIMITS.collectedEvidence),
        floors: state.floors,
        minEvidence: state.options.minEvidence ?? 1,
        allowUncertainCompletion: state.options.allowUncertainCompletion === true,
        requireGrounded: state.options.requireGroundedCompletion === true,
      });
      if (local.passed) {
        state.blockedCompletionContext = context;
        const result = await this._gate(state);
        if (result || state.terminal) {
          return result ?? state.terminal;
        }
      }
    }
    return undefined;
  };

  private readonly _blockedAfterVerification = async (
    state: RunState,
    observation: TaskObservation
  ): Promise<TaskResult> =>
    (await this._verifyReady(state, observation)) ??
    this._modelBlocked(state, state.observation ?? observation);

  private readonly _uncertainAfterVerification = async (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers,
    fallback: TaskResult
  ): Promise<TaskResult> => {
    if (
      !this._config.decider.supportsRequirements ||
      fallback.status !== 'blocked' ||
      fallback.reason !== 'MODEL_UNCERTAIN'
    ) {
      return fallback;
    }
    const missing = this._missingRequiredInput(state, observation, offers, true);
    if (missing) {
      return missing;
    }
    state.terminal = undefined;
    return (
      (await this._verifyReady(state, observation, true)) ??
      this._block(state, fallback.reason, fallback.message, fallback.budget)
    );
  };

  private readonly _modelBlocked = (state: RunState, observation: TaskObservation): TaskResult => {
    const unavailable = observation.elements.find(
      element =>
        state.goalRequirements.get(this._goalRequirementKey(element, observation))?.unavailable
    );
    if (unavailable) {
      const requirement = state.goalRequirements.get(
        this._goalRequirementKey(unavailable, observation)
      );
      return this._requirement(
        state,
        requirement?.operation ?? 'FILL',
        unavailable,
        'none_appropriate',
        requirement?.operation === 'SELECT'
          ? 'option'
          : requirement?.operation === 'SET_CHECKED'
            ? 'checked'
            : 'value'
      );
    }
    const counts = Object.entries(observation.unobserved).filter(([, count]) => count > 0);
    return this._block(
      state,
      counts.length ? 'UNSUPPORTED_SURFACE' : 'MODEL_BLOCKED',
      counts.length
        ? `Unobserved surfaces: ${counts.map(([key, count]) => `${key}=${count}`).join(', ')}.`
        : 'The model could not identify a supported next action.'
    );
  };
  private readonly _captureSubmittedControls = (
    state: RunState,
    observation: TaskObservation,
    element: TaskElement | undefined,
    ledgerSeq: number,
    effect: TaskExecutionOutcome['effect']
  ): void => {
    if (!element?.formId) {
      return;
    }
    const controls: TaskSubmittedControl[] = observation.elements.flatMap<TaskSubmittedControl>(
      control => {
        if (control.formId !== element.formId || control.sensitive || control.state.disabled) {
          return [];
        }
        const observedEmptyAtSubmission =
          control.operations.includes('FILL') &&
          control.state.value === '' &&
          control.state.valueTruncated !== true;
        const common = {
          ledgerSeq,
          effect,
          origin: observation.origin,
          label: control.label,
          kind: control.kind,
          ...(observedEmptyAtSubmission ? { observedEmptyAtSubmission: true as const } : {}),
        };
        const requirement = state.goalRequirements.get(
          this._goalRequirementKey(control, observation)
        );
        const matchesRequiredState =
          requirement &&
          !requirement.sensitive &&
          goalRequirementHolds(requirement, control, {
            goal: state.request.goal,
            inputs: state.inputs,
            declarations: state.declarations,
            ledger: state.ledger,
          });
        if (control.state.checked !== undefined) {
          return [
            {
              ...common,
              checked: control.state.checked,
              ...(matchesRequiredState && requirement.preserve?.checked !== undefined
                ? { preservedChecked: control.state.checked }
                : {}),
            },
          ];
        }
        if (
          control.kind === 'select' &&
          requirement?.operation === 'SELECT' &&
          (requirement.argument !== undefined || requirement.preserve !== undefined) &&
          matchesRequiredState
        ) {
          const selected = control.options?.find(option => option.selected && !option.disabled);
          if (selected && !selected.label.includes(TASK_REDACTED)) {
            const available =
              control.options
                ?.filter(option => !option.disabled && !option.label.includes(TASK_REDACTED))
                .map(option => option.label) ?? [];
            return [
              {
                ...common,
                selectedOption: {
                  label: selected.label,
                  observedLabels: available.slice(0, TASK_LIMITS.expectedStates),
                  labelsTruncated:
                    available.length > TASK_LIMITS.expectedStates ||
                    observation.truncation.optionsDropped > 0,
                },
              },
            ];
          }
        }
        if (
          control.operations.includes('FILL') &&
          requirement?.operation === 'FILL' &&
          !requirement.sensitive &&
          requirement.preserve?.value !== undefined &&
          control.state.value !== undefined &&
          control.state.valueTruncated !== true &&
          !control.state.value.includes(TASK_REDACTED) &&
          goalRequirementHolds(requirement, control, {
            goal: state.request.goal,
            inputs: state.inputs,
            declarations: state.declarations,
            ledger: state.ledger,
          })
        ) {
          return [{ ...common, preservedValue: control.state.value }];
        }
        if (observedEmptyAtSubmission) {
          return [{ ...common, observedEmptyAtSubmission: true }];
        }
        return [];
      }
    );
    state.submittedControls = safeUrls(
      [...state.submittedControls, ...controls].slice(-TASK_LIMITS.expectedStates),
      state.redactor
    );
  };

  private readonly _canPrepareInNewDocument = (
    state: RunState,
    observation: TaskObservation,
    entry: TaskLedgerEntry,
    element: TaskElement | undefined
  ): boolean => {
    if (
      !element ||
      !state.caps?.authoritativeLocation ||
      state.locationTrust !== 'authoritative' ||
      !state.auth?.origins.includes(observation.origin) ||
      (element.twins ?? 1) !== 1 ||
      entry.effect !== 'uncertain' ||
      entry.command.command.operation !== 'FILL' ||
      entry.effects.length === 0 ||
      entry.effects.some(effect => effect !== 'input') ||
      entry.scope.documentId === observation.documentId ||
      originOf(entry.url) !== observation.origin ||
      entry.command.target?.signature !== element.signature ||
      observation.elements.filter(control => control.signature === element.signature).length !==
        1 ||
      element.sensitive ||
      element.state.value === undefined
    ) {
      return false;
    }
    const requirement = state.goalRequirements.get(this._goalRequirementKey(element, observation));
    return (
      requirement?.operation === 'FILL' &&
      requirement.argument !== undefined &&
      requirement.confidence !== undefined &&
      Number.isFinite(requirement.confidence) &&
      requirement.confidence >= state.floors.argument &&
      requirement.confidence <= 1 &&
      stableStringify(requirement.argument) === stableStringify(entry.command.command.value) &&
      !goalRequirementHolds(requirement, element, {
        goal: state.request.goal,
        inputs: state.inputs,
        declarations: state.declarations,
        ledger: state.ledger,
      })
    );
  };

  private readonly _processCommand = async (
    state: RunState,
    observation: TaskObservation,
    command: TaskCommand,
    prepared: {
      readonly element?: TaskElement;
      readonly view?: TaskArgumentView;
      readonly optionLabel?: string;
      readonly approved?: TaskApprovedOnce;
      readonly savedEffects?: readonly TaskEffectKind[];
    }
  ): Promise<TaskResult | undefined> => {
    const { element, view, optionLabel, approved, savedEffects } = prepared;
    const auth = state.auth;
    if (!auth) {
      return this._fail(state, 'INTERNAL', 'Authorization was not initialized.');
    }
    if (
      command.operation === 'SUBMIT' ||
      (command.operation === 'PRESS' && command.key === 'Enter')
    ) {
      const rejected = this._goalCommitCheck(state, observation, command, element);
      if (rejected.rejected) {
        return rejected.result;
      }
    }
    const materializeContext = {
      goal: state.request.goal,
      inputs: state.inputs,
      declarations: state.declarations,
      resolved: {},
    };
    if (command.operation === 'FILL') {
      const available = argumentAvailable(command.value, materializeContext);
      if (!available.ok) {
        return available.code === 'INPUT_MISSING' || available.code === 'INPUT_NOT_SCALAR'
          ? this._requirement(state, command.operation, element, 'input_missing', 'value')
          : this._fail(state, 'INTERNAL', available.message);
      }
    }
    const redacted = safeUrls(redactCommand(command, element, view, optionLabel), state.redactor);
    const form = observation.forms.find(candidate => candidate.id === element?.formId);
    let effects: readonly TaskEffectKind[];
    if (savedEffects) {
      effects = savedEffects;
    } else {
      let structural;
      try {
        structural = this._policy.classify({ command, element, observation });
      } catch {
        structural = {
          effects: ['other_commitment'] as readonly TaskEffectKind[],
          hints: [],
          needsClassification: false,
          classifierError: true,
        };
      }
      effects = structural.effects;
      let classified: Extract<
        TaskEventBody,
        {
          readonly type: 'classified';
        }
      > = { type: 'classified', structural: effects, effects };
      if (structural.classifierError) {
        classified = { ...classified, skipped: 'classifier_error' };
      }
      if (!structural.needsClassification) {
        classified = {
          ...classified,
          skipped: structural.classifierError ? 'classifier_error' : 'not_classified_operation',
        };
      } else if (allCommitmentsGranted(auth)) {
        classified = { ...classified, skipped: 'all_granted' };
      } else if (!this._config.decider.classifyCommitment) {
        if (auth.assumeUnclassifiedRoutine) {
          classified = { ...classified, skipped: 'assumed_routine' };
          if (!state.warnings.some(warning => warning.code === 'ASSUMED_ROUTINE_CLASSIFICATION')) {
            state.warnings.push({ code: 'ASSUMED_ROUTINE_CLASSIFICATION' });
          }
        } else {
          effects = mergeEffects(effects, ['other_commitment']);
          classified = { ...classified, skipped: 'no_classifier' };
        }
      } else {
        const classifier = this._config.decider.classifyCommitment;
        const result = await this._deciderCall(
          state,
          'commitment',
          context =>
            classifier(
              {
                goal: state.request.goal,
                step: state.usage.steps,
                confidenceFloor: state.floors.commitment,
                observation,
                command: redacted,
                target: element,
                form,
                maxStateBytes: TASK_LIMITS.modelStateBytes,
              },
              context
            ),
          true
        );
        if (state.terminal) {
          return state.terminal;
        }
        if (!result || !result.ok) {
          effects = mergeEffects(effects, ['other_commitment']);
          classified = { ...classified, skipped: 'classifier_error' };
        } else {
          const decision = result.decision;
          const valid =
            isTaskCommitmentClass(decision.commitment) &&
            Number.isFinite(decision.confidence) &&
            decision.confidence >= 0 &&
            decision.confidence <= 1 &&
            (decision.commitment !== 'NONE' || decision.confidence >= state.floors.commitment);
          const alternatives =
            valid &&
            decision.commitment === 'OTHER_COMMITMENT' &&
            decision.agreement === 'disagreed' &&
            decision.alternatives?.length === 2 &&
            decision.alternatives.every(
              choice =>
                isTaskCommitmentClass(choice) && choice !== 'NONE' && choice !== 'OTHER_COMMITMENT'
            )
              ? decision.alternatives
              : undefined;
          const effect = alternatives
            ? null
            : valid
              ? effectForCommitment(decision.commitment)
              : 'other_commitment';
          effects = mergeEffects(effects, effect ? [effect] : []);
          if (alternatives) {
            effects = mergeEffects(
              effects,
              alternatives.flatMap(choice => {
                const effect = effectForCommitment(choice);
                return effect ? [effect] : [];
              })
            );
          }
          classified = {
            ...classified,
            model: valid ? decision.commitment : 'OTHER_COMMITMENT',
            agreement: decision.agreement,
          };
        }
      }
      this._emit(state, { ...classified, effects });
    }
    const digest = commandDigest({
      command,
      effects,
      origin: observation.origin,
      target: element,
      optionLabel,
    });
    const context = safeUrls(commitContext({ observation, element, form }), state.redactor);
    const contextHash = contextDigest(context);
    if (this._requiresResolvedCommitmentScope(state, observation, command, element, effects)) {
      const rejected = this._goalCommitCheck(state, observation, command, element, true);
      if (rejected.rejected) {
        return rejected.result;
      }
    }
    this._emit(state, { type: 'compiled', operation: command.operation, digest, effects });
    if (
      !approved &&
      (state.repeats.has(`${digest}|${observation.fingerprint}|${observation.documentId}`) ||
        state.request.priorEffects?.some(
          entry => entry.digest === digest && entry.resolution !== 'not_applied'
        ) ||
        state.ledger.some(
          entry =>
            entry.digest === digest &&
            entry.effect === 'uncertain' &&
            entry.resolution?.effect !== 'none' &&
            !this._canPrepareInNewDocument(state, observation, entry, element)
        ))
    ) {
      return this._rejectDecision(
        state,
        command.operation,
        element,
        'A previously executed or uncertain command cannot be repeated.'
      );
    }
    const pending: readonly TaskPendingCommitment[] = [
      ...pendingCommitments(state.ledger, this._resolutions(state)),
      ...(state.request.priorEffects ?? [])
        .filter(entry => entry.resolution === 'unknown' && hasCommitment(entry.effects))
        .map(entry => ({
          seq: 0,
          digest: entry.digest,
          effects: entry.effects.filter(isTaskCommitmentEffect),
          documentId: observation.documentId,
          ...(element ? { signature: element.signature } : {}),
          ...(element?.formId ? { formId: element.formId } : {}),
        })),
    ];
    let verdict;
    try {
      verdict = this._policy.evaluate({
        command,
        effects,
        digest,
        snapshotId: observation.snapshotId,
        documentId: observation.documentId,
        element,
        form,
        pageUrl: observation.url,
        now: this._clock(),
        contextDigest: contextHash,
        authorization: state.auth ?? auth,
        approvedOnce: approved,
        pendingCommitments: pending,
      });
    } catch {
      return this._block(state, 'POLICY_DENIED', 'Policy evaluation failed closed.');
    }
    this._emit(state, {
      type: 'policy',
      verdict: verdict.verdict,
      reason: verdict.reason,
      effects,
    });
    if (verdict.verdict === 'deny') {
      return this._block(
        state,
        ['origin_not_allowed', 'scheme_not_allowed'].includes(verdict.reason)
          ? 'ORIGIN_LEFT_SCOPE'
          : 'POLICY_DENIED',
        `Policy denied the command: ${verdict.reason}.`
      );
    }
    if (verdict.verdict === 'require_approval') {
      if (state.request.profile?.onUnauthorized === 'deny') {
        return this._block(
          state,
          'POLICY_DENIED',
          'This profile denies commands that require approval.'
        );
      }
      const createdAt = this._clock();
      const approval: TaskApprovalRequest = {
        id: this._createId('apr'),
        runId: state.runId,
        nonce: this._createId('non'),
        digest,
        contextDigest: contextHash,
        snapshotId: observation.snapshotId,
        documentId: observation.documentId,
        observationFingerprint: observation.fingerprint,
        url: observation.url,
        step: state.usage.steps,
        effects: effects.filter(isTaskCommitmentEffect),
        command: redacted,
        context,
        reason: verdict.reason,
        createdAt,
        expiresAt: createdAt + (state.options.approvalTtlMs ?? TASK_DEFAULT_TIMEOUTS.approvalTtlMs),
        ...(pending.some(entry => entry.seq > 0)
          ? { priorUncertain: pending.filter(entry => entry.seq > 0).map(entry => entry.seq) }
          : {}),
      };
      this._emit(state, { type: 'approval', phase: 'requested', approvalId: approval.id, digest });
      const awaiting: TaskPending = {
        kind: 'awaiting_approval',
        approval,
        command,
        effects,
        ...(optionLabel ? { optionLabel } : {}),
      };
      return {
        ...this._base(state),
        status: 'awaiting_approval',
        approval,
        checkpoint: this._checkpoint(state, awaiting),
      };
    }
    return this._executeCommand(state, observation, {
      command,
      element,
      optionLabel,
      approved,
      auth,
      redacted,
      digest,
      effects,
      grants: verdict.grants,
    });
  };
  private readonly _executeCommand = async (
    state: RunState,
    observation: TaskObservation,
    prepared: {
      readonly command: TaskCommand;
      readonly element?: TaskElement;
      readonly optionLabel?: string;
      readonly approved?: TaskApprovedOnce;
      readonly auth: TaskNormalizedAuthorization;
      readonly redacted: TaskRedactedCommand;
      readonly digest: string;
      readonly effects: readonly TaskEffectKind[];
      readonly grants: readonly number[];
    }
  ): Promise<TaskResult | undefined> => {
    const { command, element, optionLabel, approved, auth, redacted, digest, effects, grants } =
      prepared;
    const materializeContext = {
      goal: state.request.goal,
      inputs: state.inputs,
      declarations: state.declarations,
      resolved: {},
    };
    let materialized:
      | Extract<
          TaskMaterialized,
          {
            readonly ok: true;
          }
        >
      | undefined;
    if (command.operation === 'FILL') {
      let resolved: Readonly<Record<string, TaskResolvedValue>> = {};
      if (command.value.source === 'resolver') {
        const ref = command.value;
        const resolver = this._config.options?.resolvers?.find(
          candidate => candidate.id === ref.resolverId
        );
        if (!resolver) {
          return this._fail(state, 'INTERNAL', 'The declared resolver is unavailable.');
        }
        const result = await this._boundary(
          state,
          signal =>
            resolver.resolve(
              {
                goal: state.request.goal,
                operation: command.operation,
                slot: 'value',
                target: element,
                step: state.usage.steps,
              },
              signal
            ),
          state.options.observeTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.observeMs
        );
        if (state.controller.signal.aborted) {
          return this._cancelled(state);
        }
        if (!result.ok) {
          return this._fail(state, 'RESOLVER_FAILED', result.message);
        }
        if (!result.value.ok) {
          return result.value.code === 'refused' || result.value.code === 'unavailable'
            ? this._requirement(
                state,
                command.operation,
                element,
                result.value.code === 'refused' ? 'resolver_refused' : 'resolver_unavailable',
                'value'
              )
            : this._fail(state, 'RESOLVER_FAILED', result.value.message);
        }
        if (typeof result.value.value !== 'string') {
          return this._fail(state, 'RESOLVER_FAILED', 'The resolver returned a non-string value.');
        }
        if (resolver.sensitive || element?.sensitive) {
          state.redactor = state.redactor.withSecrets([result.value.value]);
        }
        resolved = {
          [`${ref.resolverId}|${ref.key}`]: {
            value: result.value.value,
            sensitive: resolver.sensitive,
          },
        };
      }
      const result = materializeArgument(command.value, { ...materializeContext, resolved });
      if (!result.ok) {
        return result.code === 'INPUT_MISSING' || result.code === 'INPUT_NOT_SCALAR'
          ? this._requirement(state, command.operation, element, 'input_missing', 'value')
          : this._fail(state, 'INTERNAL', result.message);
      }
      materialized = result;
      if (result.sensitive || element?.sensitive) {
        state.redactor = state.redactor.withSecrets([result.value]);
        if (result.sensitive && !element?.sensitive) {
          state.warnings.push({ code: 'SENSITIVE_UNCLASSIFIED_FIELD' });
        }
      }
    }
    const hostCommand = toHostCommand(command, materialized, element);
    if (!hostCommand.ok) {
      return this._fail(state, 'INTERNAL', hostCommand.message);
    }
    const before = this._config.options?.beforeExecute;
    if (before) {
      await this._boundary(
        state,
        async () => {
          await before({ step: state.usage.steps, command: redacted, element });
        },
        TASK_DEFAULT_TIMEOUTS.hookMs
      );
    }
    const stopped = this._wallOrCancel(state);
    if (stopped) {
      return stopped;
    }
    if (command.operation === 'FILL' && state.caps?.authoritativeLocation) {
      const currentOrigin = await this._location(state);
      if (state.terminal) {
        return state.terminal;
      }
      if (currentOrigin !== observation.origin || !auth.origins.includes(currentOrigin ?? '')) {
        return this._block(state, 'ORIGIN_UNVERIFIED', 'Location changed before typing the value.');
      }
    }
    if (approved) {
      if (
        this._consumedApprovals.has(approved.approvalId) ||
        state.consumed.has(approved.approvalId)
      ) {
        this._emit(state, {
          type: 'approval',
          phase: 'consumed',
          approvalId: approved.approvalId,
          digest,
        });
        return this._fail(state, 'APPROVAL_CONSUMED', 'This approval was already consumed.');
      }
      this._consumedApprovals.add(approved.approvalId);
      state.consumed.add(approved.approvalId);
      if (this._config.options?.consumeApproval) {
        const consume = this._config.options.consumeApproval;
        const result = await this._boundary(
          state,
          () => consume(approved.approvalId),
          TASK_DEFAULT_TIMEOUTS.hookMs
        );
        if (!result.ok || result.value !== true) {
          this._emit(state, {
            type: 'approval',
            phase: 'consumed',
            approvalId: approved.approvalId,
            digest,
          });
          return this._fail(
            state,
            'APPROVAL_CONSUMED',
            'The approval could not be consumed exclusively.'
          );
        }
      }
    }
    const beforeSend = this._wallOrCancel(state);
    if (beforeSend) {
      return beforeSend;
    }
    state.auth = consumeGrants(state.auth ?? auth, grants);
    const requestId = approved
      ? derivedId('req', `${approved.approvalId}|exec`)
      : this._createId('req');
    state.during = 'action';
    this._emit(state, {
      type: 'executing',
      requestId,
      command: safeUrls(redacted, state.redactor),
    });
    const startedAt = this._clock();
    const raw = await this._boundary(
      state,
      signal =>
        this._config.host.execute(
          {
            requestId,
            scope: {
              sessionId: observation.sessionId,
              snapshotId: observation.snapshotId,
              documentId: observation.documentId,
            },
            command: hostCommand.command,
            allowedOrigins: auth.origins,
            timeoutMs: state.options.executionTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.executionMs,
            settle: state.options.settle ?? TASK_DEFAULT_SETTLE,
          },
          signal
        ),
      state.options.executionTimeoutMs ?? TASK_DEFAULT_TIMEOUTS.executionMs,
      true
    );
    const outcome = safeUrls(
      normalizeOutcome(
        raw.ok
          ? raw.value
          : {
              requestId,
              status: ['READ', 'WAIT'].includes(command.operation) ? 'failed' : 'uncertain',
              effect: ['READ', 'WAIT'].includes(command.operation) ? 'none' : 'uncertain',
              code:
                raw.reason === 'timeout'
                  ? 'EXECUTION_TIMEOUT'
                  : state.controller.signal.aborted
                    ? 'EXECUTION_CANCELLED'
                    : 'HOST_FAILED',
              message: raw.message,
              durationMs: Math.max(0, this._clock() - startedAt),
            },
        command.operation,
        requestId
      ),
      state.redactor
    );
    const attach =
      ['applied', 'noop_already_satisfied', 'navigated', 'uncertain'].includes(outcome.status) ||
      (outcome.status === 'failed' && outcome.effect !== 'none');
    const entry = createLedgerEntry({
      seq: state.ledger.length + 1,
      step: state.usage.steps,
      command: safeUrls(redacted, state.redactor),
      digest,
      effects,
      outcome,
      scope: {
        sessionId: observation.sessionId,
        snapshotId: observation.snapshotId,
        documentId: observation.documentId,
      },
      observationSequence: observation.sequence,
      observationOrdinal: state.ordinal,
      url: observation.url,
      startedAt,
      finishedAt: this._clock(),
      ...(approved ? { approvalId: approved.approvalId } : {}),
      postconditions:
        attach && element
          ? derivePostconditions({
              command,
              target: element,
              materialized: materialized
                ? {
                    value: materialized.value,
                    sensitive: materialized.sensitive || element.sensitive,
                  }
                : undefined,
              optionLabel,
            })
          : [],
    });
    state.ledger.push(safeUrls(entry, state.redactor));
    this._accountSubmittedRequirements(state, observation, {
      command,
      element,
      outcome,
      effects,
      ledgerSeq: entry.seq,
    });
    this._emit(state, {
      type: 'executed',
      requestId,
      status: outcome.status,
      effect: outcome.effect,
      code: outcome.code,
      readback: outcome.readback,
      durationMs: outcome.durationMs,
    });
    this._updateResolutions(state);
    return this._accountOutcome(state, observation, { outcome, command, element, digest, effects });
  };
  private readonly _accountSubmittedRequirements = (
    state: RunState,
    observation: TaskObservation,
    prepared: {
      readonly command: TaskCommand;
      readonly element?: TaskElement;
      readonly outcome: TaskExecutionOutcome;
      readonly effects: readonly TaskEffectKind[];
      readonly ledgerSeq: number;
    }
  ): void => {
    const { command, outcome, effects } = prepared;
    if (outcome.status === 'applied' || outcome.status === 'navigated') {
      const categoricalChange =
        (command.operation === 'SELECT' &&
          outcome.readback?.kind === 'select' &&
          outcome.readback.changed) ||
        (command.operation === 'SET_CHECKED' &&
          command.checked &&
          outcome.readback?.kind === 'setChecked' &&
          outcome.readback.changed &&
          prepared.element?.inputType === 'radio' &&
          !!this._exclusiveGroupId(prepared.element));
      if (
        categoricalChange &&
        outcome.status === 'applied' &&
        outcome.effect === 'applied' &&
        prepared.element?.formId &&
        !prepared.element.sensitive
      ) {
        for (const sibling of observation.elements) {
          if (
            sibling.id === prepared.element.id ||
            sibling.kind !== 'select' ||
            sibling.sensitive ||
            sibling.formId !== prepared.element.formId ||
            (sibling.controlId && sibling.controlId === prepared.element.controlId)
          ) {
            continue;
          }
          const key = this._goalRequirementKey(sibling, observation);
          const requirement = state.goalRequirements.get(key);
          if (
            requirement?.operation === 'SELECT' &&
            requirement.unavailable &&
            !requirement.sensitive
          ) {
            state.goalRequirements.delete(key);
          }
        }
      }
      const submitted =
        command.operation === 'SUBMIT' ||
        (command.operation === 'PRESS' &&
          command.key === 'Enter' &&
          effects.includes('form_submit'));
      const preparedField =
        ['FILL', 'SELECT', 'SET_CHECKED'].includes(command.operation) && outcome.effect !== 'none';
      if (submitted && outcome.effect !== 'none') {
        if (prepared.element?.landmark !== 'footer' && prepared.element?.formId) {
          state.primarySubmissionSeq = prepared.ledgerSeq;
        }
        this._captureSubmittedControls(
          state,
          observation,
          prepared.element,
          prepared.ledgerSeq,
          outcome.effect
        );
      }
      if (submitted || preparedField) {
        for (const submitter of observation.elements.filter(
          candidate =>
            candidate.operations.includes('SUBMIT') && candidate.formId === prepared.element?.formId
        )) {
          const key = this._goalRequirementKey(submitter, observation);
          const requirement = state.goalRequirements.get(key);
          if (requirement?.operation === 'SUBMIT' && requirement.argument) {
            const activationWitness =
              submitted && command.operation === 'SUBMIT' && submitter.id === prepared.element?.id
                ? this._createActivationWitness(
                    state,
                    observation,
                    submitter,
                    requirement,
                    prepared.ledgerSeq
                  )
                : undefined;
            state.goalRequirements.set(key, {
              ...requirement,
              activated: submitted,
              ...(activationWitness ? { activationWitness } : {}),
            });
          }
        }
      }
    }
  };
  private readonly _accountOutcome = (
    state: RunState,
    observation: TaskObservation,
    prepared: {
      readonly outcome: TaskExecutionOutcome;
      readonly command: TaskCommand;
      readonly element?: TaskElement;
      readonly digest: string;
      readonly effects: readonly TaskEffectKind[];
    }
  ): TaskResult | undefined => {
    const { outcome, command, element, digest, effects } = prepared;
    if (state.controller.signal.aborted) {
      return this._cancelled(state);
    }
    if (
      ['applied', 'noop_already_satisfied', 'navigated'].includes(outcome.status) ||
      (outcome.status === 'failed' && outcome.effect === 'applied')
    ) {
      state.usage.staleRetries = 0;
      state.usage.invalidDecisions = 0;
      state.usage.rejectedCommands = 0;
      state.usage.deciderFailures = 0;
      if (outcome.effect === 'applied') {
        state.usage.prematureDone = 0;
      }
      state.repeats.add(`${digest}|${observation.fingerprint}|${observation.documentId}`);
      state.progressFingerprint = observation.fingerprint;
      return undefined;
    }
    if (outcome.status === 'rejected_stale') {
      const limit = this._occurrence(
        state,
        'staleRetries',
        'maxStaleRetries',
        'STALE_LIMIT',
        'The target repeatedly changed before execution.'
      );
      this._emit(state, {
        type: 'stale',
        reason: outcome.staleReason ?? 'superseded_snapshot',
        consecutive: state.usage.staleRetries,
      });
      return limit;
    }
    if (outcome.effect === 'uncertain') {
      state.progressFingerprint = observation.fingerprint;
      if (
        hasCommitment(effects) ||
        state.usage.uncertainEffects > state.budgets.maxUncertainEffects
      ) {
        return this._block(
          state,
          'UNCERTAIN_EFFECT',
          'The command may have taken effect and cannot be retried.'
        );
      }
      return undefined;
    }
    state.exclusions.push({
      operation: command.operation,
      ...(element ? { signature: element.signature } : {}),
    });
    if (outcome.code?.startsWith('HOST_')) {
      state.usage.hostFailures += 1;
      if (state.usage.hostFailures > state.budgets.maxHostFailures) {
        return this._fail(state, 'HOST_FAILED', 'The host repeatedly failed to execute commands.');
      }
    }
    return this._occurrence(
      state,
      'rejectedCommands',
      'maxRejectedCommands',
      'COMMANDS_REJECTED',
      'The page repeatedly refused valid commands.'
    );
  };
  private readonly _rebindApproval = async (
    state: RunState,
    observation: TaskObservation
  ): Promise<TaskResult | undefined> => {
    const pending = state.pendingApproval;
    if (!pending) {
      return undefined;
    }
    if (!(await this._assessRequirements(state, observation))) {
      return state.terminal;
    }
    state.pendingApproval = undefined;
    const approval = pending.approval;
    const savedTarget = approval.command.target;
    const matches = savedTarget
      ? observation.elements.filter(
          element =>
            element.signature === savedTarget.signature &&
            (element.twins ?? 1) === (savedTarget.twins ?? 1)
        )
      : [];
    const element = matches.length === 1 ? matches[0] : undefined;
    const targetRequired = 'target' in pending.command && pending.command.target !== undefined;
    let command = pending.command;
    let valid =
      observation.documentId === approval.documentId && (!targetRequired || element !== undefined);
    if (element && 'target' in command) {
      command = {
        ...command,
        target: {
          sessionId: state.sessionId,
          snapshotId: observation.snapshotId,
          targetId: element.id,
          signature: element.signature,
        },
      };
    }
    if (command.operation === 'SELECT' && command.optionId !== undefined) {
      const options =
        element?.options?.filter(
          option => option.label === pending.optionLabel && !option.disabled
        ) ?? [];
      if (options.length !== 1) {
        valid = false;
      } else {
        command = { ...command, optionId: options[0]?.id };
      }
    }
    const form = observation.forms.find(candidate => candidate.id === element?.formId);
    const digest = commandDigest({
      command,
      effects: pending.effects,
      origin: observation.origin,
      target: element,
      optionLabel: pending.optionLabel,
    });
    const cdigest = contextDigest(
      safeUrls(commitContext({ observation, element, form }), state.redactor)
    );
    valid = valid && digest === approval.digest && cdigest === approval.contextDigest;
    if (!valid) {
      this._emit(state, {
        type: 'approval',
        phase: 'void',
        approvalId: approval.id,
        digest: approval.digest,
      });
      return undefined;
    }
    const offers = this._guardGoalOffers(
      state,
      observation,
      computeOffers({
        observation,
        capabilities: state.caps ?? fallbackCapabilities,
        allowedOperations: state.auth?.operations ?? [],
        exclude: [],
        allowRunLoss: state.options.allowRunLoss === true,
      })
    );
    const operation = command.operation;
    const argument =
      command.operation === 'FILL'
        ? command.value
        : command.operation === 'SELECT' && command.optionId
          ? {
              source: 'observed_option' as const,
              targetId: element?.id ?? '',
              optionId: command.optionId,
            }
          : command.operation === 'PRESS'
            ? { source: 'protocol' as const, slot: 'key' as const, token: command.key }
            : command.operation === 'SET_CHECKED'
              ? {
                  source: 'protocol' as const,
                  slot: 'checked' as const,
                  token: command.checked ? 'CHECKED' : 'UNCHECKED',
                }
              : command.operation === 'SCROLL'
                ? {
                    source: 'protocol' as const,
                    slot: 'direction' as const,
                    token: command.direction,
                  }
                : command.operation === 'WAIT'
                  ? {
                      source: 'protocol' as const,
                      slot: 'duration' as const,
                      token: String(command.durationMs),
                    }
                  : undefined;
    const compiled = compileCommand({
      goal: state.request.goal,
      observation,
      offers,
      capabilities: state.caps ?? fallbackCapabilities,
      operation,
      targetId: element?.id ?? (operation === 'SCROLL' ? TASK_PAGE_TARGET_ID : undefined),
      argument,
      inputRules: inputRules(state.leaves),
      resolvers: this._config.options?.resolvers ?? [],
      origins: state.auth?.origins ?? [],
    });
    if (!compiled.ok) {
      this._emit(state, {
        type: 'approval',
        phase: 'void',
        approvalId: approval.id,
        digest: approval.digest,
      });
      return undefined;
    }
    if (state.approvalResolution?.scope === 'run' && state.auth) {
      state.auth = addRunGrants(
        state.auth,
        approval.effects,
        observation.origin,
        state.approvalResolution.maxUses ?? TASK_DEFAULT_RUN_GRANT_USES
      );
    }
    this._emit(state, { type: 'approval', phase: 'approved', approvalId: approval.id, digest });
    return this._processCommand(state, observation, compiled.command, {
      element: compiled.target,
      view: approval.command.argument,
      optionLabel: compiled.optionLabel,
      approved: { approvalId: approval.id, digest, contextDigest: cdigest },
      savedEffects: pending.effects,
    });
  };
  private readonly _protocolArgumentMissing = (
    state: RunState,
    operation: TaskHostOperation,
    element: TaskElement | undefined
  ): TaskResult | undefined =>
    this._rejectDecision(state, operation, element, 'No offered protocol argument was selected.');

  private readonly _independentRead = (state: RunState, observation: TaskObservation): boolean =>
    state.independentDocumentId === observation.documentId &&
    !needsPersistenceEvidence({ observation, ledger: state.ledger });

  private readonly _knownArgument = (
    state: RunState,
    observation: TaskObservation,
    operation: TaskHostOperation,
    element: TaskElement | undefined,
    candidates: readonly TaskArgumentCandidate[]
  ): TaskArgumentDecision | undefined => {
    const requirement = element
      ? state.goalRequirements.get(this._goalRequirementKey(element, observation))
      : undefined;
    if (
      !requirement?.argument ||
      requirement.operation !== operation ||
      requirement.confidence === undefined ||
      requirement.confidence < state.floors.argument
    ) {
      return undefined;
    }
    const candidate = candidates.find(
      item => stableStringify(item.ref) === stableStringify(requirement.argument)
    );
    return candidate
      ? { kind: 'candidate', candidateId: candidate.id, confidence: requirement.confidence }
      : undefined;
  };

  private readonly _nextPreparation = (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers
  ) => {
    const context = {
      goal: state.request.goal,
      inputs: state.inputs,
      declarations: state.declarations,
      ledger: state.ledger,
    };
    for (const element of observation.elements) {
      const requirement = state.goalRequirements.get(
        this._goalRequirementKey(element, observation)
      );
      if (
        !requirement ||
        !['FILL', 'SELECT', 'SET_CHECKED'].includes(requirement.operation) ||
        !offers.operations.includes(requirement.operation) ||
        !offers.targets[requirement.operation]?.includes(element.id) ||
        goalRequirementHolds(requirement, element, context)
      ) {
        continue;
      }
      const operation = requirement.operation;
      const spec = describeArgument(operation, element);
      if (!spec) {
        continue;
      }
      const pool = buildCandidates({
        goal: state.request.goal,
        operation,
        slot: spec.slot,
        element,
        observation,
        capabilities: state.caps ?? fallbackCapabilities,
        leaves: state.leaves,
        resolvers: this._config.options?.resolvers ?? [],
        origins: state.auth?.origins ?? [],
        previews: state.options.inputPreviews !== false,
        limit: TASK_LIMITS.candidates,
      });
      const known = this._knownArgument(state, observation, operation, element, pool.candidates);
      const candidate =
        known?.kind === 'candidate'
          ? pool.candidates.find(item => item.id === known.candidateId)
          : undefined;
      if (!candidate || !known) {
        continue;
      }
      const compiled = compileCommand({
        goal: state.request.goal,
        observation,
        offers,
        capabilities: state.caps ?? fallbackCapabilities,
        operation,
        targetId: element.id,
        argument: candidate.ref,
        inputRules: inputRules(state.leaves),
        resolvers: this._config.options?.resolvers ?? [],
        origins: state.auth?.origins ?? [],
      });
      if (!compiled.ok) {
        continue;
      }
      const repeated = state.ledger.some(entry => {
        const digest = commandDigest({
          command: compiled.command,
          effects: entry.effects,
          origin: observation.origin,
          target: element,
          optionLabel: compiled.optionLabel,
        });
        return state.repeats.has(`${digest}|${observation.fingerprint}|${observation.documentId}`);
      });
      if (repeated) {
        continue;
      }
      return { operation, element, candidate, known, compiled, spec };
    }
    return undefined;
  };

  /**
   * A fresh-state read reloads the page, which closes view-only disclosures opened earlier. After a failed completion
   * check on that reloaded view, the same non-committing clicks are repeated on controls that are demonstrably closed.
   */
  private readonly _nextViewRestoration = (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers
  ) => {
    if (
      state.independentDocumentId !== observation.documentId ||
      state.failedCompletionContext === undefined ||
      !offers.operations.includes('CLICK')
    ) {
      return undefined;
    }
    for (const entry of state.ledger) {
      const target = entry.command.target;
      if (
        entry.command.command.operation !== 'CLICK' ||
        entry.status !== 'applied' ||
        entry.effects.length !== 1 ||
        entry.effects[0] !== 'interact' ||
        !target ||
        entry.scope.documentId === observation.documentId
      ) {
        continue;
      }
      const matches = observation.elements.filter(
        candidate => candidate.signature === target.signature
      );
      const element = matches.length === 1 ? matches[0] : undefined;
      if (
        !element ||
        state.viewRestored.has(`${observation.documentId}|${element.signature}`) ||
        (element.state.expanded !== false && element.state.selected !== false) ||
        element.sensitive ||
        !!element.commitHints?.length ||
        this._hasPreparatoryCommitMarker(element) ||
        !offers.targets.CLICK?.includes(element.id) ||
        describeArgument('CLICK', element)
      ) {
        continue;
      }
      const compiled = compileCommand({
        goal: state.request.goal,
        observation,
        offers,
        capabilities: state.caps ?? fallbackCapabilities,
        operation: 'CLICK',
        targetId: element.id,
        inputRules: inputRules(state.leaves),
        resolvers: this._config.options?.resolvers ?? [],
        origins: state.auth?.origins ?? [],
      });
      if (compiled.ok) {
        return { element, compiled };
      }
    }
    return undefined;
  };

  private readonly _restoreView = async (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers
  ): Promise<{ readonly handled: boolean; readonly result?: TaskResult }> => {
    const restoration = this._nextViewRestoration(state, observation, offers);
    if (!restoration) {
      return { handled: false };
    }
    state.viewRestored.add(`${observation.documentId}|${restoration.element.signature}`);
    state.usage.steps += 1;
    return {
      handled: true,
      result: await this._processCommand(state, observation, restoration.compiled.command, {
        element: restoration.compiled.target,
      }),
    };
  };

  private readonly _prepareRequiredControl = async (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers
  ): Promise<{ readonly handled: boolean; readonly result?: TaskResult }> => {
    const restored = await this._restoreView(state, observation, offers);
    if (restored.handled) {
      return restored;
    }
    const preparation = this._nextPreparation(state, observation, offers);
    if (!preparation) {
      return { handled: false };
    }
    const { operation, element, candidate, known, compiled, spec } = preparation;
    state.usage.steps += 1;
    this._emit(state, {
      type: 'planning',
      source: 'goal_requirement',
      operation,
      targetId: element.id,
      candidateId: candidate.id,
      requirementConfidence: known.confidence,
    });
    return {
      handled: true,
      result: await this._processCommand(state, observation, compiled.command, {
        element: compiled.target,
        view: argumentView(candidate, spec.slot),
        optionLabel: compiled.optionLabel,
      }),
    };
  };

  private readonly _offerExclusions = (
    state: RunState,
    observation: TaskObservation
  ): readonly TaskOfferExclusion[] => [
    ...state.exclusions,
    ...state.ledger.flatMap(entry => {
      if (
        entry.command.command.operation === 'READ' &&
        ['applied', 'noop_already_satisfied'].includes(entry.status) &&
        entry.effect === 'none' &&
        entry.command.target?.signature &&
        state.repeats.has(`${entry.digest}|${observation.fingerprint}|${observation.documentId}`)
      ) {
        return [{ operation: 'READ' as const, signature: entry.command.target.signature }];
      }
      const element = observation.elements.find(
        candidate => candidate.signature === entry.command.target?.signature
      );
      if (
        entry.effect !== 'uncertain' ||
        entry.resolution?.effect === 'none' ||
        this._canPrepareInNewDocument(state, observation, entry, element)
      ) {
        return [];
      }
      return [
        {
          operation: entry.command.command.operation,
          ...(entry.command.target
            ? { signature: entry.command.target.signature }
            : entry.command.command.operation === 'SCROLL'
              ? { targetId: TASK_PAGE_TARGET_ID }
              : {}),
        },
      ];
    }),
  ];

  private readonly _readySubmissionOffers = (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers
  ): TaskOffers => {
    if (
      this._goalViews(state, observation).some(
        view => view.operation !== 'SUBMIT' && !view.satisfied
      )
    ) {
      return offers;
    }
    const submitters = (offers.targets.SUBMIT ?? []).filter(id => {
      const element = observation.elements.find(candidate => candidate.id === id);
      const requirement =
        element && state.goalRequirements.get(this._goalRequirementKey(element, observation));
      return (
        requirement?.operation === 'SUBMIT' &&
        requirement.activated !== true &&
        requirement.argument?.source === 'protocol' &&
        requirement.argument.token === 'CHECKED' &&
        requirement.confidence !== undefined &&
        Number.isFinite(requirement.confidence) &&
        requirement.confidence >= state.floors.argument &&
        requirement.confidence <= 1
      );
    });
    if (submitters.length !== 1) {
      return offers;
    }
    return {
      operations: offers.operations.filter(operation =>
        ['SUBMIT', 'READ', 'WAIT', 'SCROLL', 'BLOCKED'].includes(operation)
      ),
      targets: {
        ...offers.targets,
        SUBMIT: submitters,
        CLICK: [],
        NAVIGATE: [],
        PRESS: [],
        FILL: [],
        SELECT: [],
        SET_CHECKED: [],
      },
    };
  };

  private readonly _savedGoalReady = (state: RunState, observation: TaskObservation): boolean => {
    const requirements = this._goalViews(state, observation);
    return (
      !!state.caps?.freshStateObservations &&
      state.auth?.operations.includes('NAVIGATE') === true &&
      !this._config.options?.verifier &&
      requirements.length > 0 &&
      requirements.every(requirement => requirement.satisfied) &&
      needsPersistenceEvidence({ observation, ledger: state.ledger })
    );
  };

  private readonly _purchaseViewReady = (
    state: RunState,
    observation: TaskObservation
  ): boolean => {
    const purchase = [...state.ledger].reverse().find(entry => entry.effects.includes('purchase'));
    if (
      !purchase ||
      !['applied', 'navigated'].includes(purchase.status) ||
      (observation.documentId === purchase.scope.documentId && observation.url === purchase.url) ||
      this._goalViews(state, observation).some(requirement => !requirement.satisfied)
    ) {
      return false;
    }
    const probe = `${purchase.seq}|${observation.documentId}|${observation.url}`;
    if (state.completionProbe === probe) {
      return false;
    }
    state.completionProbe = probe;
    return true;
  };

  private readonly _actionCall = (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers,
    capabilities: TaskHostCapabilities
  ) =>
    this._deciderCall(state, 'action', context =>
      this._config.decider.chooseAction(
        {
          goal: state.request.goal,
          step: state.usage.steps,
          observation,
          independentRead: this._independentRead(state, observation),
          ...(state.initialPage
            ? { initialPage: safeUrls(state.initialPage, state.redactor) }
            : {}),
          offers,
          goalRequirements: this._goalViews(state, observation),
          submittedControls: safeUrls(state.submittedControls, state.redactor),
          expected: this._expected(state, observation),
          capabilities,
          inputs: this._inputSummaries(state),
          history: this._history(state),
          maxStateBytes: TASK_LIMITS.modelStateBytes,
        },
        context
      )
    );

  private readonly _chooseAction = async (
    state: RunState,
    observation: TaskObservation,
    offers: TaskOffers,
    capabilities: TaskHostCapabilities
  ): Promise<{
    readonly result?: TaskDeciderResult<TaskActionDecision>;
    readonly offers: TaskOffers;
  }> => {
    let first = await this._actionCall(state, observation, offers, capabilities);
    const confirmKey = `${observation.documentId}|${observation.fingerprint}|${state.ledger.length}`;
    if (
      first?.ok &&
      !state.terminal &&
      first.decision.operation === 'BLOCKED' &&
      first.decision.confidence < MAJORITY_CONFIDENCE &&
      !state.blockedConfirmed.has(confirmKey)
    ) {
      state.blockedConfirmed.add(confirmKey);
      const second = await this._actionCall(state, observation, offers, capabilities);
      if (second?.ok && second.decision.operation !== 'BLOCKED') {
        first = second;
      }
    }
    if (!first?.ok || state.terminal || !isTaskHostOperation(first.decision.operation)) {
      return { result: first, offers };
    }
    const action = first.decision;
    const targetId = action.target.kind === 'target' ? action.target.id : undefined;
    if (
      action.operation === 'WAIT' &&
      action.target.kind === 'not_applicable' &&
      action.confidence >= state.floors.action
    ) {
      return { result: first, offers };
    }
    const targets = offers.targets[action.operation];
    const usable = action.target.kind === 'target' && targets?.includes(action.target.id);
    if (usable && action.confidence >= state.floors.action) {
      return { result: first, offers };
    }
    const restricted: Partial<Record<TaskHostOperation, readonly string[]>> = {};
    for (const operation of offers.operations) {
      if (!isTaskHostOperation(operation)) {
        continue;
      }
      const answer = first.exchange.answers?.[`${operation.toLowerCase()}_target`];
      if (
        answer &&
        Number.isFinite(answer.confidence) &&
        answer.confidence >= state.floors.action &&
        answer.confidence <= 1 &&
        offers.targets[operation]?.includes(answer.choice)
      ) {
        restricted[operation] = [answer.choice];
      }
    }
    if (!Object.keys(restricted).length) {
      return { result: first, offers };
    }
    const rejected = this._rejectDecision(
      state,
      action.operation,
      action.target.kind === 'target'
        ? observation.elements.find(element => element.id === targetId)
        : undefined,
      'Reassessing the action among currently offered targets with confident independent judgments.'
    );
    this._emit(state, {
      type: 'decision',
      operation: action.operation,
      confidence: action.confidence,
      ...(action.target.kind === 'target' ? { targetId: action.target.id } : {}),
    });
    if (rejected) {
      state.terminal = rejected;
      return { result: first, offers };
    }
    const narrowed: TaskOffers = {
      operations: offers.operations.filter(
        operation =>
          operation === 'DONE' ||
          operation === 'BLOCKED' ||
          operation === 'WAIT' ||
          (isTaskHostOperation(operation) && !!restricted[operation]?.length)
      ),
      targets: restricted,
    };
    return {
      result: await this._actionCall(state, observation, narrowed, capabilities),
      offers: narrowed,
    };
  };

  private readonly _completionProbeReady = (
    state: RunState,
    observation: TaskObservation
  ): boolean =>
    this._unresolvedControlRefs(state, observation) !== undefined &&
    (this._savedGoalReady(state, observation) || this._purchaseViewReady(state, observation));

  private readonly _probeCompletion = async (
    state: RunState,
    observation: TaskObservation
  ): Promise<{ readonly handled: boolean; readonly result?: TaskResult }> => {
    if (this._completionProbeReady(state, observation)) {
      return { handled: true, result: (await this._gate(state)) ?? state.terminal };
    }
    return {
      handled: false,
      result: (await this._verifyReady(state, observation)) ?? state.terminal,
    };
  };

  private readonly _loop = async (state: RunState): Promise<TaskResult> => {
    for (;;) {
      const stopped = this._wallOrCancel(state);
      if (stopped) {
        return stopped;
      }
      const observation = await this._observe(state);
      if (state.terminal) {
        return state.terminal;
      }
      if (!observation) {
        continue;
      }
      if (state.pendingApproval) {
        const result = (await this._rebindApproval(state, observation)) ?? state.terminal;
        if (result) {
          return result;
        }
        continue;
      }
      const uncertainEntries = new Set(this._unresolved(state));
      if (
        state.ledger.some(
          entry =>
            uncertainEntries.has(entry.seq) &&
            hasCommitment(entry.effects) &&
            entry.status !== 'navigated'
        )
      ) {
        return this._block(
          state,
          'UNCERTAIN_EFFECT',
          'An earlier commitment still has an unresolved effect.'
        );
      }
      if (state.usage.steps >= state.budgets.maxSteps) {
        return this._budgetExceeded(state, 'maxSteps', state.usage.steps);
      }
      if (!(await this._assessRequirements(state, observation))) {
        if (state.terminal) {
          return state.terminal;
        }
        continue;
      }
      const exclusions = this._offerExclusions(state, observation);
      const caps = state.caps ?? fallbackCapabilities;
      let offers = computeOffers({
        observation,
        capabilities: caps,
        allowedOperations: state.auth?.operations ?? [],
        exclude: exclusions,
        allowRunLoss: state.options.allowRunLoss === true,
      });
      offers = this._guardGoalOffers(state, observation, offers);
      offers = this._readySubmissionOffers(state, observation, offers);
      const probe = await this._probeCompletion(state, observation);
      if (probe.result) {
        return probe.result;
      }
      if (probe.handled) {
        continue;
      }
      const prepared = await this._prepareRequiredControl(state, observation, offers);
      if (prepared.handled) {
        const result = prepared.result ?? state.terminal;
        if (result) {
          return result;
        }
        continue;
      }
      const missingInput = this._missingRequiredInput(state, observation, offers);
      if (missingInput) {
        return missingInput;
      }
      if (state.usage.modelCalls >= state.budgets.maxModelCalls) {
        return this._budgetExceeded(state, 'maxModelCalls', state.usage.modelCalls);
      }
      state.usage.steps += 1;
      const chosenAction = await this._chooseAction(state, observation, offers, caps);
      offers = chosenAction.offers;
      const decision = chosenAction.result;
      if (state.terminal) {
        return this._uncertainAfterVerification(state, observation, offers, state.terminal);
      }
      if (!decision || !decision.ok) {
        continue;
      }
      const action = decision.decision;
      const targetId = action.target?.kind === 'target' ? action.target.id : undefined;
      const element = observation.elements.find(candidate => candidate.id === targetId);
      this._emit(state, {
        type: 'decision',
        operation: action.operation,
        ...(targetId ? { targetId } : {}),
        confidence: action.confidence,
      });
      if (
        !offers.operations.includes(action.operation) ||
        !Number.isFinite(action.confidence) ||
        action.confidence < state.floors.action ||
        action.confidence > 1 ||
        action.target?.kind === 'none_appropriate'
      ) {
        const result = this._rejectDecision(
          state,
          action.operation,
          element,
          'The operation, target or confidence was not acceptable.'
        );
        if (result) {
          return this._uncertainAfterVerification(state, observation, offers, result);
        }
        continue;
      }
      if (action.operation === 'DONE') {
        const result = await this._gate(state);
        if (result) {
          return result;
        }
        if (state.terminal) {
          return state.terminal;
        }
        continue;
      }
      if (action.operation === 'BLOCKED') {
        return this._blockedAfterVerification(state, observation);
      }
      if (!isTaskHostOperation(action.operation)) {
        const result = this._rejectDecision(
          state,
          action.operation,
          element,
          'The selected operation is unsupported.'
        );
        if (result) {
          return this._uncertainAfterVerification(state, observation, offers, result);
        }
        continue;
      }
      const operation = action.operation;
      const allowedTargets = offers.targets[operation];
      if (allowedTargets && (!targetId || !allowedTargets.includes(targetId))) {
        const result = this._rejectDecision(
          state,
          operation,
          element,
          'The target was not offered for this operation.'
        );
        if (result) {
          return this._uncertainAfterVerification(state, observation, offers, result);
        }
        continue;
      }
      const spec = describeArgument(operation, element);
      let candidate: TaskArgumentCandidate | undefined;
      let view: TaskArgumentView | undefined;
      if (spec) {
        const candidates = buildCandidates({
          goal: state.request.goal,
          operation,
          slot: spec.slot,
          element,
          observation,
          capabilities: caps,
          leaves: state.leaves,
          resolvers: this._config.options?.resolvers ?? [],
          origins: state.auth?.origins ?? [],
          previews: state.options.inputPreviews !== false,
          limit: TASK_LIMITS.candidates,
        });
        if (!candidates.candidates.length) {
          this._emit(state, { type: 'argument', slot: spec.slot, outcome: 'no_candidates' });
          return this._requirement(
            state,
            operation,
            element,
            candidates.withheld > 0 ? 'input_not_bound' : 'no_candidates',
            spec.slot
          );
        }
        const known = this._knownArgument(
          state,
          observation,
          operation,
          element,
          candidates.candidates
        );
        const chosen = known
          ? { ok: true as const, decision: known }
          : await this._deciderCall(state, 'argument', context =>
              this._config.decider.chooseArgument(
                {
                  goal: state.request.goal,
                  step: state.usage.steps,
                  observation,
                  operation,
                  target: element,
                  slot: spec.slot,
                  candidates: candidateViews(candidates),
                  goalRequirements: this._goalViews(state, observation),
                  submittedControls: safeUrls(state.submittedControls, state.redactor),
                  expected: this._expected(state, observation),
                  inputs: this._inputSummaries(state),
                  history: this._history(state),
                  maxStateBytes: TASK_LIMITS.modelStateBytes,
                },
                context
              )
            );
        if (state.terminal) {
          return state.terminal;
        }
        if (!chosen || !chosen.ok) {
          continue;
        }
        if (chosen.decision.kind === 'uncertain_requirement') {
          const rejected = this._rejectUncertainRequirement(state, operation, element);
          if (rejected) {
            return rejected;
          }
          continue;
        }
        if (chosen.decision.kind !== 'candidate') {
          this._emit(state, {
            type: 'argument',
            slot: spec.slot,
            outcome: 'none_appropriate',
            confidence: chosen.decision.confidence,
          });
          if (['direction', 'duration', 'key', 'checked'].includes(spec.slot)) {
            const rejected = this._protocolArgumentMissing(state, operation, element);
            if (rejected) {
              return this._uncertainAfterVerification(state, observation, offers, rejected);
            }
            continue;
          }
          return this._requirement(state, operation, element, 'none_appropriate', spec.slot);
        }
        const argumentDecision = chosen.decision;
        candidate = candidates.candidates.find(item => item.id === argumentDecision.candidateId);
        if (
          !candidate ||
          !Number.isFinite(argumentDecision.confidence) ||
          argumentDecision.confidence < state.floors.argument ||
          argumentDecision.confidence > 1
        ) {
          const result = this._rejectDecision(
            state,
            operation,
            element,
            'The argument was not offered or its confidence was insufficient.'
          );
          if (result) {
            return this._uncertainAfterVerification(state, observation, offers, result);
          }
          continue;
        }
        view = argumentView(candidate, spec.slot);
        this._emit(state, {
          type: 'argument',
          slot: spec.slot,
          outcome: 'chosen',
          source: candidate.source,
          candidateId: candidate.id,
          confidence: argumentDecision.confidence,
        });
      }
      const compiled = compileCommand({
        goal: state.request.goal,
        observation,
        offers,
        capabilities: caps,
        operation,
        targetId,
        argument: candidate?.ref,
        inputRules: inputRules(state.leaves),
        resolvers: this._config.options?.resolvers ?? [],
        origins: state.auth?.origins ?? [],
      });
      if (!compiled.ok) {
        const result = this._rejectDecision(state, operation, element, compiled.error.code);
        if (result) {
          return this._uncertainAfterVerification(state, observation, offers, result);
        }
        continue;
      }
      const result =
        (await this._processCommand(state, observation, compiled.command, {
          element: compiled.target,
          view,
          optionLabel: compiled.optionLabel,
        })) ?? state.terminal;
      if (result) {
        return result;
      }
    }
  };
  private readonly _createState = (
    request: TaskRequest,
    checkpointData?: TaskCheckpoint,
    resumeOptions?: TaskRunOptions
  ): RunState => {
    const now = this._clock();
    const options =
      resumeOptions ??
      normalizeOptions(request, this._config.options?.run, this._confidenceProfile);
    const inputs = request.inputs ?? {};
    const declarations = request.inputDeclarations ?? [];
    const leaves = flattenInputs(inputs, declarations);
    const secrets = leaves
      .filter(leaf => leaf.sensitive && leaf.scalar !== 'boolean')
      .map(leaf => leaf.value);
    return {
      request: { ...request, goal: typeof request.goal === 'string' ? request.goal : '' },
      runId: checkpointData?.runId ?? request.runId ?? this._createId('run'),
      sessionId: checkpointData?.sessionId ?? this._createId('ses'),
      startedAt: checkpointData?.ledger[0]?.startedAt ?? checkpointData?.createdAt ?? now,
      activeAt: now,
      priorElapsed: checkpointData?.usage.elapsedMs ?? 0,
      options,
      budgets: { ...TASK_DEFAULT_BUDGETS, ...options.budgets },
      ...(options.captureProgressDiagnostics === true
        ? {
            progressDiagnostics: createProgressTracker(
              options.budgets?.maxSteps ?? TASK_DEFAULT_BUDGETS.maxSteps
            ),
          }
        : {}),
      floors: { ...TASK_DEFAULT_CONFIDENCE, ...options.confidence },
      usage: checkpointData ? { ...checkpointData.usage } : zeroUsage(),
      inputs,
      declarations,
      leaves,
      sensitivePaths: checkpointData?.request.sensitivePaths ?? [],
      redactor: createRedactor({ secrets }),
      ledger: [...(checkpointData?.ledger ?? [])],
      history: [...(checkpointData?.history ?? [])].filter(
        entry => entry.detail !== PRIOR_CONTINUATION_MARKER
      ),
      exchanges: [],
      trace: [],
      warnings:
        this._confidenceProfile?.calibrated === false ? [{ code: 'UNCALIBRATED_DECIDER' }] : [],
      submittedControls: [...(checkpointData?.submittedControls ?? [])],
      groupDocuments: new Map(),
      validationAssessed: new Set(),
      viewRestored: new Set(),
      blockedConfirmed: new Set(),
      resampled: new Set(),
      unresolvedRequirements: new Map(),
      primarySubmissionSeq: checkpointData?.primarySubmissionSeq ?? 0,
      goalRequirements: new Map(
        (checkpointData?.goalRequirements ?? [])
          .filter(requirement => !requirement.unavailable)
          .map(requirement => [requirement.key, requirement])
      ),
      ...(checkpointData?.initialPage ? { initialPage: checkpointData.initialPage } : {}),
      ...(checkpointData?.independentDocumentId
        ? { independentDocumentId: checkpointData.independentDocumentId }
        : {}),
      ...(checkpointData ? { auth: checkpointData.request.authorization } : {}),
      ordinal: Math.max(
        0,
        ...(checkpointData?.ledger.map(entry => entry.observationOrdinal) ?? [])
      ),
      startOrigin: checkpointData?.startOrigin ?? '',
      locationTrust: checkpointData?.locationTrust ?? 'page_reported',
      during: 'idle',
      controller: new AbortController(),
      eventSeq: 0,
      exclusions: [],
      repeats: new Set(
        checkpointData?.ledger
          .filter(
            entry =>
              ['applied', 'noop_already_satisfied', 'navigated'].includes(entry.status) &&
              entry.scope.snapshotId === checkpointData.lastObservation?.snapshotId
          )
          .map(
            entry =>
              `${entry.digest}|${checkpointData.lastObservation?.fingerprint}|${checkpointData.lastObservation?.documentId}`
          ) ?? []
      ),
      consumed: new Set(checkpointData?.consumedApprovalIds ?? []),
      resolvedEvents: new Set(),
    };
  };
  private readonly _validateRequest = (
    request: TaskRequest,
    state: RunState
  ): TaskResult | undefined => {
    if (
      typeof request.goal !== 'string' ||
      !request.goal.trim() ||
      new TextEncoder().encode(request.goal).byteLength > TASK_LIMITS.goalBytes ||
      (request.startUrl !== undefined && originOf(request.startUrl) === undefined) ||
      !jsonData(request.inputs ?? {}) ||
      hasUnsafeKey(request.inputs) ||
      !jsonData(request.inputDeclarations ?? []) ||
      hasUnsafeKey(request.inputDeclarations) ||
      !jsonData(request.authorization ?? {}) ||
      hasUnsafeKey(request.authorization) ||
      !validOptions(request.options) ||
      !validOptions(this._config.options?.run) ||
      !jsonData(request.expect ?? {}) ||
      !jsonData(request.profile ?? {}) ||
      !jsonData(request.priorEffects ?? []) ||
      state.declarations.some(
        declaration =>
          typeof declaration.path !== 'string' ||
          !declaration.path ||
          typeof declaration.sensitive !== 'boolean' ||
          !descriptionValid(declaration.description) ||
          (declaration.bind?.requireSensitiveElement === false && !declaration.bind.origins?.length)
      ) ||
      new Set(state.declarations.map(declaration => declaration.path)).size !==
        state.declarations.length ||
      (this._config.options?.resolvers ?? []).some(
        resolver =>
          typeof resolver.id !== 'string' ||
          !resolver.id ||
          !descriptionValid(resolver.description) ||
          typeof resolver.sensitive !== 'boolean' ||
          !Array.isArray(resolver.slots) ||
          typeof resolver.resolve !== 'function'
      )
    ) {
      return this._fail(state, 'INVALID_REQUEST', 'The task request is invalid.');
    }
    const secrets = state.leaves.filter(leaf => leaf.sensitive && leaf.scalar !== 'boolean');
    if (
      createRedactor({
        secrets: secrets.filter(leaf => leaf.value.length >= 4).map(leaf => leaf.value),
      }).scrub(request.goal) !== request.goal
    ) {
      return this._fail(
        state,
        'GOAL_CONTAINS_SECRET',
        'The literal goal contains a declared sensitive value.'
      );
    }
    for (const leaf of secrets.filter(item => item.value.length < 4)) {
      state.warnings.push({ code: 'SHORT_SENSITIVE_INPUT', detail: leaf.path });
    }
    return undefined;
  };
  private readonly _finish = (state: RunState, result: TaskResult): TaskResult => {
    this._emit(state, { type: 'finished', status: result.status });
    return safeUrls(
      { ...result, ...(state.options.captureTrace ? { trace: [...state.trace] } : {}) },
      state.redactor
    );
  };
  private readonly _invoke = async (
    state: RunState,
    signal: AbortSignal | undefined,
    prepare?: () => TaskResult | undefined
  ): Promise<TaskResult> => {
    if (this._active) {
      const result = this._fail(state, 'RUN_IN_PROGRESS', 'This agent already has an active run.');
      return result;
    }
    this._active = state;
    const onAbort = (): void => state.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    let result: TaskResult;
    try {
      const stopped = this._wallOrCancel(state);
      const invalidRequest = this._validateRequest(state.request, state);
      const prepared = !stopped && !invalidRequest ? prepare?.() : undefined;
      if (stopped || invalidRequest || prepared) {
        result =
          stopped ??
          invalidRequest ??
          prepared ??
          this._fail(state, 'INTERNAL', 'Initialization failed.');
      } else if (!(await this._readCapabilities(state))) {
        result = state.terminal ?? this._fail(state, 'HOST_FAILED', 'Capabilities unavailable.');
      } else {
        if (!state.caps?.authoritativeLocation) {
          state.warnings.push({ code: 'LOCATION_UNVERIFIED' });
        }
        this._emit(state, {
          type: 'run_started',
          resumed: prepare !== undefined,
          goal: state.request.goal,
          sessionId: state.sessionId,
        });
        result = await this._loop(state);
      }
    } catch (error: unknown) {
      result = state.controller.signal.aborted
        ? this._cancelled(state)
        : this._fail(state, 'INTERNAL', errorText(error));
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this._config.host.release) {
        const release = this._config.host.release;
        await this._boundary(
          state,
          async () => release(state.sessionId),
          TASK_DEFAULT_TIMEOUTS.hookMs,
          true
        );
      }
      this._active = undefined;
    }
    return this._finish(state, result);
  };
  private readonly _validCheckpoint = (value: unknown): value is TaskCheckpoint => {
    if (!jsonData(value) || hasUnsafeKey(value) || value === null || typeof value !== 'object') {
      return false;
    }
    const checkpointData = value as TaskCheckpoint;
    if (
      checkpointData.version !== 1 ||
      typeof checkpointData.id !== 'string' ||
      typeof checkpointData.integrity !== 'string' ||
      typeof checkpointData.runId !== 'string' ||
      typeof checkpointData.sessionId !== 'string' ||
      !finiteNonnegative(checkpointData.createdAt) ||
      !checkpointData.request ||
      typeof checkpointData.request.goal !== 'string' ||
      !checkpointData.request.authorization ||
      !Array.isArray(checkpointData.ledger) ||
      !Array.isArray(checkpointData.history) ||
      !Array.isArray(checkpointData.consumedApprovalIds) ||
      (checkpointData.goalRequirements !== undefined &&
        (!Array.isArray(checkpointData.goalRequirements) ||
          checkpointData.goalRequirements.some(
            requirement =>
              !requirement ||
              typeof requirement !== 'object' ||
              (requirement.activationWitness !== undefined &&
                !this._validActivationWitness(requirement.activationWitness))
          ))) ||
      !checkpointData.usage ||
      Object.keys(zeroUsage()).some(
        key => !finiteNonnegative(checkpointData.usage[key as keyof TaskBudgetUsage])
      ) ||
      !checkpointData.pending ||
      !['needs_input', 'awaiting_approval', 'uncertain_effect'].includes(
        checkpointData.pending.kind
      )
    ) {
      return false;
    }
    const { integrity, ...unsigned } = checkpointData;
    const expected = this._sign(unsigned);
    return (
      expected === integrity &&
      (this._config.options?.checkpointKey !== undefined ||
        this._registry.get(checkpointData.id) === integrity)
    );
  };
  private readonly _run = async (
    request: TaskRequest,
    signal?: AbortSignal
  ): Promise<TaskResult> => {
    let state: RunState | undefined;
    try {
      state = this._createState(request);
      if (this._confidenceProfileInvalid) {
        return this._fail(state, 'INVALID_REQUEST', 'The decider configuration is invalid.');
      }
      if (
        !validProgressOption(request.options) ||
        !validProgressOption(this._config.options?.run)
      ) {
        return this._fail(state, 'INVALID_REQUEST', 'The progress diagnostics option is invalid.');
      }
      return await this._invoke(state, signal);
    } catch {
      const sentinel =
        state ?? this._createState({ goal: typeof request?.goal === 'string' ? request.goal : '' });
      return this._fail(sentinel, 'INVALID_REQUEST', 'The task request could not be initialized.');
    }
  };
  private readonly _resume = async (
    request: TaskResumeRequest,
    signal?: AbortSignal
  ): Promise<TaskResult> => {
    let state: RunState | undefined;
    try {
      if (this._confidenceProfileInvalid) {
        return this._fail(
          this._createState({ goal: '' }),
          'INVALID_REQUEST',
          'The decider configuration is invalid.'
        );
      }
      if (!this._validCheckpoint(request.checkpoint)) {
        return this._fail(
          this._createState({ goal: '' }),
          'CHECKPOINT_INVALID',
          'Checkpoint integrity or shape is invalid.'
        );
      }
      const saved = request.checkpoint;
      if (
        saved.history.some(entry => entry.detail === PRIOR_CONTINUATION_MARKER) &&
        !this._checkpointPriorEffects.has(saved.id)
      ) {
        return this._fail(
          this._createState({ goal: saved.request.goal }),
          'CHECKPOINT_INVALID',
          'Prior effect context is unavailable in this agent instance.'
        );
      }
      if (
        !validOptions(request.options) ||
        !jsonData(request.inputs ?? {}) ||
        hasUnsafeKey(request.inputs) ||
        !jsonData(request.resolution) ||
        hasUnsafeKey(request.resolution)
      ) {
        return this._fail(
          this._createState({ goal: saved.request.goal }),
          'INVALID_REQUEST',
          'Resume data is invalid.'
        );
      }
      const inputResolution = request.resolution.kind === 'inputs' ? request.resolution : undefined;
      const inputs = mergeInputs(
        mergeInputs(saved.request.inputs, request.inputs ?? {}),
        inputResolution?.inputs ?? {}
      );
      const declarationMap = new Map(
        saved.request.inputDeclarations.map(declaration => [declaration.path, declaration])
      );
      for (const declaration of inputResolution?.inputDeclarations ?? []) {
        declarationMap.set(declaration.path, declaration);
      }
      const savedOptions = this._confidenceProfile?.floors
        ? tightenOptions(saved.request.options, { confidence: this._confidenceProfile.floors })
        : saved.request.options;
      const options = tightenOptions(savedOptions, request.options);
      const taskRequest: TaskRequest = {
        goal: saved.request.goal,
        startUrl: saved.request.startUrl,
        inputs,
        inputDeclarations: [...declarationMap.values()],
        expect: saved.request.expect,
        profile: saved.request.profile,
        options,
        runId: saved.runId,
        priorEffects: this._checkpointPriorEffects.get(saved.id),
      };
      state = this._createState(taskRequest, saved, options);
      state.sensitivePaths = state.sensitivePaths.filter(
        path => !request.omitSensitivePaths?.includes(path)
      );
      const current = state;
      return await this._invoke(current, signal, () => {
        const resolution = request.resolution;
        const pending = saved.pending;
        if (
          (pending.kind === 'needs_input' && resolution.kind !== 'inputs') ||
          (pending.kind === 'awaiting_approval' && resolution.kind !== 'approval') ||
          (pending.kind === 'uncertain_effect' && resolution.kind !== 'effect')
        ) {
          return this._fail(
            current,
            'RESOLUTION_MISMATCH',
            'The resolution does not match the checkpoint pause.'
          );
        }
        const missingPaths = saved.request.sensitivePaths.filter(
          path =>
            !current.leaves.some(leaf => leaf.path === path) &&
            !request.omitSensitivePaths?.includes(path)
        );
        if (missingPaths.length) {
          return this._needsInput(
            current,
            missingPaths.map(path => ({
              id: this._createId('req'),
              kind: 'sensitive_input',
              inputPath: path,
              description: 'Supply the sensitive input again to resume.',
              reason: 'input_missing',
            }))
          );
        }
        if (resolution.kind === 'effect') {
          const entry = current.ledger.find(item => item.seq === resolution.ledgerSeq);
          if (
            !entry ||
            entry.effect !== 'uncertain' ||
            entry.resolution ||
            (pending.kind === 'uncertain_effect' && !pending.entries.includes(entry.seq))
          ) {
            return this._fail(
              current,
              'RESOLUTION_MISMATCH',
              'The ledger entry is not awaiting an effect resolution.'
            );
          }
          const effectResolution = {
            seq: entry.seq,
            by: 'caller' as const,
            effect: resolution.resolution === 'applied' ? ('applied' as const) : ('none' as const),
          };
          current.ledger = current.ledger.map(item =>
            item.seq === entry.seq ? { ...item, resolution: effectResolution } : item
          );
          this._emit(current, { type: 'effect_resolved', ...effectResolution });
          this._updateResolutions(current);
        }
        if (resolution.kind === 'approval' && pending.kind === 'awaiting_approval') {
          const approval = pending.approval;
          const answer = resolution.resolution;
          const approvalFailure = (
            code: TaskFailureCode,
            phase: Extract<
              TaskEventBody,
              {
                readonly type: 'approval';
              }
            >['phase']
          ): TaskResult => {
            this._emit(current, {
              type: 'approval',
              phase,
              approvalId: approval.id,
              digest: approval.digest,
            });
            return this._fail(current, code, 'The approval resolution was refused.');
          };
          if (current.consumed.has(approval.id) || this._consumedApprovals.has(approval.id)) {
            return approvalFailure('APPROVAL_CONSUMED', 'consumed');
          }
          if (this._clock() > approval.expiresAt) {
            return approvalFailure('APPROVAL_EXPIRED', 'expired');
          }
          if (
            answer.approvalId !== approval.id ||
            answer.nonce !== approval.nonce ||
            answer.digest !== approval.digest ||
            answer.contextDigest !== approval.contextDigest ||
            !['approve', 'deny'].includes(answer.decision) ||
            (answer.maxUses !== undefined &&
              (!finiteNonnegative(answer.maxUses) || !Number.isInteger(answer.maxUses)))
          ) {
            return approvalFailure('APPROVAL_MISMATCH', 'mismatch');
          }
          if (answer.decision === 'deny') {
            this._emit(current, {
              type: 'approval',
              phase: 'denied',
              approvalId: approval.id,
              digest: approval.digest,
            });
            return this._block(current, 'POLICY_DENIED', 'The caller denied the pending command.');
          }
          current.pendingApproval = pending;
          current.approvalResolution = answer;
        }
        return undefined;
      });
    } catch {
      return this._fail(
        state ?? this._createState({ goal: '' }),
        'CHECKPOINT_INVALID',
        'The checkpoint could not be resumed.'
      );
    }
  };
  get agent(): TaskAgent {
    return {
      run: this._run,
      resume: this._resume,
      cancel: (runId?: string): boolean => {
        if (!this._active || (runId !== undefined && this._active.runId !== runId)) {
          return false;
        }
        this._active.controller.abort('The caller cancelled the run.');
        return true;
      },
    };
  }
}
export const createTaskAgent: TaskCreateAgentFn = config => new CoordinatorRuntime(config).agent;
const fallbackCapabilities: TaskHostCapabilities = {
  hostKind: 'custom',
  protocol: '',
  operations: [],
  persistsAcrossNavigation: false,
  detectsNavigation: false,
  cancellation: 'cooperative',
  redaction: { observations: false, executionEvents: false },
  strictTargets: false,
  scrollContainers: false,
  implicitSubmitDetection: false,
  authoritativeLocation: false,
  isolatedWorld: false,
  maxElements: TASK_LIMITS.observedElements,
  keys: [],
  waitDurationsMs: [],
};
