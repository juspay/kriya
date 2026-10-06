/** @jest-environment node */
import {
  TASK_ANSWER_CHOICES,
  TASK_ARGUMENT_SLOTS,
  TASK_ARGUMENT_SOURCES,
  TASK_BRIDGE_GLOBAL,
  TASK_BRIDGE_PROTOCOL,
  TASK_CHECKED_CHOICES,
  TASK_CLASSIFIED_OPERATIONS,
  TASK_COMMITMENT_CLASSES,
  TASK_COMMITMENT_EFFECT,
  TASK_COMMITMENT_EFFECTS,
  TASK_COMPLETION_VERDICTS,
  TASK_DEFAULT_BUDGETS,
  TASK_DEFAULT_CONFIDENCE,
  TASK_DEFAULT_RUN_GRANT_USES,
  TASK_DEFAULT_SETTLE,
  TASK_DEFAULT_TIMEOUTS,
  TASK_EFFECTS,
  TASK_ELEMENT_KINDS,
  TASK_EMPTY_TOKEN,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_LIMITS,
  TASK_NONE_APPROPRIATE,
  TASK_OPERATIONS,
  TASK_OPERATION_SLOT,
  TASK_PAGE_TARGET_ID,
  TASK_QUESTION_KEYS,
  TASK_REDACTED,
  TASK_RESEARCH_PROFILE,
  TASK_ROUTINE_EFFECTS,
  TASK_SCROLL_DIRECTIONS,
  TASK_SLOT_SOURCES,
  TASK_TARGET_OPERATIONS,
  TASK_TYPESAFE_DEFAULTS,
  TASK_TYPESAFE_LIMITS,
  TASK_TYPESAFE_MODEL_PREFIX,
  TASK_UNTRUSTED_DATA_RULE,
  TASK_WAIT_DURATIONS_MS,
  isTaskCommitmentClass,
  isTaskCommitmentEffect,
  isTaskHostOperation,
  isTaskOperation,
  isTaskTargetOperation,
  taskTargetQuestionKey,
} from '@/types';
import type {
  TaskArgumentSlot,
  TaskCommand,
  TaskElementKind,
  TaskExecutionStatus,
  TaskHostOperation,
  TaskOperation,
} from '@/types';
import {
  FIXTURE_ORIGIN,
  makeCapabilities,
  makeCheckpoint,
  makeCommand,
  makeCommandRequest,
  makeElement,
  makeForm,
  makeHostCommand,
  makeLedgerEntry,
  makeObservation,
  makeOutcome,
  makePageElements,
  makeRequest,
  roundTrip,
} from './helpers/agent-fixtures';

const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

const asStrings = (values: readonly string[]): readonly string[] => values;

/**
 * Where each host operation can land. A record keyed by every host operation: adding an operation to
 * TASK_HOST_OPERATIONS without a route stops this file compiling.
 */
const OPERATION_KIND_ROUTE: Readonly<Record<TaskHostOperation, readonly TaskElementKind[]>> = {
  READ: ['passage'],
  CLICK: ['button', 'tab', 'menuitem', 'other'],
  NAVIGATE: ['link'],
  FILL: ['text_input', 'textarea'],
  SELECT: ['select', 'option'],
  SET_CHECKED: ['checkbox', 'radio', 'switch'],
  PRESS: ['text_input', 'textarea', 'combobox'],
  SCROLL: ['scroller'],
  WAIT: [],
  SUBMIT: ['button'],
};

