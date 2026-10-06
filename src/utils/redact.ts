import { TASK_REDACTED } from '@/types';
import { sanitizeUntrustedText } from '@/utils/sanitize';
import type {
  Redactor,
  TaskBridgeEnvelope,
  TaskCreateRedactorFn,
  TaskIsSensitiveKeyFn,
  TaskRedactEnvelopeFn,
  TaskRedactParametersFn,
} from '@/types';

export const REDACTED = TASK_REDACTED;

// ---------------------------------------------------------------------------------------------
// Sensitive keys (contract 11.2): word based, never a substring.
// ---------------------------------------------------------------------------------------------

const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'passcode',
  'secret',
  'token',
  'apikey',
  'cvv',
  'cvc',
  'csc',
  'otp',
  'ssn',
  'pin',
  'card',
  'cc',
  'iban',
  'credential',
  'credentials',
  'authorization',
  'jwt',
  'bearer',
  'mnemonic',
  'passport',
  'routing',
  'swift',
  'cookie',
  'dob',
  // Unseparated compounds that a lower-case name attribute produces; each is still one whole token.
  'cardnumber',
  'cardnum',
  'cardcvv',
  'ccnumber',
  'ccnum',
  'creditcard',
  'creditcardnumber',
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
]);

// Both tokens present, any order, adjacent or not; each pair is listed once.
const SENSITIVE_PAIRS: readonly (readonly [string, readonly string[]])[] = [
  ['api', ['key']],
  ['private', ['key']],
  ['access', ['key']],
  ['secret', ['key']],
  ['security', ['code', 'answer', 'question']],
  ['social', ['security']],
  ['account', ['number']],
  ['recovery', ['phrase', 'code', 'key', 'word', 'words']],
  ['session', ['id', 'token', 'key']],
  ['birth', ['date']],
  ['seed', ['phrase', 'words']],
];

type CharKind = 'lower' | 'upper' | 'digit' | 'separator' | 'ignore';

const FORMAT_CHARACTER = /^\p{Cf}$/u;
const DIGIT_CHARACTER = /^\p{N}$/u;
const LETTER_CHARACTER = /^[\p{L}\p{M}]$/u;

const kindOf = (character: string): CharKind => {
  const code = character.charCodeAt(0);
  if (code < 0x80) {
    if (code >= 48 && code <= 57) {
      return 'digit';
    }
    if (code >= 65 && code <= 90) {
      return 'upper';
    }
    return code >= 97 && code <= 122 ? 'lower' : 'separator';
  }
  if (FORMAT_CHARACTER.test(character)) {
    return 'ignore';
  }
  if (DIGIT_CHARACTER.test(character)) {
    return 'digit';
  }
  if (LETTER_CHARACTER.test(character)) {
    return character !== character.toLowerCase() ? 'upper' : 'lower';
  }
  return 'separator';
};

/** Lower case whole words of a key: split on non-alphanumerics, camelCase, acronym ends and letter/digit edges. */
const tokenize = (key: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  let current = '';
  let previous: CharKind = 'separator';
  let beforePrevious: CharKind = 'separator';
  let previousCharacter = '';
  const flush = (): void => {
    if (current !== '') {
      tokens.add(current.toLowerCase());
      current = '';
    }
  };
  for (const character of key.normalize('NFKC')) {
    const kind = kindOf(character);
    if (kind === 'ignore') {
      continue;
    }
    if (kind === 'separator') {
      flush();
      previous = 'separator';
      beforePrevious = 'separator';
      previousCharacter = '';
      continue;
    }
    if (previous !== 'separator') {
      const digitEdge = (previous === 'digit') !== (kind === 'digit');
      if (digitEdge || (previous === 'lower' && kind === 'upper')) {
        flush();
      } else if (kind === 'lower' && previous === 'upper' && beforePrevious === 'upper') {
        current = current.slice(0, current.length - previousCharacter.length);
        flush();
        current = previousCharacter;
      }
    }
    current += character;
    beforePrevious = previous;
    previous = kind;
    previousCharacter = character;
  }
  flush();
  return tokens;
};

