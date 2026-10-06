import type {
  ActionCommand,
  ActionParameterIssue,
  ActionType,
  ExecutionOptions,
  Redactor,
} from '@/types';
import { ACTION_TYPES, TASK_REDACTED } from '@/types';

type Kind = 'string' | 'bool' | 'int' | 'enum' | 'unit';
type Spec = {
  readonly kind: Kind;
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
};
type Schema = {
  readonly keys: Readonly<Record<string, Spec>>;
  readonly required: readonly string[];
};

const STRING: Spec = { kind: 'string' };
const BOOL: Spec = { kind: 'bool' };
const LEFT_RIGHT_MIDDLE: readonly string[] = ['left', 'right', 'middle'];
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const FILL_FORM_RESERVED: ReadonlySet<string> = new Set(['formId', 'fields', 'values', 'strict']);
const MAX_COORDINATE = 1000000;
const CANONICAL_INTEGER = /^(0|[1-9][0-9]{0,8})$/;
const UNIT_INTERVAL = /^(0(\.[0-9]+)?|1(\.0+)?)$/;

const STRICT_ONLY_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'setChecked',
  'select',
  'scroll',
]);

const SCHEMAS: Readonly<Record<ActionType, Schema>> = {
  navigate: { keys: { url: STRING, waitForLoad: BOOL, strict: BOOL }, required: ['url'] },
  click: {
    keys: {
      selector: STRING,
      description: STRING,
      button: { kind: 'enum', values: LEFT_RIGHT_MIDDLE },
      clickCount: { kind: 'int', min: 1, max: 5 },
      x: { kind: 'int', min: 0, max: MAX_COORDINATE },
      y: { kind: 'int', min: 0, max: MAX_COORDINATE },
      strict: BOOL,
    },
    required: [],
  },
  fill: {
    keys: {
      selector: STRING,
      description: STRING,
      value: STRING,
      clearFirst: BOOL,
      triggerEvents: BOOL,
      strict: BOOL,
    },
    required: ['value'],
  },
  fillForm: {
    keys: { formId: STRING, fields: STRING, values: STRING, strict: BOOL },
    required: [],
  },
  submitForm: { keys: { formId: STRING, strict: BOOL }, required: [] },
  screenshot: {
    keys: { fullPage: BOOL, quality: { kind: 'unit' }, strict: BOOL },
    required: [],
  },
  wait: {
    keys: { duration: { kind: 'int', min: 1, max: 60000 }, strict: BOOL },
    required: ['duration'],
  },
  press: {
    keys: {
      key: STRING,
      selector: STRING,
      description: STRING,
      implicitSubmit: BOOL,
      strict: BOOL,
    },
    required: ['key'],
  },
  setChecked: {
    keys: { selector: STRING, description: STRING, checked: BOOL, strict: BOOL },
    required: ['checked'],
  },
  select: {
    keys: {
      selector: STRING,
      description: STRING,
      matchBy: { kind: 'enum', values: ['value', 'label', 'index'] },
      option: STRING,
      triggerEvents: BOOL,
      strict: BOOL,
    },
    required: [],
  },
  scroll: {
    keys: {
      selector: STRING,
      direction: { kind: 'enum', values: ['UP', 'DOWN', 'TOP', 'BOTTOM'] },
      strict: BOOL,
    },
    required: ['direction'],
  },
};

const issue = (key: string | undefined, message: string): ActionParameterIssue =>
  key === undefined
    ? { code: 'VALIDATION_FAILED', message }
    : { code: 'VALIDATION_FAILED', key, message };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// A plain `in` or index lookup also finds Object.prototype members, so a parameter named `constructor` or
// `toString` would pass as a known key.
const hasOwn = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

function checkValue(key: string, spec: Spec, value: string): ActionParameterIssue | null {
  switch (spec.kind) {
    case 'string':
      return null;
    case 'bool':
      return value === 'true' || value === 'false'
        ? null
        : issue(key, `Parameter "${key}" must be the string "true" or "false"`);
    case 'int': {
      const parsed = CANONICAL_INTEGER.test(value) ? Number(value) : Number.NaN;
      return parsed >= (spec.min ?? 0) && parsed <= (spec.max ?? Number.MAX_SAFE_INTEGER)
        ? null
        : issue(key, `Parameter "${key}" must be a canonical integer in range`);
    }
    case 'enum':
      return spec.values?.includes(value) === true
        ? null
        : issue(key, `Parameter "${key}" is not an accepted choice`);
    case 'unit':
      return UNIT_INTERVAL.test(value)
        ? null
        : issue(key, `Parameter "${key}" must be between 0 and 1`);
  }
}