describe('operation tables', () => {
  it('lists every host operation once and the two decisions after them', () => {
    expect(unique(TASK_OPERATIONS)).toBe(true);
    expect(unique(TASK_HOST_OPERATIONS)).toBe(true);
    expect(TASK_OPERATIONS.slice(0, TASK_HOST_OPERATIONS.length)).toEqual([
      ...TASK_HOST_OPERATIONS,
    ]);
    expect(TASK_OPERATIONS.slice(TASK_HOST_OPERATIONS.length)).toEqual(['DONE', 'BLOCKED']);
  });

  it('keeps DONE and BLOCKED out of every set a host can execute', () => {
    for (const set of [TASK_HOST_OPERATIONS, TASK_TARGET_OPERATIONS, TASK_CLASSIFIED_OPERATIONS]) {
      expect(asStrings(set)).not.toContain('DONE');
      expect(asStrings(set)).not.toContain('BLOCKED');
    }
  });

  it('gives every host operation an element-kind route that names real element kinds', () => {
    expect(Object.keys(OPERATION_KIND_ROUTE).sort()).toEqual([...TASK_HOST_OPERATIONS].sort());
    for (const operation of TASK_HOST_OPERATIONS) {
      for (const kind of OPERATION_KIND_ROUTE[operation]) {
        expect(asStrings(TASK_ELEMENT_KINDS)).toContain(kind);
      }
    }
  });

  it('routes operations that need an element target to at least one element kind', () => {
    for (const operation of TASK_TARGET_OPERATIONS) {
      expect(OPERATION_KIND_ROUTE[operation].length).toBeGreaterThan(0);
    }
    expect(OPERATION_KIND_ROUTE.WAIT).toEqual([]);
  });

  it('keeps the target operations a subset of the host operations and SCROLL and WAIT out of it', () => {
    for (const operation of TASK_TARGET_OPERATIONS) {
      expect(asStrings(TASK_HOST_OPERATIONS)).toContain(operation);
    }
    expect(asStrings(TASK_TARGET_OPERATIONS)).not.toContain('SCROLL');
    expect(asStrings(TASK_TARGET_OPERATIONS)).not.toContain('WAIT');
    expect(TASK_TARGET_OPERATIONS.length + 2).toBe(TASK_HOST_OPERATIONS.length);
  });

  it('classifies the operations whose effect can exceed the page, never READ, SCROLL, WAIT or FILL', () => {
    expect([...TASK_CLASSIFIED_OPERATIONS].sort()).toEqual(
      ['CLICK', 'NAVIGATE', 'PRESS', 'SELECT', 'SET_CHECKED', 'SUBMIT'].sort()
    );
    for (const operation of ['READ', 'SCROLL', 'WAIT', 'FILL']) {
      expect(asStrings(TASK_CLASSIFIED_OPERATIONS)).not.toContain(operation);
    }
  });

  it('has research operations that are all host operations', () => {
    expect(TASK_RESEARCH_PROFILE.operations.length).toBeGreaterThan(0);
    for (const operation of TASK_RESEARCH_PROFILE.operations) {
      expect(isTaskHostOperation(operation)).toBe(true);
    }
    expect([...TASK_RESEARCH_PROFILE.operations].sort()).toEqual(
      ['NAVIGATE', 'READ', 'SCROLL', 'WAIT'].sort()
    );
  });

  it('configures the research profile as read-only with an answer required and no approvals', () => {
    expect(TASK_RESEARCH_PROFILE.onUnauthorized).toBe('deny');
    expect(TASK_RESEARCH_PROFILE.expect).toEqual({ answer: true });
    expect(TASK_RESEARCH_PROFILE.confidence?.action).toBe(0);
    expect(TASK_RESEARCH_PROFILE.confidence?.completion).toBe(0.6);
    expect(TASK_RESEARCH_PROFILE.budgets?.maxSteps).toBe(24);
  });
});

