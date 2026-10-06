/** @jest-environment node */
import * as fs from 'fs';
import * as path from 'path';
import {
  commandDigest,
  commitContext,
  compileCommand,
  computeOffers,
  contextDigest,
  describeArgument,
  redactCommand,
  toActionCommand,
  toHostCommand,
} from '@/agent/commands';
import { buildCandidates, flattenInputs, inputRules } from '@/agent/resolver';
import {
  TASK_ARGUMENT_SLOTS,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_LIMITS,
  TASK_PAGE_TARGET_ID,
  TASK_REDACTED,
  TASK_SLOT_SOURCES,
} from '@/types';
import type {
  ActionCommand,
  TaskActionContext,
  TaskArgumentRef,
  TaskArgumentSlot,
  TaskArgumentView,
  TaskCommand,
  TaskCommandDigestFn,
  TaskCommitContext,
  TaskCommitContextFn,
  TaskCompileCommandFn,
  TaskCompileErrorCode,
  TaskCompileInput,
  TaskCompileResult,
  TaskContextDigestFn,
  TaskDescribeArgumentFn,
  TaskDigestInput,
  TaskElement,
  TaskForm,
  TaskHostCapabilities,
  TaskHostCommand,
  TaskHostOperation,
  TaskInputRule,
  TaskMaterialized,
  TaskObservation,
  TaskOfferInput,
  TaskOffers,
  TaskRedactCommandFn,
  TaskToActionCommandFn,
  TaskToHostCommandFn,
  TaskComputeOffersFn,
} from '@/types';
import {
  FIXTURE_ORIGIN,
  makeCapabilities,
  makeCheckbox,
  makeCommand,
  makeElement,
  makeForm,
  makeHostCommand,
  makeObservation,
  makePageElements,
  makePassage,
  makeSelectField,
  makeSensitiveField,
  makeSubmitButton,
  makeTargetRef,
  makeTextField,
  roundTrip,
  signatureFor,
  summarizeElement,
} from './helpers/agent-fixtures';

export const seamConformance: {
  readonly describeArgument: TaskDescribeArgumentFn;
  readonly computeOffers: TaskComputeOffersFn;
  readonly compileCommand: TaskCompileCommandFn;
  readonly commandDigest: TaskCommandDigestFn;
  readonly commitContext: TaskCommitContextFn;
  readonly contextDigest: TaskContextDigestFn;
  readonly redactCommand: TaskRedactCommandFn;
  readonly toHostCommand: TaskToHostCommandFn;
  readonly toActionCommand: TaskToActionCommandFn;
} = {
  describeArgument,
  computeOffers,
  compileCommand,
  commandDigest,
  commitContext,
  contextDigest,
  redactCommand,
  toHostCommand,
  toActionCommand,
};

const ZWSP = String.fromCharCode(0x200b);
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const NBSP = String.fromCharCode(0x00a0);
const BELL = String.fromCharCode(0x07);

const GOAL = 'Fill the name with "Ada Lovelace" please';
const LITERAL_TEXT = 'Ada Lovelace';
const LITERAL_START = GOAL.indexOf(LITERAL_TEXT);
const LITERAL_END = LITERAL_START + LITERAL_TEXT.length;
const OTHER_ORIGIN = 'https://other.example.test';

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
};

const goalRef = (
  text: string = LITERAL_TEXT,
  source: 'goal_literal' | 'goal_span' = 'goal_literal'
) =>
  ({
    source,
    start: GOAL.indexOf(text),
    end: GOAL.indexOf(text) + text.length,
    text,
  }) satisfies TaskArgumentRef;

const protocol = (slot: TaskArgumentSlot, token: string): TaskArgumentRef => ({
  source: 'protocol',
  slot,
  token,
});

const inputRef = (refPath: string): TaskArgumentRef => ({ source: 'input', path: refPath });

const scroller = (overrides: Partial<TaskElement> = {}): TaskElement =>
  makeElement({
    id: 't9',
    kind: 'scroller',
    role: 'region',
    label: 'Results',
    operations: ['SCROLL'],
    scroll: { directions: ['DOWN', 'BOTTOM'], top: 0, max: 900 },
    ...overrides,
  });

const radio = (overrides: Partial<TaskElement> = {}): TaskElement =>
  makeElement({
    id: 't10',
    kind: 'radio',
    role: 'radio',
    label: 'Express',
    operations: ['SET_CHECKED'],
    state: { checked: false },
    ...overrides,
  });

const ariaOption = (overrides: Partial<TaskElement> = {}): TaskElement =>
  makeElement({
    id: 't11',
    kind: 'option',
    role: 'option',
    label: 'Blue',
    operations: ['SELECT'],
    ...overrides,
  });

const pageScroll = (directions: TaskObservation['page']['scroll']['directions']) =>
  ({
    readyState: 'complete',
    busy: false,
    scroll: { directions, top: 100, max: 1000 },
    viewport: { width: 1024, height: 768 },
  }) satisfies TaskObservation['page'];

const fullPage = (): TaskObservation =>
  makeObservation({
    elements: [
      ...makePageElements(),
      scroller(),
      radio(),
      ariaOption(),
      makeSelectField({
        id: 't12',
        label: 'Size',
        options: [
          { id: 't12.1', label: 'Small', value: 's', selected: true, disabled: false },
          { id: 't12.2', label: 'Large', value: 'l', selected: false, disabled: true },
        ],
      }),
    ],
    page: pageScroll(['UP', 'TOP', 'DOWN', 'BOTTOM']),
  });

const offerInput = (overrides: Partial<TaskOfferInput> = {}): TaskOfferInput => ({
  observation: makeObservation({ elements: makePageElements() }),
  capabilities: makeCapabilities(),
  allowedOperations: [...TASK_HOST_OPERATIONS],
  exclude: [],
  allowRunLoss: false,
  ...overrides,
});

const compile = (overrides: Partial<TaskCompileInput> = {}): TaskCompileResult => {
  const observation = overrides.observation ?? fullPage();
  const capabilities = overrides.capabilities ?? makeCapabilities();
  const offers =
    overrides.offers ??
    computeOffers({
      observation,
      capabilities,
      allowedOperations: [...TASK_HOST_OPERATIONS],
      exclude: [],
      allowRunLoss: false,
    });
  return compileCommand({
    goal: GOAL,
    operation: 'CLICK',
    inputRules: [],
    resolvers: [],
    origins: [FIXTURE_ORIGIN],
    ...overrides,
    observation,
    capabilities,
    offers,
  });
};

const succeeded = (result: TaskCompileResult): Extract<TaskCompileResult, { ok: true }> => {
  if (!result.ok) {
    throw new Error(`expected a compiled command, got ${result.error.code}`);
  }
  return result;
};

const failedWith = (result: TaskCompileResult): TaskCompileErrorCode => {
  if (result.ok) {
    throw new Error('expected a compile error');
  }
  return result.error.code;
};

const rule = (rulePath: string, sensitive: boolean, bind?: TaskInputRule['bind']): TaskInputRule =>
  bind === undefined ? { path: rulePath, sensitive } : { path: rulePath, sensitive, bind };

describe('describeArgument', () => {
  const text = makeTextField();
  const area = makeElement({ id: 't20', kind: 'textarea', operations: ['FILL'] });

  it.each([
    ['FILL', text, 'value'],
    ['FILL', area, 'value'],
    ['SELECT', makeSelectField(), 'option'],
    ['SET_CHECKED', makeCheckbox(), 'checked'],
    ['SET_CHECKED', radio(), 'checked'],
    ['PRESS', text, 'key'],
    ['SCROLL', scroller(), 'direction'],
    ['SCROLL', undefined, 'direction'],
    ['WAIT', undefined, 'duration'],
  ] as const)(
    '%s on %p needs slot %s with the sources of that slot',
    (operation, element, slot) => {
      expect(describeArgument(operation, element)).toEqual({
        slot,
        sources: [...TASK_SLOT_SOURCES[slot]],
      });
    }
  );

  it.each([
    ['READ', makePassage()],
    ['CLICK', makeElement()],
    ['NAVIGATE', makeElement({ id: 't2', kind: 'link' })],
    ['SUBMIT', makeSubmitButton()],
    ['SELECT', ariaOption()],
  ] as const)('%s on %p takes no argument', (operation, element) => {
    expect(describeArgument(operation, element)).toBeNull();
  });

  it('takes no FILL argument for an element that is not a text control, or for no element', () => {
    expect(describeArgument('FILL', makeCheckbox())).toBeNull();
    expect(describeArgument('FILL', makeElement({ kind: 'combobox' }))).toBeNull();
    expect(describeArgument('FILL', undefined)).toBeNull();
  });

  it('takes no SELECT argument for an element that is neither a native select nor an ARIA option', () => {
    expect(describeArgument('SELECT', makeElement({ kind: 'tab' }))).toBeNull();
  });

  it('returns a spec whose sources are a copy that cannot change the shared table', () => {
    const spec = describeArgument('FILL', text);
    expect(spec).not.toBeNull();
    const before = [...TASK_SLOT_SOURCES.value];
    if (spec !== null) {
      (spec.sources as string[]).push('mutated');
    }
    expect([...TASK_SLOT_SOURCES.value]).toEqual(before);
  });

  it('covers every slot with at least one operation of the host', () => {
    const covered = new Set<string>();
    for (const operation of TASK_HOST_OPERATIONS) {
      for (const element of [text, makeSelectField(), makeCheckbox(), scroller(), undefined]) {
        const spec = describeArgument(operation, element);
        if (spec !== null) {
          covered.add(spec.slot);
        }
      }
    }
    expect([...covered].sort()).toEqual([...TASK_ARGUMENT_SLOTS].sort());
  });
});

