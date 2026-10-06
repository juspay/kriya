/** @jest-environment node */
import { randomBytes } from 'node:crypto';
import {
  REDACTED,
  createRedactor,
  isSensitiveKey,
  redactEnvelope,
  redactParameters,
} from '@/utils/redact';
import { TASK_REDACTED } from '@/types';
import type {
  Redactor,
  TaskBridgeEnvelope,
  TaskCommandRequest,
  TaskCreateRedactorFn,
  TaskIsSensitiveKeyFn,
  TaskRedactEnvelopeFn,
  TaskRedactParametersFn,
} from '@/types';

export const seamConformance: {
  readonly isSensitiveKey: TaskIsSensitiveKeyFn;
  readonly redactParameters: TaskRedactParametersFn;
  readonly createRedactor: TaskCreateRedactorFn;
  readonly redactEnvelope: TaskRedactEnvelopeFn;
  readonly redacted: typeof TASK_REDACTED;
} = { isSensitiveKey, redactParameters, createRedactor, redactEnvelope, redacted: REDACTED };

const unique = (): string => randomBytes(6).toString('hex');

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
};

const timed = <T>(run: () => T): { readonly result: T; readonly ms: number } => {
  const started = Date.now();
  const result = run();
  return { result, ms: Date.now() - started };
};

describe('REDACTED', () => {
  it('is the one redaction marker of the contract', () => {
    expect(REDACTED).toBe('[REDACTED]');
    expect(REDACTED).toBe(TASK_REDACTED);
  });
});

