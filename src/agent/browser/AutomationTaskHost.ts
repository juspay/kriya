import {
  TASK_BRIDGE_PROTOCOL,
  TASK_DEFAULT_SETTLE,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_LIMITS,
  TASK_REDACTED,
  TASK_SCROLL_DIRECTIONS,
  TASK_WAIT_DURATIONS_MS,
  isTaskHostOperation,
} from '@/types';
import type {
  ActionOutcome,
  AutomationTaskHostConfig,
  ErrorCode,
  ExecutionResult,
  Redactor,
  TaskCommandRequest,
  TaskElement,
  TaskExecutionOutcome,
  TaskHost,
  TaskHostCapabilities,
  TaskHostCommand,
  TaskHostOperation,
  TaskObserver,
  TaskObservation,
  TaskHostErrorCode,
  TaskHostResult,
  TaskNavigationInfo,
  TaskObserveRequest,
  TaskOutcomeCode,
  TaskOutcomeFields,
  TaskReadback,
  TaskSettleOptions,
  TaskStaleReason,
} from '@/types';
import { toActionCommand } from '@/agent/commands';
import { createRedactor } from '@/utils/redact';
import { sha256Hex, stableStringify } from '@/utils/hash';
import { sanitizeUntrustedText } from '@/utils/sanitize';
import { capFieldValue } from '@/utils/value';
import { createTaskObserver, isSensitiveElement } from './observe';

type Call = {
  readonly request: TaskCommandRequest;
  readonly startedAt: number;
  readonly clock: () => number;
  readonly redactor: Redactor;
};
type Prepared =
  | {
      readonly ok: true;
      readonly element?: HTMLElement;
      readonly entry?: TaskElement;
      readonly optionIndex?: number;
    }
  | { readonly ok: false; readonly outcome: TaskExecutionOutcome };

const INVALID_CODES: readonly ErrorCode[] = [
  'TARGET_AMBIGUOUS',
  'TARGET_DISABLED',
  'TARGET_OBSCURED',
  'NOT_EDITABLE',
  'NOT_CHECKABLE',
  'OPTION_NOT_FOUND',
  'OPTION_AMBIGUOUS',
  'OPTION_DISABLED',
  'UNSUPPORTED_STATE',
  'VALIDATION_FAILED',
  'INVALID_ACTION',
  'ELEMENT_NOT_FOUND',
];

function fields(call: Call, additions: Partial<TaskOutcomeFields> = {}): TaskOutcomeFields {
  return {
    requestId: call.request?.requestId ?? '',
    durationMs: Math.max(0, call.clock() - call.startedAt),
    ...additions,
    ...(additions.message === undefined ? {} : { message: call.redactor.scrub(additions.message) }),
  };
}
function reject(
  call: Call,
  status: 'rejected_invalid' | 'rejected_scope' | 'rejected_stale' | 'failed',
  code: TaskOutcomeCode,
  message: string,
  staleReason?: TaskStaleReason
): TaskExecutionOutcome {
  return {
    ...fields(call, { code, message, ...(staleReason ? { staleReason } : {}) }),
    status,
    effect: 'none',
  };
}
function error<T>(code: TaskHostErrorCode, message: string, retryable = false): TaskHostResult<T> {
  return { ok: false, error: { code, message, retryable } };
}
function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : 'The host could not complete the operation.';
}
function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
function origins(values: readonly string[]): string[] {
  return values.flatMap(value => {
    const origin = originOf(value);
    return origin ? [origin] : [];
  });
}
function boundControl(element: HTMLElement): HTMLElement {
  return element instanceof HTMLLabelElement && element.control instanceof HTMLElement
    ? element.control
    : element;
}
function formOf(element: HTMLElement): HTMLFormElement | null {
  const control = boundControl(element);
  return 'form' in control ? (control as HTMLInputElement).form : control.closest('form');
}
function inScope(
  element: HTMLElement | undefined,
  entry: TaskElement | undefined,
  allowed: readonly string[]
): boolean {
  const urls = [window.location.href];
  if (element instanceof HTMLAnchorElement) {
    urls.push(element.href);
  }
  const form = element ? formOf(element) : null;
  if (form) {
    urls.push(form.action);
  }
  if (entry?.formTarget && element && form) {
    const override = element.getAttribute('formaction');
    urls.push(override === null ? form.action : new URL(override, document.baseURI).href);
  }
  return urls.every(url => {
    const origin = originOf(url);
    return origin !== undefined && allowed.includes(origin);
  });
}
function validArguments(command: TaskHostCommand): boolean {
  switch (command.operation) {
    case 'FILL':
      return typeof command.value === 'string' && typeof command.sensitive === 'boolean';
    case 'SET_CHECKED':
      return typeof command.checked === 'boolean';
    case 'PRESS':
      return TASK_KEYS.includes(command.key);
    case 'SCROLL':
      return TASK_SCROLL_DIRECTIONS.includes(command.direction);
    case 'WAIT':
      return TASK_WAIT_DURATIONS_MS.includes(
        command.durationMs as (typeof TASK_WAIT_DURATIONS_MS)[number]
      );
    case 'SELECT':
      return command.optionId === undefined || typeof command.optionId === 'string';
    default:
      return true;
  }
}
function optionFingerprint(option: HTMLOptionElement): string {
  return sha256Hex(stableStringify({ label: option.label, value: option.value }));
}

