import type { TaskGoalRequirementKeyFn, TaskGoalRequirementHoldsFn } from '@/types';
import { sha256Hex, stableStringify } from '@/utils/hash';
import { compareFieldValues, capFieldValue } from '@/utils/value';
import { materializeArgument } from './resolver';

export const goalRequirementKey: TaskGoalRequirementKeyFn = (element, context) =>
  sha256Hex(
    stableStringify({
      kind: element.kind,
      role: element.role,
      inputType: element.inputType,
      groupId: element.groupId,
      choiceValue:
        element.kind === 'radio' || element.state.pressed !== undefined
          ? element.state.value
          : undefined,
      pageTitle: context?.title,
      landmark: element.landmark,
      label: element.label,
      region: element.region,
      inputName: element.inputName,
      autocomplete: element.autocomplete,
      required: element.state.required,
      formNoValidate: element.formNoValidate,
      serverInvalid: element.formNoValidate === true ? element.state.invalid : undefined,
      options: element.options?.map(option => ({
        label: option.label,
        groupLabel: option.groupLabel,
        value: option.value,
        disabled: option.disabled,
      })),
    })
  );

export const goalRequirementHolds: TaskGoalRequirementHoldsFn = (requirement, element, context) => {
  if (requirement.operation === 'SUBMIT') {
    return requirement.activated === true;
  }
  if (requirement.preserve) {
    return Object.entries(requirement.preserve).every(([key, value]) =>
      key === 'value' && typeof value === 'string'
        ? compareFieldValues(value, element.state.value ?? '', { inputType: element.inputType }) !==
          'different'
        : element.state[key as keyof typeof requirement.preserve] === value
    );
  }
  const argument = requirement.argument;
  if (!argument) {
    return true;
  }
  if (argument.source === 'protocol' && argument.slot === 'value' && argument.token === 'EMPTY') {
    return (element.state.value ?? '') === '';
  }
  if (requirement.operation === 'SELECT') {
    return (
      element.options?.some(
        option =>
          option.selected &&
          !option.disabled &&
          option.label === requirement.optionLabel &&
          (requirement.optionValue === undefined || option.value === requirement.optionValue)
      ) === true
    );
  }
  if (requirement.operation === 'SET_CHECKED' || requirement.operation === 'CLICK') {
    return (
      (element.state.checked ?? element.state.pressed) ===
      (argument.source === 'protocol' && argument.token === 'CHECKED')
    );
  }
  if (requirement.sensitive || argument.source === 'resolver') {
    return context.ledger.some(entry => {
      const command = entry.command.command;
      return (
        command.operation === 'FILL' &&
        entry.command.target?.signature === element.signature &&
        stableStringify(command.value) === stableStringify(argument) &&
        (entry.status === 'applied' || entry.status === 'noop_already_satisfied') &&
        (element.state.value ?? '') !== ''
      );
    });
  }
  const value = materializeArgument(argument, { ...context, resolved: {} });
  return (
    value.ok &&
    compareFieldValues(
      capFieldValue(value.value).value,
      capFieldValue(element.state.value ?? '').value,
      { inputType: element.inputType }
    ) !== 'different'
  );
};