describe('isSensitiveKey: corpus 11.2', () => {
  const positives = [
    'password',
    'newPassword',
    'confirm_password',
    'card_number',
    'cardNumber',
    'cc-number',
    'cvv',
    'CVC',
    'otp',
    'ssn',
    'apiKey',
    'api_token',
    'Authorization',
    'pin',
    'jwt',
    'Social security number',
    'Account number',
    'Recovery phrase',
    'routing_number',
    'private key',
    'session_id',
    'Security code',
    'dob',
    'date of birth',
  ];
  const negatives = [
    'shipping',
    'mapping',
    'spinner',
    'tokenize',
    'cardholder',
    'pinterest',
    'passenger',
    'description',
    'username',
    'email',
    'account',
    'session',
    'security',
    'recovery',
    'birthday',
    'key',
    'social',
    'swiftly',
  ];

  it.each(positives)('is sensitive: %s', key => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(negatives)('is not sensitive: %s', key => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('is sensitive for every single token of the corpus', () => {
    const tokens = (
      'password passwd pwd passcode secret token apikey cvv cvc csc otp ssn pin card cc iban ' +
      'credential credentials authorization jwt bearer mnemonic passport routing swift cookie dob'
    ).split(' ');
    expect(tokens).toHaveLength(27);
    for (const token of tokens) {
      expect(isSensitiveKey(token)).toBe(true);
      expect(isSensitiveKey(token.toUpperCase())).toBe(true);
      expect(isSensitiveKey(`user_${token}`)).toBe(true);
      expect(isSensitiveKey(`${token}Value`)).toBe(true);
      expect(isSensitiveKey(`${token}zz9x`)).toBe(false);
      expect(isSensitiveKey(`x${token}`)).toBe(false);
    }
  });

  it('is sensitive for every token pair of the corpus, in either order for the symmetric ones, adjacent or not', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['api', 'key'],
      ['private', 'key'],
      ['access', 'key'],
      ['secret', 'key'],
      ['security', 'code'],
      ['security', 'answer'],
      ['security', 'question'],
      ['social', 'security'],
      ['account', 'number'],
      ['recovery', 'phrase'],
      ['recovery', 'code'],
      ['recovery', 'key'],
      ['recovery', 'word'],
      ['recovery', 'words'],
      ['session', 'id'],
      ['session', 'token'],
      ['session', 'key'],
      ['birth', 'date'],
      ['date', 'birth'],
      ['seed', 'phrase'],
      ['seed', 'words'],
    ];
    for (const [first, second] of pairs) {
      expect(isSensitiveKey(`${first} ${second}`)).toBe(true);
      expect(isSensitiveKey(`${first}_${second}`)).toBe(true);
      expect(isSensitiveKey(`${first}-${second}`)).toBe(true);
      expect(isSensitiveKey(`${first}${second[0]?.toUpperCase()}${second.slice(1)}`)).toBe(true);
      expect(isSensitiveKey(`${second} ${first}`)).toBe(true);
      expect(isSensitiveKey(`${first} of the ${second}`)).toBe(true);
    }
  });

  it('does not treat either half of a pair alone as sensitive, except where it is a single token itself', () => {
    for (const alone of [
      'api',
      'private',
      'access',
      'security',
      'social',
      'account',
      'recovery',
      'session',
      'birth',
      'date',
      'seed',
      'key',
      'code',
      'number',
      'phrase',
      'question',
      'answer',
      'word',
      'words',
      'id',
    ]) {
      expect(isSensitiveKey(alone)).toBe(false);
    }
  });

  it('does not pair tokens that are not in the corpus', () => {
    expect(isSensitiveKey('account id')).toBe(false);
    expect(isSensitiveKey('security level')).toBe(false);
    expect(isSensitiveKey('social media')).toBe(false);
    expect(isSensitiveKey('birth place')).toBe(false);
    expect(isSensitiveKey('update date')).toBe(false);
    expect(isSensitiveKey('seed value')).toBe(false);
    expect(isSensitiveKey('public key')).toBe(false);
  });

  it('splits camelCase, PascalCase, acronyms, snake, kebab, dot and digit boundaries into words', () => {
    for (const key of [
      'APIKey',
      'apiKEY',
      'userPassword',
      'PASSWORD',
      'confirmPassword2',
      'cvv2',
      'pin1',
      'password1',
      'user.token',
      'x[password]',
      'form:cardNumber',
      'secretKey',
      'accessKeyId',
      'securityAnswer',
      'recoveryWords',
      'session-token',
      'seed.phrase',
      'birthDate',
      'dateOfBirth',
      'date_of_birth',
      'SessionID',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('never matches inside a word', () => {
    for (const key of [
      'keyboard',
      'passwordless',
      'tokens',
      'pinned',
      'spin',
      'pins',
      'cards',
      'secrets',
      'otpx',
      'accept',
      'cookiejar',
      'sessionless',
      'passportal',
      'jwtx',
      'bearers',
      'secretary',
      'rooting',
      'swiftness',
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('documents the over-redaction of cookie settings', () => {
    expect(isSensitiveKey('Cookie settings')).toBe(true);
  });

  it('sees through zero-width and format characters inside a word, and through full-width letters', () => {
    expect(isSensitiveKey(`pass${String.fromCodePoint(0x200b)}word`)).toBe(true);
    expect(isSensitiveKey(`pa${String.fromCodePoint(0xad)}ssword`)).toBe(true);
    expect(isSensitiveKey(`${String.fromCodePoint(0xfeff)}password`)).toBe(true);
    expect(isSensitiveKey('\u{ff50}\u{ff41}\u{ff53}\u{ff53}\u{ff57}\u{ff4f}\u{ff52}\u{ff44}')).toBe(
      true
    );
  });

  it('is total on empty, non-string and hostile input', () => {
    expect(isSensitiveKey('')).toBe(false);
    expect(isSensitiveKey('   ')).toBe(false);
    expect(isSensitiveKey(undefined as unknown as string)).toBe(false);
    expect(isSensitiveKey(null as unknown as string)).toBe(false);
    expect(isSensitiveKey(12 as unknown as string)).toBe(false);
    expect(isSensitiveKey(String.fromCharCode(0xd800))).toBe(false);
    expect(isSensitiveKey('\u{1F600}password\u{1F600}')).toBe(true);
    expect(isSensitiveKey('\u{4e2d}\u{6587}')).toBe(false);
  });

  it('is fast on a very long key', () => {
    const { result, ms } = timed(() => isSensitiveKey(`${'a'.repeat(1_000_000)} password`));
    expect(result).toBe(true);
    expect(ms).toBeLessThan(5000);
    expect(timed(() => isSensitiveKey('aB'.repeat(500_000))).ms).toBeLessThan(5000);
  });

  it('answers the same through a redactor', () => {
    const redactor = createRedactor();
    expect(redactor.isSensitiveKey('apiKey')).toBe(true);
    expect(redactor.isSensitiveKey('shipping')).toBe(false);
  });
});

describe('redactParameters', () => {
  it('replaces the values named in sensitiveNames and leaves the others', () => {
    const input = { selector: '#email', value: 'a-value', text: 'visible' };
    expect(redactParameters(input, ['value'])).toEqual({
      selector: '#email',
      value: REDACTED,
      text: 'visible',
    });
  });

  it('replaces the values of keys that are sensitive keys, without being told', () => {
    expect(
      redactParameters({ password: 'x', cardNumber: '1', username: 'u', cvv: '2', note: 'n' })
    ).toEqual({
      password: REDACTED,
      cardNumber: REDACTED,
      username: 'u',
      cvv: REDACTED,
      note: 'n',
    });
  });

  it('uses the given replacement', () => {
    expect(redactParameters({ password: 'x', a: 'b' }, ['a'], '***')).toEqual({
      password: '***',
      a: '***',
    });
    expect(redactParameters({ password: 'x' }, undefined, '')).toEqual({ password: '' });
  });

  it('matches sensitiveNames exactly, by name', () => {
    expect(redactParameters({ value: 'v', Value: 'w', values2: 'z' }, ['value'])).toEqual({
      value: REDACTED,
      Value: 'w',
      values2: 'z',
    });
  });

  it('returns a new object and never mutates or aliases the input', () => {
    const input = deepFreeze({ password: 'x', other: 'y' });
    const output = redactParameters(input, ['other']);
    expect(output).not.toBe(input);
    expect(input).toEqual({ password: 'x', other: 'y' });
    expect(output).toEqual({ password: REDACTED, other: REDACTED });
    const untouched = redactParameters({ a: 'b' });
    expect(untouched).toEqual({ a: 'b' });
    expect(untouched).not.toBe(input);
  });

  it('is total on empty and missing input', () => {
    expect(redactParameters({})).toEqual({});
    expect(redactParameters(undefined as unknown as Record<string, string>)).toEqual({});
    expect(redactParameters(null as unknown as Record<string, string>)).toEqual({});
  });

  it('parses a fields JSON parameter and redacts nested sensitive keys at any depth', () => {
    const fields = JSON.stringify({
      email: 'a@b.co',
      password: 'p1',
      nested: { cvv: '123', ok: 1, deeper: { api_token: 't', fine: true } },
      list: [{ token: 'x', label: 'keep' }, 'plain', 5],
    });
    const output = redactParameters({ formId: 'f1', fields });
    expect(output.formId).toBe('f1');
    expect(JSON.parse(output.fields ?? 'null')).toEqual({
      email: 'a@b.co',
      password: REDACTED,
      nested: { cvv: REDACTED, ok: 1, deeper: { api_token: REDACTED, fine: true } },
      list: [{ token: REDACTED, label: 'keep' }, 'plain', 5],
    });
    expect(output.fields).not.toContain('p1');
    expect(output.fields).not.toContain('123');
  });

  it('does the same for a values JSON parameter', () => {
    const output = redactParameters({ values: JSON.stringify({ pin: '9', name: 'n' }) });
    expect(JSON.parse(output.values ?? 'null')).toEqual({ pin: REDACTED, name: 'n' });
  });

  it('replaces a sensitive nested value of any shape, object and array included', () => {
    const fields = JSON.stringify({ password: { a: 1 }, secret: [1, 2], token: null, ssn: 5 });
    expect(JSON.parse(redactParameters({ fields }).fields ?? 'null')).toEqual({
      password: REDACTED,
      secret: REDACTED,
      token: REDACTED,
      ssn: REDACTED,
    });
  });

  it('also applies sensitiveNames to nested keys of fields', () => {
    const fields = JSON.stringify({ memorable: 'm', other: 'o' });
    expect(JSON.parse(redactParameters({ fields }, ['memorable']).fields ?? 'null')).toEqual({
      memorable: REDACTED,
      other: 'o',
    });
  });

  it('handles a top level array in fields', () => {
    const fields = JSON.stringify([{ password: 'p' }, { name: 'n' }]);
    expect(JSON.parse(redactParameters({ fields }).fields ?? 'null')).toEqual([
      { password: REDACTED },
      { name: 'n' },
    ]);
  });

  it('replaces unparseable fields JSON as a whole', () => {
    expect(redactParameters({ fields: '{"password": "p1"' }).fields).toBe(REDACTED);
    expect(redactParameters({ values: 'not json at all' }).values).toBe(REDACTED);
    expect(redactParameters({ fields: '' }).fields).toBe(REDACTED);
    expect(redactParameters({ fields: "{'password':'p1'}" }, undefined, '***').fields).toBe('***');
  });

  it('replaces fields JSON that is a bare primitive, because a PIN parses as a number', () => {
    expect(redactParameters({ fields: '1234' }).fields).toBe(REDACTED);
    expect(redactParameters({ values: '"secret text"' }).values).toBe(REDACTED);
    expect(redactParameters({ fields: 'null' }).fields).toBe(REDACTED);
    expect(redactParameters({ fields: 'true' }).fields).toBe(REDACTED);
  });

  it('replaces fields whole when fields itself is named sensitive', () => {
    expect(redactParameters({ fields: '{"a":1}' }, ['fields']).fields).toBe(REDACTED);
  });

  it('does not parse JSON in parameters other than fields and values', () => {
    const json = JSON.stringify({ password: 'p1' });
    expect(redactParameters({ payload: json }).payload).toBe(json);
  });

  it('redacts flat fillForm-style payloads by key', () => {
    expect(
      redactParameters({ formId: 'f', email: 'a@b.co', password: 'pw', card_number: '4' })
    ).toEqual({ formId: 'f', email: 'a@b.co', password: REDACTED, card_number: REDACTED });
  });

  it('replaces an over-deep structure instead of recursing without bound', () => {
    let nested = '"leaf-' + unique() + '"';
    for (let index = 0; index < 150; index += 1) {
      nested = `{"a":${nested}}`;
    }
    const output = redactParameters({ fields: nested }).fields ?? '';
    expect(output).not.toContain('leaf-');
    const huge = `${'['.repeat(300_000)}${']'.repeat(300_000)}`;
    expect(() => redactParameters({ fields: huge })).not.toThrow();
  });

  it('keeps an own __proto__ key as data and never pollutes a prototype', () => {
    const parsed = JSON.parse('{"__proto__":"hostile","a":"b"}') as Record<string, string>;
    const output = redactParameters(parsed, ['a']);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(true);
    expect(output.a).toBe(REDACTED);
    const fields = redactParameters({ fields: '{"__proto__":{"polluted":1},"x":1}' }).fields;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(typeof fields).toBe('string');
  });

  it('is exposed by a redactor with its own replacement and ignores any third argument', () => {
    const redactor = createRedactor({ replacement: '###' });
    expect(redactor.redactParameters({ password: 'x', ok: 'y' })).toEqual({
      password: '###',
      ok: 'y',
    });
    expect(redactor.redactParameters({ value: 'v' }, ['value'])).toEqual({ value: '###' });
    expect(
      JSON.parse(redactor.redactParameters({ fields: '{"pin":"1"}' }).fields ?? 'null')
    ).toEqual({ pin: '###' });
  });
});

describe('createRedactor: shape and immutability', () => {
  it('has the contract members and defaults', () => {
    const redactor: Redactor = createRedactor();
    expect(Object.keys(redactor).sort()).toEqual(
      [
        'isSensitiveKey',
        'redactParameters',
        'redactUrl',
        'replacement',
        'scrub',
        'scrubDeep',
        'secretCount',
        'withSecrets',
      ].sort()
    );
    expect(redactor.replacement).toBe(REDACTED);
    expect(redactor.secretCount).toBe(0);
  });

  it('counts distinct usable secrets, ignoring empty, whitespace only, duplicate and non-string entries', () => {
    expect(createRedactor({ secrets: ['abc', 'abc', '', '   ', '\t\n', 'de'] }).secretCount).toBe(
      2
    );
    expect(createRedactor({ secrets: [12 as unknown as string, 'x'] }).secretCount).toBe(1);
    expect(createRedactor({ secrets: undefined }).secretCount).toBe(0);
    expect(createRedactor({}).secretCount).toBe(0);
  });

  it('is frozen, and the secrets array it was given cannot change it afterwards', () => {
    const core = unique();
    const secrets = [`s-${core}`];
    const redactor = createRedactor({ secrets });
    expect(Object.isFrozen(redactor)).toBe(true);
    secrets.push(`late-${core}`);
    secrets[0] = 'replaced';
    expect(redactor.secretCount).toBe(1);
    expect(redactor.scrub(`s-${core} late-${core}`)).toBe(`${REDACTED} late-${core}`);
  });

  it('withSecrets returns a new redactor and never changes the original', () => {
    const first = unique();
    const second = unique();
    const base = createRedactor({ secrets: [`first-${first}`], replacement: '<x>' });
    const extended = base.withSecrets([`second-${second}`]);
    expect(extended).not.toBe(base);
    expect(base.secretCount).toBe(1);
    expect(extended.secretCount).toBe(2);
    expect(base.scrub(`first-${first} second-${second}`)).toBe(`<x> second-${second}`);
    expect(extended.scrub(`first-${first} second-${second}`)).toBe('<x> <x>');
    expect(extended.replacement).toBe('<x>');
    const chained = extended.withSecrets([`third-${unique()}`]);
    expect(chained.secretCount).toBe(3);
    expect(extended.secretCount).toBe(2);
  });

  it('withSecrets keeps minSubstringLength and does not double count a known secret', () => {
    const base = createRedactor({ secrets: ['abc'], minSubstringLength: 2 });
    const extended = base.withSecrets(['abc', 'xyz', '']);
    expect(extended.secretCount).toBe(2);
    expect(extended.scrub('zabcz')).toBe(`z${REDACTED}z`);
    expect(
      createRedactor({ secrets: ['abc'] })
        .withSecrets([])
        .scrub('zabcz')
    ).toBe('zabcz');
    expect(createRedactor().withSecrets(['abcd']).scrub('xabcdx')).toBe(`x${REDACTED}x`);
  });

  it('withSecrets of an empty list behaves like the original', () => {
    const core = unique();
    const base = createRedactor({ secrets: [`k-${core}`] });
    const same = base.withSecrets([]);
    expect(same.scrub(`k-${core}`)).toBe(REDACTED);
    expect(same.secretCount).toBe(1);
  });

  it('keeps independent instances independent', () => {
    const a = createRedactor({ secrets: ['aaaa'] });
    const b = createRedactor({ secrets: ['bbbb'] });
    expect(a.scrub('aaaa bbbb')).toBe(`${REDACTED} bbbb`);
    expect(b.scrub('aaaa bbbb')).toBe(`aaaa ${REDACTED}`);
  });
});

describe('createRedactor: scrub', () => {
  it('returns the input unchanged when there is nothing to scrub', () => {
    const text = 'nothing to see here';
    expect(createRedactor().scrub(text)).toBe(text);
    expect(createRedactor({ secrets: ['zzzz'] }).scrub(text)).toBe(text);
    expect(createRedactor({ secrets: ['', '  '] }).scrub(text)).toBe(text);
  });

  it('replaces every occurrence of a secret', () => {
    const secret = `s-${unique()}`;
    const redactor = createRedactor({ secrets: [secret] });
    expect(redactor.scrub(`${secret} and ${secret}, then ${secret}.`)).toBe(
      `${REDACTED} and ${REDACTED}, then ${REDACTED}.`
    );
    expect(redactor.scrub(secret)).toBe(REDACTED);
    expect(redactor.scrub(`x${secret}y`)).toBe(`x${REDACTED}y`);
  });

  it('replaces several secrets and uses the configured replacement', () => {
    const one = `one-${unique()}`;
    const two = `two-${unique()}`;
    const redactor = createRedactor({ secrets: [one, two], replacement: '***' });
    expect(redactor.scrub(`${two} / ${one}`)).toBe('*** / ***');
    expect(redactor.replacement).toBe('***');
  });

  it('matches the longest secret first, in either declaration order, leaving no remnant', () => {
    const base = `base-${unique()}`;
    for (const secrets of [
      [base, `${base}XYZ`],
      [`${base}XYZ`, base],
    ]) {
      const redactor = createRedactor({ secrets });
      expect(redactor.scrub(`v=${base}XYZ;`)).toBe(`v=${REDACTED};`);
      expect(redactor.scrub(`v=${base};`)).toBe(`v=${REDACTED};`);
      expect(redactor.scrub(`v=pre${base}XYZpost`)).toBe(`v=pre${REDACTED}post`);
    }
  });

  it('merges partially overlapping matches into one replacement so no half of a secret leaks', () => {
    const left = unique();
    const middle = unique();
    const right = unique();
    const redactor = createRedactor({ secrets: [`${left}${middle}`, `${middle}${right}`] });
    expect(redactor.scrub(`a ${left}${middle}${right} b`)).toBe(`a ${REDACTED} b`);
  });

  it('scrubs a secret that overlaps itself without leaving a tail', () => {
    const redactor = createRedactor({ secrets: ['abab'] });
    expect(redactor.scrub('xababab y')).toBe(`x${REDACTED} y`);
    expect(redactor.scrub('ababab')).toBe(REDACTED);
  });

  it('keeps two adjacent occurrences as two replacements', () => {
    const secret = `s-${unique()}`;
    expect(createRedactor({ secrets: [secret] }).scrub(`${secret}${secret}`)).toBe(
      `${REDACTED}${REDACTED}`
    );
  });

  it('scrubs the trimmed value of a secret that was given with padding', () => {
    const core = unique();
    const redactor = createRedactor({ secrets: [`   pw-${core}  \n`] });
    expect(redactor.scrub(`password=pw-${core}&x=1`)).toBe(`password=${REDACTED}&x=1`);
    expect(redactor.scrub(`   pw-${core}  \n`)).toBe(REDACTED);
  });

  it('scrubs the JSON-escaped form', () => {
    const core = unique();
    const secret = `a"b\\c\nd-${core}`;
    const redactor = createRedactor({ secrets: [secret] });
    const json = JSON.stringify({ pw: secret });
    expect(json).not.toContain(secret);
    expect(redactor.scrub(json)).toBe(`{"pw":"${REDACTED}"}`);
    expect(redactor.scrub(`raw ${secret}`)).toBe(`raw ${REDACTED}`);
  });

  it('scrubs the ASCII-escaped and slash-escaped JSON forms other encoders produce', () => {
    const core = unique();
    const secret = `caf\u{e9}/\u{20ac}-${core}`;
    const redactor = createRedactor({ secrets: [secret] });
    expect(redactor.scrub(`"v":"caf\\u00e9/\\u20ac-${core}"`)).toBe(`"v":"${REDACTED}"`);
    expect(redactor.scrub(`"v":"caf\\u00E9/\\u20AC-${core}"`)).toBe(`"v":"${REDACTED}"`);
    expect(redactor.scrub(`"v":"caf\\u00e9\\/\\u20ac-${core}"`)).toBe(`"v":"${REDACTED}"`);
  });

  it('scrubs the URL-encoded form, upper and lower case hex, and the plus-for-space form', () => {
    const core = unique();
    const secret = `p@ss w/rd&x=1 ${core}`;
    const redactor = createRedactor({ secrets: [secret] });
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toContain(' ');
    expect(redactor.scrub(`?q=${encoded}&z=1`)).toBe(`?q=${REDACTED}&z=1`);
    expect(redactor.scrub(`?q=${encoded.toLowerCase()}`)).toBe(`?q=${REDACTED}`);
    expect(redactor.scrub(`?q=${encoded.replace(/%20/g, '+')}`)).toBe(`?q=${REDACTED}`);
    expect(redactor.scrub(`?q=${encoded.replace(/%20/g, '+').toLowerCase()}`)).toBe(
      `?q=${REDACTED}`
    );
  });

  it('survives a secret with an unpaired surrogate (encodeURIComponent would throw) and still scrubs it raw', () => {
    const core = unique();
    const secret = `x${String.fromCharCode(0xd800)}y-${core}`;
    expect(() => createRedactor({ secrets: [secret] })).not.toThrow();
    expect(createRedactor({ secrets: [secret] }).scrub(`a ${secret} b`)).toBe(`a ${REDACTED} b`);
  });

  it('scrubs digit grouping variants of a 16 digit card number, from any of its forms', () => {
    const forms = ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111'];
    for (const secret of forms) {
      const redactor = createRedactor({ secrets: [secret] });
      for (const form of forms) {
        expect(redactor.scrub(`card=${form};`)).toBe(`card=${REDACTED};`);
      }
    }
  });

  it('scrubs the groups of four of an 8 character digit secret and not of a 7 character one', () => {
    const eight = createRedactor({ secrets: ['12345678'] });
    expect(eight.scrub('a 1234 5678 b')).toBe(`a ${REDACTED} b`);
    expect(eight.scrub('a 1234-5678 b')).toBe(`a ${REDACTED} b`);
    const seven = createRedactor({ secrets: ['1234567'] });
    expect(seven.scrub('a 1234 567 b')).toBe('a 1234 567 b');
    expect(seven.scrub('a 123-4567 b')).toBe('a 123-4567 b');
    expect(seven.scrub('a 1234567 b')).toBe(`a ${REDACTED} b`);
  });

  it('does not derive digit forms for secrets that contain anything but digits, spaces and dashes', () => {
    const redactor = createRedactor({ secrets: ['4111-1111-abcd'] });
    expect(redactor.scrub('41111111abcd')).toBe('41111111abcd');
    expect(redactor.scrub('4111 1111 abcd')).toBe('4111 1111 abcd');
    expect(redactor.scrub('4111-1111-abcd')).toBe(REDACTED);
  });

  it('matches secrets of 4 or more characters case-insensitively', () => {
    const core = unique();
    const redactor = createRedactor({ secrets: [`Hunter-${core}`] });
    expect(redactor.scrub(`HUNTER-${core.toUpperCase()}`)).toBe(REDACTED);
    expect(redactor.scrub(`hunter-${core}`)).toBe(REDACTED);
    expect(redactor.scrub(`hUnTeR-${core}`)).toBe(REDACTED);
  });

  it('scrubs a secret of 4 characters as a substring', () => {
    const redactor = createRedactor({ secrets: ['1234'] });
    expect(redactor.scrub('x91234y')).toBe(`x9${REDACTED}y`);
    expect(redactor.scrub('1234')).toBe(REDACTED);
  });

  describe('short secrets (1 to 3 characters)', () => {
    it('are scrubbed only as whole words in free text', () => {
      const redactor = createRedactor({ secrets: ['123'] });
      expect(redactor.scrub('pin 123 ok')).toBe(`pin ${REDACTED} ok`);
      expect(redactor.scrub('123')).toBe(REDACTED);
      expect(redactor.scrub('(123)')).toBe(`(${REDACTED})`);
      expect(redactor.scrub('a-123-b')).toBe(`a-${REDACTED}-b`);
      expect(redactor.scrub('code:123.')).toBe(`code:${REDACTED}.`);
      expect(redactor.scrub('x91234y')).toBe('x91234y');
      expect(redactor.scrub('order 1234')).toBe('order 1234');
      expect(redactor.scrub('a123')).toBe('a123');
      expect(redactor.scrub('123b')).toBe('123b');
      expect(redactor.scrub('_123')).toBe('_123');
      expect(redactor.scrub('123_')).toBe('123_');
      expect(redactor.scrub('\u{e9}123')).toBe('\u{e9}123');
      expect(redactor.scrub('123\u{e9}')).toBe('123\u{e9}');
      expect(redactor.scrub('12 3')).toBe('12 3');
    });

    it('are scrubbed at every whole-word position of a longer text', () => {
      const redactor = createRedactor({ secrets: ['42'] });
      expect(redactor.scrub('42 and 42, 142, 42!')).toBe(
        `${REDACTED} and ${REDACTED}, 142, ${REDACTED}!`
      );
    });

    it('work for single characters', () => {
      const redactor = createRedactor({ secrets: ['7'] });
      expect(redactor.scrub('room 7')).toBe(`room ${REDACTED}`);
      expect(redactor.scrub('room 77')).toBe('room 77');
      expect(redactor.scrub('7')).toBe(REDACTED);
    });

    it('are matched case-sensitively as whole words', () => {
      const redactor = createRedactor({ secrets: ['Ab'] });
      expect(redactor.scrub('say Ab now')).toBe(`say ${REDACTED} now`);
      expect(redactor.scrub('say ab now')).toBe('say ab now');
      expect(redactor.scrub('about')).toBe('about');
    });

    it('apply word boundaries only where the secret itself starts or ends with a word character', () => {
      const redactor = createRedactor({ secrets: ['!x'] });
      expect(redactor.scrub('a!xb')).toBe('a!xb');
      expect(redactor.scrub('a!x b')).toBe(`a${REDACTED} b`);
      expect(redactor.scrub('a !x')).toBe(`a ${REDACTED}`);
    });

    it('are scrubbed from a structured value by exact equality, always', () => {
      const redactor = createRedactor({ secrets: ['12'] });
      expect(redactor.scrubDeep({ value: '12', other: '123', list: ['12', 'a12'] })).toEqual({
        value: REDACTED,
        other: '123',
        list: [REDACTED, 'a12'],
      });
    });

    it('honor minSubstringLength: raising it turns longer secrets into whole-word ones', () => {
      const redactor = createRedactor({ secrets: ['abcde'], minSubstringLength: 6 });
      expect(redactor.scrub('xabcdex')).toBe('xabcdex');
      expect(redactor.scrub(' abcde ')).toBe(` ${REDACTED} `);
      const exactly = createRedactor({ secrets: ['abcde'], minSubstringLength: 5 });
      expect(exactly.scrub('xabcdex')).toBe(`x${REDACTED}x`);
    });

    it('honor minSubstringLength: lowering it makes short secrets substring matches', () => {
      expect(createRedactor({ secrets: ['ab'], minSubstringLength: 2 }).scrub('cabd')).toBe(
        `c${REDACTED}d`
      );
      expect(createRedactor({ secrets: ['ab'], minSubstringLength: 3 }).scrub('cabd')).toBe('cabd');
      expect(createRedactor({ secrets: ['a'], minSubstringLength: 0 }).scrub('cat')).toBe(
        `c${REDACTED}t`
      );
    });

    it('fall back to the default minSubstringLength for a non finite value', () => {
      expect(
        createRedactor({ secrets: ['123'], minSubstringLength: Number.NaN }).scrub('a123')
      ).toBe('a123');
      expect(
        createRedactor({ secrets: ['1234'], minSubstringLength: Number.NaN }).scrub('a1234')
      ).toBe(`a${REDACTED}`);
    });

    it('also scrub the short trimmed form of a padded secret, as a whole word', () => {
      const redactor = createRedactor({ secrets: [' 12 '] });
      expect(redactor.scrub('pin=12;')).toBe(`pin=${REDACTED};`);
      expect(redactor.scrub('x123')).toBe('x123');
    });
  });

  it('is total and returns an empty string for a non-string input', () => {
    const redactor = createRedactor({ secrets: ['abcd'] });
    expect(redactor.scrub(undefined as unknown as string)).toBe('');
    expect(redactor.scrub(null as unknown as string)).toBe('');
    expect(redactor.scrub(5 as unknown as string)).toBe('');
    expect(redactor.scrub('')).toBe('');
  });

  it('is idempotent', () => {
    const core = unique();
    const redactor = createRedactor({ secrets: [`s-${core}`, '4111 1111 1111 1111', '12'] });
    const text = `a s-${core} b 4111111111111111 c 12 d ${encodeURIComponent(`s-${core}`)}`;
    const once = redactor.scrub(text);
    expect(redactor.scrub(once)).toBe(once);
    expect(once).not.toContain(core);
  });

  it('leaves no trace of the secret or its variants in randomly assembled text', () => {
    const core = unique();
    const secret = `p"w\\ /${core}`;
    const redactor = createRedactor({ secrets: [secret] });
    const fragments = [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
      secret.toUpperCase(),
      'noise',
      ' ',
      '\n',
      '&',
      '=',
      '\u{1F600}',
      String.fromCharCode(0xd800),
    ];
    let state = 17;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296;
    };
    for (let round = 0; round < 200; round += 1) {
      let text = '';
      for (let index = 0; index < 12; index += 1) {
        text += fragments[Math.floor(next() * fragments.length)] ?? '';
      }
      expect(redactor.scrub(text).toLowerCase()).not.toContain(core);
    }
  });

  it('does not backtrack catastrophically on adversarial long inputs', () => {
    const redactor = createRedactor({
      secrets: ['aaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', '4111 1111 1111 1111', 'ab', '1'],
    });
    const inputs = [
      'a'.repeat(300_000),
      'ab'.repeat(150_000),
      `${'a'.repeat(30_000)}b`.repeat(10),
      '1'.repeat(300_000),
      '4111 '.repeat(100_000),
      ' '.repeat(500_000),
      'a1 '.repeat(100_000),
    ];
    for (const input of inputs) {
      const { ms } = timed(() => redactor.scrub(input));
      expect(ms).toBeLessThan(5000);
    }
    const url = createRedactor({ secrets: ['abcd'] });
    for (const input of ['&='.repeat(300_000), '?'.repeat(300_000), '@'.repeat(300_000)]) {
      expect(timed(() => url.redactUrl(`https://h.example/p?${input}`)).ms).toBeLessThan(5000);
    }
  });
});

describe('createRedactor: scrubDeep', () => {
  it('scrubs strings and keys at every depth, in objects and arrays', () => {
    const core = unique();
    const secret = `s-${core}`;
    const redactor = createRedactor({ secrets: [secret] });
    const input = {
      title: `t ${secret}`,
      nested: { label: secret, list: [`a ${secret}`, { deep: `${secret}!` }, 5, null, true] },
      [`k-${secret}`]: 'v',
      count: 3,
      flag: false,
      none: null,
    };
    const output = redactor.scrubDeep(input);
    expect(output).toEqual({
      title: `t ${REDACTED}`,
      nested: {
        label: REDACTED,
        list: [`a ${REDACTED}`, { deep: `${REDACTED}!` }, 5, null, true],
      },
      [`k-${REDACTED}`]: 'v',
      count: 3,
      flag: false,
      none: null,
    });
    expect(JSON.stringify(output)).not.toContain(core);
  });

  it('never mutates the input and returns new containers', () => {
    const secret = `s-${unique()}`;
    const redactor = createRedactor({ secrets: [secret] });
    const input = deepFreeze({ a: secret, list: [secret, { b: secret }] });
    const output = redactor.scrubDeep(input);
    expect(input).toEqual({ a: secret, list: [secret, { b: secret }] });
    expect(output).not.toBe(input);
    expect(output.list).not.toBe(input.list);
    expect(output.list[1]).not.toBe(input.list[1]);
    expect(Object.isFrozen(output)).toBe(false);
  });

  it('copies even when there is nothing to scrub, so a caller may mutate the result', () => {
    const input = { a: 'x', list: [1, 2] };
    const output = createRedactor().scrubDeep(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.list).not.toBe(input.list);
  });

  it('passes primitives through and scrubs a top-level string', () => {
    const secret = `s-${unique()}`;
    const redactor = createRedactor({ secrets: [secret] });
    expect(redactor.scrubDeep(secret)).toBe(REDACTED);
    expect(redactor.scrubDeep(`x ${secret}`)).toBe(`x ${REDACTED}`);
    expect(redactor.scrubDeep(5)).toBe(5);
    expect(redactor.scrubDeep(true)).toBe(true);
    expect(redactor.scrubDeep(null)).toBeNull();
    expect(redactor.scrubDeep(undefined)).toBeUndefined();
    expect(redactor.scrubDeep(10n)).toBe(10n);
  });

  it('keeps undefined properties and array entries as they are', () => {
    const output = createRedactor().scrubDeep({ a: undefined, list: [undefined, 1] });
    expect(Object.prototype.hasOwnProperty.call(output, 'a')).toBe(true);
    expect(output.list).toEqual([undefined, 1]);
    expect(output.list).toHaveLength(2);
  });

  describe('identity-bearing keys', () => {
    const identityKeys = [
      'id',
      'signature',
      'fingerprint',
      'digest',
      'nonce',
      'integrity',
      'requestId',
      'callId',
      'documentId',
      'sessionId',
      'snapshotId',
      'optionId',
      'formId',
      'groupId',
      'dialogId',
      'targetCallId',
      'expectDocumentId',
      'Id',
    ];

    it('leaves strings under identity-bearing keys untouched, a secret of 1234 included', () => {
      const redactor = createRedactor({ secrets: ['1234'] });
      const input: Record<string, string> = {};
      for (const key of identityKeys) {
        input[key] = `x1234y-${key}`;
      }
      expect(redactor.scrubDeep(input)).toEqual(input);
    });

    it('still scrubs the text next to an identity, so a hex-looking secret hides in text only', () => {
      const redactor = createRedactor({ secrets: ['1234'] });
      const element = {
        id: 't1',
        signature: 'sg_1234abcd1234abcd',
        snapshotId: 'snap_1234567890ab',
        label: 'code 1234 here',
        state: { value: '1234' },
        formId: 'f1234',
      };
      expect(redactor.scrubDeep({ elements: [element] })).toEqual({
        elements: [
          {
            id: 't1',
            signature: 'sg_1234abcd1234abcd',
            snapshotId: 'snap_1234567890ab',
            label: `code ${REDACTED} here`,
            state: { value: REDACTED },
            formId: 'f1234',
          },
        ],
      });
    });

    it('leaves the identity key names themselves alone, even when a short secret equals one', () => {
      const redactor = createRedactor({ secrets: ['id'] });
      expect(redactor.scrubDeep({ id: 't1', label: 'id' })).toEqual({ id: 't1', label: REDACTED });
    });

    it('leaves arrays of strings under identity keys ending in Ids untouched', () => {
      const redactor = createRedactor({ secrets: ['1234'] });
      const input = { optionIds: ['t1.1234', 'x1234'], groupIds: ['g1234'], names: ['n1234'] };
      expect(redactor.scrubDeep(input)).toEqual({
        optionIds: ['t1.1234', 'x1234'],
        groupIds: ['g1234'],
        names: [`n${REDACTED}`],
      });
    });

    it('treats only the listed names and a trailing Id or Ids as identity keys', () => {
      const redactor = createRedactor({ secrets: ['1234'] });
      const input = {
        valid: '1234',
        grid: '1234',
        paid: '1234',
        identity: '1234',
        idx: '1234',
        signatures: '1234',
        ident: '1234',
      };
      const output = redactor.scrubDeep(input);
      for (const value of Object.values(output)) {
        expect(value).toBe(REDACTED);
      }
    });
  });

  describe('unsafe keys', () => {
    it('drops __proto__, constructor and prototype keys and never pollutes', () => {
      const redactor = createRedactor({ secrets: ['abcd'] });
      const parsed: unknown = JSON.parse(
        '{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":{"y":2},"keep":"abcd"}'
      );
      const output = redactor.scrubDeep(parsed) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual(['keep']);
      expect(output.keep).toBe(REDACTED);
      expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(false);
    });

    it('drops them at every depth and inside arrays', () => {
      const parsed: unknown = JSON.parse(
        '{"a":{"b":[{"__proto__":{"p":1},"ok":1},{"constructor":"c","prototype":"p"}]}}'
      );
      expect(createRedactor().scrubDeep(parsed)).toEqual({ a: { b: [{ ok: 1 }, {}] } });
      expect(({} as Record<string, unknown>).p).toBeUndefined();
    });

    it('does not pollute through the JSON.parse __proto__ example of the contract', () => {
      const output = createRedactor({ secrets: ['abcd'] }).scrubDeep(
        JSON.parse('{"__proto__":{"x":1}}')
      ) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual([]);
      expect(output.x).toBeUndefined();
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
  });

  it('survives a cycle by replacing the repeated reference', () => {
    const node: Record<string, unknown> = { name: 'abcd-token' };
    node.self = node;
    const list: unknown[] = [node];
    list.push(list);
    const redactor = createRedactor({ secrets: ['abcd'] });
    const output = redactor.scrubDeep({ node, list }) as {
      node: { name: string; self: unknown };
      list: unknown[];
    };
    expect(output.node.name).toBe(`${REDACTED}-token`);
    expect(output.node.self).toBe('[Circular]');
    expect(output.list[1]).toBe('[Circular]');
  });

  it('does not treat a shared, non cyclic reference as a cycle', () => {
    const shared = { v: 'abcd' };
    const output = createRedactor({ secrets: ['abcd'] }).scrubDeep({ a: shared, b: shared });
    expect(output).toEqual({ a: { v: REDACTED }, b: { v: REDACTED } });
  });

  it('bounds recursion on a very deep structure without throwing', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 20000; index += 1) {
      deep = [deep];
    }
    expect(() => createRedactor({ secrets: ['abcd'] }).scrubDeep(deep)).not.toThrow();
  });

  it('skips a property whose getter throws and keeps the rest', () => {
    const input = {
      get boom(): string {
        throw new Error('getter');
      },
      ok: 'abcd',
    };
    const output = createRedactor({ secrets: ['abcd'] }).scrubDeep(input) as Record<
      string,
      unknown
    >;
    expect(output.ok).toBe(REDACTED);
    expect(Object.prototype.hasOwnProperty.call(output, 'boom')).toBe(false);
  });

  it('copies a Date as a Date and flattens class instances to plain objects', () => {
    const date = new Date(86_400_000);
    const output = createRedactor().scrubDeep({ at: date });
    expect(output.at).toEqual(date);
    expect(output.at).not.toBe(date);
    class Box {
      readonly label = 'abcd';
    }
    const boxed = createRedactor({ secrets: ['abcd'] }).scrubDeep(new Box());
    expect(boxed).toEqual({ label: REDACTED });
  });

  it('scrubs variants too: URL-encoded and JSON-escaped forms inside nested strings', () => {
    const core = unique();
    const secret = `a b"${core}`;
    const redactor = createRedactor({ secrets: [secret] });
    const output = redactor.scrubDeep({
      q: `?x=${encodeURIComponent(secret)}`,
      j: JSON.stringify({ k: secret }),
    });
    expect(JSON.stringify(output)).not.toContain(core);
  });

  it('does not touch the secret-free text of an observation-shaped value', () => {
    const redactor = createRedactor({ secrets: [`s-${unique()}`] });
    const observation = {
      title: 'Checkout',
      elements: [{ id: 't1', label: 'Email', state: { value: 'a@b.co' } }],
      notices: ['Saved'],
    };
    expect(redactor.scrubDeep(observation)).toEqual(observation);
  });
});

describe('createRedactor: redactUrl', () => {
  const redactor = createRedactor();

  it('drops userinfo and fragment and keeps scheme, host, port, path and query', () => {
    expect(redactor.redactUrl('https://user:pw@host.example:8443/a/b?x=1&y=two#frag')).toBe(
      'https://host.example:8443/a/b?x=1&y=two'
    );
    expect(redactor.redactUrl('https://user@host.example/')).toBe('https://host.example/');
    expect(redactor.redactUrl('http://localhost:3000/x?y=1')).toBe('http://localhost:3000/x?y=1');
    expect(redactor.redactUrl('https://h.example/p#section')).toBe('https://h.example/p');
    expect(redactor.redactUrl('https://h.example/#')).toBe('https://h.example/');
    expect(redactor.redactUrl('https://h.example')).toBe('https://h.example');
  });

  it('strips userinfo up to the last @ of the authority, even when the password has an @', () => {
    expect(redactor.redactUrl('https://u:p@ss@h.example/x')).toBe('https://h.example/x');
    expect(redactor.redactUrl('https://:onlypass@h.example/x')).toBe('https://h.example/x');
    expect(redactor.redactUrl('https://u:p@h.example?z=1')).toBe('https://h.example?z=1');
  });

  it('keeps an @ that is in the path or the query', () => {
    expect(redactor.redactUrl('https://h.example/u/@name')).toBe('https://h.example/u/@name');
    expect(redactor.redactUrl('https://h.example?email=a@b.co')).toBe(
      'https://h.example?email=a@b.co'
    );
    expect(redactor.redactUrl('https://h.example/p?email=a@b.co')).toBe(
      'https://h.example/p?email=a@b.co'
    );
  });

  it('drops a fragment that holds a token, including one with its own query', () => {
    expect(redactor.redactUrl('https://h.example/cb#access_token=abc&state=1')).toBe(
      'https://h.example/cb'
    );
    expect(redactor.redactUrl('https://h.example/#/route?token=abc')).toBe('https://h.example/');
  });

  it('replaces the value of query parameters whose name is a sensitive key, keeping the names', () => {
    expect(
      redactor.redactUrl(
        'https://h.example/p?token=a&page=2&api_key=k&apiKey=k2&password=p&sessionId=s1&otp=1&cvv=1&access_token=x&refresh_token=r&q=shoes'
      )
    ).toBe(
      'https://h.example/p?token=[REDACTED]&page=2&api_key=[REDACTED]&apiKey=[REDACTED]&password=[REDACTED]&sessionId=[REDACTED]&otp=[REDACTED]&cvv=[REDACTED]&access_token=[REDACTED]&refresh_token=[REDACTED]&q=shoes'
    );
  });

  it('matches sensitive names case-insensitively, decoded, and with plus for space', () => {
    expect(redactor.redactUrl('https://h/p?TOKEN=a&api%5Fkey=b&Pass%77ord=c&api+key=d&x=e')).toBe(
      'https://h/p?TOKEN=[REDACTED]&api%5Fkey=[REDACTED]&Pass%77ord=[REDACTED]&api+key=[REDACTED]&x=e'
    );
  });

  it('does not redact names that are not sensitive keys', () => {
    expect(
      redactor.redactUrl('https://h/p?shipping=a&mapping=b&tokenize=c&username=d&email=e&key=f')
    ).toBe('https://h/p?shipping=a&mapping=b&tokenize=c&username=d&email=e&key=f');
  });

  it('keeps empty values empty and parameters without a value as they are', () => {
    expect(redactor.redactUrl('https://h/p?token=&flag&x=')).toBe('https://h/p?token=&flag&x=');
    expect(redactor.redactUrl('https://h/p?token')).toBe('https://h/p?token');
  });

  it('replaces a JWT-shaped value whatever its parameter name', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    expect(redactor.redactUrl(`https://h/p?t=${jwt}&n=1`)).toBe('https://h/p?t=[REDACTED]&n=1');
    expect(redactor.redactUrl('https://h/p?t=header.payload.signature')).toBe(
      'https://h/p?t=[REDACTED]'
    );
    expect(redactor.redactUrl('https://h/p?t=a.b.c')).toBe('https://h/p?t=[REDACTED]');
    expect(redactor.redactUrl('https://h/p?t=ey-J_x.ab-c_d.e%')).toBe(
      'https://h/p?t=ey-J_x.ab-c_d.e%'
    );
  });

  it('keeps values that have fewer or more than three dotted segments', () => {
    expect(redactor.redactUrl('https://h/p?v=a.b')).toBe('https://h/p?v=a.b');
    expect(redactor.redactUrl('https://h/p?ip=192.168.0.1')).toBe('https://h/p?ip=192.168.0.1');
    expect(redactor.redactUrl('https://h/p?v=a..c')).toBe('https://h/p?v=a..c');
  });

  it('replaces hex values of 24 or more characters and keeps shorter ones', () => {
    const hex = (length: number): string => 'a1b2c3d4e5f60718'.repeat(8).slice(0, length);
    expect(redactor.redactUrl(`https://h/p?sig=${hex(24)}`)).toBe('https://h/p?sig=[REDACTED]');
    expect(redactor.redactUrl(`https://h/p?sig=${hex(23)}`)).toBe(`https://h/p?sig=${hex(23)}`);
    expect(redactor.redactUrl(`https://h/p?sig=${hex(64)}`)).toBe('https://h/p?sig=[REDACTED]');
    expect(redactor.redactUrl(`https://h/p?sig=${hex(40).toUpperCase()}`)).toBe(
      'https://h/p?sig=[REDACTED]'
    );
  });

  it('replaces base64url runs of 24 or more characters, padding allowed, and keeps shorter ones', () => {
    const run = (length: number): string => 'Ab-_Cd9Ef0Gh1Ij2Kl3Mn4Op5Qr6St7'.slice(0, length);
    expect(redactor.redactUrl(`https://h/p?v=${run(24)}`)).toBe('https://h/p?v=[REDACTED]');
    expect(redactor.redactUrl(`https://h/p?v=${run(23)}`)).toBe(`https://h/p?v=${run(23)}`);
    expect(redactor.redactUrl(`https://h/p?v=${run(24)}==`)).toBe('https://h/p?v=[REDACTED]');
    expect(redactor.redactUrl(`https://h/p?v=${run(23)}==`)).toBe(`https://h/p?v=${run(23)}==`);
    expect(redactor.redactUrl(`https://h/p?v=${run(30)}`)).toBe('https://h/p?v=[REDACTED]');
  });

  it('decodes a percent-encoded value before judging its shape', () => {
    expect(redactor.redactUrl(`https://h/p?v=${'%61'.repeat(24)}`)).toBe(
      'https://h/p?v=[REDACTED]'
    );
    expect(redactor.redactUrl(`https://h/p?v=${'%61'.repeat(23)}`)).toBe(
      `https://h/p?v=${'%61'.repeat(23)}`
    );
    expect(redactor.redactUrl('https://h/p?v=%E0%A4%A')).toBe('https://h/p?v=%E0%A4%A');
  });

  it('keeps ordinary values: words, sentences, numbers, short ids, paths, emails', () => {
    const url =
      'https://h.example/search?q=blue+shoes&page=2&sort=price%20asc&id=12345&email=a%40b.co&next=%2Fcart&sku=AB-1234';
    expect(redactor.redactUrl(url)).toBe(url);
  });

  it('keeps path, case, encoding, trailing slash and parameter order exactly', () => {
    expect(redactor.redactUrl('HTTPS://Host.Example/A/b%20c/D/?z=1&a=2&z=3')).toBe(
      'HTTPS://Host.Example/A/b%20c/D/?z=1&a=2&z=3'
    );
    expect(redactor.redactUrl('https://h.example/?')).toBe('https://h.example/?');
  });

  it('handles scheme-relative and relative URLs', () => {
    expect(redactor.redactUrl('//u:p@h.example/x?token=t&a=1#f')).toBe(
      '//h.example/x?token=[REDACTED]&a=1'
    );
    expect(redactor.redactUrl('/path/to?token=abc&x=1')).toBe('/path/to?token=[REDACTED]&x=1');
    expect(redactor.redactUrl('page.html#top')).toBe('page.html');
    expect(redactor.redactUrl('?token=abc')).toBe('?token=[REDACTED]');
  });

  it('handles opaque and unusual schemes without throwing', () => {
    expect(redactor.redactUrl('mailto:a@b.co?subject=hi&token=abc')).toBe(
      'mailto:a@b.co?subject=hi&token=[REDACTED]'
    );
    expect(redactor.redactUrl('javascript:void(0)#x')).toBe('javascript:void(0)');
    expect(redactor.redactUrl('data:text/plain;base64,AAAA')).toBe('data:text/plain;base64,AAAA');
    expect(redactor.redactUrl('about:blank')).toBe('about:blank');
    expect(redactor.redactUrl('http://[::1]:3000/x?a=1')).toBe('http://[::1]:3000/x?a=1');
    expect(redactor.redactUrl('file:///tmp/a%20b')).toBe('file:///tmp/a%20b');
    expect(redactor.redactUrl('https://')).toBe('https://');
    expect(redactor.redactUrl('https://@')).toBe('https://');
  });

  it('scrubs text that is not a URL, and leaves it alone otherwise', () => {
    const secret = `s-${unique()}`;
    const withSecret = createRedactor({ secrets: [secret] });
    expect(withSecret.redactUrl(`not a url ${secret}`)).toBe(`not a url ${REDACTED}`);
    expect(redactor.redactUrl('not a url')).toBe('not a url');
    expect(redactor.redactUrl('what is this? maybe')).toBe('what is this? maybe');
    expect(redactor.redactUrl('')).toBe('');
  });

  it('scrubs known secrets in the path and in non sensitive query values, in their variants', () => {
    const core = unique();
    const secret = `p w-${core}`;
    const withSecret = createRedactor({ secrets: [secret] });
    expect(withSecret.redactUrl(`https://h/p/${core}x?q=${core}y`)).toBe(
      `https://h/p/${core}x?q=${core}y`
    );
    expect(withSecret.redactUrl(`https://h/p/${encodeURIComponent(secret)}?q=ok`)).toBe(
      `https://h/p/${REDACTED}?q=ok`
    );
    expect(withSecret.redactUrl(`https://h/p?q=${encodeURIComponent(secret)}&z=1`)).toBe(
      `https://h/p?q=${REDACTED}&z=1`
    );
    expect(withSecret.redactUrl(`https://h/p?q=${secret.replace(' ', '+')}&z=1`)).toBe(
      `https://h/p?q=${REDACTED}&z=1`
    );
  });

  it('uses the redactor replacement', () => {
    const custom = createRedactor({ replacement: '***' });
    expect(custom.redactUrl('https://h/p?token=abc&x=1')).toBe('https://h/p?token=***&x=1');
  });

  it('is idempotent', () => {
    const urls = [
      'https://user:pw@h.example:8443/a?token=abc&x=1#frag',
      'https://h/p?t=header.payload.signature&sig=a1b2c3d4e5f60718a1b2c3d4e5f60718',
      '//u:p@h/x?api%5Fkey=1',
      'mailto:a@b.co?token=1',
    ];
    for (const url of urls) {
      const once = redactor.redactUrl(url);
      expect(redactor.redactUrl(once)).toBe(once);
    }
  });

  it('is total on non-string input and returns an empty string for it', () => {
    expect(redactor.redactUrl(undefined as unknown as string)).toBe('');
    expect(redactor.redactUrl(null as unknown as string)).toBe('');
    expect(redactor.redactUrl(42 as unknown as string)).toBe('');
  });

  it('never throws on odd strings', () => {
    for (const odd of [
      'http://%zz/',
      'https://h/?%',
      'https://h/?=&=&=',
      'https://h/?&&&&',
      `https://h/?x=${String.fromCharCode(0xd800)}`,
      'http://a b/c d?e f=g h#i j',
      '\u{0}\u{1}',
      '://',
      '#',
      '?',
      '??##@@',
    ]) {
      expect(() => redactor.redactUrl(odd)).not.toThrow();
    }
  });
});

describe('redactEnvelope', () => {
  const scope = { sessionId: 'ses_1', snapshotId: 'snap_1', documentId: 'doc_1' };
  const target = { sessionId: 'ses_1', snapshotId: 'snap_1', targetId: 't1', signature: 'sg_abc' };
  const base = {
    scope,
    allowedOrigins: ['https://shop.example'],
    timeoutMs: 8000,
    settle: { quietMs: 150, maxMs: 2000 },
  };

  const executeEnvelope = (request: TaskCommandRequest): TaskBridgeEnvelope => ({
    protocol: 'kriya.task.v1',
    callId: 'req_call1',
    method: 'execute',
    payload: request,
    expectDocumentId: 'doc_1',
  });

  const fillRequest = (value: string, sensitive: boolean): TaskCommandRequest => ({
    ...base,
    requestId: 'req_cmd1',
    command: { operation: 'FILL', target, value, sensitive },
  });

  it('replaces a FILL value, sensitive or not, and keeps the sensitive flag', () => {
    for (const sensitive of [true, false]) {
      const raw = `v-${unique()}`;
      const envelope = executeEnvelope(fillRequest(raw, sensitive));
      const output = redactEnvelope(envelope);
      expect(JSON.stringify(output)).not.toContain(raw);
      expect(output.method).toBe('execute');
      if (output.method === 'execute' && output.payload.command.operation === 'FILL') {
        expect(output.payload.command.value).toBe(TASK_REDACTED);
        expect(output.payload.command.sensitive).toBe(sensitive);
        expect(output.payload.command.target).toEqual(target);
      } else {
        throw new Error('expected a FILL execute envelope');
      }
    }
  });

  it('replaces an empty FILL value too', () => {
    const output = redactEnvelope(executeEnvelope(fillRequest('', false)));
    expect(output.method === 'execute' && output.payload.command).toMatchObject({
      operation: 'FILL',
      value: TASK_REDACTED,
    });
  });

  it('copies every other field unchanged', () => {
    const envelope = executeEnvelope(fillRequest(`v-${unique()}`, true));
    const output = redactEnvelope(envelope);
    expect(output).toMatchObject({
      protocol: 'kriya.task.v1',
      callId: 'req_call1',
      method: 'execute',
      expectDocumentId: 'doc_1',
    });
    if (output.method === 'execute') {
      expect(output.payload.requestId).toBe('req_cmd1');
      expect(output.payload.scope).toEqual(scope);
      expect(output.payload.allowedOrigins).toEqual(['https://shop.example']);
      expect(output.payload.timeoutMs).toBe(8000);
      expect(output.payload.settle).toEqual({ quietMs: 150, maxMs: 2000 });
    }
  });

  it('never mutates the input, even a deeply frozen one, and returns a different object', () => {
    const raw = `v-${unique()}`;
    const envelope = deepFreeze(executeEnvelope(fillRequest(raw, true)));
    const output = redactEnvelope(envelope);
    expect(output).not.toBe(envelope);
    if (envelope.method === 'execute' && envelope.payload.command.operation === 'FILL') {
      expect(envelope.payload.command.value).toBe(raw);
    }
    expect(JSON.stringify(envelope)).toContain(raw);
    expect(Object.isFrozen(output)).toBe(false);
  });

  it('returns a copy that shares no mutable container with the input', () => {
    const envelope = executeEnvelope(fillRequest(`v-${unique()}`, false));
    const output = redactEnvelope(envelope);
    if (output.method === 'execute' && envelope.method === 'execute') {
      expect(output.payload).not.toBe(envelope.payload);
      expect(output.payload.command).not.toBe(envelope.payload.command);
      expect(output.payload.allowedOrigins).not.toBe(envelope.payload.allowedOrigins);
      expect(output.payload.scope).not.toBe(envelope.payload.scope);
      expect(output.payload.settle).not.toBe(envelope.payload.settle);
    }
  });

  it('copies a non-FILL execute envelope unchanged', () => {
    for (const command of [
      { operation: 'CLICK', target } as const,
      { operation: 'PRESS', target, key: 'Enter' } as const,
      { operation: 'WAIT', durationMs: 100 } as const,
      { operation: 'SET_CHECKED', target, checked: true } as const,
      { operation: 'SCROLL', direction: 'DOWN' } as const,
    ]) {
      const envelope = executeEnvelope({ ...base, requestId: 'req_x', command });
      const output = redactEnvelope(envelope);
      expect(output).toEqual(envelope);
      expect(output).not.toBe(envelope);
    }
  });

  it('copies every other method unchanged', () => {
    const envelopes: readonly TaskBridgeEnvelope[] = [
      { protocol: 'kriya.task.v1', callId: 'req_1', method: 'hello', payload: {} },
      {
        protocol: 'kriya.task.v1',
        callId: 'req_2',
        method: 'observe',
        payload: { sessionId: 'ses_1', options: { includeText: true } },
        expectDocumentId: 'doc_1',
      },
      {
        protocol: 'kriya.task.v1',
        callId: 'req_3',
        method: 'cancel',
        payload: { targetCallId: 'req_call1' },
      },
      {
        protocol: 'kriya.task.v1',
        callId: 'req_4',
        method: 'release',
        payload: { sessionId: 'ses_1' },
      },
      { protocol: 'kriya.task.v1', callId: 'req_5', method: 'dispose', payload: {} },
    ];
    for (const envelope of envelopes) {
      const output = redactEnvelope(envelope);
      expect(output).toEqual(envelope);
      expect(output).not.toBe(envelope);
    }
  });

  it('survives a JSON round trip and leaves no raw value in any serialization', () => {
    const raw = `v-${unique()}`;
    const output = redactEnvelope(executeEnvelope(fillRequest(raw, true)));
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    expect(String(JSON.stringify(output))).not.toContain(raw);
  });

  it('is total on malformed envelopes and returns a copy of whatever it is given', () => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      'text',
      12,
      [],
      {},
      { method: 'execute' },
      { method: 'execute', payload: null },
      { method: 'execute', payload: 'x' },
      { method: 'execute', payload: {} },
      { method: 'execute', payload: { command: null } },
      { method: 'execute', payload: { command: 'FILL' } },
      { method: 'execute', payload: { command: { operation: 'CLICK' } } },
    ];
    for (const value of malformed) {
      expect(() => redactEnvelope(value as TaskBridgeEnvelope)).not.toThrow();
    }
    expect(redactEnvelope({} as unknown as TaskBridgeEnvelope)).toEqual({});
    expect(redactEnvelope(null as unknown as TaskBridgeEnvelope)).toBeNull();
  });

  it('redacts the value of a FILL command even when the command has no value or a non-string one', () => {
    const noValue = redactEnvelope({
      method: 'execute',
      payload: { command: { operation: 'FILL', sensitive: true } },
    } as unknown as TaskBridgeEnvelope);
    expect(JSON.stringify(noValue)).toContain(TASK_REDACTED);
    const numeric = redactEnvelope({
      method: 'execute',
      payload: { command: { operation: 'FILL', value: 1234, sensitive: false } },
    } as unknown as TaskBridgeEnvelope);
    expect(JSON.stringify(numeric)).not.toContain('1234');
  });

  it('does not reveal a value that sits in a non-execute envelope with a command-like payload', () => {
    const envelope = {
      protocol: 'kriya.task.v1',
      callId: 'req_1',
      method: 'observe',
      payload: { sessionId: 'ses_1' },
    } as TaskBridgeEnvelope;
    expect(redactEnvelope(envelope)).toEqual(envelope);
  });

  it('keeps an own __proto__ key as data without polluting', () => {
    const hostile = JSON.parse(
      '{"method":"hello","payload":{"__proto__":{"polluted":1}},"callId":"c"}'
    ) as TaskBridgeEnvelope;
    const output = redactEnvelope(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf((output as { payload: object }).payload)).toBe(Object.prototype);
  });
});

describe('createRedactor: further escape forms of a secret', () => {
  const scrubbing = (secret: string): ((text: string) => string) =>
    createRedactor({ secrets: [secret] }).scrub;

  it('scrubs the application/x-www-form-urlencoded form that URLSearchParams produces', () => {
    const secret = `Hunter2!(pw)~'*-${unique()}`;
    const form = new URLSearchParams({ k: secret }).toString().slice(2);
    expect(form).not.toBe(encodeURIComponent(secret));
    expect(form).toContain('%21');
    expect(scrubbing(secret)(`body=${form}&x=1`)).toBe(`body=${REDACTED}&x=1`);
    const spaced = `two words!${unique()}`;
    const spacedForm = new URLSearchParams({ k: spaced }).toString().slice(2);
    expect(scrubbing(spaced)(spacedForm)).toBe(REDACTED);
  });

  it('scrubs the encodeURI form that leaves reserved characters in place', () => {
    const secret = `p@ss w/rd:x;y=1 ${unique()}`;
    const form = encodeURI(secret);
    expect(form).toContain('@');
    expect(form).not.toBe(encodeURIComponent(secret));
    expect(scrubbing(secret)(`u=${form}&z`)).toBe(`u=${REDACTED}&z`);
  });

  it('scrubs a secret whose every byte is percent-encoded, in either case of hex', () => {
    const secret = `caf\u{e9}-sec-${unique()}`;
    const every = Array.from(Buffer.from(secret, 'utf8'))
      .map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join('');
    const scrub = scrubbing(secret);
    expect(scrub(`?q=${every}&z`)).toBe(`?q=${REDACTED}&z`);
    expect(scrub(`?q=${every.toLowerCase()}&z`)).toBe(`?q=${REDACTED}&z`);
  });

  it('scrubs the doubly percent-encoded form of a URL inside a URL', () => {
    const secret = `a b/c-${unique()}`;
    const twice = encodeURIComponent(encodeURIComponent(secret));
    expect(twice).toContain('%25');
    expect(scrubbing(secret)(`?next=${twice}&z`)).toBe(`?next=${REDACTED}&z`);
  });

  it('scrubs the HTML-escaped form', () => {
    const secret = `a<b>&"c'-${unique()}`;
    const escaped = secret
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    expect(escaped).not.toBe(secret);
    expect(scrubbing(secret)(`<p>${escaped}</p>`)).toBe(`<p>${REDACTED}</p>`);
  });

  it('scrubs a JSON string that was embedded in another JSON string', () => {
    const secret = `a"b\\c-${unique()}`;
    const nested = JSON.stringify(JSON.stringify({ pw: secret }));
    expect(nested).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(scrubbing(secret)(nested)).toBe(`"{\\"pw\\":\\"${REDACTED}\\"}"`);
  });

  it('scrubs the composed and the decomposed form of a secret, whichever one was typed', () => {
    const core = unique();
    const composed = `caf\u{e9}-${core}`;
    const decomposed = `cafe\u{301}-${core}`;
    expect(scrubbing(composed)(`x ${decomposed} y`)).toBe(`x ${REDACTED} y`);
    expect(scrubbing(decomposed)(`x ${composed} y`)).toBe(`x ${REDACTED} y`);
  });

  it('scrubs the form a sanitizer leaves: collapsed whitespace and removed invisible characters', () => {
    const core = unique();
    const spaced = `two  spaces\tand\nlines-${core}`;
    expect(scrubbing(spaced)(`seen: two spaces and lines-${core}.`)).toBe(`seen: ${REDACTED}.`);
    const hidden = `zero\u{200b}width-${core}`;
    expect(scrubbing(hidden)(`seen: zerowidth-${core}.`)).toBe(`seen: ${REDACTED}.`);
    expect(scrubbing(hidden)(`seen: zero\u{200b}width-${core}.`)).toBe(`seen: ${REDACTED}.`);
  });

  it.each([
    ['AmEx', '378282246310005', ['3782 822463 10005', '3782-822463-10005', '3782.822463.10005']],
    ['Diners', '30569309025904', ['3056 930902 5904', '3056-930902-5904']],
    ['US SSN', '123456789', ['123-45-6789', '123 45 6789', '123.45.6789']],
    ['US phone', '5551234567', ['555-123-4567', '555 123 4567', '555.123.4567', '(555) 123-4567']],
  ])('scrubs the %s layout of a digit secret', (_name, secret, layouts) => {
    const scrub = scrubbing(secret);
    expect(scrub(`n=${secret};`)).toBe(`n=${REDACTED};`);
    for (const layout of layouts) {
      expect(scrub(`n=${layout};`)).toBe(`n=${REDACTED};`);
    }
  });

  it('derives layouts only for the lengths that have one', () => {
    expect(scrubbing('4111111111111111')('n=4111 111111 11111;')).toBe('n=4111 111111 11111;');
    expect(scrubbing('12345678901')('n=123-456-7890-1;')).toBe('n=123-456-7890-1;');
    expect(scrubbing('12345678')('n=123-45-678;')).toBe('n=123-45-678;');
    expect(scrubbing('12345678')('n=1234-5678;')).toBe(`n=${REDACTED};`);
    expect(scrubbing('3782822463100')('n=3782 822463 100;')).toBe('n=3782 822463 100;');
  });
});

describe('createRedactor: redactUrl, forms a browser also accepts', () => {
  const redactor = createRedactor();

  it.each([
    ['https:\\\\u:pw@h.example/a', 'https:\\\\h.example/a'],
    ['https:/u:pw@h.example/a', 'https:/h.example/a'],
    ['https:///u:pw@h.example/a', 'https:///h.example/a'],
    ['https:u:pw@h.example/a', 'https:h.example/a'],
    ['https:/\\u:pw@h.example/a', 'https:/\\h.example/a'],
    ['HTTPS://u:pw@h.example/a', 'HTTPS://h.example/a'],
    ['ws://u:pw@h.example/a', 'ws://h.example/a'],
    ['wss://u:pw@h.example/a', 'wss://h.example/a'],
    ['ftp://u:pw@h.example/a', 'ftp://h.example/a'],
    ['\\\\u:pw@h.example/a', '\\\\h.example/a'],
    ['///u:pw@h.example/a', '///h.example/a'],
    ['/\\u:pw@h.example/a', '/\\h.example/a'],
    ['ssh://git@h.example/x.git', 'ssh://h.example/x.git'],
    ['ws:\\\\u:pw@h.example/a', 'ws:\\\\h.example/a'],
    ['wss:/u:pw@h.example/a', 'wss:/h.example/a'],
    ['ftp:u:pw@h.example/a', 'ftp:h.example/a'],
  ])('drops the userinfo of %s', (url, expected) => {
    expect(redactor.redactUrl(url)).toBe(expected);
  });

  it('keeps an @ that is not in the authority, in any slash style', () => {
    for (const url of [
      'https:/medium.com/@user/post',
      'https:\\\\medium.com\\@user\\post',
      'https:///medium.com/@user',
      'custom:/user@h.example',
      'custom:user@h.example',
      'custom:///user@h.example',
      'file:///home/@u/x',
      'mailto:a@b.co',
      'localhost:3000/a@b',
      'example.com:80/@x',
      '/@user/post',
      '//h.example/@user',
    ]) {
      expect(redactor.redactUrl(url)).toBe(url);
    }
  });

  it('treats the semicolon as a parameter separator, keeping the separators as they were', () => {
    expect(redactor.redactUrl('https://h/p?a=1;token=abc;b=2')).toBe(
      'https://h/p?a=1;token=[REDACTED];b=2'
    );
    expect(redactor.redactUrl('https://h/p?a=1&b=2;api_key=k&c=3')).toBe(
      'https://h/p?a=1&b=2;api_key=[REDACTED]&c=3'
    );
    const hex = 'a1b2c3d4e5f60718293a4b5c';
    expect(redactor.redactUrl(`https://h/p?a=1;${hex}`)).toBe('https://h/p?a=1;[REDACTED]');
    expect(redactor.redactUrl('https://h/p?style=color:red;x=1')).toBe(
      'https://h/p?style=color:red;x=1'
    );
  });

  it('replaces a query value that is itself a URL carrying a token or userinfo', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const masked = 'https://h/cb?next=[REDACTED]';
    expect(redactor.redactUrl('https://h/cb?next=/login?token=abc')).toBe(masked);
    expect(
      redactor.redactUrl(
        `https://h/cb?next=${encodeURIComponent('https://a.example/p?access_token=xyz')}`
      )
    ).toBe(masked);
    expect(redactor.redactUrl(`https://h/cb?next=${encodeURIComponent(`/p?code=${hex}`)}`)).toBe(
      masked
    );
    expect(
      redactor.redactUrl(`https://h/cb?next=${encodeURIComponent('https://u:pw@a.example/')}`)
    ).toBe(masked);
    expect(
      redactor.redactUrl(
        `https://h/cb?next=${encodeURIComponent('https://a.example/p?x=1#access_token=abc')}`
      )
    ).toBe(masked);
  });

  it('inspects URLs nested three levels deep', () => {
    let nested = '/end?token=abc';
    for (let level = 0; level < 2; level += 1) {
      nested = `/hop?next=${encodeURIComponent(nested)}`;
    }
    expect(redactor.redactUrl(`https://h/cb?next=${encodeURIComponent(nested)}`)).toBe(
      'https://h/cb?next=[REDACTED]'
    );
  });

  it('keeps a nested URL that carries nothing secret', () => {
    for (const url of [
      'https://h/cb?next=%2Fcart',
      'https://h/cb?next=%2Fsearch%3Fq%3Dshoes%26page%3D2',
      'https://h/cb?redirect_uri=https%3A%2F%2Fapp.example%2Fcb',
      'https://h/cb?continue=https%3A%2F%2Fa.example%2Fp%3Fx%3D1',
      'https://h/cb?q=what+is+this%3F',
      'https://h/cb?ref=/cart#checkout',
    ]) {
      const expected = url.includes('#') ? url.split('#')[0] : url;
      expect(redactor.redactUrl(url)).toBe(expected);
    }
  });

  it('stays idempotent and fast on hostile nesting', () => {
    const urls = [
      'https://h/cb?next=/login?token=abc',
      'https://h/cb?a=1;token=abc',
      'https:\\\\u:pw@h.example/a',
      `https://h/cb?a=${'?'.repeat(100_000)}`,
      `https://h/cb?${'x=?'.repeat(30_000)}`,
      `https://h/cb?next=${'%253F'.repeat(20_000)}`,
    ];
    for (const url of urls) {
      const first = timed(() => redactor.redactUrl(url));
      expect(first.ms).toBeLessThan(5000);
      expect(redactor.redactUrl(first.result)).toBe(first.result);
    }
  });
});

describe('utilities never throw on hostile objects', () => {
  const secret = `s-${unique()}`;
  const redactor = createRedactor({ secrets: [secret] });
  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };
  const throwingList = (): unknown[] => {
    const list: unknown[] = ['kept', 'second'];
    Object.defineProperty(list, 0, {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    return list;
  };

  it('scrubDeep replaces an unreadable node and still scrubs its siblings', () => {
    const output = redactor.scrubDeep({
      bad: revoked(),
      text: `x ${secret}`,
      list: [revoked(), secret],
    });
    expect(output).toEqual({ bad: REDACTED, text: `x ${REDACTED}`, list: [REDACTED, REDACTED] });
  });

  it('scrubDeep replaces an array element whose getter throws and keeps the length', () => {
    const output = redactor.scrubDeep({ list: throwingList() });
    expect(output).toEqual({ list: [REDACTED, 'second'] });
  });

  it('scrubDeep reads an object whose key listing throws as empty', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      }
    );
    expect(redactor.scrubDeep({ hostile, text: secret })).toEqual({ hostile: {}, text: REDACTED });
  });

  it('scrubDeep of an unreadable root does not throw', () => {
    expect(redactor.scrubDeep(revoked())).toBe(REDACTED);
  });

  it('redactEnvelope copies an unreadable node as null instead of throwing', () => {
    const envelope = {
      protocol: 'kriya.task.v1',
      callId: 'req_1',
      method: 'observe',
      payload: { bad: revoked(), list: throwingList(), ok: 1 },
    } as unknown as TaskBridgeEnvelope;
    const output = redactEnvelope(envelope) as unknown as {
      payload: { bad: unknown; list: unknown; ok: unknown };
    };
    expect(output.payload).toEqual({ bad: null, list: [null, 'second'], ok: 1 });
  });

  it('redactParameters reads an unreadable parameters object as empty and masks an unreadable fields', () => {
    expect(redactParameters(revoked() as unknown as Record<string, string>)).toEqual({});
    expect(redactParameters({ fields: revoked() as unknown as string })).toEqual({
      fields: REDACTED,
    });
  });
});

describe('isSensitiveKey: unseparated compounds of the corpus', () => {
  it.each([
    'cardnumber',
    'CardNumber',
    'ccnumber',
    'creditcard',
    'cardnum',
    'ccnum',
    'creditcardnumber',
    'cardcvv',
    'cvvcode',
    'securitycode',
    'accountnumber',
    'routingnumber',
    'sessionid',
    'sessiontoken',
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'apitoken',
    'privatekey',
    'secretkey',
    'newpassword',
    'oldpassword',
    'currentpassword',
    'confirmpassword',
  ])('treats the unseparated %s as sensitive', key => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'cardholder',
    'cardinal',
    'discard',
    'cardboard',
    'accumulate',
    'creditor',
    'numbers',
    'accountant',
    'sessions',
    'keyboard',
    'secretary',
    'tokenizer',
    'privatekeyboard',
    'routingtable',
  ])('still treats %s as an ordinary word', key => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('isSensitiveKey: acronym boundaries inside a key', () => {
  it.each(['PINEntry', 'SSNField', 'OTPInput', 'CVVField', 'JWTValue', 'CCExpiry', 'userPINEntry'])(
    'splits the acronym of %s from the word after it',
    key => {
      expect(isSensitiveKey(key)).toBe(true);
    }
  );

  it.each(['XMLHTTPRequest', 'HTMLElement', 'URLPath', 'userID', 'PINTEREST', 'SSNs'])(
    'does not find a sensitive word in %s',
    key => {
      expect(isSensitiveKey(key)).toBe(false);
    }
  );
});

describe('createRedactor: redactUrl, JWT shape', () => {
  const redactor = createRedactor();
  const header = 'eyJhbGciOiJub25lIn0';
  const payload = 'eyJzdWIiOiIxIn0';

  it('replaces an unsigned JWT: an eyJ header and payload with an empty signature', () => {
    expect(redactor.redactUrl(`https://h/p?t=${header}.${payload}.`)).toBe(
      'https://h/p?t=[REDACTED]'
    );
    expect(redactor.redactUrl(`https://h/p?${header}.${payload}.`)).toBe('https://h/p?[REDACTED]');
  });

  it('keeps a dotted value with an empty last segment unless its header is an eyJ header', () => {
    expect(redactor.redactUrl('https://h/p?v=a.b.')).toBe('https://h/p?v=a.b.');
    expect(redactor.redactUrl('https://h/p?v=host.example.')).toBe('https://h/p?v=host.example.');
    expect(redactor.redactUrl(`https://h/p?v=${header}.${payload}`)).toBe(
      'https://h/p?v=' + header + '.' + payload
    );
  });
});

describe('createRedactor: secrets given as another iterable or as a bare string', () => {
  const asSecrets = (value: unknown): readonly string[] => value as readonly string[];

  it('scrubs the members of a Set or a generator instead of silently scrubbing nothing', () => {
    const one = `one-${unique()}`;
    const two = `two-${unique()}`;
    const fromSet = createRedactor({ secrets: asSecrets(new Set([one, two])) });
    expect(fromSet.secretCount).toBe(2);
    expect(fromSet.scrub(`${one} ${two}`)).toBe(`${REDACTED} ${REDACTED}`);
    const generated = createRedactor({
      secrets: asSecrets(
        (function* secrets() {
          yield one;
        })()
      ),
    });
    expect(generated.scrub(`${one} ${two}`)).toBe(`${REDACTED} ${two}`);
    expect(
      createRedactor()
        .withSecrets(asSecrets(new Set([one])))
        .scrub(one)
    ).toBe(REDACTED);
  });

  it('treats a bare string as one secret and ignores other values', () => {
    const secret = `bare-${unique()}`;
    expect(createRedactor({ secrets: asSecrets(secret) }).scrub(`x ${secret}`)).toBe(
      `x ${REDACTED}`
    );
    expect(createRedactor({ secrets: asSecrets(5) }).secretCount).toBe(0);
    expect(createRedactor({ secrets: asSecrets({ length: 1, 0: 'abcd' }) }).secretCount).toBe(0);
    expect(createRedactor({ secrets: asSecrets(null) }).secretCount).toBe(0);
  });

  it('survives an iterable that throws', () => {
    const hostile = {
      [Symbol.iterator]: () => {
        throw new Error('boom');
      },
    };
    expect(createRedactor({ secrets: asSecrets(hostile) }).secretCount).toBe(0);
  });
});