function checkSelectPairing(
  parameters: Readonly<Record<string, unknown>>
): ActionParameterIssue | null {
  const hasMatchBy = hasOwn(parameters, 'matchBy');
  const hasOption = hasOwn(parameters, 'option');
  if (hasMatchBy !== hasOption) {
    return issue(
      hasMatchBy ? 'option' : 'matchBy',
      'Parameters "matchBy" and "option" come together'
    );
  }
  if (parameters.matchBy === 'index' && !CANONICAL_INTEGER.test(String(parameters.option))) {
    return issue('option', 'Parameter "option" must be a canonical index');
  }
  return null;
}

function checkCoordinatePairing(
  parameters: Readonly<Record<string, unknown>>
): ActionParameterIssue | null {
  const hasX = hasOwn(parameters, 'x');
  return hasX !== hasOwn(parameters, 'y')
    ? issue(hasX ? 'y' : 'x', 'Parameters "x" and "y" come together')
    : null;
}

function checkFillFormPayload(
  parameters: Readonly<Record<string, unknown>>
): ActionParameterIssue | null {
  const hasFields = hasOwn(parameters, 'fields');
  const hasValues = hasOwn(parameters, 'values');
  const flat = Object.keys(parameters).filter(key => !FILL_FORM_RESERVED.has(key));
  if (hasFields && hasValues) {
    return issue(undefined, 'Parameters "fields" and "values" are mutually exclusive');
  }
  if (!hasFields && !hasValues) {
    return flat.length > 0 ? null : issue(undefined, 'FillForm requires fields');
  }
  if (flat.length > 0) {
    return issue(undefined, 'Do not mix a fields payload with top-level field entries');
  }
  const payloadKey = hasFields ? 'fields' : 'values';
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(parameters[payloadKey]));
  } catch {
    return issue(payloadKey, `Parameter "${payloadKey}" must be a JSON object`);
  }
  if (!isPlainRecord(parsed)) {
    return issue(payloadKey, `Parameter "${payloadKey}" must be a JSON object`);
  }
  for (const name of Object.keys(parsed)) {
    const entry = parsed[name];
    const acceptable =
      !UNSAFE_KEYS.has(name) &&
      (typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean' ||
        (Array.isArray(entry) && entry.every(item => typeof item === 'string')));
    if (!acceptable) {
      return issue(payloadKey, `Parameter "${payloadKey}" holds an unsupported entry`);
    }
  }
  return null;
}

function checkStrictParameters(
  type: ActionType,
  parameters: Readonly<Record<string, unknown>>
): ActionParameterIssue | null {
  const schema = SCHEMAS[type];
  for (const key of Object.keys(parameters)) {
    const spec = hasOwn(schema.keys, key) ? schema.keys[key] : undefined;
    const value = parameters[key];
    if (spec === undefined) {
      if (type !== 'fillForm' || UNSAFE_KEYS.has(key)) {
        return issue(undefined, `Unknown parameter for ${type} action`);
      }
      if (typeof value !== 'string') {
        return issue(undefined, 'Form field entries must be strings');
      }
      continue;
    }
    if (typeof value !== 'string') {
      return issue(key, `Parameter "${key}" must be a string`);
    }
    const problem = checkValue(key, spec, value);
    if (problem !== null) {
      return problem;
    }
  }
  for (const key of schema.required) {
    if (!hasOwn(parameters, key)) {
      return issue(key, `Parameter "${key}" is required for ${type} action`);
    }
  }
  if (type === 'press' && (parameters.key === '' || String(parameters.key).length > 32)) {
    return issue('key', 'Parameter "key" must be a key name');
  }
  if (type === 'navigate' && parameters.url === '') {
    return issue('url', 'Parameter "url" must not be empty');
  }
  if (type === 'click') {
    return checkCoordinatePairing(parameters);
  }
  if (type === 'select') {
    return checkSelectPairing(parameters);
  }
  if (type === 'fillForm') {
    return checkFillFormPayload(parameters);
  }
  return null;
}

