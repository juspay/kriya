import { TASK_COMMITMENT_EFFECTS, TASK_LIMITS, TASK_NONE_APPROPRIATE } from '@/types';
import type {
  TaskAnswer,
  TaskCheckPostconditionsFn,
  TaskCollectEvidenceFn,
  TaskCollectedEvidence,
  TaskCompletionDecision,
  TaskCompletionFromReportFn,
  TaskCompletionBasis,
  TaskCreateLedgerEntryFn,
  TaskDerivePostconditionsFn,
  TaskEffectKind,
  TaskEffectResolution,
  TaskElement,
  TaskSubmittedControl,
  TaskEvaluateGateFn,
  TaskEvidence,
  TaskEvidenceState,
  TaskExecutionEffect,
  TaskExecutionOutcome,
  TaskExecutionStatus,
  TaskExpectedState,
  TaskExpectedStatesFn,
  TaskExpectedValue,
  TaskGateFailure,
  TaskGateInput,
  TaskHistoryEntry,
  TaskHistoryFromLedgerFn,
  TaskLedgerEntry,
  TaskNormalizeOutcomeFn,
  TaskNeedsPersistenceEvidenceFn,
  TaskObservation,
  TaskPendingCommitmentsFn,
  TaskPostcondition,
  TaskPostconditionCheck,
  TaskPostconditionRetiredBy,
  TaskPostconditionStatus,
  TaskReadback,
  TaskResolveUncertainFn,
  TaskSummarizeObservationFn,
  TaskVerifierResult,
} from '@/types';
import { capFieldValue, compareFieldValues } from '@/utils/value';

type Reader = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unique = <T>(values: readonly T[]): readonly T[] => Array.from(new Set(values));

// `>=` coerces: a numeric string, true or [1] would clear a floor. Only a real finite number counts.
const meetsFloor = (confidence: unknown, floor: number): confidence is number =>
  typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= floor;

/** The newest `limit` items of a list, tolerating a non-finite or negative limit. */
const newest = <T>(items: readonly T[], limit: number): readonly T[] => {
  const count = Number.isNaN(limit) ? 0 : Math.max(0, Math.floor(limit));
  return items.slice(Math.max(0, items.length - count));
};

const capText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  let index = 0;
  let count = 0;
  while (index < text.length && count < limit) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
};

const formIdOf = (formId: string | undefined): { readonly formId?: string } =>
  formId === undefined ? {} : { formId };

// ---------------------------------------------------------------------------------------------
// Postcondition derivation
// ---------------------------------------------------------------------------------------------

export const derivePostconditions: TaskDerivePostconditionsFn = input => {
  const { command, target, materialized } = input;
  const common = { signature: target.signature, label: target.label, ...formIdOf(target.formId) };
  switch (command.operation) {
    case 'FILL': {
      if (materialized === undefined) {
        return [];
      }
      const expected: TaskExpectedValue =
        materialized.sensitive || target.sensitive
          ? { sensitive: true, nonEmpty: materialized.value !== '' }
          : { sensitive: false, value: materialized.value };
      return [{ kind: 'field_value', ...common, expected }];
    }
    case 'SET_CHECKED': {
      const groupId = target.kind === 'radio' ? target.groupId : undefined;
      return [
        {
          kind: 'checked',
          ...common,
          ...(groupId === undefined ? {} : { groupId }),
          checked: command.checked,
        },
      ];
    }
    case 'SELECT': {
      if (command.optionId === undefined) {
        return [{ kind: 'option_selected', ...common, optionLabel: target.label, control: 'aria' }];
      }
      const optionId = command.optionId;
      const optionLabel =
        input.optionLabel ?? target.options?.find(option => option.id === optionId)?.label;
      return optionLabel === undefined
        ? []
        : [{ kind: 'option_selected', ...common, optionLabel, control: 'native' }];
    }
    default:
      return [];
  }
};

// ---------------------------------------------------------------------------------------------
// Outcome normalization and ledger entries
// ---------------------------------------------------------------------------------------------

const VALID_EFFECTS: Readonly<Record<TaskExecutionStatus, readonly TaskExecutionEffect[]>> = {
  applied: ['applied', 'none'],
  noop_already_satisfied: ['none'],
  rejected_stale: ['none'],
  rejected_invalid: ['none'],
  rejected_scope: ['none'],
  failed: ['none', 'applied'],
  uncertain: ['uncertain'],
  navigated: ['applied', 'uncertain'],
};

const isValidOutcome = (raw: unknown): raw is TaskExecutionOutcome => {
  if (!isRecord(raw)) {
    return false;
  }
  const { status, effect, durationMs } = raw as Reader;
  return (
    typeof status === 'string' &&
    Object.prototype.hasOwnProperty.call(VALID_EFFECTS, status) &&
    typeof effect === 'string' &&
    (VALID_EFFECTS[status as TaskExecutionStatus] as readonly string[]).includes(effect) &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs)
  );
};