function optionIndex(
  element: HTMLElement,
  entry: TaskElement,
  command: TaskHostCommand,
  expectedHash?: string
): number | undefined {
  if (command.operation !== 'SELECT' || !(element instanceof HTMLSelectElement)) {
    return undefined;
  }
  const offered = entry.options?.find(option => option.id === command.optionId);
  if (!offered) {
    return undefined;
  }
  const index = Number(offered.id.slice(entry.id.length + 1)) - 1;
  const live = element.options[index];
  if (
    !live ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    expectedHash === undefined ||
    optionFingerprint(live) !== expectedHash
  ) {
    return undefined;
  }
  const label = entry.sensitive
    ? TASK_REDACTED
    : sanitizeUntrustedText(live.label, TASK_LIMITS.labelChars);
  const value = entry.sensitive
    ? undefined
    : sanitizeUntrustedText(capFieldValue(live.value).value, TASK_LIMITS.valueChars);
  const disabled =
    live.disabled ||
    (live.parentElement instanceof HTMLOptGroupElement && live.parentElement.disabled);
  return label === offered.label && value === offered.value && disabled === offered.disabled
    ? index
    : undefined;
}

function visibleText(element: HTMLElement, config: AutomationTaskHostConfig<HTMLElement>): string {
  if (
    isSensitiveElement(element, config.observer) ||
    element.matches(
      'input,textarea,select,script,style,noscript,template,iframe,canvas,[contenteditable]'
    )
  ) {
    return '';
  }
  if (element.closest('[hidden],[inert],[aria-hidden=true]')) {
    return '';
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return '';
  }
  return Array.from(element.childNodes)
    .map(node =>
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? '')
        : node instanceof HTMLElement
          ? visibleText(node, config)
          : ''
    )
    .join(' ');
}

