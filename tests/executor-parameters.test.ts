/** @jest-environment node */
import { randomBytes } from 'crypto';
import {
  WITHHELD_TEXT,
  collectSensitiveValues,
  declaresSensitive,
  isStrictExecution,
  redactActionParameters,
  scrubActionData,
  scrubActionText,
  scrubActionTextSafely,
  validateActionParameters,
} from '@/actions/parameters';
import { createRedactor } from '@/utils/redact';
import type { ActionCommand, ActionParameterIssue, ActionType, ExecutionOptions } from '@/types';
import { ACTION_TYPES, TASK_REDACTED } from '@/types';

const unique = (tag: string): string => `${tag}-${randomBytes(6).toString('hex')}`;

const cmd = (
  type: string,
  parameters: Record<string, unknown>,
  extra: Partial<ActionCommand> = {}
): ActionCommand => ({ type, parameters, ...extra }) as unknown as ActionCommand;

// `.not.toBeNull()` also passes for `undefined`, which every caller reads as "no issue": a result that is
// neither null nor a complete issue is itself a failure.
function validate(action: ActionCommand, strict: boolean): ActionParameterIssue | null {
  const issue: unknown = validateActionParameters(action, strict);
  const complete =
    issue === null ||
    (typeof issue === 'object' &&
      typeof (issue as { code?: unknown }).code === 'string' &&
      typeof (issue as { message?: unknown }).message === 'string');
  expect(complete).toBe(true);
  return issue as ActionParameterIssue | null;
}

const STRICT_ROWS: ReadonlyArray<readonly [ActionType, Record<string, string>]> = [
  ['navigate', { strict: 'true', url: 'https://example.test/', waitForLoad: 'false' }],
  ['click', { strict: 'true' }],
  ['click', { strict: 'true', selector: '#go', button: 'left', clickCount: '1' }],
  ['click', { strict: 'true', x: '10', y: '20' }],
  ['fill', { strict: 'true', value: 'abc' }],
  ['fill', { strict: 'true', value: '' }],
  [
    'fill',
    { strict: 'true', selector: '#a', value: 'v', clearFirst: 'true', triggerEvents: 'false' },
  ],
  ['select', { strict: 'true', matchBy: 'index', option: '2' }],
  ['select', { strict: 'true', matchBy: 'label', option: 'Canada' }],
  ['select', { strict: 'true', matchBy: 'value', option: '' }],
  ['select', { strict: 'true' }],
  ['setChecked', { strict: 'true', checked: 'true' }],
  ['setChecked', { strict: 'true', checked: 'false', selector: '#c' }],
  ['press', { strict: 'true', key: 'Enter', implicitSubmit: 'true' }],
  ['press', { strict: 'true', key: ' ' }],
  ['scroll', { strict: 'true', direction: 'DOWN' }],
  ['scroll', { strict: 'true', direction: 'BOTTOM', selector: '#list' }],
  ['wait', { strict: 'true', duration: '1500' }],
  ['submitForm', { strict: 'true', formId: 'f1' }],
  ['screenshot', { strict: 'true', fullPage: 'true', quality: '0.9' }],
  ['fillForm', { strict: 'true', formId: 'f1', fields: '{"a":"x","b":true,"c":["p","q"],"d":3}' }],
  ['fillForm', { strict: 'true', email: 'a@b.test', zip: '12345' }],
];

