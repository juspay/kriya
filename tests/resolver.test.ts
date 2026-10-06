/** @jest-environment node */
import * as fs from 'fs';
import * as path from 'path';
import {
  argumentAvailable,
  argumentView,
  buildCandidates,
  candidateViews,
  flattenInputs,
  hasUnsafeKey,
  inputRules,
  materializeArgument,
  mergeInputs,
  splitSensitiveInputs,
  summarizeInputs,
} from '@/agent/resolver';
import { goalRequirementKey, goalRequirementHolds } from '@/agent/requirements';
import { TASK_KEYS, TASK_LIMITS, TASK_WAIT_DURATIONS_MS } from '@/types';
import type {
  TaskArgumentAvailableFn,
  TaskArgumentCandidate,
  TaskArgumentRef,
  TaskArgumentViewFn,
  TaskBuildCandidatesFn,
  TaskCandidateInput,
  TaskCandidateViewsFn,
  TaskElement,
  TaskFlattenInputsFn,
  TaskHasUnsafeKeyFn,
  TaskInputDeclaration,
  TaskInputLeaf,
  TaskInputRulesFn,
  TaskInputs,
  TaskMaterializeArgumentFn,
  TaskMaterializeContext,
  TaskMergeInputsFn,
  TaskObservation,
  TaskResolver,
  TaskSplitSensitiveInputsFn,
  TaskSummarizeInputsFn,
} from '@/types';
import type { ElementOverrides } from './helpers/agent-fixtures';
import {
  FIXTURE_ORIGIN,
  makeCapabilities,
  makeCheckbox,
  makeElement,
  makeObservation,
  makeSelectField,
  makeSensitiveField,
  makeTextField,
  roundTrip,
  signatureFor,
} from './helpers/agent-fixtures';

export const seamConformance: {
  readonly hasUnsafeKey: TaskHasUnsafeKeyFn;
  readonly flattenInputs: TaskFlattenInputsFn;
  readonly inputRules: TaskInputRulesFn;
  readonly summarizeInputs: TaskSummarizeInputsFn;
  readonly buildCandidates: TaskBuildCandidatesFn;
  readonly candidateViews: TaskCandidateViewsFn;
  readonly argumentView: TaskArgumentViewFn;
  readonly argumentAvailable: TaskArgumentAvailableFn;
  readonly materializeArgument: TaskMaterializeArgumentFn;
  readonly mergeInputs: TaskMergeInputsFn;
  readonly splitSensitiveInputs: TaskSplitSensitiveInputsFn;
} = {
  hasUnsafeKey,
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
};

const ZWSP = String.fromCharCode(0x200b);

describe('goal requirements bind control semantics', () => {
  test('actual option group metadata survives eligible selection without imposing a parent mapping', () => {
    const element = makeSelectField({
      options: [
        {
          id: 't5.1',
          label: 'Same',
          value: 'AA',
          groupLabel: 'First group',
          selected: false,
          disabled: false,
        },
        {
          id: 't5.2',
          label: 'Same',
          value: 'BB',
          groupLabel: 'Second group',
          selected: false,
          disabled: false,
        },
      ],
    });
    const pool = buildCandidates(candidateInput({ slot: 'option', operation: 'SELECT', element }));
    expect(candidateViews(pool).map(candidate => candidate.optionGroup)).toEqual([
      'First group',
      'Second group',
    ]);
    expect(
      goalRequirementKey({
        ...element,
        options: element.options?.map(option => ({ ...option, groupLabel: 'Changed' })),
      })
    ).not.toBe(goalRequirementKey(element));
    const hidden = buildCandidates(
      candidateInput({
        slot: 'option',
        operation: 'SELECT',
        element: { ...element, sensitive: true },
      })
    );
    expect(candidateViews(hidden).every(candidate => candidate.optionGroup === undefined)).toBe(
      true
    );
  });
  test('dependent option codes and disabled state invalidate cached assessments, selection does not', () => {
    const first = makeSelectField({
      options: [
        { id: 't5.1', label: 'Central', value: 'CA', selected: true, disabled: false },
        { id: 't5.2', label: 'Central', value: 'DE', selected: false, disabled: false },
      ],
    });
    const selected = {
      ...first,
      options: first.options?.map(option => ({ ...option, selected: !option.selected })),
    };
    expect(goalRequirementKey(selected)).toBe(goalRequirementKey(first));
    expect(
      goalRequirementKey({
        ...first,
        options: first.options?.map(option => ({ ...option, value: 'changed' })),
      })
    ).not.toBe(goalRequirementKey(first));
    expect(
      goalRequirementKey({
        ...first,
        options: first.options?.map(option => ({ ...option, disabled: true })),
      })
    ).not.toBe(goalRequirementKey(first));
    const requirement = {
      key: goalRequirementKey(first),
      operation: 'SELECT' as const,
      argument: { source: 'observed_option' as const, targetId: first.id, optionId: 't5.2' },
      label: first.label,
      sensitive: false,
      optionLabel: 'Central',
      optionValue: 'DE',
    };
    const context = { goal: 'Use the supplied region.', inputs: {}, declarations: [], ledger: [] };
    expect(goalRequirementHolds(requirement, first, context)).toBe(false);
    expect(goalRequirementHolds(requirement, selected, context)).toBe(true);
  });
  test('input kind and radio group changes invalidate cached assessments without clearing ordinary values', () => {
    const first = makeTextField({ inputType: 'text', groupId: 'contact' });
    expect(goalRequirementKey({ ...first, inputType: 'email' })).not.toBe(
      goalRequirementKey(first)
    );
    expect(goalRequirementKey({ ...first, groupId: 'marketing' })).not.toBe(
      goalRequirementKey(first)
    );
    expect(goalRequirementKey({ ...first, state: { ...first.state, value: 'changed' } })).toBe(
      goalRequirementKey(first)
    );
  });
});
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const LINE_FEED = String.fromCharCode(0x0a);

const asInputs = (json: string): TaskInputs => JSON.parse(json) as TaskInputs;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
};

const decl = (
  declPath: string,
  overrides: Partial<TaskInputDeclaration> = {}
): TaskInputDeclaration => ({ path: declPath, sensitive: false, ...overrides });

const leaf = (
  leafPath: string,
  value: string,
  overrides: Partial<TaskInputLeaf> = {}
): TaskInputLeaf => ({
  path: leafPath,
  value,
  scalar: 'string',
  sensitive: false,
  ...overrides,
});

const pathsOf = (leaves: readonly TaskInputLeaf[]): readonly string[] =>
  leaves.map(item => item.path);

describe('hasUnsafeKey', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('finds %s at the top level', key => {
    expect(hasUnsafeKey(asInputs(`{"${key}": 1}`))).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'finds %s at any depth and inside arrays',
    key => {
      expect(hasUnsafeKey(asInputs(`{"a": {"b": {"c": {"${key}": {"x": 1}}}}}`))).toBe(true);
      expect(hasUnsafeKey(asInputs(`{"a": [1, {"${key}": 2}]}`))).toBe(true);
      expect(hasUnsafeKey(JSON.parse(`[[{"${key}": null}]]`))).toBe(true);
    }
  );

  it('finds an own key defined by hand, enumerable or not', () => {
    const hidden = {};
    Object.defineProperty(hidden, 'constructor', { value: 1, enumerable: false });
    expect(hasUnsafeKey({ nested: hidden })).toBe(true);
  });

  it('is false for clean data, for primitives and for unsafe names that are only values', () => {
    expect(hasUnsafeKey({})).toBe(false);
    expect(hasUnsafeKey({ a: 1, b: { c: [1, 2, { d: 'x' }] } })).toBe(false);
    expect(hasUnsafeKey({ a: '__proto__', b: ['constructor', 'prototype'] })).toBe(false);
    expect(hasUnsafeKey({ constructors: 1, prototypes: 2, __proto: 3, proto__: 4 })).toBe(false);
    for (const primitive of [null, undefined, 1, 'text', true, Symbol('s')]) {
      expect(hasUnsafeKey(primitive)).toBe(false);
    }
  });

  it('does not count the constructor every object inherits', () => {
    expect(hasUnsafeKey(new Date())).toBe(false);
    expect(hasUnsafeKey(Object.create(null))).toBe(false);
    expect(hasUnsafeKey({ list: [] })).toBe(false);
  });

  it('terminates on a cycle and on very deep nesting', () => {
    const cyclic: Record<string, unknown> = { a: {} };
    (cyclic.a as Record<string, unknown>).back = cyclic;
    expect(hasUnsafeKey(cyclic)).toBe(false);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let index = 0; index < 20000; index += 1) {
      deep = { next: deep };
    }
    expect(hasUnsafeKey(deep)).toBe(false);
    let deepUnsafe: Record<string, unknown> = JSON.parse('{"__proto__": 1}');
    for (let index = 0; index < 20000; index += 1) {
      deepUnsafe = { next: deepUnsafe };
    }
    expect(hasUnsafeKey(deepUnsafe)).toBe(true);
  });

  it('fails closed when reading the value throws', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('no keys');
        },
      }
    );
    expect(hasUnsafeKey({ nested: hostile })).toBe(true);
  });
});