const INVALID_OUTCOME_MESSAGE = 'The host returned an outcome the agent could not validate.';

export const normalizeOutcome: TaskNormalizeOutcomeFn = (raw, operation, requestId) => {
  try {
    if (isValidOutcome(raw)) {
      return raw;
    }
  } catch {
    // A hostile or broken object is judged exactly like an invalid one.
  }
  const base = {
    requestId,
    code: 'EXECUTION_FAILED',
    message: INVALID_OUTCOME_MESSAGE,
    durationMs: 0,
  } as const;
  return operation === 'READ' || operation === 'WAIT'
    ? { ...base, status: 'failed', effect: 'none' }
    : { ...base, status: 'uncertain', effect: 'uncertain' };
};

type Submit = NonNullable<Extract<TaskReadback, { readonly kind: 'click' }>['submit']>;

const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
// tag and inputType are element names, never page text: anything else is not a value-free readback.
const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{0,32}$/.test(value);
const isChecked = (value: unknown): value is boolean | 'mixed' =>
  typeof value === 'boolean' || value === 'mixed';

const copySubmit = (submit: unknown): Submit | null | undefined => {
  if (submit === undefined) {
    return undefined;
  }
  if (!isRecord(submit)) {
    return null;
  }
  const { event, invalidControls, defaultPrevented } = submit as Reader;
  return isBool(event) && isCount(invalidControls) && isBool(defaultPrevented)
    ? { event, invalidControls, defaultPrevented }
    : null;
};

// Rebuilt field by field from validated scalars, so a malformed or lying readback never reaches the ledger.
const copyKnownReadback = (readback: unknown): TaskReadback | undefined => {
  if (!isRecord(readback)) {
    return undefined;
  }
  const r = readback as Reader;
  switch (r.kind) {
    case 'click':
    case 'press': {
      const submit = copySubmit(r.submit);
      if (!isBool(r.defaultPrevented) || submit === null) {
        return undefined;
      }
      const withSubmit = submit === undefined ? {} : { submit };
      if (r.kind === 'click') {
        return { kind: 'click', defaultPrevented: r.defaultPrevented, ...withSubmit };
      }
      const action = r.defaultAction;
      return action === 'implicit_submit' || action === 'activate' || action === 'none'
        ? {
            kind: 'press',
            defaultPrevented: r.defaultPrevented,
            defaultAction: action,
            ...withSubmit,
          }
        : undefined;
    }
    case 'fill':
      return isToken(r.tag) &&
        isToken(r.inputType) &&
        isBool(r.changed) &&
        isBool(r.matched) &&
        (r.length === undefined || isCount(r.length)) &&
        (r.empty === undefined || isBool(r.empty))
        ? {
            kind: 'fill',
            tag: r.tag,
            inputType: r.inputType,
            ...(r.length === undefined ? {} : { length: r.length }),
            ...(r.empty === undefined ? {} : { empty: r.empty }),
            changed: r.changed,
            matched: r.matched,
          }
        : undefined;
    case 'select':
      return (r.control === 'native' || r.control === 'aria') &&
        isCount(r.index) &&
        isBool(r.changed) &&
        (r.matched === null || isBool(r.matched))
        ? {
            kind: 'select',
            control: r.control,
            index: r.index,
            changed: r.changed,
            matched: r.matched,
          }
        : undefined;
    case 'setChecked':
      return (r.control === 'native' || r.control === 'aria') &&
        isChecked(r.before) &&
        isChecked(r.after) &&
        isBool(r.changed) &&
        isBool(r.matched)
        ? {
            kind: 'setChecked',
            control: r.control,
            before: r.before,
            after: r.after,
            changed: r.changed,
            matched: r.matched,
          }
        : undefined;
    case 'scroll':
      return isBool(r.moved) &&
        isCount(r.before) &&
        isCount(r.after) &&
        isCount(r.max) &&
        isBool(r.atTop) &&
        isBool(r.atBottom) &&
        (r.reason === undefined || r.reason === 'edge' || r.reason === 'blocked')
        ? {
            kind: 'scroll',
            moved: r.moved,
            ...(r.reason === undefined ? {} : { reason: r.reason }),
            before: r.before,
            after: r.after,
            max: r.max,
            atTop: r.atTop,
            atBottom: r.atBottom,
          }
        : undefined;
    case 'wait':
      return isCount(r.waitedMs) ? { kind: 'wait', waitedMs: r.waitedMs } : undefined;
    case 'read':
      return typeof r.text === 'string' ? { kind: 'read', text: r.text } : undefined;
    default:
      return undefined;
  }
};

// normalizeOutcome passes a well-formed pair through unchanged, so the readback may still be hostile.
const copyReadback = (readback: TaskReadback | undefined): TaskReadback | undefined => {
  try {
    return copyKnownReadback(readback);
  } catch {
    return undefined;
  }
};