export const isSensitiveKey: TaskIsSensitiveKeyFn = key => {
  if (typeof key !== 'string' || key === '') {
    return false;
  }
  const tokens = tokenize(key);
  for (const token of tokens) {
    if (SENSITIVE_TOKENS.has(token)) {
      return true;
    }
  }
  return SENSITIVE_PAIRS.some(
    ([first, partners]) => tokens.has(first) && partners.some(partner => tokens.has(partner))
  );
};

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 100;
const CIRCULAR_MARKER = '[Circular]';

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/** Own data property, so a key such as `__proto__` can never reach a prototype. */
const setOwn = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const readOwn = (
  record: Readonly<Record<string, unknown>>,
  key: string
): { value: unknown } | null => {
  try {
    return { value: record[key] };
  } catch {
    return null;
  }
};

const ownKeys = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  try {
    return Object.keys(record);
  } catch {
    return [];
  }
};

const readIndex = (list: readonly unknown[], index: number): { value: unknown } | null => {
  try {
    return { value: list[index] };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// redactParameters
// ---------------------------------------------------------------------------------------------

const JSON_PARAMETERS: ReadonlySet<string> = new Set(['fields', 'values']);

const redactNested = (
  value: unknown,
  isSensitiveName: (key: string) => boolean,
  replacement: string,
  depth: number
): unknown => {
  if (depth > MAX_DEPTH) {
    return replacement;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactNested(item, isSensitiveName, replacement, depth + 1));
  }
  if (!isObject(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of ownKeys(value)) {
    const read = readOwn(value, key);
    if (read === null) {
      continue;
    }
    setOwn(
      output,
      key,
      isSensitiveName(key)
        ? replacement
        : redactNested(read.value, isSensitiveName, replacement, depth + 1)
    );
  }
  return output;
};

const redactJsonParameter = (
  raw: unknown,
  isSensitiveName: (key: string) => boolean,
  replacement: string
): string => {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return replacement;
    }
  }
  if (!isObject(parsed)) {
    return replacement;
  }
  try {
    return JSON.stringify(redactNested(parsed, isSensitiveName, replacement, 0));
  } catch {
    return replacement;
  }
};

export const redactParameters: TaskRedactParametersFn = (
  parameters,
  sensitiveNames,
  replacement
) => {
  const marker = typeof replacement === 'string' ? replacement : REDACTED;
  const names = new Set(Array.isArray(sensitiveNames) ? sensitiveNames : []);
  const isSensitiveName = (key: string): boolean => names.has(key) || isSensitiveKey(key);
  const output: Record<string, string> = {};
  if (!isObject(parameters)) {
    return output;
  }
  for (const key of ownKeys(parameters)) {
    const read = readOwn(parameters, key);
    if (read === null) {
      continue;
    }
    let redacted: unknown = read.value;
    if (isSensitiveName(key)) {
      redacted = marker;
    } else if (JSON_PARAMETERS.has(key)) {
      redacted = redactJsonParameter(read.value, isSensitiveName, marker);
    }
    setOwn(output, key, redacted);
  }
  return output;
};

// ---------------------------------------------------------------------------------------------
// Secret matching (contract 11.3)
// ---------------------------------------------------------------------------------------------

const DEFAULT_MIN_SUBSTRING_LENGTH = 4;
const UNICODE_WORD_CHARACTER = /^[\p{L}\p{N}\p{M}]$/u;
const DIGITS_SPACES_DASHES = /^[0-9 -]+$/;

type WordNeedle = {
  readonly text: string;
  readonly guardStart: boolean;
  readonly guardEnd: boolean;
};

type Matcher = {
  /** Case folded, matched anywhere, case-insensitively. */
  readonly substring: readonly string[];
  /** Matched case-sensitively, only as whole words. */
  readonly word: readonly WordNeedle[];
};

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

const isWordCodePoint = (codePoint: number): boolean => {
  if (codePoint < 0x80) {
    return (
      (codePoint >= 48 && codePoint <= 57) ||
      (codePoint >= 65 && codePoint <= 90) ||
      (codePoint >= 97 && codePoint <= 122) ||
      codePoint === 95
    );
  }
  return UNICODE_WORD_CHARACTER.test(String.fromCodePoint(codePoint));
};