describe('flattenInputs', () => {
  it('walks depth first in key order and renders scalars', () => {
    const leaves = flattenInputs(
      { b: 'text', a: { y: 2, x: true, z: 'q' }, c: [10, { d: 'e' }, false] },
      []
    );
    expect(leaves.map(item => [item.path, item.value, item.scalar])).toEqual([
      ['b', 'text', 'string'],
      ['a.y', '2', 'number'],
      ['a.x', 'true', 'boolean'],
      ['a.z', 'q', 'string'],
      ['c.0', '10', 'number'],
      ['c.1.d', 'e', 'string'],
      ['c.2', 'false', 'boolean'],
    ]);
  });

  it('renders numbers with String(n) and keeps an empty string leaf', () => {
    const leaves = flattenInputs({ n: 1.5, big: 1e21, neg: -0, zero: 0, empty: '' }, []);
    expect(leaves.map(item => item.value)).toEqual(['1.5', '1e+21', '0', '0', '']);
  });

  it('skips null, undefined, functions and non-finite numbers', () => {
    const odd = {
      keep: 'k',
      none: null,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      undef: undefined,
      fn: () => 1,
    } as unknown as TaskInputs;
    expect(pathsOf(flattenInputs(odd, []))).toEqual(['keep']);
    expect(pathsOf(flattenInputs({ list: [null, 'x', null] }, []))).toEqual(['list.1']);
  });

  it('returns nothing for empty inputs and nothing for empty containers', () => {
    expect(flattenInputs({}, [])).toEqual([]);
    expect(flattenInputs({ a: {}, b: [] }, [])).toEqual([]);
  });

  it('skips unsafe keys instead of following them', () => {
    const leaves = flattenInputs(
      asInputs('{"ok": "1", "__proto__": {"x": "2"}, "constructor": "3"}'),
      []
    );
    expect(pathsOf(leaves)).toEqual(['ok']);
  });

  it('terminates on a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 'x' };
    cyclic.self = cyclic;
    expect(pathsOf(flattenInputs(cyclic as unknown as TaskInputs, []))).toEqual(['a']);
  });

  describe('sensitivity', () => {
    it('is false by default and true for a declared exact path', () => {
      const inputs = { note: 'n', pin_code: 'p' };
      const none = flattenInputs({ note: 'n' }, []);
      expect(none[0]?.sensitive).toBe(false);
      const declared = flattenInputs(inputs, [decl('note', { sensitive: true })]);
      expect(declared.find(item => item.path === 'note')?.sensitive).toBe(true);
    });

    it('is true for every leaf below a declared sensitive ancestor and false for siblings', () => {
      const leaves = flattenInputs(
        { profile: { cards: [{ number: '1' }, { holder: 'h' }], name: 'n' }, other: 'o' },
        [decl('profile.cards', { sensitive: true })]
      );
      const bySensitivity = Object.fromEntries(leaves.map(item => [item.path, item.sensitive]));
      expect(bySensitivity).toEqual({
        'profile.cards.0.number': true,
        'profile.cards.1.holder': true,
        'profile.name': false,
        other: false,
      });
    });

    it('matches a declaration by whole path segments, not by string prefix', () => {
      const leaves = flattenInputs({ card: 'a', cardio: 'b', 'card.x': 'c' }, [
        decl('card', { sensitive: true }),
      ]);
      const bySensitivity = Object.fromEntries(leaves.map(item => [item.path, item.sensitive]));
      expect(bySensitivity.card).toBe(true);
      expect(bySensitivity.cardio).toBe(false);
    });

    it.each([
      ['password', 'x'],
      ['newPassword', 'x'],
      ['confirm_password', 'x'],
      ['cardNumber', 'x'],
      ['apiKey', 'x'],
      ['api_token', 'x'],
      ['Authorization', 'x'],
      ['cvv', 'x'],
      ['otp', 'x'],
      ['ssn', 'x'],
      ['date of birth', 'x'],
    ])('flags the heuristic key %s without any declaration', key => {
      const leaves = flattenInputs({ [key]: 'v' }, []);
      expect(leaves[0]?.sensitive).toBe(true);
    });

    it('flags a heuristic hit on any segment of the path, arrays included', () => {
      const leaves = flattenInputs(
        {
          billing: { cvv: '123', holder: 'h' },
          secretNotes: { first: 'x' },
          cards: [{ cvc: '9' }],
        },
        []
      );
      const bySensitivity = Object.fromEntries(leaves.map(item => [item.path, item.sensitive]));
      expect(bySensitivity).toEqual({
        'billing.cvv': true,
        'billing.holder': false,
        'secretNotes.first': true,
        'cards.0.cvc': true,
      });
    });

    it('leaves ordinary words alone', () => {
      const leaves = flattenInputs(
        {
          username: 'u',
          email: 'e',
          shipping: 's',
          description: 'd',
          pinterest: 'p',
          cardholder: 'c',
        },
        []
      );
      expect(leaves.every(item => !item.sensitive)).toBe(true);
    });

    it('never lowers a heuristic hit with a declaration of sensitive false', () => {
      const leaves = flattenInputs({ password: 'x' }, [decl('password', { sensitive: false })]);
      expect(leaves[0]?.sensitive).toBe(true);
    });

    it('lets one sensitive declaration win over a plain declaration of another level', () => {
      const leaves = flattenInputs({ a: { b: 'x' } }, [
        decl('a', { sensitive: true }),
        decl('a.b', { sensitive: false }),
      ]);
      expect(leaves[0]?.sensitive).toBe(true);
      const reverse = flattenInputs({ a: { b: 'x' } }, [
        decl('a', { sensitive: false }),
        decl('a.b', { sensitive: true }),
      ]);
      expect(reverse[0]?.sensitive).toBe(true);
    });
  });

  describe('declaration fields', () => {
    const bindA = { origins: [FIXTURE_ORIGIN], requireSensitiveElement: false };
    const bindB = { elementKinds: ['text_input'] as const };

    it('copies bind, expose and description from the declaration of the exact path', () => {
      const leaves = flattenInputs({ pw: 'x' }, [
        decl('pw', {
          sensitive: true,
          bind: bindA,
          expose: 'label',
          description: 'Account secret',
        }),
      ]);
      expect(leaves[0]).toEqual({
        path: 'pw',
        value: 'x',
        scalar: 'string',
        sensitive: true,
        bind: bindA,
        expose: 'label',
        description: 'Account secret',
      });
    });

    it('inherits bind and expose from an ancestor declaration', () => {
      const leaves = flattenInputs({ card: { number: '1', nested: { cvv: '2' } } }, [
        decl('card', { sensitive: true, bind: bindA, expose: 'label' }),
      ]);
      for (const item of leaves) {
        expect(item.bind).toEqual(bindA);
        expect(item.expose).toBe('label');
      }
    });

    it('prefers the nearest declaration for each field and falls back to a farther one', () => {
      const leaves = flattenInputs({ card: { number: '1', cvv: '2' } }, [
        decl('card', { sensitive: true, bind: bindA, expose: 'label' }),
        decl('card.number', { sensitive: true, bind: bindB }),
      ]);
      const number = leaves.find(item => item.path === 'card.number');
      const cvv = leaves.find(item => item.path === 'card.cvv');
      expect(number?.bind).toEqual(bindB);
      expect(number?.expose).toBe('label');
      expect(cvv?.bind).toEqual(bindA);
    });

    it('takes the description from the exact path only', () => {
      const leaves = flattenInputs({ card: { number: '1' } }, [
        decl('card', { sensitive: true, description: 'whole card' }),
      ]);
      expect(leaves[0]?.description).toBeUndefined();
      expect('description' in (leaves[0] ?? {})).toBe(false);
    });

    it('omits the optional fields when no declaration gives them', () => {
      const leaves = flattenInputs({ plain: 'x' }, [decl('other')]);
      expect(Object.keys(leaves[0] ?? {}).sort()).toEqual(['path', 'scalar', 'sensitive', 'value']);
    });
  });

  it('does not mutate its arguments and returns JSON', () => {
    const inputs = deepFreeze({ a: { b: 'c' } });
    const declarations = deepFreeze([decl('a.b', { sensitive: true })]);
    const leaves = flattenInputs(inputs, declarations);
    expect(roundTrip(leaves)).toEqual(leaves);
  });
});

describe('inputRules', () => {
  it('drops the value, the scalar type, the description and expose, and keeps path, sensitive and bind', () => {
    const bind = { origins: [FIXTURE_ORIGIN] };
    const rules = inputRules([
      leaf('a', 'secret-a', { sensitive: true, bind, description: 'd', expose: 'label' }),
      leaf('b', 'value-b'),
    ]);
    expect(rules).toEqual([
      { path: 'a', sensitive: true, bind },
      { path: 'b', sensitive: false },
    ]);
    expect(JSON.stringify(rules)).not.toContain('secret-a');
    expect(JSON.stringify(rules)).not.toContain('value-b');
    expect('bind' in (rules[1] ?? {})).toBe(false);
  });
});

describe('summarizeInputs', () => {
  it('shows a preview for a non-sensitive leaf by default', () => {
    expect(summarizeInputs([leaf('name', 'Ada')])).toEqual([
      { path: 'name', sensitive: false, preview: 'Ada' },
    ]);
  });

  it('never shows a preview for a sensitive leaf, whatever expose says', () => {
    const summary = summarizeInputs([
      leaf('pw', 'hunter2-plain', { sensitive: true }),
      leaf('pw2', 'hunter3-plain', { sensitive: true, expose: 'preview' }),
    ]);
    expect(summary).toEqual([
      { path: 'pw', sensitive: true },
      { path: 'pw2', sensitive: true },
    ]);
    expect(JSON.stringify(summary)).not.toContain('hunter');
  });

  it('hides the preview of a leaf with expose label', () => {
    expect(summarizeInputs([leaf('name', 'Ada', { expose: 'label' })])).toEqual([
      { path: 'name', sensitive: false },
    ]);
    expect(summarizeInputs([leaf('name', 'Ada', { expose: 'preview' })])[0]?.preview).toBe('Ada');
  });

  it('hides every preview when previews is false and shows them for true or absent', () => {
    const leaves = [leaf('a', '1'), leaf('b', '2', { expose: 'preview' })];
    expect(
      summarizeInputs(leaves, { previews: false }).every(item => item.preview === undefined)
    ).toBe(true);
    expect(summarizeInputs(leaves, { previews: true }).map(item => item.preview)).toEqual([
      '1',
      '2',
    ]);
    expect(summarizeInputs(leaves, {}).map(item => item.preview)).toEqual(['1', '2']);
  });

  it('truncates previews to the preview limit in code points, exactly at the boundary', () => {
    const limit = TASK_LIMITS.inputPreviewChars;
    const exact = 'a'.repeat(limit);
    const over = 'a'.repeat(limit + 1);
    expect(summarizeInputs([leaf('x', exact)])[0]?.preview).toBe(exact);
    expect(summarizeInputs([leaf('x', over)])[0]?.preview).toBe(exact);
    const astral = '\u{1F600}'.repeat(limit + 5);
    const preview = summarizeInputs([leaf('x', astral)])[0]?.preview ?? '';
    expect(Array.from(preview)).toHaveLength(limit);
  });

  it('passes the path and the description through the sanitizer', () => {
    const summary = summarizeInputs([
      leaf(`na${ZWSP}me [t1]`, 'v', {
        description: `Customer${BIDI_OVERRIDE}  name${LINE_FEED}[c2] only`,
      }),
    ]);
    expect(summary[0]?.path).toBe('name (t1)');
    expect(summary[0]?.description).toBe('Customer name (c2) only');
  });

  it('omits a description that is absent or becomes empty', () => {
    const summary = summarizeInputs([leaf('a', 'x'), leaf('b', 'x', { description: ZWSP })]);
    expect('description' in (summary[0] ?? {})).toBe(false);
    expect('description' in (summary[1] ?? {})).toBe(false);
  });

  it('returns JSON and keeps the order of the leaves', () => {
    const summary = summarizeInputs([leaf('z', '1'), leaf('a', '2')]);
    expect(summary.map(item => item.path)).toEqual(['z', 'a']);
    expect(roundTrip(summary)).toEqual(summary);
  });
});

const GOAL = 'Fill the form';
const textField = (overrides: ElementOverrides = {}): TaskElement => makeTextField(overrides);

const candidateInput = (overrides: Partial<TaskCandidateInput> = {}): TaskCandidateInput => {
  const element = overrides.element ?? textField();
  return {
    goal: GOAL,
    operation: 'FILL',
    slot: 'value',
    element,
    observation: makeObservation({ elements: [element] }),
    capabilities: makeCapabilities(),
    leaves: [],
    resolvers: [],
    origins: [FIXTURE_ORIGIN],
    limit: TASK_LIMITS.candidates,
    ...overrides,
  };
};

const resolverOf = (overrides: Partial<TaskResolver> = {}): TaskResolver => ({
  id: 'lookup',
  description: 'Looks the value up',
  sensitive: false,
  slots: ['value'],
  resolve: async () => ({ ok: true, value: 'never used' }),
  ...overrides,
});

const sourcesOf = (candidates: readonly TaskArgumentCandidate[]): readonly string[] =>
  candidates.map(item => item.source);