const copyExpected = (expected: TaskExpectedValue): TaskExpectedValue =>
  expected.sensitive
    ? { sensitive: true, nonEmpty: expected.nonEmpty }
    : { sensitive: false, value: expected.value };

// Rebuilt field by field, so a field the contract does not know can never carry a raw value into the ledger.
const copyPostcondition = (postcondition: TaskPostcondition): readonly TaskPostcondition[] => {
  const common = {
    signature: postcondition.signature,
    label: postcondition.label,
    ...formIdOf(postcondition.formId),
  };
  switch (postcondition.kind) {
    case 'field_value':
      return [{ kind: 'field_value', ...common, expected: copyExpected(postcondition.expected) }];
    case 'checked':
      return [
        {
          kind: 'checked',
          ...common,
          ...(postcondition.groupId === undefined ? {} : { groupId: postcondition.groupId }),
          checked: postcondition.checked,
        },
      ];
    case 'option_selected':
      return [
        {
          kind: 'option_selected',
          ...common,
          optionLabel: postcondition.optionLabel,
          control: postcondition.control,
        },
      ];
    default:
      return [];
  }
};

export const createLedgerEntry: TaskCreateLedgerEntryFn = input => {
  const { outcome } = input;
  const navigation = outcome.navigation;
  const readback = copyReadback(outcome.readback);
  return {
    seq: input.seq,
    step: input.step,
    command: input.command,
    digest: input.digest,
    effects: [...input.effects],
    status: outcome.status,
    effect: outcome.effect,
    ...(outcome.code === undefined ? {} : { code: outcome.code }),
    ...(readback === undefined ? {} : { readback }),
    postconditions: input.postconditions.flatMap(copyPostcondition),
    scope: {
      sessionId: input.scope.sessionId,
      snapshotId: input.scope.snapshotId,
      documentId: input.scope.documentId,
    },
    observationSequence: input.observationSequence,
    observationOrdinal: input.observationOrdinal,
    url: input.url,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    navigated: outcome.status === 'navigated' || navigation !== undefined,
    ...(navigation?.toDocumentId === undefined ? {} : { afterDocumentId: navigation.toDocumentId }),
    ...(navigation?.toUrl === undefined ? {} : { afterUrl: navigation.toUrl }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
  };
};

// ---------------------------------------------------------------------------------------------
// Postcondition checking
// ---------------------------------------------------------------------------------------------

type Located = {
  readonly entry: TaskLedgerEntry;
  readonly index: number;
  readonly postcondition: TaskPostcondition;
};

const keyOf = (postcondition: TaskPostcondition): string =>
  JSON.stringify([
    postcondition.kind,
    postcondition.kind === 'checked'
      ? (postcondition.groupId ?? postcondition.signature)
      : postcondition.signature,
  ]);

/** Latest postcondition per (groupId ?? signature, kind), in ledger order. */
const latestPostconditions = (ledger: readonly TaskLedgerEntry[]): readonly Located[] => {
  const all = ledger.flatMap((entry, index) =>
    entry.postconditions.map((postcondition): Located => ({ entry, index, postcondition }))
  );
  const last = new Map<string, number>();
  all.forEach((item, position) => last.set(keyOf(item.postcondition), position));
  return all.filter((item, position) => last.get(keyOf(item.postcondition)) === position);
};

const normalizedTwins = (twins: number | undefined): number => Math.max(1, twins ?? 1);

// An identical twin is matched only when the full signature and the recorded twin count both agree.
const findElement = (
  observation: TaskObservation,
  signature: string,
  recordedTwins: number | undefined
): TaskElement | undefined => {
  const element = observation.elements.find(candidate => candidate.signature === signature);
  return element !== undefined && normalizedTwins(element.twins) === normalizedTwins(recordedTwins)
    ? element
    : undefined;
};

type Judgement = {
  readonly status: Extract<TaskPostconditionStatus, 'holds' | 'diverged' | 'violated'>;
  readonly observed?: string;
};

const judgeField = (expected: TaskExpectedValue, element: TaskElement): Judgement => {
  if (expected.sensitive) {
    const filled = (element.state.value ?? '') !== '';
    return { status: filled === expected.nonEmpty ? 'holds' : 'violated' };
  }
  const wanted = capFieldValue(expected.value).value;
  const seen = capFieldValue(element.state.value ?? '').value;
  const match = compareFieldValues(wanted, seen, { inputType: element.inputType });
  if (match === 'exact') {
    return { status: 'holds' };
  }
  return {
    status: match === 'equivalent' ? 'diverged' : 'violated',
    ...(element.sensitive ? {} : { observed: seen }),
  };
};

const judge = (postcondition: TaskPostcondition, element: TaskElement): Judgement => {
  switch (postcondition.kind) {
    case 'field_value':
      return judgeField(postcondition.expected, element);
    case 'checked':
      return { status: element.state.checked === postcondition.checked ? 'holds' : 'violated' };
    case 'option_selected': {
      const selected =
        postcondition.control === 'aria'
          ? element.state.selected === true
          : (element.options ?? []).some(
              option => option.selected && option.label === postcondition.optionLabel
            );
      return { status: selected ? 'holds' : 'violated' };
    }
    default:
      return { status: 'violated' };
  }
};

const blockedByValidation = (readback: TaskReadback | undefined): boolean =>
  (readback?.kind === 'click' || readback?.kind === 'press') &&
  (readback.submit?.invalidControls ?? 0) > 0;

const isSuccessfulSubmit = (entry: TaskLedgerEntry): boolean =>
  (entry.status === 'applied' || entry.status === 'navigated') &&
  entry.effects.includes('form_submit') &&
  !blockedByValidation(entry.readback);

const retirementOf = (
  ledger: readonly TaskLedgerEntry[],
  located: Located,
  observation: TaskObservation,
  present: boolean
): TaskPostconditionRetiredBy | undefined => {
  const later = ledger.slice(located.index + 1);
  const formId = located.postcondition.formId;
  const consumed =
    formId !== undefined &&
    later.some(
      entry =>
        isSuccessfulSubmit(entry) &&
        entry.command.target?.formId === formId &&
        entry.scope.documentId === located.entry.scope.documentId
    );
  if (consumed) {
    return 'submit';
  }
  if (present) {
    return undefined;
  }
  if (located.entry.scope.documentId !== observation.documentId) {
    return 'document_change';
  }
  return later.some(entry => entry.effect !== 'none') ? 'later_effect' : undefined;
};

const checkOne = (
  ledger: readonly TaskLedgerEntry[],
  located: Located,
  observation: TaskObservation
): TaskPostconditionCheck => {
  const { postcondition, entry } = located;
  const element = findElement(observation, postcondition.signature, entry.command.target?.twins);
  const base = { ledgerSeq: entry.seq, postcondition };
  const judgement = element === undefined ? undefined : judge(postcondition, element);
  if (judgement !== undefined && judgement.status !== 'violated') {
    return {
      ...base,
      status: judgement.status,
      ...(judgement.observed === undefined ? {} : { observed: judgement.observed }),
    };
  }
  const retiredBy = retirementOf(ledger, located, observation, element !== undefined);
  if (retiredBy !== undefined) {
    return { ...base, status: 'retired', retiredBy };
  }
  if (judgement === undefined) {
    return { ...base, status: 'absent_violated' };
  }
  return {
    ...base,
    status: 'violated',
    ...(judgement.observed === undefined ? {} : { observed: judgement.observed }),
  };
};

export const checkPostconditions: TaskCheckPostconditionsFn = (ledger, observation) =>
  latestPostconditions(ledger).map(located => checkOne(ledger, located, observation));

// ---------------------------------------------------------------------------------------------
// Uncertain effects
// ---------------------------------------------------------------------------------------------

const resolveEntry = (
  entry: TaskLedgerEntry,
  checks: readonly TaskPostconditionCheck[],
  observation: TaskObservation
): TaskEffectResolution | undefined => {
  if (entry.resolution !== undefined) {
    return { seq: entry.seq, by: 'caller', effect: entry.resolution.effect };
  }
  const statuses = checks.map(check => check.status);
  if (statuses.includes('violated')) {
    return { seq: entry.seq, by: 'postcondition', effect: 'none' };
  }
  if (statuses.length > 0 && statuses.every(status => status === 'holds')) {
    return { seq: entry.seq, by: 'postcondition', effect: 'applied' };
  }
  const moved =
    observation.documentId !== entry.scope.documentId ||
    observation.url !== entry.url ||
    (statuses.length > 0 && statuses.every(status => status === 'retired'));
  return moved ? { seq: entry.seq, by: 'transition', effect: 'applied' } : undefined;
};

export const resolveUncertain: TaskResolveUncertainFn = (ledger, observation) => {
  const checks = checkPostconditions(ledger, observation);
  return ledger.flatMap(entry => {
    if (entry.effect !== 'uncertain') {
      return [];
    }
    const own = checks.filter(check => check.ledgerSeq === entry.seq);
    const resolution = resolveEntry(entry, own, observation);
    return resolution === undefined ? [] : [resolution];
  });
};

export const pendingCommitments: TaskPendingCommitmentsFn = (ledger, resolutions) =>
  ledger.flatMap(entry => {
    if (entry.effect !== 'uncertain') {
      return [];
    }
    const effects = TASK_COMMITMENT_EFFECTS.filter(effect => entry.effects.includes(effect));
    const resolution = resolutions.find(candidate => candidate.seq === entry.seq);
    if (effects.length === 0 || (resolution !== undefined && resolution.by !== 'transition')) {
      return [];
    }
    const target = entry.command.target;
    return [
      {
        seq: entry.seq,
        digest: entry.digest,
        effects,
        ...(target?.signature === undefined ? {} : { signature: target.signature }),
        ...(target?.formId === undefined ? {} : { formId: target.formId }),
        documentId: entry.scope.documentId,
      },
    ];
  });

// ---------------------------------------------------------------------------------------------
// Evidence and expected states
// ---------------------------------------------------------------------------------------------

export const collectEvidence: TaskCollectEvidenceFn = (ledger, limit) => {
  const reads = ledger.flatMap(entry =>
    entry.command.command.operation === 'READ' &&
    entry.readback?.kind === 'read' &&
    typeof entry.readback.text === 'string'
      ? [{ entry, text: entry.readback.text }]
      : []
  );
  return newest(reads, limit).map(
    ({ entry, text }, position): TaskCollectedEvidence => ({
      id: `e${position + 1}`,
      ledgerSeq: entry.seq,
      url: entry.url,
      label: entry.command.target?.label ?? '',
      text: capText(text, TASK_LIMITS.collectedEvidenceChars),
    })
  );
};

// A diverged entry carries its non-sensitive observed value so the verifier sees both values.
type ExpectedStateWithObserved = TaskExpectedState & { readonly observed?: string };

const expectedOf = (
  postcondition: TaskPostcondition
): { readonly expected: string | boolean; readonly sensitive: boolean } => {
  switch (postcondition.kind) {
    case 'field_value':
      return postcondition.expected.sensitive
        ? { expected: postcondition.expected.nonEmpty, sensitive: true }
        : { expected: postcondition.expected.value, sensitive: false };
    case 'checked':
      return { expected: postcondition.checked, sensitive: false };
    default:
      return { expected: postcondition.optionLabel, sensitive: false };
  }
};

export const expectedStates: TaskExpectedStatesFn = (ledger, checks, limit) =>
  newest(
    checks.map((check): ExpectedStateWithObserved => {
      const { postcondition } = check;
      const { expected, sensitive } = expectedOf(postcondition);
      const writtenEntry = ledger.find(entry => entry.seq === check.ledgerSeq);
      const written = writtenEntry?.command.command;
      const inputPath =
        written?.operation === 'FILL' &&
        written.value.source === 'input' &&
        writtenEntry?.readback?.kind === 'fill' &&
        writtenEntry.readback.matched === true
          ? written.value.path
          : undefined;
      return {
        label: postcondition.label,
        kind: postcondition.kind,
        expected,
        sensitive,
        status: check.status,
        ...(inputPath !== undefined ? { inputPath } : {}),
        ...(inputPath !== undefined && check.retiredBy === 'submit'
          ? { preparationBasis: 'matched_supplied_input_submission' as const }
          : {}),
        ...(check.retiredBy !== undefined ? { retiredBy: check.retiredBy } : {}),
        ...(check.status === 'diverged' && !sensitive && check.observed !== undefined
          ? { observed: check.observed }
          : {}),
      };
    }),
    limit
  );

// ---------------------------------------------------------------------------------------------
// Observation summary
// ---------------------------------------------------------------------------------------------

export const summarizeObservation: TaskSummarizeObservationFn = observation => ({
  sessionId: observation.sessionId,
  snapshotId: observation.snapshotId,
  documentId: observation.documentId,
  sequence: observation.sequence,
  observedAt: observation.observedAt,
  url: observation.url,
  title: observation.title,
  fingerprint: observation.fingerprint,
  elementCount: observation.elements.length,
});

// ---------------------------------------------------------------------------------------------
// The DONE gate
// ---------------------------------------------------------------------------------------------

type LocalSteps = {
  readonly failures: readonly TaskGateFailure[];
  readonly postconditions: readonly TaskPostconditionCheck[];
  readonly resolutions: readonly TaskEffectResolution[];
  readonly unresolved: readonly number[];
};

const freshnessFailures = (input: TaskGateInput): readonly TaskGateFailure[] => {
  const { ledger } = input;
  if (ledger.length === 0) {
    return [];
  }
  const latestOrdinal = Math.max(...ledger.map(entry => entry.observationOrdinal));
  const latestFinish = Math.max(...ledger.map(entry => entry.finishedAt));
  return input.observationOrdinal > latestOrdinal && input.receivedAt >= latestFinish
    ? []
    : [{ code: 'NO_FRESH_OBSERVATION' }];
};

const runLocalSteps = (input: TaskGateInput): LocalSteps => {
  const { ledger, observation } = input;
  const resolutions = resolveUncertain(ledger, observation);
  const unresolved = ledger
    .filter(
      entry => entry.effect === 'uncertain' && !resolutions.some(item => item.seq === entry.seq)
    )
    .map(entry => entry.seq);
  const postconditions = checkPostconditions(ledger, observation);
  const failures: readonly TaskGateFailure[] = [
    ...freshnessFailures(input),
    ...(input.allowUncertainCompletion
      ? []
      : unresolved.map(
          (seq): TaskGateFailure => ({ code: 'UNRESOLVED_UNCERTAIN_EFFECT', ledgerSeq: seq })
        )),
    ...postconditions
      .filter(check => check.status === 'violated' || check.status === 'absent_violated')
      .map(
        (check): TaskGateFailure => ({
          code: 'POSTCONDITION_VIOLATED',
          ledgerSeq: check.ledgerSeq,
          detail: check.postcondition.label,
        })
      ),
  ];
  return { failures, postconditions, resolutions, unresolved };
};

export const evaluateLocalGate: TaskEvaluateGateFn = input => {
  const local = runLocalSteps(input);
  return {
    passed: local.failures.length === 0,
    failures: local.failures,
    postconditions: local.postconditions,
    resolutions: local.resolutions,
    unresolvedUncertain: local.unresolved,
    evidence: [],
  };
};

const evidenceStateOf = (element: TaskElement): TaskEvidenceState | undefined => {
  const { value, checked, selected } = element.state;
  const state: TaskEvidenceState = {
    ...(value === undefined
      ? {}
      : element.sensitive
        ? { nonEmpty: value !== '' }
        : { value: capFieldValue(value).value }),
    ...(checked === undefined ? {} : { checked }),
    ...(selected === undefined ? {} : { selected }),
  };
  return Object.keys(state).length === 0 ? undefined : state;
};

const observationEvidence = (element: TaskElement, url: string): TaskEvidence => {
  const state = evidenceStateOf(element);
  return {
    source: 'observation',
    targetId: element.id,
    signature: element.signature,
    role: element.role,
    label: element.label,
    ...(element.sensitive || element.text === undefined
      ? {}
      : { text: capText(element.text, TASK_LIMITS.collectedEvidenceChars) }),
    ...(state === undefined ? {} : { state }),
    url,
  };
};

const collectedToEvidence = (item: TaskCollectedEvidence): TaskEvidence => ({
  source: 'collected',
  targetId: item.id,
  role: 'passage',
  label: item.label,
  text: capText(item.text, TASK_LIMITS.collectedEvidenceChars),
  url: item.url,
});

// A cited id comes from the decider and may carry anything; only an id-shaped one is echoed.
const ID_SHAPE = /^[a-z][0-9]{1,6}(\.[0-9]{1,6})?$/;
const idDetail = (id: unknown): { readonly detail?: string } =>
  typeof id === 'string' && ID_SHAPE.test(id) ? { detail: id } : {};

type Verification = {
  readonly failures: readonly TaskGateFailure[];
  readonly evidence: readonly TaskEvidence[];
};

const verifyDecision = (input: TaskGateInput, decision: TaskCompletionDecision): Verification => {
  const { observation, collected, floors } = input;
  const verdictFailures: readonly TaskGateFailure[] =
    decision.verdict === 'UNCERTAIN'
      ? [{ code: 'VERIFIER_UNCERTAIN' }]
      : decision.verdict !== 'SATISFIED'
        ? [{ code: 'VERIFIER_NOT_SATISFIED' }]
        : meetsFloor(decision.confidence, floors.completion)
          ? []
          : [{ code: 'CONFIDENCE_BELOW_FLOOR', detail: 'verdict' }];
  const cited = unique(
    (Array.isArray(decision.evidenceTargetIds) ? decision.evidenceTargetIds : []).filter(
      id => id !== TASK_NONE_APPROPRIATE
    )
  );
  const resolved = cited.map(id => {
    const element = observation.elements.find(candidate => candidate.id === id);
    if (element !== undefined) {
      return { id, evidence: observationEvidence(element, observation.url) };
    }
    const passage = collected.find(candidate => candidate.id === id);
    return { id, evidence: passage === undefined ? undefined : collectedToEvidence(passage) };
  });
  const evidence = resolved.flatMap(item => (item.evidence === undefined ? [] : [item.evidence]));
  const missing: readonly TaskGateFailure[] =
    evidence.length >= input.minEvidence ? [] : [{ code: 'EVIDENCE_MISSING' }];
  return {
    failures: [
      ...verdictFailures,
      ...resolved
        .filter(item => item.evidence === undefined)
        .map(
          (item): TaskGateFailure => ({
            code: 'EVIDENCE_NOT_IN_SNAPSHOT',
            ...idDetail(item.id),
          })
        ),
      ...missing,
    ],
    evidence,
  };
};

type AnswerOutcome = {
  readonly failures: readonly TaskGateFailure[];
  readonly answer?: TaskAnswer;
};

const answerOutcome = (
  decision: TaskCompletionDecision,
  expectAnswer: boolean | undefined,
  floor: number
): AnswerOutcome => {
  if (expectAnswer === false) {
    return { failures: [] };
  }
  const given: unknown = decision.answer;
  if (!isRecord(given)) {
    return { failures: expectAnswer === true ? [{ code: 'ANSWER_MISSING' }] : [] };
  }
  const { choice, confidence } = given as Reader;
  if (choice === 'YES' || choice === 'NO') {
    return meetsFloor(confidence, floor)
      ? { failures: [], answer: { value: choice, confidence } }
      : { failures: [{ code: 'CONFIDENCE_BELOW_FLOOR', detail: 'answer' }] };
  }
  if (choice === 'UNKNOWN') {
    return { failures: [{ code: 'ANSWER_UNKNOWN' }] };
  }
  return { failures: expectAnswer === true ? [{ code: 'ANSWER_MISSING' }] : [] };
};

const basisOf = (
  postconditions: readonly TaskPostconditionCheck[],
  verifier: TaskVerifierResult | undefined
): TaskCompletionBasis => {
  if (postconditions.some(check => check.status === 'holds')) {
    return 'postconditions';
  }
  return verifier?.verdict === 'SATISFIED' ? 'caller_verifier' : 'model_only';
};

const PASSIVE_EFFECTS: readonly TaskEffectKind[] = ['read', 'scroll', 'wait'];

// An unaccepted unresolved entry is passed in as an empty list: it fails the gate instead.
const effectedOf = (
  ledger: readonly TaskLedgerEntry[],
  resolutions: readonly TaskEffectResolution[],
  acceptedUnresolved: readonly number[]
): boolean =>
  ledger.some(entry => {
    if (!entry.effects.some(effect => !PASSIVE_EFFECTS.includes(effect))) {
      return false;
    }
    if (entry.effect === 'applied') {
      return true;
    }
    if (entry.effect !== 'uncertain') {
      return false;
    }
    const resolution = resolutions.find(item => item.seq === entry.seq);
    return resolution === undefined
      ? acceptedUnresolved.includes(entry.seq)
      : resolution.effect === 'applied';
  });

const callerFailures = (
  verifier: TaskVerifierResult | undefined,
  requireGrounded: boolean,
  basis: TaskCompletionBasis
): readonly TaskGateFailure[] => [
  ...(verifier !== undefined && !(isRecord(verifier) && verifier.verdict === 'SATISFIED')
    ? [{ code: 'CALLER_VERIFIER_REJECTED' } as const]
    : []),
  ...(requireGrounded && basis === 'model_only'
    ? [{ code: 'COMPLETION_UNGROUNDED' } as const]
    : []),
];

export const needsPersistenceEvidence: TaskNeedsPersistenceEvidenceFn = input => {
  const commitments = input.ledger.filter(
    entry =>
      entry.effect !== 'none' &&
      entry.scope.documentId === input.observation.documentId &&
      entry.effects.some(effect =>
        TASK_COMMITMENT_EFFECTS.some(commitment => commitment === effect)
      )
  );
  const draft = latestPostconditions(input.ledger).some(({ entry, postcondition }) => {
    if (entry.scope.documentId !== input.observation.documentId) {
      return false;
    }
    const element = findElement(
      input.observation,
      postcondition.signature,
      entry.command.target?.twins
    );
    return (
      element !== undefined &&
      commitments.some(
        commitment =>
          commitment.seq >= entry.seq &&
          (postcondition.formId === undefined ||
            commitment.command.target?.formId === postcondition.formId)
      )
    );
  });
  return draft;
};

const persistenceFailures = (input: TaskGateInput): readonly TaskGateFailure[] =>
  input.verifier?.verdict !== 'SATISFIED' && needsPersistenceEvidence(input)
    ? [{ code: 'PERSISTENCE_NOT_VERIFIED' }]
    : [];

export const evaluateFullGate: TaskEvaluateGateFn = input => {
  const local = runLocalSteps(input);
  const decision = isRecord(input.decision) ? input.decision : undefined;
  const verification: Verification =
    decision === undefined
      ? { failures: [{ code: 'DECIDER_UNAVAILABLE' }], evidence: [] }
      : verifyDecision(input, decision);
  const answer: AnswerOutcome =
    decision === undefined
      ? { failures: [] }
      : answerOutcome(decision, input.expect?.answer, input.floors.completion);
  const basis = basisOf(local.postconditions, input.verifier);
  const failures: readonly TaskGateFailure[] = [
    ...local.failures,
    ...verification.failures,
    ...answer.failures,
    ...callerFailures(input.verifier, input.requireGrounded, basis),
    ...persistenceFailures(input),
  ];
  const effected = effectedOf(
    input.ledger,
    local.resolutions,
    input.allowUncertainCompletion ? local.unresolved : []
  );
  const answered = answer.answer !== undefined;
  const confidence =
    decision === undefined
      ? undefined
      : answer.answer === undefined
        ? decision.confidence
        : Math.min(decision.confidence, answer.answer.confidence);
  return {
    passed: failures.length === 0,
    failures,
    postconditions: local.postconditions,
    resolutions: local.resolutions,
    unresolvedUncertain: local.unresolved,
    mode: answered ? 'answered' : effected ? 'effected' : 'noop',
    effected,
    answered,
    basis,
    evidence: verification.evidence,
    ...(answer.answer === undefined ? {} : { answer: answer.answer }),
    ...(confidence === undefined ? {} : { confidence }),
  };
};

const executedCount = (
  ledger: readonly TaskLedgerEntry[],
  resolutions: readonly TaskEffectResolution[],
  acceptedUnresolved: readonly number[]
): number =>
  ledger.filter(entry => {
    if (entry.effect === 'applied') {
      return true;
    }
    if (entry.effect !== 'uncertain') {
      return false;
    }
    const resolution = resolutions.find(item => item.seq === entry.seq);
    return resolution === undefined
      ? acceptedUnresolved.includes(entry.seq)
      : resolution.effect === 'applied';
  }).length;

export const completionFromReport: TaskCompletionFromReportFn = (
  report,
  ledger,
  observation,
  now
) => {
  const effected =
    report.effected ?? effectedOf(ledger, report.resolutions, report.unresolvedUncertain);
  const answered = report.answered ?? report.answer !== undefined;
  return {
    mode: report.mode ?? (answered ? 'answered' : effected ? 'effected' : 'noop'),
    effected,
    answered,
    basis: report.basis ?? basisOf(report.postconditions, undefined),
    evidence: report.evidence,
    actionsExecuted: executedCount(ledger, report.resolutions, report.unresolvedUncertain),
    verifierConfidence: report.confidence ?? 0,
    verifiedAt: now,
    verifiedSnapshot: summarizeObservation(observation),
    postconditions: report.postconditions,
    resolvedUncertain: report.resolutions,
    unresolvedUncertain: report.unresolvedUncertain,
    unobserved: { ...observation.unobserved },
  };
};

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

const readbackFacts = (
  readback: TaskReadback | undefined
): Pick<TaskHistoryEntry, 'changed' | 'matched'> => {
  switch (readback?.kind) {
    case 'fill':
    case 'select':
    case 'setChecked':
      return { changed: readback.changed, matched: readback.matched };
    case 'scroll':
      return { changed: readback.moved };
    default:
      return {};
  }
};

const historyEntry = (entry: TaskLedgerEntry): TaskHistoryEntry => {
  const { command, target, argument, optionLabel } = entry.command;
  const argumentLabel = argument?.label ?? optionLabel;
  return {
    step: entry.step,
    kind: entry.effect === 'uncertain' ? 'uncertain' : 'action',
    operation: command.operation,
    ...(target === undefined ? {} : { target: target.label }),
    ...(argumentLabel === undefined ? {} : { argument: argumentLabel }),
    outcome: entry.status,
    effect: entry.effect,
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...readbackFacts(entry.readback),
    ...(entry.afterUrl === undefined ? {} : { url: entry.afterUrl }),
  };
};

/**
 * A blank-at-submission observation is counterevidence for the completion stage only; shown to a relevance or value
 * judgment it reads as proof that a different form was already handled, so argument stages do not receive it.
 */
export const argumentSubmittedControls = (
  controls: readonly TaskSubmittedControl[]
): readonly TaskSubmittedControl[] =>
  controls.filter(control => control.observedEmptyAtSubmission !== true);

/**
 * Exact duplicate records add bytes, not information, and the request builder trims page text before anything
 * else, so a completion request drops them.
 */
export const distinctSubmittedControls = (
  controls: readonly TaskSubmittedControl[]
): readonly TaskSubmittedControl[] => {
  const seen = new Set<string>();
  return controls.filter(control => {
    const key = JSON.stringify(control);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * The agent's own rejected proposals (a refused decision, a DONE that failed its gate) say nothing about the page, and a
 * completion judge reads them as doubt about it, so completion requests leave them out.
 */
export const isObservedHistoryEntry = (entry: TaskHistoryEntry): boolean =>
  entry.kind !== 'premature_done' && entry.kind !== 'rejected_decision';

const OBSERVATION_ONLY_EFFECTS: readonly TaskEffectKind[] = ['read', 'scroll', 'wait'];

/** Effect classes of every command that reached the page, counted from the ledger; observation-only classes are left out. */
export const executedEffects = (
  ledger: readonly TaskLedgerEntry[]
): Readonly<Partial<Record<TaskEffectKind, number>>> => {
  const counts: Partial<Record<TaskEffectKind, number>> = {};
  for (const entry of ledger) {
    if (entry.effect === 'none') {
      continue;
    }
    for (const effect of new Set(entry.effects)) {
      if (!OBSERVATION_ONLY_EFFECTS.includes(effect)) {
        counts[effect] = (counts[effect] ?? 0) + 1;
      }
    }
  }
  return counts;
};

/** A stale rejection never reached the page, so the model must not read it as an attempted action. */
const dispatched = (entry: TaskLedgerEntry): boolean =>
  !(entry.status === 'rejected_stale' && entry.effect === 'none');

export const historyFromLedger: TaskHistoryFromLedgerFn = (ledger, limit) =>
  newest(ledger.filter(dispatched), limit).map(historyEntry);
