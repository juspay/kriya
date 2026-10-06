import { TASK_COMMITMENT_CLASSES, TASK_DEFAULT_SETTLE, TASK_LIMITS, TASK_REDACTED } from '@/types';
import type {
  TaskCommitHint,
  TaskDialog,
  TaskElement,
  TaskElementKind,
  TaskElementState,
  TaskFormTarget,
  TaskHostOperation,
  TaskIdFactory,
  TaskObservation,
  TaskObserver,
  TaskObserverConfig,
  TaskObserveRequest,
  TaskScrollState,
  TaskSettleOptions,
  TaskTargetRef,
  TaskTargetResolution,
  TaskValidationMessage,
} from '@/types';
import { canImplicitlySubmit } from '@/actions/strict';
import { hashString, sha256Hex, stableStringify } from '@/utils/hash';
import { createRedactor, isSensitiveKey } from '@/utils/redact';
import { sanitizeUntrustedText } from '@/utils/sanitize';
import { capFieldValue } from '@/utils/value';

const PASSAGES = 'h1,h2,h3,h4,h5,h6,p,li,dd,figcaption';
const REGIONS =
  '[role=group],[role=radiogroup],[role=dialog],[role=region],[role=main],[role=navigation],[role=complementary],[role=banner],fieldset,form,main,nav,aside,section,article,li,dialog';
const TEXT_TYPES = new Set(['text', 'email', 'password', 'tel', 'url', 'search', 'number']);
const MAX_DEFINITION_SIBLINGS = 64;
type StoredTarget = {
  readonly element: HTMLElement;
  readonly entry: TaskElement;
  readonly security: string;
};
type Snapshot = {
  readonly id: string;
  readonly url: string;
  readonly targets: Map<string, StoredTarget>;
  readonly options: TaskObserveRequest['options'];
};
type Session = { readonly snapshot: Snapshot; readonly sequence: number };
type Description = {
  readonly element: HTMLElement;
  readonly entry: TaskElement;
  readonly security: string;
};
type Context = {
  readonly config: TaskObserverConfig<HTMLElement>;
  readonly formId: (form: HTMLFormElement) => string;
  readonly dialogId: (dialog: HTMLElement) => string;
  readonly radioGroupId: (group: HTMLElement) => string;
  readonly controlId: (control: HTMLElement) => string;
  readonly options: TaskObserveRequest['options'];
  readonly redactUrl: (url: string) => string;
};

function labelText(element: HTMLElement): string {
  const labelled = element.getAttribute('aria-labelledby');
  if (labelled) {
    return labelled
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ');
  }
  const aria = element.getAttribute('aria-label');
  if (aria !== null) {
    return aria;
  }
  const labels = 'labels' in element ? (element as HTMLInputElement).labels : null;
  if (labels?.length) {
    return Array.from(labels)
      .map(label => label.textContent ?? '')
      .join(' ');
  }
  return element.getAttribute('title') ?? element.getAttribute('placeholder') ?? '';
}

export function isSensitiveElement(
  element: HTMLElement,
  config: Pick<TaskObserverConfig<HTMLElement>, 'isSensitive' | 'sensitiveSelectors'> = {}
): boolean {
  try {
    const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    if (
      element.matches('input[type=password]') ||
      autocomplete.some(
        token =>
          token.startsWith('cc-') ||
          ['current-password', 'new-password', 'one-time-code'].includes(token)
      )
    ) {
      return true;
    }
    if (
      element.hasAttribute('data-kriya-sensitive') &&
      element.getAttribute('data-kriya-sensitive') !== 'false'
    ) {
      return true;
    }
    if (
      ['name', 'id', 'aria-label', 'placeholder'].some(key =>
        isSensitiveKey(element.getAttribute(key) ?? '')
      ) ||
      isSensitiveKey(labelText(element))
    ) {
      return true;
    }
    if (config.sensitiveSelectors?.some(selector => element.matches(selector))) {
      return true;
    }
    return config.isSensitive?.(element) === true;
  } catch {
    return true;
  }
}

function hidden(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (
      node.hidden ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility) ||
      style.opacity === '0'
    ) {
      return true;
    }
    if (node.matches('dialog:not([open])')) {
      return true;
    }
  }
  return false;
}

