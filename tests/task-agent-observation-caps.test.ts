/** @jest-environment node */
import { TASK_LIMITS, TASK_REDACTED } from '@/types';
import {
  deciderOk,
  makeCompletionDecision,
  makeElement,
  makeObservation,
} from './helpers/agent-fixtures';
import { requireStatus, setup, terminal } from './helpers/task-agent-contract';

const lateMarker = 'REVIEW_DETAILS_AFTER_THE_LABEL_LIMIT';
const longText = (cap: number): string => `${'a'.repeat(300)}${lateMarker}${'b'.repeat(cap)}`;
const passage = (text: string) =>
  makeElement({
    id: 't7',
    role: 'paragraph',
    kind: 'passage',
    label: 'Order review',
    text,
    operations: ['READ'],
  });

describe('coordinator observation text uses its field contract cap', () => {
  test('page text past the label cap reaches both action and independent completion requests up to observedTextChars', async () => {
    const text = longText(TASK_LIMITS.observedTextChars);
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['t7'] })),
        ],
      },
      { observations: [makeObservation({ text, elements: [passage('Observed review evidence')] })] }
    );
    requireStatus(await agent.run({ goal: 'Inspect the observed order review.' }), 'completed');
    const actionText = fakeDecider.calls.chooseAction[0]?.request.observation.text ?? '';
    const verificationText = fakeDecider.calls.verifyCompletion[0]?.request.observation.text ?? '';
    expect(Array.from(actionText).length).toBe(TASK_LIMITS.observedTextChars);
    expect(actionText.includes(lateMarker)).toBe(true);
    expect(verificationText === actionText).toBe(true);
  });

  test('reading passage text past the label cap is preserved up to passageChars in both decision stages', async () => {
    const text = longText(TASK_LIMITS.passageChars);
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['t7'] })),
        ],
      },
      { observations: [makeObservation({ elements: [passage(text)] })] }
    );
    requireStatus(await agent.run({ goal: 'Inspect the observed reading passage.' }), 'completed');
    const actionText =
      fakeDecider.calls.chooseAction[0]?.request.observation.elements[0]?.text ?? '';
    const verificationText =
      fakeDecider.calls.verifyCompletion[0]?.request.observation.elements[0]?.text ?? '';
    expect(Array.from(actionText).length).toBe(TASK_LIMITS.passageChars);
    expect(actionText.includes(lateMarker)).toBe(true);
    expect(verificationText === actionText).toBe(true);
  });

  test('long page and passage text retain useful late content while sensitive text is scrubbed before either call', async () => {
    const secret = String.fromCharCode(
      99,
      97,
      112,
      45,
      115,
      101,
      99,
      114,
      101,
      116,
      45,
      55,
      56,
      49
    );
    const text = `${'a'.repeat(300)}${lateMarker} ${secret} ${'b'.repeat(TASK_LIMITS.observedTextChars)}`;
    const { agent, fakeDecider } = setup(
      {
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: ['t7'] })),
        ],
      },
      { observations: [makeObservation({ text, elements: [passage(text)] })] }
    );
    const result = requireStatus(
      await agent.run({
        goal: 'Inspect the observed review contents.',
        inputs: { password: secret },
        options: { captureTrace: true },
      }),
      'completed'
    );
    const action = fakeDecider.calls.chooseAction[0]?.request.observation;
    const verification = fakeDecider.calls.verifyCompletion[0]?.request.observation;
    for (const observation of [action, verification]) {
      expect(observation?.text.includes(lateMarker)).toBe(true);
      expect(observation?.text.includes(TASK_REDACTED)).toBe(true);
      expect(observation?.text.includes(secret)).toBe(false);
      expect(observation?.elements[0]?.text?.includes(lateMarker)).toBe(true);
      expect(observation?.elements[0]?.text?.includes(TASK_REDACTED)).toBe(true);
      expect(observation?.elements[0]?.text?.includes(secret)).toBe(false);
      expect(Array.from(observation?.text ?? '').length).toBe(TASK_LIMITS.observedTextChars);
      expect(Array.from(observation?.elements[0]?.text ?? '').length).toBe(
        TASK_LIMITS.passageChars
      );
    }
    expect(JSON.stringify(fakeDecider.calls).includes(secret)).toBe(false);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  });
});