function settle(options: TaskSettleOptions, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => restart());
    const finish = (): void => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const restart = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, options.quietMs);
    };
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    signal?.addEventListener('abort', finish, { once: true });
    const maxTimer = setTimeout(finish, options.maxMs);
    restart();
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function checked(value: unknown): value is boolean | 'mixed' {
  return typeof value === 'boolean' || value === 'mixed';
}
function submission(
  value: unknown
): { event: boolean; invalidControls: number; defaultPrevented: boolean } | undefined {
  const raw = record(value);
  return raw &&
    typeof raw.event === 'boolean' &&
    numeric(raw.invalidControls) &&
    typeof raw.defaultPrevented === 'boolean'
    ? {
        event: raw.event,
        invalidControls: raw.invalidControls,
        defaultPrevented: raw.defaultPrevented,
      }
    : undefined;
}
function readbackOf(data: unknown, call: Call, sensitive: boolean): ActionOutcome | undefined {
  const raw = record(data);
  if (!raw) {
    return undefined;
  }
  const submit = submission(raw.submit);
  const submitPart = submit ? { submit } : {};
  switch (raw.kind) {
    case 'click':
      return typeof raw.defaultPrevented === 'boolean'
        ? { kind: 'click', defaultPrevented: raw.defaultPrevented, ...submitPart }
        : undefined;
    case 'fill':
      return typeof raw.tag === 'string' &&
        typeof raw.inputType === 'string' &&
        typeof raw.changed === 'boolean' &&
        typeof raw.matched === 'boolean'
        ? {
            kind: 'fill',
            tag: call.redactor.scrub(raw.tag),
            inputType: call.redactor.scrub(raw.inputType),
            changed: raw.changed,
            matched: raw.matched,
            ...(!sensitive && numeric(raw.length) ? { length: raw.length } : {}),
            ...(typeof raw.empty === 'boolean' ? { empty: raw.empty } : {}),
          }
        : undefined;
    case 'select':
      return (raw.control === 'native' || raw.control === 'aria') &&
        numeric(raw.index) &&
        typeof raw.changed === 'boolean' &&
        (typeof raw.matched === 'boolean' || raw.matched === null)
        ? {
            kind: 'select',
            control: raw.control,
            index: raw.index,
            changed: raw.changed,
            matched: raw.matched,
          }
        : undefined;
    case 'setChecked':
      return (raw.control === 'native' || raw.control === 'aria') &&
        checked(raw.before) &&
        checked(raw.after) &&
        typeof raw.changed === 'boolean' &&
        typeof raw.matched === 'boolean'
        ? {
            kind: 'setChecked',
            control: raw.control,
            before: raw.before,
            after: raw.after,
            changed: raw.changed,
            matched: raw.matched,
          }
        : undefined;
    case 'scroll':
      return numeric(raw.before) &&
        numeric(raw.after) &&
        numeric(raw.max) &&
        typeof raw.moved === 'boolean' &&
        typeof raw.atTop === 'boolean' &&
        typeof raw.atBottom === 'boolean'
        ? {
            kind: 'scroll',
            before: raw.before,
            after: raw.after,
            max: raw.max,
            moved: raw.moved,
            atTop: raw.atTop,
            atBottom: raw.atBottom,
            ...(raw.reason === 'edge' || raw.reason === 'blocked' ? { reason: raw.reason } : {}),
          }
        : undefined;
    case 'press':
      return typeof raw.defaultPrevented === 'boolean' &&
        (raw.defaultAction === 'implicit_submit' ||
          raw.defaultAction === 'activate' ||
          raw.defaultAction === 'none')
        ? {
            kind: 'press',
            defaultPrevented: raw.defaultPrevented,
            defaultAction: raw.defaultAction,
            ...submitPart,
          }
        : undefined;
    case 'wait':
      return numeric(raw.waitedMs) ? { kind: 'wait', waitedMs: raw.waitedMs } : undefined;
    default:
      return undefined;
  }
}

function currentReadback(
  data: ActionOutcome | undefined,
  command: TaskHostCommand,
  element: HTMLElement | undefined,
  sensitive: boolean
): ActionOutcome | undefined {
  if (!data || !element || !element.isConnected) {
    return data;
  }
  const control = boundControl(element);
  if (
    data.kind === 'fill' &&
    command.operation === 'FILL' &&
    (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)
  ) {
    return {
      ...data,
      empty: control.value === '',
      matched: control.value === command.value,
      ...(!sensitive ? { length: control.value.length } : {}),
    };
  }
  if (data.kind === 'setChecked' && command.operation === 'SET_CHECKED') {
    const state =
      control instanceof HTMLInputElement
        ? control.indeterminate
          ? 'mixed'
          : control.checked
        : control.getAttribute('aria-checked') === 'mixed'
          ? 'mixed'
          : control.getAttribute('aria-checked') === 'true';
    return { ...data, after: state, matched: state === command.checked };
  }
  if (data.kind === 'select' && command.operation === 'SELECT') {
    return control instanceof HTMLSelectElement
      ? {
          ...data,
          matched:
            control.selectedIndex === data.index && control.options[data.index]?.selected === true,
        }
      : {
          ...data,
          matched:
            control.getAttribute('aria-selected') === 'true' ||
            control.getAttribute('aria-checked') === 'true'
              ? true
              : data.matched,
        };
  }
  return data;
}