describe('validateActionParameters, strict mode', () => {
  test.each(STRICT_ROWS)('accepts the %s row %j', (type, parameters) => {
    expect(validate(cmd(type, parameters), true)).toBeNull();
  });

  test('every ACTION_TYPES member has a strict row, so a new type cannot ship unvalidated', () => {
    const covered = new Set(STRICT_ROWS.map(([type]) => type));
    expect([...ACTION_TYPES].filter(type => !covered.has(type))).toEqual([]);
  });

  test.each([
    ['fill', 'value', 12],
    ['fill', 'value', null],
    ['fill', 'value', undefined],
    ['fill', 'value', true],
    ['fill', 'value', ['a']],
    ['fill', 'value', { a: 1 }],
    ['click', 'selector', 5],
    ['click', 'clickCount', 1],
    ['setChecked', 'checked', true],
    ['wait', 'duration', 1000],
    ['press', 'key', 13],
  ])('rejects a non-string %s.%s value (%p)', (type, key, value) => {
    const base: Record<string, string> = {
      fill: 'x',
      click: '',
      setChecked: 'true',
      wait: '1000',
      press: 'Enter',
    };
    const parameters: Record<string, unknown> = { strict: 'true', [key]: value };
    if (type === 'fill' && key !== 'value') {
      parameters.value = base.fill;
    }
    const issue = validate(cmd(type, parameters), true);
    expect(issue).not.toBeNull();
    expect(issue?.code).toBe('VALIDATION_FAILED');
  });

  test.each(['True', 'TRUE', '1', '0', 'yes', ' true', 'true ', ''])(
    'rejects non-canonical boolean %p',
    value => {
      expect(validate(cmd('setChecked', { strict: 'true', checked: value }), true)?.key).toBe(
        'checked'
      );
      expect(
        validate(cmd('fill', { strict: 'true', value: 'v', clearFirst: value }), true)
      ).not.toBeNull();
      expect(
        validate(cmd('press', { strict: 'true', key: 'a', implicitSubmit: value }), true)
      ).not.toBeNull();
      expect(
        validate(cmd('navigate', { strict: 'true', url: '/x', waitForLoad: value }), true)
      ).not.toBeNull();
    }
  );

  test.each(['01', '1.5', '-1', '1e2', ' 2', '2 ', '0x10', '', 'abc', '١٢'])(
    'rejects non-canonical integer %p',
    value => {
      expect(validate(cmd('click', { strict: 'true', clickCount: value }), true)?.key).toBe(
        'clickCount'
      );
      expect(validate(cmd('wait', { strict: 'true', duration: value }), true)?.key).toBe(
        'duration'
      );
      expect(
        validate(cmd('select', { strict: 'true', matchBy: 'index', option: value }), true)
      ).not.toBeNull();
    }
  );

  test('integer bounds: clickCount 1..5, wait duration 1..60000, on both sides', () => {
    const click = (clickCount: string): ActionParameterIssue | null =>
      validate(cmd('click', { strict: 'true', clickCount }), true);
    const wait = (duration: string): ActionParameterIssue | null =>
      validate(cmd('wait', { strict: 'true', duration }), true);
    expect([click('0'), click('1'), click('5'), click('6')].map(i => i === null)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect([wait('0'), wait('1'), wait('60000'), wait('60001')].map(i => i === null)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  test('coordinates come as a pair and must be canonical non-negative integers', () => {
    expect(validate(cmd('click', { strict: 'true', x: '5' }), true)).not.toBeNull();
    expect(validate(cmd('click', { strict: 'true', y: '5' }), true)).not.toBeNull();
    expect(validate(cmd('click', { strict: 'true', x: '-5', y: '5' }), true)).not.toBeNull();
    expect(validate(cmd('click', { strict: 'true', x: '5.5', y: '5' }), true)).not.toBeNull();
    expect(validate(cmd('click', { strict: 'true', x: '0', y: '0' }), true)).toBeNull();
  });

  test.each([
    ['click', { button: 'bogus' }],
    ['click', { button: 'LEFT' }],
    ['scroll', { direction: 'up' }],
    ['scroll', { direction: 'LEFT' }],
    ['select', { matchBy: 'text', option: 'a' }],
    ['select', { matchBy: 'index' }],
    ['select', { option: 'a' }],
    ['screenshot', { quality: '2' }],
    ['screenshot', { quality: 'high' }],
    ['screenshot', { fullPage: 'maybe' }],
  ])('rejects the enum or pairing violation %s %j', (type, parameters) => {
    expect(validate(cmd(type, { strict: 'true', ...parameters }), true)).not.toBeNull();
  });

  test.each([
    ['fill', {}, 'value'],
    ['press', {}, 'key'],
    ['press', { key: '' }, 'key'],
    ['setChecked', {}, 'checked'],
    ['scroll', {}, 'direction'],
    ['wait', {}, 'duration'],
    ['navigate', {}, 'url'],
    ['navigate', { url: '' }, 'url'],
  ])('requires the key of %s %j: %s', (type, parameters, key) => {
    const issue = validate(cmd(type, { strict: 'true', ...parameters }), true);
    expect(issue?.key).toBe(key);
    expect(issue?.code).toBe('VALIDATION_FAILED');
  });

  test('a blank fill value is a present value, not a missing one', () => {
    expect(validate(cmd('fill', { strict: 'true', value: '' }), true)).toBeNull();
    expect(validate(cmd('fill', { strict: 'true' }), true)?.key).toBe('value');
  });

  test('rejects unknown keys, including prototype keys, for every non-fillForm type', () => {
    for (const type of ACTION_TYPES.filter(t => t !== 'fillForm')) {
      const rowParameters = STRICT_ROWS.find(([rowType]) => rowType === type)?.[1] ?? {};
      expect(validate(cmd(type, { ...rowParameters, bogusKey: 'x' }), true)).not.toBeNull();
    }
    const withProto = JSON.parse('{"strict":"true","key":"a","__proto__":"x"}') as Record<
      string,
      unknown
    >;
    expect(validate(cmd('press', withProto), true)).not.toBeNull();
  });

  test('strict wait is duration only: selector and condition are unknown keys', () => {
    expect(
      validate(
        cmd('wait', { strict: 'true', duration: '10', selector: '#a', condition: 'visible' }),
        true
      )
    ).not.toBeNull();
  });

  test('unknown action types and a non-object parameters bag are rejected in both modes', () => {
    for (const strict of [true, false]) {
      expect(validate(cmd('teleport', {}), strict)?.code).toBe('INVALID_ACTION');
      for (const bad of [null, undefined, 'text', 5]) {
        const issue = validate(
          { type: 'click', parameters: bad } as unknown as ActionCommand,
          strict
        );
        expect(issue?.code).toBe('VALIDATION_FAILED');
      }
    }
    expect(
      validate({ type: 'click', parameters: [] } as unknown as ActionCommand, true)
    ).not.toBeNull();
  });

  test('strict flag value must be canonical', () => {
    expect(validate(cmd('click', { strict: 'yes' }), true)?.key).toBe('strict');
    expect(validate(cmd('click', { strict: 'false' }), true)).toBeNull();
  });
});

describe('validateActionParameters, fillForm payloads in strict mode', () => {
  const fillForm = (parameters: Record<string, unknown>): ActionParameterIssue | null =>
    validate(cmd('fillForm', { strict: 'true', ...parameters }), true);

  test.each([
    ['malformed JSON', '{"a":'],
    ['an array', '["a"]'],
    ['a string', '"text"'],
    ['null', 'null'],
    ['a number', '5'],
    ['a nested object value', '{"a":{"b":1}}'],
    ['an array holding a number', '{"a":[1]}'],
    ['a null value', '{"a":null}'],
    ['a prototype key', '{"__proto__":"x"}'],
    ['a constructor key', '{"constructor":"x"}'],
  ])('rejects fields that are %s', (_label, fields) => {
    expect(fillForm({ fields })?.code).toBe('VALIDATION_FAILED');
    expect(fillForm({ values: fields })?.code).toBe('VALIDATION_FAILED');
  });

  test('accepts string, number, boolean and string-array values from fields or values', () => {
    const payload = '{"a":"x","b":1.5,"c":false,"d":["p"],"e":[]}';
    expect(fillForm({ fields: payload })).toBeNull();
    expect(fillForm({ values: payload })).toBeNull();
  });

  test('rejects an empty payload, fields together with values, and fields mixed with flat entries', () => {
    expect(fillForm({ formId: 'f1' })).not.toBeNull();
    expect(fillForm({ fields: '{"a":"1"}', values: '{"a":"1"}' })).not.toBeNull();
    expect(fillForm({ fields: '{"a":"1"}', loose: 'x' })).not.toBeNull();
  });

  test('flat entries must be strings and may not use prototype keys', () => {
    expect(fillForm({ email: 5 })).not.toBeNull();
    const proto = JSON.parse('{"strict":"true","__proto__":"x"}') as Record<string, unknown>;
    expect(validate(cmd('fillForm', proto), true)).not.toBeNull();
  });
});

describe('validateActionParameters, legacy mode keeps today leniency', () => {
  test('accepts loosely typed, unknown and non-canonical parameters', () => {
    const lenient: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['click', { clickCount: 'abc', button: 'bogus', x: 'a', y: 'b' }],
      ['click', { selector: 5, extra: {} }],
      ['fill', { value: 12, clearFirst: 'maybe', unknown: 'x' }],
      ['fill', {}],
      ['wait', { duration: 'soon', selector: '#a', condition: 'whenever' }],
      ['scroll', { direction: 'sideways' }],
      ['select', { matchBy: 'text' }],
      ['setChecked', { checked: 'yes' }],
      ['fillForm', { fields: '{"a":' }],
      ['fillForm', { fields: '[1]', loose: 3 }],
    ];
    for (const [type, parameters] of lenient) {
      expect(validate(cmd(type, parameters), false)).toBeNull();
    }
  });
});

describe('validateActionParameters never echoes a value, a key or a type that is not its own', () => {
  test('the issue of every rejection is free of caller-supplied text', () => {
    const secret = unique('param-secret');
    const cases: ReadonlyArray<ActionCommand> = [
      cmd('fill', { strict: 'true', value: { nested: secret } }),
      cmd('fill', { strict: 'true', value: [secret] }),
      cmd('click', { strict: 'true', clickCount: secret }),
      cmd('click', { strict: 'true', button: secret }),
      cmd('wait', { strict: 'true', duration: secret }),
      cmd('scroll', { strict: 'true', direction: secret }),
      cmd('setChecked', { strict: 'true', checked: secret }),
      cmd('select', { strict: 'true', matchBy: secret, option: secret }),
      cmd('select', { strict: 'true', matchBy: 'index', option: secret }),
      cmd('fill', { strict: 'true', value: 'v', [secret]: 'x' }),
      cmd('click', { strict: 'true', [secret]: secret }),
      cmd('fillForm', { strict: 'true', fields: secret }),
      cmd('fillForm', { strict: 'true', fields: `{"a":{"${secret}":1}}` }),
      cmd('fillForm', { strict: 'true', fields: `{"a":"x"`, [secret]: secret }),
      cmd('fillForm', { strict: 'true', [secret]: 4 }),
      cmd(secret, { value: secret }),
    ];
    for (const action of cases) {
      const issue = validate(action, true);
      expect(issue).not.toBeNull();
      expect(JSON.stringify(issue)).not.toContain(secret);
    }
    const legacyIssue = validate(cmd(secret, { value: secret }), false);
    expect(JSON.stringify(legacyIssue)).not.toContain(secret);
  });
});

describe('isStrictExecution', () => {
  const plain = cmd('click', {});
  const options = (value: ExecutionOptions): ExecutionOptions => value;

  test('is off for a legacy action with no strict channel', () => {
    expect(isStrictExecution(plain)).toBe(false);
    expect(isStrictExecution(plain, options({}))).toBe(false);
    expect(isStrictExecution(plain, options({ strict: false }))).toBe(false);
    expect(isStrictExecution(cmd('click', { strict: 'false' }))).toBe(false);
    expect(isStrictExecution(cmd('click', { strict: 'TRUE' }))).toBe(false);
  });

  test('turns on through ANY of the three channels of contract 5.1', () => {
    expect(isStrictExecution(plain, options({ strict: true }))).toBe(true);
    expect(isStrictExecution(plain, options({ target: {} as HTMLElement }))).toBe(true);
    expect(isStrictExecution(cmd('click', { strict: 'true' }))).toBe(true);
  });

  test('the new action types have no legacy form and are always strict', () => {
    for (const type of ['setChecked', 'select', 'scroll'] as const) {
      expect(isStrictExecution(cmd(type, {}))).toBe(true);
    }
    for (const type of [
      'navigate',
      'click',
      'fill',
      'fillForm',
      'submitForm',
      'screenshot',
      'wait',
      'press',
    ] as const) {
      expect(isStrictExecution(cmd(type, {}))).toBe(false);
    }
  });

  test('tolerates a missing parameters bag', () => {
    expect(isStrictExecution({ type: 'click' } as unknown as ActionCommand)).toBe(false);
  });
});

describe('collectSensitiveValues', () => {
  test('returns the values of the named parameters that are present and non-empty', () => {
    const action = cmd(
      'fill',
      { value: 'alpha-1234', selector: '#a', blank: '' },
      { sensitiveParameters: ['value', 'blank', 'missing'] }
    );
    expect(collectSensitiveValues(action)).toEqual(['alpha-1234']);
  });

  test('is empty without sensitiveParameters', () => {
    expect(collectSensitiveValues(cmd('fill', { value: 'alpha-1234' }))).toEqual([]);
  });

  test('a sensitive fillForm payload also exposes its string leaves', () => {
    const action = cmd(
      'fillForm',
      { fields: JSON.stringify({ pw: 'leaf-secret-1', nested: ['leaf-secret-2'], n: 5 }) },
      { sensitiveParameters: ['fields'] }
    );
    const values = collectSensitiveValues(action);
    expect(values).toEqual(expect.arrayContaining(['leaf-secret-1', 'leaf-secret-2']));
    expect(values.every(value => value.length > 0)).toBe(true);
  });
});

describe('redactActionParameters', () => {
  test('masks the named parameters and keeps every other one, without mutating the action', () => {
    const secret = unique('redact-a');
    const action = cmd(
      'fill',
      { selector: '#card', value: secret },
      { sensitiveParameters: ['value'] }
    );
    const redacted = redactActionParameters(action);
    expect(redacted).toEqual({ selector: '#card', value: TASK_REDACTED });
    expect(action.parameters.value).toBe(secret);
    expect(redacted).not.toBe(action.parameters);
  });

  test('also scrubs a sensitive value that appears inside another parameter', () => {
    const secret = unique('redact-b');
    const action = cmd(
      'fill',
      { value: secret, description: `Type ${secret} here` },
      { sensitiveParameters: ['value'] }
    );
    const redacted = redactActionParameters(action);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.description).toContain(TASK_REDACTED);
  });

  test('a named parameter is masked even when its content cannot be matched: blank and non-string values', () => {
    const blank = cmd('fill', { selector: '#a', value: '' }, { sensitiveParameters: ['value'] });
    const numeric = cmd('fill', { value: 4242424242 }, { sensitiveParameters: ['value'] });
    const nested = cmd('fill', { value: { card: '4242' } }, { sensitiveParameters: ['value'] });

    expect(redactActionParameters(blank)).toEqual({ selector: '#a', value: TASK_REDACTED });
    expect(redactActionParameters(numeric).value).toBe(TASK_REDACTED);
    expect(redactActionParameters(nested).value).toBe(TASK_REDACTED);
    const redactor = createRedactor({ secrets: [] });
    expect(redactActionParameters(blank, redactor).value).toBe(redactor.replacement);
    expect(redactActionParameters(numeric, redactor).value).toBe(redactor.replacement);
  });

  test('without sensitiveParameters or a redactor the parameters are returned as they are', () => {
    const action = cmd('fill', { selector: '#a', value: 'plain' });
    expect(redactActionParameters(action)).toEqual({ selector: '#a', value: 'plain' });
  });

  test('with a redactor: scrubs values by secret and masks sensitive key names even when unlisted', () => {
    const secret = unique('redact-c');
    const redactor = createRedactor({ secrets: [secret] });
    const action = cmd('fillForm', {
      password: 'hunter2-not-listed',
      note: `contains ${secret} inside`,
      selector: '#x',
    });
    const redacted = redactActionParameters(action, redactor);
    expect(redacted.password).toBe(redactor.replacement);
    expect(redacted.note).not.toContain(secret);
    expect(redacted.selector).toBe('#x');
  });

  test('with a redactor and sensitiveParameters both apply', () => {
    const listed = unique('redact-d');
    const known = unique('redact-e');
    const redactor = createRedactor({ secrets: [known] });
    const action = cmd(
      'fill',
      { value: listed, description: `${listed} ${known}` },
      { sensitiveParameters: ['value'] }
    );
    const text = JSON.stringify(redactActionParameters(action, redactor));
    expect(text).not.toContain(listed);
    expect(text).not.toContain(known);
  });
});

describe('scrubActionText', () => {
  test('replaces long sensitive values anywhere, longest first', () => {
    const long = unique('scrub-long');
    const short = long.slice(0, 10);
    const action = cmd(
      'fill',
      { value: long, alias: short },
      { sensitiveParameters: ['value', 'alias'] }
    );
    const out = scrubActionText(`bad ${long} and ${short}`, action);
    expect(out).not.toContain(short);
    expect(out).toBe(`bad ${TASK_REDACTED} and ${TASK_REDACTED}`);
  });

  test('short values are replaced as whole words only, so ordinary words survive', () => {
    const action = cmd('fill', { value: 'ed' }, { sensitiveParameters: ['value'] });
    expect(scrubActionText('Click failed for ed now', action)).toBe(
      `Click failed for ${TASK_REDACTED} now`
    );
    expect(scrubActionText('Click failed', action)).toBe('Click failed');
  });

  test('regular-expression characters in a secret are literal', () => {
    const action = cmd('fill', { value: 'a.b*c(d)+[e]' }, { sensitiveParameters: ['value'] });
    expect(scrubActionText('x a.b*c(d)+[e] y aXb', action)).toBe(`x ${TASK_REDACTED} y aXb`);
  });

  test('is the identity without sensitive values or a redactor', () => {
    expect(scrubActionText('nothing to hide', cmd('click', {}))).toBe('nothing to hide');
  });

  test('delegates to the redactor when one is given', () => {
    const secret = unique('scrub-r');
    const redactor = createRedactor({ secrets: [secret] });
    const out = scrubActionText(`boom ${secret}`, cmd('click', {}), redactor);
    expect(out).not.toContain(secret);
    const listed = unique('scrub-l');
    const action = cmd('fill', { value: listed }, { sensitiveParameters: ['value'] });
    expect(scrubActionText(`boom ${listed} ${secret}`, action, redactor)).not.toMatch(
      new RegExp(`${listed}|${secret}`)
    );
  });
});

// Own keys named like Object.prototype members used to pass as known keys: the schema lookup found the
// inherited member, `checkValue` fell through its switch and `validateActionParameters` returned undefined.
describe('prototype-named parameter keys are unknown keys, in strict mode', () => {
  const PROTOTYPE_NAMES = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__lookupGetter__',
  ];
  const NON_FILL_FORM_ROWS = STRICT_ROWS.filter(([type]) => type !== 'fillForm');

  test.each(NON_FILL_FORM_ROWS)('%s row %j rejects every prototype-named key', (type, row) => {
    for (const name of [...PROTOTYPE_NAMES, '__proto__']) {
      const parameters = JSON.parse(JSON.stringify({ ...row, [name]: 'x' })) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parameters)).toContain(name);
      const issue = validate(cmd(type, parameters), true);
      expect({ name, code: issue?.code }).toEqual({ name, code: 'VALIDATION_FAILED' });
      expect(issue?.message).not.toContain(name);
    }
  });

  test('fillForm still takes a flat entry named like a prototype method, but never __proto__, constructor or prototype', () => {
    for (const name of ['toString', 'valueOf', 'hasOwnProperty']) {
      expect(validate(cmd('fillForm', { strict: 'true', [name]: 'x' }), true)).toBeNull();
    }
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const parameters = JSON.parse(JSON.stringify({ strict: 'true', [name]: 'x' })) as Record<
        string,
        unknown
      >;
      expect(validate(cmd('fillForm', parameters), true)?.code).toBe('VALIDATION_FAILED');
    }
  });

  test('a required key is found by its own property, never through the prototype chain', () => {
    Object.defineProperty(Object.prototype, 'value', { value: 'inherited', configurable: true });
    Object.defineProperty(Object.prototype, 'matchBy', { value: 'index', configurable: true });
    try {
      expect(validate(cmd('fill', { strict: 'true' }), true)?.key).toBe('value');
      expect(validate(cmd('select', { strict: 'true', option: '1' }), true)?.key).toBe('matchBy');
    } finally {
      Reflect.deleteProperty(Object.prototype, 'value');
      Reflect.deleteProperty(Object.prototype, 'matchBy');
    }
  });

  test('the answer is null or a complete issue for every type, key and mode, never undefined', () => {
    for (const type of ACTION_TYPES) {
      for (const name of [...PROTOTYPE_NAMES, '__proto__', 'prototype']) {
        for (const strict of [true, false]) {
          const parameters = JSON.parse(JSON.stringify({ [name]: 'x' })) as Record<string, unknown>;
          validate(cmd(type, parameters), strict);
        }
      }
    }
  });

  test('a missing or non-object action is an issue, not a TypeError', () => {
    for (const bad of [null, undefined, 5, 'click', []]) {
      for (const strict of [true, false]) {
        expect(validate(bad as unknown as ActionCommand, strict)?.code).toBe('VALIDATION_FAILED');
      }
    }
    expect(isStrictExecution(null as unknown as ActionCommand)).toBe(false);
    expect(isStrictExecution(null as unknown as ActionCommand, { strict: true })).toBe(true);
    expect(collectSensitiveValues(null as unknown as ActionCommand)).toEqual([]);
    expect(redactActionParameters(undefined as unknown as ActionCommand)).toEqual({});
  });
});

