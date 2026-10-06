/** @jest-environment node */
import { capFieldValue, compareFieldValues } from '@/utils/value';
import { TASK_LIMITS } from '@/types';
import type { TaskCapFieldValueFn, TaskCompareFieldValuesFn, TaskValueMatch } from '@/types';

export const seamConformance: {
  readonly capFieldValue: TaskCapFieldValueFn;
  readonly compareFieldValues: TaskCompareFieldValuesFn;
} = { capFieldValue, compareFieldValues };

const LIMIT = TASK_LIMITS.valueChars;
const EMOJI = '\u{1F600}';

const codePointLength = (text: string): number => Array.from(text).length;

const hasLoneSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

describe('capFieldValue', () => {
  it('uses TASK_LIMITS.valueChars as the budget', () => {
    expect(LIMIT).toBe(500);
  });

  it('keeps a short value untouched and reports it was not truncated', () => {
    expect(capFieldValue('')).toEqual({ value: '', truncated: false });
    expect(capFieldValue('hello')).toEqual({ value: 'hello', truncated: false });
  });

  it('is exact on both sides of the boundary', () => {
    expect(capFieldValue('a'.repeat(LIMIT - 1))).toEqual({
      value: 'a'.repeat(LIMIT - 1),
      truncated: false,
    });
    expect(capFieldValue('a'.repeat(LIMIT))).toEqual({
      value: 'a'.repeat(LIMIT),
      truncated: false,
    });
    expect(capFieldValue('a'.repeat(LIMIT + 1))).toEqual({
      value: 'a'.repeat(LIMIT),
      truncated: true,
    });
    expect(capFieldValue('a'.repeat(10_000))).toEqual({
      value: 'a'.repeat(LIMIT),
      truncated: true,
    });
  });

  it('keeps the first characters, in order, when it cuts', () => {
    const value = Array.from({ length: LIMIT + 20 }, (_, index) => String(index % 10)).join('');
    const capped = capFieldValue(value);
    expect(capped.truncated).toBe(true);
    expect(capped.value).toBe(value.slice(0, LIMIT));
  });

  it('counts code points, so astral characters are not cut in half and are not over-counted', () => {
    expect(capFieldValue(EMOJI.repeat(LIMIT))).toEqual({
      value: EMOJI.repeat(LIMIT),
      truncated: false,
    });
    const over = capFieldValue(EMOJI.repeat(LIMIT + 1));
    expect(over.truncated).toBe(true);
    expect(over.value).toBe(EMOJI.repeat(LIMIT));
    expect(over.value.length).toBe(LIMIT * 2);
    expect(hasLoneSurrogate(over.value)).toBe(false);
  });

  it('cuts on a code point boundary when an astral character straddles the limit', () => {
    const before = capFieldValue(`${'a'.repeat(LIMIT - 1)}${EMOJI}tail`);
    expect(before.value).toBe(`${'a'.repeat(LIMIT - 1)}${EMOJI}`);
    expect(before.truncated).toBe(true);
    expect(codePointLength(before.value)).toBe(LIMIT);
    const after = capFieldValue(`${'a'.repeat(LIMIT)}${EMOJI}`);
    expect(after.value).toBe('a'.repeat(LIMIT));
    expect(after.truncated).toBe(true);
    expect(hasLoneSurrogate(after.value)).toBe(false);
    const exact = capFieldValue(`${'a'.repeat(LIMIT - 1)}${EMOJI}`);
    expect(exact.truncated).toBe(false);
    expect(exact.value).toBe(`${'a'.repeat(LIMIT - 1)}${EMOJI}`);
  });

  it('counts an unpaired surrogate as one code point and never creates one', () => {
    const lone = String.fromCharCode(0xd800);
    const value = `${lone}${'a'.repeat(LIMIT)}`;
    const capped = capFieldValue(value);
    expect(capped.truncated).toBe(true);
    expect(capped.value).toBe(`${lone}${'a'.repeat(LIMIT - 1)}`);
    expect(capFieldValue(lone)).toEqual({ value: lone, truncated: false });
    const loneLow = String.fromCharCode(0xdc00);
    expect(capFieldValue(`${'a'.repeat(LIMIT - 1)}${loneLow}${loneLow}`).value).toBe(
      `${'a'.repeat(LIMIT - 1)}${loneLow}`
    );
  });

  it('does not alter, trim or normalize what it keeps', () => {
    const value = `  mixed\r\n\tcontent \u{e9}  `;
    expect(capFieldValue(value)).toEqual({ value, truncated: false });
  });

  it('is total on a non-string input', () => {
    expect(capFieldValue(undefined as unknown as string)).toEqual({ value: '', truncated: false });
    expect(capFieldValue(null as unknown as string)).toEqual({ value: '', truncated: false });
  });

  it('is fast on a very long value', () => {
    const started = Date.now();
    const capped = capFieldValue('x'.repeat(5_000_000));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(capped.truncated).toBe(true);
    expect(capped.value).toHaveLength(LIMIT);
  });

  it('feeds compareFieldValues so a long textarea value compares like with like', () => {
    const typed = 'word '.repeat(300);
    const observed = capFieldValue(typed).value;
    expect(compareFieldValues(typed, observed)).toBe('different');
    expect(compareFieldValues(capFieldValue(typed).value, observed)).toBe('exact');
  });
});