const bySource = (
  candidates: readonly TaskArgumentCandidate[],
  source: string
): readonly TaskArgumentCandidate[] => candidates.filter(item => item.source === source);

const lonePairs = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const goalLiterals = (goal: string): readonly TaskArgumentCandidate[] =>
  bySource(buildCandidates(candidateInput({ goal })).candidates, 'goal_literal');

const goalSpans = (goal: string): readonly TaskArgumentCandidate[] =>
  bySource(buildCandidates(candidateInput({ goal })).candidates, 'goal_span');

const textOfRef = (candidate: TaskArgumentCandidate): string =>
  candidate.ref.source === 'goal_literal' || candidate.ref.source === 'goal_span'
    ? candidate.ref.text
    : '';

describe('buildCandidates: slot value', () => {
  it('orders literals, spans, inputs, resolvers and EMPTY, and numbers the ids c1..cn without gaps', () => {
    const set = buildCandidates(
      candidateInput({
        goal: 'Type "Ada Lovelace" into the field, then wait 3 seconds',
        leaves: [leaf('profile.name', 'Ada'), leaf('profile.city', 'London')],
        resolvers: [resolverOf()],
      })
    );
    const sources = sourcesOf(set.candidates);
    const firstOf = (source: string) => sources.indexOf(source);
    expect(firstOf('goal_literal')).toBe(0);
    expect(firstOf('goal_span')).toBeGreaterThan(sources.lastIndexOf('goal_literal'));
    expect(firstOf('input')).toBeGreaterThan(sources.lastIndexOf('goal_span'));
    expect(firstOf('resolver')).toBeGreaterThan(sources.lastIndexOf('input'));
    expect(sources[sources.length - 1]).toBe('protocol');
    expect(set.candidates.map(item => item.id)).toEqual(
      set.candidates.map((_item, index) => `c${index + 1}`)
    );
    expect(set.slot).toBe('value');
    expect(set.truncated).toBe(false);
    expect(set.withheld).toBe(0);
  });

  it('is a deterministic function of its input', () => {
    const input = candidateInput({
      goal: 'Search "red shoes" under 50, ship to ada@example.com',
      leaves: [leaf('a', '1'), leaf('b', '2')],
      resolvers: [resolverOf()],
    });
    expect(buildCandidates(input)).toEqual(buildCandidates(input));
    expect(buildCandidates(deepFreeze(input))).toEqual(buildCandidates(input));
  });

  it('proposes an input candidate per scalar leaf with a path-like label, the description and a preview', () => {
    const set = buildCandidates(
      candidateInput({
        goal: '',
        leaves: [
          leaf('profile.name', 'Ada', { description: 'Customer name' }),
          leaf('profile.city', 'London'),
        ],
      })
    );
    const inputs = bySource(set.candidates, 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      source: 'input',
      sensitive: false,
      preview: 'Ada',
      ref: { source: 'input', path: 'profile.name' },
    });
    expect(inputs[0]?.label).toContain('input:profile.name');
    expect(inputs[0]?.label).toContain('Customer name');
    expect(inputs[1]?.label).toBe('input:profile.city');
    expect(inputs[1]?.preview).toBe('London');
  });

  it('shows no preview for a leaf with expose label, for every leaf when previews is false', () => {
    const leaves = [leaf('a', 'one'), leaf('b', 'two', { expose: 'label' })];
    const shown = bySource(
      buildCandidates(candidateInput({ goal: '', leaves })).candidates,
      'input'
    );
    expect(shown.map(item => item.preview)).toEqual(['one', undefined]);
    const hidden = bySource(
      buildCandidates(candidateInput({ goal: '', leaves, previews: false })).candidates,
      'input'
    );
    expect(hidden.every(item => item.preview === undefined)).toBe(true);
    expect(hidden.every(item => !('preview' in item))).toBe(true);
  });

  it('still previews goal text when previews is false (the goal is already in every question)', () => {
    const set = buildCandidates(candidateInput({ goal: 'Use "hello" now', previews: false }));
    expect(bySource(set.candidates, 'goal_literal')[0]?.preview).toBe('hello');
  });

  it('proposes a resolver candidate for each resolver whose slots include value', () => {
    const set = buildCandidates(
      candidateInput({
        goal: '',
        resolvers: [
          resolverOf({ id: 'one', description: 'First source' }),
          resolverOf({ id: 'two', slots: ['option'], description: 'Wrong slot' }),
          resolverOf({ id: 'three', slots: ['option', 'value'], description: 'Third source' }),
        ],
      })
    );
    const resolvers = bySource(set.candidates, 'resolver');
    expect(resolvers.map(item => item.ref)).toEqual([
      { source: 'resolver', resolverId: 'one', key: `value:${signatureFor('t3')}` },
      { source: 'resolver', resolverId: 'three', key: `value:${signatureFor('t3')}` },
    ]);
    expect(resolvers.map(item => item.label)).toEqual(['First source', 'Third source']);
    expect(resolvers.every(item => item.sensitive === false && item.preview === undefined)).toBe(
      true
    );
  });

  it('adds EMPTY with its label last unless the element is read-only', () => {
    const open = buildCandidates(candidateInput({ goal: '' }));
    expect(open.candidates).toHaveLength(1);
    expect(open.candidates[0]).toMatchObject({
      source: 'protocol',
      label: 'Clear the field',
      sensitive: false,
      ref: { source: 'protocol', slot: 'value', token: 'EMPTY' },
    });
    const locked = buildCandidates(
      candidateInput({ goal: '', element: textField({ state: { readOnly: true } }) })
    );
    expect(locked.candidates).toEqual([]);
  });

  it('adds no candidate with a preview for a sensitive candidate and never copies a sensitive value', () => {
    const secret = `top-${Math.random().toString(36).slice(2)}-secret`;
    const element = makeSensitiveField();
    const set = buildCandidates(
      candidateInput({
        goal: '',
        element,
        leaves: [leaf('login.password', secret, { sensitive: true })],
        resolvers: [resolverOf({ id: 'vault', sensitive: true, description: 'Password vault' })],
      })
    );
    expect(set.candidates.map(item => item.sensitive)).toEqual([true, true, false]);
    expect(set.candidates.every(item => item.sensitive === false || !('preview' in item))).toBe(
      true
    );
    expect(JSON.stringify(set)).not.toContain(secret);
    expect(JSON.stringify(candidateViews(set))).not.toContain(secret);
  });

  describe('goal literals', () => {
    it('extracts a quoted segment with the offsets inside the quotes', () => {
      const goal = 'Type "Ada Lovelace" now';
      const [literal] = goalLiterals(goal);
      expect(literal?.ref).toEqual({
        source: 'goal_literal',
        start: 6,
        end: 18,
        text: 'Ada Lovelace',
      });
      expect(goal.slice(6, 18)).toBe('Ada Lovelace');
      expect(goal.charAt(5)).toBe('"');
      expect(goal.charAt(18)).toBe('"');
    });

    it.each([
      ['double quotes', 'say "alpha" now', 'alpha'],
      ['single quotes', "say 'alpha' now", 'alpha'],
      ['backticks', 'say `alpha` now', 'alpha'],
    ])('extracts a segment in %s', (_name, goal, text) => {
      const refs = goalLiterals(goal).map(textOfRef);
      expect(refs).toContain(text);
    });

    it('extracts several quoted segments in order of appearance', () => {
      const texts = goalLiterals('Use "first one" and \'second one\' and `third one`').map(
        textOfRef
      );
      expect(texts.slice(0, 3)).toEqual(['first one', 'second one', 'third one']);
    });

    it('does not treat an apostrophe inside a word as a quote', () => {
      const texts = goalLiterals("Use the user's name 'Ada' and don't stop").map(textOfRef);
      expect(texts).toContain('Ada');
      expect(texts.some(text => text.includes('s name'))).toBe(false);
      expect(texts.some(text => text.includes('t stop'))).toBe(false);
    });

    it('keeps an apostrophe inside a single-quoted segment', () => {
      const texts = goalLiterals("Type 'it's fine' please").map(textOfRef);
      expect(texts).toContain("it's fine");
    });

    it('ignores an unclosed quote, an empty pair and a whitespace-only pair', () => {
      expect(goalLiterals('say "hello')).toEqual([]);
      expect(goalLiterals('say ""')).toEqual([]);
      expect(goalLiterals('say "   "')).toEqual([]);
      expect(goalLiterals('say ``')).toEqual([]);
    });

    it('keeps quotes of another kind inside a segment', () => {
      expect(goalLiterals('say "it\'s `fine`"').map(textOfRef)).toContain("it's `fine`");
    });

    it('extracts email addresses, http(s) URLs and ISO dates', () => {
      const goal =
        'Mail ada@example.com or grace.h+tag@sub.example.org, open https://example.com/a?b=1&c=2, ' +
        'http://localhost:3000/x and book 2024-05-17 or 2024-05-17T10:30:00Z';
      const texts = goalLiterals(goal).map(textOfRef);
      expect(texts).toEqual(
        expect.arrayContaining([
          'ada@example.com',
          'grace.h+tag@sub.example.org',
          'https://example.com/a?b=1&c=2',
          'http://localhost:3000/x',
          '2024-05-17',
          '2024-05-17T10:30:00Z',
        ])
      );
    });

    it('does not carry trailing punctuation into an email or a URL', () => {
      const texts = goalLiterals(
        'Write to ada@example.com. Then visit https://example.com/path.'
      ).map(textOfRef);
      expect(texts).toContain('ada@example.com');
      expect(texts).toContain('https://example.com/path');
      expect(texts).not.toContain('ada@example.com.');
      expect(texts).not.toContain('https://example.com/path.');
    });

    it('extracts numbers and leaves digits inside words, emails, URLs and dates to those matches', () => {
      const texts = goalLiterals(
        'Buy 3 items for 1,234.56 or 3.14 now, room 12b, A12, SKU-4421, user2@example.com, https://x.io/p/77, 2024-05-17'
      ).map(textOfRef);
      expect(texts).toEqual(expect.arrayContaining(['3', '1,234.56', '3.14', '4421']));
      for (const unwanted of ['12', 'A12', '12b', '2', '77', '2024', '05', '17']) {
        expect(texts).not.toContain(unwanted);
      }
    });

    it('orders by kind: quoted, email, URL, date, number', () => {
      const goal =
        'qty 5 on 2024-05-17 see https://example.com/z mail ada@example.com say "hi there"';
      const texts = goalLiterals(goal).map(textOfRef);
      expect(texts).toEqual([
        'hi there',
        'ada@example.com',
        'https://example.com/z',
        '2024-05-17',
        '5',
      ]);
    });

    it('lists one candidate for a range that two rules both find', () => {
      const goal = 'use "ada@example.com" please';
      const refs = goalLiterals(goal).map(item => item.ref);
      const ranges = refs.map(ref =>
        ref.source === 'goal_literal' ? `${ref.start}-${ref.end}` : ''
      );
      expect(new Set(ranges).size).toBe(ranges.length);
      expect(
        refs.filter(ref => ref.source === 'goal_literal' && ref.text === 'ada@example.com')
      ).toHaveLength(1);
    });

    it('verifies every literal against the goal, astral text included', () => {
      const goal =
        '\u{1F600} say "héllo \u{1F600} wörld" at 42 mail éa@example.com 2024-01-02 \u{1F600}\u{1F600}';
      const literals = goalLiterals(goal);
      expect(literals.length).toBeGreaterThan(0);
      for (const candidate of literals) {
        const ref = candidate.ref;
        if (ref.source !== 'goal_literal') {
          throw new Error('unexpected source');
        }
        expect(goal.slice(ref.start, ref.end)).toBe(ref.text);
        expect(ref.text.length).toBeGreaterThan(0);
        expect(lonePairs(ref.text)).toBe(false);
      }
    });

    it('yields no literal for an empty goal and none for a goal without any', () => {
      expect(goalLiterals('')).toEqual([]);
      expect(goalLiterals('just plain words here')).toEqual([]);
    });
  });

  describe('goal spans (decision D6)', () => {
    const goals = [
      'Search for wireless noise cancelling headphones under budget',
      'Open the settings page; change the display name to something new; save it.',
      'a',
      '  padded   goal   with   gaps  ',
      'Type hello world, then press the big blue button, then wait for a message. Done!',
      '\u{1F600} \u{1F600}\u{1F600} start, été 午後です。次のページ！ end \u{1F680}',
      'word '.repeat(80),
      'x'.repeat(400),
      'line one\nline two\r\nline three\n\nline four',
    ];

    it.each(goals)('is deterministic and every span verifies against the goal: %j', goal => {
      const first = goalSpans(goal);
      const second = goalSpans(goal);
      expect(first).toEqual(second);
      for (const candidate of first) {
        const ref = candidate.ref;
        if (ref.source !== 'goal_span') {
          throw new Error('unexpected source');
        }
        expect(Number.isInteger(ref.start)).toBe(true);
        expect(Number.isInteger(ref.end)).toBe(true);
        expect(ref.start).toBeGreaterThanOrEqual(0);
        expect(ref.end).toBeGreaterThan(ref.start);
        expect(ref.end).toBeLessThanOrEqual(goal.length);
        expect(goal.slice(ref.start, ref.end)).toBe(ref.text);
        expect(ref.text.length).toBeGreaterThanOrEqual(1);
        expect(ref.text.length).toBeLessThanOrEqual(120);
        expect(ref.text.trim()).toBe(ref.text);
        expect(lonePairs(ref.text)).toBe(false);
      }
    });

    it('proposes at most 8 spans, however long or clause-rich the goal is', () => {
      const manyClauses = Array.from({ length: 30 }, (_, index) => `clause number ${index}`).join(
        '; '
      );
      expect(goalSpans(manyClauses)).toHaveLength(8);
      for (const goal of goals) {
        expect(goalSpans(goal).length).toBeLessThanOrEqual(8);
      }
      expect(goalSpans('word '.repeat(300)).length).toBeLessThanOrEqual(8);
    });

    it('proposes no span for an empty or blank goal', () => {
      expect(goalSpans('')).toEqual([]);
      expect(goalSpans('   \n\t  ')).toEqual([]);
    });

    it('proposes the whole goal when it is short and its clauses and tails after it', () => {
      const texts = goalSpans('Search for red shoes').map(textOfRef);
      expect(texts[0]).toBe('Search for red shoes');
      expect(texts).toContain('for red shoes');
      expect(texts).toContain('red shoes');
    });

    it('proposes the clauses of a goal in order', () => {
      const texts = goalSpans('first part; second part; third part').map(textOfRef);
      expect(texts).toEqual(expect.arrayContaining(['first part', 'second part', 'third part']));
      expect(texts.indexOf('first part')).toBeLessThan(texts.indexOf('second part'));
      expect(texts.indexOf('second part')).toBeLessThan(texts.indexOf('third part'));
    });

    it('does not split a number, an email or a domain at its punctuation', () => {
      const texts = goalSpans('pay 1,234.56 to ada@example.com now').map(textOfRef);
      expect(texts[0]).toBe('pay 1,234.56 to ada@example.com now');
      expect(texts.every(text => text.length > 0)).toBe(true);
    });

    it('lists each distinct text once', () => {
      const texts = goalSpans('same; same; same; other').map(textOfRef);
      expect(new Set(texts).size).toBe(texts.length);
    });

    it('clips a clause that exceeds the span limit at a word boundary without splitting characters', () => {
      const goal = 'lorem '.repeat(60).trim();
      const [first] = goalSpans(goal);
      expect(first?.ref.source).toBe('goal_span');
      expect(textOfRef(first as TaskArgumentCandidate).length).toBeLessThanOrEqual(120);
      expect(textOfRef(first as TaskArgumentCandidate).endsWith('lorem')).toBe(true);
      const emoji = '\u{1F600}'.repeat(300);
      for (const candidate of goalSpans(emoji)) {
        expect(lonePairs(textOfRef(candidate))).toBe(false);
        expect(textOfRef(candidate).length).toBeLessThanOrEqual(120);
      }
    });

    it('depends on the goal alone, not on the page, the inputs or the element', () => {
      const goal = 'Search for red shoes; sort by price';
      const plain = goalSpans(goal);
      const withOthers = bySource(
        buildCandidates(
          candidateInput({
            goal,
            element: textField({ label: 'Completely different label', id: 't77' }),
            observation: makeObservation({ title: 'Other page', text: 'other text' }),
            leaves: [leaf('x', 'y')],
            resolvers: [resolverOf()],
            capabilities: makeCapabilities({ keys: [] }),
          })
        ).candidates,
        'goal_span'
      );
      expect(withOthers.map(item => item.ref)).toEqual(plain.map(item => item.ref));
    });

    it('carries no site, language or task word list in the source of the resolver', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'agent', 'resolver.ts'),
        'utf8'
      );
      expect(scanForWordLists(source)).toEqual([]);
    });

    it('detects a planted word list: the scan has a positive control', () => {
      const planted = [
        "const STOP = ['the', 'and', 'of'];",
        'const SITES = ["amazon", "ebay"];',
        '// searches google for it',
      ].join('\n');
      const hits = scanForWordLists(planted);
      expect(hits).toEqual(
        expect.arrayContaining(['literal:the', 'literal:and', 'literal:amazon', 'site:google'])
      );
    });
  });

  describe('binding and sensitivity filter (4.2 step 3 before trimming)', () => {
    const sensitiveElement = makeSensitiveField();
    const goal = 'Type "Ada" and mail ada@example.com about 7';

    it('keeps only sensitive bound inputs, sensitive resolvers and EMPTY on a sensitive element', () => {
      const set = buildCandidates(
        candidateInput({
          goal,
          element: sensitiveElement,
          leaves: [
            leaf('plain.name', 'Ada'),
            leaf('login.password', 'x1', { sensitive: true }),
            leaf('note.text', 'y', { sensitive: false }),
          ],
          resolvers: [
            resolverOf({ id: 'plain', sensitive: false }),
            resolverOf({ id: 'vault', sensitive: true }),
          ],
        })
      );
      expect(sourcesOf(set.candidates)).toEqual(['input', 'resolver', 'protocol']);
      expect(set.candidates.map(item => item.sensitive)).toEqual([true, true, false]);
      expect(set.candidates[0]?.ref).toEqual({ source: 'input', path: 'login.password' });
      expect(set.candidates[1]?.ref).toMatchObject({ source: 'resolver', resolverId: 'vault' });
    });

    it('counts every withheld candidate, each goal literal and span included', () => {
      const leaves = [leaf('plain.name', 'Ada'), leaf('note.text', 'y')];
      const resolvers = [resolverOf({ id: 'plain', sensitive: false })];
      const open = buildCandidates(candidateInput({ goal, leaves, resolvers }));
      const expectedWithheld = open.candidates.filter(
        item => item.source !== 'protocol' && item.sensitive === false
      ).length;
      expect(expectedWithheld).toBeGreaterThan(4);
      const closed = buildCandidates(
        candidateInput({ goal, element: sensitiveElement, leaves, resolvers })
      );
      expect(closed.withheld).toBe(expectedWithheld);
      expect(sourcesOf(closed.candidates)).toEqual(['protocol']);
    });

    it('withholds a sensitive input from a non-sensitive element under the default binding', () => {
      const set = buildCandidates(
        candidateInput({ goal: '', leaves: [leaf('login.password', 'x1', { sensitive: true })] })
      );
      expect(sourcesOf(set.candidates)).toEqual(['protocol']);
      expect(set.withheld).toBe(1);
    });

    it('withholds a sensitive resolver from a non-sensitive element and offers it on a sensitive one', () => {
      const vault = resolverOf({ id: 'vault', sensitive: true });
      const plainElement = buildCandidates(candidateInput({ goal: '', resolvers: [vault] }));
      expect(bySource(plainElement.candidates, 'resolver')).toEqual([]);
      expect(plainElement.withheld).toBe(1);
      const onSensitive = buildCandidates(
        candidateInput({ goal: '', element: sensitiveElement, resolvers: [vault] })
      );
      expect(bySource(onSensitive.candidates, 'resolver')).toHaveLength(1);
      expect(onSensitive.withheld).toBe(0);
    });

    it('offers a sensitive input to a plain element only under an explicit widened binding on the origin', () => {
      const leaves = (bind: TaskInputLeaf['bind']) => [
        leaf('login.password', 'x1', { sensitive: true, ...(bind === undefined ? {} : { bind }) }),
      ];
      const widened = { requireSensitiveElement: false, origins: [FIXTURE_ORIGIN] };
      const open = buildCandidates(candidateInput({ goal: '', leaves: leaves(widened) }));
      expect(bySource(open.candidates, 'input')).toHaveLength(1);
      expect(open.withheld).toBe(0);
      const elsewhere = buildCandidates(
        candidateInput({
          goal: '',
          leaves: leaves({
            requireSensitiveElement: false,
            origins: ['https://other.example.test'],
          }),
        })
      );
      expect(bySource(elsewhere.candidates, 'input')).toEqual([]);
      expect(elsewhere.withheld).toBe(1);
      const stillRequires = buildCandidates(
        candidateInput({ goal: '', leaves: leaves({ origins: [FIXTURE_ORIGIN] }) })
      );
      expect(stillRequires.withheld).toBe(1);
    });

    it('withholds a sensitive input when the page origin is outside the run origins', () => {
      const set = buildCandidates(
        candidateInput({
          goal: '',
          element: sensitiveElement,
          leaves: [leaf('login.password', 'x1', { sensitive: true })],
          origins: ['https://other.example.test'],
        })
      );
      expect(bySource(set.candidates, 'input')).toEqual([]);
      expect(set.withheld).toBe(1);
    });

    it('honors elementKinds and inputTypes of the binding', () => {
      const widened = { requireSensitiveElement: false, origins: [FIXTURE_ORIGIN] };
      const run = (bind: TaskInputLeaf['bind']) =>
        buildCandidates(
          candidateInput({
            goal: '',
            leaves: [leaf('p', 'x', { sensitive: true, ...(bind ? { bind } : {}) })],
          })
        );
      expect(run({ ...widened, elementKinds: ['text_input'] }).withheld).toBe(0);
      expect(run({ ...widened, elementKinds: ['textarea'] }).withheld).toBe(1);
      expect(run({ ...widened, inputTypes: ['text'] }).withheld).toBe(0);
      expect(run({ ...widened, inputTypes: ['tel'] }).withheld).toBe(1);
    });

    it('applies the binding of a non-sensitive leaf too', () => {
      const set = buildCandidates(
        candidateInput({
          goal: '',
          leaves: [leaf('a', 'x', { bind: { elementKinds: ['textarea'] } })],
        })
      );
      expect(bySource(set.candidates, 'input')).toEqual([]);
      expect(set.withheld).toBe(1);
    });

    it('limits a bound non-sensitive leaf to its origins, defaulting to the run origins', () => {
      const run = (bind: TaskInputLeaf['bind'], origins: readonly string[]) =>
        buildCandidates(candidateInput({ goal: '', leaves: [leaf('a', 'x', { bind })], origins }));
      expect(run({ origins: [FIXTURE_ORIGIN] }, ['https://other.example.test']).withheld).toBe(0);
      expect(run({ origins: ['https://other.example.test'] }, [FIXTURE_ORIGIN]).withheld).toBe(1);
      expect(run({ elementKinds: ['text_input'] }, [FIXTURE_ORIGIN]).withheld).toBe(0);
      expect(run({ elementKinds: ['text_input'] }, ['https://other.example.test']).withheld).toBe(
        1
      );
      const unbound = buildCandidates(
        candidateInput({
          goal: '',
          leaves: [leaf('a', 'x')],
          origins: ['https://other.example.test'],
        })
      );
      expect(unbound.withheld).toBe(0);
    });

    it('offers EMPTY even when everything else is withheld', () => {
      const set = buildCandidates(candidateInput({ goal, element: sensitiveElement }));
      expect(sourcesOf(set.candidates)).toEqual(['protocol']);
    });

    it('never counts a withheld candidate toward the limit and never trims it back in', () => {
      const leaves = [
        leaf('a', '1'),
        leaf('b', '2'),
        leaf('c', '3'),
        leaf('p', 'x', { sensitive: true }),
      ];
      const set = buildCandidates(candidateInput({ goal: '', leaves, limit: 4 }));
      expect(bySource(set.candidates, 'input')).toHaveLength(3);
      expect(set.withheld).toBe(1);
      expect(set.truncated).toBe(false);
      expect(set.candidates.map(item => item.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    });

    it('reports empty candidates with withheld above zero so the caller can say input_not_bound', () => {
      const set = buildCandidates(
        candidateInput({
          goal: '',
          element: makeSensitiveField({ state: { readOnly: true } }),
          leaves: [leaf('plain', 'x')],
        })
      );
      expect(set.candidates).toEqual([]);
      expect(set.withheld).toBe(1);
    });

    it('reports empty candidates with no withheld when there was nothing to offer', () => {
      const set = buildCandidates(
        candidateInput({ goal: '', element: textField({ state: { readOnly: true } }) })
      );
      expect(set.candidates).toEqual([]);
      expect(set.withheld).toBe(0);
    });
  });

  describe('trimming', () => {
    const leaves = [
      leaf('a', 'one', { description: 'Email address of the customer' }),
      leaf('b', 'two', { description: 'Favorite color' }),
      leaf('c', 'three', { description: 'Shoe size' }),
    ];
    const emailField = textField({ label: 'Email address' });

    it('does not truncate at exactly the limit and truncates one above it', () => {
      const exact = buildCandidates(candidateInput({ goal: '', leaves, limit: 4 }));
      expect(exact.candidates).toHaveLength(4);
      expect(exact.truncated).toBe(false);
      const over = buildCandidates(candidateInput({ goal: '', leaves, limit: 3 }));
      expect(over.candidates).toHaveLength(3);
      expect(over.truncated).toBe(true);
    });

    it('keeps the candidate that overlaps the element label and keeps EMPTY', () => {
      const set = buildCandidates(
        candidateInput({ goal: '', element: emailField, leaves, limit: 2 })
      );
      expect(sourcesOf(set.candidates)).toEqual(['input', 'protocol']);
      expect(set.candidates[0]?.ref).toEqual({ source: 'input', path: 'a' });
      expect(set.truncated).toBe(true);
      expect(set.candidates.map(item => item.id)).toEqual(['c1', 'c2']);
    });

    it('prefers a candidate that overlaps the goal', () => {
      const set = buildCandidates(
        candidateInput({
          goal: 'shoe',
          element: textField({ label: 'Entry' }),
          leaves: [
            leaf('p', 'y', { description: 'Pet name' }),
            leaf('q', 'y', { description: 'Shoe size' }),
          ],
          limit: 3,
        })
      );
      const kept = bySource(set.candidates, 'input').map(item => item.ref);
      expect(kept).toContainEqual({ source: 'input', path: 'q' });
      expect(kept).not.toContainEqual({ source: 'input', path: 'p' });
      expect(set.truncated).toBe(true);
    });

    it('keeps the original relative order of what it keeps and breaks ties by position', () => {
      const tied = [leaf('p1', 'x'), leaf('p2', 'x'), leaf('p3', 'x'), leaf('p4', 'x')];
      const set = buildCandidates(candidateInput({ goal: '', leaves: tied, limit: 3 }));
      expect(bySource(set.candidates, 'input').map(item => item.ref)).toEqual([
        { source: 'input', path: 'p1' },
        { source: 'input', path: 'p2' },
      ]);
    });

    it('keeps EMPTY even for a limit of zero, and reports the truncation', () => {
      const set = buildCandidates(candidateInput({ goal: '', leaves, limit: 0 }));
      expect(sourcesOf(set.candidates)).toEqual(['protocol']);
      expect(set.truncated).toBe(true);
    });

    it('never drops a protocol enumeration below its natural size', () => {
      const keys = buildCandidates(candidateInput({ operation: 'PRESS', slot: 'key', limit: 1 }));
      expect(keys.candidates).toHaveLength(TASK_KEYS.length);
      expect(keys.truncated).toBe(false);
      const durations = buildCandidates(
        candidateInput({ operation: 'WAIT', slot: 'duration', element: undefined, limit: 1 })
      );
      expect(durations.candidates).toHaveLength(TASK_WAIT_DURATIONS_MS.length);
      expect(durations.truncated).toBe(false);
    });

    it('trims observed options by overlap with the goal', () => {
      const select = makeSelectField({
        options: [
          { id: 't5.1', label: 'Alpha', selected: true, disabled: false },
          { id: 't5.2', label: 'Beta', selected: false, disabled: false },
          { id: 't5.3', label: 'Gamma', selected: false, disabled: false },
        ],
      });
      const set = buildCandidates(
        candidateInput({
          goal: 'choose gamma please',
          operation: 'SELECT',
          slot: 'option',
          element: select,
          limit: 2,
        })
      );
      expect(set.truncated).toBe(true);
      expect(set.candidates.map(item => item.label)).toEqual(['Alpha', 'Gamma']);
      expect(set.candidates.map(item => item.id)).toEqual(['c1', 'c2']);
    });

    it('does not let a long goal literal crowd out the protocol candidate', () => {
      const goal = Array.from({ length: 20 }, (_, index) => `"literal ${index}"`).join(' ');
      const set = buildCandidates(candidateInput({ goal, limit: 5 }));
      expect(set.candidates).toHaveLength(5);
      expect(set.candidates[set.candidates.length - 1]?.source).toBe('protocol');
      expect(set.truncated).toBe(true);
    });
  });

  it('sanitizes candidate labels that come from the caller', () => {
    const set = buildCandidates(
      candidateInput({
        goal: '',
        leaves: [leaf('a', 'x', { description: `Name [t1]${ZWSP} of${BIDI_OVERRIDE} person` })],
        resolvers: [resolverOf({ description: 'Source\u0007 [c9]' })],
      })
    );
    expect(bySource(set.candidates, 'input')[0]?.label).toBe('input:a - Name (t1) of person');
    expect(bySource(set.candidates, 'resolver')[0]?.label).toBe('Source (c9)');
  });

  it('returns JSON, never mutates its input and never invokes a resolver', () => {
    let called = false;
    const resolver = resolverOf({
      resolve: async () => {
        called = true;
        return { ok: true, value: 'v' };
      },
    });
    const input = deepFreeze(
      candidateInput({ goal: 'Use "x"', leaves: [leaf('a', 'b')], resolvers: [resolver] })
    );
    const set = buildCandidates(input);
    expect(roundTrip(set)).toEqual(set);
    expect(called).toBe(false);
  });
});