describe('effects and commitments', () => {
  it('keeps routine and commitment effects disjoint and TASK_EFFECTS their ordered concatenation', () => {
    expect(unique(TASK_EFFECTS)).toBe(true);
    for (const effect of TASK_ROUTINE_EFFECTS) {
      expect(asStrings(TASK_COMMITMENT_EFFECTS)).not.toContain(effect);
    }
    expect([...TASK_EFFECTS]).toEqual([...TASK_ROUTINE_EFFECTS, ...TASK_COMMITMENT_EFFECTS]);
  });

  it('has the plain click effect `interact` among the routine effects', () => {
    expect(asStrings(TASK_ROUTINE_EFFECTS)).toContain('interact');
  });

  it('maps every commitment class except NONE to exactly one commitment effect', () => {
    const classes = TASK_COMMITMENT_CLASSES.filter(item => item !== 'NONE');
    expect(Object.keys(TASK_COMMITMENT_EFFECT).sort()).toEqual([...classes].sort());
    const effects = Object.values(TASK_COMMITMENT_EFFECT);
    expect(unique(effects)).toBe(true);
    expect([...effects].sort()).toEqual([...TASK_COMMITMENT_EFFECTS].sort());
    expect(Object.keys(TASK_COMMITMENT_EFFECT)).not.toContain('NONE');
  });
});

describe('argument slots and sources', () => {
  it('has a slot table keyed by exactly the slots, each listing known unique sources', () => {
    expect(Object.keys(TASK_SLOT_SOURCES).sort()).toEqual([...TASK_ARGUMENT_SLOTS].sort());
    for (const slot of TASK_ARGUMENT_SLOTS) {
      const sources = TASK_SLOT_SOURCES[slot];
      expect(sources.length).toBeGreaterThan(0);
      expect(unique(sources)).toBe(true);
      for (const source of sources) {
        expect(asStrings(TASK_ARGUMENT_SOURCES)).toContain(source);
      }
    }
  });

  it('uses every source for at least one slot', () => {
    const used = new Set<string>(TASK_ARGUMENT_SLOTS.flatMap(slot => [...TASK_SLOT_SOURCES[slot]]));
    expect([...used].sort()).toEqual([...TASK_ARGUMENT_SOURCES].sort());
  });

  it('lets only the value slot take goal text, inputs and resolvers', () => {
    for (const slot of TASK_ARGUMENT_SLOTS) {
      const sources = asStrings(TASK_SLOT_SOURCES[slot]);
      const textual = ['goal_literal', 'goal_span', 'input', 'resolver'];
      for (const source of textual) {
        expect(sources.includes(source)).toBe(slot === 'value');
      }
    }
    expect(TASK_SLOT_SOURCES.option).toEqual(['observed_option']);
  });

  it('assigns every operation slot a known slot and covers every slot', () => {
    const slots = Object.values(TASK_OPERATION_SLOT);
    for (const slot of slots) {
      expect(asStrings(TASK_ARGUMENT_SLOTS)).toContain(slot);
    }
    expect(unique(slots)).toBe(true);
    expect([...slots].sort()).toEqual([...TASK_ARGUMENT_SLOTS].sort());
  });

  it('assigns slots only to host operations and gives READ, CLICK, NAVIGATE and SUBMIT none', () => {
    for (const operation of Object.keys(TASK_OPERATION_SLOT)) {
      expect(isTaskHostOperation(operation)).toBe(true);
    }
    for (const operation of ['READ', 'CLICK', 'NAVIGATE', 'SUBMIT', 'DONE', 'BLOCKED'] as const) {
      expect(TASK_OPERATION_SLOT[operation]).toBeUndefined();
    }
    const expected: Readonly<Record<string, TaskArgumentSlot>> = {
      FILL: 'value',
      SELECT: 'option',
      SET_CHECKED: 'checked',
      PRESS: 'key',
      SCROLL: 'direction',
      WAIT: 'duration',
    };
    expect({ ...TASK_OPERATION_SLOT }).toEqual(expected);
  });
});