function safeText(element: HTMLElement, config: TaskObserverConfig<HTMLElement>): string {
  if (
    hidden(element) ||
    isSensitiveElement(element, config) ||
    element.matches(
      'script,style,noscript,template,iframe,canvas,input,textarea,select,[contenteditable]'
    )
  ) {
    return '';
  }
  return Array.from(element.childNodes)
    .map(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? '';
      }
      return node instanceof HTMLElement ? safeText(node, config) : '';
    })
    .join(' ');
}

function clean(text: string, max: number = TASK_LIMITS.labelChars): string {
  return sanitizeUntrustedText(text, max);
}

function accessibleName(element: HTMLElement, config: TaskObserverConfig<HTMLElement>): string {
  const explicit = labelText(element);
  if (explicit) {
    return clean(explicit);
  }
  if (
    element instanceof HTMLInputElement &&
    ['submit', 'button', 'reset'].includes(element.type) &&
    !isSensitiveElement(element, config)
  ) {
    return clean(element.value || element.type);
  }
  return clean(safeText(element, config));
}

function formOf(element: HTMLElement): HTMLFormElement | null {
  return 'form' in element ? (element as HTMLInputElement).form : element.closest('form');
}

function radioGroupOf(element: HTMLElement, context: Context): string | undefined {
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    return element.name !== ''
      ? `${element.form ? context.formId(element.form) : 'doc'}:${element.name}`
      : undefined;
  }
  const group = element.closest<HTMLElement>('[role=radiogroup]');
  return group ? `aria:${context.radioGroupId(group)}` : undefined;
}

function boundControlOf(element: HTMLElement): HTMLElement {
  return element instanceof HTMLLabelElement &&
    element.control instanceof HTMLInputElement &&
    ['checkbox', 'radio'].includes(element.control.type)
    ? element.control
    : element;
}

function validationOf(
  item: Description,
  config: TaskObserverConfig<HTMLElement>
): readonly TaskValidationMessage[] {
  if (item.entry.sensitive) {
    return [];
  }
  const native = boundControlOf(item.element) as HTMLInputElement;
  const messages: TaskValidationMessage[] = [];
  if (
    item.entry.state.constraintInvalid === true &&
    native.validity?.valid === false &&
    native.validationMessage
  ) {
    messages.push({
      source: 'native',
      text: clean(native.validationMessage, TASK_LIMITS.passageChars),
      targetId: item.entry.id,
    });
  }
  const references = new Set(
    [
      native.getAttribute('aria-errormessage') ?? '',
      ...(native.getAttribute('aria-invalid') === 'true'
        ? [native.getAttribute('aria-describedby') ?? '']
        : []),
    ]
      .join(' ')
      .split(/\s+/)
      .filter(Boolean)
  );
  for (const id of references) {
    const node = document.getElementById(id);
    if (node) {
      const text = clean(safeText(node, config), TASK_LIMITS.passageChars);
      if (text) {
        messages.push({ source: 'aria', text, targetId: item.entry.id });
      }
    }
  }
  return messages;
}

function defaultSubmitterOf(
  form: HTMLFormElement
): HTMLButtonElement | HTMLInputElement | undefined {
  const root = form.getRootNode();
  const tree = 'querySelectorAll' in root ? (root as ParentNode) : form.ownerDocument;
  return Array.from(tree.querySelectorAll('button,input')).find(
    (candidate): candidate is HTMLButtonElement | HTMLInputElement =>
      (candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement) &&
      candidate.form === form &&
      (candidate.type === 'submit' ||
        (candidate instanceof HTMLInputElement && candidate.type === 'image'))
  );
}

function scrollState(top: number, max: number): TaskScrollState {
  return {
    top,
    max: Math.max(0, max),
    directions: [
      ...(top > 2 ? (['UP', 'TOP'] as const) : []),
      ...(top < max - 2 ? (['DOWN', 'BOTTOM'] as const) : []),
    ],
  };
}

function elementScroll(element: HTMLElement): TaskScrollState | undefined {
  const style = window.getComputedStyle(element);
  if (
    /(auto|scroll)/.test(`${style.overflow} ${style.overflowY}`) &&
    element.scrollHeight > element.clientHeight + 2
  ) {
    return scrollState(element.scrollTop, element.scrollHeight - element.clientHeight);
  }
  return undefined;
}

function kindFromAriaRole(role: string): TaskElementKind | undefined {
  if (
    [
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'combobox',
      'option',
    ].includes(role)
  ) {
    return role as TaskElementKind;
  }
  if (role === 'menuitemradio') {
    return 'radio';
  }
  return ['textbox', 'searchbox', 'spinbutton'].includes(role) ? 'text_input' : undefined;
}

