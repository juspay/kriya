import {
  TASK_CHECKED_CHOICES,
  TASK_EFFECTS,
  TASK_EMPTY_TOKEN,
  TASK_HOST_OPERATIONS,
  TASK_KEYS,
  TASK_LIMITS,
  TASK_PAGE_TARGET_ID,
  TASK_SLOT_SOURCES,
  isTaskHostOperation,
} from '@/types';
import type {
  ActionCommand,
  TaskArgumentView,
  TaskArgumentRef,
  TaskArgumentSlot,
  TaskCommand,
  TaskCommandDigestFn,
  TaskCommitContextFn,
  TaskCommitField,
  TaskCommitHint,
  TaskCompileCommandFn,
  TaskCompileErrorCode,
  TaskCompileInput,
  TaskCompileResult,
  TaskComputeOffersFn,
  TaskContextDigestFn,
  TaskDescribeArgumentFn,
  TaskElement,
  TaskEffectKind,
  TaskElementSummary,
  TaskForm,
  TaskFormTarget,
  TaskHostCapabilities,
  TaskHostOperation,
  TaskInputBinding,
  TaskObservation,
  TaskOperation,
  TaskOption,
  TaskRedactCommandFn,
  TaskTargetRef,
  TaskToActionCommandFn,
  TaskToHostCommandFn,
} from '@/types';
import { sha256Hex, stableStringify } from '@/utils/hash';
import { createRedactor } from '@/utils/redact';
import { sanitizeUntrustedText } from '@/utils/sanitize';
import {
  goalRefMatches,
  permittedDurations,
  permittedKeys,
  permittedScrollDirections,
  valueAllowedOnElement,
} from './resolver';

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly result: TaskCompileResult };

type TargetStep = Step<TaskElement | undefined>;
type ArgumentStep = Step<{ readonly option?: TaskOption }>;

// ---------------------------------------------------------------------------------------------
// describeArgument
// ---------------------------------------------------------------------------------------------

const slotFor = (
  operation: TaskHostOperation,
  element: TaskElement | undefined
): TaskArgumentSlot | null => {
  switch (operation) {
    case 'FILL':
      return element?.kind === 'text_input' || element?.kind === 'textarea' ? 'value' : null;
    case 'SELECT':
      return element?.kind === 'select' ? 'option' : null;
    case 'SET_CHECKED':
      return 'checked';
    case 'PRESS':
      return 'key';
    case 'SCROLL':
      return 'direction';
    case 'WAIT':
      return 'duration';
    default:
      return null;
  }
};

export const describeArgument: TaskDescribeArgumentFn = (operation, element) => {
  const slot = slotFor(operation, element);
  return slot === null ? null : { slot, sources: [...TASK_SLOT_SOURCES[slot]] };
};

// ---------------------------------------------------------------------------------------------
// computeOffers
// ---------------------------------------------------------------------------------------------

const visibleElements = (observation: TaskObservation): readonly TaskElement[] => {
  const modal = new Set(
    observation.dialogs.filter(dialog => dialog.modal).map(dialog => dialog.id)
  );
  if (modal.size === 0) {
    return observation.elements;
  }
  return observation.elements.filter(
    element => element.dialogId !== undefined && modal.has(element.dialogId)
  );
};

const leavesRun = (capabilities: TaskHostCapabilities): boolean =>
  !capabilities.persistsAcrossNavigation || !capabilities.detectsNavigation;

const survivesCapabilities = (
  operation: TaskHostOperation,
  capabilities: TaskHostCapabilities,
  allowRunLoss: boolean
): boolean => {
  switch (operation) {
    case 'NAVIGATE':
    case 'SUBMIT':
      return allowRunLoss || !leavesRun(capabilities);
    case 'PRESS':
      return permittedKeys(capabilities).length > 0;
    case 'WAIT':
      return permittedDurations(capabilities).length > 0;
    default:
      return true;
  }
};

const hasInvalidForm = (
  observation: TaskObservation,
  element: TaskElement | undefined
): boolean => {
  if (element?.formNoValidate === true) {
    return false;
  }
  const form = observation.forms.find(candidate => candidate.id === element?.formId);
  return (
    form !== undefined &&
    form.invalidFieldIds.some(
      id =>
        observation.elements.find(candidate => candidate.id === id)?.state.constraintInvalid !==
        false
    )
  );
};