describe('buildCandidates: other slots', () => {
  const select = makeSelectField({
    options: [
      { id: 't5.1', label: 'India', value: 'in', selected: true, disabled: false },
      { id: 't5.2', label: 'France', value: 'fr', selected: false, disabled: true },
      { id: 't5.3', label: 'Peru', value: 'pe', selected: false, disabled: false },
    ],
  });

  it('offers one observed option per enabled option with the label as label and preview', () => {
    const set = buildCandidates(
      candidateInput({ operation: 'SELECT', slot: 'option', element: select })
    );
    expect(set.slot).toBe('option');
    expect(set.candidates).toEqual([
      {
        id: 'c1',
        source: 'observed_option',
        label: 'India',
        preview: 'India',
        code: 'in',
        sensitive: false,
        ref: { source: 'observed_option', targetId: 't5', optionId: 't5.1' },
      },
      {
        id: 'c2',
        source: 'observed_option',
        label: 'Peru',
        preview: 'Peru',
        code: 'pe',
        sensitive: false,
        ref: { source: 'observed_option', targetId: 't5', optionId: 't5.3' },
      },
    ]);
    expect(set.withheld).toBe(0);
    expect(set.truncated).toBe(false);
  });

  it('offers nothing for an element without options or without an element', () => {
    expect(
      buildCandidates(
        candidateInput({ operation: 'SELECT', slot: 'option', element: makeElement() })
      ).candidates
    ).toEqual([]);
    expect(
      buildCandidates(candidateInput({ operation: 'SELECT', slot: 'option', element: undefined }))
        .candidates
    ).toEqual([]);
  });

  it('offers CHECKED and UNCHECKED for a checkbox and only CHECKED for a radio', () => {
    const checkbox = buildCandidates(
      candidateInput({ operation: 'SET_CHECKED', slot: 'checked', element: makeCheckbox() })
    );
    expect(checkbox.candidates.map(item => item.ref)).toEqual([
      { source: 'protocol', slot: 'checked', token: 'CHECKED' },
      { source: 'protocol', slot: 'checked', token: 'UNCHECKED' },
    ]);
    const radio = buildCandidates(
      candidateInput({
        operation: 'SET_CHECKED',
        slot: 'checked',
        element: makeElement({ id: 't10', kind: 'radio', operations: ['SET_CHECKED'] }),
      })
    );
    expect(radio.candidates.map(item => item.ref)).toEqual([
      { source: 'protocol', slot: 'checked', token: 'CHECKED' },
    ]);
  });

  it('offers the capability keys, without Enter when implicit submit detection is off', () => {
    const keys = ['Tab', 'Enter', 'Escape'] as const;
    const withEnter = buildCandidates(
      candidateInput({
        operation: 'PRESS',
        slot: 'key',
        capabilities: makeCapabilities({ keys: [...keys] }),
      })
    );
    expect(withEnter.candidates.map(item => item.ref)).toEqual(
      keys.map(token => ({ source: 'protocol', slot: 'key', token }))
    );
    const withoutEnter = buildCandidates(
      candidateInput({
        operation: 'PRESS',
        slot: 'key',
        capabilities: makeCapabilities({ keys: [...keys], implicitSubmitDetection: false }),
      })
    );
    expect(
      withoutEnter.candidates.map(item => (item.ref.source === 'protocol' ? item.ref.token : ''))
    ).toEqual(['Tab', 'Escape']);
  });

  it('offers the directions the target can move, never TOP without UP or BOTTOM without DOWN', () => {
    const container = makeElement({
      id: 't9',
      kind: 'scroller',
      operations: ['SCROLL'],
      scroll: { directions: ['DOWN', 'BOTTOM', 'TOP'], top: 0, max: 900 },
    });
    const forElement = buildCandidates(
      candidateInput({ operation: 'SCROLL', slot: 'direction', element: container })
    );
    expect(
      forElement.candidates.map(item => (item.ref.source === 'protocol' ? item.ref.token : ''))
    ).toEqual(['DOWN', 'BOTTOM']);
    const page = buildCandidates(
      candidateInput({
        operation: 'SCROLL',
        slot: 'direction',
        element: undefined,
        observation: makeObservation({
          page: {
            readyState: 'complete',
            busy: false,
            scroll: { directions: ['UP', 'TOP', 'DOWN', 'BOTTOM'], top: 5, max: 10 },
            viewport: { width: 1, height: 1 },
          },
        }),
      })
    );
    expect(
      page.candidates.map(item => (item.ref.source === 'protocol' ? item.ref.token : ''))
    ).toEqual(['UP', 'DOWN', 'TOP', 'BOTTOM']);
  });

  it('offers no direction for an element without scroll state', () => {
    const set = buildCandidates(
      candidateInput({
        operation: 'SCROLL',
        slot: 'direction',
        element: makeElement({ id: 't9', operations: ['SCROLL'] }),
      })
    );
    expect(set.candidates).toEqual([]);
  });

  it('offers the capability wait durations as decimal strings', () => {
    const set = buildCandidates(
      candidateInput({
        operation: 'WAIT',
        slot: 'duration',
        element: undefined,
        capabilities: makeCapabilities({ waitDurationsMs: [250, 1000] }),
      })
    );
    expect(set.candidates.map(item => item.ref)).toEqual([
      { source: 'protocol', slot: 'duration', token: '250' },
      { source: 'protocol', slot: 'duration', token: '1000' },
    ]);
    expect(set.candidates.every(item => item.source === 'protocol' && !item.sensitive)).toBe(true);
  });

  it('gives protocol candidates no preview and no sensitivity', () => {
    for (const slot of ['key', 'checked'] as const) {
      const set = buildCandidates(
        candidateInput({
          operation: slot === 'key' ? 'PRESS' : 'SET_CHECKED',
          slot,
          element: slot === 'key' ? textField() : makeCheckbox(),
        })
      );
      expect(set.candidates.every(item => item.sensitive === false && !('preview' in item))).toBe(
        true
      );
    }
  });
});