describe('computeOffers', () => {
  it('always offers DONE and BLOCKED, even when nothing else can be offered', () => {
    const offers = computeOffers(
      offerInput({ allowedOperations: [], capabilities: makeCapabilities({ operations: [] }) })
    );
    expect(offers.operations).toEqual(['DONE', 'BLOCKED']);
    expect(offers.targets).toEqual({});
  });

  it('offers every operation that has a target on a fully capable host, in canonical order', () => {
    const offers = computeOffers(offerInput({ observation: fullPage() }));
    expect(offers.operations).toEqual([
      'READ',
      'CLICK',
      'NAVIGATE',
      'FILL',
      'SELECT',
      'SET_CHECKED',
      'PRESS',
      'SCROLL',
      'WAIT',
      'SUBMIT',
      'DONE',
      'BLOCKED',
    ]);
  });

  it('lists target ids per operation in document order', () => {
    const elements = [...makePageElements()].reverse();
    const offers = computeOffers(offerInput({ observation: makeObservation({ elements }) }));
    expect(offers.targets.FILL).toEqual(['t8', 't3']);
    expect(offers.targets.CLICK).toEqual(['t1']);
    expect(offers.targets.NAVIGATE).toEqual(['t2']);
    expect(offers.targets.SUBMIT).toEqual(['t6']);
    expect(offers.targets.SELECT).toEqual(['t5']);
    expect(offers.targets.SET_CHECKED).toEqual(['t4']);
    expect(offers.targets.PRESS).toEqual(['t3']);
    expect(offers.targets.READ).toEqual(['t7']);
  });

  it('withholds submission until invalid form controls are corrected, including implicit Enter', () => {
    const field = makeTextField({ formId: 'f1', state: { required: true, invalid: true } });
    const submitter = makeSubmitButton({ formId: 'f1' });
    const observation = makeObservation({
      elements: [field, submitter],
      forms: [makeForm({ id: 'f1', fieldIds: [field.id], invalidFieldIds: [field.id] })],
    });
    const offers = computeOffers(offerInput({ observation }));
    expect(offers.targets.SUBMIT).toBeUndefined();
    expect(offers.targets.FILL).toContain(field.id);
    const unvalidated = makeObservation({
      ...observation,
      elements: [
        { ...field, formNoValidate: true },
        { ...submitter, formNoValidate: true },
      ],
    });
    expect(computeOffers(offerInput({ observation: unvalidated })).targets.SUBMIT).toContain(
      submitter.id
    );
    expect(
      compile({
        observation: unvalidated,
        operation: 'PRESS',
        targetId: field.id,
        argument: protocol('key', 'Enter'),
      })
    ).toMatchObject({ ok: true });
    expect(
      failedWith(
        compile({
          observation,
          operation: 'PRESS',
          targetId: field.id,
          argument: protocol('key', 'Enter'),
        })
      )
    ).toBe('FORM_INVALID');
    const valid = makeObservation({
      elements: [
        makeTextField({ formId: 'f1', state: { value: 'Ada', invalid: false } }),
        submitter,
      ],
      forms: [makeForm({ id: 'f1', fieldIds: [field.id], invalidFieldIds: [] })],
    });
    expect(computeOffers(offerInput({ observation: valid })).targets.SUBMIT).toContain(
      submitter.id
    );
  });

  it('intersects the host operations with the allowed operations', () => {
    const observation = makeObservation({ elements: makePageElements() });
    const hostOnly = computeOffers(
      offerInput({
        observation,
        capabilities: makeCapabilities({ operations: ['CLICK', 'FILL'] }),
      })
    );
    expect(hostOnly.operations).toEqual(['CLICK', 'FILL', 'DONE', 'BLOCKED']);
    expect(hostOnly.targets.NAVIGATE).toBeUndefined();
    const allowedOnly = computeOffers(
      offerInput({ observation, allowedOperations: ['CLICK', 'FILL', 'READ'] })
    );
    expect(allowedOnly.operations).toEqual(['READ', 'CLICK', 'FILL', 'DONE', 'BLOCKED']);
    expect(allowedOnly.targets.NAVIGATE).toBeUndefined();
    const both = computeOffers(
      offerInput({
        observation,
        capabilities: makeCapabilities({ operations: ['CLICK', 'FILL'] }),
        allowedOperations: ['FILL', 'READ'],
      })
    );
    expect(both.operations).toEqual(['FILL', 'DONE', 'BLOCKED']);
  });

  it('does not offer an operation that has no legal target and has no targets entry for it', () => {
    const observation = makeObservation({ elements: [makeElement()] });
    const offers = computeOffers(offerInput({ observation }));
    expect(offers.operations).toEqual(['CLICK', 'WAIT', 'DONE', 'BLOCKED']);
    expect(offers.targets).toEqual({ CLICK: ['t1'] });
  });

  it('offers WAIT exactly when the host reports wait durations, with no targets entry', () => {
    const observation = makeObservation({ elements: [makeElement()] });
    const without = computeOffers(
      offerInput({ observation, capabilities: makeCapabilities({ waitDurationsMs: [] }) })
    );
    expect(without.operations).not.toContain('WAIT');
    const withOne = computeOffers(
      offerInput({ observation, capabilities: makeCapabilities({ waitDurationsMs: [500] }) })
    );
    expect(withOne.operations).toContain('WAIT');
    for (const operation of ['WAIT', 'DONE', 'BLOCKED'] as const) {
      expect(withOne.targets[operation]).toBeUndefined();
    }
  });

  it('does not offer READ on a sensitive element even if the host listed it', () => {
    const leaky = makeSensitiveField({ operations: ['READ', 'FILL'] });
    const offers = computeOffers(
      offerInput({ observation: makeObservation({ elements: [leaky, makePassage()] }) })
    );
    expect(offers.targets.READ).toEqual(['t7']);
    expect(offers.targets.FILL).toEqual(['t8']);
  });

  describe('modal dialogs', () => {
    const modalObservation = (modal: boolean): TaskObservation =>
      makeObservation({
        elements: [
          makeElement({ id: 't1', label: 'Behind' }),
          makeElement({ id: 't2', label: 'Close', dialogId: 'd1' }),
          makeTextField({ id: 't3', dialogId: 'd1' }),
          makePassage({ id: 't7' }),
        ],
        dialogs: [{ id: 'd1', modal, label: 'Confirm', elementIds: ['t2', 't3'] }],
      });

    it('offers only the elements of a modal dialog', () => {
      const offers = computeOffers(offerInput({ observation: modalObservation(true) }));
      expect(offers.targets.CLICK).toEqual(['t2']);
      expect(offers.targets.FILL).toEqual(['t3']);
      expect(offers.targets.READ).toBeUndefined();
      expect(offers.operations).not.toContain('READ');
    });

    it('does not restrict anything for a dialog that is not modal', () => {
      const offers = computeOffers(offerInput({ observation: modalObservation(false) }));
      expect(offers.targets.CLICK).toEqual(['t1', 't2']);
      expect(offers.targets.READ).toEqual(['t7']);
    });

    it('drops an operation whose only targets are obscured by the modal', () => {
      const observation = makeObservation({
        elements: [makeElement({ id: 't1' }), makeElement({ id: 't2', dialogId: 'd1' })],
        dialogs: [{ id: 'd1', modal: true, label: 'Confirm', elementIds: ['t2'] }],
      });
      const offers = computeOffers(offerInput({ observation }));
      expect(offers.targets.CLICK).toEqual(['t2']);
      const noneInside = makeObservation({
        elements: [makeTextField({ id: 't3' }), makeElement({ id: 't2', dialogId: 'd1' })],
        dialogs: [{ id: 'd1', modal: true, label: 'Confirm', elementIds: ['t2'] }],
      });
      expect(computeOffers(offerInput({ observation: noneInside })).operations).not.toContain(
        'FILL'
      );
    });

    it('treats an element of a non-modal dialog as obscured while a modal dialog is open', () => {
      const observation = makeObservation({
        elements: [
          makeElement({ id: 't1', dialogId: 'd2' }),
          makeElement({ id: 't2', dialogId: 'd1' }),
        ],
        dialogs: [
          { id: 'd1', modal: true, label: 'Confirm', elementIds: ['t2'] },
          { id: 'd2', modal: false, label: 'Tip', elementIds: ['t1'] },
        ],
      });
      expect(computeOffers(offerInput({ observation })).targets.CLICK).toEqual(['t2']);
    });
  });

  describe('exclusions', () => {
    const observation = makeObservation({
      elements: [
        makeElement({ id: 't1' }),
        makeElement({ id: 't2', label: 'Other' }),
        makeLinkElement(),
      ],
    });

    function makeLinkElement(): TaskElement {
      return makeElement({
        id: 't3',
        kind: 'link',
        role: 'link',
        operations: ['NAVIGATE', 'CLICK'],
        href: `${FIXTURE_ORIGIN}/x`,
      });
    }

    it('removes an element by target id', () => {
      const offers = computeOffers(
        offerInput({ observation, exclude: [{ operation: 'CLICK', targetId: 't1' }] })
      );
      expect(offers.targets.CLICK).toEqual(['t2', 't3']);
    });

    it('removes an element by signature although its target id changed', () => {
      const offers = computeOffers(
        offerInput({
          observation,
          exclude: [{ operation: 'CLICK', signature: signatureFor('t2') }],
        })
      );
      expect(offers.targets.CLICK).toEqual(['t1', 't3']);
    });

    it('removes an element when only one of the two fields of the entry matches', () => {
      const offers = computeOffers(
        offerInput({
          observation,
          exclude: [{ operation: 'CLICK', targetId: 't1', signature: signatureFor('t2') }],
        })
      );
      expect(offers.targets.CLICK).toEqual(['t3']);
    });

    it('keeps an element whose id and signature both differ from the entry', () => {
      const offers = computeOffers(
        offerInput({
          observation,
          exclude: [{ operation: 'CLICK', targetId: 't99', signature: 'sg_unknown' }],
        })
      );
      expect(offers.targets.CLICK).toEqual(['t1', 't2', 't3']);
    });

    it('removes the whole operation for an entry with neither field', () => {
      const offers = computeOffers(offerInput({ observation, exclude: [{ operation: 'CLICK' }] }));
      expect(offers.operations).not.toContain('CLICK');
      expect(offers.targets.CLICK).toBeUndefined();
      expect(offers.targets.NAVIGATE).toEqual(['t3']);
    });

    it('affects only the operation named in the entry', () => {
      const offers = computeOffers(
        offerInput({ observation, exclude: [{ operation: 'CLICK', targetId: 't3' }] })
      );
      expect(offers.targets.NAVIGATE).toEqual(['t3']);
      expect(offers.targets.CLICK).toEqual(['t1', 't2']);
    });

    it('drops an operation once every target is excluded', () => {
      const offers = computeOffers(
        offerInput({
          observation,
          exclude: [
            { operation: 'NAVIGATE', targetId: 't3' },
            { operation: 'SUBMIT', targetId: 't3' },
          ],
        })
      );
      expect(offers.operations).not.toContain('NAVIGATE');
      expect(offers.targets.NAVIGATE).toBeUndefined();
    });
  });

  describe('SCROLL targets', () => {
    it('offers the page target only when the page can move', () => {
      const still = computeOffers(
        offerInput({ observation: makeObservation({ elements: [makeElement()] }) })
      );
      expect(still.operations).not.toContain('SCROLL');
      const moving = computeOffers(
        offerInput({
          observation: makeObservation({
            elements: [makeElement()],
            page: pageScroll(['DOWN', 'BOTTOM']),
          }),
        })
      );
      expect(moving.targets.SCROLL).toEqual([TASK_PAGE_TARGET_ID]);
    });

    it('adds containers that can move, after the page target, in document order', () => {
      const observation = makeObservation({
        elements: [
          scroller({ id: 't9' }),
          scroller({ id: 't13', scroll: { directions: [], top: 0, max: 0 } }),
          scroller({ id: 't14', scroll: { directions: ['UP', 'TOP'], top: 50, max: 50 } }),
        ],
        page: pageScroll(['DOWN']),
      });
      const offers = computeOffers(offerInput({ observation }));
      expect(offers.targets.SCROLL).toEqual([TASK_PAGE_TARGET_ID, 't9', 't14']);
    });

    it('offers a container although the page cannot move', () => {
      const observation = makeObservation({ elements: [scroller()], page: pageScroll([]) });
      expect(computeOffers(offerInput({ observation })).targets.SCROLL).toEqual(['t9']);
    });

    it('ignores a container that offers SCROLL without scroll state', () => {
      const observation = makeObservation({
        elements: [scroller({ scroll: undefined })],
        page: pageScroll([]),
      });
      expect(computeOffers(offerInput({ observation })).operations).not.toContain('SCROLL');
    });

    it('offers the page target only when the host has no scroll containers', () => {
      const observation = makeObservation({
        elements: [scroller()],
        page: pageScroll(['DOWN']),
      });
      const offers = computeOffers(
        offerInput({ observation, capabilities: makeCapabilities({ scrollContainers: false }) })
      );
      expect(offers.targets.SCROLL).toEqual([TASK_PAGE_TARGET_ID]);
    });

    it('drops SCROLL when containers are unsupported and the page cannot move', () => {
      const observation = makeObservation({ elements: [scroller()], page: pageScroll([]) });
      const offers = computeOffers(
        offerInput({ observation, capabilities: makeCapabilities({ scrollContainers: false }) })
      );
      expect(offers.operations).not.toContain('SCROLL');
    });

    it('excludes the page target by the page target id and keeps containers', () => {
      const observation = makeObservation({
        elements: [scroller()],
        page: pageScroll(['DOWN']),
      });
      const offers = computeOffers(
        offerInput({
          observation,
          exclude: [{ operation: 'SCROLL', targetId: TASK_PAGE_TARGET_ID }],
        })
      );
      expect(offers.targets.SCROLL).toEqual(['t9']);
    });

    it('excludes a container by signature', () => {
      const observation = makeObservation({
        elements: [scroller()],
        page: pageScroll(['DOWN']),
      });
      const offers = computeOffers(
        offerInput({
          observation,
          exclude: [{ operation: 'SCROLL', signature: signatureFor('t9') }],
        })
      );
      expect(offers.targets.SCROLL).toEqual([TASK_PAGE_TARGET_ID]);
    });

    it('keeps the page target while a modal dialog restricts the elements', () => {
      const observation = makeObservation({
        elements: [makeElement({ id: 't1' }), makeElement({ id: 't2', dialogId: 'd1' })],
        dialogs: [{ id: 'd1', modal: true, label: 'Confirm', elementIds: ['t2'] }],
        page: pageScroll(['DOWN']),
      });
      const offers = computeOffers(offerInput({ observation }));
      expect(offers.targets.SCROLL).toEqual([TASK_PAGE_TARGET_ID]);
    });
  });

  describe('capability consequences (4.4)', () => {
    const observation = makeObservation({ elements: makePageElements() });

    it.each([
      ['persistsAcrossNavigation', { persistsAcrossNavigation: false }],
      ['detectsNavigation', { detectsNavigation: false }],
    ])('withholds NAVIGATE and SUBMIT when %s is false', (_name, overrides) => {
      const capabilities = makeCapabilities(overrides);
      const offers = computeOffers(offerInput({ observation, capabilities }));
      expect(offers.operations).not.toContain('NAVIGATE');
      expect(offers.operations).not.toContain('SUBMIT');
      expect(offers.targets.NAVIGATE).toBeUndefined();
      expect(offers.targets.SUBMIT).toBeUndefined();
      expect(offers.operations).toContain('CLICK');
      expect(offers.operations).toContain('FILL');
    });

    it.each([
      ['persistsAcrossNavigation', { persistsAcrossNavigation: false }],
      ['detectsNavigation', { detectsNavigation: false }],
    ])('keeps NAVIGATE and SUBMIT with allowRunLoss when %s is false', (_name, overrides) => {
      const capabilities = makeCapabilities(overrides);
      const offers = computeOffers(offerInput({ observation, capabilities, allowRunLoss: true }));
      expect(offers.targets.NAVIGATE).toEqual(['t2']);
      expect(offers.targets.SUBMIT).toEqual(['t6']);
    });

    it('offers NAVIGATE and SUBMIT on a host that persists and detects navigation', () => {
      const offers = computeOffers(offerInput({ observation }));
      expect(offers.targets.NAVIGATE).toEqual(['t2']);
      expect(offers.targets.SUBMIT).toEqual(['t6']);
    });

    it('keeps PRESS when Enter is withheld but other keys remain', () => {
      const offers = computeOffers(
        offerInput({
          observation,
          capabilities: makeCapabilities({
            implicitSubmitDetection: false,
            keys: ['Enter', 'Tab'],
          }),
        })
      );
      expect(offers.targets.PRESS).toEqual(['t3']);
    });

    it('does not offer PRESS when Enter is the only key and implicit submit is not detected', () => {
      const blind = computeOffers(
        offerInput({
          observation,
          capabilities: makeCapabilities({ implicitSubmitDetection: false, keys: ['Enter'] }),
        })
      );
      expect(blind.operations).not.toContain('PRESS');
      const sighted = computeOffers(
        offerInput({
          observation,
          capabilities: makeCapabilities({ implicitSubmitDetection: true, keys: ['Enter'] }),
        })
      );
      expect(sighted.operations).toContain('PRESS');
    });

    it('does not offer PRESS when the host reports no keys', () => {
      const offers = computeOffers(
        offerInput({ observation, capabilities: makeCapabilities({ keys: [] }) })
      );
      expect(offers.operations).not.toContain('PRESS');
    });
  });

  it('does not mutate its input and returns plain JSON', () => {
    const input = deepFreeze(offerInput({ observation: fullPage() }));
    const offers = computeOffers(input);
    expect(roundTrip(offers)).toEqual(offers);
    expect(computeOffers(input)).toEqual(offers);
  });
});