function kindOf(element: HTMLElement): TaskElementKind | undefined {
  if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) {
    return 'link';
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === 'hidden') {
      return undefined;
    }
    if (['button', 'submit', 'reset', 'image'].includes(element.type)) {
      return 'button';
    }
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.type;
    }
    return TEXT_TYPES.has(element.type) ? 'text_input' : 'other';
  }
  if (element instanceof HTMLTextAreaElement) {
    return 'textarea';
  }
  if (element instanceof HTMLSelectElement) {
    return 'select';
  }
  const ariaKind = kindFromAriaRole(element.getAttribute('role') ?? '');
  if (element instanceof HTMLButtonElement) {
    return ariaKind ?? 'button';
  }
  if (element.matches('summary')) {
    return 'button';
  }
  if (ariaKind) {
    return ariaKind;
  }
  if (elementScroll(element)) {
    return 'scroller';
  }
  return element.matches(PASSAGES) ? 'passage' : undefined;
}

function regionLabel(element: HTMLElement, config: TaskObserverConfig<HTMLElement>): string {
  const heading =
    element instanceof HTMLFieldSetElement
      ? Array.from(element.children).find(child => child instanceof HTMLLegendElement)
      : element.querySelector('h1,h2,h3,h4,h5,h6');
  return labelText(element) || (heading instanceof HTMLElement ? safeText(heading, config) : '');
}

function definitionTerms(
  element: HTMLElement,
  config: TaskObserverConfig<HTMLElement>
): readonly string[] {
  if (!element.matches('dd')) {
    return [];
  }
  const parent = element.parentElement;
  if (
    !parent ||
    (!parent.matches('dl') && !(parent.matches('div') && parent.parentElement?.matches('dl')))
  ) {
    return [];
  }
  let sibling = element.previousElementSibling;
  let inspected = 0;
  while (sibling?.matches('dd') && inspected < MAX_DEFINITION_SIBLINGS) {
    inspected += 1;
    sibling = sibling.previousElementSibling;
  }
  const terms: string[] = [];
  while (sibling?.matches('dt') && terms.length < 4 && inspected < MAX_DEFINITION_SIBLINGS) {
    inspected += 1;
    if (sibling instanceof HTMLElement) {
      const text = clean(safeText(sibling, config));
      if (text) {
        terms.unshift(text);
      }
    }
    sibling = sibling.previousElementSibling;
  }
  return [...new Set(terms)];
}

function regionOf(
  element: HTMLElement,
  config: TaskObserverConfig<HTMLElement>
): string | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (!node.matches(REGIONS)) {
      continue;
    }
    const label = regionLabel(node, config);
    if (label) {
      return clean(label);
    }
  }
  return undefined;
}

function domPath(element: HTMLElement): string {
  const path: string[] = [element.tagName.toLowerCase()];
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const siblings = Array.from(node.parentElement?.children ?? []).filter(
      other => other.tagName === node.tagName
    );
    path.unshift(`${node.tagName.toLowerCase()}:${siblings.indexOf(node) + 1}`);
  }
  return path.join('/');
}

function stateOf(
  element: HTMLElement,
  sensitive: boolean,
  formNoValidate: boolean = false
): TaskElementState {
  const native = element as HTMLInputElement;
  const hasValue =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLButtonElement &&
      element.hasAttribute('aria-pressed') &&
      /^[a-z0-9_-]{1,48}$/i.test(element.value) &&
      !/^[a-f0-9]{16,}$/i.test(element.value));
  const capped = hasValue && !sensitive ? capFieldValue(native.value) : undefined;
  const checked = element.getAttribute('aria-checked');
  return {
    ...(hasValue
      ? {
          value: sensitive
            ? native.value === ''
              ? ''
              : TASK_REDACTED
            : clean(capped?.value ?? '', TASK_LIMITS.valueChars),
          ...(!sensitive ? { valueTruncated: capped?.truncated ?? false } : {}),
        }
      : {}),
    ...(element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
      ? { checked: element.indeterminate ? ('mixed' as const) : element.checked }
      : checked !== null
        ? { checked: checked === 'mixed' ? ('mixed' as const) : checked === 'true' }
        : {}),
    ...(element.hasAttribute('aria-selected')
      ? { selected: element.getAttribute('aria-selected') === 'true' }
      : {}),
    ...(element.hasAttribute('aria-expanded')
      ? { expanded: element.getAttribute('aria-expanded') === 'true' }
      : {}),
    ...(element.hasAttribute('aria-pressed')
      ? { pressed: element.getAttribute('aria-pressed') === 'true' }
      : {}),
    disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
    readOnly: native.readOnly === true || element.getAttribute('aria-readonly') === 'true',
    required: native.required === true || element.getAttribute('aria-required') === 'true',
    invalid:
      (native.validity?.valid === false && !formNoValidate) ||
      element.getAttribute('aria-invalid') === 'true',
    constraintInvalid: native.validity?.valid === false && !formNoValidate,
    focused: document.activeElement === element,
  };
}