describe('protocol enumerations', () => {
  it('has unique members in every enumeration', () => {
    for (const set of [
      TASK_KEYS,
      TASK_SCROLL_DIRECTIONS,
      TASK_CHECKED_CHOICES,
      TASK_WAIT_DURATIONS_MS,
      TASK_COMPLETION_VERDICTS,
      TASK_ANSWER_CHOICES,
      TASK_ELEMENT_KINDS,
    ]) {
      expect(unique(set)).toBe(true);
    }
  });

  it('lists Enter among the keys and the four scroll directions and two checked choices', () => {
    expect(asStrings(TASK_KEYS)).toContain('Enter');
    expect(asStrings(TASK_KEYS)).toContain('Space');
    expect([...TASK_SCROLL_DIRECTIONS]).toEqual(['UP', 'DOWN', 'TOP', 'BOTTOM']);
    expect([...TASK_CHECKED_CHOICES]).toEqual(['CHECKED', 'UNCHECKED']);
  });

  it('has positive integer ascending wait durations', () => {
    for (const duration of TASK_WAIT_DURATIONS_MS) {
      expect(Number.isInteger(duration)).toBe(true);
      expect(duration).toBeGreaterThan(0);
    }
    expect([...TASK_WAIT_DURATIONS_MS]).toEqual([...TASK_WAIT_DURATIONS_MS].sort((a, b) => a - b));
  });

  it('keeps the two sentinel tokens distinct from each other and from every enumeration', () => {
    expect(TASK_EMPTY_TOKEN).toBe('EMPTY');
    expect(TASK_NONE_APPROPRIATE).toBe('NONE_APPROPRIATE');
    expect(TASK_EMPTY_TOKEN).not.toBe(TASK_NONE_APPROPRIATE);
    const everyToken = [
      ...TASK_KEYS,
      ...TASK_SCROLL_DIRECTIONS,
      ...TASK_CHECKED_CHOICES,
      ...TASK_WAIT_DURATIONS_MS.map(String),
    ];
    expect(everyToken).not.toContain(TASK_EMPTY_TOKEN);
    expect(everyToken).not.toContain(TASK_NONE_APPROPRIATE);
  });

  it('uses a page target id that cannot be mistaken for an element id', () => {
    expect(TASK_PAGE_TARGET_ID).toBe('page');
    expect(/^t[0-9]+$/.test(TASK_PAGE_TARGET_ID)).toBe(false);
    for (const element of makePageElements()) {
      expect(element.id).not.toBe(TASK_PAGE_TARGET_ID);
    }
  });

  it('has the bridge constants and the redaction marker', () => {
    expect(TASK_BRIDGE_PROTOCOL).toBe('kriya.task.v1');
    expect(TASK_BRIDGE_GLOBAL).toBe('__kriyaTaskBridge');
    expect(TASK_REDACTED).toBe('[REDACTED]');
    expect(TASK_TYPESAFE_MODEL_PREFIX).toBe('jev-');
  });
});

describe('question keys', () => {
  it('derives one lower case target key per operation with underscores kept', () => {
    expect(taskTargetQuestionKey('SET_CHECKED')).toBe('set_checked_target');
    expect(taskTargetQuestionKey('FILL')).toBe('fill_target');
    const keys = TASK_OPERATIONS.map(operation => taskTargetQuestionKey(operation));
    expect(unique(keys)).toBe(true);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z_]+_target$/);
    }
  });

  it('keeps every fixed question key distinct from every target key', () => {
    const fixed = Object.values(TASK_QUESTION_KEYS);
    expect(unique(fixed)).toBe(true);
    const targetKeys = TASK_OPERATIONS.map(operation => taskTargetQuestionKey(operation));
    for (const key of fixed) {
      expect(targetKeys).not.toContain(key);
    }
    expect(TASK_QUESTION_KEYS.commitmentReverse).toBe('commitment_reverse');
    expect(TASK_QUESTION_KEYS.evidencePrefix).toBe('evidence_');
  });

  it('has a one-line untrusted-data rule that names untrusted page data', () => {
    expect(TASK_UNTRUSTED_DATA_RULE).not.toMatch(/[\r\n]/);
    expect(TASK_UNTRUSTED_DATA_RULE.toLowerCase()).toContain('untrusted');
    expect(TASK_UNTRUSTED_DATA_RULE.toLowerCase()).toContain('instructions');
  });
});

