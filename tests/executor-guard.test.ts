/** @jest-environment node */
import { NOOP_GUARD, createMutationGuard } from '@/actions/guard';
import type { MutationGuard } from '@/types';
import { AutomationError } from '@/types';

function capture(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('createMutationGuard', () => {
  test('is assignable to the MutationGuard seam and starts uncommitted', () => {
    const guard: MutationGuard = createMutationGuard(new AbortController().signal);
    expect(guard.committed).toBe(false);
    expect(typeof guard.checkpoint).toBe('function');
    expect(typeof guard.commit).toBe('function');
  });

  test('checkpoint on a live signal returns and does not commit', () => {
    const guard = createMutationGuard(new AbortController().signal);
    guard.checkpoint();
    guard.checkpoint();
    expect(guard.committed).toBe(false);
  });

  test('commit marks the boundary crossed and stays crossed', () => {
    const guard = createMutationGuard(new AbortController().signal);
    guard.commit();
    expect(guard.committed).toBe(true);
    guard.commit();
    guard.checkpoint();
    expect(guard.committed).toBe(true);
  });

  test('committed is a live getter, not a snapshot taken at construction', () => {
    const guard = createMutationGuard(new AbortController().signal);
    const descriptor = Object.getOwnPropertyDescriptor(guard, 'committed');
    expect(typeof descriptor?.get).toBe('function');
    const before = guard.committed;
    guard.commit();
    expect([before, guard.committed]).toEqual([false, true]);
  });

  test('abort before any commit: checkpoint and commit throw EXECUTION_CANCELLED and nothing commits', () => {
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    controller.abort();

    const fromCheckpoint = capture(() => guard.checkpoint());
    const fromCommit = capture(() => guard.commit());

    expect(fromCheckpoint).toBeInstanceOf(AutomationError);
    expect((fromCheckpoint as AutomationError).code).toBe('EXECUTION_CANCELLED');
    expect(fromCommit).toBeInstanceOf(AutomationError);
    expect((fromCommit as AutomationError).code).toBe('EXECUTION_CANCELLED');
    expect(guard.committed).toBe(false);
  });

  test('abort after commit: checkpoint throws but committed stays true (the effect is uncertain)', () => {
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    guard.commit();
    controller.abort();

    const error = capture(() => guard.checkpoint());

    expect((error as AutomationError).code).toBe('EXECUTION_CANCELLED');
    expect(guard.committed).toBe(true);
  });

  test('checkpoint after abort does not change state in either direction', () => {
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    controller.abort();
    capture(() => guard.checkpoint());
    capture(() => guard.checkpoint());
    expect(guard.committed).toBe(false);
  });

  test('a signal aborted between two checkpoints is noticed by the second one only', () => {
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    expect(capture(() => guard.checkpoint())).toBeUndefined();
    controller.abort();
    expect(capture(() => guard.checkpoint())).toBeInstanceOf(AutomationError);
  });

  test('without a signal nothing is ever cancelled', () => {
    const guard = createMutationGuard();
    expect(capture(() => guard.checkpoint())).toBeUndefined();
    expect(capture(() => guard.commit())).toBeUndefined();
    expect(guard.committed).toBe(true);
  });

  test('the cancellation message is fixed text without any abort reason', () => {
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    const reasonMarker = `reason-${Math.random().toString(36).slice(2)}`;
    controller.abort(new Error(reasonMarker));

    const error = capture(() => guard.checkpoint()) as AutomationError;

    expect(error.message).not.toContain(reasonMarker);
    expect(error.name).toBe('AutomationError');
    expect(error.context).toBeUndefined();
  });

  test('guards are independent of each other', () => {
    const first = createMutationGuard();
    const second = createMutationGuard();
    first.commit();
    expect([first.committed, second.committed]).toEqual([true, false]);
  });
});

describe('NOOP_GUARD', () => {
  test('is the legacy default: never throws, never commits', () => {
    const guard: MutationGuard = NOOP_GUARD;
    expect(capture(() => guard.checkpoint())).toBeUndefined();
    expect(capture(() => guard.commit())).toBeUndefined();
    expect(guard.committed).toBe(false);
  });
});