function formTarget(
  element: HTMLElement,
  form: HTMLFormElement | null
): TaskFormTarget | undefined {
  if (!form) {
    return undefined;
  }
  const action = element.getAttribute('formaction');
  return {
    action: action === null ? form.action : new URL(action, document.baseURI).href,
    method: (element.getAttribute('formmethod') ?? form.method ?? 'get').toUpperCase(),
  };
}

function hintsOf(element: HTMLElement, submit: boolean, implicit: boolean): TaskCommitHint[] {
  const hints: TaskCommitHint[] = [];
  if (submit) {
    hints.push({ class: 'FORM_SUBMIT', basis: 'submit_control' });
  }
  if (implicit) {
    hints.push({ class: 'FORM_SUBMIT', basis: 'implicit_submit_field' });
  }
  const markers = {
    purchase: 'PURCHASE',
    delete: 'DELETE',
    publish: 'PUBLISH',
    send: 'SEND',
    account_change: 'ACCOUNT_CHANGE',
    other: 'OTHER_COMMITMENT',
  } as const;
  const marker = element.getAttribute('data-kriya-commit') ?? '';
  if (Object.prototype.hasOwnProperty.call(markers, marker)) {
    hints.push({ class: markers[marker as keyof typeof markers], basis: 'declared_marker' });
  }
  return hints;
}

function canonicalHints(...groups: readonly (readonly TaskCommitHint[])[]): TaskCommitHint[] {
  const unique = new Map<string, TaskCommitHint>();
  for (const hint of groups.flat()) {
    unique.set(`${hint.class}:${hint.basis}`, hint);
  }
  return [...unique.values()].sort((left, right) => {
    const classOrder =
      TASK_COMMITMENT_CLASSES.indexOf(left.class) - TASK_COMMITMENT_CLASSES.indexOf(right.class);
    return classOrder || (left.basis < right.basis ? -1 : left.basis > right.basis ? 1 : 0);
  });
}