const codePointBefore = (text: string, index: number): number => {
  const unit = text.charCodeAt(index - 1);
  if (isLowSurrogate(unit) && index >= 2 && isHighSurrogate(text.charCodeAt(index - 2))) {
    return text.codePointAt(index - 2) ?? unit;
  }
  return unit;
};

const codePointLength = (text: string): number => {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))) {
      index += 1;
    }
    count += 1;
  }
  return count;
};

/** Length preserving lower casing, so a match index in the folded text is an index in the original. */
const foldCase = (text: string): string => {
  let ascii = true;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    return text.toLowerCase();
  }
  let folded = '';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      folded += unit >= 65 && unit <= 90 ? String.fromCharCode(unit + 32) : text.charAt(index);
    } else {
      const lower = text.charAt(index).toLowerCase();
      folded += lower.length === 1 ? lower : text.charAt(index);
    }
  }
  return folded;
};

const jsonEscape = (text: string): string => JSON.stringify(text).slice(1, -1);

const asciiEscape = (escaped: string): string => {
  let output = '';
  for (let index = 0; index < escaped.length; index += 1) {
    const unit = escaped.charCodeAt(index);
    output +=
      unit >= 0x20 && unit <= 0x7e
        ? escaped.charAt(index)
        : `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return output;
};

const slashEscape = (escaped: string): string => escaped.split('/').join('\\/');

const percentByte = (character: string): string =>
  `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/** application/x-www-form-urlencoded: only `*-._` and alphanumerics stay, a space is `+`. */
const formUrlEncoded = (component: string): string =>
  component
    .replace(/[!'()~]/g, percentByte)
    .split('%20')
    .join('+');

/** Every byte as %XX, the form a hostile or a naive encoder produces. */
const everyByteEncoded = (component: string): string =>
  component.replace(/%[0-9A-F]{2}|[A-Za-z0-9\-_.!~*'()]/g, piece =>
    piece.length === 3 ? piece : percentByte(piece)
  );

const urlForms = (text: string): readonly string[] => {
  try {
    const component = encodeURIComponent(text);
    return [
      component,
      component.split('%20').join('+'),
      encodeURI(text),
      formUrlEncoded(component),
      everyByteEncoded(component),
      encodeURIComponent(component),
    ];
  } catch {
    return [];
  }
};

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const htmlEscaped = (text: string): string => text.replace(/[&<>"']/g, c => HTML_ENTITIES[c] ?? c);

// Layouts a payment or identity form applies to a run of digits: AmEx, Diners, US SSN and US phone.
const DIGIT_LAYOUTS: Readonly<Record<number, readonly number[]>> = {
  9: [3, 2, 4],
  10: [3, 3, 4],
  14: [4, 6, 4],
  15: [4, 6, 5],
};

const splitDigits = (digits: string, sizes: readonly number[]): readonly string[] => {
  const groups: string[] = [];
  let offset = 0;
  for (const size of sizes) {
    groups.push(digits.slice(offset, offset + size));
    offset += size;
  }
  return groups;
};

const evenGroups = (digits: string): readonly string[] => {
  const groups: string[] = [];
  for (let index = 0; index < digits.length; index += 4) {
    groups.push(digits.slice(index, index + 4));
  }
  return groups;
};

const digitForms = (text: string): readonly string[] => {
  if (text.length < 8 || !DIGITS_SPACES_DASHES.test(text)) {
    return [];
  }
  const digits = text.split(' ').join('').split('-').join('');
  if (digits.length < 4) {
    return [];
  }
  const layout = DIGIT_LAYOUTS[digits.length];
  const layouts =
    layout === undefined ? [evenGroups(digits)] : [evenGroups(digits), splitDigits(digits, layout)];
  const forms = [digits];
  for (const groups of layouts) {
    forms.push(groups.join(' '), groups.join('-'), groups.join('.'));
  }
  if (digits.length === 10) {
    const [area = '', exchange = '', line = ''] = splitDigits(digits, [3, 3, 4]);
    forms.push(`(${area}) ${exchange}-${line}`);
  }
  return forms;
};

/** The secret as typed plus every form it takes when a page, a URL, a JSON body or a sanitizer carries it. */
const variantsOf = (secret: string): readonly string[] => {
  const found = new Set<string>();
  const add = (variant: string): void => {
    if (variant.trim() !== '') {
      found.add(variant);
    }
  };
  for (const base of new Set([secret, secret.trim()])) {
    add(base);
    const json = jsonEscape(base);
    const ascii = asciiEscape(json);
    add(json);
    add(ascii);
    add(jsonEscape(json));
    if (base.includes('/')) {
      add(slashEscape(json));
      add(slashEscape(ascii));
    }
    urlForms(base).forEach(add);
    digitForms(base).forEach(add);
    add(htmlEscaped(base));
    add(base.normalize('NFC'));
    add(base.normalize('NFD'));
    add(sanitizeUntrustedText(base, Number.POSITIVE_INFINITY));
  }
  return [...found];
};

const makeWordNeedle = (text: string): WordNeedle => {
  const first = text.codePointAt(0) ?? 0;
  const last = codePointBefore(text, text.length);
  return { text, guardStart: isWordCodePoint(first), guardEnd: isWordCodePoint(last) };
};

const buildMatcher = (secrets: readonly string[], minSubstringLength: number): Matcher => {
  const substring = new Set<string>();
  const word = new Map<string, WordNeedle>();
  for (const secret of secrets) {
    for (const variant of variantsOf(secret)) {
      if (codePointLength(variant) < minSubstringLength) {
        word.set(variant, makeWordNeedle(variant));
      } else {
        substring.add(foldCase(variant));
      }
    }
  }
  return { substring: [...substring], word: [...word.values()] };
};

const wordBoundariesHold = (text: string, start: number, needle: WordNeedle): boolean => {
  const end = start + needle.text.length;
  if (needle.guardStart && start > 0 && isWordCodePoint(codePointBefore(text, start))) {
    return false;
  }
  if (needle.guardEnd && end < text.length && isWordCodePoint(text.codePointAt(end) ?? 0)) {
    return false;
  }
  return true;
};

/**
 * ends[start] is the furthest end of any match that begins at start; 0 means no match begins there. Every
 * needle is searched and the spans are united afterwards, so the longest match always wins and no needle
 * order can leave a remnant of a longer secret.
 */
const markMatches = (text: string, matcher: Matcher): Int32Array | undefined => {
  let ends: Int32Array | undefined;
  if (matcher.substring.length > 0) {
    const folded = foldCase(text);
    for (const needle of matcher.substring) {
      let from = folded.indexOf(needle);
      if (from === -1) {
        continue;
      }
      const length = needle.length;
      const table = ends ?? new Int32Array(text.length);
      ends = table;
      while (from !== -1) {
        const stop = from + length;
        if ((table[from] ?? 0) < stop) {
          table[from] = stop;
        }
        from = folded.indexOf(needle, from + 1);
      }
    }
  }
  for (const needle of matcher.word) {
    const length = needle.text.length;
    for (
      let from = text.indexOf(needle.text);
      from !== -1;
      from = text.indexOf(needle.text, from + 1)
    ) {
      if (wordBoundariesHold(text, from, needle)) {
        const table = ends ?? new Int32Array(text.length);
        ends = table;
        if ((table[from] ?? 0) < from + length) {
          table[from] = from + length;
        }
      }
    }
  }
  return ends;
};

/** Overlapping matches become one replacement; matches that merely touch stay separate. */
const replaceMarked = (text: string, ends: Int32Array, replacement: string): string => {
  const pieces: string[] = [];
  let copied = 0;
  let spanStart = -1;
  let spanEnd = 0;
  const size = ends.length;
  for (let index = 0; index < size; index += 1) {
    const end = ends[index] ?? 0;
    if (end === 0) {
      continue;
    }
    if (spanStart >= 0 && index < spanEnd) {
      if (end > spanEnd) {
        spanEnd = end;
      }
      continue;
    }
    if (spanStart >= 0) {
      pieces.push(text.slice(copied, spanStart), replacement);
      copied = spanEnd;
    }
    spanStart = index;
    spanEnd = end;
  }
  if (spanStart >= 0) {
    pieces.push(text.slice(copied, spanStart), replacement);
    copied = spanEnd;
  }
  pieces.push(text.slice(copied));
  return pieces.join('');
};

const scrubText = (text: unknown, matcher: Matcher, replacement: string): string => {
  if (typeof text !== 'string') {
    return '';
  }
  if (text === '' || (matcher.substring.length === 0 && matcher.word.length === 0)) {
    return text;
  }
  const ends = markMatches(text, matcher);
  return ends === undefined ? text : replaceMarked(text, ends, replacement);
};

// ---------------------------------------------------------------------------------------------
// scrubDeep
// ---------------------------------------------------------------------------------------------

const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'id',
  'signature',
  'fingerprint',
  'digest',
  'nonce',
  'integrity',
  'requestId',
  'callId',
]);

const isIdentityKey = (key: string): boolean =>
  IDENTITY_KEYS.has(key) || key.endsWith('Id') || key.endsWith('Ids');

type DeepScrub = {
  readonly scrub: (text: string) => string;
  readonly replacement: string;
};

const scrubContainer = (
  value: Readonly<Record<string, unknown>>,
  context: DeepScrub,
  ancestors: unknown[],
  depth: number,
  verbatim: boolean
): unknown => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const read = readIndex(value, index);
        items.push(
          read === null
            ? context.replacement
            : scrubValue(read.value, context, ancestors, depth + 1, verbatim)
        );
      }
      return items;
    }
    const output: Record<string, unknown> = {};
    for (const key of ownKeys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        continue;
      }
      const read = readOwn(value, key);
      if (read === null) {
        continue;
      }
      const keepVerbatim = verbatim || isIdentityKey(key);
      setOwn(
        output,
        keepVerbatim ? key : context.scrub(key),
        scrubValue(read.value, context, ancestors, depth + 1, keepVerbatim)
      );
    }
    return output;
  } finally {
    ancestors.pop();
  }
};