describe('collectSensitiveValues reaches every leaf of every declared parameter', () => {
  const sensitive = (parameters: Record<string, unknown>, names: readonly string[]): string[] => [
    ...collectSensitiveValues(cmd('fillForm', parameters, { sensitiveParameters: names })),
  ];

  test('a string leaf nested ten levels deep is collected on its own, not only inside the payload string', () => {
    const leaf = unique('deep-leaf');
    let payload: unknown = { value: leaf };
    for (let level = 0; level < 9; level += 1) {
      payload = { child: payload, list: [payload] };
    }
    const values = sensitive({ fields: JSON.stringify(payload) }, ['fields']);
    expect(values).toContain(leaf);
  });

  test('a legacy object payload (not a JSON string) is collected leaf by leaf, arrays included', () => {
    const [first, second] = [unique('obj-leaf'), unique('arr-leaf')];
    const values = sensitive({ fields: { a: first, b: { c: [second] } } }, ['fields']);
    expect(values).toEqual(expect.arrayContaining([first, second]));
  });

  test('a long number is a value (a card, a pin); a short one is not, or "5 fields" would be redacted', () => {
    const values = sensitive(
      { fields: JSON.stringify({ card: 4111111111111111, n: 5, zip: 999 }) },
      ['fields']
    );
    expect(values).toContain('4111111111111111');
    expect(values).not.toContain('5');
    expect(values).not.toContain('999');
    expect(sensitive({ pin: 123456 }, ['pin'])).toEqual(['123456']);
  });

  test('a declared name that is not an own parameter yields nothing, even when the prototype has it', () => {
    Object.defineProperty(Object.prototype, 'inheritedSecret', {
      value: 'inherited-secret-value',
      configurable: true,
    });
    try {
      expect(sensitive({ other: 'x' }, ['inheritedSecret'])).toEqual([]);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'inheritedSecret');
    }
  });

  test('declared names that are not strings, and a non-array declaration, are ignored', () => {
    const action = cmd(
      'fill',
      { value: 'abcdefgh' },
      {
        sensitiveParameters: [5, null, 'value', {}] as unknown as readonly string[],
      }
    );
    expect(collectSensitiveValues(action)).toEqual(['abcdefgh']);
    const notAnArray = cmd(
      'fill',
      { value: 'abcdefgh' },
      {
        sensitiveParameters: 'value' as unknown as readonly string[],
      }
    );
    expect(collectSensitiveValues(notAnArray)).toEqual([]);
  });

  test('a huge payload is bounded: no stack overflow, and the whole raw string is still collected', () => {
    let nest = '"x"';
    for (let level = 0; level < 4000; level += 1) {
      nest = `[${nest}]`;
    }
    const wide = JSON.stringify(Array.from({ length: 20000 }, (_, index) => `leaf-${index}-abcd`));
    for (const payload of [nest, wide]) {
      const values = sensitive({ fields: payload }, ['fields']);
      expect(values).toContain(payload);
      expect(values.length).toBeLessThanOrEqual(5002);
    }
  });

  test('declaresSensitive reads the declaration by exact name', () => {
    const action = cmd('fill', { value: 'v' }, { sensitiveParameters: ['value'] });
    expect(declaresSensitive(action, 'value')).toBe(true);
    expect(declaresSensitive(action, 'Value')).toBe(false);
    expect(declaresSensitive(cmd('fill', { value: 'v' }), 'value')).toBe(false);
  });
});

