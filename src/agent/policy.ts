import {
  TASK_CLASSIFIED_OPERATIONS,
  TASK_COMMITMENT_EFFECT,
  TASK_COMMITMENT_EFFECTS,
  TASK_EFFECTS,
  TASK_ROUTINE_EFFECTS,
  isTaskCommitmentClass,
  isTaskCommitmentEffect,
  isTaskHostOperation,
} from '@/types';
import type {
  TaskAddRunGrantsFn,
  TaskAllCommitmentsGrantedFn,
  TaskClassifyInput,
  TaskCommand,
  TaskCommitBasis,
  TaskCommitHint,
  TaskCommitmentEffect,
  TaskConsumeGrantsFn,
  TaskCreatePolicyFn,
  TaskEffectForCommitmentFn,
  TaskEffectKind,
  TaskElement,
  TaskForm,
  TaskHostOperation,
  TaskKey,
  TaskMergeEffectsFn,
  TaskNormalizeAuthorizationFn,
  TaskNormalizedAuthorization,
  TaskNormalizedGrant,
  TaskPolicyDecision,
  TaskPolicyInput,
  TaskPolicyOptions,
  TaskRoutineEffect,
  TaskSignature,
  TaskStructuralClassification,
} from '@/types';

type Reader = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null;

const asArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

const unique = <T>(values: readonly T[]): readonly T[] => Array.from(new Set(values));

