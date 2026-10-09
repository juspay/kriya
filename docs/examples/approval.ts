import type { TaskAgent, TaskInputs, TaskResult } from '@juspay/kriya';

/** Call only after your authenticated approval UI records the user's actual decision. */
export async function resolveApproval(
  agent: TaskAgent,
  result: TaskResult,
  decision: 'approve' | 'deny',
  sensitiveInputs?: TaskInputs
) {
  if (result.status !== 'awaiting_approval') {
    return result;
  }
  const { id, nonce, digest, contextDigest } = result.approval;
  return agent.resume({
    checkpoint: result.checkpoint,
    resolution: {
      kind: 'approval',
      resolution: { approvalId: id, nonce, digest, contextDigest, decision, scope: 'once' },
    },
    inputs: sensitiveInputs,
  });
}
