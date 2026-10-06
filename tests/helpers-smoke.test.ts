import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { observePage, resetGuideCache } from '@/guide/observe';
import type {
  ActionCommand,
  ExecutionOptions,
  TaskActionDecision,
  TaskActionExecutor,
  TaskArgumentDecision,
  TaskCommitmentDecision,
  TaskCompletionDecision,
  TaskDecider,
  TaskDeciderResult,
  TaskElement,
  TaskExecutionEffect,
  TaskExecutionOutcome,
  TaskExecutionStatus,
  TaskHost,
  TaskHostCapabilities,
  TaskHostOperation,
  TaskIdFactory,
  TaskLedgerEntry,
  TaskIdPrefix,
  TaskObservation,
  TaskObserveRequest,
  TaskOutcomeFields,
} from '@/types';
import {
  TASK_DEFAULT_SETTLE,
  TASK_DEFAULT_TIMEOUTS,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_REDACTED,
  TASK_SCROLL_DIRECTIONS,
  TASK_TYPESAFE_LIMITS,
  TASK_WAIT_DURATIONS_MS,
} from '@/types';
import {
  FIXTURE_IDS,
  FIXTURE_ORIGIN,
  FIXTURE_START,
  FIXTURE_URL,
  counterIds,
  deciderFail,
  deciderOk,
  makeActionDecision,
  makeArgumentDecision,
  makeCapabilities,
  makeCheckbox,
  makeCheckpoint,
  makeClock,
  makeCommand,
  makeCommandRequest,
  makeCommitmentDecision,
  makeCompletionDecision,
  makeElement,
  makeExchange,
  makeExecutionResult,
  makeFakeDecider,
  makeFakeExecutor,
  makeFakeHost,
  makeForm,
  makeHostCommand,
  makeBudgetUsage,
  makeLedgerEntry,
  makeLink,
  makeManualClock,
  makeNoArgumentDecision,
  makeNormalizedAuthorization,
  makeObservation,
  makeOutcome,
  makePageElements,
  makePassage,
  makeRedactedCommand,
  makeRequest,
  makeScope,
  makeSelectField,
  makeSensitiveField,
  makeSubmitButton,
  makeTargetRef,
  makeTextField,
  roundTrip,
  signatureFor,
  summarizeElement,
  summarizeObservation,
} from './helpers/agent-fixtures';
import type { Box, Viewport } from './helpers/domHarness';
import {
  installLayoutStubs,
  layoutColumn,
  makeScrollable,
  mount,
  mountHtml,
  resetDom,
  setBox,
  setViewport,
} from './helpers/domHarness';

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

function hasUndefined(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasUndefined);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasUndefined);
  }
  return false;
}

function expectJsonSafe(value: unknown): void {
  expect(hasUndefined(value)).toBe(false);
  expect(roundTrip(value)).toStrictEqual(value);
}

const PREFIXES: readonly TaskIdPrefix[] = ['run', 'ses', 'snap', 'doc', 'req', 'apr', 'ck', 'non'];