const httpOrigin = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const normalizeOrigins = (values: readonly unknown[]): readonly string[] => {
  const origins: string[] = [];
  for (const value of values) {
    const origin = httpOrigin(value);
    if (origin !== null && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
};

const isRoutine = (effect: TaskEffectKind): effect is TaskRoutineEffect =>
  (TASK_ROUTINE_EFFECTS as readonly string[]).includes(effect);

// ---------------------------------------------------------------------------------------------
// Effect helpers
// ---------------------------------------------------------------------------------------------

const KNOWN_EFFECTS: readonly string[] = TASK_EFFECTS;

const isKnownEffect = (effect: unknown): effect is TaskEffectKind =>
  typeof effect === 'string' && KNOWN_EFFECTS.includes(effect);

// A kind outside TASK_EFFECTS is a decider, hook or checkpoint defect: it must never vanish into "routine".
export const mergeEffects: TaskMergeEffectsFn = (...groups) => {
  const present = new Set<TaskEffectKind>();
  for (const group of groups) {
    for (const effect of group) {
      present.add(isKnownEffect(effect) ? effect : 'other_commitment');
    }
  }
  return TASK_EFFECTS.filter(effect => present.has(effect));
};

// An unknown class is a decider or hook defect: it must never read as "no commitment".
export const effectForCommitment: TaskEffectForCommitmentFn = commitment => {
  if (commitment === 'NONE') {
    return null;
  }
  return isTaskCommitmentClass(commitment)
    ? TASK_COMMITMENT_EFFECT[commitment]
    : 'other_commitment';
};

const hintEffects = (hints: readonly TaskCommitHint[]): readonly TaskEffectKind[] =>
  hints.flatMap(hint => {
    const effect = effectForCommitment(hint.class);
    return effect === null ? [] : [effect];
  });

// ---------------------------------------------------------------------------------------------
// Structural classification
// ---------------------------------------------------------------------------------------------

type Structural = {
  readonly base: readonly TaskEffectKind[];
  /** Every hint that contributed, for the report. */
  readonly hints: readonly TaskCommitHint[];
  /** The hints whose class becomes an effect. Enter reports an implicit_submit_field hint but adds form_submit for it. */
  readonly classHints: readonly TaskCommitHint[];
};

const structure = (
  base: readonly TaskEffectKind[],
  hints: readonly TaskCommitHint[]
): Structural => ({ base, hints, classHints: hints });

const KNOWN_BASES: readonly TaskCommitBasis[] = [
  'submit_control',
  'implicit_submit_field',
  'declared_marker',
];

const hintsWith = (
  hints: readonly TaskCommitHint[],
  bases: readonly TaskCommitBasis[]
): readonly TaskCommitHint[] => hints.filter(hint => bases.includes(hint.basis));

// A basis this version does not know (a newer host) is never ignored: its class counts on every operation.
const pick = (
  hints: readonly TaskCommitHint[],
  bases: readonly TaskCommitBasis[]
): readonly TaskCommitHint[] =>
  hints.filter(hint => bases.includes(hint.basis) || !KNOWN_BASES.includes(hint.basis));

const pressStructure = (
  key: TaskKey,
  hints: readonly TaskCommitHint[],
  form: TaskForm | undefined
): Structural => {
  if (key === 'Enter') {
    const implicitHints = hintsWith(hints, ['implicit_submit_field']);
    const implicit = implicitHints.length > 0 || form?.implicitSubmit === true;
    const classHints = pick(hints, ['declared_marker', 'submit_control']);
    return {
      base: implicit ? ['interact', 'form_submit'] : ['interact'],
      hints: [...classHints, ...implicitHints],
      classHints,
    };
  }
  const bases: readonly TaskCommitBasis[] =
    key === 'Space' ? ['declared_marker', 'submit_control'] : ['declared_marker'];
  return structure(['interact'], pick(hints, bases));
};

const structureOf = (
  command: TaskCommand,
  element: TaskElement | undefined,
  form: TaskForm | undefined
): Structural => {
  const hints = element?.commitHints ?? [];
  switch (command.operation) {
    case 'READ':
      return structure(['read'], []);
    case 'NAVIGATE':
      return structure(['navigate'], pick(hints, ['declared_marker']));
    case 'CLICK':
      return structure(['interact'], pick(hints, ['declared_marker', 'submit_control']));
    case 'SUBMIT':
      return structure(['form_submit'], hints);
    case 'FILL':
      return structure(['input'], pick(hints, ['declared_marker']));
    case 'SELECT':
      return structure(['select'], pick(hints, ['declared_marker']));
    case 'SET_CHECKED':
      return structure(['toggle'], pick(hints, ['declared_marker']));
    case 'PRESS':
      return pressStructure(command.key, hints, form);
    case 'SCROLL':
      return structure(['scroll'], []);
    case 'WAIT':
      return structure(['wait'], []);
    default:
      return structure(['other_commitment'], []);
  }
};

const promoteEffects = (
  effects: readonly TaskEffectKind[],
  promotion: TaskPolicyOptions['promoteEffects']
): readonly TaskEffectKind[] => {
  if (promotion === undefined) {
    return effects;
  }
  return effects.map(effect => {
    if (!isRoutine(effect) || !Object.prototype.hasOwnProperty.call(promotion, effect)) {
      return effect;
    }
    const mapped: unknown = promotion[effect];
    return typeof mapped === 'string' && isTaskCommitmentEffect(mapped)
      ? mapped
      : 'other_commitment';
  });
};

type HookResult = { readonly effect: TaskCommitmentEffect | null; readonly error: boolean };

const runHook = (
  hook: NonNullable<TaskPolicyOptions['classify']>,
  input: TaskClassifyInput
): HookResult => {
  try {
    const answer: unknown = hook(input);
    if (answer === null || answer === 'NONE') {
      return { effect: null, error: false };
    }
    if (typeof answer === 'string' && isTaskCommitmentClass(answer)) {
      return { effect: effectForCommitment(answer), error: false };
    }
  } catch {
    // A throwing hook is handled below exactly like an unusable answer.
  }
  return { effect: 'other_commitment', error: true };
};

const failClosed = (): TaskStructuralClassification => ({
  effects: ['other_commitment'],
  hints: [],
  needsClassification: true,
  classifierError: true,
});

const classifyStructurally = (
  input: TaskClassifyInput,
  options: TaskPolicyOptions,
  classifyOperations: readonly TaskHostOperation[]
): TaskStructuralClassification => {
  if (!isRecord(input) || !isRecord(input.command) || !isRecord(input.observation)) {
    return failClosed();
  }
  const { command, element, observation } = input;
  const formId = element?.formId;
  const form =
    formId === undefined ? undefined : observation.forms.find(candidate => candidate.id === formId);
  const structural = structureOf(command, element, form);
  const needsClassification = classifyOperations.includes(command.operation);
  const hook =
    needsClassification && options.classify !== undefined
      ? runHook(options.classify, input)
      : { effect: null, error: false };
  return {
    effects: mergeEffects(
      promoteEffects(
        [...structural.base, ...hintEffects(structural.classHints)],
        options.promoteEffects
      ),
      hook.effect === null ? [] : [hook.effect]
    ),
    hints: structural.hints,
    needsClassification,
    classifierError: hook.error,
  };
};

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

const FORM_ACTION_OPERATIONS: readonly TaskHostOperation[] = ['SUBMIT', 'PRESS', 'CLICK'];

const destinationsOf = (input: TaskPolicyInput): readonly string[] => {
  const { element, form, command } = input;
  const urls: string[] = [];
  if (element?.href !== undefined) {
    urls.push(element.href);
  }
  if (element?.formTarget !== undefined) {
    urls.push(element.formTarget.action);
  }
  if (form?.action !== undefined && FORM_ACTION_OPERATIONS.includes(command.operation)) {
    urls.push(form.action);
  }
  return urls;
};

const sharedPendingEffects = (
  input: TaskPolicyInput,
  commitments: readonly TaskCommitmentEffect[]
): readonly TaskCommitmentEffect[] => {
  const signature = input.element?.signature;
  const formId = input.element?.formId ?? input.form?.id;
  const shared = new Set<TaskCommitmentEffect>();
  for (const pending of input.pendingCommitments) {
    const sameSignature = signature !== undefined && pending.signature === signature;
    const sameForm =
      formId !== undefined && pending.formId === formId && pending.documentId === input.documentId;
    if (sameSignature || sameForm) {
      for (const effect of pending.effects) {
        if (commitments.includes(effect)) {
          shared.add(effect);
        }
      }
    }
  }
  return TASK_COMMITMENT_EFFECTS.filter(effect => shared.has(effect));
};

type GrantContext = {
  readonly now: number;
  readonly origin: string;
  readonly signature: TaskSignature | undefined;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

// A grant is trusted only in its normalized shape: a counter or list of another type covers nothing.
const withinUses = (grant: TaskNormalizedGrant): boolean =>
  grant.maxUses === null ||
  (isCount(grant.maxUses) && isCount(grant.used) && grant.used < grant.maxUses);

const beforeExpiry = (grant: TaskNormalizedGrant, now: number): boolean =>
  grant.expiresAt === null || (typeof grant.expiresAt === 'number' && now < grant.expiresAt);

const coversSignature = (
  grant: TaskNormalizedGrant,
  signature: TaskSignature | undefined
): boolean => {
  if (grant.signatures === null) {
    return true;
  }
  const listed = asArray(grant.signatures);
  return signature !== undefined && listed !== undefined && listed.includes(signature);
};

const isActive = (grant: TaskNormalizedGrant, context: GrantContext): boolean =>
  withinUses(grant) &&
  beforeExpiry(grant, context.now) &&
  (asArray(grant.origins) ?? []).includes(context.origin) &&
  coversSignature(grant, context.signature);

type Coverage = {
  readonly missing: readonly TaskCommitmentEffect[];
  readonly grants: readonly number[];
};

// A form_submit rides on another commitment effect only when the same command carries it.
const coverCommitments = (
  grants: readonly TaskNormalizedGrant[],
  commitments: readonly TaskCommitmentEffect[],
  context: GrantContext
): Coverage => {
  const own = new Map<TaskCommitmentEffect, number>();
  for (const effect of commitments) {
    const index = grants.findIndex(grant => grant.effect === effect && isActive(grant, context));
    if (index >= 0) {
      own.set(effect, index);
    }
  }
  const riding = commitments.some(effect => effect !== 'form_submit' && own.has(effect));
  const missing = commitments.filter(
    effect => !own.has(effect) && !(effect === 'form_submit' && riding)
  );
  return { missing, grants: Array.from(own.values()).sort((left, right) => left - right) };
};

const deny = (
  effects: readonly TaskEffectKind[],
  reason: Extract<TaskPolicyDecision, { readonly verdict: 'deny' }>['reason']
): TaskPolicyDecision => ({ verdict: 'deny', effects: [...effects], reason });

const requireApproval = (
  effects: readonly TaskEffectKind[],
  missing: readonly TaskCommitmentEffect[],
  reason: 'commitment_not_granted' | 'uncertain_commitment_pending'
): TaskPolicyDecision => ({
  verdict: 'require_approval',
  effects: [...effects],
  missing,
  reason,
});

const unauthorized = (
  denyUnauthorized: boolean,
  effects: readonly TaskEffectKind[],
  missing: readonly TaskCommitmentEffect[],
  reason: 'commitment_not_granted' | 'uncertain_commitment_pending'
): TaskPolicyDecision =>
  denyUnauthorized
    ? deny(effects, 'commitment_not_granted')
    : requireApproval(effects, missing, reason);

const checkBoundary = (
  input: TaskPolicyInput,
  pageOrigin: string | null
): TaskPolicyDecision | null => {
  const { authorization, effects } = input;
  // includes() on a string is a substring test: only a real list may act as an allow-list.
  const operations: readonly unknown[] = asArray(authorization.operations) ?? [];
  const origins: readonly unknown[] = asArray(authorization.origins) ?? [];
  if (!operations.includes(input.command.operation)) {
    return deny(effects, 'operation_not_allowed');
  }
  if (pageOrigin === null || !origins.includes(pageOrigin)) {
    return deny(effects, 'origin_not_allowed');
  }
  const destinations = destinationsOf(input);
  if (destinations.some(url => httpOrigin(url) === null)) {
    return deny(effects, 'scheme_not_allowed');
  }
  const outside = destinations.some(url => !origins.includes(httpOrigin(url) ?? ''));
  return outside ? deny(effects, 'origin_not_allowed') : null;
};

// An effect kind outside TASK_EFFECTS counts as other_commitment instead of reading as routine.
const commitmentsOf = (effects: readonly TaskEffectKind[]): readonly TaskCommitmentEffect[] => {
  const unknown = effects.some(effect => !isKnownEffect(effect));
  return TASK_COMMITMENT_EFFECTS.filter(
    effect => effects.includes(effect) || (unknown && effect === 'other_commitment')
  );
};

const isDigest = (value: unknown): value is string => typeof value === 'string' && value !== '';

// Two missing digests are equal under ===: only two real ones bind an approval.
const isApprovedOnce = (input: TaskPolicyInput): boolean => {
  const approved: unknown = input.approvedOnce;
  if (!isRecord(approved)) {
    return false;
  }
  const { digest, contextDigest } = approved as Reader;
  return (
    isDigest(digest) &&
    isDigest(contextDigest) &&
    digest === input.digest &&
    contextDigest === input.contextDigest
  );
};

const evaluateRows = (input: TaskPolicyInput, denyUnauthorized: boolean): TaskPolicyDecision => {
  const pageOrigin = httpOrigin(input.pageUrl);
  const boundary = checkBoundary(input, pageOrigin);
  if (boundary !== null || pageOrigin === null) {
    return boundary ?? deny(input.effects, 'origin_not_allowed');
  }
  const { effects, authorization } = input;
  const commitments = commitmentsOf(effects);
  if (commitments.length === 0) {
    return { verdict: 'allow', effects: [...effects], reason: 'routine', grants: [] };
  }
  if (isApprovedOnce(input)) {
    return { verdict: 'allow', effects: [...effects], reason: 'approved_once', grants: [] };
  }
  const pending = sharedPendingEffects(input, commitments);
  if (pending.length > 0) {
    return unauthorized(denyUnauthorized, effects, pending, 'uncertain_commitment_pending');
  }
  const coverage = coverCommitments(authorization.grants, commitments, {
    now: input.now,
    origin: pageOrigin,
    signature: input.element?.signature,
  });
  if (coverage.missing.length === 0) {
    return { verdict: 'allow', effects: [...effects], reason: 'granted', grants: coverage.grants };
  }
  return unauthorized(denyUnauthorized, effects, coverage.missing, 'commitment_not_granted');
};

const evaluateSafely = (input: TaskPolicyInput, denyUnauthorized: boolean): TaskPolicyDecision => {
  try {
    return evaluateRows(input, denyUnauthorized);
  } catch {
    return deny([], 'commitment_not_granted');
  }
};

export const createTaskPolicy: TaskCreatePolicyFn = (options = {}) => {
  const classifyOperations = options.classifyOperations ?? TASK_CLASSIFIED_OPERATIONS;
  const denyUnauthorized = options.onUnauthorized === 'deny';
  return {
    classify: input => {
      try {
        return classifyStructurally(input, options, classifyOperations);
      } catch {
        return failClosed();
      }
    },
    evaluate: input => evaluateSafely(input, denyUnauthorized),
  };
};

// ---------------------------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------------------------

// Malformed limits fail closed: a grant that cannot be read covers nothing.
const normalizeMaxUses = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
};

const normalizeExpiry = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const normalizeSignatures = (value: unknown): readonly TaskSignature[] | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return unique(
    (asArray(value) ?? []).filter((entry): entry is string => typeof entry === 'string')
  );
};

const bareGrant = (
  effect: TaskCommitmentEffect,
  origins: readonly string[]
): TaskNormalizedGrant => ({
  effect,
  origins: [...origins],
  maxUses: null,
  used: 0,
  expiresAt: null,
  signatures: null,
});

const normalizeGrantEntry = (
  entry: unknown,
  runOrigins: readonly string[]
): readonly TaskNormalizedGrant[] => {
  if (typeof entry === 'string') {
    return isTaskCommitmentEffect(entry) ? [bareGrant(entry, runOrigins)] : [];
  }
  if (!isRecord(entry)) {
    return [];
  }
  const record = entry as Reader;
  const effect = record.effect;
  if (typeof effect !== 'string' || !isTaskCommitmentEffect(effect)) {
    return [];
  }
  return [
    {
      effect,
      origins:
        record.origins === undefined
          ? [...runOrigins]
          : normalizeOrigins(asArray(record.origins) ?? []),
      maxUses: normalizeMaxUses(record.maxUses),
      used: 0,
      expiresAt: normalizeExpiry(record.expiresAt),
      signatures: normalizeSignatures(record.signatures),
    },
  ];
};

const grantKey = (grant: TaskNormalizedGrant): string =>
  JSON.stringify([
    grant.effect,
    [...grant.origins].sort(),
    grant.maxUses,
    grant.expiresAt,
    grant.signatures === null ? null : [...grant.signatures].sort(),
  ]);

const collapseGrants = (grants: readonly TaskNormalizedGrant[]): readonly TaskNormalizedGrant[] => {
  const seen = new Set<string>();
  return grants.filter(grant => {
    const key = grantKey(grant);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const isHostOperation = (value: unknown): value is TaskHostOperation =>
  typeof value === 'string' && isTaskHostOperation(value);

// Left out (undefined or null) means the host's operations; any other non-list is a typo that must not widen.
const normalizeOperations = (
  requested: unknown,
  hostOperations: readonly unknown[]
): readonly TaskHostOperation[] => {
  const fromHost = hostOperations.filter(isHostOperation);
  if (requested === undefined || requested === null) {
    return fromHost;
  }
  const listed = asArray(requested) ?? [];
  return unique(listed.filter(isHostOperation).filter(operation => fromHost.includes(operation)));
};

export const normalizeAuthorization: TaskNormalizeAuthorizationFn = (
  authorization,
  startOrigin,
  capabilities
) => {
  const input = (isRecord(authorization) ? authorization : {}) as Reader;
  const hostOperations: readonly unknown[] = asArray(capabilities?.operations) ?? [];
  const operations = normalizeOperations(input.operations, hostOperations);
  const requestedOrigins = asArray(input.origins);
  const origins = normalizeOrigins(
    requestedOrigins === undefined ? [startOrigin] : requestedOrigins
  );
  const grants = collapseGrants(
    (asArray(input.effects) ?? []).flatMap(entry => normalizeGrantEntry(entry, origins))
  );
  return {
    operations,
    origins,
    grants,
    assumeUnclassifiedRoutine: input.assumeUnclassifiedRoutine === true,
  };
};

export const addRunGrants: TaskAddRunGrantsFn = (authorization, effects, origin, maxUses) => {
  const pageOrigin = httpOrigin(origin);
  if (pageOrigin === null) {
    return { ...authorization, grants: [...authorization.grants] };
  }
  const uses = Number.isFinite(maxUses) ? Math.max(0, Math.floor(maxUses)) : 0;
  const added = unique(effects.filter(effect => isTaskCommitmentEffect(effect))).map(
    (effect): TaskNormalizedGrant => ({
      effect,
      origins: [pageOrigin],
      maxUses: uses,
      used: 0,
      expiresAt: null,
      signatures: null,
    })
  );
  return { ...authorization, grants: [...authorization.grants, ...added] };
};

export const consumeGrants: TaskConsumeGrantsFn = (authorization, indexes) => {
  const consumed = new Set(
    indexes.filter(
      index => Number.isInteger(index) && index >= 0 && index < authorization.grants.length
    )
  );
  return {
    ...authorization,
    grants: authorization.grants.map((grant, index) =>
      consumed.has(index) ? { ...grant, used: grant.used + 1 } : grant
    ),
  };
};

const isUnrestricted = (grant: TaskNormalizedGrant, runOrigins: readonly string[]): boolean =>
  grant.maxUses === null &&
  grant.expiresAt === null &&
  grant.signatures === null &&
  runOrigins.every(origin => grant.origins.includes(origin));

export const allCommitmentsGranted: TaskAllCommitmentsGrantedFn = (
  authorization: TaskNormalizedAuthorization
) =>
  TASK_COMMITMENT_EFFECTS.every(effect =>
    authorization.grants.some(
      grant => grant.effect === effect && isUnrestricted(grant, authorization.origins)
    )
  );