const scrubValue = (
  value: unknown,
  context: DeepScrub,
  ancestors: unknown[],
  depth: number,
  verbatim: boolean
): unknown => {
  if (typeof value === 'string') {
    return verbatim ? value : context.scrub(value);
  }
  if (!isObject(value)) {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return context.replacement;
  }
  if (ancestors.includes(value)) {
    return CIRCULAR_MARKER;
  }
  try {
    return scrubContainer(value, context, ancestors, depth, verbatim);
  } catch {
    // A revoked proxy or a throwing trap cannot be read, so nothing in it can be kept.
    return context.replacement;
  }
};

// ---------------------------------------------------------------------------------------------
// redactUrl
// ---------------------------------------------------------------------------------------------

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const BASE64_URL_RUN = /^[A-Za-z0-9_-]+$/;
const LONG_TOKEN_LENGTH = 24;

const decodeQueryText = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const isJwtShaped = (value: string): boolean => {
  const segments = value.split('.');
  const [header, payload, signature] = segments;
  if (segments.length !== 3 || header === undefined || payload === undefined) {
    return false;
  }
  if (!BASE64_URL_RUN.test(header) || !BASE64_URL_RUN.test(payload)) {
    return false;
  }
  return signature === '' ? header.startsWith('eyJ') : BASE64_URL_RUN.test(signature ?? '');
};

