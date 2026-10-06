import { TASK_EMPTY_TOKEN, TASK_KEYS, TASK_LIMITS, TASK_SCROLL_DIRECTIONS } from '@/types';
import type {
  TaskArgumentAvailability,
  TaskArgumentAvailableFn,
  TaskArgumentCandidate,
  TaskArgumentRef,
  TaskArgumentSlot,
  TaskArgumentViewFn,
  TaskBuildCandidatesFn,
  TaskCandidateInput,
  TaskCandidateSet,
  TaskCandidateViewsFn,
  TaskElement,
  TaskFlattenInputsFn,
  TaskHasUnsafeKeyFn,
  TaskHostCapabilities,
  TaskInputBinding,
  TaskInputDeclaration,
  TaskInputLeaf,
  TaskInputRule,
  TaskInputRulesFn,
  TaskInputValue,
  TaskKey,
  TaskMaterializeArgumentFn,
  TaskMaterializeContext,
  TaskMaterialized,
  TaskMergeInputsFn,
  TaskScrollDirection,
  TaskSplitSensitiveInputsFn,
  TaskSummarizeInputsFn,
} from '@/types';
import { isSensitiveKey } from '@/utils/redact';
import { sanitizeUntrustedText } from '@/utils/sanitize';

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_INPUT_DEPTH = 64;

type ScalarValue = string | number | boolean;
type MutableInputs = Record<string, TaskInputValue>;
type GoalRange = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly representation?: 'number';
};

const SMALL_NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;
const TENS = [
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;
const numericRepresentation = (text: string): string | undefined => {
  const words = text.toLowerCase().split(/[ -]/);
  const first = words[0] ?? '';
  const small = SMALL_NUMBERS.findIndex(word => word === first);
  if (small >= 0 && words.length === 1) {
    return String(small);
  }
  const tens = TENS.findIndex(word => word === first);
  const unit = words.length === 1 ? 0 : SMALL_NUMBERS.findIndex(word => word === words[1]);
  return tens >= 0 && words.length <= 2 && unit >= 0 && unit < 10
    ? String((tens + 2) * 10 + unit)
    : undefined;
};
const numberWordRanges = (goal: string): readonly GoalRange[] => {
  const expression = new RegExp(
    `\\b(?:${TENS.join('|')})(?:[ -](?:${SMALL_NUMBERS.slice(1, 10).join('|')}))?\\b|\\b(?:${SMALL_NUMBERS.join('|')})\\b`,
    'gi'
  );
  return [...goal.matchAll(expression)].flatMap(match => {
    const start = match.index;
    const end = start + match[0].length;
    if (/^[ -]+(?:hundred|thousand|million)\b/i.test(goal.slice(end))) {
      return [];
    }
    return [{ start, end, text: match[0], representation: 'number' as const }];
  });
};
type Draft = Omit<TaskArgumentCandidate, 'id'>;
type InputLookup =
  | { readonly kind: 'leaf'; readonly leaf: TaskInputLeaf }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not_scalar' };

// ---------------------------------------------------------------------------------------------
// Unsafe keys
// ---------------------------------------------------------------------------------------------

/** Iterative so a very deep value cannot overflow the stack; a value that cannot be read counts as unsafe. */
export const hasUnsafeKey: TaskHasUnsafeKeyFn = value => {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current !== 'object' || current === null || seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string') {
          continue;
        }
        if (UNSAFE_KEYS.has(key)) {
          return true;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor !== undefined && 'value' in descriptor) {
          pending.push(descriptor.value);
        }
      }
    }
    return false;
  } catch {
    return true;
  }
};