describe('guards', () => {
  it('accepts exactly the members and narrows', () => {
    for (const operation of TASK_OPERATIONS) {
      expect(isTaskOperation(operation)).toBe(true);
    }
    for (const operation of TASK_HOST_OPERATIONS) {
      expect(isTaskHostOperation(operation)).toBe(true);
    }
    for (const operation of TASK_TARGET_OPERATIONS) {
      expect(isTaskTargetOperation(operation)).toBe(true);
    }
    for (const effect of TASK_COMMITMENT_EFFECTS) {
      expect(isTaskCommitmentEffect(effect)).toBe(true);
    }
    for (const commitment of TASK_COMMITMENT_CLASSES) {
      expect(isTaskCommitmentClass(commitment)).toBe(true);
    }
    const candidate: string = 'FILL';
    if (isTaskHostOperation(candidate)) {
      const narrowed: TaskHostOperation = candidate;
      expect(narrowed).toBe('FILL');
    }
  });

  it('separates decisions from host operations and scroll and wait from target operations', () => {
    expect(isTaskOperation('DONE')).toBe(true);
    expect(isTaskOperation('BLOCKED')).toBe(true);
    expect(isTaskHostOperation('DONE')).toBe(false);
    expect(isTaskHostOperation('BLOCKED')).toBe(false);
    expect(isTaskTargetOperation('SCROLL')).toBe(false);
    expect(isTaskTargetOperation('WAIT')).toBe(false);
    expect(isTaskCommitmentEffect('input')).toBe(false);
    expect(isTaskCommitmentEffect('form_submit')).toBe(true);
    expect(isTaskCommitmentClass('NONE')).toBe(true);
    expect(isTaskCommitmentClass('purchase')).toBe(false);
  });

  it('rejects case variants, padding, empty text and prototype names', () => {
    for (const bad of [
      '',
      'fill',
      'Fill',
      ' FILL',
      'FILL ',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(isTaskOperation(bad)).toBe(false);
      expect(isTaskHostOperation(bad)).toBe(false);
      expect(isTaskTargetOperation(bad)).toBe(false);
      expect(isTaskCommitmentEffect(bad)).toBe(false);
      expect(isTaskCommitmentClass(bad)).toBe(false);
    }
  });
});

describe('defaults and limits (provisional values, tested by relation)', () => {
  it('has positive integer budgets and run-grant uses', () => {
    for (const value of Object.values(TASK_DEFAULT_BUDGETS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(TASK_DEFAULT_RUN_GRANT_USES).toBeGreaterThan(0);
  });

  it('has confidence floors in the unit interval and a settle quiet period below its ceiling', () => {
    for (const value of Object.values(TASK_DEFAULT_CONFIDENCE)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(TASK_DEFAULT_SETTLE.quietMs).toBeLessThan(TASK_DEFAULT_SETTLE.maxMs);
    for (const value of Object.values(TASK_DEFAULT_TIMEOUTS)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('has positive limits and a model state that fits inside its request', () => {
    for (const value of Object.values(TASK_LIMITS)) {
      expect(value).toBeGreaterThan(0);
    }
    expect(TASK_LIMITS.modelStateBytes).toBeLessThan(TASK_LIMITS.modelRequestBytes);
    expect(TASK_LIMITS.modelElements).toBeLessThanOrEqual(TASK_LIMITS.observedElements);
    expect(TASK_LIMITS.inputPreviewChars).toBeLessThanOrEqual(TASK_LIMITS.labelChars);
    expect(TASK_LIMITS.commitContextPassageChars).toBeLessThanOrEqual(TASK_LIMITS.passageChars);
  });

  it('keeps the TypeSafe defaults inside the API facts they clamp to', () => {
    expect(TASK_TYPESAFE_DEFAULTS.maxOptions).toBe(TASK_LIMITS.modelElements);
    expect(TASK_TYPESAFE_DEFAULTS.maxOptions).toBeLessThanOrEqual(
      TASK_TYPESAFE_LIMITS.apiMaxOptions
    );
    expect(TASK_TYPESAFE_DEFAULTS.maxRequestBytes).toBeLessThanOrEqual(
      TASK_TYPESAFE_LIMITS.requestBytesCeiling
    );
    expect(TASK_TYPESAFE_LIMITS.provenRequestBytes).toBeLessThanOrEqual(
      TASK_TYPESAFE_LIMITS.requestBytesCeiling
    );
    expect(TASK_LIMITS.modelRequestBytes).toBeLessThanOrEqual(
      TASK_TYPESAFE_DEFAULTS.maxRequestBytes
    );
  });
});

describe('JSON round trips of samples (contract rule 7)', () => {
  it('keeps an observation of the sample page identical', () => {
    const observation = makeObservation({
      elements: makePageElements(),
      forms: [makeForm()],
      notices: [{ kind: 'alert', text: 'Saved' }],
      dialogs: [{ id: 'd1', modal: true, label: 'Confirm', elementIds: ['t6'] }],
      validation: [{ source: 'native', text: 'Required', targetId: 't3' }],
    });
    expect(roundTrip(observation)).toEqual(observation);
    expect(JSON.stringify(observation)).not.toContain('undefined');
  });

  it('keeps a command, a host command and a request of every operation identical', () => {
    for (const operation of TASK_HOST_OPERATIONS) {
      const command: TaskCommand = makeCommand(operation);
      expect(roundTrip(command)).toEqual(command);
      const hostCommand = makeHostCommand(operation);
      expect(roundTrip(hostCommand)).toEqual(hostCommand);
      const request = makeCommandRequest({ command: hostCommand });
      expect(roundTrip(request)).toEqual(request);
    }
  });

  it('keeps every valid outcome pair, a ledger entry, a request and a checkpoint identical', () => {
    const pairs: readonly (readonly [TaskExecutionStatus, 'none' | 'applied' | 'uncertain'])[] = [
      ['applied', 'applied'],
      ['applied', 'none'],
      ['noop_already_satisfied', 'none'],
      ['rejected_stale', 'none'],
      ['rejected_invalid', 'none'],
      ['rejected_scope', 'none'],
      ['failed', 'none'],
      ['failed', 'applied'],
      ['uncertain', 'uncertain'],
      ['navigated', 'applied'],
      ['navigated', 'uncertain'],
    ];
    for (const [status, effect] of pairs) {
      const outcome = makeOutcome(status, effect as never);
      expect(roundTrip(outcome)).toEqual(outcome);
    }
    const entry = makeLedgerEntry();
    expect(roundTrip(entry)).toEqual(entry);
    const request = makeRequest();
    expect(roundTrip(request)).toEqual(request);
    const checkpoint = makeCheckpoint();
    expect(roundTrip(checkpoint)).toEqual(checkpoint);
  });

  it('keeps capabilities identical and every element kind constructible', () => {
    const capabilities = makeCapabilities();
    expect(roundTrip(capabilities)).toEqual(capabilities);
    for (const kind of TASK_ELEMENT_KINDS) {
      const element = makeElement({ kind });
      expect(roundTrip(element)).toEqual(element);
    }
    expect(FIXTURE_ORIGIN.startsWith('https://')).toBe(true);
  });

  it('keeps the operation type usable as an exhaustive record key', () => {
    const everyOperation: Readonly<Record<TaskOperation, true>> = {
      READ: true,
      CLICK: true,
      NAVIGATE: true,
      FILL: true,
      SELECT: true,
      SET_CHECKED: true,
      PRESS: true,
      SCROLL: true,
      WAIT: true,
      SUBMIT: true,
      DONE: true,
      BLOCKED: true,
    };
    expect(Object.keys(everyOperation).sort()).toEqual([...TASK_OPERATIONS].sort());
  });
});
