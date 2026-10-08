import type { TaskElement, TaskObservation, TaskProgressDiagnostics } from '@/types';
import { sha256Hex, stableStringify } from '@/utils/hash';

const identity = (element: TaskElement): string => element.controlId ?? element.signature;
const sorted = <T>(values: readonly T[]): T[] =>
  [...values].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

const semanticDigest = (observation: TaskObservation): string => {
  const identities = new Map(observation.elements.map(element => [element.id, identity(element)]));
  const targetIdentity = (id: string): string => identities.get(id) ?? id;
  return sha256Hex(
    stableStringify({
      document: observation.documentId,
      url: observation.url,
      page: {
        readyState: observation.page.readyState,
        busy: observation.page.busy,
        scroll: observation.page.scroll,
      },
      controls: sorted(
        observation.elements
          .filter(element => element.operations.some(operation => operation !== 'READ'))
          .map(element => ({
            identity: identity(element),
            label: element.label,
            kind: element.kind,
            role: element.role,
            inputName: element.inputName,
            inputType: element.inputType,
            operations: sorted(element.operations),
            state: {
              value: element.state.value,
              checked: element.state.checked,
              selected: element.state.selected,
              expanded: element.state.expanded,
              pressed: element.state.pressed,
              disabled: element.state.disabled,
              readOnly: element.state.readOnly,
              required: element.state.required,
              invalid: element.state.invalid,
              constraintInvalid: element.state.constraintInvalid,
            },
            inViewport: element.inViewport,
            scroll: element.scroll,
            href: element.href,
            formTarget: element.formTarget,
            options: element.options?.map(option => ({
              label: option.label,
              value: option.value,
              selected: option.selected,
              disabled: option.disabled,
            })),
          }))
      ),
      forms: sorted(
        observation.forms.map(form => ({
          action: form.action,
          method: form.method,
          implicitSubmit: form.implicitSubmit,
          fields: sorted(form.fieldIds.map(targetIdentity)),
          submitters: sorted(form.submitterIds.map(targetIdentity)),
          invalidFields: sorted(form.invalidFieldIds.map(targetIdentity)),
        }))
      ),
      validation: sorted(
        observation.validation.map(message => ({
          source: message.source,
          text: message.text,
          target: message.targetId === undefined ? undefined : targetIdentity(message.targetId),
        }))
      ),
      dialogs: sorted(
        observation.dialogs.map(dialog => ({
          label: dialog.label,
          modal: dialog.modal,
          elements: sorted(dialog.elementIds.map(targetIdentity)),
        }))
      ),
      truncation: {
        elementsDropped: observation.truncation.elementsDropped,
        optionsDropped: observation.truncation.optionsDropped,
      },
      unobserved: observation.unobserved,
    })
  );
};

/** Diagnostic heuristic only. Digests and page values never leave this tracker. */
export const createProgressTracker = (maxSteps: number) => {
  const limit = Math.max(1, Math.min(4096, Math.floor(maxSteps) * 4));
  const seen = new Set<string>();
  let previousDigest: string | undefined;
  let previousFingerprint: string | undefined;
  let unchangedStreak = 0;
  let observations = 0;
  let semanticChanges = 0;
  let cosmeticOnlyChanges = 0;
  let repeatedStates = 0;
  let maxUnchangedStreak = 0;
  return {
    observe: (observation: TaskObservation): void => {
      const digest = semanticDigest(observation);
      observations += 1;
      if (previousDigest !== undefined) {
        if (digest !== previousDigest) {
          semanticChanges += 1;
          unchangedStreak = 0;
        } else {
          unchangedStreak += 1;
          maxUnchangedStreak = Math.max(maxUnchangedStreak, unchangedStreak);
          if (observation.fingerprint !== previousFingerprint) {
            cosmeticOnlyChanges += 1;
          }
        }
        if (seen.has(digest)) {
          repeatedStates += 1;
        }
      }
      seen.delete(digest);
      seen.add(digest);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      previousDigest = digest;
      previousFingerprint = observation.fingerprint;
    },
    snapshot: (): TaskProgressDiagnostics => ({
      scope: 'active_segment',
      observations,
      semanticChanges,
      cosmeticOnlyChanges,
      repeatedStates,
      maxUnchangedStreak,
    }),
  };
};