/**
 * Validates the parameters of an action. Strict mode rejects non-string values, non-canonical booleans and
 * integers, unknown keys and malformed fillForm payloads; legacy mode keeps the historic leniency and only
 * insists on an object. No message ever repeats a value, an unknown key or an unknown type.
 */
export function validateActionParameters(
  action: ActionCommand,
  strict: boolean
): ActionParameterIssue | null {
  const parameters = parametersOf(action);
  if (parameters === null || (strict && !isPlainRecord(parameters))) {
    return issue(undefined, 'Action parameters are required and must be an object');
  }
  if (!ACTION_TYPES.includes(action.type)) {
    return { code: 'INVALID_ACTION', message: 'Unsupported action type' };
  }
  return strict ? checkStrictParameters(action.type, parameters) : null;
}

/**
 * Strict mode is on when ANY of options.strict, options.target or parameters.strict === 'true' holds.
 * setChecked, select and scroll have no legacy form, so they are always strict.
 */
export function isStrictExecution(action: ActionCommand, options?: ExecutionOptions): boolean {
  if (options?.strict === true || (options?.target !== undefined && options.target !== null)) {
    return true;
  }
  if (isRecord(action) && STRICT_ONLY_TYPES.has(action.type)) {
    return true;
  }
  return parametersOf(action)?.strict === 'true';
}

// A leaf nested deeper than the cap would be scrubbed only as part of the whole payload string, never alone.
const MAX_LEAF_DEPTH = 32;
const MAX_LEAF_NODES = 5000;
// Short numbers are everywhere in messages ("5 fields"); a longer one is a card, a pin or an account number.
const MIN_NUMERIC_LEAF_CHARS = 4;

type LeafBudget = { remaining: number };

function collectLeaves(value: unknown, depth: number, into: Set<string>, budget: LeafBudget): void {
  if (budget.remaining <= 0) {
    return;
  }
  budget.remaining -= 1;
  if (typeof value === 'string') {
    if (value.length > 0) {
      into.add(value);
    }
  } else if (typeof value === 'number') {
    const text = String(value);
    if (Number.isFinite(value) && text.length >= MIN_NUMERIC_LEAF_CHARS) {
      into.add(text);
    }
  } else if (depth < MAX_LEAF_DEPTH && Array.isArray(value)) {
    value.forEach(item => collectLeaves(item, depth + 1, into, budget));
  } else if (depth < MAX_LEAF_DEPTH && isRecord(value)) {
    Object.keys(value).forEach(key => collectLeaves(value[key], depth + 1, into, budget));
  }
}

function sensitiveNames(action: unknown): readonly string[] {
  const names: unknown = isRecord(action) ? action.sensitiveParameters : undefined;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string')
    : [];
}

function parametersOf(action: unknown): Readonly<Record<string, unknown>> | null {
  const parameters: unknown = isRecord(action) ? action.parameters : undefined;
  return isRecord(parameters) ? parameters : null;
}

/** True when the command lists this parameter in `sensitiveParameters`. */
export function declaresSensitive(action: ActionCommand, name: string): boolean {
  return sensitiveNames(action).includes(name);
}

/**
 * The values of the parameters named in `sensitiveParameters`, plus every string and long-number leaf of
 * them: a payload may arrive as a JSON string or, in legacy calls, as a real object.
 */
export function collectSensitiveValues(action: ActionCommand): readonly string[] {
  const names = sensitiveNames(action);
  const parameters = parametersOf(action);
  if (names.length === 0 || parameters === null) {
    return [];
  }
  const values = new Set<string>();
  const budget: LeafBudget = { remaining: MAX_LEAF_NODES };
  for (const name of names) {
    if (!hasOwn(parameters, name)) {
      continue;
    }
    const value = parameters[name];
    if (typeof value === 'string') {
      if (value.length > 0) {
        values.add(value);
        try {
          collectLeaves(JSON.parse(value), 0, values, budget);
        } catch {
          // not JSON: the raw value is already collected
        }
      }
    } else {
      collectLeaves(value, 0, values, budget);
    }
  }
  return [...values];
}