describe('compareFieldValues: exact', () => {
  it('is exact for identical strings', () => {
    expect(compareFieldValues('hello', 'hello')).toBe('exact');
    expect(compareFieldValues('', '')).toBe('exact');
    expect(compareFieldValues('a b', 'a b')).toBe('exact');
    expect(compareFieldValues('\u{1F600}', '\u{1F600}')).toBe('exact');
  });

  it('is exact after Unicode NFC normalization', () => {
    expect(compareFieldValues('\u{e9}', 'e\u{301}')).toBe('exact');
    expect(compareFieldValues('e\u{301}', '\u{e9}')).toBe('exact');
    expect(compareFieldValues('A\u{30a}', '\u{c5}')).toBe('exact');
  });

  it('is exact when only the line ending differs (CRLF and CR become LF)', () => {
    expect(compareFieldValues('a\r\nb', 'a\nb')).toBe('exact');
    expect(compareFieldValues('a\nb', 'a\r\nb')).toBe('exact');
    expect(compareFieldValues('a\rb', 'a\nb')).toBe('exact');
    expect(compareFieldValues('a\r\nb\r\nc', 'a\rb\nc')).toBe('exact');
  });

  it('does not treat a lone LF difference in count as exact', () => {
    expect(compareFieldValues('a\n\nb', 'a\nb')).toBe('equivalent');
  });
});

describe('compareFieldValues: equivalent', () => {
  it('is equivalent when only the case differs (an upper-casing page)', () => {
    expect(compareFieldValues('hello world', 'HELLO WORLD')).toBe('equivalent');
    expect(compareFieldValues('Jane Doe', 'jane doe')).toBe('equivalent');
    expect(compareFieldValues('jane@example.com', 'JANE@EXAMPLE.COM')).toBe('equivalent');
  });

  it('is equivalent when only leading or trailing whitespace differs', () => {
    expect(compareFieldValues('hello', '  hello  ')).toBe('equivalent');
    expect(compareFieldValues('  hello', 'hello')).toBe('equivalent');
    expect(compareFieldValues('hello\n', 'hello')).toBe('equivalent');
  });

  it('is equivalent when whitespace runs differ', () => {
    expect(compareFieldValues('a  b', 'a b')).toBe('equivalent');
    expect(compareFieldValues('a\t b', 'a b')).toBe('equivalent');
    expect(compareFieldValues('a\n\nb', 'a b')).toBe('equivalent');
  });

  it('is equivalent when phone numbers differ only by grouping', () => {
    expect(compareFieldValues('5551234567', '(555) 123-4567')).toBe('equivalent');
    expect(compareFieldValues('(555) 123-4567', '555-123-4567')).toBe('equivalent');
    expect(compareFieldValues('555.123.4567', '555 123 4567')).toBe('equivalent');
    expect(compareFieldValues('+15551234567', '+1 555 123 4567')).toBe('equivalent');
    expect(compareFieldValues('+1 (555) 123-4567', '15551234567')).toBe('equivalent');
  });

  it('is equivalent when card numbers differ only by grouping', () => {
    expect(compareFieldValues('4111111111111111', '4111 1111 1111 1111')).toBe('equivalent');
    expect(compareFieldValues('4111-1111-1111-1111', '4111 1111 1111 1111')).toBe('equivalent');
    expect(compareFieldValues('4111 1111 1111 1111', '4111111111111111')).toBe('equivalent');
  });

  it('combines the rules: case, trim and collapse together', () => {
    expect(compareFieldValues('Jane   Doe', '  JANE DOE\n')).toBe('equivalent');
  });

  it('is equivalent across NFC and CRLF together with a presentation difference', () => {
    expect(compareFieldValues('Caf\u{e9}\nBar', 'CAFE\u{301}\r\nBAR')).toBe('equivalent');
  });

  it('does not apply the digit rule unless both strings are made only of digits and separators', () => {
    expect(compareFieldValues('5551234567', '555-123-4567 ext 1')).toBe('different');
    expect(compareFieldValues('5551234567x', '555-123-4567')).toBe('different');
    expect(compareFieldValues('call 5551234567', '555-123-4567')).toBe('different');
    expect(compareFieldValues('5551234567', '555-123-4567x')).toBe('different');
  });

  it('does not treat separators alone as equivalent to each other', () => {
    expect(compareFieldValues('---', '...')).toBe('different');
    expect(compareFieldValues('-', '.')).toBe('different');
    expect(compareFieldValues('()', '+')).toBe('different');
  });

  it('treats whitespace only strings as equivalent to the empty string', () => {
    expect(compareFieldValues('', '   ')).toBe('equivalent');
    expect(compareFieldValues('\t', '')).toBe('equivalent');
  });
});