describe('compileCommand: order of checks and every error code', () => {
  it('returns OPERATION_NOT_OFFERED first, before any target or argument check', () => {
    const observation = fullPage();
    const capabilities = makeCapabilities();
    const offers = computeOffers(
      offerInput({ observation, capabilities, allowedOperations: ['CLICK'] })
    );
    expect(
      failedWith(
        compile({ observation, capabilities, offers, operation: 'FILL', argument: goalRef() })
      )
    ).toBe('OPERATION_NOT_OFFERED');
    expect(failedWith(compile({ operation: 'DONE' as TaskHostOperation }))).toBe(
      'OPERATION_NOT_OFFERED'
    );
    expect(failedWith(compile({ operation: 'BLOCKED' as TaskHostOperation }))).toBe(
      'OPERATION_NOT_OFFERED'
    );
  });

  it.each([
    'READ',
    'CLICK',
    'NAVIGATE',
    'FILL',
    'SELECT',
    'SET_CHECKED',
    'PRESS',
    'SUBMIT',
  ] as const)('requires a target for %s', operation => {
    expect(failedWith(compile({ operation }))).toBe('TARGET_REQUIRED');
    expect(failedWith(compile({ operation, targetId: '' }))).toBe('TARGET_REQUIRED');
  });

  it('returns TARGET_NOT_OFFERED for an element that is not in the offered list', () => {
    expect(failedWith(compile({ operation: 'CLICK', targetId: 't2' }))).toBe('TARGET_NOT_OFFERED');
    expect(failedWith(compile({ operation: 'CLICK', targetId: 't404' }))).toBe(
      'TARGET_NOT_OFFERED'
    );
    const observation = fullPage();
    const offers = computeOffers(
      offerInput({ observation, exclude: [{ operation: 'FILL', targetId: 't3' }] })
    );
    expect(offers.targets.FILL).toEqual(['t8']);
    expect(
      failedWith(
        compile({ observation, offers, operation: 'FILL', targetId: 't3', argument: goalRef() })
      )
    ).toBe('TARGET_NOT_OFFERED');
    const wholeOperation = computeOffers(
      offerInput({ observation, exclude: [{ operation: 'CLICK', targetId: 't1' }] })
    );
    expect(
      failedWith(
        compile({ observation, offers: wholeOperation, operation: 'CLICK', targetId: 't1' })
      )
    ).toBe('OPERATION_NOT_OFFERED');
  });

  it('returns TARGET_UNKNOWN for an offered id that the observation does not contain', () => {
    const offers: TaskOffers = {
      operations: ['CLICK', 'DONE', 'BLOCKED'],
      targets: { CLICK: ['t1', 't77'] },
    };
    expect(failedWith(compile({ offers, operation: 'CLICK', targetId: 't77' }))).toBe(
      'TARGET_UNKNOWN'
    );
    expect(
      succeeded(compile({ offers, operation: 'CLICK', targetId: 't1' })).command.operation
    ).toBe('CLICK');
  });

  it('checks the target before the argument', () => {
    expect(failedWith(compile({ operation: 'FILL', targetId: 't404', argument: goalRef() }))).toBe(
      'TARGET_NOT_OFFERED'
    );
    expect(failedWith(compile({ operation: 'FILL', targetId: 't1' }))).toBe('TARGET_NOT_OFFERED');
  });

  it('rejects a target for WAIT', () => {
    expect(
      failedWith(
        compile({ operation: 'WAIT', targetId: 't1', argument: protocol('duration', '500') })
      )
    ).toBe('TARGET_NOT_OFFERED');
  });

  it('returns ARGUMENT_UNEXPECTED when an operation without a slot receives an argument', () => {
    for (const [operation, targetId] of [
      ['CLICK', 't1'],
      ['NAVIGATE', 't2'],
      ['SUBMIT', 't6'],
      ['READ', 't7'],
      ['SELECT', 't11'],
    ] as const) {
      expect(failedWith(compile({ operation, targetId, argument: goalRef() }))).toBe(
        'ARGUMENT_UNEXPECTED'
      );
    }
  });

  it('returns ARGUMENT_REQUIRED when a slot has no argument', () => {
    for (const [operation, targetId] of [
      ['FILL', 't3'],
      ['SELECT', 't5'],
      ['SET_CHECKED', 't4'],
      ['PRESS', 't3'],
    ] as const) {
      expect(failedWith(compile({ operation, targetId }))).toBe('ARGUMENT_REQUIRED');
    }
    expect(failedWith(compile({ operation: 'SCROLL' }))).toBe('ARGUMENT_REQUIRED');
    expect(failedWith(compile({ operation: 'WAIT' }))).toBe('ARGUMENT_REQUIRED');
  });

  it('returns ARGUMENT_NOT_ALLOWED for a source the slot does not accept, before validating the source', () => {
    const optionRef: TaskArgumentRef = {
      source: 'observed_option',
      targetId: 't5',
      optionId: 't5.9',
    };
    expect(failedWith(compile({ operation: 'FILL', targetId: 't3', argument: optionRef }))).toBe(
      'ARGUMENT_NOT_ALLOWED'
    );
    expect(failedWith(compile({ operation: 'SELECT', targetId: 't5', argument: goalRef() }))).toBe(
      'ARGUMENT_NOT_ALLOWED'
    );
    expect(
      failedWith(
        compile({ operation: 'SELECT', targetId: 't5', argument: protocol('option', 'x') })
      )
    ).toBe('ARGUMENT_NOT_ALLOWED');
    expect(
      failedWith(compile({ operation: 'PRESS', targetId: 't3', argument: inputRef('name') }))
    ).toBe('ARGUMENT_NOT_ALLOWED');
    expect(
      failedWith(compile({ operation: 'WAIT', argument: goalRef('Ada Lovelace', 'goal_span') }))
    ).toBe('ARGUMENT_NOT_ALLOWED');
    expect(
      failedWith(
        compile({
          operation: 'SET_CHECKED',
          targetId: 't4',
          argument: { source: 'resolver', resolverId: 'r', key: 'value:x' },
        })
      )
    ).toBe('ARGUMENT_NOT_ALLOWED');
  });

  describe('goal references', () => {
    it.each(['goal_literal', 'goal_span'] as const)('accepts a verifying %s', source => {
      const result = succeeded(
        compile({ operation: 'FILL', targetId: 't3', argument: goalRef(LITERAL_TEXT, source) })
      );
      expect(result.command).toEqual({
        operation: 'FILL',
        target: expect.objectContaining({ targetId: 't3' }),
        value: goalRef(LITERAL_TEXT, source),
      });
    });

    it.each([
      [
        'text that differs from the slice',
        { start: LITERAL_START, end: LITERAL_END, text: 'Ada Lovelacx' },
      ],
      ['empty text and an empty range', { start: LITERAL_START, end: LITERAL_START, text: '' }],
      [
        'an empty range with matching empty text at the end',
        { start: GOAL.length, end: GOAL.length, text: '' },
      ],
      ['a negative start', { start: -1, end: LITERAL_END, text: LITERAL_TEXT }],
      [
        'a negative start whose wrapped slice equals the text',
        { start: -6, end: GOAL.length, text: 'please' },
      ],
      [
        'an end beyond the goal whose clamped slice equals the text',
        { start: 0, end: GOAL.length + 5, text: GOAL },
      ],
      [
        'an end beyond the goal',
        { start: LITERAL_START, end: GOAL.length + 1, text: LITERAL_TEXT },
      ],
      ['an end before the start', { start: LITERAL_END, end: LITERAL_START, text: LITERAL_TEXT }],
      ['a fractional offset', { start: LITERAL_START + 0.5, end: LITERAL_END, text: LITERAL_TEXT }],
      [
        'an offset shifted by one',
        { start: LITERAL_START + 1, end: LITERAL_END + 1, text: LITERAL_TEXT },
      ],
    ])('rejects %s with ARGUMENT_INVALID', (_name, range) => {
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: { source: 'goal_literal', ...range },
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('verifies against the goal of the call and not a different goal', () => {
      expect(
        failedWith(
          compile({
            goal: 'Fill the name with "Grace Hopper" please',
            operation: 'FILL',
            targetId: 't3',
            argument: goalRef(),
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });
  });

  describe('input, resolver and option references', () => {
    it('accepts an input path that is in the rules and rejects one that is not', () => {
      const rules = [rule('profile.name', false)];
      expect(
        succeeded(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('profile.name'),
            inputRules: rules,
          })
        ).command.operation
      ).toBe('FILL');
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('profile.other'),
            inputRules: rules,
          })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('profile'),
            inputRules: rules,
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('accepts a declared resolver id and rejects an unknown one', () => {
      const resolvers = [{ id: 'lookup', sensitive: false }];
      const known: TaskArgumentRef = {
        source: 'resolver',
        resolverId: 'lookup',
        key: 'value:sg_x',
      };
      expect(
        succeeded(compile({ operation: 'FILL', targetId: 't3', argument: known, resolvers }))
          .command.operation
      ).toBe('FILL');
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: { source: 'resolver', resolverId: 'ghost', key: 'value:sg_x' },
            resolvers,
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('rejects an observed option of another element with ARGUMENT_INVALID', () => {
      expect(
        failedWith(
          compile({
            operation: 'SELECT',
            targetId: 't5',
            argument: { source: 'observed_option', targetId: 't12', optionId: 't12.1' },
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('returns OPTION_UNKNOWN for an option id the element does not have', () => {
      expect(
        failedWith(
          compile({
            operation: 'SELECT',
            targetId: 't5',
            argument: { source: 'observed_option', targetId: 't5', optionId: 't5.9' },
          })
        )
      ).toBe('OPTION_UNKNOWN');
      expect(
        failedWith(
          compile({
            operation: 'SELECT',
            targetId: 't5',
            argument: { source: 'observed_option', targetId: 't5', optionId: 't12.1' },
          })
        )
      ).toBe('OPTION_UNKNOWN');
    });

    it('returns OPTION_DISABLED for a disabled option and accepts the enabled one', () => {
      expect(
        failedWith(
          compile({
            operation: 'SELECT',
            targetId: 't12',
            argument: { source: 'observed_option', targetId: 't12', optionId: 't12.2' },
          })
        )
      ).toBe('OPTION_DISABLED');
      const result = succeeded(
        compile({
          operation: 'SELECT',
          targetId: 't12',
          argument: { source: 'observed_option', targetId: 't12', optionId: 't12.1' },
        })
      );
      expect(result.optionLabel).toBe('Small');
    });
  });

  describe('protocol tokens', () => {
    it('rejects a protocol reference whose slot is not the slot of the operation', () => {
      expect(
        failedWith(
          compile({ operation: 'PRESS', targetId: 't3', argument: protocol('direction', 'Tab') })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(failedWith(compile({ operation: 'WAIT', argument: protocol('key', '500') }))).toBe(
        'ARGUMENT_INVALID'
      );
    });

    it('accepts a key the host reports and rejects another one', () => {
      const capabilities = makeCapabilities({ keys: ['Tab', 'Escape'] });
      expect(
        succeeded(
          compile({
            capabilities,
            operation: 'PRESS',
            targetId: 't3',
            argument: protocol('key', 'Escape'),
          })
        ).command
      ).toEqual({ operation: 'PRESS', target: expect.anything(), key: 'Escape' });
      expect(
        failedWith(
          compile({
            capabilities,
            operation: 'PRESS',
            targetId: 't3',
            argument: protocol('key', 'Home'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({ operation: 'PRESS', targetId: 't3', argument: protocol('key', 'F13') })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({ operation: 'PRESS', targetId: 't3', argument: protocol('key', 'enter') })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('allows Enter only while implicit submit detection works', () => {
      expect(
        succeeded(
          compile({ operation: 'PRESS', targetId: 't3', argument: protocol('key', 'Enter') })
        ).command
      ).toEqual({ operation: 'PRESS', target: expect.anything(), key: 'Enter' });
      const blind = makeCapabilities({ implicitSubmitDetection: false });
      expect(
        failedWith(
          compile({
            capabilities: blind,
            operation: 'PRESS',
            targetId: 't3',
            argument: protocol('key', 'Enter'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        succeeded(
          compile({
            capabilities: blind,
            operation: 'PRESS',
            targetId: 't3',
            argument: protocol('key', 'Tab'),
          })
        ).command.operation
      ).toBe('PRESS');
    });

    it.each(TASK_KEYS)('accepts every key of a fully capable host: %s', key => {
      expect(
        succeeded(compile({ operation: 'PRESS', targetId: 't3', argument: protocol('key', key) }))
          .command
      ).toEqual({ operation: 'PRESS', target: expect.anything(), key });
    });

    it('accepts a direction that the page can move and rejects the others', () => {
      const moving = makeObservation({
        elements: [makeElement()],
        page: pageScroll(['DOWN']),
      });
      expect(
        succeeded(
          compile({
            observation: moving,
            operation: 'SCROLL',
            argument: protocol('direction', 'DOWN'),
          })
        ).command
      ).toEqual({ operation: 'SCROLL', direction: 'DOWN' });
      for (const token of ['UP', 'TOP', 'BOTTOM', 'down', 'LEFT']) {
        expect(
          failedWith(
            compile({
              observation: moving,
              operation: 'SCROLL',
              argument: protocol('direction', token),
            })
          )
        ).toBe('ARGUMENT_INVALID');
      }
    });

    it('allows TOP only when UP is possible and BOTTOM only when DOWN is possible', () => {
      const topOnly = makeObservation({ elements: [makeElement()], page: pageScroll(['TOP']) });
      expect(
        failedWith(
          compile({
            observation: topOnly,
            operation: 'SCROLL',
            argument: protocol('direction', 'TOP'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
      const bottomOnly = makeObservation({
        elements: [makeElement()],
        page: pageScroll(['BOTTOM']),
      });
      expect(
        failedWith(
          compile({
            observation: bottomOnly,
            operation: 'SCROLL',
            argument: protocol('direction', 'BOTTOM'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
      const both = makeObservation({ elements: [makeElement()], page: pageScroll(['UP', 'TOP']) });
      expect(
        succeeded(
          compile({
            observation: both,
            operation: 'SCROLL',
            argument: protocol('direction', 'TOP'),
          })
        ).command
      ).toEqual({ operation: 'SCROLL', direction: 'TOP' });
      const down = makeObservation({
        elements: [makeElement()],
        page: pageScroll(['DOWN', 'BOTTOM']),
      });
      expect(
        succeeded(
          compile({
            observation: down,
            operation: 'SCROLL',
            argument: protocol('direction', 'BOTTOM'),
          })
        ).command
      ).toEqual({ operation: 'SCROLL', direction: 'BOTTOM' });
    });

    it('takes the directions of the container for a container target, not the page', () => {
      const observation = fullPage();
      const good = succeeded(
        compile({
          observation,
          operation: 'SCROLL',
          targetId: 't9',
          argument: protocol('direction', 'DOWN'),
        })
      );
      expect(good.command).toEqual({
        operation: 'SCROLL',
        target: {
          sessionId: observation.sessionId,
          snapshotId: observation.snapshotId,
          targetId: 't9',
          signature: signatureFor('t9'),
        },
        direction: 'DOWN',
      });
      expect(good.target?.id).toBe('t9');
      expect(
        failedWith(
          compile({
            observation,
            operation: 'SCROLL',
            targetId: 't9',
            argument: protocol('direction', 'UP'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('accepts a numeric wait duration the host reports and nothing else', () => {
      const capabilities = makeCapabilities({ waitDurationsMs: [500, 1000] });
      expect(
        succeeded(
          compile({ capabilities, operation: 'WAIT', argument: protocol('duration', '500') })
        ).command
      ).toEqual({ operation: 'WAIT', durationMs: 500 });
      for (const token of ['250', '0500', '5e2', 'abc', '', '-500', '500.0', ' 500', '500 ']) {
        expect(
          failedWith(
            compile({ capabilities, operation: 'WAIT', argument: protocol('duration', token) })
          )
        ).toBe('ARGUMENT_INVALID');
      }
    });

    it('accepts CHECKED and UNCHECKED for a checkbox and only CHECKED for a radio', () => {
      expect(
        succeeded(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't4',
            argument: protocol('checked', 'CHECKED'),
          })
        ).command
      ).toEqual({ operation: 'SET_CHECKED', target: expect.anything(), checked: true });
      expect(
        succeeded(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't4',
            argument: protocol('checked', 'UNCHECKED'),
          })
        ).command
      ).toEqual({ operation: 'SET_CHECKED', target: expect.anything(), checked: false });
      expect(
        succeeded(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't10',
            argument: protocol('checked', 'CHECKED'),
          })
        ).command
      ).toEqual({ operation: 'SET_CHECKED', target: expect.anything(), checked: true });
      expect(
        failedWith(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't10',
            argument: protocol('checked', 'UNCHECKED'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't4',
            argument: protocol('checked', 'checked'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't4',
            argument: protocol('checked', 'EMPTY'),
          })
        )
      ).toBe('ARGUMENT_INVALID');
    });

    it('allows EMPTY for the value slot only', () => {
      expect(
        succeeded(
          compile({ operation: 'FILL', targetId: 't3', argument: protocol('value', 'EMPTY') })
        ).command
      ).toEqual({
        operation: 'FILL',
        target: expect.anything(),
        value: protocol('value', 'EMPTY'),
      });
      expect(
        failedWith(
          compile({ operation: 'FILL', targetId: 't3', argument: protocol('value', 'CLEAR') })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({ operation: 'FILL', targetId: 't3', argument: protocol('value', 'Tab') })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(
          compile({ operation: 'PRESS', targetId: 't3', argument: protocol('key', 'EMPTY') })
        )
      ).toBe('ARGUMENT_INVALID');
    });
  });

  describe('FILL and SELECT on elements without an argument slot', () => {
    it('refuses to build a FILL for an element that is not a text control', () => {
      const observation = makeObservation({
        elements: [makeElement({ id: 't30', kind: 'combobox', operations: ['FILL'] })],
      });
      expect(failedWith(compile({ observation, operation: 'FILL', targetId: 't30' }))).toBe(
        'ARGUMENT_INVALID'
      );
      expect(
        failedWith(
          compile({ observation, operation: 'FILL', targetId: 't30', argument: goalRef() })
        )
      ).toBe('ARGUMENT_UNEXPECTED');
    });

    it('refuses to build a SELECT for an element that is neither a native select nor an ARIA option', () => {
      const observation = makeObservation({
        elements: [makeElement({ id: 't31', kind: 'tab', operations: ['SELECT'] })],
      });
      expect(failedWith(compile({ observation, operation: 'SELECT', targetId: 't31' }))).toBe(
        'ARGUMENT_INVALID'
      );
    });
  });

  describe('binding and sensitivity (value slot)', () => {
    const sensitiveRule = (bind?: TaskInputRule['bind']) => [rule('secret.password', true, bind)];
    const plainRule = [rule('profile.name', false)];
    const fillSensitive = (overrides: Partial<TaskCompileInput>): TaskCompileResult =>
      compile({ operation: 'FILL', targetId: 't8', ...overrides });

    it('rejects a goal literal and a goal span into a structurally sensitive field', () => {
      expect(failedWith(fillSensitive({ argument: goalRef() }))).toBe('ARGUMENT_NOT_ALLOWED');
      expect(failedWith(fillSensitive({ argument: goalRef(LITERAL_TEXT, 'goal_span') }))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
    });

    it('rejects a non-sensitive input and a non-sensitive resolver into a sensitive field', () => {
      expect(
        failedWith(fillSensitive({ argument: inputRef('profile.name'), inputRules: plainRule }))
      ).toBe('ARGUMENT_NOT_ALLOWED');
      expect(
        failedWith(
          fillSensitive({
            argument: { source: 'resolver', resolverId: 'plain', key: 'value:x' },
            resolvers: [{ id: 'plain', sensitive: false }],
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
    });

    it('accepts goal text, a plain input and a plain resolver into a non-sensitive field', () => {
      expect(
        succeeded(compile({ operation: 'FILL', targetId: 't3', argument: goalRef() })).command
          .operation
      ).toBe('FILL');
      expect(
        succeeded(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('profile.name'),
            inputRules: plainRule,
          })
        ).command.operation
      ).toBe('FILL');
      expect(
        succeeded(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: { source: 'resolver', resolverId: 'plain', key: 'value:x' },
            resolvers: [{ id: 'plain', sensitive: false }],
          })
        ).command.operation
      ).toBe('FILL');
    });

    it('checks the validity of the source before the binding', () => {
      expect(
        failedWith(
          fillSensitive({
            argument: { source: 'goal_literal', start: 0, end: 3, text: 'xyz' },
          })
        )
      ).toBe('ARGUMENT_INVALID');
      expect(
        failedWith(fillSensitive({ argument: inputRef('missing.path'), inputRules: plainRule }))
      ).toBe('ARGUMENT_INVALID');
    });

    it('accepts a sensitive input on a sensitive element of an authorized origin by default', () => {
      expect(
        succeeded(
          fillSensitive({ argument: inputRef('secret.password'), inputRules: sensitiveRule() })
        ).command.operation
      ).toBe('FILL');
    });

    it('rejects a sensitive input on a non-sensitive element by default', () => {
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(),
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
    });

    it('rejects a sensitive input when the page origin is not an authorized origin', () => {
      expect(
        failedWith(
          fillSensitive({
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(),
            origins: [OTHER_ORIGIN],
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
      expect(
        failedWith(
          fillSensitive({
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(),
            origins: [],
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
    });

    it('lets a binding with requireSensitiveElement false and origins reach a plain field', () => {
      const bind = { requireSensitiveElement: false, origins: [FIXTURE_ORIGIN] };
      expect(
        succeeded(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(bind),
          })
        ).command.operation
      ).toBe('FILL');
    });

    it('rejects such a binding on a page origin outside its origins', () => {
      const bind = { requireSensitiveElement: false, origins: [OTHER_ORIGIN] };
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(bind),
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
    });

    it('uses the run origins when a widened binding names none', () => {
      const bind = { requireSensitiveElement: false };
      expect(
        succeeded(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(bind),
          })
        ).command.operation
      ).toBe('FILL');
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(bind),
            origins: [OTHER_ORIGIN],
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
    });

    it('still requires a sensitive element when the binding restricts origins but not that flag', () => {
      const bind = { origins: [FIXTURE_ORIGIN] };
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule(bind),
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
      expect(
        succeeded(
          fillSensitive({ argument: inputRef('secret.password'), inputRules: sensitiveRule(bind) })
        ).command.operation
      ).toBe('FILL');
    });

    it('honors elementKinds and inputTypes of a binding when given', () => {
      const widened = { requireSensitiveElement: false, origins: [FIXTURE_ORIGIN] };
      const run = (bind: TaskInputRule['bind'], targetId = 't3') =>
        compile({
          operation: 'FILL',
          targetId,
          argument: inputRef('secret.password'),
          inputRules: sensitiveRule(bind),
        });
      expect(
        succeeded(run({ ...widened, elementKinds: ['text_input', 'textarea'] })).command.operation
      ).toBe('FILL');
      expect(failedWith(run({ ...widened, elementKinds: ['textarea'] }))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
      expect(succeeded(run({ ...widened, inputTypes: ['text', 'tel'] })).command.operation).toBe(
        'FILL'
      );
      expect(failedWith(run({ ...widened, inputTypes: ['tel'] }))).toBe('ARGUMENT_NOT_ALLOWED');
      expect(failedWith(run({ ...widened, inputTypes: ['password'] }))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
      const noType = makeObservation({
        elements: [makeTextField({ id: 't32', inputType: undefined })],
      });
      expect(
        failedWith(
          compile({
            observation: noType,
            operation: 'FILL',
            targetId: 't32',
            argument: inputRef('secret.password'),
            inputRules: sensitiveRule({ ...widened, inputTypes: ['text'] }),
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
    });

    it('applies the explicit binding of a non-sensitive input as well', () => {
      const bound = [rule('profile.name', false, { elementKinds: ['textarea'] })];
      expect(
        failedWith(
          compile({
            operation: 'FILL',
            targetId: 't3',
            argument: inputRef('profile.name'),
            inputRules: bound,
          })
        )
      ).toBe('ARGUMENT_NOT_ALLOWED');
      const areaPage = makeObservation({
        elements: [makeElement({ id: 't33', kind: 'textarea', operations: ['FILL'] })],
      });
      expect(
        succeeded(
          compile({
            observation: areaPage,
            operation: 'FILL',
            targetId: 't33',
            argument: inputRef('profile.name'),
            inputRules: bound,
          })
        ).command.operation
      ).toBe('FILL');
    });

    it('limits a bound non-sensitive input to its origins, defaulting to the run origins', () => {
      const run = (bind: TaskInputRule['bind'], origins: readonly string[]) =>
        compile({
          operation: 'FILL',
          targetId: 't3',
          argument: inputRef('profile.name'),
          inputRules: [rule('profile.name', false, bind)],
          origins,
        });
      expect(succeeded(run({ origins: [FIXTURE_ORIGIN] }, [OTHER_ORIGIN])).command.operation).toBe(
        'FILL'
      );
      expect(failedWith(run({ origins: [OTHER_ORIGIN] }, [FIXTURE_ORIGIN]))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
      expect(
        succeeded(run({ elementKinds: ['text_input'] }, [FIXTURE_ORIGIN])).command.operation
      ).toBe('FILL');
      expect(failedWith(run({ elementKinds: ['text_input'] }, [OTHER_ORIGIN]))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
      const unbound = compile({
        operation: 'FILL',
        targetId: 't3',
        argument: inputRef('profile.name'),
        inputRules: [rule('profile.name', false)],
        origins: [OTHER_ORIGIN],
      });
      expect(succeeded(unbound).command.operation).toBe('FILL');
    });

    it('binds a sensitive resolver like a sensitive input with the default binding', () => {
      const resolvers = [{ id: 'vault', sensitive: true }];
      const argument: TaskArgumentRef = {
        source: 'resolver',
        resolverId: 'vault',
        key: 'value:sg_x',
      };
      expect(succeeded(fillSensitive({ argument, resolvers })).command.operation).toBe('FILL');
      expect(failedWith(compile({ operation: 'FILL', targetId: 't3', argument, resolvers }))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
      expect(failedWith(fillSensitive({ argument, resolvers, origins: [OTHER_ORIGIN] }))).toBe(
        'ARGUMENT_NOT_ALLOWED'
      );
    });

    it('always allows EMPTY, on sensitive and non-sensitive fields alike', () => {
      expect(
        succeeded(fillSensitive({ argument: protocol('value', 'EMPTY') })).command.operation
      ).toBe('FILL');
      expect(
        succeeded(
          compile({ operation: 'FILL', targetId: 't3', argument: protocol('value', 'EMPTY') })
        ).command.operation
      ).toBe('FILL');
    });

    it('does not echo input values: a planted secret never appears in rules or in any output', () => {
      const secret = `s3cret-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const leaves = flattenInputs({ secret: { password: secret }, profile: { name: 'plain' } }, [
        { path: 'secret.password', sensitive: true },
      ]);
      const rules = inputRules(leaves);
      expect(JSON.stringify(rules)).not.toContain(secret);
      for (const entry of rules) {
        expect(Object.keys(entry)).not.toContain('value');
      }
      const result = fillSensitive({ argument: inputRef('secret.password'), inputRules: rules });
      expect(succeeded(result).command.operation).toBe('FILL');
      expect(JSON.stringify(result)).not.toContain(secret);
      const failure = compile({
        operation: 'FILL',
        targetId: 't3',
        argument: inputRef('secret.password'),
        inputRules: rules,
      });
      expect(JSON.stringify(failure)).not.toContain(secret);
    });
  });

  describe('built commands (step 4)', () => {
    it('builds reference commands for the operations that need only a target', () => {
      const observation = fullPage();
      for (const [operation, targetId] of [
        ['READ', 't7'],
        ['CLICK', 't1'],
        ['NAVIGATE', 't2'],
        ['SUBMIT', 't6'],
      ] as const) {
        const result = succeeded(compile({ observation, operation, targetId }));
        expect(result.command).toEqual({
          operation,
          target: {
            sessionId: observation.sessionId,
            snapshotId: observation.snapshotId,
            targetId,
            signature: signatureFor(targetId),
          },
        });
        expect(result.target?.id).toBe(targetId);
        expect(result.optionLabel).toBeUndefined();
      }
    });

    it('builds a native SELECT with the option id of the reference and its label', () => {
      const result = succeeded(
        compile({
          operation: 'SELECT',
          targetId: 't5',
          argument: { source: 'observed_option', targetId: 't5', optionId: 't5.2' },
        })
      );
      expect(result.command).toEqual({
        operation: 'SELECT',
        target: expect.objectContaining({ targetId: 't5' }),
        optionId: 't5.2',
      });
      expect(result.optionLabel).toBe('France');
    });

    it('builds an ARIA option SELECT with neither option id nor label', () => {
      const result = succeeded(compile({ operation: 'SELECT', targetId: 't11' }));
      expect(result.command).toEqual({
        operation: 'SELECT',
        target: expect.objectContaining({ targetId: 't11' }),
      });
      expect('optionId' in result.command).toBe(false);
      expect(result.optionLabel).toBeUndefined();
    });

    it('builds FILL with the reference itself as its value', () => {
      const argument = goalRef();
      const result = succeeded(compile({ operation: 'FILL', targetId: 't3', argument }));
      expect(result.command).toEqual({
        operation: 'FILL',
        target: expect.objectContaining({ targetId: 't3' }),
        value: argument,
      });
    });

    it('builds SET_CHECKED, PRESS and WAIT from their tokens', () => {
      expect(
        succeeded(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't4',
            argument: protocol('checked', 'UNCHECKED'),
          })
        ).command
      ).toMatchObject({ checked: false });
      expect(
        succeeded(
          compile({
            operation: 'SET_CHECKED',
            targetId: 't4',
            argument: protocol('checked', 'CHECKED'),
          })
        ).command
      ).toMatchObject({ checked: true });
      expect(
        succeeded(compile({ operation: 'PRESS', targetId: 't3', argument: protocol('key', 'Tab') }))
          .command
      ).toMatchObject({ key: 'Tab' });
      expect(
        succeeded(compile({ operation: 'WAIT', argument: protocol('duration', '2000') })).command
      ).toEqual({ operation: 'WAIT', durationMs: 2000 });
    });

    it('builds a page SCROLL without a target for no target id and for the page target id', () => {
      const argument = protocol('direction', 'DOWN');
      for (const targetId of [undefined, TASK_PAGE_TARGET_ID]) {
        const result = succeeded(
          compile({
            operation: 'SCROLL',
            ...(targetId === undefined ? {} : { targetId }),
            argument,
          })
        );
        expect(result.command).toEqual({ operation: 'SCROLL', direction: 'DOWN' });
        expect('target' in result.command).toBe(false);
        expect(result.target).toBeUndefined();
      }
    });

    it('does not build a page SCROLL when the page target is not offered', () => {
      const observation = makeObservation({ elements: [scroller()], page: pageScroll([]) });
      expect(
        failedWith(
          compile({ observation, operation: 'SCROLL', argument: protocol('direction', 'DOWN') })
        )
      ).toBe('TARGET_NOT_OFFERED');
      expect(
        failedWith(
          compile({
            observation,
            operation: 'SCROLL',
            targetId: TASK_PAGE_TARGET_ID,
            argument: protocol('direction', 'DOWN'),
          })
        )
      ).toBe('TARGET_NOT_OFFERED');
    });

    it('rejects a scroll target that is not offered or not in the observation', () => {
      expect(
        failedWith(
          compile({ operation: 'SCROLL', targetId: 't1', argument: protocol('direction', 'DOWN') })
        )
      ).toBe('TARGET_NOT_OFFERED');
      const offers: TaskOffers = {
        operations: ['SCROLL', 'DONE', 'BLOCKED'],
        targets: { SCROLL: ['t55'] },
      };
      expect(
        failedWith(
          compile({
            offers,
            operation: 'SCROLL',
            targetId: 't55',
            argument: protocol('direction', 'DOWN'),
          })
        )
      ).toBe('TARGET_UNKNOWN');
    });

    it('returns JSON without undefined values and does not mutate its inputs', () => {
      const observation = deepFreeze(fullPage());
      const capabilities = deepFreeze(makeCapabilities());
      const offers = deepFreeze(
        computeOffers({
          observation,
          capabilities,
          allowedOperations: [...TASK_HOST_OPERATIONS],
          exclude: [],
          allowRunLoss: false,
        })
      );
      const result = compileCommand({
        goal: GOAL,
        observation,
        offers,
        capabilities,
        operation: 'FILL',
        targetId: 't3',
        argument: goalRef(),
        inputRules: deepFreeze([rule('a', false)]),
        resolvers: deepFreeze([{ id: 'r', sensitive: false }]),
        origins: deepFreeze([FIXTURE_ORIGIN]),
      });
      expect(succeeded(result).command.operation).toBe('FILL');
      expect(roundTrip(succeeded(result).command)).toEqual(succeeded(result).command);
    });

    it('messages of failures never contain page labels, goal text or ids of the page text', () => {
      const labelled = makeObservation({
        elements: [makeTextField({ label: 'UNIQUE-PAGE-LABEL-9f3' })],
      });
      const failures = [
        compile({ observation: labelled, operation: 'FILL', targetId: 't3' }),
        compile({
          observation: labelled,
          operation: 'FILL',
          targetId: 't3',
          argument: { source: 'goal_literal', start: 0, end: 4, text: 'WRONG-TEXT-77' },
        }),
        compile({ observation: labelled, operation: 'CLICK', targetId: 't3' }),
      ];
      for (const failure of failures) {
        expect(failure.ok).toBe(false);
        const text = JSON.stringify(failure);
        expect(text).not.toContain('UNIQUE-PAGE-LABEL-9f3');
        expect(text).not.toContain('WRONG-TEXT-77');
      }
    });
  });
});

describe('commandDigest', () => {
  const digestInput = (overrides: Partial<TaskDigestInput> = {}): TaskDigestInput => ({
    command: makeCommand('CLICK'),
    effects: ['interact'],
    origin: FIXTURE_ORIGIN,
    target: { sensitive: false },
    ...overrides,
  });

  it('has the dg_ prefix, 32 hex characters and is deterministic', () => {
    const digest = commandDigest(digestInput());
    expect(digest).toMatch(/^dg_[0-9a-f]{32}$/);
    expect(commandDigest(digestInput())).toBe(digest);
  });

  it('ignores every snapshot-local id: session, snapshot, target id and option id', () => {
    const first = compile({
      observation: makeObservation({ elements: [makeSelectField()] }),
      operation: 'SELECT',
      targetId: 't5',
      argument: { source: 'observed_option', targetId: 't5', optionId: 't5.2' },
    });
    const other = makeObservation({
      sessionId: 'ses_00000000000f',
      snapshotId: 'snap_0000000000ff',
      elements: [
        makeSelectField({
          id: 't17',
          signature: signatureFor('t5'),
          options: [
            { id: 't17.1', label: 'India', value: 'in', selected: true, disabled: false },
            { id: 't17.2', label: 'France', value: 'fr', selected: false, disabled: false },
          ],
        }),
      ],
    });
    const second = compile({
      observation: other,
      operation: 'SELECT',
      targetId: 't17',
      argument: { source: 'observed_option', targetId: 't17', optionId: 't17.2' },
    });
    const one = succeeded(first);
    const two = succeeded(second);
    expect(JSON.stringify(one.command)).not.toBe(JSON.stringify(two.command));
    const toInput = (result: typeof one): TaskDigestInput => ({
      command: result.command,
      effects: ['select'],
      origin: FIXTURE_ORIGIN,
      ...(result.optionLabel === undefined ? {} : { optionLabel: result.optionLabel }),
      target: { sensitive: false },
    });
    expect(commandDigest(toInput(one))).toBe(commandDigest(toInput(two)));
  });

  it('changes with the operation and with the signature of the target', () => {
    const base = commandDigest(digestInput());
    expect(
      commandDigest(digestInput({ command: makeCommand('NAVIGATE', { target: makeTargetRef() }) }))
    ).not.toBe(base);
    expect(
      commandDigest(
        digestInput({
          command: makeCommand('CLICK', { target: makeTargetRef({ signature: 'sg_other' }) }),
        })
      )
    ).not.toBe(base);
  });

  it('changes with the origin and with the effects', () => {
    const base = commandDigest(digestInput());
    expect(commandDigest(digestInput({ origin: OTHER_ORIGIN }))).not.toBe(base);
    expect(commandDigest(digestInput({ effects: ['interact', 'navigate'] }))).not.toBe(base);
    expect(commandDigest(digestInput({ effects: ['purchase'] }))).not.toBe(base);
    expect(commandDigest(digestInput({ effects: [] }))).not.toBe(base);
  });

  it('sorts effects into the canonical order and ignores duplicates', () => {
    const forward = commandDigest(
      digestInput({ effects: ['interact', 'form_submit', 'navigate'] })
    );
    const shuffled = commandDigest(
      digestInput({ effects: ['form_submit', 'navigate', 'interact'] })
    );
    const repeated = commandDigest(
      digestInput({ effects: ['navigate', 'interact', 'form_submit', 'interact'] })
    );
    expect(shuffled).toBe(forward);
    expect(repeated).toBe(forward);
  });

  it('changes with the argument of a FILL: path, goal offsets, goal text, token, resolver id and key', () => {
    const fill = (value: TaskArgumentRef) =>
      commandDigest(digestInput({ command: makeCommand('FILL', { value }), effects: ['input'] }));
    const variants: readonly TaskArgumentRef[] = [
      { source: 'input', path: 'a' },
      { source: 'input', path: 'b' },
      { source: 'goal_literal', start: 1, end: 4, text: 'abc' },
      { source: 'goal_literal', start: 2, end: 5, text: 'abc' },
      { source: 'goal_literal', start: 1, end: 4, text: 'abd' },
      { source: 'goal_span', start: 1, end: 4, text: 'abc' },
      { source: 'protocol', slot: 'value', token: 'EMPTY' },
      { source: 'resolver', resolverId: 'r1', key: 'value:sg_a' },
      { source: 'resolver', resolverId: 'r2', key: 'value:sg_a' },
      { source: 'resolver', resolverId: 'r1', key: 'value:sg_b' },
    ];
    const digests = variants.map(fill);
    expect(new Set(digests).size).toBe(variants.length);
  });

  it('changes with the checked flag, the key, the direction and the duration', () => {
    const checked = (value: boolean) =>
      commandDigest(digestInput({ command: makeCommand('SET_CHECKED', { checked: value }) }));
    expect(checked(true)).not.toBe(checked(false));
    const press = (key: 'Enter' | 'Tab') =>
      commandDigest(digestInput({ command: makeCommand('PRESS', { key }) }));
    expect(press('Enter')).not.toBe(press('Tab'));
    const scroll = (direction: 'UP' | 'DOWN') =>
      commandDigest(digestInput({ command: makeCommand('SCROLL', { direction }) }));
    expect(scroll('UP')).not.toBe(scroll('DOWN'));
    const wait = (durationMs: number) =>
      commandDigest(digestInput({ command: makeCommand('WAIT', { durationMs }) }));
    expect(wait(250)).not.toBe(wait(500));
  });

  it('changes with the option label of a SELECT', () => {
    const select = (optionLabel: string) =>
      commandDigest(digestInput({ command: makeCommand('SELECT'), optionLabel }));
    expect(select('France')).not.toBe(select('India'));
    expect(select('France')).not.toBe(
      commandDigest(digestInput({ command: makeCommand('SELECT') }))
    );
  });

  it('changes with the href, the form target, the hints and the sensitivity of the target', () => {
    const base = commandDigest(digestInput());
    const withTarget = (target: TaskDigestInput['target']) =>
      commandDigest(digestInput({ target }));
    const linked = withTarget({ sensitive: false, href: `${FIXTURE_ORIGIN}/a` });
    expect(linked).not.toBe(base);
    expect(withTarget({ sensitive: false, href: `${FIXTURE_ORIGIN}/b` })).not.toBe(linked);
    const submitting = withTarget({
      sensitive: false,
      formTarget: { action: `${FIXTURE_ORIGIN}/pay`, method: 'POST' },
    });
    expect(submitting).not.toBe(base);
    expect(
      withTarget({
        sensitive: false,
        formTarget: { action: `${FIXTURE_ORIGIN}/evil`, method: 'POST' },
      })
    ).not.toBe(submitting);
    expect(
      withTarget({
        sensitive: false,
        formTarget: { action: `${FIXTURE_ORIGIN}/pay`, method: 'GET' },
      })
    ).not.toBe(submitting);
    const hinted = withTarget({
      sensitive: false,
      commitHints: [{ class: 'PURCHASE', basis: 'declared_marker' }],
    });
    expect(hinted).not.toBe(base);
    expect(
      withTarget({ sensitive: false, commitHints: [{ class: 'DELETE', basis: 'declared_marker' }] })
    ).not.toBe(hinted);
    expect(
      withTarget({
        sensitive: false,
        commitHints: [{ class: 'PURCHASE', basis: 'submit_control' }],
      })
    ).not.toBe(hinted);
    expect(withTarget({ sensitive: true })).not.toBe(base);
  });

  it('ignores the order of the hints', () => {
    const a = { class: 'PURCHASE', basis: 'declared_marker' } as const;
    const b = { class: 'FORM_SUBMIT', basis: 'submit_control' } as const;
    expect(commandDigest(digestInput({ target: { sensitive: false, commitHints: [a, b] } }))).toBe(
      commandDigest(digestInput({ target: { sensitive: false, commitHints: [b, a] } }))
    );
  });

  it('treats an absent target like a target with no structure', () => {
    const noTarget = commandDigest({
      command: makeCommand('WAIT'),
      effects: ['wait'],
      origin: FIXTURE_ORIGIN,
    });
    const plain = commandDigest({
      command: makeCommand('WAIT'),
      effects: ['wait'],
      origin: FIXTURE_ORIGIN,
      target: { sensitive: false },
    });
    expect(noTarget).toBe(plain);
  });
});

describe('commitContext and contextDigest', () => {
  const buildObservation = (): TaskObservation =>
    makeObservation({
      elements: [
        makeTextField({ id: 't3', label: 'Name', state: { value: 'Ada' }, formId: 'f1' }),
        makeCheckbox({ id: 't4', label: 'Gift wrap', state: { checked: true }, formId: 'f1' }),
        makeSensitiveField({
          id: 't8',
          label: 'Card number',
          state: { value: TASK_REDACTED },
          formId: 'f1',
        }),
        makeSubmitButton({ id: 't6', region: 'Cart' }),
        makePassage({ id: 't7', region: 'Cart', text: 'Order total 40 USD' }),
        makePassage({ id: 't9', region: 'Promo', text: 'Summer sale today', label: 'Promo' }),
      ],
      forms: [makeForm({ fieldIds: ['t3', 't4', 't8'], submitterIds: ['t6'] })],
      notices: [{ kind: 'banner', text: 'Welcome back' }],
      title: 'Checkout',
    });

  const contextOf = (observation: TaskObservation): TaskCommitContext =>
    commitContext({
      observation,
      element: observation.elements.find(element => element.id === 't6'),
    });

  const digestOf = (observation: TaskObservation) => contextDigest(contextOf(observation));

  const mapElement = (
    observation: TaskObservation,
    id: string,
    change: (element: TaskElement) => TaskElement
  ): TaskObservation => ({
    ...observation,
    elements: observation.elements.map(element => (element.id === id ? change(element) : element)),
  });

  it('builds the structural part from the element and the page part from scrubbed text', () => {
    const context = contextOf(buildObservation());
    expect(context.structural).toEqual({
      origin: FIXTURE_ORIGIN,
      destination: { action: `${FIXTURE_ORIGIN}/submit`, method: 'POST' },
      hints: [{ class: 'FORM_SUBMIT', basis: 'submit_control' }],
      sensitiveTarget: false,
    });
    expect(context.page.title).toBe('Checkout');
    expect(context.page.targetLabel).toBe('Submit');
    expect(context.page.url).toBe(buildObservation().url);
    expect(context.page.regionPassages).toEqual(['Order total 40 USD']);
  });

  it('lists the form fields with a value for plain fields and nonEmpty for sensitive text', () => {
    const { formFields } = contextOf(buildObservation()).page;
    expect(formFields).toEqual([
      { label: 'Name', kind: 'text_input', sensitive: false, value: 'Ada' },
      { label: 'Gift wrap', kind: 'checkbox', sensitive: false, checked: true },
      { label: 'Card number', kind: 'text_input', sensitive: true, nonEmpty: true },
    ]);
  });

  it('reports an empty sensitive field as not non-empty', () => {
    const observation = mapElement(buildObservation(), 't8', element => ({
      ...element,
      state: { ...element.state, value: '' },
    }));
    const field = contextOf(observation).page.formFields.find(item => item.sensitive);
    expect(field).toEqual({
      label: 'Card number',
      kind: 'text_input',
      sensitive: true,
      nonEmpty: false,
    });
  });

  it('never copies the value of a sensitive field, even if a host leaked it', () => {
    const leak = `leak-${Math.random().toString(36).slice(2)}`;
    const observation = mapElement(buildObservation(), 't8', element => ({
      ...element,
      state: { ...element.state, value: leak },
    }));
    expect(JSON.stringify(contextOf(observation))).not.toContain(leak);
  });

  it('uses the form given by the caller before the form found through the element', () => {
    const observation = buildObservation();
    const chosen = makeForm({ id: 'f9', fieldIds: ['t4'], submitterIds: ['t6'] });
    const context = commitContext({
      observation,
      element: observation.elements.find(element => element.id === 't6'),
      form: chosen,
    });
    expect(context.page.formFields.map(field => field.label)).toEqual(['Gift wrap']);
  });

  it('has no form fields when the element has no form, and no destination for a plain button', () => {
    const observation = buildObservation();
    const context = commitContext({
      observation,
      element: observation.elements.find(element => element.id === 't7'),
    });
    expect(context.page.formFields).toEqual([]);
    expect('destination' in context.structural).toBe(false);
    expect(context.structural.hints).toEqual([]);
  });

  it('uses the href as a GET destination for a link', () => {
    const link = makeElement({
      id: 't2',
      kind: 'link',
      role: 'link',
      operations: ['NAVIGATE'],
      href: `${FIXTURE_ORIGIN}/orders`,
    });
    const context = commitContext({
      observation: makeObservation({ elements: [link] }),
      element: link,
    });
    expect(context.structural.destination).toEqual({
      action: `${FIXTURE_ORIGIN}/orders`,
      method: 'GET',
    });
  });

  it('prefers the form target over the href', () => {
    const element = makeSubmitButton({ href: `${FIXTURE_ORIGIN}/ignored` });
    const context = commitContext({
      observation: makeObservation({ elements: [element] }),
      element,
    });
    expect(context.structural.destination).toEqual(element.formTarget);
  });

  it('marks a sensitive target', () => {
    const element = makeSensitiveField();
    const context = commitContext({
      observation: makeObservation({ elements: [element] }),
      element,
    });
    expect(context.structural.sensitiveTarget).toBe(true);
  });

  it('builds a context for the page alone when no element is given', () => {
    const context = commitContext({ observation: buildObservation() });
    expect(context.page.targetLabel).toBe('');
    expect(context.page.formFields).toEqual([]);
    expect(context.page.regionPassages).toEqual([]);
    expect(context.structural.sensitiveTarget).toBe(false);
  });

  it('takes region passages in document order from READ elements that share the region or the dialog', () => {
    const observation = makeObservation({
      elements: [
        makeSubmitButton({ id: 't6', region: 'Cart', dialogId: 'd1' }),
        makePassage({ id: 't20', region: 'Cart', text: 'first' }),
        makePassage({ id: 't21', region: 'Elsewhere', text: 'never' }),
        makePassage({ id: 't22', dialogId: 'd1', text: 'second' }),
        makePassage({ id: 't23', region: 'Cart', dialogId: 'd9', text: 'third' }),
        makeElement({
          id: 't24',
          region: 'Cart',
          text: 'not a READ element',
          operations: ['CLICK'],
        }),
        makePassage({ id: 't25', text: 'no region at all' }),
      ],
    });
    const context = commitContext({
      observation,
      element: observation.elements.find(element => element.id === 't6'),
    });
    expect(context.page.regionPassages).toEqual(['first', 'second', 'third']);
  });

  it('has no region passages when the target has neither region nor dialog', () => {
    const observation = makeObservation({
      elements: [makeSubmitButton({ id: 't6' }), makePassage({ id: 't7', text: 'orphan' })],
    });
    const context = commitContext({
      observation,
      element: observation.elements.find(element => element.id === 't6'),
    });
    expect(context.page.regionPassages).toEqual([]);
  });

  it('caps the passages in number and length and never splits a surrogate pair', () => {
    const long = '\u{1F600}'.repeat(TASK_LIMITS.commitContextPassageChars + 50);
    const passages = Array.from({ length: TASK_LIMITS.commitContextPassages + 3 }, (_, index) =>
      makePassage({
        id: `t${40 + index}`,
        region: 'Cart',
        text: index === 0 ? long : `passage ${index}`,
      })
    );
    const observation = makeObservation({
      elements: [makeSubmitButton({ id: 't6', region: 'Cart' }), ...passages],
    });
    const context = commitContext({
      observation,
      element: observation.elements.find(element => element.id === 't6'),
    });
    expect(context.page.regionPassages).toHaveLength(TASK_LIMITS.commitContextPassages);
    expect(Array.from(context.page.regionPassages[0] ?? '')).toHaveLength(
      TASK_LIMITS.commitContextPassageChars
    );
    expect(context.page.regionPassages[1]).toBe('passage 1');
  });

  it('caps the form fields', () => {
    const fieldElements = Array.from({ length: TASK_LIMITS.commitContextFields + 10 }, (_, index) =>
      makeTextField({
        id: `t${100 + index}`,
        label: `Field ${index}`,
        state: { value: `v${index}` },
      })
    );
    const submit = makeSubmitButton({ id: 't6' });
    const observation = makeObservation({
      elements: [...fieldElements, submit],
      forms: [
        makeForm({ fieldIds: fieldElements.map(element => element.id), submitterIds: ['t6'] }),
      ],
    });
    const context = commitContext({ observation, element: submit });
    expect(context.page.formFields).toHaveLength(TASK_LIMITS.commitContextFields);
    expect(context.page.formFields[0]?.label).toBe('Field 0');
  });

  it('skips form fields the observation does not contain', () => {
    const submit = makeSubmitButton({ id: 't6' });
    const observation = makeObservation({
      elements: [makeTextField({ id: 't3', label: 'Name' }), submit],
      forms: [makeForm({ fieldIds: ['t404', 't3'], submitterIds: ['t6'] })],
    });
    expect(
      commitContext({ observation, element: submit }).page.formFields.map(field => field.label)
    ).toEqual(['Name']);
  });

  it('sanitizes page strings: invisible characters go and look-alike ids are neutralized', () => {
    const observation = makeObservation({
      title: `Pay${ZWSP}ment [t6]${BELL}`,
      elements: [makeSubmitButton({ id: 't6', label: `Place${BIDI_OVERRIDE} order [t1]` })],
      notices: [{ kind: 'alert', text: 'Total   changed\nnow' }],
      validation: [{ source: 'native', text: `Bad${ZWSP} value` }],
      dialogs: [{ id: 'd1', modal: false, label: `Confirm${NBSP}${NBSP}it`, elementIds: [] }],
    });
    const context = commitContext({ observation, element: observation.elements[0] });
    expect(context.page.title).toBe('Payment (t6)');
    expect(context.page.targetLabel).toBe('Place order (t1)');
    expect(context.page.notices).toEqual(['Total changed now']);
    expect(context.page.validation).toEqual(['Bad value']);
    expect(context.page.dialogs).toEqual(['Confirm it']);
  });

  it('keeps alerts, statuses and logs in the notices and leaves banners out', () => {
    const observation = makeObservation({
      elements: [makeSubmitButton({ id: 't6' })],
      notices: [
        { kind: 'banner', text: 'Promo banner' },
        { kind: 'alert', text: 'Alert text' },
        { kind: 'status', text: 'Status text' },
        { kind: 'log', text: 'Log text' },
      ],
    });
    const context = commitContext({ observation, element: observation.elements[0] });
    expect(context.page.notices).toEqual(['Alert text', 'Status text', 'Log text']);
  });

  it('redacts credentials and tokens from the page URL', () => {
    const observation = makeObservation({
      url: `${FIXTURE_ORIGIN}/pay?token=abcdefghijklmnopqrstuvwxyz0123456789ABCD#frag`,
      elements: [makeSubmitButton({ id: 't6' })],
    });
    const context = commitContext({ observation, element: observation.elements[0] });
    expect(context.page.url).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    expect(context.page.url).not.toContain('frag');
    expect(context.page.url.startsWith(`${FIXTURE_ORIGIN}/pay`)).toBe(true);
  });

  it('round trips as JSON and does not mutate its input', () => {
    const observation = deepFreeze(buildObservation());
    const context = contextOf(observation);
    expect(roundTrip(context)).toEqual(context);
  });

  describe('digest', () => {
    it('has the cx_ prefix, 32 hex characters and is deterministic', () => {
      const digest = digestOf(buildObservation());
      expect(digest).toMatch(/^cx_[0-9a-f]{32}$/);
      expect(digestOf(buildObservation())).toBe(digest);
    });

    it('changes when a form field value changes', () => {
      const base = digestOf(buildObservation());
      const changed = mapElement(buildObservation(), 't3', element => ({
        ...element,
        state: { ...element.state, value: 'Grace' },
      }));
      expect(digestOf(changed)).not.toBe(base);
      const toggled = mapElement(buildObservation(), 't4', element => ({
        ...element,
        state: { ...element.state, checked: false },
      }));
      expect(digestOf(toggled)).not.toBe(base);
    });

    it('changes when a sensitive field becomes empty or filled, never with its content', () => {
      const base = digestOf(buildObservation());
      const emptied = mapElement(buildObservation(), 't8', element => ({
        ...element,
        state: { ...element.state, value: '' },
      }));
      expect(digestOf(emptied)).not.toBe(base);
      const otherMask = mapElement(buildObservation(), 't8', element => ({
        ...element,
        state: { ...element.state, value: 'different but still non-empty' },
      }));
      expect(digestOf(otherMask)).toBe(base);
    });

    it('changes when a passage in the target region changes (an order total)', () => {
      const base = digestOf(buildObservation());
      const changed = mapElement(buildObservation(), 't7', element => ({
        ...element,
        text: 'Order total 4000 USD',
      }));
      expect(digestOf(changed)).not.toBe(base);
    });

    it('does not change when a passage outside the region changes', () => {
      const base = digestOf(buildObservation());
      const changed = mapElement(buildObservation(), 't9', element => ({
        ...element,
        text: 'Winter sale today',
      }));
      expect(digestOf(changed)).toBe(base);
    });

    it('changes when an alert notice appears and not when a banner changes', () => {
      const base = digestOf(buildObservation());
      const alerted: TaskObservation = {
        ...buildObservation(),
        notices: [...buildObservation().notices, { kind: 'alert', text: 'Price changed' }],
      };
      expect(digestOf(alerted)).not.toBe(base);
      const rebanner: TaskObservation = {
        ...buildObservation(),
        notices: [{ kind: 'banner', text: 'A completely different banner' }],
      };
      expect(digestOf(rebanner)).toBe(base);
    });

    it('changes when validation text or a dialog label changes', () => {
      const base = digestOf(buildObservation());
      const invalid: TaskObservation = {
        ...buildObservation(),
        validation: [{ source: 'native', text: 'Required', targetId: 't3' }],
      };
      expect(digestOf(invalid)).not.toBe(base);
      const dialog: TaskObservation = {
        ...buildObservation(),
        dialogs: [{ id: 'd1', modal: true, label: 'Confirm purchase', elementIds: ['t6'] }],
      };
      expect(digestOf(dialog)).not.toBe(base);
    });

    it('changes when the destination changes', () => {
      const base = digestOf(buildObservation());
      const action = mapElement(buildObservation(), 't6', element => ({
        ...element,
        formTarget: { action: `${FIXTURE_ORIGIN}/evil`, method: 'POST' },
      }));
      expect(digestOf(action)).not.toBe(base);
      const method = mapElement(buildObservation(), 't6', element => ({
        ...element,
        formTarget: { action: `${FIXTURE_ORIGIN}/submit`, method: 'GET' },
      }));
      expect(digestOf(method)).not.toBe(base);
    });

    it('changes when the hints or the label of the target change', () => {
      const base = digestOf(buildObservation());
      const hinted = mapElement(buildObservation(), 't6', element => ({
        ...element,
        commitHints: [{ class: 'PURCHASE', basis: 'declared_marker' }],
      }));
      expect(digestOf(hinted)).not.toBe(base);
      const relabelled = mapElement(buildObservation(), 't6', element => ({
        ...element,
        label: 'Delete everything',
      }));
      expect(digestOf(relabelled)).not.toBe(base);
    });

    it('does not change with focus, scrolling state, snapshot ids, the text or the fingerprint', () => {
      const base = digestOf(buildObservation());
      const focusedField = mapElement(buildObservation(), 't3', element => ({
        ...element,
        state: { ...element.state, focused: true },
      }));
      expect(digestOf(focusedField)).toBe(base);
      const focusedTarget = mapElement(buildObservation(), 't6', element => ({
        ...element,
        state: { ...element.state, focused: true },
      }));
      expect(digestOf(focusedTarget)).toBe(base);
      const other: TaskObservation = {
        ...buildObservation(),
        sessionId: 'ses_0000000000aa',
        snapshotId: 'snap_0000000000bb',
        text: 'Totally different page text',
        fingerprint: 'ffffffff',
        sequence: 99,
        observedAt: 1,
      };
      expect(digestOf(other)).toBe(base);
    });
  });
});

describe('redactCommand', () => {
  const view: TaskArgumentView = {
    slot: 'value',
    source: 'input',
    label: 'input:name',
    preview: 'Ada',
    sensitive: false,
  };

  it('keeps the command and reduces the target to the ten summary fields, twins included', () => {
    const element = makeTextField({
      twins: 2,
      href: `${FIXTURE_ORIGIN}/x`,
      formId: 'f1',
      description: 'long help text',
      text: 'passage text',
      state: { value: 'typed text', focused: true },
      options: [{ id: 't3.1', label: 'x', selected: false, disabled: false }],
      region: 'Cart',
    });
    const command = makeCommand('FILL');
    const redacted = redactCommand(command, element, view);
    expect(redacted.command).toEqual(command);
    expect(redacted.target).toEqual(summarizeElement(element));
    expect(Object.keys(redacted.target ?? {}).sort()).toEqual(
      [
        'formId',
        'href',
        'id',
        'inputType',
        'kind',
        'label',
        'role',
        'sensitive',
        'signature',
        'twins',
      ].sort()
    );
    expect(JSON.stringify(redacted)).not.toContain('typed text');
    expect(JSON.stringify(redacted)).not.toContain('passage text');
    expect(JSON.stringify(redacted)).not.toContain('long help text');
    expect(redacted.argument).toEqual(view);
  });

  it('omits what is absent instead of writing undefined', () => {
    const bare = redactCommand(makeCommand('WAIT'), undefined, undefined);
    expect(bare).toEqual({ command: makeCommand('WAIT') });
    expect(Object.keys(bare)).toEqual(['command']);
    const withLabel = redactCommand(makeCommand('SELECT'), makeSelectField(), undefined, 'France');
    expect(withLabel.optionLabel).toBe('France');
    expect('argument' in withLabel).toBe(false);
    const element = makeElement();
    const summary = redactCommand(makeCommand('CLICK'), element, undefined).target ?? {};
    for (const key of ['twins', 'inputType', 'href', 'formId']) {
      expect(key in summary).toBe(false);
    }
    expect(roundTrip(redactCommand(makeCommand('CLICK'), element, undefined))).toEqual(
      redactCommand(makeCommand('CLICK'), element, undefined)
    );
  });

  it('keeps a sensitive argument view free of any preview that the caller left out', () => {
    const sensitiveView: TaskArgumentView = {
      slot: 'value',
      source: 'input',
      label: 'input:secret.password',
      sensitive: true,
    };
    const redacted = redactCommand(makeCommand('FILL'), makeSensitiveField(), sensitiveView);
    expect(redacted.argument).toEqual(sensitiveView);
    expect(redacted.target?.sensitive).toBe(true);
  });
});

describe('toHostCommand', () => {
  const okValue = (value: string, sensitive: boolean): Extract<TaskMaterialized, { ok: true }> => ({
    ok: true,
    value,
    sensitive,
  });

  it('turns a FILL reference into the raw value and carries the sensitivity of the value', () => {
    const result = toHostCommand(makeCommand('FILL'), okValue('Ada', false), makeTextField());
    expect(result).toEqual({
      ok: true,
      command: {
        operation: 'FILL',
        target: makeCommand('FILL').target,
        value: 'Ada',
        sensitive: false,
      },
    });
  });

  it('marks the command sensitive when the value is sensitive on a plain target', () => {
    const result = toHostCommand(makeCommand('FILL'), okValue('Ada', true), makeTextField());
    expect(result).toMatchObject({ ok: true, command: { sensitive: true } });
  });

  it('marks the command sensitive for a sensitive target even with a non-sensitive value', () => {
    const result = toHostCommand(
      makeCommand('FILL'),
      okValue('plain', false),
      makeSensitiveField()
    );
    expect(result).toMatchObject({ ok: true, command: { value: 'plain', sensitive: true } });
  });

  it('is sensitive when both the value and the target are', () => {
    const result = toHostCommand(makeCommand('FILL'), okValue('x', true), makeSensitiveField());
    expect(result).toMatchObject({ ok: true, command: { sensitive: true } });
  });

  it('treats an unknown target as non-sensitive and keeps an empty value', () => {
    const result = toHostCommand(makeCommand('FILL'), okValue('', false), undefined);
    expect(result).toMatchObject({ ok: true, command: { value: '', sensitive: false } });
  });

  it('needs a materialized value for FILL and says so without a value', () => {
    const result = toHostCommand(makeCommand('FILL'), undefined, makeTextField());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it.each(TASK_HOST_OPERATIONS.filter(operation => operation !== 'FILL'))(
    'passes %s through unchanged, ignoring a materialized value',
    operation => {
      const command = makeCommand(operation);
      expect(toHostCommand(command, undefined, undefined)).toEqual({ ok: true, command });
      expect(toHostCommand(command, okValue('ignored', true), makeSensitiveField())).toEqual({
        ok: true,
        command,
      });
    }
  );

  it('never adds a value field to a command that is not FILL', () => {
    const result = toHostCommand(
      makeCommand('CLICK'),
      okValue('secret', true),
      makeSensitiveField()
    );
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('toActionCommand (5.1)', () => {
  const context = (overrides: Partial<TaskActionContext> = {}): TaskActionContext => ({
    timeoutMs: 8000,
    ...overrides,
  });

  const convert = (
    command: TaskHostCommand,
    overrides: Partial<TaskActionContext> = {}
  ): ActionCommand => {
    const result = toActionCommand(command, context(overrides));
    if (result === null) {
      throw new Error('expected an action command');
    }
    return result;
  };

  it('returns null for READ', () => {
    expect(toActionCommand(makeHostCommand('READ'), context())).toBeNull();
  });

  it.each(['CLICK', 'NAVIGATE', 'SUBMIT'] as const)('maps %s to a strict click', operation => {
    expect(convert(makeHostCommand(operation))).toEqual({
      type: 'click',
      parameters: { strict: 'true' },
      timeout: 8000,
    });
  });

  it('maps FILL to fill with the value and marks it sensitive only when the command is', () => {
    expect(convert(makeHostCommand('FILL', { value: 'Ada', sensitive: false }))).toEqual({
      type: 'fill',
      parameters: { strict: 'true', value: 'Ada' },
      timeout: 8000,
    });
    expect(convert(makeHostCommand('FILL', { value: 'Ada', sensitive: true }))).toEqual({
      type: 'fill',
      parameters: { strict: 'true', value: 'Ada' },
      timeout: 8000,
      sensitiveParameters: ['value'],
    });
  });

  it('keeps an empty FILL value as an empty string', () => {
    const action = convert(makeHostCommand('FILL', { value: '', sensitive: false }));
    expect(action.parameters.value).toBe('');
    expect('value' in action.parameters).toBe(true);
    expect(action.sensitiveParameters).toBeUndefined();
  });

  it('maps a native SELECT to select by index with the option index as a decimal string', () => {
    expect(convert(makeHostCommand('SELECT', { optionId: 't5.2' }), { optionIndex: 1 })).toEqual({
      type: 'select',
      parameters: { strict: 'true', matchBy: 'index', option: '1' },
      timeout: 8000,
    });
    expect(
      convert(makeHostCommand('SELECT', { optionId: 't5.1' }), { optionIndex: 0 }).parameters.option
    ).toBe('0');
    expect(
      convert(makeHostCommand('SELECT', { optionId: 't5.1' }), { optionIndex: 12 }).parameters
        .option
    ).toBe('12');
  });

  it('never writes the text undefined or NaN when a native SELECT lacks a usable index', () => {
    for (const optionIndex of [undefined, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const action = convert(makeHostCommand('SELECT', { optionId: 't5.1' }), {
        ...(optionIndex === undefined ? {} : { optionIndex }),
      });
      expect(action.type).toBe('select');
      for (const value of Object.values(action.parameters)) {
        expect(value).not.toMatch(/undefined|NaN|Infinity|^-/);
      }
      expect('option' in action.parameters).toBe(false);
    }
  });

  it('maps a SELECT on an ARIA option to select with no parameter besides strict', () => {
    const command: TaskHostCommand = {
      operation: 'SELECT',
      target: makeTargetRef({ targetId: 't11' }),
    };
    expect(convert(command, { optionIndex: 3 })).toEqual({
      type: 'select',
      parameters: { strict: 'true' },
      timeout: 8000,
    });
  });

  it('maps SET_CHECKED to setChecked with canonical booleans', () => {
    expect(convert(makeHostCommand('SET_CHECKED', { checked: true }))).toEqual({
      type: 'setChecked',
      parameters: { strict: 'true', checked: 'true' },
      timeout: 8000,
    });
    expect(convert(makeHostCommand('SET_CHECKED', { checked: false })).parameters.checked).toBe(
      'false'
    );
  });

  it('maps PRESS to press with the key and implicitSubmit, and Space to the space character', () => {
    expect(convert(makeHostCommand('PRESS', { key: 'Enter' }))).toEqual({
      type: 'press',
      parameters: { strict: 'true', key: 'Enter', implicitSubmit: 'true' },
      timeout: 8000,
    });
    expect(convert(makeHostCommand('PRESS', { key: 'Space' })).parameters.key).toBe(' ');
    for (const key of TASK_KEYS.filter(item => item !== 'Space')) {
      expect(convert(makeHostCommand('PRESS', { key })).parameters.key).toBe(key);
    }
  });

  it('maps SCROLL to scroll with the direction', () => {
    expect(convert(makeHostCommand('SCROLL', { direction: 'BOTTOM' }))).toEqual({
      type: 'scroll',
      parameters: { strict: 'true', direction: 'BOTTOM' },
      timeout: 8000,
    });
  });

  it('maps WAIT to wait with the duration and a timeout one second longer', () => {
    expect(convert(makeHostCommand('WAIT', { durationMs: 500 }))).toEqual({
      type: 'wait',
      parameters: { strict: 'true', duration: '500' },
      timeout: 1500,
    });
    expect(convert(makeHostCommand('WAIT', { durationMs: 5000 }), { timeoutMs: 100 }).timeout).toBe(
      6000
    );
  });

  it('uses the context timeout for every other operation', () => {
    for (const operation of ['CLICK', 'FILL', 'SET_CHECKED', 'PRESS', 'SCROLL'] as const) {
      expect(convert(makeHostCommand(operation), { timeoutMs: 1234 }).timeout).toBe(1234);
    }
  });

  it('marks every command strict, passes only string parameters and never sets a description', () => {
    for (const operation of TASK_HOST_OPERATIONS) {
      if (operation === 'READ') {
        continue;
      }
      const command = makeHostCommand(operation);
      const action = convert(command, { optionIndex: 1 });
      expect(action.parameters.strict).toBe('true');
      expect('description' in action).toBe(false);
      for (const value of Object.values(action.parameters)) {
        expect(typeof value).toBe('string');
      }
      expect(roundTrip(action)).toEqual(action);
    }
  });

  it('puts no value in the parameters of a non-FILL command', () => {
    for (const operation of TASK_HOST_OPERATIONS) {
      if (operation === 'FILL' || operation === 'READ') {
        continue;
      }
      expect('value' in convert(makeHostCommand(operation)).parameters).toBe(false);
    }
  });

  const parametersPath = path.join(__dirname, '..', 'src', 'actions', 'parameters.ts');
  const whenExecutorExists = fs.existsSync(parametersPath) ? it : it.skip;

  whenExecutorExists(
    'produces parameters that validateActionParameters accepts in strict mode',
    () => {
      const executor = jest.requireActual<{
        validateActionParameters: (action: ActionCommand, strict: boolean) => unknown;
      }>('@/actions/parameters');
      for (const operation of TASK_HOST_OPERATIONS) {
        if (operation === 'READ') {
          continue;
        }
        const action = convert(makeHostCommand(operation), { optionIndex: 1 });
        expect(executor.validateActionParameters(action, true)).toBeNull();
      }
    }
  );
});

describe('malformed decider output never makes compileCommand throw', () => {
  const nullArgument = null as unknown as TaskArgumentRef;
  const nullTarget = null as unknown as string;

  it('treats a null argument as no argument', () => {
    expect(
      succeeded(compile({ operation: 'CLICK', targetId: 't1', argument: nullArgument })).command
    ).toMatchObject({ operation: 'CLICK' });
    expect(failedWith(compile({ operation: 'FILL', targetId: 't3', argument: nullArgument }))).toBe(
      'ARGUMENT_REQUIRED'
    );
    expect(failedWith(compile({ operation: 'SCROLL', argument: nullArgument }))).toBe(
      'ARGUMENT_REQUIRED'
    );
    expect(failedWith(compile({ operation: 'WAIT', argument: nullArgument }))).toBe(
      'ARGUMENT_REQUIRED'
    );
  });

  it('treats a null target as no target', () => {
    expect(failedWith(compile({ operation: 'CLICK', targetId: nullTarget }))).toBe(
      'TARGET_REQUIRED'
    );
    const scrolled = succeeded(
      compile({
        operation: 'SCROLL',
        targetId: nullTarget,
        argument: protocol('direction', 'DOWN'),
      })
    );
    expect(scrolled.command).toEqual({ operation: 'SCROLL', direction: 'DOWN' });
    expect(scrolled.target).toBeUndefined();
    expect(
      succeeded(
        compile({ operation: 'WAIT', targetId: nullTarget, argument: protocol('duration', '500') })
      ).command
    ).toEqual({ operation: 'WAIT', durationMs: 500 });
  });

  it('turns every other malformed argument into a result', () => {
    const malformed: readonly unknown[] = [
      0,
      '',
      'goal_span',
      [],
      {},
      { source: 'goal_span' },
      { source: 'goal_span', start: 0, end: 4 },
      { source: 'input' },
      { source: 'protocol', slot: 'value' },
      { source: 'observed_option' },
      { source: 'resolver' },
      { source: ['input'] },
    ];
    for (const argument of malformed) {
      for (const [operation, targetId] of [
        ['FILL', 't3'],
        ['SELECT', 't5'],
        ['SET_CHECKED', 't4'],
        ['PRESS', 't3'],
        ['CLICK', 't1'],
      ] as const) {
        const result = compile({ operation, targetId, argument: argument as TaskArgumentRef });
        expect(result.ok).toBe(false);
      }
    }
  });
});

describe('redactCommand drops a preview from a sensitive view', () => {
  const command = makeCommand('FILL');

  it('removes the preview of a sensitive view whatever the caller passed, and keeps the rest', () => {
    const leaky: TaskArgumentView = {
      slot: 'value',
      source: 'input',
      label: 'input:secret.password',
      preview: 'hunter2-never-shown',
      sensitive: true,
    };
    const redacted = redactCommand(command, makeSensitiveField(), leaky);
    expect(redacted.argument).toEqual({
      slot: 'value',
      source: 'input',
      label: 'input:secret.password',
      sensitive: true,
    });
    expect(JSON.stringify(redacted)).not.toContain('hunter2-never-shown');
    expect(leaky.preview).toBe('hunter2-never-shown');
  });

  it('keeps the preview of a view that is not sensitive', () => {
    const open: TaskArgumentView = {
      slot: 'value',
      source: 'input',
      label: 'input:name',
      preview: 'Ada',
      sensitive: false,
    };
    expect(redactCommand(command, makeTextField(), open).argument).toEqual(open);
  });
});

describe('property: nothing compiles outside what was offered', () => {
  const ORIGINS = ['https://a.test', 'https://b.test', 'https://c.test'] as const;
  const KINDS = [
    'button',
    'link',
    'text_input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'option',
    'scroller',
    'passage',
    'combobox',
  ] as const;
  const OPERATIONS_OF: Readonly<Record<(typeof KINDS)[number], readonly TaskHostOperation[]>> = {
    button: ['CLICK', 'SUBMIT', 'READ'],
    link: ['NAVIGATE', 'READ'],
    text_input: ['FILL', 'PRESS', 'READ'],
    textarea: ['FILL', 'PRESS'],
    select: ['SELECT'],
    checkbox: ['SET_CHECKED'],
    radio: ['SET_CHECKED'],
    option: ['SELECT'],
    scroller: ['SCROLL'],
    passage: ['READ'],
    combobox: ['FILL', 'SELECT'],
  };
  const DIRECTIONS = ['UP', 'DOWN', 'TOP', 'BOTTOM'] as const;

  const generator = (seed: number) => {
    let state = seed;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const chance = (probability: number): boolean => next() < probability;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const subset = <T>(items: readonly T[]): T[] => items.filter(() => chance(0.5));
    return { next, chance, pick, subset };
  };

  it('holds for seeded random pages, capabilities, exclusions, bindings and arguments', () => {
    const random = generator(987654);
    const problems: string[] = [];
    let compiled = 0;
    for (let round = 0; round < 250; round += 1) {
      const modal = random.chance(0.3);
      const dialogs = modal ? [{ id: 'd1', modal: true, label: 'Dialog', elementIds: [] }] : [];
      const count = 1 + Math.floor(random.next() * 8);
      const elements = Array.from({ length: count }, (_, index) => {
        const kind = random.pick(KINDS);
        return makeElement({
          id: `t${index + 1}`,
          kind,
          sensitive: random.chance(0.3),
          operations: (OPERATIONS_OF[kind] ?? []).filter(() => random.chance(0.9)),
          inputType: kind === 'text_input' ? random.pick(['text', 'password', 'tel']) : undefined,
          ...(kind === 'select'
            ? {
                options: [
                  { id: `t${index + 1}.0`, label: 'One', selected: false, disabled: false },
                  { id: `t${index + 1}.1`, label: 'Two', selected: false, disabled: true },
                ],
              }
            : {}),
          ...(modal && random.chance(0.5) ? { dialogId: 'd1' } : {}),
          ...(kind === 'scroller'
            ? { scroll: { directions: random.subset(DIRECTIONS), top: 5, max: 100 } }
            : {}),
        });
      });
      const origin = random.pick(ORIGINS);
      const observation = makeObservation({
        origin,
        url: `${origin}/page`,
        elements,
        dialogs,
        page: {
          readyState: 'complete',
          busy: false,
          scroll: { directions: random.subset(DIRECTIONS), top: 3, max: 100 },
          viewport: { width: 10, height: 10 },
        },
      });
      const capabilities = makeCapabilities({
        operations: random.subset(TASK_HOST_OPERATIONS),
        persistsAcrossNavigation: random.chance(0.7),
        detectsNavigation: random.chance(0.8),
        scrollContainers: random.chance(0.5),
        implicitSubmitDetection: random.chance(0.6),
        keys: random.subset(['Enter', 'Tab', 'Escape', 'Space'] as const),
        waitDurationsMs: random.chance(0.7) ? [250, 500] : [],
      });
      const allowedOperations = random.subset(TASK_HOST_OPERATIONS);
      const excludedId = `t${1 + Math.floor(random.next() * count)}`;
      const exclude = random.chance(0.4)
        ? [{ operation: random.pick(TASK_HOST_OPERATIONS), targetId: excludedId }]
        : [];
      const allowRunLoss = random.chance(0.3);
      const offers = computeOffers({
        observation,
        capabilities,
        allowedOperations,
        exclude,
        allowRunLoss,
      });

      const declarations = Array.from({ length: 4 }, (_, index) => ({
        path: `in${index}`,
        sensitive: random.chance(0.5),
        ...(random.chance(0.5)
          ? {
              bind: {
                ...(random.chance(0.5) ? { origins: random.subset(ORIGINS) } : {}),
                ...(random.chance(0.3) ? { elementKinds: random.subset(KINDS) } : {}),
                ...(random.chance(0.3) ? { inputTypes: random.subset(['text', 'password']) } : {}),
                ...(random.chance(0.4) ? { requireSensitiveElement: random.chance(0.5) } : {}),
              },
            }
          : {}),
      }));
      const leaves = flattenInputs(
        Object.fromEntries(declarations.map(entry => [entry.path, `value ${entry.path}`])),
        declarations
      );
      const resolvers = [
        {
          id: 'secret',
          description: 'S',
          sensitive: true,
          slots: ['value'] as const,
          resolve: async () => ({ ok: true as const, value: 'v' }),
        },
        {
          id: 'plain',
          description: 'P',
          sensitive: false,
          slots: ['value'] as const,
          resolve: async () => ({ ok: true as const, value: 'v' }),
        },
      ];
      const runOrigins = random.subset(ORIGINS);
      const goal = 'Type "hello" now';

      for (const operation of TASK_HOST_OPERATIONS) {
        for (const targetId of [undefined, TASK_PAGE_TARGET_ID, ...elements.map(e => e.id)]) {
          const element = elements.find(candidate => candidate.id === targetId);
          const spec = describeArgument(operation, element);
          const candidates =
            spec === null
              ? { candidates: [], withheld: 0, truncated: false }
              : buildCandidates({
                  goal,
                  operation,
                  slot: spec.slot,
                  element,
                  observation,
                  capabilities,
                  leaves,
                  resolvers,
                  origins: runOrigins,
                  limit: 1000,
                });
          const offered = new Set(
            (spec === null ? [] : candidates.candidates).map(item => JSON.stringify(item.ref))
          );
          const tried: (TaskArgumentRef | undefined)[] = [
            undefined,
            ...(spec === null ? [] : candidates.candidates.map(item => item.ref)),
          ];
          if (spec?.slot === 'value') {
            tried.push(
              ...leaves.map(item => ({ source: 'input' as const, path: item.path })),
              ...resolvers.map(item => ({
                source: 'resolver' as const,
                resolverId: item.id,
                key: `value:${element?.signature ?? ''}`,
              })),
              { source: 'goal_literal', start: 6, end: 11, text: 'hello' },
              { source: 'goal_span', start: 0, end: 4, text: 'Type' }
            );
          }
          for (const argument of tried) {
            const result = compileCommand({
              goal,
              observation,
              offers,
              capabilities,
              operation,
              ...(targetId === undefined ? {} : { targetId }),
              ...(argument === undefined ? {} : { argument }),
              inputRules: inputRules(leaves),
              resolvers: resolvers.map(item => ({ id: item.id, sensitive: item.sensitive })),
              origins: runOrigins,
            });
            const operationOffered = offers.operations.includes(operation);
            const targetOffered =
              targetId !== undefined && (offers.targets[operation] ?? []).includes(targetId);
            if (!result.ok) {
              if (
                argument !== undefined &&
                offered.has(JSON.stringify(argument)) &&
                operationOffered &&
                targetOffered
              ) {
                problems.push(`offered candidate rejected: ${operation} ${String(targetId)}`);
              }
              continue;
            }
            compiled += 1;
            if (!operationOffered) {
              problems.push(`operation not offered: ${operation}`);
            }
            if (operation === 'WAIT' && targetId !== undefined) {
              problems.push('WAIT compiled with a target');
            }
            if (operation !== 'WAIT' && operation !== 'SCROLL' && !targetOffered) {
              problems.push(`target not offered: ${operation} ${String(targetId)}`);
            }
            if (operation === 'SCROLL' && targetId !== undefined && !targetOffered) {
              problems.push(`scroll target not offered: ${String(targetId)}`);
            }
            const textual = argument?.source === 'goal_literal' || argument?.source === 'goal_span';
            if (element?.sensitive === true && textual) {
              problems.push('goal text compiled into a sensitive element');
            }
            if (spec?.slot === 'value' && argument !== undefined && !textual) {
              if (!offered.has(JSON.stringify(argument))) {
                problems.push(`compiled a value the builder withheld: ${JSON.stringify(argument)}`);
              }
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(compiled).toBeGreaterThan(500);
  });
});

describe('source hygiene of src/agent/commands.ts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'commands.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('uses no browser global, node module, console, any, interface or default export', () => {
    const forbidden = [
      /\bwindow\b/,
      /\bdocument\b/,
      /\bnavigator\b/,
      /\blocation\b/,
      /\bHTMLElement\b/,
      /\bElement\b/,
      /\bMutationObserver\b/,
      /\bgetComputedStyle\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\brequestAnimationFrame\b/,
      /from\s+['"]node:/,
      /\brequire\(/,
      /\bconsole\./,
      /:\s*any\b/,
      /\bas any\b/,
      /^\s*interface\s/m,
      /export\s+default/,
      /@ts-ignore/,
    ];
    for (const pattern of forbidden) {
      expect(code).not.toMatch(pattern);
    }
  });

  it('imports no executor module', () => {
    expect(code).not.toMatch(/from\s+['"]@\/actions/);
  });

  it('declares no exported type outside src/types', () => {
    expect(code).not.toMatch(/export\s+type\s/);
  });
});