const isLongToken = (value: string): boolean => {
  let end = value.length;
  while (end > 0 && value.length - end < 2 && value.charAt(end - 1) === '=') {
    end -= 1;
  }
  return end >= LONG_TOKEN_LENGTH && BASE64_URL_RUN.test(value.slice(0, end));
};

const looksLikeToken = (value: string): boolean => {
  const decoded = decodeQueryText(value);
  return isJwtShaped(decoded) || isLongToken(decoded);
};

const MAX_NESTED_URL_DEPTH = 3;
const QUERY_SEPARATOR = /([&;])/;

/** A query value that is itself a URL (`next`, `redirect_uri`, `continue`) can hide a token or userinfo. */
const carriesNestedSecret = (value: string, replacement: string, depth: number): boolean => {
  if (depth >= MAX_NESTED_URL_DEPTH) {
    return false;
  }
  const decoded = decodeQueryText(value);
  if (!decoded.includes('?') && !decoded.includes('://')) {
    return false;
  }
  return redactUrlStructure(decoded, replacement, depth + 1) !== decoded;
};

const redactQueryPart = (part: string, replacement: string, depth: number): string => {
  const equals = part.indexOf('=');
  if (equals === -1) {
    return looksLikeToken(part) ? replacement : part;
  }
  const name = part.slice(0, equals);
  const value = part.slice(equals + 1);
  if (value === '') {
    return part;
  }
  const decodedName = decodeQueryText(name.split('+').join(' '));
  const hidesSecret =
    isSensitiveKey(decodedName) ||
    looksLikeToken(value) ||
    carriesNestedSecret(value, replacement, depth);
  return hidesSecret ? `${name}=${replacement}` : part;
};