describe('compareFieldValues: different', () => {
  it('is different for another value', () => {
    expect(compareFieldValues('hello', 'world')).toBe('different');
    expect(compareFieldValues('a', 'b')).toBe('different');
    expect(compareFieldValues('', 'x')).toBe('different');
    expect(compareFieldValues('x', '')).toBe('different');
  });

  it('is different for a prefix, in either direction', () => {
    expect(compareFieldValues('hello world', 'hello')).toBe('different');
    expect(compareFieldValues('hello', 'hello world')).toBe('different');
    expect(compareFieldValues('jane@example.com', 'jane@example.co')).toBe('different');
  });

  it('is different for a truncation, in either direction', () => {
    const full = 'abcdefghij'.repeat(60);
    const cut = capFieldValue(full).value;
    expect(compareFieldValues(full, cut)).toBe('different');
    expect(compareFieldValues(cut, full)).toBe('different');
  });

  it('is different for digits against letters', () => {
    expect(compareFieldValues('12345', 'abcde')).toBe('different');
    expect(compareFieldValues('5551234567', '555123456l')).toBe('different');
    expect(compareFieldValues('1234', '12a4')).toBe('different');
    expect(compareFieldValues('abcde', '12345')).toBe('different');
  });

  it('is different for digit strings with other digits or another length', () => {
    expect(compareFieldValues('5551234567', '(555) 123-4568')).toBe('different');
    expect(compareFieldValues('4111111111111111', '4111 1111 1111 111')).toBe('different');
    expect(compareFieldValues('4111111111111111', '4111 1111 1111 1111 1')).toBe('different');
    expect(compareFieldValues('1234', '123')).toBe('different');
  });

  it('is different when words are reordered or letters are doubled', () => {
    expect(compareFieldValues('Jane Doe', 'Doe Jane')).toBe('different');
    expect(compareFieldValues('Jane', 'Janee')).toBe('different');
  });

  it('is different for a string that merely contains the other', () => {
    expect(compareFieldValues('jane', 'xjane')).toBe('different');
    expect(compareFieldValues('jane', 'janex')).toBe('different');
  });
});

describe('compareFieldValues: a sign or a decimal point is not grouping', () => {
  it('keeps a negative number different from the same digits without the sign', () => {
    expect(compareFieldValues('-5', '5')).toBe('different');
    expect(compareFieldValues('5', '-5')).toBe('different');
    expect(compareFieldValues('-1200', '1200')).toBe('different');
    expect(compareFieldValues(' -5 ', '5')).toBe('different');
  });

  it('keeps a hyphen between digit groups as grouping, and equal signs equivalent', () => {
    expect(compareFieldValues('555-123-4567', '5551234567')).toBe('equivalent');
    expect(compareFieldValues('-5', '- 5')).toBe('equivalent');
    expect(compareFieldValues('-5', '-5')).toBe('exact');
  });

  it('keeps a decimal different from the digits without the point, in either direction', () => {
    expect(compareFieldValues('1.5', '15')).toBe('different');
    expect(compareFieldValues('15', '1.5')).toBe('different');
    expect(compareFieldValues('10.50', '1050')).toBe('different');
    expect(compareFieldValues('0.5', '05')).toBe('different');
  });

  it('still treats dots between three or more groups as grouping', () => {
    expect(compareFieldValues('555.123.4567', '5551234567')).toBe('equivalent');
    expect(compareFieldValues('555.123.4567', '(555) 123-4567')).toBe('equivalent');
  });

  it('does not apply digit grouping to a number input at all', () => {
    expect(compareFieldValues('1.5', '15', { inputType: 'number' })).toBe('different');
    expect(compareFieldValues('-5', '5', { inputType: 'number' })).toBe('different');
    expect(compareFieldValues('5', '+5', { inputType: 'number' })).toBe('different');
    expect(compareFieldValues('1 2', '12', { inputType: 'NUMBER' })).toBe('different');
    expect(compareFieldValues('42', ' 42 ', { inputType: 'number' })).toBe('exact');
  });

  it('keeps grouping equivalence for the other types that the browser trims', () => {
    expect(compareFieldValues('5551234567', '555 123 4567', { inputType: 'tel' })).toBe(
      'equivalent'
    );
    expect(compareFieldValues('5551234567', '555-123-4567', { inputType: 'search' })).toBe(
      'equivalent'
    );
  });
});