const candidateIds = (
  operation: TaskHostOperation,
  observation: TaskObservation,
  capabilities: TaskHostCapabilities,
  visible: readonly TaskElement[]
): readonly { readonly id: string; readonly signature?: string }[] => {
  if (operation === 'SCROLL') {
    const page = observation.page.scroll.directions.length > 0 ? [{ id: TASK_PAGE_TARGET_ID }] : [];
    const containers = capabilities.scrollContainers
      ? visible
          .filter(
            element =>
              element.operations.includes('SCROLL') && (element.scroll?.directions.length ?? 0) > 0
          )
          .map(element => ({ id: element.id, signature: element.signature }))
      : [];
    return [...page, ...containers];
  }
  return visible
    .filter(
      element =>
        element.operations.includes(operation) &&
        !(operation === 'READ' && element.sensitive) &&
        !(operation === 'SUBMIT' && hasInvalidForm(observation, element))
    )
    .map(element => ({ id: element.id, signature: element.signature }));
};

export const computeOffers: TaskComputeOffersFn = input => {
  const { observation, capabilities, allowedOperations, exclude, allowRunLoss } = input;
  const visible = visibleElements(observation);
  const operations: TaskOperation[] = [];
  const targets: Partial<Record<TaskOperation, readonly string[]>> = {};
  for (const operation of TASK_HOST_OPERATIONS) {
    const entries = exclude.filter(entry => entry.operation === operation);
    const wholeOperationExcluded = entries.some(
      entry => entry.targetId === undefined && entry.signature === undefined
    );
    if (
      wholeOperationExcluded ||
      !capabilities.operations.includes(operation) ||
      !allowedOperations.includes(operation) ||
      !survivesCapabilities(operation, capabilities, allowRunLoss)
    ) {
      continue;
    }
    if (operation === 'WAIT') {
      operations.push(operation);
      continue;
    }
    const ids = candidateIds(operation, observation, capabilities, visible)
      .filter(
        candidate =>
          !entries.some(
            entry =>
              entry.targetId === candidate.id ||
              (entry.signature !== undefined && entry.signature === candidate.signature)
          )
      )
      .map(candidate => candidate.id);
    if (ids.length > 0) {
      operations.push(operation);
      targets[operation] = ids;
    }
  }
  return { operations: [...operations, 'DONE', 'BLOCKED'], targets };
};

// ---------------------------------------------------------------------------------------------
// compileCommand
// ---------------------------------------------------------------------------------------------

const fail = (
  code: TaskCompileErrorCode,
  message: string
): { readonly ok: false; readonly result: TaskCompileResult } => ({
  ok: false,
  result: { ok: false, error: { code, message } },
});

const pass = <T>(value: T): Step<T> => ({ ok: true, value });

const resolveTarget = (input: TaskCompileInput): TargetStep => {
  const { operation, targetId, offers, observation } = input;
  const find = (id: string): TaskElement | undefined =>
    observation.elements.find(element => element.id === id);
  if (operation === 'WAIT') {
    return targetId === undefined
      ? pass(undefined)
      : fail('TARGET_NOT_OFFERED', 'WAIT does not take a target.');
  }
  if (operation === 'SCROLL') {
    const id = targetId === undefined ? TASK_PAGE_TARGET_ID : targetId;
    if (!(offers.targets.SCROLL ?? []).includes(id)) {
      return fail('TARGET_NOT_OFFERED', 'That scroll target is not offered.');
    }
    if (id === TASK_PAGE_TARGET_ID) {
      return pass(undefined);
    }
    const container = find(id);
    return container === undefined
      ? fail('TARGET_UNKNOWN', 'The scroll target is not in the observation.')
      : pass(container);
  }
  if (targetId === undefined || targetId === '') {
    return fail('TARGET_REQUIRED', `${operation} needs a target element.`);
  }
  if (!(offers.targets[operation] ?? []).includes(targetId)) {
    return fail('TARGET_NOT_OFFERED', `That target is not offered for ${operation}.`);
  }
  const element = find(targetId);
  return element === undefined
    ? fail('TARGET_UNKNOWN', 'The target is not in the observation.')
    : pass(element);
};

const scrollDirectionsOf = (
  observation: TaskObservation,
  element: TaskElement | undefined
): readonly string[] =>
  element === undefined ? observation.page.scroll.directions : (element.scroll?.directions ?? []);