describe('redaction output cannot be re-parented or made to throw', () => {
  test('an own __proto__ parameter stays an ordinary entry and the output keeps Object.prototype', () => {
    const parameters = JSON.parse('{"__proto__":{"polluted":"yes"},"a":"b"}') as Record<
      string,
      unknown
    >;
    const output = redactActionParameters(cmd('fillForm', parameters));
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect((output as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(output)).toEqual(['__proto__', 'a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('a redactor that omits a key (or answers with an inherited one) does not invent a value for it', () => {
    const redactor = {
      ...createRedactor({}),
      redactParameters: () => ({ kept: 'k' }),
    };
    const output = redactActionParameters(
      cmd(
        'click',
        JSON.parse('{"kept":"k","dropped":"d","__proto__":"p"}') as Record<string, unknown>
      ),
      redactor
    );
    expect(Object.keys(output)).toEqual(['kept']);
  });

  const throwing = {
    ...createRedactor({}),
    scrub: (): string => {
      throw new Error('scrub boom');
    },
    scrubDeep: (): never => {
      throw new Error('scrubDeep boom');
    },
    withSecrets: () => throwing,
  };

  test('scrubActionTextSafely withholds the text when the redactor throws, and coerces a non-string', () => {
    const action = cmd('fill', { value: 'abcdefgh' });
    expect(scrubActionTextSafely('text abcdefgh', action, throwing)).toBe(WITHHELD_TEXT);
    expect(scrubActionTextSafely({ message: 'm' }, action)).toBe('[object Object]');
    expect(scrubActionTextSafely(undefined, action)).toBe('undefined');
    expect(scrubActionTextSafely('plain', action)).toBe('plain');
  });

  test('scrubActionText itself still throws (only the Safely variant is total)', () => {
    expect(() => scrubActionText('x', cmd('fill', {}), throwing)).toThrow('scrub boom');
  });
});

describe('scrubActionData removes the action own values from a result payload', () => {
  const secret = unique('data-secret');
  const action = cmd(
    'fillForm',
    { fields: JSON.stringify({ pw: secret }) },
    { sensitiveParameters: ['fields'] }
  );

  test('without a redactor: strings at every depth, in arrays and records, in a copy', () => {
    const data = {
      a: `typed ${secret}`,
      list: [secret, { deep: [`x${secret}y`] }],
      n: 7,
      none: null,
    };
    const scrubbed = scrubActionData(data, action) as typeof data;
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
    expect(scrubbed.n).toBe(7);
    expect(scrubbed.none).toBeNull();
    expect(data.a).toContain(secret);
    expect(scrubbed).not.toBe(data);
  });

  test('with a redactor that does not know the secret, the action own value is still removed', () => {
    const redactor = createRedactor({ secrets: ['some-other-secret'] });
    const scrubbed = scrubActionData(
      { list: [`a ${secret}`], other: 'some-other-secret' },
      action,
      redactor
    );
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
    expect(JSON.stringify(scrubbed)).not.toContain('some-other-secret');
  });

  test('is the identity when the action declares nothing and no redactor is given', () => {
    const data = { a: 'plain' };
    expect(scrubActionData(data, cmd('fill', { value: 'v' }))).toBe(data);
  });

  test('a structure deeper than the cap is dropped, never passed through unscrubbed', () => {
    let nested: unknown = { leaf: secret };
    for (let level = 0; level < 40; level += 1) {
      nested = { next: nested };
    }
    expect(JSON.stringify(scrubActionData(nested, action))).not.toContain(secret);
  });

  test('an own __proto__ key in the payload stays an ordinary entry of the copy', () => {
    const data = JSON.parse(`{"__proto__":{"polluted":"${secret}"}}`) as Record<string, unknown>;
    const scrubbed = scrubActionData(data, action) as Record<string, unknown>;
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.prototype);
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
  });
});