const SHORT_SECRET_LENGTH = 4;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function replaceWholeWord(text: string, secret: string, marker: string): string {
  let output = '';
  let from = 0;
  for (let at = text.indexOf(secret, from); at !== -1; at = text.indexOf(secret, from)) {
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = text.charAt(at + secret.length);
    const bounded =
      !(before !== '' && WORD_CHARACTER.test(before)) &&
      !(after !== '' && WORD_CHARACTER.test(after));
    output += text.slice(from, at) + (bounded ? marker : secret);
    from = at + secret.length;
  }
  return output + text.slice(from);
}

function scrubWithValues(text: string, values: readonly string[], marker: string): string {
  let output = text;
  const ordered = [...values].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    output =
      secret.length < SHORT_SECRET_LENGTH
        ? replaceWholeWord(output, secret, marker)
        : output.split(secret).join(marker);
  }
  return output;
}

/** Removes every sensitive value of this action, and every secret the redactor knows, from free text. */
export function scrubActionText(text: string, action: ActionCommand, redactor?: Redactor): string {
  const values = collectSensitiveValues(action);
  if (redactor) {
    return (values.length > 0 ? redactor.withSecrets(values) : redactor).scrub(text);
  }
  return values.length > 0 ? scrubWithValues(text, values, TASK_REDACTED) : text;
}

/** Shown instead of text that could not be scrubbed (a redactor that throws): never the raw text. */
export const WITHHELD_TEXT = 'The text was withheld because it could not be scrubbed';

/** `scrubActionText` that cannot throw and always returns a string: a faulty redactor withholds, never leaks. */
export function scrubActionTextSafely(
  text: unknown,
  action: ActionCommand,
  redactor?: Redactor
): string {
  try {
    return scrubActionText(typeof text === 'string' ? text : String(text), action, redactor);
  } catch {
    return WITHHELD_TEXT;
  }
}

const MAX_DATA_DEPTH = 16;

function mapStrings(value: unknown, map: (text: string) => string, depth: number): unknown {
  if (typeof value === 'string') {
    return map(value);
  }
  if (depth >= MAX_DATA_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(item => mapStrings(item, map, depth + 1));
  }
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: mapStrings(value[key], map, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}

/**
 * Deep scrub of a result payload by this action's own sensitive values (and by every secret the redactor
 * knows). Returns a copy; a structure deeper than the cap is dropped rather than passed unscrubbed.
 */
export function scrubActionData(
  data: unknown,
  action: ActionCommand,
  redactor?: Redactor
): unknown {
  const values = collectSensitiveValues(action);
  if (redactor) {
    return (values.length > 0 ? redactor.withSecrets(values) : redactor).scrubDeep(data);
  }
  return values.length > 0
    ? mapStrings(data, text => scrubWithValues(text, values, TASK_REDACTED), 0)
    : data;
}

/** Parameters safe to emit: named ones masked, every other value scrubbed, the input never mutated. */
export function redactActionParameters(
  action: ActionCommand,
  redactor?: Redactor
): Readonly<Record<string, string>> {
  const parameters = parametersOf(action);
  if (parameters === null) {
    return {};
  }
  const names = sensitiveNames(action);
  const marker = redactor?.replacement ?? TASK_REDACTED;
  const masked = redactor
    ? redactor.redactParameters(parameters as Readonly<Record<string, string>>, names)
    : null;
  const output: Record<string, string> = {};
  // defineProperty, not assignment: an own `__proto__` key must stay a plain entry and never re-parent the output.
  const put = (key: string, value: unknown): void => {
    Object.defineProperty(output, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const key of Object.keys(parameters)) {
    const raw = parameters[key];
    const base = masked ? (hasOwn(masked, key) ? masked[key] : undefined) : raw;
    if (names.includes(key)) {
      put(key, marker);
    } else if (typeof base === 'string') {
      put(key, scrubActionText(base, action, redactor));
    } else if (base !== undefined) {
      put(key, redactor ? redactor.scrubDeep(base) : base);
    }
  }
  return output;
}