/** `&` and the legacy `;` both separate parameters; the separators are kept as they were. */
const redactQuery = (query: string, replacement: string, depth: number): string =>
  query
    .split(QUERY_SEPARATOR)
    .map((part, index) => (index % 2 === 1 ? part : redactQueryPart(part, replacement, depth)))
    .join('');

const hasWhitespace = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x20 || (unit >= 0x09 && unit <= 0x0d)) {
      return true;
    }
  }
  return false;
};

// Browsers read `https:\\u:p@h`, `https:/u:p@h`, `https:///u:p@h` and `https:u:p@h` as `https://u:p@h`.
const LENIENT_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

const isSlash = (character: string): boolean => character === '/' || character === '\\';

const skipSlashes = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && isSlash(text.charAt(index))) {
    index += 1;
  }
  return index;
};

const authorityStart = (base: string): number => {
  const colon = base.indexOf(':');
  const scheme = colon > 0 ? base.slice(0, colon) : '';
  if (scheme !== '' && SCHEME.test(scheme)) {
    const after = skipSlashes(base, colon + 1);
    if (LENIENT_SCHEMES.has(scheme.toLowerCase())) {
      return after;
    }
    return base.startsWith('//', colon + 1) && after === colon + 3 ? after : -1;
  }
  const leading = skipSlashes(base, 0);
  return leading >= 2 ? leading : -1;
};

const stripUserinfo = (base: string): string => {
  const start = authorityStart(base);
  if (start === -1) {
    return base;
  }
  let end = start;
  while (end < base.length && !isSlash(base.charAt(end))) {
    end += 1;
  }
  const at = base.slice(start, end).lastIndexOf('@');
  return at === -1 ? base : base.slice(0, start) + base.slice(start + at + 1);
};

const looksLikeUrl = (text: string): boolean => {
  if (!hasWhitespace(text)) {
    return true;
  }
  const marker = text.indexOf('://');
  return marker > 0 && SCHEME.test(text.slice(0, marker));
};

/** Drops fragment and userinfo and masks the query; secrets are scrubbed by the caller. */
const redactUrlStructure = (url: string, replacement: string, depth: number): string => {
  const hash = url.indexOf('#');
  const withoutFragment = hash === -1 ? url : url.slice(0, hash);
  const question = withoutFragment.indexOf('?');
  const base = question === -1 ? withoutFragment : withoutFragment.slice(0, question);
  const query =
    question === -1
      ? ''
      : `?${redactQuery(withoutFragment.slice(question + 1), replacement, depth)}`;
  return stripUserinfo(base) + query;
};

const redactUrlText = (
  url: unknown,
  scrub: (text: string) => string,
  replacement: string
): string => {
  if (typeof url !== 'string') {
    return '';
  }
  return looksLikeUrl(url) ? scrub(redactUrlStructure(url, replacement, 0)) : scrub(url);
};