describe('counterIds', () => {
  test('produces <prefix>_<12 lowercase hex> for every prefix', () => {
    const createId: TaskIdFactory = counterIds();
    for (const prefix of PREFIXES) {
      expect(createId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9a-f]{12}$`));
    }
  });

  test('counts per prefix from 1 and the prefixes do not share a counter', () => {
    const createId = counterIds();
    expect([
      createId('run'),
      createId('req'),
      createId('run'),
      createId('req'),
      createId('req'),
    ]).toEqual([
      'run_000000000001',
      'req_000000000001',
      'run_000000000002',
      'req_000000000002',
      'req_000000000003',
    ]);
  });

  test('encodes the counter in hexadecimal across the 9/a, 15/16 and 255/256 boundaries', () => {
    const createId = counterIds();
    const ids = Array.from({ length: 256 }, () => createId('ck'));
    expect(ids[8]).toBe('ck_000000000009');
    expect(ids[9]).toBe('ck_00000000000a');
    expect(ids[15]).toBe('ck_000000000010');
    expect(ids[16]).toBe('ck_000000000011');
    expect(ids[254]).toBe('ck_0000000000ff');
    expect(ids[255]).toBe('ck_000000000100');
    expect(new Set(ids).size).toBe(256);
  });

  test('independent factories replay the same sequence', () => {
    const first = counterIds();
    const second = counterIds();
    expect([first('doc'), first('doc')]).toEqual([second('doc'), second('doc')]);
  });

  test('never produces the <word>-<hex> shape that trips the key scanner', () => {
    const createId = counterIds();
    for (const prefix of PREFIXES) {
      expect(createId(prefix)).not.toMatch(/-[0-9a-f]{12}/);
    }
  });
});

describe('clocks', () => {
  test('makeClock starts at the given value and advances by exactly one per call', () => {
    const clock: () => number = makeClock(5000);
    expect([clock(), clock(), clock()]).toEqual([5000, 5001, 5002]);
  });

  test('makeClock defaults to FIXTURE_START and clocks are independent', () => {
    const first = makeClock();
    const second = makeClock();
    expect(first()).toBe(FIXTURE_START);
    expect(first()).toBe(FIXTURE_START + 1);
    expect(second()).toBe(FIXTURE_START);
  });

  test('makeClock accepts a start of zero', () => {
    const clock = makeClock(0);
    expect([clock(), clock()]).toEqual([0, 1]);
  });

  test('makeManualClock stands still until it is advanced or set', () => {
    const clock = makeManualClock(100);
    expect(clock.now()).toBe(100);
    expect(clock.now()).toBe(100);
    expect(clock.advance(50)).toBe(150);
    expect(clock.now()).toBe(150);
    clock.set(10);
    expect(clock.now()).toBe(10);
    expect(clock.advance(0)).toBe(10);
  });

  test('makeManualClock defaults to FIXTURE_START', () => {
    expect(makeManualClock().now()).toBe(FIXTURE_START);
  });
});

describe('roundTrip', () => {
  test('returns a deep copy through JSON, never the same reference', () => {
    const original = { a: [1, { b: 'x' }], c: null, d: true };
    const copy = roundTrip(original);
    expect(copy).toStrictEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.a).not.toBe(original.a);
    expect(copy.a[1]).not.toBe(original.a[1]);
  });

  test('drops what JSON drops, which is how it exposes undefined-bearing fixtures', () => {
    expect(roundTrip({ a: 1, b: undefined })).toStrictEqual({ a: 1 });
    expect(roundTrip([1, undefined])).toStrictEqual([1, null]);
  });
});

describe('makeElement', () => {
  test('the default element is a valid enabled clickable button', () => {
    const element: TaskElement = makeElement();
    expect(element).toMatchObject({
      id: 't1',
      role: 'button',
      kind: 'button',
      label: 'Continue',
      sensitive: false,
      inViewport: true,
      operations: ['CLICK'],
      state: { disabled: false, readOnly: false, required: false, invalid: false, focused: false },
    });
    expect(element.signature).toMatch(/^sg_[0-9a-f]{16}$/);
    expectJsonSafe(element);
  });

  test('overrides win and a state override is merged into the default state', () => {
    const element = makeElement({
      id: 't9',
      label: 'Pay',
      operations: ['CLICK', 'READ'],
      state: { disabled: true, value: 'x' },
    });
    expect(element.id).toBe('t9');
    expect(element.label).toBe('Pay');
    expect(element.operations).toEqual(['CLICK', 'READ']);
    expect(element.state).toStrictEqual({
      disabled: true,
      readOnly: false,
      required: false,
      invalid: false,
      focused: false,
      value: 'x',
    });
  });

  test('accepts a plain Partial<TaskElement> override, as the pinned signature says', () => {
    const partial: Partial<TaskElement> = { label: 'Typed' };
    expect(makeElement(partial).label).toBe('Typed');
  });

  test('the signature follows the id, is unique per id, and an explicit signature wins', () => {
    expect(makeElement({ id: 't2' }).signature).toBe(signatureFor('t2'));
    expect(makeElement({ id: 't2' }).signature).not.toBe(makeElement({ id: 't3' }).signature);
    expect(makeElement({ id: 't1' }).signature).not.toBe(makeElement({ id: 't10' }).signature);
    expect(makeElement({ signature: 'sg_custom.2' }).signature).toBe('sg_custom.2');
  });

  test('signatures stay unique for every id, however long or exotic, and keep the sg_<16 hex> shape', () => {
    expect(signatureFor('t1')).toBe('sg_7431000000000000');
    const ids = [
      ...Array.from({ length: 400 }, (_, index) => `t${index + 1}`),
      't12345678',
      't12345679',
      't123456789',
      'ab',
      '\u6162',
      't\u{1F600}',
      't\u{1F601}',
      'x'.repeat(40),
      `${'x'.repeat(39)}y`,
    ];
    const signatures = ids.map(signatureFor);
    expect(new Set(signatures).size).toBe(ids.length);
    for (const signature of signatures) {
      expect(signature).toMatch(/^sg_[0-9a-f]{16}$/);
    }
    expect(ids.map(signatureFor)).toStrictEqual(signatures);
  });

  test('overrides never leak between calls', () => {
    makeElement({ label: 'Other', state: { disabled: true } });
    expect(makeElement().label).toBe('Continue');
    expect(makeElement().state.disabled).toBe(false);
  });
});

describe('element presets follow the contract', () => {
  test('a link offers NAVIGATE and never CLICK, with an absolute href', () => {
    const link = makeLink();
    expect(link.kind).toBe('link');
    expect(link.operations).toEqual(['NAVIGATE']);
    expect(link.href).toBe(`${FIXTURE_ORIGIN}/help`);
    expectJsonSafe(link);
  });

  test('a submit control offers SUBMIT and never CLICK, with a form target and a structural hint', () => {
    const submit = makeSubmitButton();
    expect(submit.operations).toEqual(['SUBMIT']);
    expect(submit.formId).toBe('f1');
    expect(submit.formTarget).toStrictEqual({ action: `${FIXTURE_ORIGIN}/submit`, method: 'POST' });
    expect(submit.commitHints).toStrictEqual([{ class: 'FORM_SUBMIT', basis: 'submit_control' }]);
    expectJsonSafe(submit);
  });

  test('a text field offers FILL and PRESS and starts empty', () => {
    const field = makeTextField();
    expect(field.operations).toEqual(['FILL', 'PRESS']);
    expect(field.kind).toBe('text_input');
    expect(field.state.value).toBe('');
    expectJsonSafe(field);
  });

  test('a sensitive field is structurally sensitive, offers no READ and carries no text', () => {
    const field = makeSensitiveField();
    expect(field.sensitive).toBe(true);
    expect(field.operations).not.toContain('READ');
    expect(field.text).toBeUndefined();
    expect(field.inputType).toBe('password');
    expect([TASK_REDACTED, '']).toContain(field.state.value);
    expectJsonSafe(field);
  });

  test('a checkbox offers SET_CHECKED and reports a boolean checked state', () => {
    const box = makeCheckbox();
    expect(box.operations).toEqual(['SET_CHECKED']);
    expect(box.state.checked).toBe(false);
    expect(makeCheckbox({ state: { checked: true } }).state.checked).toBe(true);
    expectJsonSafe(box);
  });

  test('a select offers SELECT with options numbered <targetId>.<n> and exactly one selected', () => {
    const select = makeSelectField();
    expect(select.operations).toEqual(['SELECT']);
    expect(select.options?.map(option => option.id)).toEqual(['t5.1', 't5.2']);
    expect(select.options?.filter(option => option.selected)).toHaveLength(1);
    const selected = must(
      select.options?.find(option => option.selected),
      'selected option'
    );
    expect(select.state.value).toBe(selected.value);
    expectJsonSafe(select);
  });

  test('a select re-derives its option ids from an overridden element id', () => {
    const select = makeSelectField({ id: 't9' });
    expect(select.options?.map(option => option.id)).toEqual(['t9.1', 't9.2']);
    expect(makeSelectField({ options: [] }).options).toEqual([]);
  });

  test('a passage offers READ and carries its text', () => {
    const passage = makePassage();
    expect(passage.kind).toBe('passage');
    expect(passage.operations).toEqual(['READ']);
    expect(must(passage.text, 'passage text').length).toBeGreaterThan(0);
    expectJsonSafe(passage);
  });

  test('preset state overrides merge with the preset state', () => {
    const field = makeTextField({ state: { value: 'Ada', required: true } });
    expect(field.state).toMatchObject({ value: 'Ada', required: true, disabled: false });
    expect(makeCheckbox({ state: { disabled: true } }).state).toMatchObject({
      checked: false,
      disabled: true,
    });
  });

  test('the sample page has unique ids and signatures, in id order', () => {
    const page = makePageElements();
    expect(page.map(element => element.id)).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
    ]);
    expect(new Set(page.map(element => element.signature)).size).toBe(page.length);
    expectJsonSafe(page);
  });

  test('a form lists real fields and submitters of the sample page', () => {
    const form = makeForm();
    const ids = new Set(makePageElements().map(element => element.id));
    expect(form.method).toBe('POST');
    for (const id of [...form.fieldIds, ...form.submitterIds]) {
      expect(ids.has(id)).toBe(true);
    }
    expectJsonSafe(form);
    expect(makeForm({ implicitSubmit: false }).implicitSubmit).toBe(false);
  });

  test('summarizeElement keeps identity fields and drops state, options and text', () => {
    const summary = summarizeElement(makeSubmitButton());
    expect(summary).toStrictEqual({
      id: 't6',
      signature: signatureFor('t6'),
      role: 'button',
      kind: 'button',
      label: 'Submit',
      sensitive: false,
      formId: 'f1',
    });
    expect(summarizeElement(makeLink())).toMatchObject({ href: `${FIXTURE_ORIGIN}/help` });
    expect(summarizeElement(makeSensitiveField())).toMatchObject({ inputType: 'password' });
    expect(summarizeElement(makeElement({ twins: 2 })).twins).toBe(2);
    expectJsonSafe(summary);
  });
});

describe('makeObservation', () => {
  test('the default observation is a complete, scoped, JSON-safe snapshot', () => {
    const observation: TaskObservation = makeObservation();
    expect(observation).toMatchObject({
      sessionId: FIXTURE_IDS.session,
      snapshotId: FIXTURE_IDS.snapshot,
      documentId: FIXTURE_IDS.document,
      sequence: 1,
      observedAt: FIXTURE_START,
      url: FIXTURE_URL,
      origin: FIXTURE_ORIGIN,
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
    });
    expect(observation.elements).toStrictEqual([makeElement()]);
    expect(observation.page.viewport).toStrictEqual({ width: 1024, height: 768 });
    expect(observation.page.scroll).toStrictEqual({ directions: [], top: 0, max: 0 });
    expectJsonSafe(observation);
  });

  test('the scope matches makeScope and the default targets', () => {
    expect(makeScope()).toStrictEqual({
      sessionId: FIXTURE_IDS.session,
      snapshotId: FIXTURE_IDS.snapshot,
      documentId: FIXTURE_IDS.document,
    });
    const { sessionId, snapshotId, documentId } = makeObservation();
    expect({ sessionId, snapshotId, documentId }).toStrictEqual(makeScope());
    expect(makeTargetRef()).toStrictEqual({
      sessionId: FIXTURE_IDS.session,
      snapshotId: FIXTURE_IDS.snapshot,
      targetId: 't1',
      signature: makeElement().signature,
    });
    expect(makeScope({ snapshotId: 'snap_x' }).snapshotId).toBe('snap_x');
  });

  test('origin is derived from an overridden url, and an explicit origin wins', () => {
    expect(makeObservation({ url: 'https://other.test:8443/a?b=1#h' }).origin).toBe(
      'https://other.test:8443'
    );
    expect(makeObservation({ url: 'https://other.test/a', origin: 'https://x.test' }).origin).toBe(
      'https://x.test'
    );
    expect(makeObservation({ url: 'not a url' }).origin).toBe(FIXTURE_ORIGIN);
  });

  test('the fingerprint is deterministic and follows url, text, notices and element state', () => {
    const base = makeObservation();
    expect(makeObservation().fingerprint).toBe(base.fingerprint);
    expect(base.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const variants: readonly Partial<TaskObservation>[] = [
      { url: `${FIXTURE_ORIGIN}/other` },
      { text: 'changed text' },
      { notices: [{ kind: 'alert', text: 'Oops' }] },
      { elements: [makeElement({ state: { disabled: true } })] },
      { elements: [makeElement({ id: 't2' })] },
    ];
    const prints = variants.map(variant => makeObservation(variant).fingerprint);
    expect(new Set([base.fingerprint, ...prints]).size).toBe(variants.length + 1);
  });

  test('an explicit fingerprint is kept, and other overrides are honored', () => {
    const observation = makeObservation({
      fingerprint: 'cafebabe',
      sequence: 7,
      elements: makePageElements(),
    });
    expect(observation.fingerprint).toBe('cafebabe');
    expect(observation.sequence).toBe(7);
    expect(observation.elements).toHaveLength(8);
    expectJsonSafe(observation);
  });

  test('summarizeObservation counts elements and keeps the scope and fingerprint', () => {
    const observation = makeObservation({ elements: makePageElements() });
    expect(summarizeObservation(observation)).toStrictEqual({
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      documentId: observation.documentId,
      sequence: observation.sequence,
      observedAt: observation.observedAt,
      url: observation.url,
      title: observation.title,
      fingerprint: observation.fingerprint,
      elementCount: 8,
    });
  });
});

describe('makeCapabilities', () => {
  test('the default host is fully capable and fits the agent requirements', () => {
    const capabilities: TaskHostCapabilities = makeCapabilities();
    expect(capabilities).toMatchObject({
      hostKind: 'custom',
      persistsAcrossNavigation: true,
      detectsNavigation: true,
      cancellation: 'cooperative',
      redaction: { observations: true, executionEvents: true },
      strictTargets: true,
      scrollContainers: true,
      implicitSubmitDetection: true,
      authoritativeLocation: true,
      isolatedWorld: false,
    });
    expect(capabilities.operations).toEqual([...TASK_HOST_OPERATIONS]);
    expect(capabilities.keys).toEqual([...TASK_KEYS]);
    expect(capabilities.waitDurationsMs).toEqual([...TASK_WAIT_DURATIONS_MS]);
    expect(capabilities.maxElements).toBeGreaterThan(0);
    expectJsonSafe(capabilities);
  });

  test('arrays are fresh copies, not the shared constants', () => {
    const capabilities = makeCapabilities();
    expect(capabilities.keys).not.toBe(TASK_KEYS);
    expect(capabilities.operations).not.toBe(TASK_HOST_OPERATIONS);
    expect(capabilities.waitDurationsMs).not.toBe(TASK_WAIT_DURATIONS_MS);
    expect(makeCapabilities().keys).not.toBe(capabilities.keys);
  });

  test('overrides win and a redaction override is merged', () => {
    const capabilities = makeCapabilities({
      operations: ['READ'],
      cancellation: 'none',
      redaction: { executionEvents: false },
    });
    expect(capabilities.operations).toEqual(['READ']);
    expect(capabilities.cancellation).toBe('none');
    expect(capabilities.redaction).toStrictEqual({ observations: true, executionEvents: false });
    const plain: Partial<TaskHostCapabilities> = { strictTargets: false };
    expect(makeCapabilities(plain).strictTargets).toBe(false);
  });
});

describe('pinned signatures of the contract table (section 3, row M0)', () => {
  test('every helper is assignable to its pinned function type, so a drift fails to compile', () => {
    const pinnedElement: (overrides?: Partial<TaskElement>) => TaskElement = makeElement;
    const pinnedObservation: (overrides?: Partial<TaskObservation>) => TaskObservation =
      makeObservation;
    const pinnedCapabilities: (overrides?: Partial<TaskHostCapabilities>) => TaskHostCapabilities =
      makeCapabilities;
    const pinnedOutcome: (
      status: TaskExecutionStatus,
      effect: TaskExecutionEffect,
      overrides?: Partial<TaskOutcomeFields>
    ) => TaskExecutionOutcome = makeOutcome;
    const pinnedLedger: (overrides?: Partial<TaskLedgerEntry>) => TaskLedgerEntry = makeLedgerEntry;
    const pinnedRoundTrip: <T>(value: T) => T = roundTrip;
    const pinnedIds: () => TaskIdFactory = counterIds;
    const pinnedClock: (start?: number) => () => number = makeClock;
    const pinnedBox: <T extends Element>(element: T, box: Box) => T = setBox;
    const pinnedMount: <T extends HTMLElement>(element: T, box: Box, parent?: HTMLElement) => T =
      mount;
    const pinnedColumn: (root?: ParentNode, rowHeight?: number) => void = layoutColumn;
    const pinnedHtml: (html: string, autoLayout?: boolean) => HTMLElement = mountHtml;
    const pinnedViewport: (viewport: Viewport) => void = setViewport;
    const pinnedStubs: () => void = installLayoutStubs;
    const pinnedReset: () => void = resetDom;
    const all: readonly unknown[] = [
      pinnedElement,
      pinnedObservation,
      pinnedCapabilities,
      pinnedOutcome,
      pinnedLedger,
      pinnedRoundTrip,
      pinnedIds,
      pinnedClock,
      pinnedBox,
      pinnedMount,
      pinnedColumn,
      pinnedHtml,
      pinnedViewport,
      pinnedStubs,
      pinnedReset,
    ];
    expect(all.every(helper => typeof helper === 'function')).toBe(true);
    expect(pinnedElement()).toStrictEqual(makeElement());
    expect(pinnedClock()()).toBe(FIXTURE_START);
    expect(pinnedIds()('run')).toBe('run_000000000001');
  });
});

describe('makeOutcome', () => {
  test.each<[TaskExecutionStatus, TaskExecutionEffect]>([
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
  ])('builds the valid pair %s / %s', (status, effect) => {
    const outcome: TaskExecutionOutcome = makeOutcome(status, effect);
    expect(outcome.status).toBe(status);
    expect(outcome.effect).toBe(effect);
    expect(outcome.requestId).toBe(FIXTURE_IDS.request);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expectJsonSafe(outcome);
  });

  test.each<[TaskExecutionStatus, TaskExecutionEffect]>([
    ['applied', 'uncertain'],
    ['noop_already_satisfied', 'applied'],
    ['noop_already_satisfied', 'uncertain'],
    ['rejected_stale', 'applied'],
    ['rejected_invalid', 'uncertain'],
    ['rejected_scope', 'applied'],
    ['failed', 'uncertain'],
    ['uncertain', 'none'],
    ['uncertain', 'applied'],
    ['navigated', 'none'],
  ])('rejects the dishonest pair %s / %s at run time', (status, effect) => {
    expect(() => makeOutcome(status as 'applied', effect as 'applied')).toThrow(/invalid/i);
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'a status that is an inherited object key (%s) is an invalid pair, not a crash',
    key => {
      expect(() => makeOutcome(key as 'applied', 'none')).toThrow(/invalid outcome pair/);
    }
  );

  test('a dishonest pair does not compile', () => {
    expect(
      // @ts-expect-error uncertain admits only the uncertain effect
      () => makeOutcome('uncertain', 'none')
    ).toThrow();
    expect(
      // @ts-expect-error a rejection never applied anything
      () => makeOutcome('rejected_stale', 'applied')
    ).toThrow();
    expect(
      // @ts-expect-error noop is always effect none
      () => makeOutcome('noop_already_satisfied', 'applied')
    ).toThrow();
  });

  test('field overrides are applied', () => {
    const outcome = makeOutcome('failed', 'none', {
      requestId: 'req_00000000beef',
      code: 'TARGET_DISABLED',
      message: 'disabled',
      durationMs: 42,
      staleReason: 'element_missing',
      readback: { kind: 'read', text: 'passage' },
    });
    expect(outcome).toStrictEqual({
      requestId: 'req_00000000beef',
      code: 'TARGET_DISABLED',
      message: 'disabled',
      durationMs: 42,
      staleReason: 'element_missing',
      readback: { kind: 'read', text: 'passage' },
      status: 'failed',
      effect: 'none',
    });
  });

  test('an override can never replace the status or the effect', () => {
    const sneaky = { status: 'failed', effect: 'applied' } as unknown as Partial<TaskOutcomeFields>;
    const outcome = makeOutcome('applied', 'none', sneaky);
    expect(outcome.status).toBe('applied');
    expect(outcome.effect).toBe('none');
  });
});

describe('commands', () => {
  const page = makePageElements();

  test.each(TASK_HOST_OPERATIONS.filter(op => op !== 'SCROLL' && op !== 'WAIT'))(
    'the default %s command targets a sample-page element that really offers it',
    operation => {
      const command = makeCommand(operation);
      const target = must('target' in command ? command.target : undefined, `${operation} target`);
      const element = must(
        page.find(candidate => candidate.id === target.targetId),
        `${operation} element`
      );
      expect(element.operations).toContain(operation);
      expect(target.signature).toBe(element.signature);
      expect({
        sessionId: target.sessionId,
        snapshotId: target.snapshotId,
      }).toStrictEqual({ sessionId: FIXTURE_IDS.session, snapshotId: FIXTURE_IDS.snapshot });
      expectJsonSafe(command);
    }
  );

  test('SCROLL scrolls the page and WAIT takes an allowed duration', () => {
    const scroll = makeCommand('SCROLL');
    expect('target' in scroll).toBe(false);
    expect(TASK_SCROLL_DIRECTIONS).toContain(scroll.direction);
    const wait = makeCommand('WAIT');
    expect(TASK_WAIT_DURATIONS_MS).toContain(wait.durationMs);
    expectJsonSafe(scroll);
    expectJsonSafe(wait);
  });

  test('operation specific fields carry valid values', () => {
    expect(TASK_KEYS).toContain(makeCommand('PRESS').key);
    expect(makeCommand('SELECT').optionId).toBe('t5.2');
    expect(makeCommand('SET_CHECKED').checked).toBe(true);
    expect(makeCommand('FILL').value).toStrictEqual({ source: 'input', path: 'name' });
  });

  test('overrides are typed per operation and win', () => {
    expect(makeCommand('PRESS', { key: 'Escape' }).key).toBe('Escape');
    expect(makeCommand('WAIT', { durationMs: 2000 }).durationMs).toBe(2000);
    const filled = makeCommand('FILL', {
      value: { source: 'protocol', slot: 'value', token: 'EMPTY' },
    });
    expect(filled.value).toStrictEqual({ source: 'protocol', slot: 'value', token: 'EMPTY' });
    const retargeted = makeCommand('CLICK', { target: makeTargetRef({ targetId: 't9' }) });
    expect(retargeted.target.targetId).toBe('t9');
    // @ts-expect-error key belongs to PRESS, not to CLICK
    makeCommand('CLICK', { key: 'Enter' });
  });

  test('host commands: only FILL differs, and it carries a raw value and a sensitivity flag', () => {
    const fill = makeHostCommand('FILL');
    expect(fill).toMatchObject({ operation: 'FILL', value: 'Ada Lovelace', sensitive: false });
    expect(makeHostCommand('FILL', { sensitive: true, value: 'x' })).toMatchObject({
      sensitive: true,
      value: 'x',
    });
    expect(makeHostCommand('CLICK')).toStrictEqual(makeCommand('CLICK'));
    expect(makeHostCommand('SCROLL')).toStrictEqual(makeCommand('SCROLL'));
    expectJsonSafe(fill);
  });

  test('a command request is scoped to the snapshot of its target and bounded by the run defaults', () => {
    const request = makeCommandRequest();
    expect(request.requestId).toBe(FIXTURE_IDS.request);
    expect(request.scope).toStrictEqual(makeScope());
    expect(request.allowedOrigins).toStrictEqual([FIXTURE_ORIGIN]);
    expect(request.timeoutMs).toBe(TASK_DEFAULT_TIMEOUTS.executionMs);
    expect(request.settle).toStrictEqual(TASK_DEFAULT_SETTLE);
    expect(request.settle).not.toBe(TASK_DEFAULT_SETTLE);
    const command = request.command;
    expect(command.operation).toBe('CLICK');
    const target = 'target' in command ? command.target : undefined;
    expect(target?.snapshotId).toBe(request.scope.snapshotId);
    expectJsonSafe(request);
    expect(makeCommandRequest({ timeoutMs: 5 }).timeoutMs).toBe(5);
  });

  test('a redacted command pairs a reference command with a value-free target summary', () => {
    const redacted = makeRedactedCommand();
    expect(redacted.command).toStrictEqual(makeCommand('CLICK'));
    expect(redacted.target).toStrictEqual(summarizeElement(makeElement()));
    expect(redacted.target).not.toHaveProperty('state');
    expectJsonSafe(redacted);
    expect(makeRedactedCommand({ optionLabel: 'India' }).optionLabel).toBe('India');
  });
});

describe('makeLedgerEntry', () => {
  test('the default entry is coherent with the sample observation and command', () => {
    const entry = makeLedgerEntry();
    expect(entry.seq).toBe(1);
    expect(entry.scope).toStrictEqual(makeScope());
    expect(entry.digest).toMatch(/^dg_[0-9a-f]{32}$/);
    expect(entry.command.target?.signature).toBe(makeElement().signature);
    expect(entry.status).toBe('applied');
    expect(entry.effect).toBe('applied');
    expect(entry.effects).toEqual(['interact']);
    expect(entry.navigated).toBe(false);
    expect(entry.finishedAt).toBeGreaterThanOrEqual(entry.startedAt);
    expect(entry.observationOrdinal).toBe(1);
    expect(entry.url).toBe(FIXTURE_URL);
    expect(entry.postconditions).toEqual([]);
    expectJsonSafe(entry);
  });

  test('the default entry spans exactly the default outcome duration on the coordinator clock', () => {
    const entry = makeLedgerEntry();
    expect(entry.finishedAt - entry.startedAt).toBe(makeOutcome('applied', 'applied').durationMs);
    expect(entry.startedAt).toBe(FIXTURE_START);
  });

  test('overrides win', () => {
    const entry = makeLedgerEntry({
      seq: 3,
      status: 'uncertain',
      effect: 'uncertain',
      navigated: true,
    });
    expect(entry).toMatchObject({
      seq: 3,
      status: 'uncertain',
      effect: 'uncertain',
      navigated: true,
    });
  });
});

describe('makeRequest and makeCheckpoint', () => {
  test('the default request has only a goal and a start url, both JSON-safe', () => {
    const request = makeRequest();
    expect(request.goal.length).toBeGreaterThan(0);
    expect(request.startUrl).toBe(FIXTURE_URL);
    expectJsonSafe(request);
    expect(makeRequest({ goal: 'Do it', inputs: { name: 'Ada' } })).toMatchObject({
      goal: 'Do it',
      inputs: { name: 'Ada' },
    });
  });

  test('the default checkpoint is a complete paused run, JSON-safe, with a well-formed integrity string', () => {
    const checkpoint = makeCheckpoint();
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.id).toMatch(/^ck_[0-9a-f]{12}$/);
    expect(checkpoint.runId).toBe(FIXTURE_IDS.run);
    expect(checkpoint.sessionId).toBe(FIXTURE_IDS.session);
    expect(checkpoint.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(checkpoint.request.goal).toBe(makeRequest().goal);
    expect(checkpoint.request.authorization.origins).toEqual([FIXTURE_ORIGIN]);
    expect(checkpoint.request.authorization.grants).toEqual([]);
    expect(checkpoint.startOrigin).toBe(FIXTURE_ORIGIN);
    expect(checkpoint.locationTrust).toBe('authoritative');
    expect(checkpoint.consumedApprovalIds).toEqual([]);
    expect(checkpoint.usage).toStrictEqual({
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
    expect(checkpoint.pending.kind).toBe('needs_input');
    expectJsonSafe(checkpoint);
  });

  test('checkpoint overrides win', () => {
    const checkpoint = makeCheckpoint({
      step: 4,
      ledger: [makeLedgerEntry()],
      pending: { kind: 'uncertain_effect', entries: [1] },
    });
    expect(checkpoint.step).toBe(4);
    expect(checkpoint.ledger).toHaveLength(1);
    expect(checkpoint.pending).toStrictEqual({ kind: 'uncertain_effect', entries: [1] });
    expectJsonSafe(checkpoint);
  });
});

describe('authorization and budget defaults', () => {
  test('the default authorization is strict: it never assumes an unclassified command is routine and grants nothing', () => {
    const authorization = makeNormalizedAuthorization();
    expect(authorization.assumeUnclassifiedRoutine).toBe(false);
    expect(authorization.grants).toEqual([]);
    expect(authorization.origins).toEqual([FIXTURE_ORIGIN]);
    expect(authorization.operations).toEqual([...TASK_HOST_OPERATIONS]);
    expect(authorization.operations).not.toBe(TASK_HOST_OPERATIONS);
    expect(makeNormalizedAuthorization({ assumeUnclassifiedRoutine: true }).origins).toEqual([
      FIXTURE_ORIGIN,
    ]);
    expectJsonSafe(authorization);
  });

  test('the default usage is all zero and every override lands on its own counter', () => {
    const usage = makeBudgetUsage();
    expect(Object.values(usage).every(value => value === 0)).toBe(true);
    expect(Object.keys(usage).sort()).toEqual(
      [
        'steps',
        'modelCalls',
        'staleRetries',
        'noProgress',
        'uncertainEffects',
        'prematureDone',
        'invalidDecisions',
        'rejectedCommands',
        'deciderFailures',
        'hostFailures',
        'elapsedMs',
      ].sort()
    );
    expect(makeBudgetUsage({ hostFailures: 2 })).toStrictEqual({ ...usage, hostFailures: 2 });
  });
});

describe('decider result builders', () => {
  test('deciderOk wraps a decision with a matching exchange', () => {
    const decision = makeActionDecision();
    const result: TaskDeciderResult<TaskActionDecision> = deciderOk('action', decision);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe(decision);
      expect(result.exchange.stage).toBe('action');
    }
    expectJsonSafe(result);
  });

  test('an exchange is internally consistent: attempts equal attemptLog and tokens follow the byte ratio', () => {
    const exchange = makeExchange('completion');
    expect(exchange.stage).toBe('completion');
    expect(exchange.attempts).toBe(exchange.attemptLog.length);
    expect(exchange.estimatedInputTokens).toBe(
      Math.ceil(exchange.requestBytes / TASK_TYPESAFE_LIMITS.bytesPerToken)
    );
    expect(exchange.goalVerified).toBe(true);
    expectJsonSafe(exchange);
    expect(makeExchange('action', { provider: 'other' }).provider).toBe('other');
    expect(deciderOk('action', makeActionDecision(), { latencyMs: 99 })).toMatchObject({
      exchange: { latencyMs: 99 },
    });
  });

  test('deciderFail carries a redacted error and marks transient codes retryable', () => {
    const transient = deciderFail('RATE_LIMITED');
    expect(transient.ok).toBe(false);
    if (!transient.ok) {
      expect(transient.error.code).toBe('RATE_LIMITED');
      expect(transient.error.retryable).toBe(true);
    }
    const permanent = deciderFail('INVALID_RESPONSE');
    if (!permanent.ok) {
      expect(permanent.error.retryable).toBe(false);
    }
    expect(deciderFail().ok).toBe(false);
    const custom = deciderFail('HTTP_ERROR', { status: 503, retryable: false });
    if (!custom.ok) {
      expect(custom.error).toMatchObject({ code: 'HTTP_ERROR', status: 503, retryable: false });
    }
    expectJsonSafe(transient);
  });

  test('decision builders return valid defaults and honor overrides', () => {
    const action: TaskActionDecision = makeActionDecision();
    expect(action).toMatchObject({ operation: 'CLICK', target: { kind: 'target', id: 't1' } });
    expect(action.confidence).toBe(
      Math.min(action.operationConfidence, action.targetConfidence ?? 1)
    );
    expect(
      makeActionDecision({ operation: 'DONE', target: { kind: 'not_applicable' } })
    ).toMatchObject({
      operation: 'DONE',
    });
    const argument: TaskArgumentDecision = makeArgumentDecision();
    expect(argument).toMatchObject({ kind: 'candidate', candidateId: 'c1' });
    expect(makeArgumentDecision({ candidateId: 'c4' })).toMatchObject({ candidateId: 'c4' });
    expect(makeNoArgumentDecision(0.2)).toStrictEqual({
      kind: 'none_appropriate',
      confidence: 0.2,
    });
    const commitment: TaskCommitmentDecision = makeCommitmentDecision();
    expect(commitment).toMatchObject({ commitment: 'NONE', agreement: 'single' });
    const completion: TaskCompletionDecision = makeCompletionDecision();
    expect(completion).toMatchObject({ verdict: 'SATISFIED', evidenceTargetIds: ['t1'] });
    expect(makeCompletionDecision({ verdict: 'NOT_SATISFIED' }).verdict).toBe('NOT_SATISFIED');
    for (const decision of [action, argument, commitment, completion]) {
      expectJsonSafe(decision);
    }
  });
});

describe('makeFakeHost', () => {
  const observeRequest = { sessionId: FIXTURE_IDS.session };

  test('is a TaskHost whose capabilities and location follow the capabilities option', async () => {
    const fake = makeFakeHost();
    const host: TaskHost = fake.host;
    const capabilities = await host.capabilities();
    expect(capabilities).toStrictEqual({ ok: true, value: makeCapabilities() });
    const location = await must(host.location, 'location')();
    expect(location).toStrictEqual({
      ok: true,
      value: { url: FIXTURE_URL, origin: FIXTURE_ORIGIN },
    });
    expect(fake.calls.capabilities).toHaveLength(1);
    expect(fake.calls.location).toHaveLength(1);
  });

  test('has no location when the host cannot report one, as the contract requires', () => {
    const fake = makeFakeHost({
      capabilities: makeCapabilities({ authoritativeLocation: false }),
    });
    expect('location' in fake.host).toBe(false);
  });

  test('location can be scripted and defaults to the first observation', async () => {
    const fixed = makeFakeHost({ location: { url: 'https://x.test/p', origin: 'https://x.test' } });
    expect(await must(fixed.host.location, 'location')()).toStrictEqual({
      ok: true,
      value: { url: 'https://x.test/p', origin: 'https://x.test' },
    });
    const derived = makeFakeHost({
      observations: [makeObservation({ url: 'https://y.test/q' })],
    });
    expect(await must(derived.host.location, 'location')()).toStrictEqual({
      ok: true,
      value: { url: 'https://y.test/q', origin: 'https://y.test' },
    });
    const scripted = makeFakeHost({
      location: () => ({
        ok: false,
        error: { code: 'HOST_UNAVAILABLE', message: 'gone', retryable: false },
      }),
    });
    expect((await must(scripted.host.location, 'location')()).ok).toBe(false);
  });

  test('capabilities can fail', async () => {
    const error = { code: 'HOST_UNAVAILABLE', message: 'no bridge', retryable: true } as const;
    const fake = makeFakeHost({ capabilities: { error } });
    expect(await fake.host.capabilities()).toStrictEqual({ ok: false, error });
    expect('location' in fake.host).toBe(false);
  });

  test('observe walks the script in order, then keeps repeating the last page', async () => {
    const first = makeObservation({ title: 'one' });
    const second = makeObservation({ title: 'two' });
    const fake = makeFakeHost({ observations: [first, second] });
    const titles: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await fake.host.observe(observeRequest);
      titles.push(result.ok ? result.value.title : 'error');
    }
    expect(titles).toEqual(['one', 'two', 'two', 'two']);
    expect(fake.calls.observe).toHaveLength(4);
  });

  test('each observation is re-stamped like a real host: new snapshot id, request session, rising sequence', async () => {
    const fake = makeFakeHost();
    const a = must(await fake.host.observe({ sessionId: 'ses_aaaaaaaaaaaa' }), 'a');
    const b = must(await fake.host.observe({ sessionId: 'ses_aaaaaaaaaaaa' }), 'b');
    if (!a.ok || !b.ok) {
      throw new Error('observe failed');
    }
    expect(a.value.sessionId).toBe('ses_aaaaaaaaaaaa');
    expect(a.value.snapshotId).toMatch(/^snap_[0-9a-f]{12}$/);
    expect(b.value.snapshotId).not.toBe(a.value.snapshotId);
    expect(a.value.sequence).toBe(1);
    expect(b.value.sequence).toBe(2);
    expect(b.value.fingerprint).toBe(a.value.fingerprint);
    expect(b.value.elements).toStrictEqual(a.value.elements);
  });

  test('the sequence honors minSequence: max(own counter + 1, minSequence + 1)', async () => {
    const fake = makeFakeHost();
    const jump = await fake.host.observe({ sessionId: FIXTURE_IDS.session, minSequence: 10 });
    const next = await fake.host.observe({ sessionId: FIXTURE_IDS.session, minSequence: 3 });
    const low = await fake.host.observe({ sessionId: FIXTURE_IDS.session, minSequence: 0 });
    expect(jump.ok && jump.value.sequence).toBe(11);
    expect(next.ok && next.value.sequence).toBe(12);
    expect(low.ok && low.value.sequence).toBe(13);
  });

  test('restamp can be turned off to serve observations exactly as scripted', async () => {
    const scripted = makeObservation({ snapshotId: 'snap_00000000cafe', sequence: 9 });
    const fake = makeFakeHost({ observations: [scripted], restamp: false });
    const result = await fake.host.observe({ sessionId: 'ses_bbbbbbbbbbbb' });
    expect(result).toStrictEqual({ ok: true, value: scripted });
  });

  test('restamped snapshot ids come from an injected createId', async () => {
    const fake = makeFakeHost({ createId: prefix => `${prefix}_00000000face` });
    const result = await fake.host.observe(observeRequest);
    expect(result.ok && result.value.snapshotId).toBe('snap_00000000face');
  });

  test('an observation script entry can be a host error', async () => {
    const error = { code: 'OBSERVE_FAILED', message: 'boom', retryable: true } as const;
    const fake = makeFakeHost({ observations: [{ error }, makeObservation()] });
    expect(await fake.host.observe(observeRequest)).toStrictEqual({ ok: false, error });
    expect((await fake.host.observe(observeRequest)).ok).toBe(true);
  });

  test('observe and execute answer an aborted signal with a cancellation, without consuming the script', async () => {
    const fake = makeFakeHost({
      observations: [makeObservation({ title: 'scripted' })],
      outcomes: [makeOutcome('uncertain', 'uncertain')],
    });
    const controller = new AbortController();
    controller.abort();
    const observed = await fake.host.observe(observeRequest, controller.signal);
    expect(observed.ok).toBe(false);
    if (!observed.ok) {
      expect(observed.error.code).toBe('CANCELLED');
    }
    const request = makeCommandRequest({ requestId: 'req_0000000000a1' });
    const outcome = await fake.host.execute(request, controller.signal);
    expect(outcome).toMatchObject({
      status: 'failed',
      effect: 'none',
      code: 'EXECUTION_CANCELLED',
      requestId: 'req_0000000000a1',
    });
    const next = await fake.host.execute(request);
    expect(next.status).toBe('uncertain');
    const page = await fake.host.observe(observeRequest);
    expect(page.ok && page.value.title).toBe('scripted');
  });

  test('execute records requests, stamps the request id and walks the outcome script', async () => {
    const fake = makeFakeHost({
      outcomes: [makeOutcome('rejected_stale', 'none', { staleReason: 'signature_changed' })],
    });
    const request = makeCommandRequest({ requestId: 'req_00000000b001' });
    const stale = await fake.host.execute(request);
    expect(stale).toMatchObject({
      status: 'rejected_stale',
      staleReason: 'signature_changed',
      requestId: 'req_00000000b001',
    });
    const fallback = await fake.host.execute(makeCommandRequest({ requestId: 'req_00000000b002' }));
    expect(fallback).toMatchObject({
      status: 'applied',
      effect: 'applied',
      requestId: 'req_00000000b002',
    });
    expect(fake.calls.execute.map(call => call.requestId)).toEqual([
      'req_00000000b001',
      'req_00000000b002',
    ]);
  });

  test('the request id is stamped unless the test asks to keep a scripted one', async () => {
    const wrong = makeOutcome('applied', 'applied', { requestId: 'req_0000000000bd' });
    const stamped = makeFakeHost({ outcomes: [wrong] });
    expect(
      (await stamped.host.execute(makeCommandRequest({ requestId: 'req_000000000abc' }))).requestId
    ).toBe('req_000000000abc');
    const raw = makeFakeHost({ outcomes: [wrong], stampRequestId: false });
    expect(
      (await raw.host.execute(makeCommandRequest({ requestId: 'req_000000000abc' }))).requestId
    ).toBe('req_0000000000bd');
  });

  test('an outcome script entry can be a function of the request', async () => {
    const fake = makeFakeHost({
      outcomes: [
        request =>
          request.command.operation === 'FILL'
            ? makeOutcome('failed', 'none', { code: 'NOT_EDITABLE' })
            : makeOutcome('applied', 'applied'),
      ],
    });
    const outcome = await fake.host.execute(
      makeCommandRequest({ command: makeHostCommand('FILL') })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'NOT_EDITABLE' });
  });

  test('default outcomes are honest per operation: reads and waits change nothing, writes apply', async () => {
    const fake = makeFakeHost();
    const read = await fake.host.execute(makeCommandRequest({ command: makeHostCommand('READ') }));
    expect(read).toMatchObject({ status: 'applied', effect: 'none', readback: { kind: 'read' } });
    const wait = await fake.host.execute(makeCommandRequest({ command: makeHostCommand('WAIT') }));
    expect(wait).toMatchObject({
      status: 'applied',
      effect: 'none',
      readback: { kind: 'wait', waitedMs: 500 },
    });
    const click = await fake.host.execute(
      makeCommandRequest({ command: makeHostCommand('CLICK') })
    );
    expect(click).toMatchObject({ status: 'applied', effect: 'applied' });
    const operations: readonly TaskHostOperation[] = [
      'FILL',
      'SELECT',
      'SET_CHECKED',
      'PRESS',
      'SCROLL',
      'NAVIGATE',
      'SUBMIT',
    ];
    for (const operation of operations) {
      const outcome = await fake.host.execute(
        makeCommandRequest({ command: makeHostCommand(operation) })
      );
      expect(outcome).toMatchObject({ status: 'applied', effect: 'applied' });
    }
  });

  test('release and dispose are recorded in call order, and release can be left out', async () => {
    const fake = makeFakeHost();
    await fake.host.capabilities();
    await fake.host.observe(observeRequest);
    await must(fake.host.release, 'release')('ses_cccccccccccc');
    await fake.host.dispose();
    expect(fake.calls.release).toEqual(['ses_cccccccccccc']);
    expect(fake.calls.dispose).toHaveLength(1);
    expect(fake.calls.order).toEqual(['capabilities', 'observe', 'release', 'dispose']);
    expect(makeFakeHost({ release: false }).host.release).toBeUndefined();
  });

  test.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a string', '3'],
    ['null', null],
  ])(
    'a malformed minSequence (%s) is a PROTOCOL_ERROR that neither consumes the script nor moves the counter',
    async (_label, minSequence) => {
      const fake = makeFakeHost({
        observations: [makeObservation({ title: 'one' }), makeObservation({ title: 'two' })],
      });
      const request = {
        sessionId: FIXTURE_IDS.session,
        minSequence,
      } as unknown as TaskObserveRequest;
      const refused = await fake.host.observe(request);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe('PROTOCOL_ERROR');
        expect(refused.error.retryable).toBe(false);
      }
      const first = await fake.host.observe({ sessionId: FIXTURE_IDS.session });
      expect(first.ok && [first.value.title, first.value.sequence]).toEqual(['one', 1]);
    }
  );

  test('a missing or empty session id is a PROTOCOL_ERROR', async () => {
    const fake = makeFakeHost();
    for (const sessionId of ['', undefined, 7]) {
      const refused = await fake.host.observe({ sessionId } as unknown as TaskObserveRequest);
      expect(refused.ok).toBe(false);
    }
    expect((await fake.host.observe({ sessionId: FIXTURE_IDS.session })).ok).toBe(true);
  });

  test('minSequence 0 and a large safe integer are accepted', async () => {
    const fake = makeFakeHost();
    const zero = await fake.host.observe({ sessionId: FIXTURE_IDS.session, minSequence: 0 });
    const large = await fake.host.observe({
      sessionId: FIXTURE_IDS.session,
      minSequence: 1_000_000,
    });
    expect([zero.ok && zero.value.sequence, large.ok && large.value.sequence]).toEqual([
      1, 1_000_001,
    ]);
  });

  test.each([true, false])(
    'served observations are independent copies (restamp %s): a consumer cannot change the script or the next page',
    async restamp => {
      const scripted = makeObservation({ elements: makePageElements() });
      const before = roundTrip(scripted);
      const fake = makeFakeHost({ observations: [scripted], restamp });
      const first = await fake.host.observe(observeRequest);
      const second = await fake.host.observe(observeRequest);
      if (!first.ok || !second.ok) {
        throw new Error('observe failed');
      }
      expect(first.value).not.toBe(scripted);
      expect(first.value.elements).not.toBe(scripted.elements);
      expect(first.value.elements).not.toBe(second.value.elements);
      expect(first.value.elements[0]).not.toBe(second.value.elements[0]);
      expect(first.value.page.scroll.directions).not.toBe(second.value.page.scroll.directions);
      Object.assign(must(first.value.elements[0], 'element').state, { disabled: true });
      (first.value.elements as TaskElement[]).pop();
      expect(second.value.elements).toHaveLength(scripted.elements.length);
      expect(must(second.value.elements[0], 'element').state.disabled).toBe(false);
      expect(roundTrip(scripted)).toStrictEqual(before);
      expect(scripted.elements[0]?.state.disabled).toBe(false);
    }
  );

  test('a scripted observation that holds undefined or an own __proto__ key is served faithfully', async () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"label":"x"}') as object;
    const scripted = {
      ...makeObservation(),
      title: undefined,
      notices: [undefined, hostile],
    } as unknown as TaskObservation;
    const fake = makeFakeHost({ observations: [scripted], restamp: false });
    const served = await fake.host.observe(observeRequest);
    if (!served.ok) {
      throw new Error('observe failed');
    }
    expect('title' in served.value).toBe(true);
    expect(served.value.title).toBeUndefined();
    expect(served.value.notices).toHaveLength(2);
    expect(served.value.notices[0]).toBeUndefined();
    const copy = served.value.notices[1] as unknown as object;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toEqual(['__proto__', 'label']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('a cyclic scripted observation is copied with its cycle, not recursed into forever', async () => {
    const cyclic: Record<string, unknown> = { ...makeObservation() };
    cyclic.self = cyclic;
    const fake = makeFakeHost({
      observations: [cyclic as unknown as TaskObservation],
      restamp: false,
    });
    const served = await fake.host.observe(observeRequest);
    if (!served.ok) {
      throw new Error('observe failed');
    }
    const copy = served.value as unknown as Record<string, unknown>;
    expect(copy.self).toBe(copy);
    expect(copy).not.toBe(cyclic);
  });

  test('capabilities and scripted outcomes are served as independent copies', async () => {
    const capabilities = makeCapabilities();
    const outcome = makeOutcome('navigated', 'applied', {
      navigation: {
        kind: 'same_document',
        fromDocumentId: FIXTURE_IDS.document,
        fromUrl: FIXTURE_URL,
        realmLost: false,
      },
      readback: { kind: 'read', text: 'passage' },
    });
    const fake = makeFakeHost({ capabilities, outcomes: [outcome] });
    const served = await fake.host.capabilities();
    const again = await fake.host.capabilities();
    if (!served.ok || !again.ok) {
      throw new Error('capabilities failed');
    }
    expect(served.value).not.toBe(capabilities);
    expect(served.value).not.toBe(again.value);
    expect(served.value.operations).not.toBe(again.value.operations);
    expect(served.value.redaction).not.toBe(again.value.redaction);
    expect(served.value).toStrictEqual(capabilities);
    const executed = await fake.host.execute(makeCommandRequest());
    expect(executed).toStrictEqual({ ...outcome, requestId: FIXTURE_IDS.request });
    expect(executed.navigation).not.toBe(outcome.navigation);
    expect(executed.readback).not.toBe(outcome.readback);
  });

  test('the default location follows the page served last, so a navigation script stays coherent', async () => {
    const fake = makeFakeHost({
      observations: [
        makeObservation({ url: 'https://a.test/one' }),
        makeObservation({ url: 'https://b.test/two' }),
        { error: { code: 'OBSERVE_FAILED', message: 'x', retryable: true } },
      ],
    });
    const locate = must(fake.host.location, 'location');
    expect(await locate()).toStrictEqual({
      ok: true,
      value: { url: 'https://a.test/one', origin: 'https://a.test' },
    });
    await fake.host.observe(observeRequest);
    expect(await locate()).toStrictEqual({
      ok: true,
      value: { url: 'https://a.test/one', origin: 'https://a.test' },
    });
    await fake.host.observe(observeRequest);
    expect(await locate()).toStrictEqual({
      ok: true,
      value: { url: 'https://b.test/two', origin: 'https://b.test' },
    });
    await fake.host.observe(observeRequest);
    expect(await locate()).toStrictEqual({
      ok: true,
      value: { url: 'https://b.test/two', origin: 'https://b.test' },
    });
  });

  test('the signals handed to capabilities and location are recorded, so a test can assert they were forwarded', async () => {
    const fake = makeFakeHost();
    const controller = new AbortController();
    await fake.host.capabilities(controller.signal);
    await fake.host.capabilities();
    await must(fake.host.location, 'location')(controller.signal);
    expect(fake.calls.capabilities).toEqual([controller.signal, undefined]);
    expect(fake.calls.capabilities[0]).toBe(controller.signal);
    expect(fake.calls.location).toHaveLength(1);
    expect(fake.calls.location[0]).toBe(controller.signal);
  });

  test('the default location also follows a verbatim page, and a page without a url leaves it unchanged', async () => {
    const fake = makeFakeHost({
      restamp: false,
      observations: [
        makeObservation({ url: 'https://a.test/one' }),
        makeObservation({ url: 'https://b.test/two' }),
        { ...makeObservation(), url: undefined, origin: undefined } as unknown as TaskObservation,
      ],
    });
    const locate = must(fake.host.location, 'location');
    await fake.host.observe(observeRequest);
    await fake.host.observe(observeRequest);
    expect(await locate()).toStrictEqual({
      ok: true,
      value: { url: 'https://b.test/two', origin: 'https://b.test' },
    });
    await fake.host.observe(observeRequest);
    expect(await locate()).toStrictEqual({
      ok: true,
      value: { url: 'https://b.test/two', origin: 'https://b.test' },
    });
  });

  test('the location a caller receives is a copy: changing it changes neither the option nor the next answer', async () => {
    const configured = { url: 'https://x.test/p', origin: 'https://x.test' };
    const fake = makeFakeHost({ location: configured });
    const locate = must(fake.host.location, 'location');
    const first = await locate();
    if (!first.ok) {
      throw new Error('location failed');
    }
    Object.assign(first.value, { origin: 'https://evil.test' });
    expect(configured.origin).toBe('https://x.test');
    expect(await locate()).toStrictEqual({ ok: true, value: configured });
    const second = await locate();
    expect(second.ok && second.value).not.toBe(configured);
  });

  test('an explicit location option is never overridden by the pages served', async () => {
    const fake = makeFakeHost({
      observations: [makeObservation({ url: 'https://a.test/one' })],
      location: { url: 'https://fixed.test/p', origin: 'https://fixed.test' },
    });
    await fake.host.observe(observeRequest);
    expect(await must(fake.host.location, 'location')()).toStrictEqual({
      ok: true,
      value: { url: 'https://fixed.test/p', origin: 'https://fixed.test' },
    });
  });

  test('two fake hosts do not share state', async () => {
    const one = makeFakeHost();
    const two = makeFakeHost();
    await one.host.observe(observeRequest);
    expect(two.calls.observe).toHaveLength(0);
    const first = await two.host.observe(observeRequest);
    expect(first.ok && first.value.sequence).toBe(1);
  });
});

describe('makeFakeDecider', () => {
  const context = { goal: 'g', step: 1, runId: FIXTURE_IDS.run, callIndex: 1 };
  const actionRequest = {
    goal: 'g',
    step: 1,
    observation: makeObservation(),
    offers: { operations: ['DONE' as const], targets: {} },
    capabilities: makeCapabilities(),
    inputs: [],
    history: [],
    maxStateBytes: 22000,
  };

  test('serves each stage from its own script, in order, and records every call', async () => {
    const first = deciderOk('action', makeActionDecision({ operation: 'CLICK' }));
    const second = deciderOk(
      'action',
      makeActionDecision({ operation: 'DONE', target: { kind: 'not_applicable' } })
    );
    const fake = makeFakeDecider({ chooseAction: [first, second] });
    const decider: TaskDecider = fake.decider;
    expect(await decider.chooseAction(actionRequest, context)).toBe(first);
    expect(await decider.chooseAction(actionRequest, context)).toBe(second);
    expect(fake.calls.chooseAction).toHaveLength(2);
    expect(fake.calls.chooseAction[0]).toStrictEqual({ request: actionRequest, context });
    expect(fake.calls.chooseArgument).toHaveLength(0);
  });

  test('an exhausted script fails loudly instead of inventing a decision', async () => {
    const fake = makeFakeDecider({ chooseAction: [] });
    const result = await fake.decider.chooseAction(actionRequest, context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED');
      expect(result.error.message).toMatch(/exhausted/i);
      expect(result.error.message).toMatch(/chooseAction/);
    }
    const unscripted = makeFakeDecider();
    const other = await unscripted.decider.verifyCompletion(
      {
        goal: 'g',
        step: 1,
        observation: makeObservation(),
        history: [],
        inputs: [],
        evidenceSlots: 2,
        collectedEvidence: [],
        expected: [],
        maxStateBytes: 22000,
      },
      context
    );
    expect(other.ok).toBe(false);
  });

  test('classifyCommitment exists only when it is scripted, because its absence has a meaning', () => {
    expect('classifyCommitment' in makeFakeDecider().decider).toBe(false);
    expect('classifyCommitment' in makeFakeDecider({ classifyCommitment: [] }).decider).toBe(true);
  });

  test('a script entry can be a function of the request and context', async () => {
    const fake = makeFakeDecider({
      chooseArgument: [
        (request, ctx) =>
          deciderOk(
            'argument',
            makeArgumentDecision({ candidateId: `c${request.step + ctx.callIndex}` })
          ),
      ],
      classifyCommitment: [
        () => deciderOk('commitment', makeCommitmentDecision({ commitment: 'PURCHASE' })),
      ],
      verifyCompletion: [() => deciderOk('completion', makeCompletionDecision())],
    });
    const argument = await fake.decider.chooseArgument(
      {
        goal: 'g',
        step: 3,
        observation: makeObservation(),
        operation: 'FILL',
        slot: 'value',
        candidates: [],
        inputs: [],
        history: [],
        maxStateBytes: 22000,
      },
      { ...context, callIndex: 2 }
    );
    expect(argument.ok && argument.decision).toMatchObject({ candidateId: 'c5' });
    const classify = must(fake.decider.classifyCommitment, 'classifyCommitment');
    const commitment = await classify(
      {
        goal: 'g',
        step: 1,
        observation: makeObservation(),
        command: makeRedactedCommand(),
        maxStateBytes: 22000,
      },
      context
    );
    expect(commitment.ok && commitment.decision.commitment).toBe('PURCHASE');
    expect(fake.calls.chooseArgument).toHaveLength(1);
    expect(fake.calls.classifyCommitment).toHaveLength(1);
  });

  test('two fake deciders do not share state', async () => {
    const one = makeFakeDecider({ chooseAction: [deciderOk('action', makeActionDecision())] });
    const two = makeFakeDecider({ chooseAction: [deciderOk('action', makeActionDecision())] });
    await one.decider.chooseAction(actionRequest, context);
    expect(two.calls.chooseAction).toHaveLength(0);
    expect((await two.decider.chooseAction(actionRequest, context)).ok).toBe(true);
  });
});

describe('makeFakeExecutor', () => {
  const click: ActionCommand = { type: 'click', parameters: { selector: '#go' } };

  test('records every call with its options and walks the script, then falls back to success', async () => {
    const failure = makeExecutionResult({
      success: false,
      status: 'failed',
      error: 'nope',
      errorCode: 'EXECUTION_FAILED',
      effect: 'none',
    });
    const fake = makeFakeExecutor([failure]);
    const executor: TaskActionExecutor = fake.executor;
    const options: ExecutionOptions = { strict: true };
    expect(await executor.executeAction(click, options)).toBe(failure);
    const fallback = await executor.executeAction(click);
    expect(fallback).toStrictEqual(makeExecutionResult());
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toStrictEqual({ action: click, options });
    expect(fake.calls[1]?.options).toBeUndefined();
  });

  test('a script entry can be a function of the call', async () => {
    const fake = makeFakeExecutor([
      (action, options) =>
        makeExecutionResult({ data: { type: action.type, strict: options?.strict === true } }),
    ]);
    const result = await fake.executor.executeAction(click, { strict: true });
    expect(result.data).toStrictEqual({ type: 'click', strict: true });
  });

  test('the default result is a completed, applied success', () => {
    expect(makeExecutionResult()).toStrictEqual({
      success: true,
      status: 'completed',
      timestamp: FIXTURE_START,
      effect: 'applied',
    });
    expect(makeExecutionResult({ effect: 'uncertain' }).effect).toBe('uncertain');
  });
});

describe('the fixtures module is DOM-free', () => {
  const FORBIDDEN = new Set([
    'window',
    'document',
    'navigator',
    'location',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'localStorage',
    'sessionStorage',
  ]);

  function forbiddenGlobals(source: string): string[] {
    const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2020, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) {
        const parent = node.parent;
        const isMemberName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node);
        if (!isMemberName) {
          found.push(node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  }

  test('the scanner flags real uses and ignores member names, comments and strings', () => {
    expect(forbiddenGlobals('const title = document.title;')).toEqual(['document']);
    expect(forbiddenGlobals('const el: HTMLElement = x; window.scrollTo(0, 0);')).toEqual([
      'HTMLElement',
      'window',
    ]);
    expect(forbiddenGlobals('const o = { location: 1 }; o.location; o.document;')).toEqual([]);
    expect(forbiddenGlobals('// document\nconst a = "window";')).toEqual([]);
  });

  test('agent-fixtures touches no browser global (the control above proves the scan measures something)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'helpers', 'agent-fixtures.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(2000);
    expect(forbiddenGlobals(source)).toEqual([]);
  });

  test('the same scan does flag the DOM harness, so it is not blind to the file shape', () => {
    const source = fs.readFileSync(path.join(__dirname, 'helpers', 'domHarness.ts'), 'utf8');
    const found = forbiddenGlobals(source);
    expect(found).toContain('document');
    expect(found).toContain('window');
  });
});

describe('domHarness: rects, offsets and visibility', () => {
  beforeEach(() => {
    resetDom();
    resetGuideCache();
  });
  afterEach(() => {
    resetDom();
  });

  test('an unboxed element has no layout, like jsdom, and setBox gives it one with defaults', () => {
    const div = document.createElement('div');
    document.body.append(div);
    expect(div.getBoundingClientRect().width).toBe(0);
    expect(div.offsetWidth).toBe(0);
    expect(setBox(div, { top: 20 })).toBe(div);
    const rect = div.getBoundingClientRect();
    expect(rect).toMatchObject({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      width: 160,
      height: 32,
      right: 170,
      bottom: 52,
    });
    expect(div.offsetWidth).toBe(160);
    expect(div.offsetHeight).toBe(32);
    expect(div.offsetTop).toBe(20);
    expect(div.offsetLeft).toBe(10);
    expect(div.clientWidth).toBe(160);
    expect(div.clientHeight).toBe(32);
    expect(div.getClientRects()).toHaveLength(1);
    expect(div.offsetParent).toBe(document.body);
    expect(setBox(document.body, { top: 0 }).offsetParent).toBeNull();
    expect(setBox(document.documentElement, { top: 0 }).offsetParent).toBeNull();
  });

  test('a position:fixed element has no offsetParent, a rendered static or relative one has the body', () => {
    const fixed = mount(document.createElement('div'), { top: 5 });
    fixed.style.position = 'fixed';
    const relative = mount(document.createElement('div'), { top: 50 });
    relative.style.position = 'relative';
    const plain = mount(document.createElement('div'), { top: 90 });
    expect(fixed.getBoundingClientRect().height).toBe(32);
    expect(fixed.offsetParent).toBeNull();
    expect(relative.offsetParent).toBe(document.body);
    expect(plain.offsetParent).toBe(document.body);
    fixed.style.position = 'static';
    expect(fixed.offsetParent).toBe(document.body);
    plain.style.display = 'none';
    expect(plain.offsetParent).toBeNull();
  });

  test('explicit box values are used as given, including zero-size boxes', () => {
    const div = document.createElement('div');
    document.body.append(div);
    setBox(div, { top: 5, left: 7, width: 30, height: 9 });
    expect(div.getBoundingClientRect()).toMatchObject({
      left: 7,
      top: 5,
      width: 30,
      height: 9,
      right: 37,
      bottom: 14,
    });
    setBox(div, { top: 0, left: 0, width: 0, height: 0 });
    expect(div.getBoundingClientRect()).toMatchObject({ width: 0, height: 0 });
    expect(div.getClientRects()).toHaveLength(1);
    expect(div.getBoundingClientRect().toJSON()).toStrictEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  test('getClientRects behaves like a DOMRectList: item() is null out of range and the list is indexable', () => {
    const boxed = mount(document.createElement('div'), { top: 5 });
    const list = boxed.getClientRects();
    expect(list).toHaveLength(1);
    expect(list.item(0)).toStrictEqual(list[0]);
    expect(list.item(1)).toBeNull();
    expect(list.item(-1)).toBeNull();
    const unrendered = document.createElement('div');
    document.body.append(unrendered);
    expect(setBox(unrendered, { top: 0 }).getClientRects().item(0)).not.toBeNull();
    unrendered.style.display = 'none';
    expect(unrendered.getClientRects().item(0)).toBeNull();
    expect(unrendered.getClientRects()).toHaveLength(0);
  });

  test('a later setBox replaces an earlier box', () => {
    const div = mount(document.createElement('div'), { top: 5 });
    setBox(div, { top: 500 });
    expect(div.getBoundingClientRect().top).toBe(500);
  });

  test('an element inside display:none, a hidden element and a detached element render nothing', () => {
    const host = mountHtml(
      '<div id="d" style="display:none"><b id="inner">x</b></div><div id="h" hidden></div>',
      false
    );
    const inner = must(host.querySelector<HTMLElement>('#inner'), 'inner');
    const hidden = must(host.querySelector<HTMLElement>('#h'), 'hidden');
    setBox(inner, { top: 0 });
    setBox(hidden, { top: 0 });
    for (const element of [inner, hidden]) {
      expect(element.getBoundingClientRect()).toMatchObject({ width: 0, height: 0 });
      expect(element.offsetWidth).toBe(0);
      expect(element.getClientRects()).toHaveLength(0);
      expect(element.offsetParent).toBeNull();
    }
    const detached = setBox(document.createElement('div'), { top: 0 });
    expect(detached.getBoundingClientRect().width).toBe(0);
    document.body.append(detached);
    expect(detached.getBoundingClientRect().width).toBe(160);
  });

  test('visibility:hidden does not change geometry', () => {
    const host = mountHtml('<div id="v" style="visibility:hidden">x</div>', false);
    const hiddenBox = setBox(must(host.querySelector<HTMLElement>('#v'), 'v'), { top: 0 });
    expect(hiddenBox.getBoundingClientRect().width).toBe(160);
  });

  test('mount appends to body by default or to a given parent, and returns the element', () => {
    const first = mount(document.createElement('div'), { top: 0 });
    expect(first.parentElement).toBe(document.body);
    const parent = mount(document.createElement('section'), { top: 0 });
    const child = mount(document.createElement('p'), { top: 40 }, parent);
    expect(child.parentElement).toBe(parent);
    expect(child.getBoundingClientRect().top).toBe(40);
  });

  test('layoutColumn stacks unboxed interactive elements and leaves explicit boxes alone', () => {
    const host = mountHtml(
      '<h1>Title</h1><button id="a">A</button><span>plain</span><a id="b" href="/x">B</a><input id="c">',
      false
    );
    const preset = setBox(must(host.querySelector<HTMLElement>('#b'), 'b'), { top: 999 });
    layoutColumn(host);
    const top = (selector: string): number =>
      must(host.querySelector<HTMLElement>(selector), selector).getBoundingClientRect().top;
    expect(top('h1')).toBe(10);
    expect(top('#a')).toBe(50);
    expect(preset.getBoundingClientRect().top).toBe(999);
    expect(top('#c')).toBe(130);
    expect(
      must(host.querySelector<HTMLElement>('span'), 'span').getBoundingClientRect().height
    ).toBe(0);
  });

  test.each([
    ['a link', '<a href="/x" id="t">x</a>'],
    ['a textarea', '<textarea id="t"></textarea>'],
    ['a select', '<select id="t"><option>a</option></select>'],
    ['a summary', '<details open><summary id="t">s</summary></details>'],
    ['a label', '<label id="t">l</label>'],
    ['a legend', '<fieldset><legend id="t">l</legend></fieldset>'],
    ['an element with a role', '<div role="switch" id="t"></div>'],
    ['a contenteditable element', '<div contenteditable="true" id="t"></div>'],
    ['a heading', '<h3 id="t">h</h3>'],
    ['a paragraph', '<p id="t">p</p>'],
    ['a list item', '<ul><li id="t">i</li></ul>'],
    ['a definition term', '<dl><dt id="t">t</dt></dl>'],
    ['a definition description', '<dl><dd id="t">d</dd></dl>'],
    ['an open dialog', '<dialog open id="t"></dialog>'],
    ['a form', '<form id="t"></form>'],
    ['a fieldset', '<fieldset id="t"></fieldset>'],
  ])('layoutColumn gives %s a box and a plain element none', (_label, html) => {
    const host = mountHtml(`${html}<span id="plain">x</span>`, false);
    layoutColumn(host);
    const target = must(host.querySelector<HTMLElement>('#t'), 'target');
    expect(target.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(
      must(host.querySelector<HTMLElement>('#plain'), 'plain').getBoundingClientRect().width
    ).toBe(0);
  });

  test('layoutColumn honors a custom row height and root', () => {
    const host = mountHtml('<button id="a">A</button><button id="b">B</button>', false);
    layoutColumn(host, 100);
    expect(must(host.querySelector<HTMLElement>('#a'), 'a').getBoundingClientRect().top).toBe(10);
    expect(must(host.querySelector<HTMLElement>('#b'), 'b').getBoundingClientRect().top).toBe(110);
  });

  test('mountHtml lays elements out by default and can be asked not to', () => {
    const laidOut = mountHtml('<button id="a">A</button>');
    expect(laidOut.parentElement).toBe(document.body);
    expect(must(laidOut.querySelector<HTMLElement>('#a'), 'a').getBoundingClientRect().width).toBe(
      160
    );
    const bare = mountHtml('<button id="z">Z</button>', false);
    expect(must(bare.querySelector<HTMLElement>('#z'), 'z').getBoundingClientRect().width).toBe(0);
  });

  test('the production observer sees an element only once it has a rendered box', () => {
    const host = mountHtml('<button>Visible once laid out</button>', false);
    expect(observePage().elements).toHaveLength(0);
    layoutColumn(host);
    expect(observePage().elements.map(element => element.label)).toEqual(['Visible once laid out']);
    const button = must(host.querySelector<HTMLElement>('button'), 'button');
    button.hidden = true;
    expect(observePage().elements).toHaveLength(0);
  });

  test('a box outside the viewport is not observed, and elementFromPoint-based covering works through the stubs', () => {
    installLayoutStubs();
    const host = mountHtml(
      '<button>Under</button><div role="dialog" id="modal">Modal</div>',
      false
    );
    const button = must(host.querySelector<HTMLElement>('button'), 'button');
    setBox(button, { top: 100 });
    expect(observePage().elements.map(element => element.label)).toEqual(['Under']);
    const modal = setBox(must(host.querySelector<HTMLElement>('#modal'), 'modal'), {
      top: 0,
      left: 0,
      width: 1000,
      height: 700,
    });
    expect(observePage().elements.map(element => element.label)).not.toContain('Under');
    setBox(modal, { top: 5000 });
    setBox(button, { top: 5000 });
    expect(observePage().elements).toHaveLength(0);
  });
});

describe('domHarness: checkVisibility', () => {
  beforeEach(() => {
    resetDom();
    installLayoutStubs();
  });
  afterEach(() => {
    resetDom();
  });

  test('is false for display:none anywhere in the chain and for detached nodes', () => {
    const host = mountHtml('<div style="display:none"><i id="a">x</i></div><p id="b">y</p>', false);
    expect(must(host.querySelector<HTMLElement>('#a'), 'a').checkVisibility()).toBe(false);
    expect(must(host.querySelector<HTMLElement>('#b'), 'b').checkVisibility()).toBe(true);
    expect(document.createElement('div').checkVisibility()).toBe(false);
  });

  test('visibility:hidden counts only when asked, under either option name', () => {
    const host = mountHtml('<div style="visibility:hidden"><i id="a">x</i></div>', false);
    const inner = must(host.querySelector<HTMLElement>('#a'), 'a');
    expect(inner.checkVisibility()).toBe(true);
    expect(inner.checkVisibility({ checkVisibilityCSS: true })).toBe(false);
    expect(inner.checkVisibility({ visibilityProperty: true })).toBe(false);
    expect(inner.checkVisibility({ checkOpacity: true })).toBe(true);
  });

  test('opacity:0 on the node or an ancestor counts only when asked', () => {
    const host = mountHtml('<div style="opacity:0"><i id="a">x</i></div><p id="b">y</p>', false);
    const inner = must(host.querySelector<HTMLElement>('#a'), 'a');
    expect(inner.checkVisibility()).toBe(true);
    expect(inner.checkVisibility({ checkOpacity: true })).toBe(false);
    expect(inner.checkVisibility({ opacityProperty: true })).toBe(false);
    expect(
      must(host.querySelector<HTMLElement>('#b'), 'b').checkVisibility({ checkOpacity: true })
    ).toBe(true);
  });
});

describe('domHarness: elementFromPoint', () => {
  beforeEach(() => {
    resetDom();
    installLayoutStubs();
  });
  afterEach(() => {
    resetDom();
  });

  function boxed(
    html: string,
    boxes: Readonly<Record<string, Parameters<typeof setBox>[1]>>
  ): HTMLElement {
    const host = mountHtml(html, false);
    for (const [selector, box] of Object.entries(boxes)) {
      setBox(must(host.querySelector<HTMLElement>(selector), selector), box);
    }
    return host;
  }

  test('the later element in document order is on top where boxes overlap', () => {
    const host = boxed('<div id="a"></div><div id="b"></div>', {
      '#a': { top: 0, left: 0, width: 100, height: 100 },
      '#b': { top: 50, left: 50, width: 100, height: 100 },
    });
    expect(document.elementFromPoint(10, 10)?.id).toBe('a');
    expect(document.elementFromPoint(75, 75)?.id).toBe('b');
    expect(document.elementFromPoint(140, 140)?.id).toBe('b');
    expect(host.isConnected).toBe(true);
  });

  test('a child is on top of its parent', () => {
    boxed('<div id="p"><span id="c"></span></div>', {
      '#p': { top: 0, left: 0, width: 100, height: 100 },
      '#c': { top: 10, left: 10, width: 20, height: 20 },
    });
    expect(document.elementFromPoint(15, 15)?.id).toBe('c');
    expect(document.elementFromPoint(60, 60)?.id).toBe('p');
  });

  test('boxes are half-open: the left and top edge hit, the right and bottom edge do not', () => {
    boxed('<div id="a"></div>', { '#a': { top: 100, left: 100, width: 50, height: 40 } });
    expect(document.elementFromPoint(100, 100)?.id).toBe('a');
    expect(document.elementFromPoint(149, 139)?.id).toBe('a');
    expect(document.elementFromPoint(150, 120)?.id).not.toBe('a');
    expect(document.elementFromPoint(120, 140)?.id).not.toBe('a');
    expect(document.elementFromPoint(99, 120)?.id).not.toBe('a');
    expect(document.elementFromPoint(120, 99)?.id).not.toBe('a');
  });

  test('a point on blank page hits the body, and a point outside the viewport hits nothing', () => {
    boxed('<div id="a"></div>', { '#a': { top: 0, left: 0, width: 10, height: 10 } });
    expect(document.elementFromPoint(500, 500)).toBe(document.body);
    expect(document.elementFromPoint(-1, 5)).toBeNull();
    expect(document.elementFromPoint(5, -1)).toBeNull();
    expect(document.elementFromPoint(window.innerWidth, 5)).toBeNull();
    expect(document.elementFromPoint(5, window.innerHeight)).toBeNull();
    expect(document.elementFromPoint(window.innerWidth - 1, window.innerHeight - 1)).toBe(
      document.body
    );
    expect(document.elementFromPoint(0, 0)?.id).toBe('a');
  });

  test('pointer-events:none (own or inherited), visibility:hidden and display:none are never hit', () => {
    boxed(
      '<div id="under"></div><div id="none" style="pointer-events:none"></div><div id="par" style="pointer-events:none"><i id="kid"></i></div><div id="vis" style="visibility:hidden"></div><div id="gone" style="display:none"></div>',
      {
        '#under': { top: 0, left: 0, width: 100, height: 100 },
        '#none': { top: 0, left: 0, width: 100, height: 100 },
        '#par': { top: 0, left: 0, width: 100, height: 100 },
        '#kid': { top: 0, left: 0, width: 100, height: 100 },
        '#vis': { top: 0, left: 0, width: 100, height: 100 },
        '#gone': { top: 0, left: 0, width: 100, height: 100 },
      }
    );
    expect(document.elementFromPoint(50, 50)?.id).toBe('under');
  });

  test('a child can opt back into pointer events under a pointer-events:none parent', () => {
    boxed(
      '<div id="par" style="pointer-events:none"><i id="kid" style="pointer-events:auto"></i></div>',
      {
        '#par': { top: 0, left: 0, width: 100, height: 100 },
        '#kid': { top: 0, left: 0, width: 100, height: 100 },
      }
    );
    expect(document.elementFromPoint(50, 50)?.id).toBe('kid');
  });

  test.each<[string, readonly unknown[], RegExp]>([
    ['NaN x', [Number.NaN, 15], /non-finite/],
    ['NaN y', [15, Number.NaN], /non-finite/],
    ['both NaN', [Number.NaN, Number.NaN], /non-finite/],
    ['Infinity', [Number.POSITIVE_INFINITY, 15], /non-finite/],
    ['-Infinity', [15, Number.NEGATIVE_INFINITY], /non-finite/],
    ['an undefined coordinate', [15, undefined], /non-finite/],
    ['no arguments', [], /2 arguments required, but only 0 present/],
    ['one argument', [15], /2 arguments required, but only 1 present/],
  ])(
    'a non-finite or missing coordinate (%s) is a TypeError, as in a browser, never a hit on everything',
    (_label, args, message) => {
      mount(document.createElement('button'), { top: 10, left: 10, width: 50, height: 20 });
      const probe = (call: (...values: never[]) => unknown): void => {
        expect(() => call(...(args as never[]))).toThrow(TypeError);
        expect(() => call(...(args as never[]))).toThrow(message);
      };
      probe(document.elementFromPoint as (...values: never[]) => unknown);
      probe(document.elementsFromPoint as (...values: never[]) => unknown);
    }
  );

  test('a numeric string coordinate is converted like a browser does', () => {
    const button = mount(document.createElement('button'), {
      top: 10,
      left: 10,
      width: 50,
      height: 20,
    });
    const call = document.elementFromPoint as unknown as (x: string, y: string) => Element | null;
    expect(call('20', '15')).toBe(button);
  });

  test('finite coordinates still work, including zero, negatives and fractions', () => {
    const button = mount(document.createElement('button'), {
      top: 0,
      left: 0,
      width: 50,
      height: 20,
    });
    expect(document.elementFromPoint(0, 0)).toBe(button);
    expect(document.elementFromPoint(49.9, 19.9)).toBe(button);
    expect(document.elementFromPoint(-0.1, 5)).toBeNull();
    expect(document.elementsFromPoint(0, 0)[0]).toBe(button);
  });

  test('elementsFromPoint lists hits top first and ends with body and the root element', () => {
    boxed('<div id="a"></div><div id="b"></div>', {
      '#a': { top: 0, left: 0, width: 100, height: 100 },
      '#b': { top: 0, left: 0, width: 100, height: 100 },
    });
    const ids = document.elementsFromPoint(10, 10).map(element => element.id || element.tagName);
    expect(ids).toEqual(['b', 'a', 'BODY', 'HTML']);
    expect(document.elementsFromPoint(-5, -5)).toEqual([]);
  });

  test('an unboxed element is never hit and zero-size boxes cannot be hit', () => {
    boxed('<div id="none"></div><div id="zero"></div>', {
      '#zero': { top: 0, left: 0, width: 0, height: 0 },
    });
    expect(document.elementFromPoint(0, 0)).toBe(document.body);
  });
});

describe('domHarness: page scrolling', () => {
  beforeEach(() => {
    resetDom();
    resetGuideCache();
    installLayoutStubs();
  });
  afterEach(() => {
    resetDom();
  });

  test('with no scrollable height the page cannot move and scrollingElement is the root element', () => {
    expect(document.scrollingElement).toBe(document.documentElement);
    expect(document.documentElement.scrollHeight).toBe(window.innerHeight);
    expect(document.documentElement.clientHeight).toBe(window.innerHeight);
    expect(document.documentElement.clientWidth).toBe(window.innerWidth);
    window.scrollTo(0, 100);
    expect(window.scrollY).toBe(0);
  });

  test('scrollTo clamps to [0, scrollHeight - innerHeight] and fires scroll only when the position changes', () => {
    setViewport({ height: 500, scrollHeight: 2000 });
    const fired: number[] = [];
    const onScroll = (): void => {
      fired.push(window.scrollY);
    };
    window.addEventListener('scroll', onScroll);
    try {
      window.scrollTo(0, 300);
      window.scrollTo(0, 5000);
      window.scrollTo(0, 1500);
      window.scrollTo(0, -10);
      window.scrollTo(0, 0);
    } finally {
      window.removeEventListener('scroll', onScroll);
    }
    expect(fired).toEqual([300, 1500, 0]);
  });

  test('the maximum is exactly scrollHeight - innerHeight, with no off-by-one on either side', () => {
    setViewport({ height: 500, scrollHeight: 2000 });
    window.scrollTo(0, 1499);
    expect(window.scrollY).toBe(1499);
    window.scrollTo(0, 1500);
    expect(window.scrollY).toBe(1500);
    window.scrollTo(0, 1501);
    expect(window.scrollY).toBe(1500);
    expect(document.scrollingElement?.scrollTop).toBe(1500);
  });

  test('scrollTo accepts options and ignores smooth behavior; a call without a top changes nothing', () => {
    setViewport({ height: 500, scrollHeight: 2000 });
    window.scrollTo({ top: 700, behavior: 'smooth' });
    expect(window.scrollY).toBe(700);
    window.scrollTo({ left: 5 });
    expect(window.scrollY).toBe(700);
    window.scrollTo();
    expect(window.scrollY).toBe(700);
    window.scroll(0, 900);
    expect(window.scrollY).toBe(900);
  });

  test('scrollBy is relative and clamps at both ends', () => {
    setViewport({ height: 500, scrollHeight: 2000 });
    window.scrollBy(0, 400);
    window.scrollBy({ top: 400 });
    expect(window.scrollY).toBe(800);
    window.scrollBy(0, 5000);
    expect(window.scrollY).toBe(1500);
    window.scrollBy({ top: -5000 });
    expect(window.scrollY).toBe(0);
    window.scrollBy({ left: 10 });
    expect(window.scrollY).toBe(0);
  });

  test('scrollingElement scrolls the page like window does, and body does not (standards mode)', () => {
    setViewport({ height: 500, scrollHeight: 2000 });
    const scroller = must(document.scrollingElement, 'scrollingElement');
    scroller.scrollTo({ top: 200 });
    expect(window.scrollY).toBe(200);
    scroller.scrollTo(0, 5000);
    expect(window.scrollY).toBe(1500);
    scroller.scrollBy(0, -100);
    expect(window.scrollY).toBe(1400);
    scroller.scrollBy({ top: 5000 });
    expect(window.scrollY).toBe(1500);
    document.body.scrollTo(0, 10);
    document.body.scrollBy(0, 10);
    expect(window.scrollY).toBe(1500);
  });

  test('scrollY, pageYOffset and the root scrollTop always agree, and a scrollTop write clamps', () => {
    setViewport({ height: 500, scrollHeight: 2000 });
    window.scrollTo(0, 250);
    expect(window.pageYOffset).toBe(250);
    expect(document.documentElement.scrollTop).toBe(250);
    document.documentElement.scrollTop = 99999;
    expect(window.scrollY).toBe(1500);
    document.documentElement.scrollTop = -4;
    expect(window.scrollY).toBe(0);
  });

  test('setViewport positions the page directly, unclamped, like the proven scout harness', () => {
    setViewport({ scrollY: 300 });
    expect(window.scrollY).toBe(300);
    expect(window.pageYOffset).toBe(300);
    setViewport({ width: 640, height: 480 });
    expect([window.innerWidth, window.innerHeight]).toEqual([640, 480]);
    expect(document.documentElement.clientWidth).toBe(640);
    expect(document.documentElement.clientHeight).toBe(480);
    expect(document.documentElement.scrollHeight).toBe(480);
  });

  test('the page scroll model drives the production observer controls', () => {
    const operations = (): string[] => observePage().controls.map(control => control.operation);
    expect(operations()).toEqual(['WAIT']);
    setViewport({ scrollHeight: 4000 });
    expect(operations()).toEqual(['SCROLL_DOWN', 'WAIT']);
    setViewport({ scrollY: 300 });
    expect(operations()).toEqual(['SCROLL_UP', 'SCROLL_DOWN', 'WAIT']);
    window.scrollTo(0, 5000);
    expect(operations()).toEqual(['SCROLL_UP', 'WAIT']);
  });

  test('setViewport works on its own, without installLayoutStubs', () => {
    resetDom();
    setViewport({ height: 400, scrollHeight: 1000 });
    window.scrollTo(0, 5000);
    expect(window.scrollY).toBe(600);
    expect(typeof document.elementFromPoint).toBe('undefined');
  });
});

describe('domHarness: scroll containers', () => {
  beforeEach(() => {
    resetDom();
  });
  afterEach(() => {
    resetDom();
  });

  test('scrollTop, scrollTo and scrollBy clamp to [0, scrollHeight - clientHeight] and fire scroll on change', () => {
    const box = mount(document.createElement('div'), { top: 0, height: 100 });
    expect(makeScrollable(box, { scrollHeight: 400 })).toBe(box);
    expect(box.scrollHeight).toBe(400);
    expect(box.clientHeight).toBe(100);
    const fired: number[] = [];
    box.addEventListener('scroll', () => fired.push(box.scrollTop));
    box.scrollTop = 250;
    box.scrollTop = 9999;
    box.scrollTop = 300;
    box.scrollTo({ top: 301 });
    box.scrollTo(0, -5);
    box.scrollBy(0, 40);
    box.scrollBy({ top: 5000 });
    box.scrollBy({ top: -5000 });
    expect(fired).toEqual([250, 300, 0, 40, 300, 0]);
  });

  test('a container scroll event does not bubble, as in a browser, while the page scroll event does', () => {
    setViewport({ height: 100, scrollHeight: 1000 });
    const box = makeScrollable(mount(document.createElement('div'), { top: 0, height: 50 }), {
      scrollHeight: 400,
    });
    const atDocument = jest.fn();
    const atBox = jest.fn();
    document.addEventListener('scroll', atDocument);
    box.addEventListener('scroll', atBox);
    box.scrollTop = 30;
    expect(atBox).toHaveBeenCalledTimes(1);
    expect(atDocument).not.toHaveBeenCalled();
    window.scrollTo(0, 20);
    expect(atDocument).toHaveBeenCalledTimes(1);
    expect(atBox).toHaveBeenCalledTimes(1);
    document.removeEventListener('scroll', atDocument);
  });

  test('the maximum is exactly scrollHeight - clientHeight', () => {
    const box = makeScrollable(mount(document.createElement('div'), { top: 0, height: 100 }), {
      scrollHeight: 400,
    });
    box.scrollTop = 299;
    expect(box.scrollTop).toBe(299);
    box.scrollTop = 301;
    expect(box.scrollTop).toBe(300);
  });

  test('an explicit clientHeight and initial scrollTop are honored and the initial position is clamped', () => {
    const box = makeScrollable(document.createElement('div'), {
      scrollHeight: 400,
      clientHeight: 150,
      scrollTop: 50,
    });
    expect(box.clientHeight).toBe(150);
    expect(box.scrollTop).toBe(50);
    box.scrollTop = 1000;
    expect(box.scrollTop).toBe(250);
    const clamped = makeScrollable(document.createElement('div'), {
      scrollHeight: 400,
      clientHeight: 150,
      scrollTop: 1000,
    });
    expect(clamped.scrollTop).toBe(250);
  });

  test('works whether the box or the scroller comes first', () => {
    const scrollerFirst = makeScrollable(document.createElement('div'), { scrollHeight: 400 });
    setBox(scrollerFirst, { top: 0, height: 120 });
    document.body.append(scrollerFirst);
    expect(scrollerFirst.clientHeight).toBe(120);
    scrollerFirst.scrollTop = 1000;
    expect(scrollerFirst.scrollTop).toBe(280);
  });

  test('a scroller does not need installLayoutStubs, and an ordinary element cannot be scrolled', () => {
    const box = makeScrollable(mount(document.createElement('div'), { top: 0, height: 10 }), {
      scrollHeight: 100,
    });
    box.scrollTo(0, 50);
    expect(box.scrollTop).toBe(50);
    installLayoutStubs();
    const plain = mount(document.createElement('div'), { top: 0, height: 10 });
    expect(() => plain.scrollTo(0, 50)).not.toThrow();
    expect(() => plain.scrollBy(0, 50)).not.toThrow();
    expect(plain.scrollTop).toBe(0);
  });

  test('scrolling one container leaves another and the page alone', () => {
    installLayoutStubs();
    const one = makeScrollable(mount(document.createElement('div'), { top: 0, height: 50 }), {
      scrollHeight: 200,
    });
    const two = makeScrollable(mount(document.createElement('div'), { top: 60, height: 50 }), {
      scrollHeight: 200,
    });
    one.scrollTop = 80;
    expect(two.scrollTop).toBe(0);
    expect(window.scrollY).toBe(0);
  });

  test('NaN and non-finite targets are ignored instead of corrupting the position', () => {
    const box = makeScrollable(document.createElement('div'), {
      scrollHeight: 400,
      clientHeight: 100,
      scrollTop: 40,
    });
    box.scrollTop = Number.NaN;
    expect(box.scrollTop).toBe(40);
    box.scrollTo({ top: Number.NaN });
    expect(box.scrollTop).toBe(40);
  });
});

describe('domHarness: scroll argument handling', () => {
  beforeEach(() => {
    resetDom();
    installLayoutStubs();
    setViewport({ height: 100, scrollHeight: 1000 });
  });
  afterEach(() => {
    resetDom();
  });

  test('a null options argument is an empty dictionary: scrolling nothing, not a crash', () => {
    window.scrollTo(0, 30);
    const call = window.scrollTo as unknown as (options: null) => void;
    expect(() => call(null)).not.toThrow();
    expect(() => (window.scrollBy as unknown as (options: null) => void)(null)).not.toThrow();
    expect(window.scrollY).toBe(30);
    const box = makeScrollable(mount(document.createElement('div'), { top: 0, height: 50 }), {
      scrollHeight: 400,
    });
    box.scrollTop = 20;
    expect(() => (box.scrollTo as unknown as (options: null) => void)(null)).not.toThrow();
    expect(box.scrollTop).toBe(20);
  });

  test('a numeric string written to scrollTop is converted like a browser does, on the page and on a container', () => {
    (document.documentElement as unknown as { scrollTop: string }).scrollTop = '50';
    expect(window.scrollY).toBe(50);
    const box = makeScrollable(mount(document.createElement('div'), { top: 0, height: 50 }), {
      scrollHeight: 400,
    });
    (box as unknown as { scrollTop: string }).scrollTop = '25';
    expect(box.scrollTop).toBe(25);
    (box as unknown as { scrollTop: string }).scrollTop = 'abc';
    expect(box.scrollTop).toBe(25);
    (document.documentElement as unknown as { scrollTop: undefined }).scrollTop = undefined;
    expect(window.scrollY).toBe(50);
  });
});

describe('domHarness: stubs and reset', () => {
  beforeEach(() => {
    resetDom();
  });
  afterEach(() => {
    resetDom();
  });

  test('installLayoutStubs adds what jsdom lacks, is idempotent, and resetDom removes it again', () => {
    expect(typeof document.elementFromPoint).toBe('undefined');
    expect(typeof document.elementsFromPoint).toBe('undefined');
    expect(typeof Element.prototype.scrollIntoView).toBe('undefined');
    expect('scrollingElement' in document).toBe(false);
    expect(typeof Element.prototype.checkVisibility).toBe('undefined');
    installLayoutStubs();
    installLayoutStubs();
    expect(typeof document.elementFromPoint).toBe('function');
    expect(typeof document.elementsFromPoint).toBe('function');
    expect(typeof Element.prototype.scrollIntoView).toBe('function');
    expect(typeof Element.prototype.checkVisibility).toBe('function');
    expect(document.scrollingElement).toBe(document.documentElement);
    resetDom();
    expect(typeof document.elementFromPoint).toBe('undefined');
    expect(typeof document.elementsFromPoint).toBe('undefined');
    expect(typeof Element.prototype.scrollIntoView).toBe('undefined');
    expect(typeof Element.prototype.checkVisibility).toBe('undefined');
    expect('scrollingElement' in document).toBe(false);
  });

  test('the stubs can be spied on, which is how executor tests assert scrollIntoView', () => {
    installLayoutStubs();
    const spy = jest.spyOn(Element.prototype, 'scrollIntoView');
    const div = mount(document.createElement('div'), { top: 0 });
    div.scrollIntoView({ block: 'center' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ block: 'center' });
    spy.mockRestore();
  });

  test('resetDom restores the viewport and page scroll, and a fresh install starts from the top', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    const originalScrollTo = window.scrollTo;
    installLayoutStubs();
    setViewport({ width: 500, height: 300, scrollHeight: 2000 });
    window.scrollTo(0, 400);
    expect(window.scrollY).toBe(400);
    resetDom();
    expect([window.innerWidth, window.innerHeight]).toEqual([originalWidth, originalHeight]);
    expect(window.scrollY).toBe(0);
    expect(window.scrollTo).toBe(originalScrollTo);
    installLayoutStubs();
    expect(window.scrollY).toBe(0);
    expect(document.documentElement.scrollHeight).toBe(window.innerHeight);
  });

  test('resetDom removes a box given to the body or the root element, which outlive every test', () => {
    setBox(document.body, { top: 0, width: 500, height: 500 });
    setBox(document.documentElement, { top: 0, width: 600, height: 600 });
    expect(document.body.offsetWidth).toBe(500);
    expect(document.documentElement.getBoundingClientRect().width).toBe(600);
    resetDom();
    expect(document.body.offsetWidth).toBe(0);
    expect(document.body.getBoundingClientRect().width).toBe(0);
    expect(document.documentElement.getBoundingClientRect().width).toBe(0);
    expect(Object.getOwnPropertyNames(document.body)).not.toContain('getBoundingClientRect');
  });

  test('resetDom also undoes a scroll model given to the body or the root element', () => {
    const bodyBefore = Object.getOwnPropertyNames(document.body);
    const rootBefore = Object.getOwnPropertyNames(document.documentElement);
    makeScrollable(document.body, { scrollHeight: 5000, clientHeight: 100, scrollTop: 40 });
    makeScrollable(document.documentElement, { scrollHeight: 6000, clientHeight: 100 });
    installLayoutStubs();
    expect(document.body.scrollHeight).toBe(5000);
    resetDom();
    expect(document.body.scrollHeight).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(document.documentElement.scrollHeight).toBe(0);
    expect(Object.getOwnPropertyNames(document.body)).toEqual(bodyBefore);
    expect(Object.getOwnPropertyNames(document.documentElement)).toEqual(rootBefore);
    makeScrollable(document.documentElement, { scrollHeight: 6000, clientHeight: 100 });
    resetDom();
    installLayoutStubs();
    resetDom();
    expect(Object.getOwnPropertyNames(document.documentElement)).toEqual(rootBefore);
    expect(document.documentElement.scrollHeight).toBe(0);
  });

  test('a body that was a scroller leaves no scroll state behind: a later box reports its own height', () => {
    makeScrollable(document.body, { scrollHeight: 5000, clientHeight: 123 });
    setBox(document.body, { top: 0, height: 77 });
    expect(document.body.clientHeight).toBe(123);
    resetDom();
    setBox(document.body, { top: 0, height: 77 });
    expect(document.body.clientHeight).toBe(77);
    resetDom();
    expect(document.body.clientHeight).toBe(0);
  });

  test('boxes and scroll models are per element: siblings, new elements and the prototypes are untouched', () => {
    const descriptor = (target: object, key: string): PropertyDescriptor | undefined =>
      Object.getOwnPropertyDescriptor(target, key);
    const keys = ['getBoundingClientRect', 'getClientRects', 'offsetWidth', 'clientHeight'];
    const before = [Element.prototype, HTMLElement.prototype].map(target =>
      keys.map(key => descriptor(target, key))
    );
    const boxed = mount(document.createElement('div'), { top: 5, width: 77, height: 44 });
    const sibling = document.createElement('div');
    document.body.append(sibling);
    makeScrollable(boxed, { scrollHeight: 300, clientHeight: 20 });
    expect(boxed.getBoundingClientRect().width).toBe(77);
    expect(sibling.getBoundingClientRect().width).toBe(0);
    expect(sibling.offsetWidth).toBe(0);
    expect(document.createElement('div').getBoundingClientRect().height).toBe(0);
    expect(sibling.scrollHeight).toBe(0);
    expect(Object.getOwnPropertyNames(sibling)).toEqual([]);
    const after = [Element.prototype, HTMLElement.prototype].map(target =>
      keys.map(key => descriptor(target, key))
    );
    expect(after).toStrictEqual(before);
    resetDom();
    expect(
      [Element.prototype, HTMLElement.prototype].map(target =>
        keys.map(key => descriptor(target, key))
      )
    ).toStrictEqual(before);
  });

  test('resetDom restores the original viewport after several setViewport calls', () => {
    const original = [window.innerWidth, window.innerHeight];
    setViewport({ width: 500, height: 300 });
    setViewport({ width: 400, height: 200 });
    setViewport({ width: 300 });
    expect([window.innerWidth, window.innerHeight]).toEqual([300, 200]);
    resetDom();
    expect([window.innerWidth, window.innerHeight]).toEqual(original);
  });

  test('resetDom clears body, head, root attributes, body attributes and the history path', () => {
    window.history.pushState(null, '', '/a/b?c=1#d');
    document.head.innerHTML = '<base href="https://elsewhere.test/"><title>t</title>';
    document.body.className = 'dark';
    document.documentElement.setAttribute('lang', 'fr');
    document.body.innerHTML = '<p>x</p>';
    resetDom();
    expect(document.head.innerHTML).toBe('');
    expect(document.body.innerHTML).toBe('');
    expect(document.body.getAttributeNames()).toEqual([]);
    expect(document.documentElement.getAttributeNames()).toEqual([]);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/');
  });

  test('resetDom is safe to call repeatedly', () => {
    resetDom();
    resetDom();
    installLayoutStubs();
    resetDom();
    resetDom();
    expect(document.body.innerHTML).toBe('');
  });
});
