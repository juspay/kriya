import { TASK_LIMITS } from '@/types';
import type { TaskCapFieldValueFn, TaskCompareFieldValuesFn } from '@/types';

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** The one cap for observed field values and for the expectation compared with them (code points). */
export const capFieldValue: TaskCapFieldValueFn = value => {
  const text = typeof value === 'string' ? value : '';
  const limit = TASK_LIMITS.valueChars;
  if (text.length <= limit) {
    return { value: text, truncated: false };
  }
  let index = 0;
  let count = 0;
  while (index < text.length && count < limit) {
    const pair =
      isHighSurrogate(text.charCodeAt(index)) &&
      index + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(index + 1));
    index += pair ? 2 : 1;
    count += 1;
  }
  return index >= text.length
    ? { value: text, truncated: false }
    : { value: text.slice(0, index), truncated: true };
};

// Input types whose value the browser itself sanitizes by trimming.
const TRIMMED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'email',
  'tel',
  'url',
  'number',
  'search',
]);

// A number input has no digit grouping: its `-` is a sign and its `.` a decimal point.
const NUMERIC_INPUT_TYPES: ReadonlySet<string> = new Set(['number']);

const DIGITS_AND_SEPARATORS = /^[0-9 ()+.-]*$/;
const SEPARATORS = /[ ()+.-]/g;
const DECIMAL_NUMBER = /^[0-9]+\.[0-9]+$/;

const normalize = (text: string, trim: boolean): string => {
  const unified = text.normalize('NFC').replace(/\r\n?/g, '\n');
  return trim ? unified.trim() : unified;
};

const fold = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

const digitsOnly = (text: string): string => text.replace(SEPARATORS, '');

// Phone and card grouping only. A leading hyphen is a sign and a lone `1.5` is a decimal, so neither may
// be dropped as a separator: `-5` is not `5` and `1.5` is not `15`.
const differsByGroupingOnly = (left: string, right: string): boolean => {
  if (!DIGITS_AND_SEPARATORS.test(left) || !DIGITS_AND_SEPARATORS.test(right)) {
    return false;
  }
  if (left.startsWith('-') !== right.startsWith('-')) {
    return false;
  }
  if (DECIMAL_NUMBER.test(left) || DECIMAL_NUMBER.test(right)) {
    return false;
  }
  const digits = digitsOnly(left);
  return digits !== '' && digits === digitsOnly(right);
};

/**
 * exact: equal after NFC and line ending normalization (and trimming for the types the browser trims).
 * equivalent: only presentation differs (case, padding, whitespace runs, digit grouping).
 * different: anything else, in particular a prefix, a truncation, another value or digits against letters.
 */
export const compareFieldValues: TaskCompareFieldValuesFn = (expected, observed, options) => {
  const inputType = typeof options?.inputType === 'string' ? options.inputType.toLowerCase() : '';
  const trim = TRIMMED_INPUT_TYPES.has(inputType);
  const left = normalize(typeof expected === 'string' ? expected : '', trim);
  const right = normalize(typeof observed === 'string' ? observed : '', trim);
  if (left === right) {
    return 'exact';
  }
  const foldedLeft = fold(left);
  const foldedRight = fold(right);
  if (foldedLeft === foldedRight) {
    return 'equivalent';
  }
  if (!NUMERIC_INPUT_TYPES.has(inputType) && differsByGroupingOnly(foldedLeft, foldedRight)) {
    return 'equivalent';
  }
  return 'different';
};