const protocolTokenValid = (
  ref: Extract<TaskArgumentRef, { readonly source: 'protocol' }>,
  input: TaskCompileInput,
  element: TaskElement | undefined
): boolean => {
  const { token } = ref;
  switch (ref.slot) {
    case 'value':
      return token === TASK_EMPTY_TOKEN;
    case 'key':
      return (permittedKeys(input.capabilities) as readonly string[]).includes(token);
    case 'direction':
      return (
        permittedScrollDirections(
          scrollDirectionsOf(input.observation, element)
        ) as readonly string[]
      ).includes(token);
    case 'duration':
      return permittedDurations(input.capabilities).some(duration => String(duration) === token);
    case 'checked':
      return (
        (TASK_CHECKED_CHOICES as readonly string[]).includes(token) &&
        !(element?.kind === 'radio' && token !== 'CHECKED')
      );
    default:
      return false;
  }
};

const optionStep = (
  ref: Extract<TaskArgumentRef, { readonly source: 'observed_option' }>,
  element: TaskElement | undefined
): ArgumentStep => {
  if (element === undefined || ref.targetId !== element.id) {
    return fail('ARGUMENT_INVALID', 'The option belongs to another element.');
  }
  const option = element.options?.find(candidate => candidate.id === ref.optionId);
  if (option === undefined) {
    return fail('OPTION_UNKNOWN', 'The option is not one of the element options.');
  }
  return option.disabled ? fail('OPTION_DISABLED', 'The option is disabled.') : pass({ option });
};

const sourceStep = (
  ref: TaskArgumentRef,
  slot: TaskArgumentSlot,
  input: TaskCompileInput,
  element: TaskElement | undefined
): ArgumentStep => {
  const invalid = fail('ARGUMENT_INVALID', 'The argument does not verify.');
  switch (ref.source) {
    case 'goal_literal':
    case 'goal_span':
      return goalRefMatches(ref, input.goal) ? pass({}) : invalid;
    case 'input':
      return input.inputRules.some(rule => rule.path === ref.path) ? pass({}) : invalid;
    case 'resolver':
      return input.resolvers.some(resolver => resolver.id === ref.resolverId) ? pass({}) : invalid;
    case 'observed_option':
      return optionStep(ref, element);
    case 'protocol':
      return ref.slot === slot && protocolTokenValid(ref, input, element) ? pass({}) : invalid;
    default:
      return invalid;
  }
};

const bindingRule = (
  ref: TaskArgumentRef,
  input: TaskCompileInput
): { readonly sensitive: boolean; readonly bind?: TaskInputBinding } | null => {
  switch (ref.source) {
    case 'input': {
      const rule = input.inputRules.find(candidate => candidate.path === ref.path);
      return rule === undefined ? null : { sensitive: rule.sensitive, bind: rule.bind };
    }
    case 'resolver': {
      const resolver = input.resolvers.find(candidate => candidate.id === ref.resolverId);
      return resolver === undefined ? null : { sensitive: resolver.sensitive };
    }
    case 'goal_literal':
    case 'goal_span':
      return { sensitive: false };
    default:
      return null;
  }
};

const checkArgument = (input: TaskCompileInput, element: TaskElement | undefined): ArgumentStep => {
  const { operation, argument } = input;
  const spec = describeArgument(operation, element);
  if (spec === null) {
    if (argument !== undefined) {
      return fail('ARGUMENT_UNEXPECTED', `${operation} takes no argument here.`);
    }
    const lacksSlot =
      operation === 'FILL' || (operation === 'SELECT' && element?.kind !== 'option');
    return lacksSlot
      ? fail('ARGUMENT_INVALID', `${operation} is not possible on this element.`)
      : pass({});
  }
  if (argument === undefined) {
    return fail('ARGUMENT_REQUIRED', `${operation} needs an argument.`);
  }
  if (!spec.sources.includes(argument.source)) {
    return fail('ARGUMENT_NOT_ALLOWED', 'That argument source is not allowed for this slot.');
  }
  const verified = sourceStep(argument, spec.slot, input, element);
  if (!verified.ok || spec.slot !== 'value') {
    return verified;
  }
  const rule = bindingRule(argument, input);
  if (
    rule !== null &&
    !valueAllowedOnElement(rule, element, input.observation.origin, input.origins)
  ) {
    return fail('ARGUMENT_NOT_ALLOWED', 'That value may not be typed into this element.');
  }
  return verified;
};

const targetRef = (observation: TaskObservation, element: TaskElement): TaskTargetRef => ({
  sessionId: observation.sessionId,
  snapshotId: observation.snapshotId,
  targetId: element.id,
  signature: element.signature,
});