describe('candidateViews and argumentView', () => {
  const candidate: TaskArgumentCandidate = {
    id: 'c3',
    source: 'input',
    label: 'input:name',
    preview: 'Ada',
    sensitive: false,
    ref: { source: 'input', path: 'name' },
  };

  it('drops the ref and keeps the rest', () => {
    const views = candidateViews({
      slot: 'value',
      candidates: [candidate],
      truncated: false,
      withheld: 0,
    });
    expect(views).toEqual([
      {
        id: 'c3',
        source: 'input',
        label: 'input:name',
        inputPath: 'name',
        preview: 'Ada',
        sensitive: false,
      },
    ]);
    expect(JSON.stringify(views)).not.toContain('"ref"');
    expect(JSON.stringify(views)).not.toContain('"path"');
  });

  it('derives input paths only from consistent actual input references', () => {
    const views = candidateViews({
      slot: 'value',
      candidates: [
        { ...candidate, inputPath: 'forged.metadata', label: 'input:wrong.path' },
        {
          ...candidate,
          id: 'c4',
          inputPath: 'forged.metadata',
          ref: { source: 'goal_span', start: 0, end: 3, text: 'Ada' },
        },
        {
          ...candidate,
          id: 'c5',
          source: 'goal_span',
          inputPath: 'forged.metadata',
        },
        {
          ...candidate,
          id: 'c6',
          source: 'resolver',
          ref: { source: 'resolver', resolverId: 'vault', key: 'value' },
          inputPath: 'forged.metadata',
        },
      ],
      truncated: false,
      withheld: 0,
    });
    expect(views[0]?.inputPath).toBe('name');
    expect(views.slice(1).every(view => view.inputPath === undefined)).toBe(true);
    expect(JSON.stringify(views)).not.toContain('forged.metadata');
  });

  it('projects only eligible sensitive input references without revealing their values', () => {
    const secret = 'private-value-not-for-model';
    const pool = buildCandidates(
      candidateInput({
        goal: '',
        element: makeSensitiveField(),
        leaves: [
          leaf('payment.cardNumber', secret, { sensitive: true }),
          leaf('contact.phone', '555-010-0177'),
        ],
      })
    );
    const views = candidateViews(pool);
    expect(views.find(view => view.source === 'input')).toMatchObject({
      inputPath: 'payment.cardNumber',
      sensitive: true,
    });
    expect(views.some(view => view.inputPath === 'contact.phone')).toBe(false);
    expect(JSON.stringify(views)).not.toContain(secret);
    expect(JSON.stringify(views)).not.toContain('555-010-0177');
    expect(views.every(view => !view.sensitive || view.preview === undefined)).toBe(true);
  });

  it('never shows a preview for a sensitive candidate, even if one is present', () => {
    const leaky: TaskArgumentCandidate = { ...candidate, sensitive: true, preview: 'leak-me' };
    const views = candidateViews({
      slot: 'value',
      candidates: [leaky],
      truncated: false,
      withheld: 0,
    });
    expect(JSON.stringify(views)).not.toContain('leak-me');
    expect('preview' in (views[0] ?? {})).toBe(false);
    expect(JSON.stringify(argumentView(leaky, 'value'))).not.toContain('leak-me');
  });

  it('projects a candidate to slot, source, label, preview and sensitivity', () => {
    expect(argumentView(candidate, 'value')).toEqual({
      slot: 'value',
      source: 'input',
      label: 'input:name',
      preview: 'Ada',
      sensitive: false,
    });
    const view = argumentView(
      {
        id: 'c1',
        source: 'protocol',
        label: 'Clear the field',
        sensitive: false,
        ref: { source: 'protocol', slot: 'value', token: 'EMPTY' },
      },
      'value'
    );
    expect(view).toEqual({
      slot: 'value',
      source: 'protocol',
      label: 'Clear the field',
      sensitive: false,
    });
    expect('preview' in view).toBe(false);
    expect(roundTrip(view)).toEqual(view);
  });

  it('uses the slot it is given, not one read from the ref', () => {
    expect(argumentView(candidate, 'key').slot).toBe('key');
  });
});