function describe(element: HTMLElement, id: string, context: Context): Description | undefined {
  if (hidden(element) || element.matches('[contenteditable],select[multiple]')) {
    return undefined;
  }
  const control = boundControlOf(element);
  const kind = kindOf(control);
  if (!kind) {
    return undefined;
  }
  const controlId = context.controlId(control);
  if (
    element instanceof HTMLAnchorElement &&
    (element.hasAttribute('download') || !['', '_self'].includes(element.target.toLowerCase()))
  ) {
    return undefined;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return undefined;
  }
  const inViewport =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;
  if (!inViewport && !context.options?.includeOffscreen) {
    return undefined;
  }
  const modal = Array.from(
    document.querySelectorAll<HTMLElement>('dialog[open],[role=dialog][aria-modal=true]')
  ).find(node => !hidden(node));
  if (modal && !modal.contains(element)) {
    return undefined;
  }
  const hit =
    inViewport && typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : null;
  if (
    hit &&
    !element.contains(hit) &&
    !hit.contains(element) &&
    hit.closest('dialog[open],[role=dialog][aria-modal=true]')
  ) {
    return undefined;
  }
  const sensitive =
    isSensitiveElement(control, context.config) || isSensitiveElement(element, context.config);
  const label = accessibleName(control, context.config);
  const text = sensitive
    ? undefined
    : clean(safeText(element, context.config), TASK_LIMITS.passageChars);
  const form = formOf(control);
  const groupId = kind === 'radio' ? radioGroupOf(control, context) : undefined;
  const implicit = control instanceof HTMLInputElement && canImplicitlySubmit(control);
  const submitter = form && implicit ? (defaultSubmitterOf(form) ?? control) : control;
  const formNoValidate = form
    ? form.noValidate ||
      ((submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
        submitter.formNoValidate)
    : undefined;
  const state = stateOf(control, sensitive, formNoValidate);
  const inputType = control instanceof HTMLInputElement ? control.type : undefined;
  const submit =
    !!form &&
    (control instanceof HTMLButtonElement
      ? control.type === 'submit'
      : control instanceof HTMLInputElement && ['submit', 'image'].includes(control.type));
  const commitHints = canonicalHints(
    hintsOf(control, submit, implicit),
    control === element ? [] : hintsOf(element, false, false)
  );
  const rawTarget = submit || implicit ? formTarget(submitter, form) : undefined;
  const rawHref = element instanceof HTMLAnchorElement ? element.href : undefined;
  const region = regionOf(element, context.config);
  const role = element.getAttribute('role') ?? kind;
  const formOrdinal = form ? Array.from(document.forms).indexOf(form) + 1 : 0;
  const choiceValue =
    control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)
      ? control.value
      : control.hasAttribute('aria-pressed')
        ? control.getAttribute('value')
        : undefined;
  const optionGroups =
    element instanceof HTMLSelectElement
      ? Array.from(element.options).map(option =>
          option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : null
        )
      : undefined;
  const terms = definitionTerms(element, context.config);
  const signature = `sg_${sha256Hex(stableStringify({ role, kind, accessibleName: label, inputType, formOrdinal, tag: element.tagName.toLowerCase(), domPathOrdinal: domPath(element), region, securityIdentity: { href: rawHref, inputName: control.getAttribute('name'), autocomplete: control.getAttribute('autocomplete'), value: choiceValue, optionGroups, definitionTerms: terms, formAction: form?.action, formMethod: form?.method.toUpperCase(), formNoValidate, formTarget: rawTarget, commitHints } })).slice(0, 16)}`;
  const scroll = elementScroll(element);
  const operations: TaskHostOperation[] = [];
  if (!state.disabled) {
    if (submit) {
      operations.push('SUBMIT');
    } else if (kind === 'link' && rawHref) {
      operations.push('NAVIGATE');
    } else if (['button', 'tab', 'menuitem', 'combobox'].includes(kind)) {
      operations.push('CLICK');
    } else if (
      ['checkbox', 'radio', 'switch'].includes(kind) &&
      (control instanceof HTMLInputElement || control.hasAttribute('aria-checked'))
    ) {
      operations.push('SET_CHECKED');
    } else if (
      ((element instanceof HTMLInputElement && TEXT_TYPES.has(element.type)) ||
        element instanceof HTMLTextAreaElement) &&
      !state.readOnly
    ) {
      operations.push('FILL', 'PRESS');
    } else if (
      element instanceof HTMLSelectElement ||
      (kind === 'option' && element.closest('[role=listbox]'))
    ) {
      operations.push('SELECT');
    }
    if (scroll) {
      operations.push('SCROLL');
    }
  }
  const dialog = element.closest<HTMLElement>('dialog,[role=dialog]');
  const landmark = element.closest('header,main,footer,nav,aside')?.tagName.toLowerCase();
  const contexts: string[] = [...terms];
  for (
    let parent = element.parentElement;
    parent && contexts.length < 4;
    parent = parent.parentElement
  ) {
    if (!parent.matches(REGIONS)) {
      continue;
    }
    const contextLabel = regionLabel(parent, context.config);
    if (contextLabel && !contexts.includes(contextLabel)) {
      contexts.push(clean(contextLabel));
    }
  }
  const entry: TaskElement = {
    id,
    controlId,
    signature,
    role,
    kind,
    label,
    state,
    ...(landmark ? { landmark } : {}),
    ...(contexts.length ? { contexts } : {}),
    sensitive,
    inViewport,
    operations,
    ...(text ? { text } : {}),
    ...(inputType ? { inputType } : {}),
    ...(control.getAttribute('name')
      ? { inputName: clean(control.getAttribute('name') ?? '', TASK_LIMITS.labelChars) }
      : {}),
    ...(control.getAttribute('autocomplete')
      ? { autocomplete: clean(control.getAttribute('autocomplete') ?? '', TASK_LIMITS.labelChars) }
      : {}),
    ...(rawHref ? { href: context.redactUrl(rawHref) } : {}),
    ...(form ? { formId: context.formId(form) } : {}),
    ...(formNoValidate !== undefined ? { formNoValidate } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(rawTarget
      ? { formTarget: { ...rawTarget, action: context.redactUrl(rawTarget.action) } }
      : {}),
    ...(region ? { region } : {}),
    ...(dialog ? { dialogId: context.dialogId(dialog) } : {}),
    ...(commitHints.length ? { commitHints } : {}),
    ...(scroll ? { scroll } : {}),
    ...(element instanceof HTMLSelectElement
      ? {
          options: Array.from(element.options)
            .slice(0, TASK_LIMITS.optionsPerElement)
            .map((option, index) => ({
              id: `${id}.${index + 1}`,
              label: sensitive ? TASK_REDACTED : clean(option.label),
              ...(!sensitive
                ? { value: clean(capFieldValue(option.value).value, TASK_LIMITS.valueChars) }
                : {}),
              ...(!sensitive &&
              option.parentElement instanceof HTMLOptGroupElement &&
              !isSensitiveElement(option.parentElement, context.config) &&
              clean(option.parentElement.label)
                ? { groupLabel: clean(option.parentElement.label) }
                : {}),
              selected: option.selected,
              disabled:
                option.disabled ||
                (option.parentElement instanceof HTMLOptGroupElement &&
                  option.parentElement.disabled),
            })),
        }
      : {}),
  };
  const summary = entry;
  if (context.config.allowElement?.(element, summary) === false) {
    return undefined;
  }
  const reading =
    !sensitive &&
    !!text &&
    (context.config.allowReading
      ? context.config.allowReading(element, summary)
      : !(kind === 'passage' && element.closest('nav,[role=navigation]')));
  if (reading) {
    operations.push('READ');
  }
  if (
    operations.includes('NAVIGATE') &&
    context.config.allowNavigation?.(element, summary) === false
  ) {
    operations.splice(operations.indexOf('NAVIGATE'), 1);
  }
  const security = stableStringify({
    controlId,
    operations,
    href: rawHref,
    formTarget: rawTarget,
    commitHints,
    sensitive,
    disabled: state.disabled,
    inputType,
    formAction: form?.action,
    groupId: entry.groupId,
    labelControl:
      control !== element
        ? domPath(control) + (control.id || control.getAttribute('name') || '')
        : undefined,
  });
  return { element, entry, security };
}

function settle(options: TaskSettleOptions, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => restartQuiet());
    const finish = (): void => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      document.removeEventListener('DOMContentLoaded', ready);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const restartQuiet = (): void => {
      if (document.readyState === 'loading') {
        return;
      }
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, Math.max(0, options.quietMs));
    };
    const ready = (): void => restartQuiet();
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    document.addEventListener('DOMContentLoaded', ready);
    signal?.addEventListener('abort', finish, { once: true });
    const maxTimer = setTimeout(finish, Math.max(0, options.maxMs));
    restartQuiet();
  });
}

