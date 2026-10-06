import type {
  ActionCheckedState,
  ActionOutcome,
  ActionSubmitInfo,
  ErrorCode,
  MutationGuard,
  ScrollDirectionName,
  SelectMatchBy,
} from '@/types';
import { AutomationError } from '@/types';
import type { DOMRoot } from '@/utils/DOMRoot';

/*
 * Strict executor primitives. Every function resolves nothing by text, never falls back to another
 * element, returns a union and never throws: a guard that throws (cancellation) becomes a failure result.
 * `guard.commit()` runs immediately before the first page mutation and never between the events of one
 * activation; read-only settle polling after it checkpoints, so an abort there leaves an uncertain effect.
 */

type Failure = { readonly ok: false; readonly code: ErrorCode; readonly message: string };
type Done<K extends ActionOutcome['kind']> = {
  readonly ok: true;
  readonly outcome: Extract<ActionOutcome, { kind: K }>;
};
type Result<K extends ActionOutcome['kind']> = Done<K> | Failure;
type Resolution = { readonly ok: true; readonly element: HTMLElement } | Failure;

const SETTLE_ROUNDS = 5;
const SETTLE_INTERVAL_MS = 20;
const SCROLL_STEP_RATIO = 0.7;
const EDGE_EPSILON = 2;
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
const EDITABLE_INPUT_TYPES = new Set([
  'text',
  'email',
  'password',
  'tel',
  'url',
  'search',
  'number',
]);
const IMPLICIT_SUBMIT_TYPES = new Set([
  ...EDITABLE_INPUT_TYPES,
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);
const ARIA_CHECKABLE_ROLES = new Set([
  'switch',
  'checkbox',
  'radio',
  'menuitemcheckbox',
  'menuitemradio',
]);
const ARIA_RADIO_ROLES = new Set(['radio', 'menuitemradio']);
const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);

function fail(code: ErrorCode, message: string): Failure {
  return { ok: false, code, message };
}

function failureOf(error: unknown): Failure {
  if (error instanceof AutomationError) {
    return fail(error.code, error.message);
  }
  return fail('EXECUTION_FAILED', 'The action failed unexpectedly');
}