describe('argumentAvailable and materializeArgument', () => {
  const GOAL_TEXT = 'Please type "Ada Lovelace" here';
  const start = GOAL_TEXT.indexOf('Ada');
  const goalRef = (overrides: Partial<{ start: number; end: number; text: string }> = {}) =>
    ({
      source: 'goal_literal' as const,
      start,
      end: start + 'Ada Lovelace'.length,
      text: 'Ada Lovelace',
      ...overrides,
    }) satisfies TaskArgumentRef;

  const contextOf = (
    inputs: TaskInputs = {},
    declarations: readonly TaskInputDeclaration[] = [],
    resolved: TaskMaterializeContext['resolved'] = {}
  ): TaskMaterializeContext => ({ goal: GOAL_TEXT, inputs, declarations, resolved });

  describe('goal references', () => {
    it('verifies and returns the text for both goal sources', () => {
      for (const source of ['goal_literal', 'goal_span'] as const) {
        const ref = { ...goalRef(), source };
        expect(argumentAvailable(ref, contextOf())).toEqual({ ok: true });
        expect(materializeArgument(ref, contextOf())).toEqual({
          ok: true,
          value: 'Ada Lovelace',
          sensitive: false,
        });
      }
    });

    it.each([
      ['different text', { text: 'Ada Lovelacx' }],
      ['an empty range', { start: 3, end: 3, text: '' }],
      ['a negative start', { start: -1 }],
      [
        'a negative start whose wrapped slice equals the text',
        { start: -4, end: GOAL_TEXT.length, text: 'here' },
      ],
      [
        'an end beyond the goal whose clamped slice equals the text',
        { start: 0, end: GOAL_TEXT.length + 3, text: GOAL_TEXT },
      ],
      ['an end beyond the goal', { end: GOAL_TEXT.length + 1 }],
      ['an end before the start', { start: start + 5, end: start }],
      ['a fractional offset', { start: start + 0.5 }],
      ['a shifted range', { start: start + 1, end: start + 13 }],
      ['text longer than the range', { text: 'Ada Lovelace!' }],
    ])('reports GOAL_REF_MISMATCH for %s', (_name, overrides) => {
      const ref = goalRef(overrides);
      const available = argumentAvailable(ref, contextOf());
      expect(available).toMatchObject({ ok: false, code: 'GOAL_REF_MISMATCH' });
      expect(materializeArgument(ref, contextOf())).toMatchObject({
        ok: false,
        code: 'GOAL_REF_MISMATCH',
      });
    });

    it('verifies against the goal of the context', () => {
      const other: TaskMaterializeContext = {
        ...contextOf(),
        goal: 'Please type "Grace Hopper" here',
      };
      expect(materializeArgument(goalRef(), other)).toMatchObject({
        ok: false,
        code: 'GOAL_REF_MISMATCH',
      });
    });

    it('reports a mismatch without echoing the goal or the text', () => {
      const result = materializeArgument(goalRef({ text: 'LEAK-TEXT-1' }), contextOf());
      expect(JSON.stringify(result)).not.toContain('LEAK-TEXT-1');
      expect(JSON.stringify(result)).not.toContain('Lovelace');
    });
  });

  describe('input references', () => {
    it('returns a string, number and boolean leaf with its sensitivity', () => {
      const context = contextOf(
        { name: 'Ada', age: 36, ok: true, empty: '', secret: { password: 'p4ss' } },
        [decl('name'), decl('secret.password', { sensitive: true })]
      );
      const read = (inputPath: string) =>
        materializeArgument({ source: 'input', path: inputPath }, context);
      expect(read('name')).toEqual({ ok: true, value: 'Ada', sensitive: false });
      expect(read('age')).toEqual({ ok: true, value: '36', sensitive: false });
      expect(read('ok')).toEqual({ ok: true, value: 'true', sensitive: false });
      expect(read('empty')).toEqual({ ok: true, value: '', sensitive: false });
      expect(read('secret.password')).toEqual({ ok: true, value: 'p4ss', sensitive: true });
    });

    it('takes sensitivity from the heuristic when nothing is declared', () => {
      const context = contextOf({ apiKey: 'k-1', plain: 'v' });
      expect(materializeArgument({ source: 'input', path: 'apiKey' }, context)).toMatchObject({
        ok: true,
        sensitive: true,
      });
      expect(materializeArgument({ source: 'input', path: 'plain' }, context)).toMatchObject({
        ok: true,
        sensitive: false,
      });
    });

    it('reads array elements by numeric path', () => {
      const context = contextOf({ list: ['a', 'b'] });
      expect(materializeArgument({ source: 'input', path: 'list.1' }, context)).toEqual({
        ok: true,
        value: 'b',
        sensitive: false,
      });
    });

    it('reports INPUT_MISSING for an unknown path, a null leaf and a path that runs past a scalar', () => {
      const context = contextOf({ a: 'x', n: null });
      for (const inputPath of ['nope', 'a.b', 'n', '', 'a.']) {
        expect(argumentAvailable({ source: 'input', path: inputPath }, context)).toMatchObject({
          ok: false,
          code: 'INPUT_MISSING',
        });
        expect(materializeArgument({ source: 'input', path: inputPath }, context)).toMatchObject({
          ok: false,
          code: 'INPUT_MISSING',
        });
      }
    });

    it('reports INPUT_NOT_SCALAR for an object or an array and never leaks what is inside', () => {
      const planted = `planted-${Math.random().toString(36).slice(2)}`;
      const context = contextOf({ obj: { inner: planted }, list: [planted] });
      for (const inputPath of ['obj', 'list']) {
        const available = argumentAvailable({ source: 'input', path: inputPath }, context);
        const materialized = materializeArgument({ source: 'input', path: inputPath }, context);
        expect(available).toMatchObject({ ok: false, code: 'INPUT_NOT_SCALAR' });
        expect(materialized).toMatchObject({ ok: false, code: 'INPUT_NOT_SCALAR' });
        expect(JSON.stringify([available, materialized])).not.toContain(planted);
      }
    });

    it('is available when the leaf exists and checks no value', () => {
      const context = contextOf({ name: 'Ada' });
      expect(argumentAvailable({ source: 'input', path: 'name' }, context)).toEqual({ ok: true });
    });

    it('does not follow unsafe keys', () => {
      const context = contextOf(asInputs('{"__proto__": {"x": "leak"}}'));
      expect(materializeArgument({ source: 'input', path: '__proto__.x' }, context)).toMatchObject({
        ok: false,
      });
    });
  });

  describe('resolver references', () => {
    const ref: TaskArgumentRef = { source: 'resolver', resolverId: 'vault', key: 'value:sg_1' };

    it('is always available because it runs later', () => {
      expect(argumentAvailable(ref, contextOf())).toEqual({ ok: true });
    });

    it('returns the resolved value with the sensitivity the resolver reported', () => {
      const plain = contextOf({}, [], {
        'vault|value:sg_1': { value: 'resolved', sensitive: false },
      });
      expect(materializeArgument(ref, plain)).toEqual({
        ok: true,
        value: 'resolved',
        sensitive: false,
      });
      const secret = contextOf({}, [], {
        'vault|value:sg_1': { value: 'resolved', sensitive: true },
      });
      expect(materializeArgument(ref, secret)).toEqual({
        ok: true,
        value: 'resolved',
        sensitive: true,
      });
    });

    it('reports RESOLVER_PENDING when there is no resolved value for the pair', () => {
      expect(materializeArgument(ref, contextOf())).toMatchObject({
        ok: false,
        code: 'RESOLVER_PENDING',
      });
      const other = contextOf({}, [], { 'other|value:sg_1': { value: 'x', sensitive: false } });
      expect(materializeArgument(ref, other)).toMatchObject({
        ok: false,
        code: 'RESOLVER_PENDING',
      });
      const otherKey = contextOf({}, [], { 'vault|value:sg_2': { value: 'x', sensitive: false } });
      expect(materializeArgument(ref, otherKey)).toMatchObject({
        ok: false,
        code: 'RESOLVER_PENDING',
      });
    });

    it('ignores an inherited entry', () => {
      const inherited = Object.create({ 'vault|value:sg_1': { value: 'x', sensitive: false } });
      expect(materializeArgument(ref, { ...contextOf(), resolved: inherited })).toMatchObject({
        ok: false,
        code: 'RESOLVER_PENDING',
      });
    });
  });

  describe('protocol and option references', () => {
    it('turns EMPTY of the value slot into an empty non-sensitive string', () => {
      const ref: TaskArgumentRef = { source: 'protocol', slot: 'value', token: 'EMPTY' };
      expect(argumentAvailable(ref, contextOf())).toEqual({ ok: true });
      expect(materializeArgument(ref, contextOf())).toEqual({
        ok: true,
        value: '',
        sensitive: false,
      });
    });

    it('reports UNSUPPORTED_SLOT for every other protocol reference', () => {
      const refs: readonly TaskArgumentRef[] = [
        { source: 'protocol', slot: 'value', token: 'CLEAR' },
        { source: 'protocol', slot: 'key', token: 'Enter' },
        { source: 'protocol', slot: 'direction', token: 'DOWN' },
        { source: 'protocol', slot: 'checked', token: 'CHECKED' },
        { source: 'protocol', slot: 'duration', token: '500' },
        { source: 'protocol', slot: 'option', token: 'EMPTY' },
      ];
      for (const ref of refs) {
        expect(materializeArgument(ref, contextOf())).toMatchObject({
          ok: false,
          code: 'UNSUPPORTED_SLOT',
        });
        expect(argumentAvailable(ref, contextOf())).toEqual({ ok: true });
      }
    });

    it('reports UNSUPPORTED_SLOT for an observed option, which selects instead of typing', () => {
      const ref: TaskArgumentRef = { source: 'observed_option', targetId: 't5', optionId: 't5.1' };
      expect(materializeArgument(ref, contextOf())).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_SLOT',
      });
      expect(argumentAvailable(ref, contextOf())).toEqual({ ok: true });
    });

    it('reports UNSUPPORTED_SLOT for a source it does not know', () => {
      const alien = { source: 'telepathy' } as unknown as TaskArgumentRef;
      expect(materializeArgument(alien, contextOf())).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_SLOT',
      });
      expect(argumentAvailable(alien, contextOf())).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_SLOT',
      });
    });
  });

  it('produces a raw value only in materializeArgument, never in availability or messages', () => {
    const secret = `pw-${Math.random().toString(36).slice(2)}`;
    const context = contextOf({ login: { password: secret }, obj: { password: secret } });
    const available = argumentAvailable({ source: 'input', path: 'login.password' }, context);
    expect(JSON.stringify(available)).not.toContain(secret);
    const failures = [
      argumentAvailable({ source: 'input', path: 'obj' }, context),
      materializeArgument({ source: 'input', path: 'obj' }, context),
      materializeArgument({ source: 'input', path: 'missing' }, context),
    ];
    expect(JSON.stringify(failures)).not.toContain(secret);
    expect(materializeArgument({ source: 'input', path: 'login.password' }, context)).toEqual({
      ok: true,
      value: secret,
      sensitive: true,
    });
  });

  it('does not mutate its arguments', () => {
    const context = deepFreeze(contextOf({ a: { b: 'c' } }, [decl('a.b')]));
    expect(materializeArgument({ source: 'input', path: 'a.b' }, context)).toMatchObject({
      ok: true,
    });
    expect(argumentAvailable(goalRef(), context)).toEqual({ ok: true });
  });
});