function collectDescriptions(context: Context): Description[] {
  const results: Description[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    try {
      const description = describe(element, `t${results.length + 1}`, context);
      if (description) {
        results.push(description);
      }
    } catch {
      /* An inaccessible page node is not an executable target. */
    }
  }
  const twins = new Map<string, Description[]>();
  for (const item of results) {
    const group = twins.get(item.entry.signature) ?? [];
    group.push(item);
    twins.set(item.entry.signature, group);
  }
  return results.map(item => {
    const group = twins.get(item.entry.signature) ?? [];
    return group.length <= 1
      ? item
      : {
          ...item,
          entry: {
            ...item.entry,
            signature: `${item.entry.signature}.${group.indexOf(item) + 1}`,
            twins: group.length,
          },
        };
  });
}

function fingerprint(observation: Omit<TaskObservation, 'fingerprint'>): string {
  return hashString(
    stableStringify({
      url: observation.url,
      title: observation.title,
      text: hashString(observation.text),
      elements: observation.elements.map(element => ({
        signature: element.signature,
        value: element.state.value,
        checked: element.state.checked,
        selected:
          element.state.selected ??
          element.options?.filter(option => option.selected).map(option => option.id),
        disabled: element.state.disabled,
        expanded: element.state.expanded,
        inViewport: element.inViewport,
        scroll: element.scroll?.top,
      })),
      notices: observation.notices,
      validation: observation.validation,
      dialogs: observation.dialogs,
      scrollTop: observation.page.scroll.top,
    })
  );
}