const defineOwn = (target: MutableInputs, key: string, value: TaskInputValue): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const readKey = (record: object, key: string): unknown => {
  try {
    return (record as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
};

const safeKeys = (record: object): readonly string[] =>
  Object.keys(record).filter(key => !UNSAFE_KEYS.has(key));

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const joinPath = (parent: string | undefined, key: string): string =>
  parent === undefined ? key : `${parent}.${key}`;

// ---------------------------------------------------------------------------------------------
// Input leaves
// ---------------------------------------------------------------------------------------------

type LeafVisitor = (path: string, value: ScalarValue, keyHit: boolean) => void;

const walkScalars = (
  node: unknown,
  path: string | undefined,
  keyHit: boolean,
  ancestors: readonly object[],
  visit: LeafVisitor
): void => {
  if (typeof node === 'string' || typeof node === 'boolean') {
    if (path !== undefined) {
      visit(path, node, keyHit);
    }
    return;
  }
  if (typeof node === 'number') {
    if (path !== undefined && Number.isFinite(node)) {
      visit(path, node, keyHit);
    }
    return;
  }
  if (
    typeof node !== 'object' ||
    node === null ||
    ancestors.length >= MAX_INPUT_DEPTH ||
    ancestors.includes(node)
  ) {
    return;
  }
  const nextAncestors = [...ancestors, node];
  if (Array.isArray(node)) {
    const items: readonly unknown[] = node;
    for (let index = 0; index < items.length; index += 1) {
      walkScalars(items[index], joinPath(path, String(index)), keyHit, nextAncestors, visit);
    }
    return;
  }
  for (const key of safeKeys(node)) {
    walkScalars(
      readKey(node, key),
      joinPath(path, key),
      keyHit || isSensitiveKey(key),
      nextAncestors,
      visit
    );
  }
};

const coversPath = (declarationPath: string, leafPath: string): boolean =>
  leafPath === declarationPath || leafPath.startsWith(`${declarationPath}.`);

const scalarType = (value: ScalarValue): TaskInputLeaf['scalar'] =>
  typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';

const buildLeaf = (
  path: string,
  value: ScalarValue,
  keyHit: boolean,
  declarations: readonly TaskInputDeclaration[]
): TaskInputLeaf => {
  const covering = declarations.filter(declaration => coversPath(declaration.path, path));
  const nearestFirst = [...covering].sort((left, right) => right.path.length - left.path.length);
  const bind = nearestFirst.find(declaration => declaration.bind !== undefined)?.bind;
  const expose = nearestFirst.find(declaration => declaration.expose !== undefined)?.expose;
  const description = covering.find(
    declaration => declaration.path === path && declaration.description !== undefined
  )?.description;
  return {
    path,
    value: String(value),
    scalar: scalarType(value),
    sensitive: keyHit || covering.some(declaration => declaration.sensitive === true),
    ...(description === undefined ? {} : { description }),
    ...(bind === undefined ? {} : { bind }),
    ...(expose === undefined ? {} : { expose }),
  };
};

export const flattenInputs: TaskFlattenInputsFn = (inputs, declarations) => {
  const leaves: TaskInputLeaf[] = [];
  walkScalars(inputs, undefined, false, [], (path, value, keyHit) => {
    leaves.push(buildLeaf(path, value, keyHit, declarations));
  });
  return leaves;
};

export const inputRules: TaskInputRulesFn = leaves =>
  leaves.map(
    (leaf): TaskInputRule => ({
      path: leaf.path,
      sensitive: leaf.sensitive,
      ...(leaf.bind === undefined ? {} : { bind: leaf.bind }),
    })
  );

export const summarizeInputs: TaskSummarizeInputsFn = (leaves, options) => {
  const previews = options?.previews !== false;
  return leaves.map(leaf => {
    const description =
      leaf.description === undefined
        ? ''
        : sanitizeUntrustedText(leaf.description, TASK_LIMITS.descriptionChars);
    const showPreview = previews && !leaf.sensitive && leaf.expose !== 'label';
    return {
      path: sanitizeUntrustedText(leaf.path),
      sensitive: leaf.sensitive,
      ...(description === '' ? {} : { description }),
      ...(showPreview
        ? { preview: sanitizeUntrustedText(leaf.value, TASK_LIMITS.inputPreviewChars) }
        : {}),
    };
  });
};

// ---------------------------------------------------------------------------------------------
// Rules shared with compileCommand
// ---------------------------------------------------------------------------------------------

/**
 * Where a value for the `value` slot may be typed (4.2 step 3). Goal text counts as a non-sensitive
 * value. A non-sensitive value never goes into a structurally sensitive element; a sensitive value
 * needs its binding (default: a sensitive element on an authorized origin).
 */
export const valueAllowedOnElement = (
  rule: Pick<TaskInputRule, 'sensitive' | 'bind'>,
  element: TaskElement | undefined,
  origin: string,
  runOrigins: readonly string[]
): boolean => {
  if (!rule.sensitive && element?.sensitive === true) {
    return false;
  }
  const bind = rule.bind;
  if ((bind?.requireSensitiveElement ?? rule.sensitive) && element?.sensitive !== true) {
    return false;
  }
  const origins = bind?.origins ?? (rule.sensitive || bind !== undefined ? runOrigins : undefined);
  if (origins !== undefined && !origins.includes(origin)) {
    return false;
  }
  return elementMatchesBinding(bind, element);
};

const elementMatchesBinding = (
  bind: TaskInputBinding | undefined,
  element: TaskElement | undefined
): boolean => {
  if (bind?.elementKinds !== undefined) {
    if (element === undefined || !bind.elementKinds.includes(element.kind)) {
      return false;
    }
  }
  if (bind?.inputTypes !== undefined) {
    const inputType = element?.inputType?.toLowerCase();
    if (
      inputType === undefined ||
      !bind.inputTypes.some(allowed => allowed.toLowerCase() === inputType)
    ) {
      return false;
    }
  }
  return true;
};

export const goalRefMatches = (
  ref: Extract<TaskArgumentRef, { readonly source: 'goal_literal' | 'goal_span' }>,
  goal: string
): boolean =>
  Number.isInteger(ref.start) &&
  Number.isInteger(ref.end) &&
  ref.start >= 0 &&
  ref.end > ref.start &&
  ref.end <= goal.length &&
  typeof ref.text === 'string' &&
  goal.slice(ref.start, ref.end) === ref.text &&
  (ref.representation === undefined ||
    (ref.representation === 'number' && numericRepresentation(ref.text) !== undefined));

const isTaskKey = (value: string): value is TaskKey =>
  (TASK_KEYS as readonly string[]).includes(value);

/** Keys of the host that can be offered; Enter only while implicit submit detection works. */
export const permittedKeys = (capabilities: TaskHostCapabilities): readonly TaskKey[] => {
  const keys = capabilities.keys.filter(isTaskKey);
  const unique = keys.filter((key, index) => keys.indexOf(key) === index);
  return capabilities.implicitSubmitDetection ? unique : unique.filter(key => key !== 'Enter');
};

/** Canonical order; TOP only while UP is possible and BOTTOM only while DOWN is. */
export const permittedScrollDirections = (
  directions: readonly string[]
): readonly TaskScrollDirection[] =>
  TASK_SCROLL_DIRECTIONS.filter(direction => {
    if (!directions.includes(direction)) {
      return false;
    }
    if (direction === 'TOP') {
      return directions.includes('UP');
    }
    return direction === 'BOTTOM' ? directions.includes('DOWN') : true;
  });

export const permittedDurations = (capabilities: TaskHostCapabilities): readonly number[] => {
  const durations = capabilities.waitDurationsMs.filter(
    duration => Number.isSafeInteger(duration) && duration > 0
  );
  return durations.filter((duration, index) => durations.indexOf(duration) === index);
};

// ---------------------------------------------------------------------------------------------
// Goal literals and spans
// ---------------------------------------------------------------------------------------------

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const SPAN_LIMIT = 8;
const SPAN_MAX_CHARS = 120;
const CLAUSE_PUNCTUATION = '.,;:!?';
const WIDE_CLAUSE_PUNCTUATION = '。！？；：，、';
const QUOTES = '"\'`';

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

const characterBefore = (text: string, index: number): string => {
  if (index <= 0) {
    return '';
  }
  if (
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    index >= 2 &&
    isHighSurrogate(text.charCodeAt(index - 2))
  ) {
    return text.slice(index - 2, index);
  }
  return text.charAt(index - 1);
};

const characterAfter = (text: string, index: number): string => {
  const codePoint = index < text.length ? text.codePointAt(index) : undefined;
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint);
};

const isWordCharacter = (character: string): boolean =>
  character !== '' && WORD_CHARACTER.test(character);

const isWhitespace = (character: string): boolean => /\s/.test(character);

const findClosingQuote = (goal: string, quote: string, from: number): number => {
  let position = goal.indexOf(quote, from);
  while (position >= 0) {
    if (quote !== "'" || !isWordCharacter(characterAfter(goal, position + 1))) {
      return position;
    }
    position = goal.indexOf(quote, position + 1);
  }
  return -1;
};

const quotedRanges = (goal: string): readonly GoalRange[] => {
  const found: GoalRange[] = [];
  let index = 0;
  while (index < goal.length) {
    const quote = goal.charAt(index);
    const opens =
      QUOTES.includes(quote) && !(quote === "'" && isWordCharacter(characterBefore(goal, index)));
    const close = opens ? findClosingQuote(goal, quote, index + 1) : -1;
    if (close < 0) {
      index += 1;
      continue;
    }
    const text = goal.slice(index + 1, close);
    if (text.trim() !== '') {
      found.push({ start: index + 1, end: close, text });
    }
    index = close + 1;
  }
  return found;
};

const matchRanges = (goal: string, pattern: RegExp): readonly GoalRange[] => {
  const found: GoalRange[] = [];
  for (const match of goal.matchAll(pattern)) {
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length, text: match[0] });
  }
  return found;
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_START = /https?:\/\/[^\s"'`<>()[\]{}]+/gi;
const ISO_DATE =
  /\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const URL_TRAILING = /[.,;:!?]+$/;
const URL_BODY = /^https?:\/\/./i;

const urlRanges = (goal: string): readonly GoalRange[] =>
  matchRanges(goal, URL_START).flatMap(range => {
    const text = range.text.replace(URL_TRAILING, '');
    return URL_BODY.test(text)
      ? [{ start: range.start, end: range.start + text.length, text }]
      : [];
  });

const isAsciiDigit = (character: string): boolean => character >= '0' && character <= '9';

const dateRanges = (goal: string): readonly GoalRange[] =>
  matchRanges(goal, ISO_DATE).filter(
    range =>
      !isAsciiDigit(characterBefore(goal, range.start)) &&
      !isAsciiDigit(characterAfter(goal, range.end))
  );

const overlaps = (range: GoalRange, others: readonly GoalRange[]): boolean =>
  others.some(other => range.start < other.end && other.start < range.end);

const numberRanges = (goal: string, occupied: readonly GoalRange[]): readonly GoalRange[] =>
  matchRanges(goal, NUMBER).filter(
    range =>
      !isWordCharacter(characterBefore(goal, range.start)) &&
      !isWordCharacter(characterAfter(goal, range.end)) &&
      !overlaps(range, occupied)
  );

const uniqueRanges = (ranges: readonly GoalRange[]): readonly GoalRange[] => {
  const seen = new Set<string>();
  return ranges.filter(range => {
    const key = `${range.start}:${range.end}:${range.representation ?? 'text'}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/** Quoted segments (offsets inside the quotes), emails, http(s) URLs, ISO dates, numbers: pure syntax. */
const literalRanges = (goal: string): readonly GoalRange[] => {
  const emails = matchRanges(goal, EMAIL);
  const urls = urlRanges(goal);
  const dates = dateRanges(goal);
  return uniqueRanges([
    ...quotedRanges(goal),
    ...emails,
    ...urls,
    ...dates,
    ...numberRanges(goal, [...emails, ...urls, ...dates]),
    ...numberWordRanges(goal),
  ]);
};

type Span = { readonly start: number; readonly end: number };

const trimSpan = (text: string, span: Span): Span | null => {
  let { start, end } = span;
  while (start < end && isWhitespace(text.charAt(start))) {
    start += 1;
  }
  while (end > start && isWhitespace(text.charAt(end - 1))) {
    end -= 1;
  }
  return end > start ? { start, end } : null;
};

const isClauseBreak = (goal: string, index: number): boolean => {
  const character = goal.charAt(index);
  if (character === '\n' || character === '\r' || WIDE_CLAUSE_PUNCTUATION.includes(character)) {
    return true;
  }
  if (!CLAUSE_PUNCTUATION.includes(character)) {
    return false;
  }
  const next = goal.charAt(index + 1);
  return next === '' || isWhitespace(next);
};

const clauseSpans = (goal: string): readonly Span[] => {
  const spans: Span[] = [];
  let start = 0;
  for (let index = 0; index <= goal.length; index += 1) {
    if (index === goal.length || isClauseBreak(goal, index)) {
      const trimmed = trimSpan(goal, { start, end: index });
      if (trimmed !== null) {
        spans.push(trimmed);
      }
      start = index + 1;
    }
  }
  return spans;
};

const wordSpans = (goal: string, within: Span): readonly Span[] => {
  const spans: Span[] = [];
  let start = -1;
  for (let index = within.start; index <= within.end; index += 1) {
    const inWord = index < within.end && !isWhitespace(goal.charAt(index));
    if (inWord && start < 0) {
      start = index;
    } else if (!inWord && start >= 0) {
      spans.push({ start, end: index });
      start = -1;
    }
  }
  return spans;
};

/** At most SPAN_MAX_CHARS UTF-16 units, cut back to a word boundary and never inside a surrogate pair. */
const clipSpan = (goal: string, span: Span): Span => {
  if (span.end - span.start <= SPAN_MAX_CHARS) {
    return span;
  }
  let cut = span.start + SPAN_MAX_CHARS;
  if (isHighSurrogate(goal.charCodeAt(cut - 1)) && isLowSurrogate(goal.charCodeAt(cut))) {
    cut -= 1;
  }
  if (!isWhitespace(goal.charAt(cut))) {
    let boundary = cut - 1;
    while (boundary > span.start && !isWhitespace(goal.charAt(boundary))) {
      boundary -= 1;
    }
    cut = boundary > span.start ? boundary : cut;
  }
  return trimSpan(goal, { start: span.start, end: cut }) ?? { start: span.start, end: cut };
};

/**
 * Spans a free-text value might come from, as a function of the goal string alone: the whole goal when it
 * is short, then every clause, then the tails of the first clause. Clause breaks and word breaks are
 * punctuation and whitespace; nothing here knows a language, a site or a task.
 */
const spanRanges = (goal: string): readonly GoalRange[] => {
  const whole = trimSpan(goal, { start: 0, end: goal.length });
  if (whole === null) {
    return [];
  }
  const clauses = clauseSpans(goal);
  const first = clauses[0];
  const tails =
    first === undefined
      ? []
      : wordSpans(goal, first)
          .slice(1)
          .map(word => ({ start: word.start, end: first.end }));
  const ordered: readonly Span[] = [
    ...(whole.end - whole.start <= SPAN_MAX_CHARS ? [whole] : []),
    ...clauses,
    ...[...wordSpans(goal, whole)].sort(
      (left, right) => right.end - right.start - (left.end - left.start)
    ),
    ...tails,
  ];
  const seen = new Set<string>();
  const ranges: GoalRange[] = [];
  for (const candidate of ordered) {
    const clipped = clipSpan(goal, candidate);
    const text = goal.slice(clipped.start, clipped.end);
    if (!seen.has(text)) {
      seen.add(text);
      ranges.push({ start: clipped.start, end: clipped.end, text });
    }
  }
  return ranges.slice(0, SPAN_LIMIT);
};

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

const clean = (text: string, limit: number): string => sanitizeUntrustedText(text, limit);

const previewOf = (text: string): { readonly preview?: string } => {
  const preview = clean(text, TASK_LIMITS.inputPreviewChars);
  return preview === '' ? {} : { preview };
};

type RuledDraft = {
  readonly draft: Draft;
  readonly rule: Pick<TaskInputRule, 'sensitive' | 'bind'>;
};

/**
 * A goal above the limit is invalid at init, and the scans below are quadratic on adversarial text, so an
 * unvalidated goal proposes no text instead of stalling every step (UTF-16 units never exceed UTF-8 bytes).
 */
const goalDrafts = (goal: string): readonly RuledDraft[] => {
  if (goal.length > TASK_LIMITS.goalBytes) {
    return [];
  }
  const draftOf = (source: 'goal_literal' | 'goal_span', label: string) => (range: GoalRange) => ({
    draft: {
      source,
      label,
      ...previewOf(
        range.representation === 'number'
          ? (numericRepresentation(range.text) ?? range.text)
          : range.text
      ),
      sensitive: false,
      ref: {
        source,
        start: range.start,
        end: range.end,
        text: range.text,
        ...(range.representation ? { representation: range.representation } : {}),
      },
    } satisfies Draft,
    rule: { sensitive: false },
  });
  return [
    ...literalRanges(goal).map(draftOf('goal_literal', 'Quoted or literal text from the task')),
    ...spanRanges(goal).map(draftOf('goal_span', 'Text span from the task')),
  ];
};

const inputLabel = (leaf: TaskInputLeaf): string => {
  const description =
    leaf.description === undefined
      ? ''
      : sanitizeUntrustedText(leaf.description, TASK_LIMITS.descriptionChars);
  return clean(
    `input:${leaf.path}${description === '' ? '' : ` - ${description}`}`,
    TASK_LIMITS.labelChars
  );
};

const inputDrafts = (input: TaskCandidateInput): readonly RuledDraft[] =>
  input.leaves.map(leaf => ({
    draft: {
      source: 'input',
      label: inputLabel(leaf),
      ...(!leaf.sensitive && leaf.expose !== 'label' && input.previews !== false
        ? previewOf(leaf.value)
        : {}),
      sensitive: leaf.sensitive,
      ref: { source: 'input', path: leaf.path },
    },
    rule: { sensitive: leaf.sensitive, ...(leaf.bind === undefined ? {} : { bind: leaf.bind }) },
  }));

const resolverDrafts = (input: TaskCandidateInput): readonly RuledDraft[] =>
  input.resolvers
    .filter(resolver => resolver.slots.includes('value'))
    .map(resolver => {
      const label = clean(resolver.description, TASK_LIMITS.labelChars);
      return {
        draft: {
          source: 'resolver',
          label: label === '' ? `resolver:${clean(resolver.id, TASK_LIMITS.labelChars)}` : label,
          sensitive: resolver.sensitive,
          ref: {
            source: 'resolver',
            resolverId: resolver.id,
            key: `value:${input.element?.signature ?? ''}`,
          },
        },
        rule: { sensitive: resolver.sensitive },
      };
    });

const protocolDraft = (slot: TaskArgumentSlot, token: string, label: string): Draft => ({
  source: 'protocol',
  label,
  sensitive: false,
  ref: { source: 'protocol', slot, token },
});

const valueDrafts = (
  input: TaskCandidateInput
): { readonly drafts: readonly Draft[]; readonly withheld: number } => {
  const entries = [...goalDrafts(input.goal), ...inputDrafts(input), ...resolverDrafts(input)];
  const allowed = entries.filter(entry =>
    valueAllowedOnElement(entry.rule, input.element, input.observation.origin, input.origins)
  );
  const clearable = input.element?.state.readOnly !== true;
  return {
    drafts: [
      ...allowed.map(entry => entry.draft),
      ...(clearable ? [protocolDraft('value', TASK_EMPTY_TOKEN, 'Clear the field')] : []),
    ],
    withheld: entries.length - allowed.length,
  };
};

const optionDrafts = (element: TaskElement | undefined): readonly Draft[] =>
  (element?.options ?? [])
    .filter(option => !option.disabled)
    .map(option => {
      const label = clean(option.label, TASK_LIMITS.labelChars);
      return {
        source: 'observed_option',
        label,
        ...(option.value !== undefined ? { code: option.value } : {}),
        ...(!element?.sensitive && option.groupLabel !== undefined
          ? { optionGroup: clean(option.groupLabel, TASK_LIMITS.labelChars) }
          : {}),
        ...(label === '' ? {} : { preview: label }),
        sensitive: false,
        ref: { source: 'observed_option', targetId: element?.id ?? '', optionId: option.id },
      };
    });

const protocolDrafts = (input: TaskCandidateInput): readonly Draft[] => {
  const { slot, element, capabilities, observation } = input;
  switch (slot) {
    case 'checked':
      return [
        protocolDraft('checked', 'CHECKED', 'Set checked'),
        ...(element?.kind === 'radio'
          ? []
          : [protocolDraft('checked', 'UNCHECKED', 'Set unchecked')]),
      ];
    case 'key':
      return permittedKeys(capabilities).map(key => protocolDraft('key', key, `Press ${key}`));
    case 'direction': {
      const directions =
        element === undefined
          ? observation.page.scroll.directions
          : (element.scroll?.directions ?? []);
      return permittedScrollDirections(directions).map(direction =>
        protocolDraft('direction', direction, `Scroll ${direction}`)
      );
    }
    case 'duration':
      return permittedDurations(capabilities).map(duration =>
        protocolDraft('duration', String(duration), `Wait ${duration} ms`)
      );
    default:
      return [];
  }
};

const tokensOf = (text: string): ReadonlySet<string> =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

const draftText = (draft: Draft): string => {
  const refText =
    draft.ref.source === 'goal_literal' || draft.ref.source === 'goal_span' ? draft.ref.text : '';
  return `${draft.label} ${draft.preview ?? ''} ${refText}`;
};

type RelevanceContext = {
  readonly base: ReadonlySet<string>;
  /** Leaves whose description holds a token, and the same count restricted to one leaf path. */
  readonly described: ReadonlyMap<string, number>;
  readonly describedByPath: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

const countTokens = (counts: Map<string, number>, tokens: ReadonlySet<string>): void => {
  tokens.forEach(token => counts.set(token, (counts.get(token) ?? 0) + 1));
};

const relevanceContext = (input: TaskCandidateInput): RelevanceContext => {
  const described = new Map<string, number>();
  const describedByPath = new Map<string, Map<string, number>>();
  for (const leaf of input.leaves) {
    if (leaf.description === undefined) {
      continue;
    }
    const tokens = tokensOf(leaf.description);
    countTokens(described, tokens);
    const own = describedByPath.get(leaf.path) ?? new Map<string, number>();
    countTokens(own, tokens);
    describedByPath.set(leaf.path, own);
  }
  return {
    base: tokensOf(
      `${input.element?.label ?? ''} ${input.element?.description ?? ''} ${input.goal}`
    ),
    described,
    describedByPath,
  };
};

/** Tokens shared with the element, the goal or the description of any other input (never its own). */
const relevance = (draft: Draft, context: RelevanceContext): number => {
  const own =
    draft.ref.source === 'input' ? context.describedByPath.get(draft.ref.path) : undefined;
  let score = 0;
  tokensOf(draftText(draft)).forEach(token => {
    const others = (context.described.get(token) ?? 0) - (own?.get(token) ?? 0);
    score += context.base.has(token) || others > 0 ? 1 : 0;
  });
  return score;
};

const normalizeLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : TASK_LIMITS.candidates;

/**
 * Keeps every protocol token (small, fixed enumerations) and the best of the rest by token overlap.
 * When everything fits the budget, the ranking keeps every draft in its original order.
 */
const trimDrafts = (drafts: readonly Draft[], input: TaskCandidateInput): readonly Draft[] => {
  const protocolCount = drafts.filter(draft => draft.source === 'protocol').length;
  const budget = Math.max(0, normalizeLimit(input.limit) - protocolCount);
  const context = relevanceContext(input);
  const supplied = new Set(
    input.leaves.filter(leaf => !leaf.sensitive).map(leaf => String(leaf.value).toLowerCase())
  );
  const ranked = drafts
    .map((draft, index) => ({
      draft,
      index,
      score:
        draft.source === 'observed_option' &&
        [draft.code, draft.preview, draft.label].some(
          value => value !== undefined && supplied.has(value.toLowerCase())
        )
          ? 100
          : relevance(draft, context),
    }))
    .filter(entry => entry.draft.source !== 'protocol')
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, budget);
  const kept = new Set(ranked.map(entry => entry.index));
  return drafts.filter((draft, index) => draft.source === 'protocol' || kept.has(index));
};

const toCandidates = (drafts: readonly Draft[]): readonly TaskArgumentCandidate[] =>
  drafts.map((draft, index) => ({ id: `c${index + 1}`, ...draft }));

const draftsFor = (
  input: TaskCandidateInput
): { readonly drafts: readonly Draft[]; readonly withheld: number } => {
  if (input.slot === 'value') {
    return valueDrafts(input);
  }
  return {
    drafts: input.slot === 'option' ? optionDrafts(input.element) : protocolDrafts(input),
    withheld: 0,
  };
};

export const buildCandidates: TaskBuildCandidatesFn = (input): TaskCandidateSet => {
  const { drafts, withheld } = draftsFor(input);
  const trimmed = trimDrafts(drafts, input);
  return {
    slot: input.slot,
    candidates: toCandidates(trimmed),
    truncated: trimmed.length < drafts.length,
    withheld,
  };
};

const visiblePreview = (candidate: {
  readonly sensitive: boolean;
  readonly preview?: string;
}): { readonly preview?: string } =>
  candidate.sensitive || candidate.preview === undefined ? {} : { preview: candidate.preview };

export const candidateViews: TaskCandidateViewsFn = set =>
  set.candidates.map(candidate => ({
    id: candidate.id,
    source: candidate.source,
    label: candidate.label,
    ...(candidate.source === 'input' && candidate.ref.source === 'input'
      ? { inputPath: candidate.ref.path }
      : {}),
    ...(!candidate.sensitive && candidate.code !== undefined ? { code: candidate.code } : {}),
    ...(!candidate.sensitive &&
    candidate.source === 'observed_option' &&
    candidate.ref.source === 'observed_option' &&
    candidate.optionGroup !== undefined
      ? { optionGroup: candidate.optionGroup }
      : {}),
    ...visiblePreview(candidate),
    sensitive: candidate.sensitive,
  }));

export const argumentView: TaskArgumentViewFn = (candidate, slot) => ({
  slot,
  source: candidate.source,
  label: candidate.label,
  ...visiblePreview(candidate),
  sensitive: candidate.sensitive,
});

// ---------------------------------------------------------------------------------------------
// Availability and materialization
// ---------------------------------------------------------------------------------------------

const nodeAt = (root: unknown, path: string): unknown => {
  let node = root;
  for (const segment of path.split('.')) {
    if (
      typeof node !== 'object' ||
      node === null ||
      UNSAFE_KEYS.has(segment) ||
      !Object.prototype.hasOwnProperty.call(node, segment)
    ) {
      return undefined;
    }
    node = readKey(node, segment);
  }
  return node;
};

const lookupInput = (context: TaskMaterializeContext, path: string): InputLookup => {
  const leaves = flattenInputs(context.inputs, context.declarations);
  const leaf = leaves.find(item => item.path === path);
  if (leaf !== undefined) {
    return { kind: 'leaf', leaf };
  }
  const container = nodeAt(context.inputs, path);
  const holdsLeaves = leaves.some(item => item.path.startsWith(`${path}.`));
  return holdsLeaves || (typeof container === 'object' && container !== null)
    ? { kind: 'not_scalar' }
    : { kind: 'missing' };
};

type Failure = Extract<TaskMaterialized, { readonly ok: false }>;

const failure = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });

const GOAL_MISMATCH = failure(
  'GOAL_REF_MISMATCH',
  'The goal text no longer matches the reference.'
);
const INPUT_ABSENT = failure('INPUT_MISSING', 'The referenced input is not available.');
const INPUT_COMPOUND = failure('INPUT_NOT_SCALAR', 'The referenced input is not a single value.');
const UNSUPPORTED = failure('UNSUPPORTED_SLOT', 'This reference cannot be typed as a value.');

const inputFailure = (lookup: Exclude<InputLookup, { readonly kind: 'leaf' }>): Failure =>
  lookup.kind === 'missing' ? INPUT_ABSENT : INPUT_COMPOUND;

export const argumentAvailable: TaskArgumentAvailableFn = (
  ref,
  context
): TaskArgumentAvailability => {
  switch (ref.source) {
    case 'goal_literal':
    case 'goal_span':
      return goalRefMatches(ref, context.goal) ? { ok: true } : GOAL_MISMATCH;
    case 'input': {
      const lookup = lookupInput(context, ref.path);
      return lookup.kind === 'leaf' ? { ok: true } : inputFailure(lookup);
    }
    case 'resolver':
    case 'protocol':
    case 'observed_option':
      return { ok: true };
    default:
      return UNSUPPORTED;
  }
};

const resolvedValue = (
  context: TaskMaterializeContext,
  resolverId: string,
  key: string
): TaskMaterialized => {
  const entryKey = `${resolverId}|${key}`;
  const entry = Object.prototype.hasOwnProperty.call(context.resolved, entryKey)
    ? readKey(context.resolved, entryKey)
    : undefined;
  if (
    !isPlainRecord(entry) ||
    typeof entry.value !== 'string' ||
    typeof entry.sensitive !== 'boolean'
  ) {
    return failure(
      'RESOLVER_PENDING',
      'The resolver has not produced a value for this command yet.'
    );
  }
  return { ok: true, value: entry.value, sensitive: entry.sensitive };
};

export const materializeArgument: TaskMaterializeArgumentFn = (ref, context): TaskMaterialized => {
  switch (ref.source) {
    case 'goal_literal':
    case 'goal_span':
      return goalRefMatches(ref, context.goal)
        ? {
            ok: true,
            value:
              ref.representation === 'number'
                ? (numericRepresentation(ref.text) ?? '')
                : context.goal.slice(ref.start, ref.end),
            sensitive: false,
          }
        : GOAL_MISMATCH;
    case 'input': {
      const lookup = lookupInput(context, ref.path);
      return lookup.kind === 'leaf'
        ? { ok: true, value: lookup.leaf.value, sensitive: lookup.leaf.sensitive }
        : inputFailure(lookup);
    }
    case 'resolver':
      return resolvedValue(context, ref.resolverId, ref.key);
    case 'protocol':
      return ref.slot === 'value' && ref.token === TASK_EMPTY_TOKEN
        ? { ok: true, value: '', sensitive: false }
        : UNSUPPORTED;
    default:
      return UNSUPPORTED;
  }
};

// ---------------------------------------------------------------------------------------------
// Merge and split
// ---------------------------------------------------------------------------------------------

const cloneInput = (value: unknown, depth: number): TaskInputValue | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'object' || depth >= MAX_INPUT_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map(item => cloneInput(item, depth + 1) ?? null);
  }
  const copy: MutableInputs = {};
  for (const key of safeKeys(value)) {
    const child = cloneInput(readKey(value, key), depth + 1);
    if (child !== undefined) {
      defineOwn(copy, key, child);
    }
  }
  return copy;
};

const mergeRecords = (
  base: Readonly<Record<string, TaskInputValue>>,
  patch: object,
  depth: number
): MutableInputs => {
  const result: MutableInputs = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    if (value !== undefined) {
      defineOwn(result, key, value);
    }
  }
  for (const key of safeKeys(patch)) {
    const incoming = readKey(patch, key);
    const existing = Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined;
    const merged =
      isPlainRecord(incoming) && isPlainRecord(existing) && depth < MAX_INPUT_DEPTH
        ? mergeRecords(existing as Readonly<Record<string, TaskInputValue>>, incoming, depth + 1)
        : cloneInput(incoming, depth + 1);
    if (merged !== undefined) {
      defineOwn(result, key, merged);
    }
  }
  return result;
};

export const mergeInputs: TaskMergeInputsFn = (base, patch) => {
  const cleanBase = cloneInput(base, 0);
  return mergeRecords(
    isPlainRecord(cleanBase) ? (cleanBase as MutableInputs) : {},
    isPlainRecord(patch) ? patch : {},
    0
  );
};

type Pruned = { readonly value: TaskInputValue | undefined; readonly removed: boolean };

const pruneNode = (
  node: unknown,
  path: string | undefined,
  sensitivePaths: ReadonlySet<string>,
  removedPaths: string[],
  depth: number
): Pruned => {
  if (typeof node === 'string' || typeof node === 'boolean' || typeof node === 'number') {
    if (path !== undefined && sensitivePaths.has(path)) {
      removedPaths.push(path);
      return { value: undefined, removed: true };
    }
    return { value: cloneInput(node, depth), removed: false };
  }
  if (typeof node !== 'object' || node === null || depth >= MAX_INPUT_DEPTH) {
    return { value: node === null ? null : undefined, removed: false };
  }
  if (Array.isArray(node)) {
    const items: readonly unknown[] = node;
    const children = items.map((item, index) =>
      pruneNode(item, joinPath(path, String(index)), sensitivePaths, removedPaths, depth + 1)
    );
    const removed = children.some(child => child.removed);
    if (removed && children.every(child => child.value === undefined)) {
      return { value: undefined, removed };
    }
    return { value: children.map(child => child.value ?? null), removed };
  }
  const copy: MutableInputs = {};
  let removed = false;
  for (const key of safeKeys(node)) {
    const child = pruneNode(
      readKey(node, key),
      joinPath(path, key),
      sensitivePaths,
      removedPaths,
      depth + 1
    );
    removed = removed || child.removed;
    if (child.value !== undefined) {
      defineOwn(copy, key, child.value);
    }
  }
  return removed && Object.keys(copy).length === 0
    ? { value: undefined, removed }
    : { value: copy, removed };
};

export const splitSensitiveInputs: TaskSplitSensitiveInputsFn = (inputs, leaves) => {
  const sensitivePaths = new Set(leaves.filter(leaf => leaf.sensitive).map(leaf => leaf.path));
  const paths: string[] = [];
  const pruned = pruneNode(inputs, undefined, sensitivePaths, paths, 0);
  return { inputs: isPlainRecord(pruned.value) ? (pruned.value as MutableInputs) : {}, paths };
};