describe('splitSensitiveInputs', () => {
  const split = (inputs: TaskInputs, declarations: readonly TaskInputDeclaration[] = []) =>
    splitSensitiveInputs(inputs, flattenInputs(inputs, declarations));

  it('removes sensitive leaves and lists their paths, keeping everything else', () => {
    const result = split(
      { name: 'Ada', password: 'p', profile: { city: 'x', apiKey: 'k' }, list: ['a', 'b'] },
      []
    );
    expect(result.inputs).toEqual({ name: 'Ada', profile: { city: 'x' }, list: ['a', 'b'] });
    expect([...result.paths].sort()).toEqual(['password', 'profile.apiKey']);
  });

  it('removes declared sensitive leaves, including everything under a sensitive ancestor', () => {
    const result = split({ card: { number: '4111', holder: 'Ada' }, note: 'n' }, [
      decl('card', { sensitive: true }),
    ]);
    expect(result.inputs).toEqual({ note: 'n' });
    expect([...result.paths]).toEqual(['card.number', 'card.holder']);
  });

  it('prunes containers that the removal emptied and keeps those that still hold data', () => {
    const result = split({ a: { b: { secret: 's' } }, c: { secret: 's', keep: 'k' } }, []);
    expect(result.inputs).toEqual({ c: { keep: 'k' } });
  });

  it('keeps the positions of array items by nulling a removed one', () => {
    const result = split({ rows: ['first', 'second', 'third'] }, [
      decl('rows.1', { sensitive: true }),
    ]);
    expect(result.inputs).toEqual({ rows: ['first', null, 'third'] });
    expect(result.paths).toEqual(['rows.1']);
  });

  it('drops an array whose items were all removed', () => {
    const result = split({ rows: [{ cvv: '1' }, { cvv: '2' }], keep: 1 }, []);
    expect(result.inputs).toEqual({ keep: 1 });
    expect([...result.paths]).toEqual(['rows.0.cvv', 'rows.1.cvv']);
  });

  it('returns an equal copy and no paths when nothing is sensitive', () => {
    const inputs = { a: { b: [1, 2, { c: 'd' }] }, e: true };
    const result = split(inputs, []);
    expect(result.inputs).toEqual(inputs);
    expect(result.inputs).not.toBe(inputs);
    expect(result.paths).toEqual([]);
  });

  it('returns empty inputs when everything is sensitive', () => {
    const result = split({ password: 'a', pin: 'b' }, []);
    expect(result.inputs).toEqual({});
    expect([...result.paths]).toEqual(['password', 'pin']);
  });

  it('keeps a boolean or number leaf that is not sensitive and removes one that is', () => {
    const result = split({ flag: true, count: 3, secretFlag: false }, []);
    expect(result.inputs).toEqual({ flag: true, count: 3 });
  });

  it('removes a leaf named in leaves even when the key looks harmless', () => {
    const inputs: TaskInputs = { plain: 'v', other: 'w' };
    const result = splitSensitiveInputs(inputs, [leaf('plain', 'v', { sensitive: true })]);
    expect(result.inputs).toEqual({ other: 'w' });
    expect(result.paths).toEqual(['plain']);
  });

  it('never leaves a planted secret in the result and does not mutate the input', () => {
    const secret = `plant-${Math.random().toString(36).slice(2)}`;
    const inputs = deepFreeze({ login: { password: secret }, notes: ['x', { token: secret }] });
    const result = split(inputs, []);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(roundTrip(result)).toEqual(result);
  });

  it('drops unsafe keys from the copy', () => {
    const result = split(asInputs('{"ok": "1", "__proto__": {"x": "2"}}'), []);
    expect(Object.keys(result.inputs)).toEqual(['ok']);
  });

  it('copies by value: changing the result never changes the source', () => {
    const inputs: TaskInputs = { a: { b: 'c' } };
    const result = split(inputs, []);
    const inner = result.inputs.a as Record<string, unknown>;
    inner.b = 'changed';
    expect((inputs.a as Record<string, unknown>).b).toBe('c');
  });
});

