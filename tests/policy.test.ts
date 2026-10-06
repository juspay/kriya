/** @jest-environment node */
import {
  addRunGrants,
  allCommitmentsGranted,
  consumeGrants,
  createTaskPolicy,
  effectForCommitment,
  mergeEffects,
  normalizeAuthorization,
} from '@/agent/policy';
import {
  TASK_CLASSIFIED_OPERATIONS,
  TASK_COMMITMENT_CLASSES,
  TASK_COMMITMENT_EFFECT,
  TASK_COMMITMENT_EFFECTS,
  TASK_DEFAULT_RUN_GRANT_USES,
  TASK_EFFECTS,
  TASK_HOST_OPERATIONS,
  TASK_ROUTINE_EFFECTS,
} from '@/types';
import type {
  TaskAddRunGrantsFn,
  TaskAllCommitmentsGrantedFn,
  TaskAuthorization,
  TaskClassifyInput,
  TaskCommand,
  TaskCommitBasis,
  TaskCommitHint,
  TaskCommitmentClass,
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
  TaskPendingCommitment,
  TaskPolicy,
  TaskPolicyDecision,
  TaskPolicyInput,
} from '@/types';
import {
  FIXTURE_IDS,
  FIXTURE_ORIGIN,
  FIXTURE_START,
  FIXTURE_URL,
  makeCapabilities,
  makeCheckbox,
  makeCommand,
  makeElement,
  makeForm,
  makeLink,
  makeNormalizedAuthorization,
  makeObservation,
  makePassage,
  makeSelectField,
  makeSubmitButton,
  makeTextField,
  roundTrip,
  signatureFor,
} from './helpers/agent-fixtures';

export const seamConformance: {
  readonly createTaskPolicy: TaskCreatePolicyFn;
  readonly normalizeAuthorization: TaskNormalizeAuthorizationFn;
  readonly addRunGrants: TaskAddRunGrantsFn;
  readonly consumeGrants: TaskConsumeGrantsFn;
  readonly mergeEffects: TaskMergeEffectsFn;
  readonly effectForCommitment: TaskEffectForCommitmentFn;
  readonly allCommitmentsGranted: TaskAllCommitmentsGrantedFn;
} = {
  createTaskPolicy,
  normalizeAuthorization,
  addRunGrants,
  consumeGrants,
  mergeEffects,
  effectForCommitment,
  allCommitmentsGranted,
};

const DIGEST = `dg_${'a'.repeat(32)}`;
const OTHER_DIGEST = `dg_${'c'.repeat(32)}`;
const CONTEXT = `cx_${'b'.repeat(32)}`;
const OTHER_CONTEXT = `cx_${'d'.repeat(32)}`;
const OTHER_ORIGIN = 'https://partner.example.test';

type StructuralHintClass = Exclude<TaskCommitmentClass, 'NONE'>;

const hint = (hintClass: StructuralHintClass, basis: TaskCommitBasis): TaskCommitHint => ({
  class: hintClass,
  basis,
});

