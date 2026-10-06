import type { MutationGuard } from '@/types';
import { AutomationError } from '@/types';

/** Default for legacy call sites: no cancellation checks and no mutation tracking. */
export const NOOP_GUARD: MutationGuard = {
  committed: false,
  checkpoint: (): void => undefined,
  commit: (): void => undefined,
};

/**
 * Tracks the mutation boundary of one action. `checkpoint` is a clean cancellation point,
 * `commit` marks the first page mutation; after it an abort can only leave an uncertain effect.
 */
export function createMutationGuard(signal?: AbortSignal): MutationGuard {
  let committed = false;
  const checkpoint = (): void => {
    if (signal?.aborted === true) {
      throw new AutomationError('Operation was cancelled', 'EXECUTION_CANCELLED');
    }
  };
  return {
    get committed(): boolean {
      return committed;
    },
    checkpoint,
    commit: (): void => {
      checkpoint();
      committed = true;
    },
  };
}