const protocolToken = (ref: TaskArgumentRef | undefined): string =>
  ref?.source === 'protocol' ? ref.token : '';

const buildCommand = (
  input: TaskCompileInput,
  element: TaskElement | undefined,
  option: TaskOption | undefined
): TaskCommand | null => {
  const { operation, observation, argument } = input;
  const target = element === undefined ? undefined : targetRef(observation, element);
  const token = protocolToken(argument);
  switch (operation) {
    case 'WAIT':
      return { operation, durationMs: Number(token) };
    case 'SCROLL': {
      const direction = permittedScrollDirections(scrollDirectionsOf(observation, element)).find(
        candidate => candidate === token
      );
      return direction === undefined
        ? null
        : { operation, ...(target === undefined ? {} : { target }), direction };
    }
    case 'READ':
    case 'CLICK':
    case 'NAVIGATE':
    case 'SUBMIT':
      return target === undefined ? null : { operation, target };
    case 'SELECT':
      if (target === undefined) {
        return null;
      }
      return option === undefined
        ? { operation, target }
        : { operation, target, optionId: option.id };
    case 'SET_CHECKED':
      return target === undefined ? null : { operation, target, checked: token === 'CHECKED' };
    case 'PRESS': {
      const key = TASK_KEYS.find(candidate => candidate === token);
      return target === undefined || key === undefined ? null : { operation, target, key };
    }
    case 'FILL':
      return target === undefined || argument === undefined
        ? null
        : { operation, target, value: argument };
    default:
      return null;
  }
};

/** A null from a decoder means no target and no argument; it must not reach a property read. */
const withoutNulls = (input: TaskCompileInput): TaskCompileInput => ({
  ...input,
  targetId: input.targetId ?? undefined,
  argument: input.argument ?? undefined,
});

export const compileCommand: TaskCompileCommandFn = given => {
  const input = withoutNulls(given);
  const { operation } = input;
  if (!isTaskHostOperation(operation) || !input.offers.operations.includes(operation)) {
    return fail('OPERATION_NOT_OFFERED', 'That operation is not offered.').result;
  }
  const target = resolveTarget(input);
  if (!target.ok) {
    return target.result;
  }
  const argument = checkArgument(input, target.value);
  if (!argument.ok) {
    return argument.result;
  }
  const option = argument.value.option;
  const command = buildCommand(input, target.value, option);
  if (command === null) {
    return fail('ARGUMENT_INVALID', 'The command cannot be built from this argument.').result;
  }
  if (
    (command.operation === 'SUBMIT' ||
      (command.operation === 'PRESS' && command.key === 'Enter')) &&
    hasInvalidForm(input.observation, target.value)
  ) {
    return fail('FORM_INVALID', 'The form has invalid controls that must be corrected.').result;
  }
  return {
    ok: true,
    command,
    ...(target.value === undefined ? {} : { target: target.value }),
    ...(option === undefined ? {} : { optionLabel: option.label }),
  };
};

// ---------------------------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------------------------

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const effectOrder = (effect: TaskEffectKind): number => {
  const index = TASK_EFFECTS.indexOf(effect);
  return index < 0 ? TASK_EFFECTS.length : index;
};

const canonicalEffects = (effects: readonly TaskEffectKind[]): readonly TaskEffectKind[] =>
  [...new Set(effects)].sort(
    (left, right) => effectOrder(left) - effectOrder(right) || compareText(left, right)
  );

const canonicalHints = (hints: readonly TaskCommitHint[] | undefined): readonly TaskCommitHint[] =>
  [...(hints ?? [])]
    .map(hint => ({ class: hint.class, basis: hint.basis }))
    .sort((left, right) =>
      compareText(`${left.class}|${left.basis}`, `${right.class}|${right.basis}`)
    );

const canonicalRef = (ref: TaskArgumentRef): Readonly<Record<string, unknown>> => {
  switch (ref.source) {
    case 'goal_literal':
    case 'goal_span':
      return { source: ref.source, start: ref.start, end: ref.end, text: ref.text };
    case 'input':
      return { source: 'input', path: ref.path };
    case 'resolver':
      return { source: 'resolver', resolverId: ref.resolverId, key: ref.key };
    case 'protocol':
      return { source: 'protocol', slot: ref.slot, token: ref.token };
    default:
      return { source: 'observed_option' };
  }
};