describe('compareFieldValues: input types', () => {
  it.each(['email', 'tel', 'url', 'number', 'search'])(
    'trims both sides before comparing for type %s, which makes padding exact',
    inputType => {
      expect(compareFieldValues('value', '  value  ', { inputType })).toBe('exact');
      expect(compareFieldValues('  value', 'value\n', { inputType })).toBe('exact');
      expect(compareFieldValues('value', 'other', { inputType })).toBe('different');
    }
  );

  it('does not trim for other types, where padding is only equivalent', () => {
    expect(compareFieldValues('value', '  value  ', { inputType: 'text' })).toBe('equivalent');
    expect(compareFieldValues('value', '  value  ', { inputType: 'textarea' })).toBe('equivalent');
    expect(compareFieldValues('value', '  value  ', {})).toBe('equivalent');
    expect(compareFieldValues('value', '  value  ')).toBe('equivalent');
    expect(compareFieldValues('value', '  value  ', { inputType: undefined })).toBe('equivalent');
  });

  it('matches the type case-insensitively', () => {
    expect(compareFieldValues('a@b.co', ' a@b.co ', { inputType: 'EMAIL' })).toBe('exact');
    expect(compareFieldValues('a@b.co', ' a@b.co ', { inputType: 'Email' })).toBe('exact');
  });

  it('keeps an email case difference equivalent rather than exact', () => {
    expect(compareFieldValues('a@b.co', ' A@B.CO ', { inputType: 'email' })).toBe('equivalent');
  });

  it('handles number input padding and keeps different numbers different', () => {
    expect(compareFieldValues('42', ' 42 ', { inputType: 'number' })).toBe('exact');
    expect(compareFieldValues('42', '43', { inputType: 'number' })).toBe('different');
    expect(compareFieldValues('42', '4', { inputType: 'number' })).toBe('different');
    expect(compareFieldValues('42', '42.0', { inputType: 'number' })).toBe('different');
  });

  it('normalizes line endings and NFC for every type', () => {
    expect(compareFieldValues('a\r\nb', 'a\nb', { inputType: 'text' })).toBe('exact');
    expect(compareFieldValues('\u{e9}', 'e\u{301}', { inputType: 'email' })).toBe('exact');
  });

  it('applies the digit grouping rule for tel and for other types alike', () => {
    expect(compareFieldValues('5551234567', '(555) 123-4567', { inputType: 'tel' })).toBe(
      'equivalent'
    );
    expect(compareFieldValues('5551234567', '(555) 123-4567', { inputType: 'text' })).toBe(
      'equivalent'
    );
  });
});

describe('compareFieldValues: totality', () => {
  const samples = [
    '',
    ' ',
    'a',
    '\u{1F600}',
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdc00),
    `a${String.fromCharCode(0xd800)}b`,
    '\u{0}',
    '\r\n',
    '\u{e9}',
    'e\u{301}',
    '12 34',
    '+',
    '(',
    'x'.repeat(2000),
  ];
  const match: readonly TaskValueMatch[] = ['exact', 'equivalent', 'different'];

  it('never throws and always answers one of the three verdicts, for any pair of samples', () => {
    for (const expected of samples) {
      for (const observed of samples) {
        for (const inputType of [undefined, 'email', 'text', 'tel', 'number', 'url', 'search']) {
          const verdict = compareFieldValues(expected, observed, { inputType });
          expect(match).toContain(verdict);
        }
      }
    }
  });

  it('is reflexive and symmetric on the samples', () => {
    for (const first of samples) {
      expect(compareFieldValues(first, first)).toBe('exact');
      for (const second of samples) {
        expect(compareFieldValues(first, second)).toBe(compareFieldValues(second, first));
      }
    }
  });

  it('is total on non-string input', () => {
    expect(compareFieldValues(undefined as unknown as string, 'x')).toBe('different');
    expect(compareFieldValues('x', null as unknown as string)).toBe('different');
    expect(compareFieldValues(undefined as unknown as string, undefined as unknown as string)).toBe(
      'exact'
    );
  });

  it('handles very long input quickly', () => {
    const left = 'ab '.repeat(300_000);
    const right = 'AB '.repeat(300_000);
    const started = Date.now();
    expect(compareFieldValues(left, right)).toBe('equivalent');
    expect(compareFieldValues(left, `${right}x`)).toBe('different');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