function bounded(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function createTaskObserver(
  config: TaskObserverConfig<HTMLElement> = {}
): TaskObserver<HTMLElement> {
  const redactor = createRedactor();
  let idCounter = 0;
  const createId: TaskIdFactory =
    config.createId ??
    (prefix => {
      idCounter += 1;
      const bytes = new Uint8Array(12);
      if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
      }
      return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}${idCounter.toString(16)}`;
    });
  const documentId = config.documentId ?? createId('doc');
  const sessions = new Map<string, Session>();
  const formIds = new WeakMap<HTMLFormElement, string>();
  const dialogIds = new WeakMap<HTMLElement, string>();
  const radioGroupIds = new WeakMap<HTMLElement, string>();
  const controlIds = new WeakMap<HTMLElement, string>();
  let formCounter = 0;
  let dialogCounter = 0;
  let radioGroupCounter = 0;
  let controlCounter = 0;
  let sequence = 0;
  let disposed = false;
  const formId = (form: HTMLFormElement): string => {
    let id = formIds.get(form);
    if (!id) {
      formCounter += 1;
      id = `f${formCounter}`;
      formIds.set(form, id);
    }
    return id;
  };
  const dialogId = (dialog: HTMLElement): string => {
    let id = dialogIds.get(dialog);
    if (!id) {
      dialogCounter += 1;
      id = `d${dialogCounter}`;
      dialogIds.set(dialog, id);
    }
    return id;
  };
  const radioGroupId = (group: HTMLElement): string => {
    let id = radioGroupIds.get(group);
    if (!id) {
      radioGroupCounter += 1;
      id = `g${radioGroupCounter}`;
      radioGroupIds.set(group, id);
    }
    return id;
  };
  const controlId = (control: HTMLElement): string => {
    let id = controlIds.get(control);
    if (!id) {
      controlCounter += 1;
      id = `ctl_${controlCounter}`;
      controlIds.set(control, id);
    }
    return id;
  };
  const contextFor = (options: TaskObserveRequest['options']): Context => ({
    config,
    formId,
    dialogId,
    radioGroupId,
    controlId,
    options,
    redactUrl: redactor.redactUrl,
  });

  const observe = async (
    request: TaskObserveRequest,
    signal?: AbortSignal
  ): Promise<TaskObservation> => {
    await settle(request.options?.settle ?? config.settle ?? TASK_DEFAULT_SETTLE, signal);
    const context = contextFor(request.options);
    const descriptions = disposed || signal?.aborted ? [] : collectDescriptions(context);
    const maxElements = Math.min(
      bounded(request.options?.maxElements, TASK_LIMITS.observedElements),
      bounded(config.maxElements, TASK_LIMITS.observedElements)
    );
    const kept = descriptions.slice(0, maxElements);
    const elements = kept.map(item => item.entry);
    const snapshotId = createId('snap');
    sequence = Math.max(sequence + 1, bounded(request.minSequence, 0) + 1);
    const all = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(
      element => element instanceof HTMLElement
    );
    const pageScroll = document.scrollingElement ?? document.documentElement;
    const notices = all
      .filter(
        element =>
          ['alert', 'status', 'log', 'banner'].includes(element.getAttribute('role') ?? '') &&
          !hidden(element) &&
          !isSensitiveElement(element, config)
      )
      .map(element => ({
        kind: element.getAttribute('role') as 'alert' | 'status' | 'log' | 'banner',
        text: clean(safeText(element, config), TASK_LIMITS.passageChars),
        ...(kept.find(item => item.element === element)
          ? { targetId: kept.find(item => item.element === element)?.entry.id }
          : {}),
      }));
    const dialogs: TaskDialog[] = all
      .filter(element => element.matches('dialog[open],[role=dialog]') && !hidden(element))
      .map(element => ({
        id: dialogId(element),
        modal:
          element.getAttribute('aria-modal') === 'true' ||
          (element instanceof HTMLDialogElement && element.open),
        label: accessibleName(element, config),
        elementIds: kept.filter(item => element.contains(item.element)).map(item => item.entry.id),
      }));
    const fullText =
      request.options?.includeText === false || !document.body
        ? ''
        : clean(safeText(document.body, config), Number.POSITIVE_INFINITY);
    const text = clean(fullText, TASK_LIMITS.observedTextChars);
    const observation: Omit<TaskObservation, 'fingerprint'> = {
      sessionId: request.sessionId,
      snapshotId,
      documentId,
      sequence,
      observedAt: (config.clock ?? Date.now)(),
      url: redactor.redactUrl(window.location.href),
      origin: window.location.origin,
      title: clean(document.title),
      text,
      page: {
        readyState: document.readyState,
        busy: all.some(element => element.getAttribute('aria-busy') === 'true'),
        scroll: scrollState(
          pageScroll.scrollTop || window.scrollY,
          pageScroll.scrollHeight - window.innerHeight
        ),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
      elements,
      forms: Array.from(document.forms).map(form => {
        const members = kept.filter(item => formOf(boundControlOf(item.element)) === form);
        return {
          id: formId(form),
          name: clean(labelText(form) || form.name),
          method: form.method.toUpperCase(),
          action: redactor.redactUrl(form.action),
          fieldIds: members
            .filter(item =>
              ['text_input', 'textarea', 'select', 'checkbox', 'radio', 'switch'].includes(
                item.entry.kind
              )
            )
            .map(item => item.entry.id),
          submitterIds: members
            .filter(item => item.entry.operations.includes('SUBMIT'))
            .map(item => item.entry.id),
          invalidFieldIds: members
            .filter(item => item.entry.state.invalid)
            .map(item => item.entry.id),
          implicitSubmit: members.some(item =>
            item.entry.commitHints?.some(hint => hint.basis === 'implicit_submit_field')
          ),
        };
      }),
      notices,
      dialogs,
      validation: kept.flatMap(item => validationOf(item, config)),
      truncation: {
        elementsDropped: descriptions.length - kept.length,
        optionsDropped: kept.reduce(
          (count, item) =>
            count +
            (item.element instanceof HTMLSelectElement
              ? Math.max(0, item.element.options.length - TASK_LIMITS.optionsPerElement)
              : 0),
          0
        ),
        textTruncated: text !== fullText,
      },
      unobserved: {
        iframes: all.filter(element => element.matches('iframe')).length,
        shadowRoots: all.filter(element => element.shadowRoot !== null).length,
        canvases: all.filter(element => element.matches('canvas')).length,
        contentEditable: all.filter(element =>
          element.matches('[contenteditable]:not([contenteditable=false])')
        ).length,
        multiSelects: all.filter(element => element.matches('select[multiple]')).length,
        externalTargets: all.filter(
          element =>
            element instanceof HTMLAnchorElement &&
            element.hasAttribute('href') &&
            (element.hasAttribute('download') ||
              !['', '_self'].includes(element.target.toLowerCase()))
        ).length,
      },
    };
    if (!disposed && !signal?.aborted) {
      sessions.set(request.sessionId, {
        sequence,
        snapshot: {
          id: snapshotId,
          url: window.location.href,
          options: request.options,
          targets: new Map(kept.map(item => [item.entry.id, item])),
        },
      });
      const maxSessions = Math.max(1, bounded(config.maxSessions, 4));
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (oldest === undefined) {
          break;
        }
        sessions.delete(oldest);
      }
    }
    return { ...observation, fingerprint: fingerprint(observation) };
  };

  const resolve = (ref: TaskTargetRef): TaskTargetResolution<HTMLElement> => {
    const session = sessions.get(ref.sessionId);
    if (!session) {
      return { ok: false, reason: 'session_released' };
    }
    if (session.snapshot.id !== ref.snapshotId) {
      return { ok: false, reason: 'superseded_snapshot' };
    }
    if (session.snapshot.url !== window.location.href) {
      return { ok: false, reason: 'url_changed' };
    }
    const stored = session.snapshot.targets.get(ref.targetId);
    if (!stored) {
      return { ok: false, reason: 'element_missing' };
    }
    if (!stored.element.isConnected) {
      return { ok: false, reason: 'element_detached' };
    }
    try {
      const current = describe(stored.element, ref.targetId, contextFor(session.snapshot.options));
      if (!current) {
        return { ok: false, reason: 'element_missing' };
      }
      if (current.security !== stored.security) {
        return { ok: false, reason: 'structure_changed' };
      }
      if (
        ref.signature !== stored.entry.signature ||
        current.entry.signature !== stored.entry.signature.split('.')[0]
      ) {
        return { ok: false, reason: 'signature_changed' };
      }
      return { ok: true, element: stored.element, entry: stored.entry };
    } catch {
      return { ok: false, reason: 'element_missing' };
    }
  };
  return {
    documentId,
    observe,
    resolve,
    latestSnapshotId: sessionId => sessions.get(sessionId)?.snapshot.id,
    release: sessionId => {
      sessions.delete(sessionId);
    },
    dispose: () => {
      disposed = true;
      sessions.clear();
    },
  };
}