function mapResult(
  result: ExecutionResult,
  data: TaskReadback | undefined,
  navigation: TaskNavigationInfo | undefined,
  call: Call
): TaskExecutionOutcome {
  const common = fields(call, {
    ...(data ? { readback: data } : {}),
    ...(navigation ? { navigation } : {}),
    ...(result.error ? { message: result.error } : {}),
  });
  const readonly =
    call.request.command.operation === 'READ' || call.request.command.operation === 'WAIT';
  if (!result.success) {
    const code = result.errorCode ?? 'EXECUTION_FAILED';
    if (code === 'TARGET_STALE' && result.effect !== 'applied' && result.effect !== 'uncertain') {
      return {
        ...common,
        status: 'rejected_stale',
        effect: 'none',
        code,
        staleReason: 'element_missing',
      };
    }
    if (result.effect === 'none' || readonly) {
      return {
        ...common,
        status: INVALID_CODES.includes(code) ? 'rejected_invalid' : 'failed',
        effect: 'none',
        code,
      };
    }
    return { ...common, status: 'uncertain', effect: 'uncertain', code };
  }
  if (data && 'matched' in data && data.matched === false) {
    return { ...common, status: 'failed', effect: 'applied', code: 'READBACK_MISMATCH' };
  }
  if (data && 'changed' in data && data.changed === false && data.matched === true) {
    return { ...common, status: 'noop_already_satisfied', effect: 'none' };
  }
  if (data?.kind === 'scroll' && !data.moved) {
    return data.reason === 'edge'
      ? { ...common, status: 'noop_already_satisfied', effect: 'none' }
      : { ...common, status: 'failed', effect: 'none', code: 'UNSUPPORTED_STATE' };
  }
  if (
    data?.kind === 'click' &&
    data.submit &&
    !data.submit.event &&
    data.submit.invalidControls > 0
  ) {
    return { ...common, status: 'failed', effect: 'applied', code: 'VALIDATION_FAILED' };
  }
  if (navigation) {
    return {
      ...common,
      status: 'navigated',
      effect: result.effect === 'applied' || result.effect === undefined ? 'applied' : 'uncertain',
    };
  }
  if (result.effect === 'uncertain' && !readonly) {
    return {
      ...common,
      status: 'uncertain',
      effect: 'uncertain',
      code: result.errorCode ?? 'EXECUTION_FAILED',
    };
  }
  return {
    ...common,
    status: 'applied',
    effect: readonly ? 'none' : result.effect === 'none' ? 'none' : 'applied',
  };
}

function scrubObservation(observation: TaskObservation, redactor: Redactor): TaskObservation {
  const text = (value: string): string => redactor.scrub(value);
  return {
    ...observation,
    url: redactor.redactUrl(observation.url),
    title: text(observation.title),
    text: text(observation.text),
    elements: observation.elements.map(entry => ({
      ...entry,
      label: text(entry.label),
      ...(entry.description !== undefined ? { description: text(entry.description) } : {}),
      ...(entry.text !== undefined ? { text: text(entry.text) } : {}),
      ...(entry.region !== undefined ? { region: text(entry.region) } : {}),
      state: {
        ...entry.state,
        ...(entry.state.value !== undefined ? { value: text(entry.state.value) } : {}),
      },
      ...(entry.href !== undefined ? { href: redactor.redactUrl(entry.href) } : {}),
      ...(entry.formTarget
        ? {
            formTarget: {
              ...entry.formTarget,
              action: redactor.redactUrl(entry.formTarget.action),
            },
          }
        : {}),
      ...(entry.options
        ? {
            options: entry.options.map(option => ({
              ...option,
              label: text(option.label),
              ...(option.value !== undefined ? { value: text(option.value) } : {}),
            })),
          }
        : {}),
    })),
    forms: observation.forms.map(form => ({
      ...form,
      ...(form.name !== undefined ? { name: text(form.name) } : {}),
      ...(form.action !== undefined ? { action: redactor.redactUrl(form.action) } : {}),
    })),
    notices: observation.notices.map(notice => ({ ...notice, text: text(notice.text) })),
    validation: observation.validation.map(message => ({ ...message, text: text(message.text) })),
    dialogs: observation.dialogs.map(dialog => ({ ...dialog, label: text(dialog.label) })),
  };
}