describe('mergeInputs', () => {
  it('merges objects deeply with the patch winning', () => {
    expect(
      mergeInputs({ a: 1, b: { c: 2, d: 3 }, e: 'keep' }, { b: { c: 9, f: 4 }, a: 5, g: 'new' })
    ).toEqual({ a: 5, b: { c: 9, d: 3, f: 4 }, e: 'keep', g: 'new' });
  });

  it('replaces arrays instead of merging them', () => {
    expect(
      mergeInputs({ list: [1, 2, 3], nested: { list: ['a'] } }, { list: [9], nested: { list: [] } })
    ).toEqual({
      list: [9],
      nested: { list: [] },
    });
  });

  it('lets a patch replace an object with a scalar, a scalar with an object and a value with null', () => {
    expect(
      mergeInputs({ a: { b: 1 }, c: 'x', d: 'y' }, { a: 'flat', c: { z: 1 }, d: null })
    ).toEqual({
      a: 'flat',
      c: { z: 1 },
      d: null,
    });
  });

  it('keeps the keys of the base first and adds new keys after them', () => {
    expect(Object.keys(mergeInputs({ b: 1, a: 2 }, { c: 3, a: 4 }))).toEqual(['b', 'a', 'c']);
  });

  it('returns a copy of the base for an empty patch and of the patch for an empty base', () => {
    const base = { a: { b: 1 } };
    const merged = mergeInputs(base, {});
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
    expect(mergeInputs({}, base)).toEqual(base);
  });

  it('drops unsafe keys of the patch and of the base at every depth without polluting any prototype', () => {
    const patch = asInputs(
      '{"safe": 1, "__proto__": {"polluted": "yes"}, "n": {"constructor": {"x": 1}, "ok": 2}}'
    );
    const base = asInputs('{"prototype": {"y": 1}, "b": [{"__proto__": 1}], "keep": 3}');
    const merged = mergeInputs(base, patch);
    expect(hasUnsafeKey(merged)).toBe(false);
    expect(merged).toEqual({ keep: 3, b: [{}], safe: 1, n: { ok: 2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not alias the inputs and does not mutate them', () => {
    const base = deepFreeze({ a: { b: 1 }, list: [{ x: 1 }] });
    const patch = deepFreeze({ a: { c: 2 }, other: { d: 3 } });
    const merged = mergeInputs(base, patch);
    expect(merged).toEqual({ a: { b: 1, c: 2 }, list: [{ x: 1 }], other: { d: 3 } });
    expect(merged.other).not.toBe(patch.other);
    expect(merged.list).not.toBe(base.list);
  });

  it('keeps booleans, numbers and empty strings of the patch', () => {
    expect(mergeInputs({ a: 'x', b: 'y', c: 'z' }, { a: false, b: 0, c: '' })).toEqual({
      a: false,
      b: 0,
      c: '',
    });
  });

  it('skips a patch key that holds undefined', () => {
    const patch = { a: undefined, b: 2 } as unknown as TaskInputs;
    expect(mergeInputs({ a: 1 }, patch)).toEqual({ a: 1, b: 2 });
  });
});

describe('scalar and redactor secrets', () => {
  it('records the JSON type so a boolean leaf is never mistaken for a secret string', () => {
    const leaves = flattenInputs({ agree: true, count: 7, name: 'Ada', secretFlag: false }, [
      decl('agree', { sensitive: true }),
    ]);
    const byPath = Object.fromEntries(leaves.map(item => [item.path, item.scalar]));
    expect(byPath).toEqual({
      agree: 'boolean',
      count: 'number',
      name: 'string',
      secretFlag: 'boolean',
    });
    const redactable = leaves.filter(item => item.sensitive && item.scalar !== 'boolean');
    expect(redactable).toEqual([]);
    const stringSecrets = flattenInputs({ pin: '4921' }, []).filter(
      item => item.sensitive && item.scalar !== 'boolean'
    );
    expect(stringSecrets.map(item => item.value)).toEqual(['4921']);
  });
});

describe('hostile input: bounded work and unreadable values', () => {
  const goalCapacity = TASK_LIMITS.goalBytes;

  it('proposes no goal text for a goal above the goal limit, and does not spend quadratic time on it', () => {
    for (const pattern of ["'a ", '1.', 'a', 'x@', 'a.', '"a ']) {
      const goal = pattern.repeat(Math.ceil((goalCapacity * 200) / pattern.length));
      const started = Date.now();
      const set = buildCandidates(
        candidateInput({ goal, leaves: [leaf('name', 'Ada')], resolvers: [resolverOf()] })
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(bySource(set.candidates, 'goal_literal')).toEqual([]);
      expect(bySource(set.candidates, 'goal_span')).toEqual([]);
      expect(sourcesOf(set.candidates)).toEqual(['input', 'resolver', 'protocol']);
      expect(set.withheld).toBe(0);
    }
  });

  it('still proposes goal text at exactly the goal limit and none one unit above it', () => {
    const atLimit = `"quoted" ${'x'.repeat(goalCapacity - 9)}`;
    expect(atLimit.length).toBe(goalCapacity);
    expect(goalLiterals(atLimit).map(textOfRef)).toEqual(['quoted']);
    expect(goalSpans(atLimit).length).toBeGreaterThan(0);
    const above = `${atLimit}x`;
    expect(goalLiterals(above)).toEqual([]);
    expect(goalSpans(above)).toEqual([]);
  });

  it('ranks thousands of described inputs without time that grows with the square of their number', () => {
    const leaves = Array.from({ length: 3000 }, (_, index) =>
      leaf(`field${index}`, `value ${index}`, {
        description: `description of field number ${index} here`,
      })
    );
    const started = Date.now();
    const set = buildCandidates(candidateInput({ goal: 'fill field 7', leaves, limit: 100 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(set.candidates).toHaveLength(100);
    expect(set.truncated).toBe(true);
    expect(set.candidates[set.candidates.length - 1]?.source).toBe('protocol');
  });

  it('does not let an input boost itself with its own description, but counts the descriptions of the others', () => {
    const first = leaf('q', 'x', { description: 'gamma' });
    const second = leaf('p', 'y', { description: 'alpha beta' });
    const set = buildCandidates(
      candidateInput({
        goal: '',
        element: textField({ label: 'Entry' }),
        leaves: [first, second],
        limit: 2,
      })
    );
    expect(bySource(set.candidates, 'input').map(item => item.ref)).toEqual([
      { source: 'input', path: 'q' },
    ]);
    const boosted = buildCandidates(
      candidateInput({
        goal: '',
        element: textField({ label: 'Entry' }),
        leaves: [
          leaf('q', 'x', { description: 'gamma' }),
          leaf('p', 'gamma', { description: 'z' }),
        ],
        limit: 2,
      })
    );
    expect(bySource(boosted.candidates, 'input').map(item => item.ref)).toEqual([
      { source: 'input', path: 'p' },
    ]);
  });

  it('never cuts a clipped span inside a surrogate pair, whichever side of the cut the pair straddles', () => {
    const straddling = `${'a'.repeat(119)}\u{1F600}${'b'.repeat(40)}`;
    const [first] = goalSpans(straddling);
    expect(textOfRef(first as TaskArgumentCandidate)).toBe('a'.repeat(119));
    for (const candidate of goalSpans(straddling)) {
      expect(lonePairs(textOfRef(candidate))).toBe(false);
    }
    const inside = `${'a'.repeat(118)}\u{1F600}${'b'.repeat(40)}`;
    const [second] = goalSpans(inside);
    expect(textOfRef(second as TaskArgumentCandidate)).toBe(`${'a'.repeat(118)}\u{1F600}`);
    expect(textOfRef(second as TaskArgumentCandidate)).toHaveLength(120);
  });

  it('treats an astral letter next to a number as part of a word and an astral symbol as a separator', () => {
    expect(goalLiterals('\u{1D4B3}123').map(textOfRef)).toEqual([]);
    expect(goalLiterals('123\u{1D4B3}').map(textOfRef)).toEqual([]);
    expect(goalLiterals('\u{1F600}123\u{1F600}').map(textOfRef)).toEqual(['123']);
  });

  it('treats an input it cannot inspect as unsafe and reads past a getter that throws', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('refused');
        },
      }
    );
    expect(hasUnsafeKey({ nested: hostile })).toBe(true);
    const inputs = {};
    Object.defineProperty(inputs, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('refused');
      },
    });
    Object.defineProperty(inputs, 'good', { enumerable: true, value: 'v' });
    expect(pathsOf(flattenInputs(inputs as TaskInputs, []))).toEqual(['good']);
  });

  it('inspects a very deep input and a cyclic one without overflowing the stack', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 100_000; level += 1) {
      deep = { n: deep };
    }
    expect(hasUnsafeKey(deep)).toBe(false);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(hasUnsafeKey(cyclic)).toBe(false);
    expect(pathsOf(flattenInputs(cyclic as TaskInputs, []))).toEqual(['a']);
  });
});

describe('source hygiene of src/agent/resolver.ts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'resolver.ts'), 'utf8');
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
      /\(\?<[=!]/,
    ];
    for (const pattern of forbidden) {
      expect(code).not.toMatch(pattern);
    }
  });

  it('imports no executor module and declares no exported type', () => {
    expect(code).not.toMatch(/from\s+['"]@\/actions/);
    expect(code).not.toMatch(/export\s+type\s/);
  });
});

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'is',
  'are',
  'el',
  'la',
  'los',
  'las',
  'de',
  'del',
  'y',
  'un',
  'una',
  'le',
  'les',
  'des',
  'du',
  'et',
  'ou',
  'der',
  'die',
  'das',
  'und',
  'oder',
  'ein',
  'eine',
  'il',
  'lo',
  'gli',
  'di',
  'da',
  'um',
  'uma',
]);

const TASK_WORDS: ReadonlySet<string> = new Set([
  'login',
  'logout',
  'signup',
  'search',
  'checkout',
  'cart',
  'buy',
  'shop',
  'order',
  'username',
  'amazon',
  'ebay',
  'etsy',
  'walmart',
  'google',
  'bing',
  'shopify',
  'breeze',
  'juspay',
  'facebook',
  'twitter',
  'github',
  'linkedin',
  'netflix',
  'airbnb',
  'stripe',
  'paypal',
]);

const SITE_PATTERN =
  /\b(amazon|ebay|etsy|walmart|google|bing|shopify|breeze|juspay|facebook|twitter|github|linkedin|netflix|airbnb|stripe|paypal)\b/gi;

const scanForWordLists = (source: string): readonly string[] => {
  const hits: string[] = [];
  const literals = source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g);
  for (const literal of literals) {
    const text = (literal[2] ?? '').trim().toLowerCase();
    if (STOPWORDS.has(text) || TASK_WORDS.has(text)) {
      hits.push(`literal:${text}`);
    }
  }
  for (const site of source.matchAll(SITE_PATTERN)) {
    hits.push(`site:${(site[1] ?? '').toLowerCase()}`);
  }
  return hits;
};