const withHints = (element: TaskElement, ...hints: readonly TaskCommitHint[]): TaskElement => ({
  ...element,
  commitHints: hints,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

const grant = (
  effect: TaskCommitmentEffect,
  overrides: Partial<TaskNormalizedGrant> = {}
): TaskNormalizedGrant => ({
  effect,
  origins: [FIXTURE_ORIGIN],
  maxUses: null,
  used: 0,
  expiresAt: null,
  signatures: null,
  ...overrides,
});

const authWith = (
  grants: readonly TaskNormalizedGrant[],
  overrides: Partial<TaskNormalizedAuthorization> = {}
): TaskNormalizedAuthorization => makeNormalizedAuthorization({ grants, ...overrides });

const commitmentOnly = (effects: readonly TaskEffectKind[]): readonly TaskCommitmentEffect[] =>
  effects.filter((effect): effect is TaskCommitmentEffect =>
    (TASK_COMMITMENT_EFFECTS as readonly string[]).includes(effect)
  );

const evaluateInput = (overrides: Partial<TaskPolicyInput> = {}): TaskPolicyInput => ({
  command: makeCommand('CLICK'),
  effects: ['interact'],
  digest: DIGEST,
  snapshotId: FIXTURE_IDS.snapshot,
  documentId: FIXTURE_IDS.document,
  pageUrl: FIXTURE_URL,
  now: FIXTURE_START,
  contextDigest: CONTEXT,
  authorization: makeNormalizedAuthorization(),
  pendingCommitments: [],
  ...overrides,
});

function asAllow(decision: TaskPolicyDecision): Extract<TaskPolicyDecision, { verdict: 'allow' }> {
  if (decision.verdict !== 'allow') {
    throw new Error(`expected allow, got ${JSON.stringify(decision)}`);
  }
  return decision;
}

const policy: TaskPolicy = createTaskPolicy();

const classifyWith = (
  target: TaskPolicy,
  command: TaskCommand,
  element: TaskElement | undefined,
  forms: readonly TaskForm[] = []
) =>
  target.classify({
    command,
    ...(element === undefined ? {} : { element }),
    observation: makeObservation({ elements: element === undefined ? [] : [element], forms }),
  });

const press = (key: TaskKey): TaskCommand => makeCommand('PRESS', { key });

const implicitForm = makeForm({ implicitSubmit: true });

describe('structural classification (section 9 table)', () => {
  type Case = {
    readonly name: string;
    readonly command: TaskCommand;
    readonly element?: TaskElement;
    readonly forms?: readonly TaskForm[];
    readonly effects: readonly TaskEffectKind[];
  };

  const plainForm = makeForm({ implicitSubmit: false });
  const fieldInForm = makeTextField({ formId: 'f1' });
  const implicitField = withHints(
    makeTextField({ formId: 'f1' }),
    hint('FORM_SUBMIT', 'implicit_submit_field')
  );
  const submitControl = makeSubmitButton();

  const cases: readonly Case[] = [
    { name: 'READ', command: makeCommand('READ'), element: makePassage(), effects: ['read'] },
    {
      name: 'READ ignores a declared marker',
      command: makeCommand('READ'),
      element: withHints(makePassage(), hint('DELETE', 'declared_marker')),
      effects: ['read'],
    },
    {
      name: 'NAVIGATE a plain link',
      command: makeCommand('NAVIGATE'),
      element: makeLink(),
      effects: ['navigate'],
    },
    {
      name: 'NAVIGATE a link with a declared marker',
      command: makeCommand('NAVIGATE'),
      element: withHints(makeLink(), hint('DELETE', 'declared_marker')),
      effects: ['navigate', 'delete'],
    },
    {
      name: 'NAVIGATE ignores submit_control and implicit_submit_field hints',
      command: makeCommand('NAVIGATE'),
      element: withHints(
        makeLink(),
        hint('FORM_SUBMIT', 'submit_control'),
        hint('FORM_SUBMIT', 'implicit_submit_field')
      ),
      effects: ['navigate'],
    },
    {
      name: 'CLICK a plain button',
      command: makeCommand('CLICK'),
      element: makeElement(),
      effects: ['interact'],
    },
    {
      name: 'CLICK with a declared marker',
      command: makeCommand('CLICK'),
      element: withHints(makeElement(), hint('PURCHASE', 'declared_marker')),
      effects: ['interact', 'purchase'],
    },
    {
      name: 'CLICK on a submit control gets form_submit',
      command: makeCommand('CLICK'),
      element: submitControl,
      effects: ['interact', 'form_submit'],
    },
    {
      name: 'CLICK ignores an implicit_submit_field hint',
      command: makeCommand('CLICK'),
      element: withHints(makeElement(), hint('FORM_SUBMIT', 'implicit_submit_field')),
      effects: ['interact'],
    },
    {
      name: 'two hints on one element merge in canonical order',
      command: makeCommand('CLICK'),
      element: withHints(
        makeElement(),
        hint('DELETE', 'declared_marker'),
        hint('PURCHASE', 'declared_marker')
      ),
      effects: ['interact', 'purchase', 'delete'],
    },
    {
      name: 'SUBMIT on a submit control',
      command: makeCommand('SUBMIT'),
      element: submitControl,
      effects: ['form_submit'],
    },
    {
      name: 'SUBMIT is always form_submit, even without a hint',
      command: makeCommand('SUBMIT'),
      element: makeElement({ operations: ['SUBMIT'] }),
      effects: ['form_submit'],
    },
    {
      name: 'SUBMIT adds every hint class',
      command: makeCommand('SUBMIT'),
      element: withHints(
        makeSubmitButton(),
        hint('FORM_SUBMIT', 'submit_control'),
        hint('FORM_SUBMIT', 'implicit_submit_field'),
        hint('SEND', 'declared_marker'),
        hint('PUBLISH', 'implicit_submit_field')
      ),
      effects: ['form_submit', 'publish', 'send'],
    },
    {
      name: 'FILL a field',
      command: makeCommand('FILL'),
      element: makeTextField(),
      effects: ['input'],
    },
    {
      name: 'FILL a field with a declared marker',
      command: makeCommand('FILL'),
      element: withHints(makeTextField(), hint('SEND', 'declared_marker')),
      effects: ['input', 'send'],
    },
    {
      name: 'FILL ignores submit_control and implicit hints',
      command: makeCommand('FILL'),
      element: implicitField,
      effects: ['input'],
    },
    {
      name: 'SELECT a select',
      command: makeCommand('SELECT'),
      element: makeSelectField(),
      effects: ['select'],
    },
    {
      name: 'SELECT with a declared marker on a select',
      command: makeCommand('SELECT'),
      element: withHints(makeSelectField(), hint('PURCHASE', 'declared_marker')),
      effects: ['select', 'purchase'],
    },
    {
      name: 'SET_CHECKED a checkbox',
      command: makeCommand('SET_CHECKED'),
      element: makeCheckbox(),
      effects: ['toggle'],
    },
    {
      name: 'SET_CHECKED a switch with a declared marker',
      command: makeCommand('SET_CHECKED'),
      element: withHints(
        makeCheckbox({ role: 'switch', kind: 'switch' }),
        hint('ACCOUNT_CHANGE', 'declared_marker')
      ),
      effects: ['toggle', 'account_change'],
    },
    {
      name: 'PRESS Enter in a field with an implicit_submit_field hint',
      command: press('Enter'),
      element: implicitField,
      effects: ['interact', 'form_submit'],
    },
    {
      name: 'PRESS Enter in a field of an implicit-submit form (no hint)',
      command: press('Enter'),
      element: fieldInForm,
      forms: [implicitForm],
      effects: ['interact', 'form_submit'],
    },
    {
      name: 'PRESS Enter in a field of a form without implicit submit',
      command: press('Enter'),
      element: fieldInForm,
      forms: [plainForm],
      effects: ['interact'],
    },
    {
      name: 'PRESS Enter in a field whose form is not in the observation',
      command: press('Enter'),
      element: fieldInForm,
      forms: [],
      effects: ['interact'],
    },
    {
      name: 'PRESS Enter in a field without a form',
      command: press('Enter'),
      element: makeTextField(),
      effects: ['interact'],
    },
    {
      name: 'PRESS Enter on a submit control',
      command: press('Enter'),
      element: submitControl,
      effects: ['interact', 'form_submit'],
    },
    {
      name: 'PRESS Enter with a declared marker',
      command: press('Enter'),
      element: withHints(makeTextField(), hint('DELETE', 'declared_marker')),
      effects: ['interact', 'delete'],
    },
    {
      name: 'PRESS Enter with implicit hint and a declared marker',
      command: press('Enter'),
      element: withHints(
        makeTextField({ formId: 'f1' }),
        hint('FORM_SUBMIT', 'implicit_submit_field'),
        hint('SEND', 'declared_marker')
      ),
      effects: ['interact', 'form_submit', 'send'],
    },
    {
      name: 'PRESS Space on a submit control activates it',
      command: press('Space'),
      element: submitControl,
      effects: ['interact', 'form_submit'],
    },
    {
      name: 'PRESS Space in an implicit-submit field is not a submit',
      command: press('Space'),
      element: implicitField,
      effects: ['interact'],
    },
    {
      name: 'PRESS Space in a field of an implicit-submit form is not a submit',
      command: press('Space'),
      element: fieldInForm,
      forms: [implicitForm],
      effects: ['interact'],
    },
    {
      name: 'PRESS Space with a submit control and a declared marker',
      command: press('Space'),
      element: withHints(
        makeSubmitButton(),
        hint('FORM_SUBMIT', 'submit_control'),
        hint('DELETE', 'declared_marker')
      ),
      effects: ['interact', 'form_submit', 'delete'],
    },
    {
      name: 'PRESS Tab on a submit control',
      command: press('Tab'),
      element: submitControl,
      effects: ['interact'],
    },
    {
      name: 'PRESS Tab with a declared marker',
      command: press('Tab'),
      element: withHints(makeTextField(), hint('DELETE', 'declared_marker')),
      effects: ['interact', 'delete'],
    },
    {
      name: 'PRESS ArrowDown with a declared marker',
      command: press('ArrowDown'),
      element: withHints(makeTextField(), hint('PURCHASE', 'declared_marker')),
      effects: ['interact', 'purchase'],
    },
    {
      name: 'PRESS Escape in an implicit-submit field',
      command: press('Escape'),
      element: implicitField,
      effects: ['interact'],
    },
    { name: 'SCROLL', command: makeCommand('SCROLL'), effects: ['scroll'] },
    { name: 'WAIT', command: makeCommand('WAIT'), effects: ['wait'] },
  ];

  it.each(cases)('$name', ({ command, element, forms, effects }) => {
    expect(classifyWith(policy, command, element, forms).effects).toEqual(effects);
  });

  it('reports exactly the hints that contributed', () => {
    const element = withHints(
      makeSubmitButton(),
      hint('DELETE', 'declared_marker'),
      hint('FORM_SUBMIT', 'submit_control'),
      hint('PURCHASE', 'implicit_submit_field')
    );
    expect(classifyWith(policy, makeCommand('CLICK'), element).hints).toEqual([
      hint('DELETE', 'declared_marker'),
      hint('FORM_SUBMIT', 'submit_control'),
    ]);
    expect(classifyWith(policy, makeCommand('SUBMIT'), element).hints).toEqual([
      hint('DELETE', 'declared_marker'),
      hint('FORM_SUBMIT', 'submit_control'),
      hint('PURCHASE', 'implicit_submit_field'),
    ]);
    expect(classifyWith(policy, makeCommand('READ'), element).hints).toEqual([]);
    expect(classifyWith(policy, makeCommand('WAIT'), undefined).hints).toEqual([]);
  });

  it('reports the implicit_submit_field hint when Enter uses it', () => {
    const element = withHints(
      makeTextField({ formId: 'f1' }),
      hint('FORM_SUBMIT', 'implicit_submit_field')
    );
    expect(classifyWith(policy, press('Enter'), element).hints).toEqual([
      hint('FORM_SUBMIT', 'implicit_submit_field'),
    ]);
    expect(classifyWith(policy, press('Space'), element).hints).toEqual([]);
  });

  it('classifies a command without an element structurally', () => {
    expect(classifyWith(policy, makeCommand('CLICK'), undefined).effects).toEqual(['interact']);
    expect(classifyWith(policy, makeCommand('SUBMIT'), undefined).effects).toEqual(['form_submit']);
    expect(classifyWith(policy, press('Enter'), undefined).effects).toEqual(['interact']);
  });

  it('never returns a non-canonical or duplicated effect list', () => {
    const element = withHints(
      makeSubmitButton(),
      hint('FORM_SUBMIT', 'submit_control'),
      hint('FORM_SUBMIT', 'declared_marker'),
      hint('FORM_SUBMIT', 'implicit_submit_field')
    );
    const { effects } = classifyWith(policy, makeCommand('SUBMIT'), element);
    expect(effects).toEqual(['form_submit']);
  });

  it('is pure: frozen inputs are accepted and a result is JSON-safe', () => {
    const element = deepFreeze(
      withHints(makeTextField({ formId: 'f1' }), hint('SEND', 'declared_marker'))
    );
    const input: TaskClassifyInput = deepFreeze({
      command: press('Enter'),
      element,
      observation: makeObservation({ elements: [element], forms: [implicitForm] }),
    });
    const result = policy.classify(input);
    expect(roundTrip(result)).toEqual(result);
    expect(result.effects).toEqual(['interact', 'form_submit', 'send']);
  });

  it('fails closed and never throws on a malformed input', () => {
    const garbage = { command: { operation: 'CLICK' } } as unknown as TaskClassifyInput;
    let result: ReturnType<TaskPolicy['classify']> | undefined;
    expect(() => {
      result = policy.classify(garbage);
    }).not.toThrow();
    expect(commitmentOnly(result?.effects ?? []).length).toBeGreaterThan(0);
    expect(result?.classifierError).toBe(true);
    expect(() => policy.classify(null as unknown as TaskClassifyInput)).not.toThrow();
  });
});

describe('needsClassification and classifyOperations', () => {
  const needs = (target: TaskPolicy, operation: TaskHostOperation): boolean => {
    const commands: Readonly<Record<TaskHostOperation, TaskCommand>> = {
      READ: makeCommand('READ'),
      CLICK: makeCommand('CLICK'),
      NAVIGATE: makeCommand('NAVIGATE'),
      FILL: makeCommand('FILL'),
      SELECT: makeCommand('SELECT'),
      SET_CHECKED: makeCommand('SET_CHECKED'),
      PRESS: makeCommand('PRESS'),
      SCROLL: makeCommand('SCROLL'),
      WAIT: makeCommand('WAIT'),
      SUBMIT: makeCommand('SUBMIT'),
    };
    return classifyWith(target, commands[operation], undefined).needsClassification;
  };

  it('defaults to TASK_CLASSIFIED_OPERATIONS', () => {
    for (const operation of TASK_HOST_OPERATIONS) {
      expect(needs(policy, operation)).toBe(
        (TASK_CLASSIFIED_OPERATIONS as readonly string[]).includes(operation)
      );
    }
    expect(needs(policy, 'FILL')).toBe(false);
    expect(needs(policy, 'READ')).toBe(false);
    expect(needs(policy, 'SCROLL')).toBe(false);
    expect(needs(policy, 'WAIT')).toBe(false);
  });

  it('honors a custom classifyOperations list', () => {
    const custom = createTaskPolicy({ classifyOperations: ['CLICK', 'FILL'] });
    for (const operation of TASK_HOST_OPERATIONS) {
      expect(needs(custom, operation)).toBe(operation === 'CLICK' || operation === 'FILL');
    }
    const none = createTaskPolicy({ classifyOperations: [] });
    for (const operation of TASK_HOST_OPERATIONS) {
      expect(needs(none, operation)).toBe(false);
    }
  });

  it('keeps structural effects and declared markers for operations outside the list', () => {
    const narrow = createTaskPolicy({ classifyOperations: ['CLICK'] });
    const marked = withHints(makeTextField({ formId: 'f1' }), hint('SEND', 'declared_marker'));
    expect(classifyWith(narrow, press('Enter'), marked, [makeForm()]).effects).toEqual([
      'interact',
      'form_submit',
      'send',
    ]);
    expect(classifyWith(narrow, makeCommand('SUBMIT'), makeSubmitButton()).effects).toEqual([
      'form_submit',
    ]);
    expect(
      classifyWith(
        narrow,
        makeCommand('FILL'),
        withHints(makeTextField(), hint('SEND', 'declared_marker'))
      ).effects
    ).toEqual(['input', 'send']);
  });
});

describe('promoteEffects', () => {
  const promoting = createTaskPolicy({
    promoteEffects: { toggle: 'account_change', navigate: 'other_commitment' },
  });

  it('turns a promoted routine effect into its commitment effect', () => {
    expect(classifyWith(promoting, makeCommand('SET_CHECKED'), makeCheckbox()).effects).toEqual([
      'account_change',
    ]);
    expect(classifyWith(promoting, makeCommand('NAVIGATE'), makeLink()).effects).toEqual([
      'other_commitment',
    ]);
  });

  it('leaves unpromoted routine effects alone', () => {
    expect(classifyWith(promoting, makeCommand('CLICK'), makeElement()).effects).toEqual([
      'interact',
    ]);
    expect(classifyWith(promoting, makeCommand('READ'), makePassage()).effects).toEqual(['read']);
    expect(classifyWith(promoting, makeCommand('FILL'), makeTextField()).effects).toEqual([
      'input',
    ]);
  });

  it('merges a promoted effect with hint effects', () => {
    const marked = withHints(makeLink(), hint('DELETE', 'declared_marker'));
    expect(classifyWith(promoting, makeCommand('NAVIGATE'), marked).effects).toEqual([
      'delete',
      'other_commitment',
    ]);
  });

  it('can promote every routine effect', () => {
    const everything = createTaskPolicy({
      promoteEffects: Object.fromEntries(
        TASK_ROUTINE_EFFECTS.map(effect => [effect, 'other_commitment' as const])
      ),
    });
    expect(classifyWith(everything, makeCommand('WAIT'), undefined).effects).toEqual([
      'other_commitment',
    ]);
    expect(classifyWith(everything, makeCommand('READ'), makePassage()).effects).toEqual([
      'other_commitment',
    ]);
  });
});

describe('classify hook', () => {
  const hooked = (
    result: TaskCommitmentClass | null | (() => never) | string
  ): { readonly policy: TaskPolicy; readonly calls: TaskClassifyInput[] } => {
    const calls: TaskClassifyInput[] = [];
    const hookPolicy = createTaskPolicy({
      classify: input => {
        calls.push(input);
        if (typeof result === 'function') {
          return result();
        }
        return result as TaskCommitmentClass | null;
      },
    });
    return { policy: hookPolicy, calls };
  };

  it('adds the class its effect names', () => {
    const { policy: target, calls } = hooked('PURCHASE');
    const element = makeElement();
    const result = classifyWith(target, makeCommand('CLICK'), element);
    expect(result.effects).toEqual(['interact', 'purchase']);
    expect(result.classifierError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual(makeCommand('CLICK'));
    expect(calls[0]?.element).toEqual(element);
    expect(calls[0]?.observation.elements).toEqual([element]);
  });

  it('maps every non-NONE class to its commitment effect', () => {
    for (const commitmentClass of TASK_COMMITMENT_CLASSES) {
      if (commitmentClass === 'NONE') {
        continue;
      }
      const { policy: target } = hooked(commitmentClass);
      expect(classifyWith(target, makeCommand('CLICK'), makeElement()).effects).toContain(
        TASK_COMMITMENT_EFFECT[commitmentClass]
      );
    }
  });

  it('adds nothing for NONE or null', () => {
    for (const answer of ['NONE', null] as const) {
      const { policy: target } = hooked(answer);
      const result = classifyWith(target, makeCommand('CLICK'), makeElement());
      expect(result.effects).toEqual(['interact']);
      expect(result.classifierError).toBe(false);
    }
  });

  it('turns a throwing hook into other_commitment and classifierError', () => {
    const { policy: target, calls } = hooked(() => {
      throw new Error('boom');
    });
    const result = classifyWith(target, makeCommand('CLICK'), makeElement());
    expect(calls).toHaveLength(1);
    expect(result.classifierError).toBe(true);
    expect(result.effects).toEqual(['interact', 'other_commitment']);
  });

  it('treats an unknown class from the hook as a classifier error', () => {
    const { policy: target } = hooked('PRETEND');
    const result = classifyWith(target, makeCommand('CLICK'), makeElement());
    expect(result.classifierError).toBe(true);
    expect(result.effects).toContain('other_commitment');
  });

  it('merges the hook effect with structural and promoted effects', () => {
    const calls: TaskClassifyInput[] = [];
    const target = createTaskPolicy({
      classify: input => {
        calls.push(input);
        return 'DELETE';
      },
      promoteEffects: { select: 'account_change' },
    });
    const result = classifyWith(
      target,
      makeCommand('SELECT'),
      withHints(makeSelectField(), hint('PURCHASE', 'declared_marker'))
    );
    expect(result.effects).toEqual(['purchase', 'delete', 'account_change']);
  });

  it('only runs for operations in classifyOperations', () => {
    const calls: TaskClassifyInput[] = [];
    const target = createTaskPolicy({
      classify: input => {
        calls.push(input);
        return 'PURCHASE';
      },
    });
    for (const command of [
      makeCommand('FILL'),
      makeCommand('READ'),
      makeCommand('SCROLL'),
      makeCommand('WAIT'),
    ]) {
      const result = classifyWith(target, command, undefined);
      expect(commitmentOnly(result.effects)).toEqual([]);
    }
    expect(calls).toHaveLength(0);
    classifyWith(target, makeCommand('NAVIGATE'), makeLink());
    classifyWith(target, makeCommand('SET_CHECKED'), makeCheckbox());
    expect(calls).toHaveLength(2);
  });

  it('runs for a custom classifyOperations entry such as FILL', () => {
    const target = createTaskPolicy({
      classifyOperations: ['FILL'],
      classify: () => 'SEND',
    });
    expect(classifyWith(target, makeCommand('FILL'), makeTextField()).effects).toEqual([
      'input',
      'send',
    ]);
    expect(classifyWith(target, makeCommand('CLICK'), makeElement()).effects).toEqual(['interact']);
  });
});

describe('evaluate: rows 1 to 4 (operation, origin, scheme)', () => {
  const grantAll = authWith(TASK_COMMITMENT_EFFECTS.map(effect => grant(effect)));

  it('row 1: denies an operation outside authorization.operations, even with grants and approvals', () => {
    const authorization = authWith(grantAll.grants, { operations: ['READ'] });
    const cases: readonly Partial<TaskPolicyInput>[] = [
      {},
      { effects: ['interact', 'purchase'] },
      { approvedOnce: { approvalId: 'apr_000000000001', digest: DIGEST, contextDigest: CONTEXT } },
    ];
    for (const overrides of cases) {
      expect(policy.evaluate(evaluateInput({ authorization, ...overrides }))).toEqual({
        verdict: 'deny',
        effects: overrides.effects ?? ['interact'],
        reason: 'operation_not_allowed',
      });
    }
  });

  it('row 1 positive control: the same command passes when its operation is listed', () => {
    const decision = policy.evaluate(
      evaluateInput({ authorization: authWith([], { operations: ['CLICK'] }) })
    );
    expect(decision.verdict).toBe('allow');
  });

  it('row 2: denies a page origin outside authorization.origins, even with grants and approvals', () => {
    const decision = policy.evaluate(
      evaluateInput({
        pageUrl: `${OTHER_ORIGIN}/cart`,
        effects: ['interact', 'purchase'],
        authorization: grantAll,
        approvedOnce: { approvalId: 'apr_000000000001', digest: DIGEST, contextDigest: CONTEXT },
      })
    );
    expect(decision).toEqual({
      verdict: 'deny',
      effects: ['interact', 'purchase'],
      reason: 'origin_not_allowed',
    });
  });

  it('row 2: accepts any listed origin and compares exact origins', () => {
    const authorization = authWith([], { origins: [FIXTURE_ORIGIN, OTHER_ORIGIN] });
    expect(
      policy.evaluate(evaluateInput({ authorization, pageUrl: `${OTHER_ORIGIN}/x?y=1#z` })).verdict
    ).toBe('allow');
    for (const pageUrl of [
      'http://shop.example.test/cart',
      'https://shop.example.test:8443/cart',
      'https://sub.shop.example.test/cart',
      'https://example.test/cart',
    ]) {
      expect(policy.evaluate(evaluateInput({ pageUrl })).reason).toBe('origin_not_allowed');
    }
  });

  it('row 2: denies an unparseable or opaque page url', () => {
    for (const pageUrl of ['', 'not a url', 'about:blank', 'data:text/html,hi', 'javascript:1']) {
      expect(policy.evaluate(evaluateInput({ pageUrl }))).toMatchObject({
        verdict: 'deny',
        reason: 'origin_not_allowed',
      });
    }
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://shop.example.test/f',
    'blob:https://shop.example.test/x',
    'mailto:a@b.c',
  ])('row 3: denies the href %s for any operation', href => {
    for (const command of [makeCommand('NAVIGATE'), makeCommand('CLICK'), makeCommand('READ')]) {
      const decision = policy.evaluate(
        evaluateInput({ command, effects: ['read'], element: makeLink({ href }) })
      );
      expect(decision).toEqual({
        verdict: 'deny',
        effects: ['read'],
        reason: 'scheme_not_allowed',
      });
    }
  });

  it('row 3: denies an unparseable href (fail closed)', () => {
    const decision = policy.evaluate(
      evaluateInput({ element: makeLink({ href: '::::' }), command: makeCommand('NAVIGATE') })
    );
    expect(decision).toMatchObject({ verdict: 'deny', reason: 'scheme_not_allowed' });
  });

  it('row 3: denies a non-http formTarget for any operation', () => {
    const element = makeSubmitButton({
      formTarget: { action: 'javascript:void(0)', method: 'POST' },
    });
    for (const command of [makeCommand('FILL'), makeCommand('SUBMIT'), makeCommand('READ')]) {
      expect(policy.evaluate(evaluateInput({ command, element })).reason).toBe(
        'scheme_not_allowed'
      );
    }
  });

  it('row 3: denies a non-http form action for SUBMIT, PRESS and CLICK only', () => {
    const form = makeForm({ action: 'javascript:void(0)' });
    const element = makeTextField({ formId: 'f1' });
    for (const command of [makeCommand('SUBMIT'), makeCommand('PRESS'), makeCommand('CLICK')]) {
      expect(policy.evaluate(evaluateInput({ command, element, form }))).toMatchObject({
        verdict: 'deny',
        reason: 'scheme_not_allowed',
      });
    }
    for (const command of [
      makeCommand('FILL'),
      makeCommand('SELECT'),
      makeCommand('SET_CHECKED'),
    ]) {
      expect(
        policy.evaluate(evaluateInput({ command, element, form, effects: ['input'] })).verdict
      ).toBe('allow');
    }
  });

  it('row 3: allows an http link when its origin is authorized', () => {
    const authorization = authWith([], {
      origins: [FIXTURE_ORIGIN, 'http://shop.example.test'],
    });
    const decision = policy.evaluate(
      evaluateInput({
        authorization,
        command: makeCommand('NAVIGATE'),
        effects: ['navigate'],
        element: makeLink({ href: 'http://shop.example.test/help' }),
      })
    );
    expect(decision.verdict).toBe('allow');
  });

  it('row 4: denies a cross-origin href for any operation and compares exact origins', () => {
    for (const href of [
      `${OTHER_ORIGIN}/x`,
      'http://shop.example.test/help',
      'https://shop.example.test:8443/help',
      'https://evil.shop.example.test/help',
    ]) {
      const decision = policy.evaluate(
        evaluateInput({
          command: makeCommand('NAVIGATE'),
          effects: ['navigate'],
          element: makeLink({ href }),
        })
      );
      expect(decision).toEqual({
        verdict: 'deny',
        effects: ['navigate'],
        reason: 'origin_not_allowed',
      });
    }
    expect(
      policy.evaluate(
        evaluateInput({
          command: makeCommand('NAVIGATE'),
          effects: ['navigate'],
          element: makeLink({ href: `${FIXTURE_ORIGIN}/other/path?q=1#frag` }),
        })
      ).verdict
    ).toBe('allow');
  });

  it('row 4: denies a cross-origin formTarget regardless of operation', () => {
    const element = makeSubmitButton({
      formTarget: { action: `${OTHER_ORIGIN}/collect`, method: 'POST' },
    });
    for (const command of [makeCommand('SUBMIT'), makeCommand('CLICK'), makeCommand('FILL')]) {
      expect(policy.evaluate(evaluateInput({ command, element })).reason).toBe(
        'origin_not_allowed'
      );
    }
  });

  it('row 4: a script click in a form with a foreign action is denied (SUBMIT, PRESS, CLICK)', () => {
    const form = makeForm({ action: `${OTHER_ORIGIN}/collect` });
    const element = makeElement({ formId: 'f1' });
    for (const command of [makeCommand('CLICK'), makeCommand('SUBMIT'), makeCommand('PRESS')]) {
      expect(policy.evaluate(evaluateInput({ command, element, form }))).toEqual({
        verdict: 'deny',
        effects: ['interact'],
        reason: 'origin_not_allowed',
      });
    }
    expect(
      policy.evaluate(
        evaluateInput({ command: makeCommand('FILL'), element, form, effects: ['input'] })
      ).verdict
    ).toBe('allow');
  });

  it('row 4: a cross-origin destination is never covered by a grant or an approval', () => {
    const element = makeSubmitButton({
      formTarget: { action: `${OTHER_ORIGIN}/pay`, method: 'POST' },
    });
    const decision = policy.evaluate(
      evaluateInput({
        command: makeCommand('SUBMIT'),
        effects: ['form_submit', 'purchase'],
        element,
        authorization: grantAll,
        approvedOnce: { approvalId: 'apr_000000000001', digest: DIGEST, contextDigest: CONTEXT },
      })
    );
    expect(decision).toMatchObject({ verdict: 'deny', reason: 'origin_not_allowed' });
  });

  it('row 3 outranks row 4, and rows 1 to 2 outrank rows 3 to 4', () => {
    const both = makeElement({
      href: `${OTHER_ORIGIN}/x`,
      formTarget: { action: 'javascript:1', method: 'GET' },
    });
    expect(policy.evaluate(evaluateInput({ element: both })).reason).toBe('scheme_not_allowed');
    const mixedHref = makeLink({ href: `${OTHER_ORIGIN}/x` });
    const javascriptForm = makeForm({ action: 'javascript:1' });
    expect(
      policy.evaluate(evaluateInput({ element: mixedHref, form: javascriptForm })).reason
    ).toBe('scheme_not_allowed');
    expect(
      policy.evaluate(
        evaluateInput({
          element: both,
          pageUrl: `${OTHER_ORIGIN}/`,
          authorization: authWith([], { origins: [FIXTURE_ORIGIN] }),
        })
      ).reason
    ).toBe('origin_not_allowed');
    expect(
      policy.evaluate(
        evaluateInput({
          element: both,
          authorization: authWith([], { operations: ['READ'] }),
        })
      ).reason
    ).toBe('operation_not_allowed');
  });
});

describe('evaluate: rows 5 and 6 (routine, approvedOnce)', () => {
  it('row 5: a command without a commitment effect is allowed with no grants', () => {
    for (const effects of [
      ['read'],
      ['interact'],
      ['navigate', 'input'],
      ['toggle', 'select', 'scroll', 'wait'],
      [],
    ] satisfies readonly TaskEffectKind[][]) {
      expect(policy.evaluate(evaluateInput({ effects }))).toEqual({
        verdict: 'allow',
        effects,
        reason: 'routine',
        grants: [],
      });
    }
  });

  it('row 5 outranks a pending commitment and ignores grants', () => {
    const pending: TaskPendingCommitment = {
      seq: 1,
      digest: OTHER_DIGEST,
      effects: ['form_submit'],
      signature: signatureFor('t1'),
      documentId: FIXTURE_IDS.document,
    };
    const decision = policy.evaluate(
      evaluateInput({
        pendingCommitments: [pending],
        authorization: authWith([grant('purchase')]),
      })
    );
    expect(decision).toMatchObject({ verdict: 'allow', reason: 'routine', grants: [] });
  });

  const approved = { approvalId: 'apr_000000000001', digest: DIGEST, contextDigest: CONTEXT };

  it('row 6: the exact digest and context digest are allowed once, consuming no grant', () => {
    const decision = policy.evaluate(
      evaluateInput({ effects: ['interact', 'delete'], approvedOnce: approved })
    );
    expect(decision).toEqual({
      verdict: 'allow',
      effects: ['interact', 'delete'],
      reason: 'approved_once',
      grants: [],
    });
  });

  it('row 6: a different digest or a different context digest is not approved', () => {
    for (const approvedOnce of [
      { ...approved, digest: OTHER_DIGEST },
      { ...approved, contextDigest: OTHER_CONTEXT },
      { ...approved, digest: OTHER_DIGEST, contextDigest: OTHER_CONTEXT },
    ]) {
      expect(policy.evaluate(evaluateInput({ effects: ['delete'], approvedOnce }))).toEqual({
        verdict: 'require_approval',
        effects: ['delete'],
        missing: ['delete'],
        reason: 'commitment_not_granted',
      });
    }
  });

  it('row 6: the snapshot id is informational and not part of the binding', () => {
    const decision = policy.evaluate(
      evaluateInput({
        effects: ['delete'],
        snapshotId: 'snap_00000000ffff',
        approvedOnce: approved,
      })
    );
    expect(decision).toMatchObject({ verdict: 'allow', reason: 'approved_once' });
  });

  it('row 6: an approval outranks onUnauthorized deny', () => {
    const denying = createTaskPolicy({ onUnauthorized: 'deny' });
    expect(
      denying.evaluate(evaluateInput({ effects: ['delete'], approvedOnce: approved }))
    ).toMatchObject({ verdict: 'allow', reason: 'approved_once' });
  });

  it('row 6: an approval outranks a pending uncertain commitment for the exact context', () => {
    const pending: TaskPendingCommitment = {
      seq: 2,
      digest: OTHER_DIGEST,
      effects: ['delete'],
      documentId: FIXTURE_IDS.document,
      signature: signatureFor('t1'),
    };
    const element = makeElement();
    expect(
      policy.evaluate(
        evaluateInput({
          effects: ['delete'],
          element,
          pendingCommitments: [pending],
          approvedOnce: approved,
        })
      )
    ).toMatchObject({ verdict: 'allow', reason: 'approved_once' });
  });

  it('row 6 never overrides rows 1 to 4', () => {
    expect(
      policy.evaluate(
        evaluateInput({
          effects: ['delete'],
          approvedOnce: approved,
          authorization: authWith([], { operations: ['READ'] }),
        })
      ).reason
    ).toBe('operation_not_allowed');
  });
});

describe('evaluate: row 7 (pending uncertain commitments)', () => {
  const element = makeSubmitButton();
  const pendingSubmit: TaskPendingCommitment = {
    seq: 3,
    digest: OTHER_DIGEST,
    effects: ['form_submit'],
    signature: element.signature,
    formId: 'f1',
    documentId: FIXTURE_IDS.document,
  };
  const submitInput = (overrides: Partial<TaskPolicyInput> = {}): TaskPolicyInput =>
    evaluateInput({
      command: makeCommand('SUBMIT'),
      effects: ['form_submit'],
      element,
      ...overrides,
    });

  it('requires approval when the same signature shares a commitment effect', () => {
    expect(policy.evaluate(submitInput({ pendingCommitments: [pendingSubmit] }))).toEqual({
      verdict: 'require_approval',
      effects: ['form_submit'],
      missing: ['form_submit'],
      reason: 'uncertain_commitment_pending',
    });
  });

  it('a standing grant never covers a pending commitment', () => {
    expect(
      policy.evaluate(
        submitInput({
          pendingCommitments: [pendingSubmit],
          authorization: authWith([grant('form_submit')]),
        })
      )
    ).toMatchObject({ verdict: 'require_approval', reason: 'uncertain_commitment_pending' });
  });

  it('denies instead under onUnauthorized deny', () => {
    const denying = createTaskPolicy({ onUnauthorized: 'deny' });
    expect(denying.evaluate(submitInput({ pendingCommitments: [pendingSubmit] }))).toEqual({
      verdict: 'deny',
      effects: ['form_submit'],
      reason: 'commitment_not_granted',
    });
  });

  it('an uncertain SUBMIT followed by Enter in the same form is not executed', () => {
    const field = makeTextField({ formId: 'f1' });
    const decision = policy.evaluate(
      evaluateInput({
        command: makeCommand('PRESS', { key: 'Enter' }),
        effects: ['interact', 'form_submit'],
        element: field,
        form: makeForm(),
        pendingCommitments: [{ ...pendingSubmit, signature: signatureFor('other') }],
        authorization: authWith([grant('form_submit')]),
      })
    );
    expect(decision).toEqual({
      verdict: 'require_approval',
      effects: ['interact', 'form_submit'],
      missing: ['form_submit'],
      reason: 'uncertain_commitment_pending',
    });
  });

  it('matches by form only inside the current document', () => {
    const elsewhere = {
      ...pendingSubmit,
      signature: signatureFor('other'),
      documentId: 'doc_00000000beef',
    };
    expect(policy.evaluate(submitInput({ pendingCommitments: [elsewhere] }))).toMatchObject({
      verdict: 'require_approval',
      reason: 'commitment_not_granted',
    });
    expect(
      policy.evaluate(
        submitInput({
          pendingCommitments: [elsewhere],
          authorization: authWith([grant('form_submit')]),
        })
      )
    ).toMatchObject({ verdict: 'allow', reason: 'granted' });
  });

  it('matches by signature even when the document differs', () => {
    const { formId: _formId, ...withoutForm } = pendingSubmit;
    const otherDocument: TaskPendingCommitment = { ...withoutForm, documentId: 'doc_00000000beef' };
    expect(
      policy.evaluate(
        submitInput({
          pendingCommitments: [otherDocument],
          authorization: authWith([grant('form_submit')]),
        })
      )
    ).toMatchObject({ verdict: 'require_approval', reason: 'uncertain_commitment_pending' });
  });

  it('does not match another signature in another form, or a different effect', () => {
    const unrelated: TaskPendingCommitment = {
      ...pendingSubmit,
      signature: signatureFor('zz'),
      formId: 'f9',
    };
    const differentEffect: TaskPendingCommitment = { ...pendingSubmit, effects: ['delete'] };
    const authorization = authWith([grant('form_submit')]);
    expect(
      policy.evaluate(submitInput({ pendingCommitments: [unrelated], authorization })).reason
    ).toBe('granted');
    expect(
      policy.evaluate(submitInput({ pendingCommitments: [differentEffect], authorization })).reason
    ).toBe('granted');
  });

  it('does not match a pending commitment that has neither signature nor form for a bare command', () => {
    const anonymous: TaskPendingCommitment = {
      seq: 1,
      digest: OTHER_DIGEST,
      effects: ['form_submit'],
      documentId: FIXTURE_IDS.document,
    };
    expect(
      policy.evaluate(
        evaluateInput({
          command: makeCommand('SUBMIT'),
          effects: ['form_submit'],
          pendingCommitments: [anonymous],
          authorization: authWith([grant('form_submit')]),
        })
      ).reason
    ).toBe('granted');
  });

  it('reports only the shared effects as missing, merged over entries in canonical order', () => {
    const purchaseAndSubmit = { ...pendingSubmit, effects: ['form_submit', 'purchase'] as const };
    const deleteEntry: TaskPendingCommitment = { ...pendingSubmit, seq: 4, effects: ['delete'] };
    const decision = policy.evaluate(
      submitInput({
        effects: ['form_submit', 'purchase', 'delete', 'send'],
        pendingCommitments: [deleteEntry, purchaseAndSubmit],
      })
    );
    expect(decision).toEqual({
      verdict: 'require_approval',
      effects: ['form_submit', 'purchase', 'delete', 'send'],
      missing: ['form_submit', 'purchase', 'delete'],
      reason: 'uncertain_commitment_pending',
    });
  });

  it('rows 1 to 4 outrank row 7', () => {
    expect(
      policy.evaluate(
        submitInput({
          pendingCommitments: [pendingSubmit],
          pageUrl: `${OTHER_ORIGIN}/`,
        })
      ).reason
    ).toBe('origin_not_allowed');
  });
});

describe('evaluate: row 8 (grant coverage)', () => {
  const click = (effects: readonly TaskEffectKind[], overrides: Partial<TaskPolicyInput> = {}) =>
    evaluateInput({ effects, ...overrides });

  it.each(TASK_COMMITMENT_EFFECTS)('%s never passes without a grant or an approval', effect => {
    const effects: readonly TaskEffectKind[] = ['interact', effect];
    expect(policy.evaluate(click(effects))).toEqual({
      verdict: 'require_approval',
      effects,
      missing: [effect],
      reason: 'commitment_not_granted',
    });
    const denying = createTaskPolicy({ onUnauthorized: 'deny' });
    expect(denying.evaluate(click(effects))).toEqual({
      verdict: 'deny',
      effects,
      reason: 'commitment_not_granted',
    });
  });

  it.each(TASK_COMMITMENT_EFFECTS)('%s is allowed by its own active grant', effect => {
    const effects: readonly TaskEffectKind[] = ['interact', effect];
    expect(policy.evaluate(click(effects, { authorization: authWith([grant(effect)]) }))).toEqual({
      verdict: 'allow',
      effects,
      reason: 'granted',
      grants: [0],
    });
  });

  it.each(TASK_COMMITMENT_EFFECTS)('a grant for another effect never covers %s', effect => {
    const others = TASK_COMMITMENT_EFFECTS.filter(candidate => candidate !== effect);
    const authorization = authWith(others.map(other => grant(other)));
    const decision = policy.evaluate(click(['interact', effect], { authorization }));
    expect(decision.verdict).not.toBe('allow');
  });

  it('reports the indexes of the covering grants, unique and ascending', () => {
    const authorization = authWith([
      grant('delete', { origins: [OTHER_ORIGIN] }),
      grant('purchase'),
      grant('publish', { maxUses: 1, used: 1 }),
      grant('delete'),
      grant('purchase'),
    ]);
    expect(policy.evaluate(click(['interact', 'purchase', 'delete'], { authorization }))).toEqual({
      verdict: 'allow',
      effects: ['interact', 'purchase', 'delete'],
      reason: 'granted',
      grants: [1, 3],
    });
  });

  it('skips an exhausted grant and uses the next active one for the same effect', () => {
    const authorization = authWith([
      grant('purchase', { maxUses: 2, used: 2 }),
      grant('purchase', { maxUses: 2, used: 1 }),
    ]);
    expect(asAllow(policy.evaluate(click(['purchase'], { authorization }))).grants).toEqual([1]);
  });

  it('missing lists every uncovered commitment effect in canonical order', () => {
    const decision = policy.evaluate(
      click(['interact', 'send', 'delete', 'purchase'], {
        authorization: authWith([grant('delete')]),
      })
    );
    expect(decision).toEqual({
      verdict: 'require_approval',
      effects: ['interact', 'send', 'delete', 'purchase'],
      missing: ['purchase', 'send'],
      reason: 'commitment_not_granted',
    });
  });

  it('row 9: partial coverage under onUnauthorized deny is a denial', () => {
    const denying = createTaskPolicy({ onUnauthorized: 'deny' });
    expect(
      denying.evaluate(
        click(['purchase', 'delete'], { authorization: authWith([grant('delete')]) })
      )
    ).toEqual({
      verdict: 'deny',
      effects: ['purchase', 'delete'],
      reason: 'commitment_not_granted',
    });
  });

  it('onUnauthorized defaults to pause', () => {
    for (const target of [
      createTaskPolicy(),
      createTaskPolicy({}),
      createTaskPolicy({ onUnauthorized: 'pause' }),
    ]) {
      expect(target.evaluate(click(['delete'])).verdict).toBe('require_approval');
    }
  });

  describe('maxUses', () => {
    it('covers while used < maxUses, on both sides of the boundary', () => {
      expect(
        policy.evaluate(
          click(['delete'], { authorization: authWith([grant('delete', { maxUses: 2, used: 1 })]) })
        ).verdict
      ).toBe('allow');
      expect(
        policy.evaluate(
          click(['delete'], { authorization: authWith([grant('delete', { maxUses: 2, used: 2 })]) })
        ).verdict
      ).toBe('require_approval');
      expect(
        policy.evaluate(
          click(['delete'], { authorization: authWith([grant('delete', { maxUses: 0, used: 0 })]) })
        ).verdict
      ).toBe('require_approval');
      expect(
        policy.evaluate(
          click(['delete'], {
            authorization: authWith([grant('delete', { maxUses: null, used: 999 })]),
          })
        ).verdict
      ).toBe('allow');
    });

    it('a run-scoped approval grant is bounded: the (n+1)th use requires approval again', () => {
      let authorization = addRunGrants(
        makeNormalizedAuthorization(),
        ['purchase'],
        FIXTURE_ORIGIN,
        3
      );
      for (let use = 0; use < 3; use += 1) {
        const decision = asAllow(
          policy.evaluate(click(['interact', 'purchase'], { authorization }))
        );
        expect(decision.reason).toBe('granted');
        authorization = consumeGrants(authorization, decision.grants);
      }
      expect(policy.evaluate(click(['interact', 'purchase'], { authorization }))).toEqual({
        verdict: 'require_approval',
        effects: ['interact', 'purchase'],
        missing: ['purchase'],
        reason: 'commitment_not_granted',
      });
    });
  });

  describe('expiresAt', () => {
    const expiring = (expiresAt: number | null) => authWith([grant('delete', { expiresAt })]);
    const at = (now: number, expiresAt: number | null) =>
      policy.evaluate(click(['delete'], { now, authorization: expiring(expiresAt) })).verdict;

    it('covers while now < expiresAt and not at or after it', () => {
      expect(at(FIXTURE_START, FIXTURE_START + 1)).toBe('allow');
      expect(at(FIXTURE_START, FIXTURE_START)).toBe('require_approval');
      expect(at(FIXTURE_START + 1, FIXTURE_START)).toBe('require_approval');
      expect(at(FIXTURE_START + 10 ** 9, null)).toBe('allow');
    });

    it('an expired grant covers nothing', () => {
      expect(at(FIXTURE_START + 5000, FIXTURE_START + 1000)).toBe('require_approval');
    });
  });

  describe('origins', () => {
    it('covers only a page origin listed in the grant', () => {
      const authorization = authWith([grant('delete', { origins: [OTHER_ORIGIN] })], {
        origins: [FIXTURE_ORIGIN, OTHER_ORIGIN],
      });
      expect(policy.evaluate(click(['delete'], { authorization })).verdict).toBe(
        'require_approval'
      );
      expect(
        policy.evaluate(click(['delete'], { authorization, pageUrl: `${OTHER_ORIGIN}/x` })).verdict
      ).toBe('allow');
    });

    it('a grant with no origins covers nothing', () => {
      expect(
        policy.evaluate(
          click(['delete'], { authorization: authWith([grant('delete', { origins: [] })]) })
        ).verdict
      ).toBe('require_approval');
    });
  });

  describe('signatures', () => {
    const limited = authWith([grant('delete', { signatures: [signatureFor('t1')] })]);

    it('covers only a listed element signature', () => {
      expect(
        policy.evaluate(click(['delete'], { authorization: limited, element: makeElement() }))
          .verdict
      ).toBe('allow');
      expect(
        policy.evaluate(
          click(['delete'], {
            authorization: limited,
            element: makeElement({ id: 't9', signature: signatureFor('t9') }),
          })
        ).verdict
      ).toBe('require_approval');
    });

    it('covers nothing when the command has no element', () => {
      expect(policy.evaluate(click(['delete'], { authorization: limited })).verdict).toBe(
        'require_approval'
      );
    });

    it('an empty signature list covers nothing, null covers everything', () => {
      expect(
        policy.evaluate(
          click(['delete'], {
            authorization: authWith([grant('delete', { signatures: [] })]),
            element: makeElement(),
          })
        ).verdict
      ).toBe('require_approval');
      expect(
        policy.evaluate(click(['delete'], { authorization: authWith([grant('delete')]) })).verdict
      ).toBe('allow');
    });
  });

  describe('form_submit coverage', () => {
    const submit = (effects: readonly TaskEffectKind[], grants: readonly TaskNormalizedGrant[]) =>
      policy.evaluate(
        evaluateInput({
          command: makeCommand('SUBMIT'),
          effects,
          element: makeSubmitButton(),
          authorization: authWith(grants),
        })
      );

    it('a standalone form_submit needs a form_submit grant', () => {
      expect(submit(['form_submit'], [])).toMatchObject({
        verdict: 'require_approval',
        missing: ['form_submit'],
      });
      expect(submit(['form_submit'], [grant('form_submit')])).toMatchObject({
        verdict: 'allow',
        grants: [0],
      });
    });

    it.each(TASK_COMMITMENT_EFFECTS.filter(effect => effect !== 'form_submit'))(
      'a %s grant never covers a standalone form_submit',
      effect => {
        expect(submit(['form_submit'], [grant(effect)])).toEqual({
          verdict: 'require_approval',
          effects: ['form_submit'],
          missing: ['form_submit'],
          reason: 'commitment_not_granted',
        });
      }
    );

    it('a delete grant plus a plain SUBMIT requires approval', () => {
      expect(submit(['form_submit'], [grant('delete')]).verdict).toBe('require_approval');
    });

    it('a purchase through a form needs one grant', () => {
      expect(submit(['form_submit', 'purchase'], [grant('purchase')])).toEqual({
        verdict: 'allow',
        effects: ['form_submit', 'purchase'],
        reason: 'granted',
        grants: [0],
      });
    });

    it('with both grants, each covers its own effect and both are consumed', () => {
      expect(
        submit(['form_submit', 'purchase'], [grant('form_submit'), grant('purchase')])
      ).toMatchObject({
        verdict: 'allow',
        grants: [0, 1],
      });
    });

    it('a form_submit grant alone leaves the other effect missing', () => {
      expect(submit(['form_submit', 'purchase'], [grant('form_submit')])).toMatchObject({
        verdict: 'require_approval',
        missing: ['purchase'],
      });
    });

    it('an inactive grant for the other effect covers neither effect', () => {
      expect(
        submit(['form_submit', 'purchase'], [grant('purchase', { maxUses: 1, used: 1 })])
      ).toMatchObject({ verdict: 'require_approval', missing: ['form_submit', 'purchase'] });
      expect(
        submit(['form_submit', 'purchase'], [grant('purchase', { expiresAt: FIXTURE_START })])
      ).toMatchObject({ verdict: 'require_approval', missing: ['form_submit', 'purchase'] });
    });

    it('rides on an active grant of any other effect the command carries', () => {
      expect(submit(['form_submit', 'delete', 'purchase'], [grant('delete')])).toMatchObject({
        verdict: 'require_approval',
        missing: ['purchase'],
      });
      expect(
        submit(['form_submit', 'delete', 'purchase'], [grant('delete'), grant('purchase')])
      ).toMatchObject({ verdict: 'allow', grants: [0, 1] });
    });

    it('Enter in an implicit-submit field requires a form_submit grant', () => {
      const field = withHints(
        makeTextField({ formId: 'f1' }),
        hint('FORM_SUBMIT', 'implicit_submit_field')
      );
      const command = makeCommand('PRESS', { key: 'Enter' });
      const effects = classifyWith(policy, command, field, [makeForm()]).effects;
      expect(effects).toEqual(['interact', 'form_submit']);
      const evaluate = (grants: readonly TaskNormalizedGrant[]) =>
        policy.evaluate(
          evaluateInput({
            command,
            effects,
            element: field,
            form: makeForm(),
            authorization: authWith(grants),
          })
        );
      expect(evaluate([])).toMatchObject({ verdict: 'require_approval', missing: ['form_submit'] });
      expect(evaluate([grant('purchase')]).verdict).toBe('require_approval');
      expect(evaluate([grant('form_submit')])).toMatchObject({ verdict: 'allow', grants: [0] });
    });

    it('a declared marker on a link, a switch and a select requires a grant', () => {
      const cases: readonly {
        readonly command: TaskCommand;
        readonly element: TaskElement;
        readonly effect: TaskCommitmentEffect;
      }[] = [
        {
          command: makeCommand('NAVIGATE'),
          element: withHints(makeLink(), hint('DELETE', 'declared_marker')),
          effect: 'delete',
        },
        {
          command: makeCommand('SET_CHECKED'),
          element: withHints(
            makeCheckbox({ role: 'switch', kind: 'switch' }),
            hint('ACCOUNT_CHANGE', 'declared_marker')
          ),
          effect: 'account_change',
        },
        {
          command: makeCommand('SELECT'),
          element: withHints(makeSelectField(), hint('PURCHASE', 'declared_marker')),
          effect: 'purchase',
        },
      ];
      for (const { command, element, effect } of cases) {
        const effects = classifyWith(policy, command, element).effects;
        const run = (grants: readonly TaskNormalizedGrant[]) =>
          policy.evaluate(
            evaluateInput({ command, effects, element, authorization: authWith(grants) })
          );
        expect(run([])).toMatchObject({ verdict: 'require_approval', missing: [effect] });
        expect(run([grant(effect)])).toMatchObject({ verdict: 'allow', reason: 'granted' });
      }
    });
  });
});

describe('evaluate: decision shape and purity', () => {
  it('returns JSON-safe decisions for every verdict', () => {
    const decisions = [
      policy.evaluate(evaluateInput()),
      policy.evaluate(evaluateInput({ effects: ['delete'] })),
      policy.evaluate(evaluateInput({ pageUrl: `${OTHER_ORIGIN}/` })),
      policy.evaluate(
        evaluateInput({ effects: ['delete'], authorization: authWith([grant('delete')]) })
      ),
      createTaskPolicy({ onUnauthorized: 'deny' }).evaluate(evaluateInput({ effects: ['delete'] })),
    ];
    for (const decision of decisions) {
      expect(roundTrip(decision)).toEqual(decision);
    }
  });

  it('does not mutate a frozen input', () => {
    const input = deepFreeze(
      evaluateInput({
        effects: ['form_submit', 'purchase'],
        command: makeCommand('SUBMIT'),
        element: makeSubmitButton(),
        authorization: authWith([grant('purchase', { maxUses: 2 })]),
        pendingCommitments: [
          { seq: 1, digest: OTHER_DIGEST, effects: ['delete'], documentId: FIXTURE_IDS.document },
        ],
      })
    );
    expect(asAllow(policy.evaluate(input)).grants).toEqual([0]);
  });

  it('is deterministic and never throws on a malformed input, never allowing', () => {
    expect(() => policy.evaluate(null as unknown as TaskPolicyInput)).not.toThrow();
    expect(policy.evaluate(null as unknown as TaskPolicyInput).verdict).not.toBe('allow');
    const broken = { ...evaluateInput(), authorization: undefined } as unknown as TaskPolicyInput;
    expect(() => policy.evaluate(broken)).not.toThrow();
    expect(policy.evaluate(broken).verdict).not.toBe('allow');
    const input = evaluateInput({ effects: ['delete'] });
    expect(policy.evaluate(input)).toEqual(policy.evaluate(input));
  });
});

describe('normalizeAuthorization', () => {
  const capabilities = makeCapabilities({ operations: ['READ', 'CLICK', 'FILL'] });

  it('defaults to the host operations, the start origin and no grants', () => {
    expect(normalizeAuthorization(undefined, FIXTURE_ORIGIN, capabilities)).toEqual({
      operations: ['READ', 'CLICK', 'FILL'],
      origins: [FIXTURE_ORIGIN],
      grants: [],
      assumeUnclassifiedRoutine: false,
    });
    expect(normalizeAuthorization({}, FIXTURE_ORIGIN, capabilities)).toEqual(
      normalizeAuthorization(undefined, FIXTURE_ORIGIN, capabilities)
    );
  });

  it('intersects operations with the host capabilities, without duplicates', () => {
    expect(
      normalizeAuthorization(
        { operations: ['FILL', 'SCROLL', 'READ', 'FILL', 'SUBMIT'] },
        FIXTURE_ORIGIN,
        capabilities
      ).operations
    ).toEqual(['FILL', 'READ']);
    expect(
      normalizeAuthorization({ operations: ['SUBMIT'] }, FIXTURE_ORIGIN, capabilities).operations
    ).toEqual([]);
    expect(
      normalizeAuthorization({ operations: [] }, FIXTURE_ORIGIN, capabilities).operations
    ).toEqual([]);
  });

  it('normalizes origins to URL.origin and drops invalid and non-http(s) entries', () => {
    const result = normalizeAuthorization(
      {
        origins: [
          'https://Shop.Example.test/path?x=1#y',
          'http://localhost:3000/',
          'https://shop.example.test',
          'ftp://files.example.test',
          'javascript:alert(1)',
          'file:///etc/passwd',
          'data:text/html,hi',
          'not a url',
          '',
          '*',
        ],
      },
      'https://ignored.example.test',
      capabilities
    );
    expect(result.origins).toEqual(['https://shop.example.test', 'http://localhost:3000']);
  });

  it('explicit origins replace the start origin, and an all-invalid list stays empty', () => {
    expect(
      normalizeAuthorization({ origins: [OTHER_ORIGIN] }, FIXTURE_ORIGIN, capabilities).origins
    ).toEqual([OTHER_ORIGIN]);
    expect(
      normalizeAuthorization({ origins: ['nope', 'ftp://x.test'] }, FIXTURE_ORIGIN, capabilities)
        .origins
    ).toEqual([]);
    expect(normalizeAuthorization({ origins: [] }, FIXTURE_ORIGIN, capabilities).origins).toEqual(
      []
    );
  });

  it('normalizes the start origin as well, and an invalid one yields no origin', () => {
    expect(
      normalizeAuthorization(undefined, 'https://Shop.Example.test/cart', capabilities).origins
    ).toEqual([FIXTURE_ORIGIN]);
    expect(normalizeAuthorization(undefined, 'garbage', capabilities).origins).toEqual([]);
    expect(normalizeAuthorization(undefined, 'ftp://x.test', capabilities).origins).toEqual([]);
  });

  it('turns a bare effect into an unrestricted grant over the run origins', () => {
    const result = normalizeAuthorization(
      { origins: [FIXTURE_ORIGIN, OTHER_ORIGIN], effects: ['purchase', 'delete'] },
      FIXTURE_ORIGIN,
      capabilities
    );
    expect(result.grants).toEqual([
      {
        effect: 'purchase',
        origins: [FIXTURE_ORIGIN, OTHER_ORIGIN],
        maxUses: null,
        used: 0,
        expiresAt: null,
        signatures: null,
      },
      {
        effect: 'delete',
        origins: [FIXTURE_ORIGIN, OTHER_ORIGIN],
        maxUses: null,
        used: 0,
        expiresAt: null,
        signatures: null,
      },
    ]);
  });

  it('normalizes a grant object field by field', () => {
    const result = normalizeAuthorization(
      {
        effects: [
          {
            effect: 'publish',
            origins: [`${OTHER_ORIGIN}/ignored/path`, 'nope', 'ftp://x.test'],
            maxUses: 3.9,
            expiresAt: FIXTURE_START + 1000,
            signatures: [signatureFor('t1'), signatureFor('t2')],
          },
          { effect: 'send' },
        ],
      },
      FIXTURE_ORIGIN,
      capabilities
    );
    expect(result.grants).toEqual([
      {
        effect: 'publish',
        origins: [OTHER_ORIGIN],
        maxUses: 3,
        used: 0,
        expiresAt: FIXTURE_START + 1000,
        signatures: [signatureFor('t1'), signatureFor('t2')],
      },
      {
        effect: 'send',
        origins: [FIXTURE_ORIGIN],
        maxUses: null,
        used: 0,
        expiresAt: null,
        signatures: null,
      },
    ]);
  });

  it('collapses identical grants and keeps different ones', () => {
    const result = normalizeAuthorization(
      {
        effects: [
          'purchase',
          'purchase',
          { effect: 'purchase' },
          { effect: 'purchase', maxUses: 2 },
          { effect: 'purchase', maxUses: 2 },
          { effect: 'purchase', expiresAt: FIXTURE_START + 5 },
          { effect: 'purchase', signatures: [signatureFor('t1')] },
          { effect: 'delete' },
        ],
      },
      FIXTURE_ORIGIN,
      capabilities
    );
    expect(
      result.grants.map(entry => [entry.effect, entry.maxUses, entry.expiresAt, entry.signatures])
    ).toEqual([
      ['purchase', null, null, null],
      ['purchase', 2, null, null],
      ['purchase', null, FIXTURE_START + 5, null],
      ['purchase', null, null, [signatureFor('t1')]],
      ['delete', null, null, null],
    ]);
  });

  it('drops entries that are not a commitment effect', () => {
    const result = normalizeAuthorization(
      {
        effects: [
          'read',
          'interact',
          'bogus',
          null,
          42,
          { effect: 'navigate' },
          { effect: 'other_commitment' },
        ] as unknown as TaskAuthorization['effects'],
      },
      FIXTURE_ORIGIN,
      capabilities
    );
    expect(result.grants.map(entry => entry.effect)).toEqual(['other_commitment']);
  });

  it('fails closed on a malformed maxUses or expiresAt', () => {
    const result = normalizeAuthorization(
      {
        effects: [
          { effect: 'delete', maxUses: -1 },
          { effect: 'publish', maxUses: Number.NaN },
          { effect: 'send', expiresAt: Number.NaN },
          { effect: 'purchase', maxUses: '5' as unknown as number },
        ],
      },
      FIXTURE_ORIGIN,
      capabilities
    );
    expect(result.grants.map(entry => entry.maxUses)).toEqual([0, 0, null, 0]);
    expect(result.grants[2]?.expiresAt).toBe(0);
    for (const entry of result.grants) {
      const decision = policy.evaluate(
        evaluateInput({
          effects: [entry.effect],
          authorization: { ...result, origins: [FIXTURE_ORIGIN] },
        })
      );
      expect(decision.verdict).toBe('require_approval');
    }
  });

  it('keeps assumeUnclassifiedRoutine only when it is exactly true', () => {
    expect(
      normalizeAuthorization({ assumeUnclassifiedRoutine: true }, FIXTURE_ORIGIN, capabilities)
        .assumeUnclassifiedRoutine
    ).toBe(true);
    expect(
      normalizeAuthorization({ assumeUnclassifiedRoutine: false }, FIXTURE_ORIGIN, capabilities)
        .assumeUnclassifiedRoutine
    ).toBe(false);
    expect(
      normalizeAuthorization(
        { assumeUnclassifiedRoutine: 'yes' as unknown as boolean },
        FIXTURE_ORIGIN,
        capabilities
      ).assumeUnclassifiedRoutine
    ).toBe(false);
  });

  it('is pure, JSON-safe and idempotent through a checkpoint round trip', () => {
    const input: TaskAuthorization = deepFreeze({
      operations: ['READ', 'CLICK'],
      origins: [FIXTURE_ORIGIN],
      effects: ['delete', { effect: 'purchase', maxUses: 2, signatures: [signatureFor('t1')] }],
      assumeUnclassifiedRoutine: true,
    });
    const result = normalizeAuthorization(input, FIXTURE_ORIGIN, capabilities);
    expect(roundTrip(result)).toEqual(result);
    expect(normalizeAuthorization(input, FIXTURE_ORIGIN, capabilities)).toEqual(result);
  });

  it('a malformed authorization object does not throw and grants nothing', () => {
    expect(() =>
      normalizeAuthorization(42 as unknown as TaskAuthorization, FIXTURE_ORIGIN, capabilities)
    ).not.toThrow();
    const result = normalizeAuthorization(
      {
        effects: 'purchase',
        origins: 'https://x.test',
        operations: 'CLICK',
      } as unknown as TaskAuthorization,
      FIXTURE_ORIGIN,
      capabilities
    );
    expect(result.grants).toEqual([]);
  });
});

describe('addRunGrants', () => {
  const base = deepFreeze(
    authWith([grant('delete', { maxUses: 1 })], { origins: [FIXTURE_ORIGIN, OTHER_ORIGIN] })
  );

  it('appends one bounded grant per effect for the page origin and keeps earlier grants', () => {
    const result = addRunGrants(base, ['purchase', 'send'], FIXTURE_ORIGIN, 4);
    expect(result.grants).toEqual([
      grant('delete', { maxUses: 1 }),
      grant('purchase', { maxUses: 4 }),
      grant('send', { maxUses: 4 }),
    ]);
    expect(result.operations).toEqual(base.operations);
    expect(result.origins).toEqual(base.origins);
    expect(result.assumeUnclassifiedRoutine).toBe(base.assumeUnclassifiedRoutine);
  });

  it('returns a new value and never mutates the input', () => {
    const result = addRunGrants(base, ['purchase'], FIXTURE_ORIGIN, 2);
    expect(result).not.toBe(base);
    expect(result.grants).not.toBe(base.grants);
    expect(base.grants).toHaveLength(1);
    expect(addRunGrants(base, [], FIXTURE_ORIGIN, 2)).toEqual(base);
  });

  it('binds the grant to the given page origin only, with no expiry', () => {
    const result = addRunGrants(base, ['purchase'], OTHER_ORIGIN, 2);
    const added = result.grants[1];
    expect(added).toEqual({
      effect: 'purchase',
      origins: [OTHER_ORIGIN],
      maxUses: 2,
      used: 0,
      expiresAt: null,
      signatures: null,
    });
    expect(
      policy.evaluate(evaluateInput({ effects: ['purchase'], authorization: result })).verdict
    ).toBe('require_approval');
    expect(
      policy.evaluate(
        evaluateInput({
          effects: ['purchase'],
          authorization: result,
          pageUrl: `${OTHER_ORIGIN}/x`,
        })
      ).verdict
    ).toBe('allow');
  });

  it('normalizes the origin and appends a new grant even when an identical one exists', () => {
    const once = addRunGrants(base, ['purchase'], `${FIXTURE_ORIGIN}/cart?x=1`, 2);
    const twice = addRunGrants(once, ['purchase'], FIXTURE_ORIGIN, 2);
    expect(once.grants[1]?.origins).toEqual([FIXTURE_ORIGIN]);
    expect(twice.grants).toHaveLength(3);
  });

  it('adds each effect once per call and ignores non-commitment effects', () => {
    const result = addRunGrants(
      base,
      ['purchase', 'purchase', 'read', 'bogus'] as unknown as readonly TaskCommitmentEffect[],
      FIXTURE_ORIGIN,
      2
    );
    expect(result.grants.map(entry => entry.effect)).toEqual(['delete', 'purchase']);
  });

  it('adds nothing for an origin it cannot normalize', () => {
    expect(addRunGrants(base, ['purchase'], 'garbage', 2).grants).toEqual(base.grants);
    expect(addRunGrants(base, ['purchase'], 'ftp://x.test', 2).grants).toEqual(base.grants);
  });

  it('floors maxUses and never widens a malformed value', () => {
    expect(addRunGrants(base, ['send'], FIXTURE_ORIGIN, 2.7).grants[1]?.maxUses).toBe(2);
    for (const bad of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(addRunGrants(base, ['send'], FIXTURE_ORIGIN, bad).grants[1]?.maxUses).toBe(0);
    }
  });

  it('works with the default number of run grant uses', () => {
    const result = addRunGrants(base, ['publish'], FIXTURE_ORIGIN, TASK_DEFAULT_RUN_GRANT_USES);
    expect(result.grants[1]?.maxUses).toBe(5);
  });
});

describe('consumeGrants', () => {
  const base = deepFreeze(
    authWith([
      grant('delete', { maxUses: 3, used: 1 }),
      grant('purchase'),
      grant('send', { used: 4 }),
    ])
  );

  it('increments used by one on each listed grant only', () => {
    const result = consumeGrants(base, [0, 2]);
    expect(result.grants.map(entry => entry.used)).toEqual([2, 0, 5]);
    expect(result.grants[0]).toEqual(grant('delete', { maxUses: 3, used: 2 }));
  });

  it('returns a new value and leaves the input untouched', () => {
    const result = consumeGrants(base, [1]);
    expect(result).not.toBe(base);
    expect(result.grants).not.toBe(base.grants);
    expect(base.grants.map(entry => entry.used)).toEqual([1, 0, 4]);
  });

  it('counts a duplicate index once and ignores indexes that name no grant', () => {
    expect(consumeGrants(base, [1, 1, 1]).grants.map(entry => entry.used)).toEqual([1, 1, 4]);
    for (const bad of [[-1], [3], [99], [1.5], [Number.NaN]]) {
      expect(consumeGrants(base, bad).grants).toEqual(base.grants);
    }
  });

  it('an empty list changes nothing and keeps every other field', () => {
    const result = consumeGrants(base, []);
    expect(result).toEqual(base);
    expect(result.origins).toEqual(base.origins);
    expect(result.operations).toEqual(base.operations);
  });

  it('exhausts a bounded grant exactly at maxUses', () => {
    let authorization = authWith([grant('delete', { maxUses: 2 })]);
    const decide = () => policy.evaluate(evaluateInput({ effects: ['delete'], authorization }));
    authorization = consumeGrants(authorization, asAllow(decide()).grants);
    expect(decide().verdict).toBe('allow');
    authorization = consumeGrants(authorization, asAllow(decide()).grants);
    expect(decide().verdict).toBe('require_approval');
  });
});

describe('mergeEffects', () => {
  it('unions groups, removes duplicates and orders routine effects first', () => {
    expect(
      mergeEffects(
        ['purchase', 'input'],
        ['interact', 'purchase'],
        ['read'],
        ['delete', 'navigate']
      )
    ).toEqual(['read', 'navigate', 'interact', 'input', 'purchase', 'delete']);
  });

  it('sorts any permutation into TASK_EFFECTS order', () => {
    expect(mergeEffects([...TASK_EFFECTS].reverse())).toEqual([...TASK_EFFECTS]);
    expect(mergeEffects(TASK_COMMITMENT_EFFECTS, TASK_ROUTINE_EFFECTS)).toEqual([...TASK_EFFECTS]);
  });

  it('is empty only when every group is empty', () => {
    expect(mergeEffects()).toEqual([]);
    expect(mergeEffects([], [])).toEqual([]);
    expect(mergeEffects([], ['wait'])).toEqual(['wait']);
    expect(mergeEffects(['other_commitment'])).toEqual(['other_commitment']);
  });

  it('does not mutate its inputs and returns a fresh array', () => {
    const group: readonly TaskEffectKind[] = deepFreeze(['purchase', 'read']);
    const result = mergeEffects(group);
    expect(result).toEqual(['read', 'purchase']);
    expect(result).not.toBe(group);
    expect(group).toEqual(['purchase', 'read']);
  });
});

describe('effectForCommitment', () => {
  it('maps NONE to null and every other class to its effect', () => {
    expect(effectForCommitment('NONE')).toBeNull();
    for (const commitmentClass of TASK_COMMITMENT_CLASSES) {
      if (commitmentClass !== 'NONE') {
        expect(effectForCommitment(commitmentClass)).toBe(TASK_COMMITMENT_EFFECT[commitmentClass]);
      }
    }
    expect(effectForCommitment('FORM_SUBMIT')).toBe('form_submit');
    expect(effectForCommitment('OTHER_COMMITMENT')).toBe('other_commitment');
  });

  it('fails closed on a class it does not know', () => {
    expect(effectForCommitment('PRETEND' as TaskCommitmentClass)).toBe('other_commitment');
  });
});

describe('allCommitmentsGranted', () => {
  const unrestricted = (): readonly TaskNormalizedGrant[] =>
    TASK_COMMITMENT_EFFECTS.map(effect => grant(effect));

  it('is false without grants and true when all seven effects have an unrestricted grant', () => {
    expect(allCommitmentsGranted(makeNormalizedAuthorization())).toBe(false);
    expect(allCommitmentsGranted(authWith(unrestricted()))).toBe(true);
  });

  it.each(TASK_COMMITMENT_EFFECTS)('is false when %s has no grant', missing => {
    expect(
      allCommitmentsGranted(authWith(unrestricted().filter(entry => entry.effect !== missing)))
    ).toBe(false);
  });

  it.each([
    ['maxUses', { maxUses: 5 }],
    ['expiresAt', { expiresAt: FIXTURE_START + 1 }],
    ['signatures', { signatures: [signatureFor('t1')] }],
    ['origins', { origins: [OTHER_ORIGIN] }],
    ['empty origins', { origins: [] }],
  ] as const)('a grant restricted by %s does not count', (_name, restriction) => {
    const grants = unrestricted().map(entry =>
      entry.effect === 'delete' ? { ...entry, ...restriction } : entry
    );
    expect(allCommitmentsGranted(authWith(grants))).toBe(false);
  });

  it('a restricted grant never lets the classifier be skipped, but a second unrestricted one does', () => {
    const restricted = grant('publish', { maxUses: 1 });
    const grants = [...unrestricted().filter(entry => entry.effect !== 'publish'), restricted];
    expect(allCommitmentsGranted(authWith(grants))).toBe(false);
    expect(allCommitmentsGranted(authWith([...grants, grant('publish')]))).toBe(true);
  });

  it('requires the grant origins to cover every run origin', () => {
    const run = [FIXTURE_ORIGIN, OTHER_ORIGIN];
    const partial = TASK_COMMITMENT_EFFECTS.map(effect =>
      grant(effect, { origins: [FIXTURE_ORIGIN] })
    );
    expect(allCommitmentsGranted(authWith(partial, { origins: run }))).toBe(false);
    const covering = TASK_COMMITMENT_EFFECTS.map(effect =>
      grant(effect, { origins: [OTHER_ORIGIN, FIXTURE_ORIGIN, 'https://more.example.test'] })
    );
    expect(allCommitmentsGranted(authWith(covering, { origins: run }))).toBe(true);
  });

  it('ignores the number of uses already made by an unlimited grant', () => {
    expect(
      allCommitmentsGranted(
        authWith(TASK_COMMITMENT_EFFECTS.map(effect => grant(effect, { used: 50 })))
      )
    ).toBe(true);
  });
});

describe('malformed runtime input fails closed (adversarial review of m2a)', () => {
  const asInput = (value: unknown): TaskPolicyInput => value as TaskPolicyInput;
  const notAllowed = (input: TaskPolicyInput): TaskPolicyDecision => {
    const decision = policy.evaluate(input);
    expect(decision.verdict).not.toBe('allow');
    return decision;
  };

  describe('mergeEffects and an effect kind the contract does not know', () => {
    it('never loses an unknown kind: it reads as other_commitment', () => {
      expect(mergeEffects(['Purchase' as TaskEffectKind])).toEqual(['other_commitment']);
      expect(mergeEffects(['read'], ['purchase ' as TaskEffectKind])).toEqual([
        'read',
        'other_commitment',
      ]);
      expect(mergeEffects([''] as unknown as readonly TaskEffectKind[])).toEqual([
        'other_commitment',
      ]);
    });

    it('is empty only for empty groups even when a kind is unknown', () => {
      const groups: readonly (readonly TaskEffectKind[])[] = [
        [],
        ['bogus' as TaskEffectKind],
        ['wait'],
      ];
      expect(mergeEffects(...groups)).toEqual(['wait', 'other_commitment']);
    });

    it('evaluate treats an unknown kind as an uncovered other_commitment, never as routine', () => {
      const unknown = 'Purchase' as TaskEffectKind;
      expect(policy.evaluate(evaluateInput({ effects: ['interact', unknown] }))).toEqual({
        verdict: 'require_approval',
        effects: ['interact', unknown],
        missing: ['other_commitment'],
        reason: 'commitment_not_granted',
      });
      expect(
        createTaskPolicy({ onUnauthorized: 'deny' }).evaluate(evaluateInput({ effects: [unknown] }))
      ).toMatchObject({ verdict: 'deny', reason: 'commitment_not_granted' });
    });

    it('evaluate lets an other_commitment grant cover an unknown kind, and nothing else does', () => {
      const unknown = 'Purchase' as TaskEffectKind;
      expect(
        policy.evaluate(
          evaluateInput({
            effects: [unknown],
            authorization: authWith([grant('other_commitment')]),
          })
        )
      ).toMatchObject({ verdict: 'allow', reason: 'granted', grants: [0] });
      expect(
        policy.evaluate(
          evaluateInput({
            effects: [unknown],
            authorization: authWith([grant('purchase'), grant('delete')]),
          })
        ).verdict
      ).toBe('require_approval');
    });

    it('a known routine command stays routine next to nothing unknown', () => {
      expect(policy.evaluate(evaluateInput({ effects: ['interact'] })).reason).toBe('routine');
    });
  });

  describe('row 6 binds to real digests only', () => {
    const empties: readonly (readonly [string, unknown])[] = [
      ['undefined', undefined],
      ['an empty string', ''],
      ['null', null],
    ];
    it.each(empties)('an approval whose digests are %s approves nothing', (_name, empty) => {
      const decision = notAllowed(
        asInput({
          ...evaluateInput({ effects: ['delete'] }),
          digest: empty,
          contextDigest: empty,
          approvedOnce: { approvalId: 'apr_000000000001', digest: empty, contextDigest: empty },
        })
      );
      expect(decision.verdict).toBe('require_approval');
    });

    it('one empty side is enough to refuse, even when the other side matches', () => {
      for (const approvedOnce of [
        { approvalId: 'apr_000000000001', digest: '', contextDigest: CONTEXT },
        { approvalId: 'apr_000000000001', digest: DIGEST, contextDigest: '' },
      ]) {
        notAllowed(
          asInput({
            ...evaluateInput({ effects: ['delete'] }),
            digest: approvedOnce.digest === '' ? '' : DIGEST,
            contextDigest: approvedOnce.contextDigest === '' ? '' : CONTEXT,
            approvedOnce,
          })
        );
      }
    });

    it('a non-object approval approves nothing and does not throw', () => {
      for (const approvedOnce of [null, 'apr', 7, true]) {
        notAllowed(asInput({ ...evaluateInput({ effects: ['delete'] }), approvedOnce }));
      }
    });
  });

  describe('a string where a list belongs never passes by substring', () => {
    it('authorization.origins as a string that contains the page origin denies', () => {
      const authorization = asInput({
        ...evaluateInput(),
        authorization: { ...makeNormalizedAuthorization(), origins: `${FIXTURE_ORIGIN}.evil.test` },
      }).authorization;
      expect(policy.evaluate(evaluateInput({ authorization }))).toMatchObject({
        verdict: 'deny',
        reason: 'origin_not_allowed',
      });
    });

    it('authorization.operations as a string that contains the operation denies', () => {
      const authorization = {
        ...makeNormalizedAuthorization(),
        operations: 'CLICK_AND_MORE',
      } as unknown as TaskNormalizedAuthorization;
      expect(policy.evaluate(evaluateInput({ authorization }))).toMatchObject({
        verdict: 'deny',
        reason: 'operation_not_allowed',
      });
    });

    it('a destination checked against a string origin list denies', () => {
      const authorization = {
        ...makeNormalizedAuthorization(),
        origins: `${FIXTURE_ORIGIN} ${OTHER_ORIGIN}`,
      } as unknown as TaskNormalizedAuthorization;
      expect(
        policy.evaluate(
          evaluateInput({ authorization, element: makeLink({ href: `${OTHER_ORIGIN}/x` }) })
        ).verdict
      ).toBe('deny');
    });

    it('a grant whose origins is a string covers nothing', () => {
      const hostile = {
        ...grant('delete'),
        origins: `${FIXTURE_ORIGIN}.evil.test`,
      } as unknown as TaskNormalizedGrant;
      expect(
        policy.evaluate(evaluateInput({ effects: ['delete'], authorization: authWith([hostile]) }))
          .verdict
      ).toBe('require_approval');
    });

    it('a grant whose signatures is a string covers nothing', () => {
      const element = makeElement();
      const hostile = {
        ...grant('delete'),
        signatures: `${element.signature}-and-more`,
      } as unknown as TaskNormalizedGrant;
      expect(
        policy.evaluate(
          evaluateInput({ effects: ['delete'], element, authorization: authWith([hostile]) })
        ).verdict
      ).toBe('require_approval');
    });
  });

  describe('a grant with a non-numeric or negative counter covers nothing', () => {
    const hostileGrants: readonly (readonly [string, unknown])[] = [
      ['a string maxUses', { maxUses: '5' }],
      ['a negative used count', { maxUses: 1, used: -5 }],
      ['a string used count', { maxUses: 1, used: '0' }],
      ['a NaN used count', { maxUses: 1, used: Number.NaN }],
      ['a string expiry', { expiresAt: '9999999999999' }],
      ['an undefined expiry', { expiresAt: undefined }],
      ['an infinite maxUses', { maxUses: Number.POSITIVE_INFINITY }],
    ];
    it.each(hostileGrants)('%s', (_name, overrides) => {
      const hostile = { ...grant('delete'), ...(overrides as object) } as TaskNormalizedGrant;
      expect(
        policy.evaluate(evaluateInput({ effects: ['delete'], authorization: authWith([hostile]) }))
          .verdict
      ).toBe('require_approval');
    });

    it('control: the well-formed counterparts still cover', () => {
      for (const overrides of [
        { maxUses: 5, used: 0 },
        { maxUses: 1, used: 0 },
        { expiresAt: FIXTURE_START + 1 },
        { maxUses: null, used: 50 },
      ]) {
        expect(
          policy.evaluate(
            evaluateInput({
              effects: ['delete'],
              authorization: authWith([grant('delete', overrides)]),
            })
          ).verdict
        ).toBe('allow');
      }
    });
  });

  describe('normalizeAuthorization', () => {
    const capabilities = makeCapabilities({ operations: ['READ', 'CLICK', 'FILL'] });

    it.each([
      ['a string', 'READ'],
      ['a number', 5],
      ['an object', { READ: true }],
      ['true', true],
    ])('operations given as %s never widens to the host operations', (_name, operations) => {
      const result = normalizeAuthorization(
        { operations } as unknown as TaskAuthorization,
        FIXTURE_ORIGIN,
        capabilities
      );
      expect(result.operations).toEqual([]);
    });

    it('operations left out (undefined or null) still default to the host operations', () => {
      for (const authorization of [
        undefined,
        {},
        { operations: undefined },
        { operations: null },
      ]) {
        expect(
          normalizeAuthorization(
            authorization as unknown as TaskAuthorization,
            FIXTURE_ORIGIN,
            capabilities
          ).operations
        ).toEqual(['READ', 'CLICK', 'FILL']);
      }
    });

    it('a host that reports no usable operation list yields no operation instead of throwing', () => {
      for (const operations of [undefined, null, 'READ', 5]) {
        const broken = { ...capabilities, operations } as unknown as typeof capabilities;
        expect(() => normalizeAuthorization(undefined, FIXTURE_ORIGIN, broken)).not.toThrow();
        expect(normalizeAuthorization(undefined, FIXTURE_ORIGIN, broken).operations).toEqual([]);
        expect(
          normalizeAuthorization({ operations: ['READ'] }, FIXTURE_ORIGIN, broken).operations
        ).toEqual([]);
      }
    });
  });
});

describe('a commit hint with a basis the contract does not know (version skew) fails closed', () => {
  const mystery = { class: 'PURCHASE', basis: 'mystery' } as unknown as TaskCommitHint;
  const element = withHints(makeTextField({ formId: 'f1' }), mystery);

  const operations: readonly (readonly [string, TaskCommand])[] = [
    ['CLICK', makeCommand('CLICK')],
    ['NAVIGATE', makeCommand('NAVIGATE')],
    ['SUBMIT', makeCommand('SUBMIT')],
    ['FILL', makeCommand('FILL')],
    ['SELECT', makeCommand('SELECT')],
    ['SET_CHECKED', makeCommand('SET_CHECKED')],
    ['PRESS Enter', press('Enter')],
    ['PRESS Space', press('Space')],
    ['PRESS Tab', press('Tab')],
  ];

  it.each(operations)('%s counts the class of the hint', (_name, command) => {
    const result = classifyWith(policy, command, element);
    expect(result.effects).toContain('purchase');
    expect(result.hints).toContainEqual(mystery);
    expect(result.classifierError).toBe(false);
  });

  it.each([
    ['READ', makeCommand('READ')],
    ['SCROLL', makeCommand('SCROLL')],
    ['WAIT', makeCommand('WAIT')],
  ])('%s keeps its structural row and ignores hints', (_name, command) => {
    expect(classifyWith(policy, command, element).effects).not.toContain('purchase');
  });

  it('an unknown basis never counts as an implicit-submit field by itself', () => {
    const odd = { class: 'DELETE', basis: 'mystery' } as unknown as TaskCommitHint;
    const result = classifyWith(
      policy,
      press('Enter'),
      withHints(makeTextField({ formId: 'f1' }), odd)
    );
    expect(result.effects).toEqual(['interact', 'delete']);
  });

  it('the known bases keep their documented selectivity', () => {
    const marker = withHints(makeElement(), hint('PURCHASE', 'implicit_submit_field'));
    expect(classifyWith(policy, makeCommand('CLICK'), marker).effects).toEqual(['interact']);
  });
});