function prepare(context: {
  readonly call: Call;
  readonly observer: TaskObserver<HTMLElement>;
  readonly operations: readonly TaskHostOperation[];
  readonly config: AutomationTaskHostConfig<HTMLElement>;
  readonly optionHashes: ReadonlyMap<string, string> | undefined;
}): Prepared {
  const { call, observer, operations, config } = context;
  const { request } = call;
  const command = request.command;
  if (!command || typeof command !== 'object' || !isTaskHostOperation(command.operation)) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_invalid',
        'VALIDATION_FAILED',
        'The command operation is invalid.'
      ),
    };
  }
  if (!request.scope || request.scope.documentId !== observer.documentId) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_stale',
        'TARGET_STALE',
        'The command belongs to another document.',
        'document_changed'
      ),
    };
  }
  const target = 'target' in command ? command.target : undefined;
  if (
    target &&
    (target.sessionId !== request.scope.sessionId || target.snapshotId !== request.scope.snapshotId)
  ) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_invalid',
        'VALIDATION_FAILED',
        'The target scope does not match the command scope.'
      ),
    };
  }
  if (!operations.includes(command.operation)) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_scope',
        'PERMISSION_DENIED',
        'The host does not offer this operation.'
      ),
    };
  }
  if (
    !validArguments(command) ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    !request.settle ||
    !Number.isFinite(request.settle.quietMs) ||
    !Number.isFinite(request.settle.maxMs) ||
    request.settle.quietMs < 0 ||
    request.settle.maxMs < 0
  ) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_invalid',
        'VALIDATION_FAILED',
        'The command arguments or timing limits are invalid.'
      ),
    };
  }
  if (command.operation !== 'SCROLL' && command.operation !== 'WAIT' && !target) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_invalid',
        'VALIDATION_FAILED',
        'This operation needs an observed target.'
      ),
    };
  }
  let element: HTMLElement | undefined;
  let entry: TaskElement | undefined;
  if (target) {
    const resolution = observer.resolve(target);
    if (!resolution.ok) {
      return {
        ok: false,
        outcome: reject(
          call,
          'rejected_stale',
          'TARGET_STALE',
          'The observed target is stale.',
          resolution.reason
        ),
      };
    }
    element = resolution.element;
    entry = resolution.entry;
    if (command.operation === 'READ' && entry.sensitive) {
      return {
        ok: false,
        outcome: reject(
          call,
          'rejected_invalid',
          'VALIDATION_FAILED',
          'Sensitive targets cannot be read.'
        ),
      };
    }
    if (!entry.operations.includes(command.operation)) {
      return {
        ok: false,
        outcome: reject(
          call,
          'rejected_invalid',
          'VALIDATION_FAILED',
          'The target does not offer this operation.'
        ),
      };
    }
  }
  if (!Array.isArray(request.allowedOrigins)) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_invalid',
        'VALIDATION_FAILED',
        'Allowed origins are required.'
      ),
    };
  }
  const requested = origins(request.allowedOrigins);
  const allowed =
    config.allowedOrigins === undefined
      ? requested
      : requested.filter(origin => origins(config.allowedOrigins ?? []).includes(origin));
  if (!inScope(element, entry, allowed)) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_scope',
        'PERMISSION_DENIED',
        'The document or target destination is outside the allowed origins.'
      ),
    };
  }
  const index =
    element && entry
      ? optionIndex(
          element,
          entry,
          command,
          command.operation === 'SELECT' && command.optionId
            ? context.optionHashes?.get(command.optionId)
            : undefined
        )
      : undefined;
  if (
    command.operation === 'SELECT' &&
    element instanceof HTMLSelectElement &&
    index === undefined
  ) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_stale',
        'TARGET_STALE',
        'The selected option is no longer the observed option.',
        'option_changed'
      ),
    };
  }
  if (
    command.operation === 'SELECT' &&
    !(element instanceof HTMLSelectElement) &&
    command.optionId !== undefined
  ) {
    return {
      ok: false,
      outcome: reject(
        call,
        'rejected_invalid',
        'VALIDATION_FAILED',
        'An ARIA option does not take a native option id.'
      ),
    };
  }
  return { ok: true, element, entry, optionIndex: index };
}