const protocolArgument = (
  slot: TaskArgumentSlot,
  token: string
): Readonly<Record<string, unknown>> => ({
  source: 'protocol',
  slot,
  token,
});

const canonicalArgument = (command: TaskCommand): Readonly<Record<string, unknown>> | undefined => {
  switch (command.operation) {
    case 'FILL':
      return canonicalRef(command.value);
    case 'SET_CHECKED':
      return protocolArgument('checked', command.checked ? 'CHECKED' : 'UNCHECKED');
    case 'PRESS':
      return protocolArgument('key', command.key);
    case 'SCROLL':
      return protocolArgument('direction', command.direction);
    case 'WAIT':
      return protocolArgument('duration', String(command.durationMs));
    default:
      return undefined;
  }
};

const digestOf = (prefix: string, value: unknown): string =>
  `${prefix}_${sha256Hex(stableStringify(value)).slice(0, 32)}`;

export const commandDigest: TaskCommandDigestFn = input => {
  const { command, effects, origin, optionLabel, target } = input;
  return digestOf('dg', {
    operation: command.operation,
    signature: 'target' in command ? command.target?.signature : undefined,
    argument: canonicalArgument(command),
    effects: canonicalEffects(effects),
    origin,
    optionLabel,
    href: target?.href,
    formTarget: target?.formTarget,
    hints: canonicalHints(target?.commitHints),
    sensitive: target?.sensitive === true,
  });
};

// ---------------------------------------------------------------------------------------------
// Commit context
// ---------------------------------------------------------------------------------------------

const URL_REDACTOR = createRedactor();
const LIST_CAP = TASK_LIMITS.commitContextFields;

const clean = (text: string, limit: number): string => sanitizeUntrustedText(text, limit);

const cleanList = (texts: readonly string[], limit: number, cap: number): readonly string[] =>
  texts
    .map(text => clean(text, limit))
    .filter(text => text !== '')
    .slice(0, cap);

const destinationOf = (element: TaskElement | undefined): TaskFormTarget | undefined => {
  if (element?.formTarget !== undefined) {
    return { action: element.formTarget.action, method: element.formTarget.method };
  }
  return element?.href === undefined ? undefined : { action: element.href, method: 'GET' };
};

const fieldOf = (element: TaskElement): TaskCommitField => {
  const { value, checked } = element.state;
  return {
    label: clean(element.label, TASK_LIMITS.labelChars),
    kind: element.kind,
    sensitive: element.sensitive,
    ...(value === undefined
      ? {}
      : element.sensitive
        ? { nonEmpty: value !== '' }
        : { value: clean(value, TASK_LIMITS.valueChars) }),
    ...(checked === undefined ? {} : { checked }),
  };
};

const formFieldsOf = (
  observation: TaskObservation,
  form: TaskForm | undefined
): readonly TaskCommitField[] => {
  if (form === undefined) {
    return [];
  }
  const byId = new Map(observation.elements.map(element => [element.id, element]));
  return form.fieldIds
    .flatMap(id => {
      const element = byId.get(id);
      return element === undefined ? [] : [element];
    })
    .slice(0, LIST_CAP)
    .map(fieldOf);
};

const regionPassagesOf = (
  observation: TaskObservation,
  element: TaskElement | undefined
): readonly string[] => {
  if (element === undefined || (element.region === undefined && element.dialogId === undefined)) {
    return [];
  }
  const shares = (candidate: TaskElement): boolean =>
    (element.region !== undefined && candidate.region === element.region) ||
    (element.dialogId !== undefined && candidate.dialogId === element.dialogId);
  return cleanList(
    observation.elements
      .filter(
        candidate =>
          candidate.id !== element.id &&
          candidate.operations.includes('READ') &&
          !candidate.sensitive &&
          shares(candidate)
      )
      .map(candidate => candidate.text ?? ''),
    TASK_LIMITS.commitContextPassageChars,
    TASK_LIMITS.commitContextPassages
  );
};