// ---------------------------------------------------------------------------------------------
// createRedactor
// ---------------------------------------------------------------------------------------------

type RedactorConfig = {
  readonly secrets: readonly string[];
  readonly replacement: string;
  readonly minSubstringLength: number;
};

// A caller that passes a Set, another iterable or a bare string must not silently get no redaction at all.
const secretCandidates = (secrets: unknown): readonly unknown[] => {
  if (typeof secrets === 'string' || Array.isArray(secrets)) {
    return Array.isArray(secrets) ? secrets : [secrets];
  }
  if (isObject(secrets) && typeof Reflect.get(secrets, Symbol.iterator) === 'function') {
    try {
      return Array.from(secrets as unknown as Iterable<unknown>);
    } catch {
      return [];
    }
  }
  return [];
};

const usableSecrets = (secrets: unknown): readonly string[] => {
  const kept = new Set<string>();
  for (const secret of secretCandidates(secrets)) {
    if (typeof secret === 'string' && secret.trim() !== '') {
      kept.add(secret);
    }
  }
  return [...kept];
};

const buildRedactor = (config: RedactorConfig): Redactor => {
  const matcher = buildMatcher(config.secrets, config.minSubstringLength);
  const scrub = (text: string): string => scrubText(text, matcher, config.replacement);
  const context: DeepScrub = { scrub, replacement: config.replacement };
  const redactor: Redactor = {
    replacement: config.replacement,
    secretCount: config.secrets.length,
    scrub,
    scrubDeep: <T>(value: T): T => scrubValue(value, context, [], 0, false) as T,
    redactUrl: url => redactUrlText(url, scrub, config.replacement),
    redactParameters: (parameters, sensitiveNames) =>
      redactParameters(parameters, sensitiveNames, config.replacement),
    isSensitiveKey,
    withSecrets: secrets =>
      buildRedactor({
        ...config,
        secrets: usableSecrets([...config.secrets, ...usableSecrets(secrets)]),
      }),
  };
  return Object.freeze(redactor);
};

export const createRedactor: TaskCreateRedactorFn = options => {
  const requestedMinimum = options?.minSubstringLength;
  return buildRedactor({
    secrets: usableSecrets(options?.secrets),
    replacement: typeof options?.replacement === 'string' ? options.replacement : REDACTED,
    minSubstringLength:
      typeof requestedMinimum === 'number' && Number.isFinite(requestedMinimum)
        ? Math.max(0, Math.floor(requestedMinimum))
        : DEFAULT_MIN_SUBSTRING_LENGTH,
  });
};

// ---------------------------------------------------------------------------------------------
// redactEnvelope
// ---------------------------------------------------------------------------------------------

const copyContainer = (
  value: Readonly<Record<string, unknown>>,
  ancestors: unknown[],
  depth: number
): unknown => {
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const read = readIndex(value, index);
        items.push(read === null ? null : copyJson(read.value, ancestors, depth + 1));
      }
      return items;
    }
    const output: Record<string, unknown> = {};
    for (const key of ownKeys(value)) {
      const read = readOwn(value, key);
      if (read !== null) {
        setOwn(output, key, copyJson(read.value, ancestors, depth + 1));
      }
    }
    return output;
  } finally {
    ancestors.pop();
  }
};

const copyJson = (value: unknown, ancestors: unknown[], depth: number): unknown => {
  if (!isObject(value)) {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (ancestors.includes(value)) {
    return CIRCULAR_MARKER;
  }
  try {
    return copyContainer(value, ancestors, depth);
  } catch {
    return null;
  }
};

/** A copy that is safe to log: the value of a FILL command in an execute envelope is always replaced. */
export const redactEnvelope: TaskRedactEnvelopeFn = envelope => {
  const copy = copyJson(envelope, [], 0);
  if (isObject(copy) && copy.method === 'execute' && isObject(copy.payload)) {
    const command = copy.payload.command;
    if (isObject(command) && command.operation === 'FILL') {
      setOwn(command, 'value', REDACTED);
    }
  }
  return copy as TaskBridgeEnvelope;
};