export function createAutomationTaskHost(config: AutomationTaskHostConfig<HTMLElement>): TaskHost {
  const optionsBySession = new Map<
    string,
    { readonly snapshotId: string; readonly hashes: Map<string, string> }
  >();
  let disposed = false;
  let redactor = createRedactor();
  const clock = (): number => {
    try {
      const value = (config.clock ?? Date.now)();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };
  const observer = createTaskObserver({
    ...config.observer,
    documentId: config.documentId,
    createId: config.createId,
    clock,
    maxElements: config.maxElements,
    settle: config.settle,
  });
  const operations = TASK_HOST_OPERATIONS.filter(
    operation => config.operations === undefined || config.operations.includes(operation)
  );
  const maxElements =
    typeof config.maxElements === 'number' && Number.isFinite(config.maxElements)
      ? Math.min(TASK_LIMITS.observedElements, Math.max(0, Math.floor(config.maxElements)))
      : TASK_LIMITS.observedElements;
  const capabilities: TaskHostCapabilities = {
    hostKind: 'in_page',
    protocol: TASK_BRIDGE_PROTOCOL,
    operations,
    persistsAcrossNavigation: false,
    detectsNavigation: true,
    cancellation: 'cooperative',
    redaction: { observations: true, executionEvents: true },
    strictTargets: true,
    scrollContainers: true,
    implicitSubmitDetection: true,
    authoritativeLocation: false,
    isolatedWorld: false,
    maxElements,
    keys: TASK_KEYS,
    waitDurationsMs: operations.includes('WAIT') ? TASK_WAIT_DURATIONS_MS : [],
  };

  const execute = async (
    request: TaskCommandRequest,
    signal?: AbortSignal
  ): Promise<TaskExecutionOutcome> => {
    const startedAt = clock();
    const fill =
      request?.command?.operation === 'FILL' && typeof request.command.value === 'string'
        ? request.command.value
        : undefined;
    const call: Call = {
      request,
      startedAt,
      clock,
      redactor: fill === undefined ? redactor : redactor.withSecrets([fill]),
    };
    let invoked = false;
    try {
      if (disposed) {
        return reject(call, 'failed', 'HOST_DISPOSED', 'The host is disposed.');
      }
      if (signal?.aborted) {
        return reject(call, 'failed', 'EXECUTION_CANCELLED', 'The operation was cancelled.');
      }
      const options = optionsBySession.get(request.scope?.sessionId ?? '');
      const prepared = prepare({
        call,
        observer,
        operations,
        config,
        optionHashes:
          options?.snapshotId === request.scope?.snapshotId ? options.hashes : undefined,
      });
      if (!prepared.ok) {
        return prepared.outcome;
      }
      const { element, entry } = prepared;
      const sensitive =
        entry?.sensitive === true ||
        (request.command.operation === 'FILL' && request.command.sensitive);
      const command =
        request.command.operation === 'FILL' ? { ...request.command, sensitive } : request.command;
      if (sensitive && fill !== undefined) {
        redactor = redactor.withSecrets([fill]);
      }
      if (command.operation === 'READ' && element) {
        const text = sanitizeUntrustedText(
          call.redactor.scrub(visibleText(element, config)),
          TASK_LIMITS.passageChars
        );
        return {
          ...fields(call, { readback: { kind: 'read', text } }),
          status: 'applied',
          effect: 'none',
        };
      }
      const action = toActionCommand(command, {
        timeoutMs: request.timeoutMs,
        optionIndex: prepared.optionIndex,
      });
      if (!action) {
        return reject(
          call,
          'rejected_invalid',
          'VALIDATION_FAILED',
          'The command cannot be compiled.'
        );
      }
      const beforeUrl = window.location.href;
      let committed = false;
      invoked = true;
      const result = await config.executor.executeAction(action, {
        signal,
        target: element,
        strict: true,
        onCommit: () => {
          committed = true;
        },
      });
      await settle(request.settle ?? config.settle ?? TASK_DEFAULT_SETTLE, signal);
      if (signal?.aborted) {
        if ((result.effect === 'none' && !committed) || command.operation === 'WAIT') {
          return reject(call, 'failed', 'EXECUTION_CANCELLED', 'The operation was cancelled.');
        }
        return {
          ...fields(call, {
            code: 'EXECUTION_CANCELLED',
            message: 'The operation was cancelled after execution began.',
          }),
          status: 'uncertain',
          effect: 'uncertain',
        };
      }
      const navigation: TaskNavigationInfo | undefined =
        window.location.href !== beforeUrl
          ? {
              kind: 'same_document',
              fromDocumentId: observer.documentId,
              toDocumentId: observer.documentId,
              fromUrl: call.redactor.redactUrl(beforeUrl),
              toUrl: call.redactor.redactUrl(window.location.href),
              realmLost: false,
            }
          : undefined;
      const readback = currentReadback(
        readbackOf(result.data, call, sensitive),
        command,
        element,
        sensitive
      );
      return mapResult(result, readback, navigation, call);
    } catch (thrown) {
      const readonly =
        request?.command?.operation === 'READ' || request?.command?.operation === 'WAIT';
      return invoked && !readonly
        ? {
            ...fields(call, {
              code: signal?.aborted ? 'EXECUTION_CANCELLED' : 'EXECUTION_FAILED',
              message: messageOf(thrown),
            }),
            status: 'uncertain',
            effect: 'uncertain',
          }
        : reject(
            call,
            'failed',
            signal?.aborted ? 'EXECUTION_CANCELLED' : 'EXECUTION_FAILED',
            messageOf(thrown)
          );
    }
  };

  return {
    capabilities: async signal =>
      disposed
        ? error('HOST_DISPOSED', 'The host is disposed.')
        : signal?.aborted
          ? error('CANCELLED', 'The capability request was cancelled.')
          : { ok: true, value: capabilities },
    observe: async (request: TaskObserveRequest, signal) => {
      if (disposed) {
        return error('HOST_DISPOSED', 'The host is disposed.');
      }
      if (signal?.aborted) {
        return error('CANCELLED', 'The observation was cancelled.');
      }
      try {
        const observation = await observer.observe(request, signal);
        if (signal?.aborted) {
          return error('CANCELLED', 'The observation was cancelled.');
        }
        if (disposed) {
          return error('HOST_DISPOSED', 'The host is disposed.');
        }
        const hashes = new Map<string, string>();
        for (const entry of observation.elements) {
          if (!entry.options) {
            continue;
          }
          const resolved = observer.resolve({
            sessionId: observation.sessionId,
            snapshotId: observation.snapshotId,
            targetId: entry.id,
            signature: entry.signature,
          });
          if (resolved.ok && resolved.element instanceof HTMLSelectElement) {
            for (const option of entry.options) {
              const index = Number(option.id.slice(entry.id.length + 1)) - 1;
              const native = resolved.element.options[index];
              if (native) {
                hashes.set(option.id, optionFingerprint(native));
              }
            }
          }
        }
        optionsBySession.set(request.sessionId, { snapshotId: observation.snapshotId, hashes });
        while (optionsBySession.size > 4) {
          const oldest = optionsBySession.keys().next().value as string | undefined;
          if (oldest === undefined) {
            break;
          }
          optionsBySession.delete(oldest);
        }
        const scrubbed = scrubObservation(observation, redactor);
        return {
          ok: true,
          value: {
            ...scrubbed,
            elements: scrubbed.elements.map(entry => ({
              ...entry,
              operations: entry.operations.filter(operation => operations.includes(operation)),
            })),
          },
        };
      } catch (thrown) {
        return error('OBSERVE_FAILED', redactor.scrub(messageOf(thrown)), true);
      }
    },
    execute,
    release: async sessionId => {
      try {
        observer.release(sessionId);
        optionsBySession.delete(sessionId);
      } catch {
        /* Best effort. */
      }
    },
    dispose: async () => {
      disposed = true;
      observer.dispose();
      optionsBySession.clear();
      redactor = createRedactor();
    },
  };
}