function checkpoint(guard: MutationGuard): Failure | null {
  try {
    guard.checkpoint();
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

function commit(guard: MutationGuard): Failure | null {
  try {
    guard.commit();
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

function attempt<T>(run: () => T | Failure): T | Failure {
  try {
    return run();
  } catch (error) {
    return failureOf(error);
  }
}

async function attemptAsync<T>(run: () => Promise<T | Failure>): Promise<T | Failure> {
  try {
    return await run();
  } catch (error) {
    return failureOf(error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNativelyDisabled(element: Element): boolean {
  try {
    return element.matches(':disabled');
  } catch {
    return false;
  }
}

function isDisabled(element: Element): boolean {
  return isNativelyDisabled(element) || element.getAttribute('aria-disabled') === 'true';
}

function disabledFailure(element: Element): Failure | null {
  return isDisabled(element) ? fail('TARGET_DISABLED', 'Target element is disabled') : null;
}

function inputTypeOf(element: Element): string {
  return element.localName === 'input' ? (element as HTMLInputElement).type : '';
}

function dispatchFlag(element: EventTarget, event: Event): boolean {
  return element.dispatchEvent(event);
}

/** The automation root a strict lookup is confined to; absent means the whole document. */
type StrictScope = Pick<DOMRoot, 'document' | 'contains' | 'querySelectorAll'>;

export function resolveStrictElement(
  selector: string | undefined,
  target: HTMLElement | undefined,
  scope?: StrictScope
): Resolution {
  if (target !== undefined) {
    const present = (target as HTMLElement | null) !== null && target.isConnected;
    const owner = scope?.document ?? document;
    return present && target.ownerDocument === owner && (scope?.contains(target) ?? true)
      ? { ok: true, element: target }
      : fail('TARGET_STALE', 'Target element is no longer in the document');
  }
  if (selector === undefined || selector === '') {
    return fail('INVALID_ACTION', 'Strict action needs a target element or a selector');
  }
  let matches: readonly Element[];
  try {
    matches = scope
      ? scope.querySelectorAll(selector)
      : Array.from(document.querySelectorAll(selector));
  } catch {
    return fail('VALIDATION_FAILED', 'Selector is not valid');
  }
  const [first] = matches;
  if (first === undefined) {
    return fail('TARGET_STALE', 'No element matches the selector');
  }
  if (matches.length > 1) {
    return fail('TARGET_AMBIGUOUS', 'More than one element matches the selector');
  }
  return { ok: true, element: first as HTMLElement };
}

/** The tree a form's controls live in: the document, or the shadow root that holds the form. */
function treeOf(form: HTMLFormElement): ParentNode {
  const root = form.getRootNode();
  return 'querySelectorAll' in root ? (root as ParentNode) : form.ownerDocument;
}

function controlsOf(form: HTMLFormElement): readonly Element[] {
  return Array.from(treeOf(form).querySelectorAll('button, input')).filter(
    control => (control as HTMLButtonElement).form === form
  );
}

function isSubmitButton(element: Element): boolean {
  if (element.localName === 'button') {
    return (element as HTMLButtonElement).type === 'submit';
  }
  const type = inputTypeOf(element);
  return type === 'submit' || type === 'image';
}

function defaultButtonOf(form: HTMLFormElement): Element | undefined {
  return controlsOf(form).find(isSubmitButton);
}

/**
 * Whether Enter in this element runs implicit form submission in a browser: a text-like input with a form
 * and either a default submit button that is not disabled, or no submit button and no other field that
 * blocks implicit submission. Reads only; never submits, focuses or mutates.
 */
export function canImplicitlySubmit(element: HTMLElement): boolean {
  if (!IMPLICIT_SUBMIT_TYPES.has(inputTypeOf(element)) || isNativelyDisabled(element)) {
    return false;
  }
  const { form } = element as HTMLInputElement;
  if (form === null) {
    return false;
  }
  const defaultButton = defaultButtonOf(form);
  if (defaultButton !== undefined) {
    return !isNativelyDisabled(defaultButton);
  }
  return (
    controlsOf(form).filter(control => IMPLICIT_SUBMIT_TYPES.has(inputTypeOf(control))).length <= 1
  );
}

type SubmissionWatch = { readonly read: () => ActionSubmitInfo; readonly stop: () => void };

function watchSubmission(form: HTMLFormElement): SubmissionWatch {
  // submit and invalid are not composed: a form inside a shadow root only reports to its own root.
  const scope = form.getRootNode();
  const state: { submit: Event | null; invalid: number } = { submit: null, invalid: 0 };
  const onSubmit = (event: Event): void => {
    if (event.target === form && state.submit === null) {
      state.submit = event;
    }
  };
  const onInvalid = (event: Event): void => {
    if ((event.target as { form?: HTMLFormElement | null }).form === form) {
      state.invalid += 1;
    }
  };
  scope.addEventListener('submit', onSubmit, true);
  scope.addEventListener('invalid', onInvalid, true);
  return {
    read: (): ActionSubmitInfo => ({
      event: state.submit !== null,
      invalidControls: state.invalid,
      defaultPrevented: state.submit?.defaultPrevented === true,
    }),
    stop: (): void => {
      scope.removeEventListener('submit', onSubmit, true);
      scope.removeEventListener('invalid', onInvalid, true);
    },
  };
}

function submittedFormOf(element: Element): HTMLFormElement | null {
  return isSubmitButton(element) ? (element as HTMLButtonElement).form : null;
}

function pointerEvent(type: string, init: MouseEventInit): Event {
  return typeof PointerEvent === 'function'
    ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
    : new MouseEvent(type, init);
}

function elementAt(element: Element, x: number, y: number): Element | null | undefined {
  const root = element.getRootNode() as Partial<DocumentOrShadowRoot>;
  const source = typeof root.elementFromPoint === 'function' ? root : element.ownerDocument;
  return typeof source.elementFromPoint === 'function' ? source.elementFromPoint(x, y) : undefined;
}

type Point = { readonly ok: true; readonly x: number; readonly y: number } | Failure;

function visiblePoint(element: HTMLElement, guard: MutationGuard): Point {
  const before = element.getBoundingClientRect();
  if (before.width <= 0 || before.height <= 0) {
    return fail('TARGET_OBSCURED', 'Target element has no visible box');
  }
  const view = element.ownerDocument.defaultView;
  const beforeX = before.left + before.width / 2;
  const beforeY = before.top + before.height / 2;
  if (
    view &&
    beforeX >= 0 &&
    beforeX < view.innerWidth &&
    beforeY >= 0 &&
    beforeY < view.innerHeight
  ) {
    const hit = elementAt(element, beforeX, beforeY);
    if (hit !== undefined && (hit === null || (hit !== element && !element.contains(hit)))) {
      return fail('TARGET_OBSCURED', 'Another element covers the target');
    }
  }
  if (typeof element.scrollIntoView === 'function') {
    const committed = commit(guard);
    if (committed !== null) {
      return committed;
    }
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const cancelled = checkpoint(guard);
    if (cancelled !== null) {
      return cancelled;
    }
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return fail('TARGET_OBSCURED', 'Target element has no visible box');
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = elementAt(element, x, y);
  if (hit !== undefined && (hit === null || (hit !== element && !element.contains(hit)))) {
    return fail('TARGET_OBSCURED', 'Another element covers the target');
  }
  return { ok: true, x, y };
}

function activate(element: HTMLElement, x: number, y: number): boolean {
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    clientX: x,
    clientY: y,
  };
  dispatchFlag(element, pointerEvent('pointerdown', { ...base, buttons: 1 }));
  dispatchFlag(element, new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
  dispatchFlag(element, pointerEvent('pointerup', { ...base, buttons: 0 }));
  dispatchFlag(element, new MouseEvent('mouseup', { ...base, buttons: 0, detail: 1 }));
  return dispatchFlag(element, new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
}

export function clickStrict(element: HTMLElement, guard: MutationGuard): Result<'click'> {
  return attempt((): Result<'click'> => {
    const blocked = disabledFailure(element) ?? checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const point = visiblePoint(element, guard);
    if (!point.ok) {
      return point;
    }
    const form = submittedFormOf(element);
    const watch = form === null ? null : watchSubmission(form);
    try {
      const committed = guard.committed ? checkpoint(guard) : commit(guard);
      if (committed !== null) {
        return committed;
      }
      const proceeded = activate(element, point.x, point.y);
      const submit = watch === null ? {} : { submit: watch.read() };
      return { ok: true, outcome: { kind: 'click', defaultPrevented: !proceeded, ...submit } };
    } finally {
      watch?.stop();
    }
  });
}

function isSensitiveTarget(element: Element): boolean {
  if (inputTypeOf(element) === 'password') {
    return true;
  }
  const tokens = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  const marker = element.getAttribute('data-kriya-sensitive');
  return (
    tokens.some(token => token.startsWith('cc-') || SENSITIVE_AUTOCOMPLETE.has(token)) ||
    (marker !== null && marker.toLowerCase() !== 'false')
  );
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

function textControlOf(element: Element): TextControl | null {
  if (element.localName === 'textarea') {
    return element as HTMLTextAreaElement;
  }
  return EDITABLE_INPUT_TYPES.has(inputTypeOf(element)) ? (element as HTMLInputElement) : null;
}

function writeNativeValue(control: TextControl, value: string): void {
  let proto: object | null = Object.getPrototypeOf(control) as object | null;
  while (proto !== null) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter !== undefined) {
      setter.call(control, value);
      return;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  control.value = value;
}

function focusQuietly(element: HTMLElement): void {
  if (typeof element.focus === 'function') {
    element.focus({ preventScroll: true });
  }
}

export function fillStrict(
  element: HTMLElement,
  value: string,
  guard: MutationGuard,
  sensitive = false
): Result<'fill'> {
  return attempt((): Result<'fill'> => {
    if (typeof value !== 'string') {
      return fail('VALIDATION_FAILED', 'Value must be a string');
    }
    const control = textControlOf(element);
    if (control === null) {
      return fail('NOT_EDITABLE', 'Target element is not a text field');
    }
    const blocked =
      disabledFailure(control) ??
      (control.readOnly ? fail('NOT_EDITABLE', 'Target field is read-only') : null) ??
      checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const hidden = sensitive || isSensitiveTarget(control);
    const before = control.value;
    const describe = (after: string, changed: boolean): Done<'fill'> => ({
      ok: true,
      outcome: {
        kind: 'fill',
        tag: control.localName,
        inputType: control.type,
        ...(hidden ? {} : { length: after.length }),
        empty: after === '',
        changed,
        matched: after === value,
      },
    });
    if (before === value) {
      return describe(before, false);
    }
    const committed = commit(guard);
    if (committed !== null) {
      return committed;
    }
    focusQuietly(control);
    writeNativeValue(control, value);
    dispatchFlag(control, new Event('input', { bubbles: true, composed: true }));
    dispatchFlag(control, new Event('change', { bubbles: true }));
    return describe(control.value, control.value !== before);
  });
}

type KeySpec = {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly printable: boolean;
};

const NAMED_KEYS: ReadonlyMap<string, KeySpec> = new Map(
  (
    [
      ['Enter', 'Enter', 13],
      ['Escape', 'Escape', 27],
      ['Tab', 'Tab', 9],
      ['Backspace', 'Backspace', 8],
      ['Delete', 'Delete', 46],
      ['ArrowUp', 'ArrowUp', 38],
      ['ArrowDown', 'ArrowDown', 40],
      ['ArrowLeft', 'ArrowLeft', 37],
      ['ArrowRight', 'ArrowRight', 39],
      ['Home', 'Home', 36],
      ['End', 'End', 35],
      ['PageUp', 'PageUp', 33],
      ['PageDown', 'PageDown', 34],
      [' ', 'Space', 32],
    ] as const
  ).map(([key, code, keyCode]): [string, KeySpec] => [
    key,
    { key, code, keyCode, printable: key === ' ' },
  ])
);

function keySpecOf(key: string): KeySpec | null {
  if (typeof key !== 'string') {
    return null;
  }
  const named = NAMED_KEYS.get(key === 'Space' ? ' ' : key);
  if (named !== undefined) {
    return named;
  }
  if (key.length !== 1 || key < ' ') {
    return null;
  }
  if (/^[a-z]$/i.test(key)) {
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
      printable: true,
    };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), printable: true };
  }
  return { key, code: '', keyCode: key.charCodeAt(0), printable: true };
}

function keypressCharCode(spec: KeySpec): number {
  if (spec.key === 'Enter') {
    return 13;
  }
  return spec.printable ? spec.key.charCodeAt(0) : 0;
}

function keyboardEvent(type: string, spec: KeySpec): KeyboardEvent {
  return new KeyboardEvent(type, {
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    which: spec.keyCode,
    charCode: type === 'keypress' ? keypressCharCode(spec) : 0,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
}

type DefaultAction = 'implicit_submit' | 'activate' | 'none';

function isButtonLike(element: Element): boolean {
  return (
    element.localName === 'button' ||
    element.localName === 'summary' ||
    (element.localName === 'input' && BUTTON_INPUT_TYPES.has(inputTypeOf(element)))
  );
}

function defaultActionFor(element: HTMLElement, key: string): DefaultAction {
  if (key === 'Enter') {
    if (canImplicitlySubmit(element)) {
      return 'implicit_submit';
    }
    const link = element.localName === 'a' && element.hasAttribute('href');
    return link || isButtonLike(element) ? 'activate' : 'none';
  }
  if (key !== ' ') {
    return 'none';
  }
  const type = inputTypeOf(element);
  return isButtonLike(element) || type === 'checkbox' || type === 'radio' ? 'activate' : 'none';
}

function runDefaultAction(element: HTMLElement, action: DefaultAction): DefaultAction {
  if (action === 'activate') {
    element.click();
    return action;
  }
  const { form } = element as HTMLInputElement;
  if (action === 'implicit_submit' && form !== null && typeof form.requestSubmit === 'function') {
    const submitter = defaultButtonOf(form);
    if (submitter === undefined) {
      form.requestSubmit();
    } else {
      (submitter as HTMLElement).click();
    }
    return action;
  }
  return 'none';
}

function formOfDefaultAction(element: HTMLElement, action: DefaultAction): HTMLFormElement | null {
  if (action === 'implicit_submit') {
    return (element as HTMLInputElement).form;
  }
  return action === 'activate' ? submittedFormOf(element) : null;
}

function sendKeys(
  element: HTMLElement,
  spec: KeySpec,
  planned: DefaultAction
): { readonly prevented: boolean; readonly performed: DefaultAction } {
  const runs = (key: string): boolean => spec.key === key;
  let prevented = !dispatchFlag(element, keyboardEvent('keydown', spec));
  if (!prevented && (runs('Enter') || spec.printable)) {
    prevented = !dispatchFlag(element, keyboardEvent('keypress', spec));
  }
  let performed: DefaultAction = 'none';
  if (!prevented && runs('Enter')) {
    performed = runDefaultAction(element, planned);
  }
  dispatchFlag(element, keyboardEvent('keyup', spec));
  if (!prevented && runs(' ')) {
    performed = runDefaultAction(element, planned);
  }
  return { prevented, performed };
}

export function pressStrict(
  element: HTMLElement,
  key: string,
  implicitSubmit: boolean,
  guard: MutationGuard
): Result<'press'> {
  return attempt((): Result<'press'> => {
    const spec = keySpecOf(key);
    if (spec === null) {
      return fail('VALIDATION_FAILED', 'Unsupported key');
    }
    const blocked = disabledFailure(element) ?? checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const planned: DefaultAction = implicitSubmit ? defaultActionFor(element, spec.key) : 'none';
    const form = formOfDefaultAction(element, planned);
    const watch = form === null ? null : watchSubmission(form);
    try {
      const committed = commit(guard);
      if (committed !== null) {
        return committed;
      }
      focusQuietly(element);
      const { prevented, performed } = sendKeys(element, spec, planned);
      const submit = watch !== null && performed !== 'none' ? { submit: watch.read() } : {};
      return {
        ok: true,
        outcome: {
          kind: 'press',
          defaultPrevented: prevented,
          defaultAction: performed,
          ...submit,
        },
      };
    } finally {
      watch?.stop();
    }
  });
}

type CheckedControl =
  | { readonly kind: 'native'; readonly control: HTMLInputElement }
  | { readonly kind: 'aria'; readonly control: HTMLElement };

function resolveCheckedControl(element: HTMLElement): CheckedControl | null {
  const candidate = element.localName === 'label' ? (element as HTMLLabelElement).control : element;
  if (candidate === null) {
    return null;
  }
  const type = inputTypeOf(candidate);
  if (type === 'checkbox' || type === 'radio') {
    return { kind: 'native', control: candidate as HTMLInputElement };
  }
  const role = candidate.getAttribute('role');
  const ariaControl =
    element === candidate &&
    role !== null &&
    ARIA_CHECKABLE_ROLES.has(role) &&
    candidate.hasAttribute('aria-checked');
  return ariaControl ? { kind: 'aria', control: candidate as HTMLElement } : null;
}

function readChecked(checked: CheckedControl): ActionCheckedState {
  if (checked.kind === 'native') {
    return checked.control.indeterminate ? 'mixed' : checked.control.checked;
  }
  const state = checked.control.getAttribute('aria-checked');
  return state === 'mixed' ? 'mixed' : state === 'true';
}

function isRadio(checked: CheckedControl): boolean {
  return checked.kind === 'native'
    ? checked.control.type === 'radio'
    : ARIA_RADIO_ROLES.has(checked.control.getAttribute('role') ?? '');
}

async function settle<T>(
  read: () => T,
  done: (value: T) => boolean,
  guard: MutationGuard
): Promise<{ readonly ok: true; readonly value: T } | Failure> {
  let value = read();
  for (let round = 0; round < SETTLE_ROUNDS && !done(value); round += 1) {
    await sleep(SETTLE_INTERVAL_MS);
    const cancelled = checkpoint(guard);
    if (cancelled !== null) {
      return cancelled;
    }
    value = read();
  }
  return { ok: true, value };
}

export async function setChecked(
  element: HTMLElement,
  desired: boolean,
  guard: MutationGuard
): Promise<Result<'setChecked'>> {
  return attemptAsync(async (): Promise<Result<'setChecked'>> => {
    if (typeof desired !== 'boolean') {
      return fail('VALIDATION_FAILED', 'Checked must be a boolean');
    }
    const checked = resolveCheckedControl(element);
    if (checked === null) {
      return fail('NOT_CHECKABLE', 'Target element is not a checkbox, radio or switch');
    }
    const before = readChecked(checked);
    const blocked =
      disabledFailure(checked.control) ??
      (!desired && isRadio(checked)
        ? fail('UNSUPPORTED_STATE', 'A radio cannot be unchecked')
        : null) ??
      (!desired && before === 'mixed'
        ? fail('UNSUPPORTED_STATE', 'A mixed control cannot be set to unchecked directly')
        : null) ??
      checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const outcome = (
      control: 'native' | 'aria',
      after: ActionCheckedState
    ): Done<'setChecked'> => ({
      ok: true,
      outcome: {
        kind: 'setChecked',
        control,
        before,
        after,
        changed: after !== before,
        matched: after === desired,
      },
    });
    if (before === desired) {
      return outcome(checked.kind, before);
    }
    const committed = commit(guard);
    if (committed !== null) {
      return committed;
    }
    focusQuietly(checked.control);
    checked.control.click();
    const settled = await settle(
      () => readChecked(checked),
      state => state === desired,
      guard
    );
    return settled.ok ? outcome(checked.kind, settled.value) : settled;
  });
}

const BLANK = /\s+/g;

function collapse(text: string): string {
  return text.replace(BLANK, ' ').trim();
}

function labelOf(option: HTMLOptionElement): string {
  return collapse(option.label === '' ? option.text : option.label);
}

function optionIsDisabled(option: HTMLOptionElement): boolean {
  const group = option.parentElement;
  return (
    option.disabled || (group?.localName === 'optgroup' && (group as HTMLOptGroupElement).disabled)
  );
}

const SELECT_MATCHES: ReadonlySet<string> = new Set(['value', 'label', 'index']);

type Matches = { readonly ok: true; readonly options: readonly HTMLOptionElement[] } | Failure;

function matchingOptions(
  select: HTMLSelectElement,
  matchBy: SelectMatchBy,
  needle: string
): Matches {
  const options = Array.from(select.options);
  if (matchBy === 'value') {
    return { ok: true, options: options.filter(option => option.value === needle) };
  }
  if (matchBy === 'label') {
    const wanted = collapse(needle);
    return { ok: true, options: options.filter(option => labelOf(option) === wanted) };
  }
  if (!/^(0|[1-9][0-9]*)$/.test(needle)) {
    return fail('VALIDATION_FAILED', 'Option index is not a canonical integer');
  }
  return { ok: true, options: options.filter(option => option.index === Number(needle)) };
}

export function selectNative(
  select: HTMLSelectElement,
  matchBy: SelectMatchBy,
  needle: string,
  triggerEvents: boolean,
  guard: MutationGuard
): Result<'select'> {
  return attempt((): Result<'select'> => {
    if (!SELECT_MATCHES.has(matchBy) || typeof needle !== 'string') {
      return fail('VALIDATION_FAILED', 'Select needs a known matchBy and a string option');
    }
    const blocked =
      disabledFailure(select) ??
      (select.multiple ? fail('UNSUPPORTED_STATE', 'Multiple selects are not supported') : null) ??
      checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const matches = matchingOptions(select, matchBy, needle);
    if (!matches.ok) {
      return matches;
    }
    const [option] = matches.options;
    if (option === undefined) {
      return fail('OPTION_NOT_FOUND', 'No option matches');
    }
    if (matches.options.length > 1) {
      return fail('OPTION_AMBIGUOUS', 'More than one option matches');
    }
    if (optionIsDisabled(option)) {
      return fail('OPTION_DISABLED', 'The matching option is disabled');
    }
    const before = select.selectedIndex;
    const describe = (changed: boolean): Done<'select'> => ({
      ok: true,
      outcome: {
        kind: 'select',
        control: 'native',
        index: option.index,
        changed,
        matched: select.selectedIndex === option.index && option.selected,
      },
    });
    if (before === option.index) {
      return describe(false);
    }
    const committed = commit(guard);
    if (committed !== null) {
      return committed;
    }
    option.selected = true;
    if (triggerEvents) {
      dispatchFlag(select, new Event('input', { bubbles: true, composed: true }));
      dispatchFlag(select, new Event('change', { bubbles: true }));
    }
    return describe(select.selectedIndex !== before);
  });
}

export async function selectAriaOption(
  element: HTMLElement,
  guard: MutationGuard
): Promise<Result<'select'>> {
  return attemptAsync(async (): Promise<Result<'select'>> => {
    if (element.getAttribute('role') !== 'option') {
      return fail('OPTION_NOT_FOUND', 'Target element is not an option');
    }
    const listbox = element.closest('[role="listbox"]');
    if (listbox === null) {
      return fail('UNSUPPORTED_STATE', 'Option has no owning listbox');
    }
    const blocked =
      (element.getAttribute('aria-disabled') === 'true'
        ? fail('OPTION_DISABLED', 'Option is disabled')
        : null) ?? checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const index = Array.from(listbox.querySelectorAll('[role="option"]')).indexOf(element);
    const done = (changed: boolean, matched: boolean | null): Done<'select'> => ({
      ok: true,
      outcome: { kind: 'select', control: 'aria', index, changed, matched },
    });
    if (element.getAttribute('aria-selected') === 'true') {
      return done(false, true);
    }
    const point = element.getBoundingClientRect();
    const committed = commit(guard);
    if (committed !== null) {
      return committed;
    }
    activate(element, point.left + point.width / 2, point.top + point.height / 2);
    const settled = await settle(
      () => ({
        selected: element.getAttribute('aria-selected') === 'true',
        connected: element.isConnected,
      }),
      state => state.selected || !state.connected,
      guard
    );
    if (!settled.ok) {
      return settled;
    }
    const { selected, connected } = settled.value;
    if (selected) {
      return done(true, true);
    }
    return connected ? done(false, false) : done(true, null);
  });
}

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['UP', 'DOWN', 'TOP', 'BOTTOM']);

function nextScrollTop(
  direction: ScrollDirectionName,
  before: number,
  max: number,
  step: number
): number {
  switch (direction) {
    case 'TOP':
      return 0;
    case 'BOTTOM':
      return max;
    case 'DOWN':
      return Math.min(max, before + step);
    default:
      return Math.max(0, before - step);
  }
}

function pageScrollerOf(doc: Document): HTMLElement {
  return (doc.scrollingElement ?? doc.documentElement) as HTMLElement;
}

function containerFailure(container: HTMLElement): Failure | null {
  const view = container.ownerDocument.defaultView;
  const overflow = view === null ? '' : view.getComputedStyle(container).overflowY;
  return SCROLLABLE_OVERFLOW.has(overflow) && container.scrollHeight > container.clientHeight
    ? null
    : fail('UNSUPPORTED_STATE', 'Target element is not a scroll container');
}

export function scroll(
  direction: ScrollDirectionName,
  container: HTMLElement | undefined,
  guard: MutationGuard
): Result<'scroll'> {
  return attempt((): Result<'scroll'> => {
    if (!SCROLL_DIRECTIONS.has(direction)) {
      return fail('VALIDATION_FAILED', 'Unsupported scroll direction');
    }
    const doc = container?.ownerDocument ?? document;
    const isPage =
      container === undefined || container === doc.documentElement || container === doc.body;
    const scroller = isPage ? pageScrollerOf(doc) : container;
    const blocked = (isPage ? null : containerFailure(scroller)) ?? checkpoint(guard);
    if (blocked !== null) {
      return blocked;
    }
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const before = scroller.scrollTop;
    const step = Math.max(1, Math.floor(scroller.clientHeight * SCROLL_STEP_RATIO));
    const next = nextScrollTop(direction, before, max, step);
    const describe = (after: number, reason?: 'edge' | 'blocked'): Done<'scroll'> => ({
      ok: true,
      outcome: {
        kind: 'scroll',
        moved: Math.abs(after - before) >= 1,
        ...(reason === undefined ? {} : { reason }),
        before,
        after,
        max,
        atTop: after <= EDGE_EPSILON,
        atBottom: after >= max - EDGE_EPSILON,
      },
    });
    if (Math.abs(next - before) < 1) {
      return describe(before, 'edge');
    }
    const committed = commit(guard);
    if (committed !== null) {
      return committed;
    }
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: next, left: scroller.scrollLeft, behavior: 'instant' });
    } else {
      scroller.scrollTop = next;
    }
    const after = scroller.scrollTop;
    return describe(after, Math.abs(after - before) >= 1 ? undefined : 'blocked');
  });
}