export const commitContext: TaskCommitContextFn = ({ observation, element, form }) => {
  const resolvedForm =
    form ??
    (element?.formId === undefined
      ? undefined
      : observation.forms.find(candidate => candidate.id === element.formId));
  const destination =
    destinationOf(element) ??
    (resolvedForm?.action === undefined
      ? undefined
      : { action: resolvedForm.action, method: resolvedForm.method });
  const passageChars = TASK_LIMITS.commitContextPassageChars;
  return {
    structural: {
      origin: observation.origin,
      ...(destination === undefined ? {} : { destination }),
      hints: canonicalHints(element?.commitHints),
      sensitiveTarget: element?.sensitive === true,
    },
    page: {
      url: clean(URL_REDACTOR.redactUrl(observation.url), TASK_LIMITS.passageChars),
      title: clean(observation.title, TASK_LIMITS.labelChars),
      targetLabel: clean(element?.label ?? '', TASK_LIMITS.labelChars),
      formFields: formFieldsOf(observation, resolvedForm),
      regionPassages: regionPassagesOf(observation, element),
      notices: cleanList(
        observation.notices.filter(notice => notice.kind !== 'banner').map(notice => notice.text),
        passageChars,
        LIST_CAP
      ),
      validation: cleanList(
        observation.validation.map(message => message.text),
        passageChars,
        LIST_CAP
      ),
      dialogs: cleanList(
        observation.dialogs.map(dialog => dialog.label),
        TASK_LIMITS.labelChars,
        LIST_CAP
      ),
    },
  };
};

export const contextDigest: TaskContextDigestFn = context => digestOf('cx', context);

// ---------------------------------------------------------------------------------------------
// Redacted and host commands
// ---------------------------------------------------------------------------------------------

const summarize = (element: TaskElement): TaskElementSummary => ({
  id: element.id,
  signature: element.signature,
  role: element.role,
  kind: element.kind,
  label: element.label,
  sensitive: element.sensitive,
  ...(element.twins === undefined ? {} : { twins: element.twins }),
  ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
  ...(element.href === undefined ? {} : { href: element.href }),
  ...(element.formId === undefined ? {} : { formId: element.formId }),
});

const guardedView = (view: TaskArgumentView): TaskArgumentView => {
  if (!view.sensitive || view.preview === undefined) {
    return view;
  }
  const { preview: _preview, ...rest } = view;
  return rest;
};

export const redactCommand: TaskRedactCommandFn = (command, target, argument, optionLabel) => ({
  command,
  ...(target === undefined ? {} : { target: summarize(target) }),
  ...(argument === undefined ? {} : { argument: guardedView(argument) }),
  ...(optionLabel === undefined ? {} : { optionLabel }),
});

export const toHostCommand: TaskToHostCommandFn = (command, materialized, target) => {
  if (command.operation !== 'FILL') {
    return { ok: true, command };
  }
  if (materialized === undefined || typeof materialized.value !== 'string') {
    return { ok: false, message: 'A FILL command needs a materialized value.' };
  }
  return {
    ok: true,
    command: {
      operation: 'FILL',
      target: command.target,
      value: materialized.value,
      sensitive: materialized.sensitive || target?.sensitive === true,
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Action commands (5.1)
// ---------------------------------------------------------------------------------------------

const action = (
  type: ActionCommand['type'],
  parameters: Readonly<Record<string, string>>,
  timeout: number
): ActionCommand => ({ type, parameters: { strict: 'true', ...parameters }, timeout });

export const toActionCommand: TaskToActionCommandFn = (command, context) => {
  const { timeoutMs } = context;
  switch (command.operation) {
    case 'READ':
      return null;
    case 'CLICK':
    case 'NAVIGATE':
    case 'SUBMIT':
      return action('click', {}, timeoutMs);
    case 'FILL':
      return {
        ...action('fill', { value: command.value }, timeoutMs),
        ...(command.sensitive ? { sensitiveParameters: ['value'] } : {}),
      };
    case 'SELECT': {
      if (command.optionId === undefined) {
        return action('select', {}, timeoutMs);
      }
      const index = context.optionIndex;
      const usable = typeof index === 'number' && Number.isSafeInteger(index) && index >= 0;
      return action(
        'select',
        usable ? { matchBy: 'index', option: String(index) } : { matchBy: 'index' },
        timeoutMs
      );
    }
    case 'SET_CHECKED':
      return action('setChecked', { checked: command.checked ? 'true' : 'false' }, timeoutMs);
    case 'PRESS':
      return action(
        'press',
        { key: command.key === 'Space' ? ' ' : command.key, implicitSubmit: 'true' },
        timeoutMs
      );
    case 'SCROLL':
      return action('scroll', { direction: command.direction }, timeoutMs);
    case 'WAIT':
      return action('wait', { duration: String(command.durationMs) }, command.durationMs + 1000);
    default:
      return null;
  }
};
