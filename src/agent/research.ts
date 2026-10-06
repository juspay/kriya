import { TASK_RESEARCH_PROFILE } from '@/types';
import type {
  ResearchEvidence,
  ResearchGuideOptions,
  ResearchResult,
  TaskRequest,
  TaskResult,
} from '@/types';

export function createResearchRequest(
  goal: string,
  options: Pick<
    ResearchGuideOptions,
    'allowedOrigins' | 'minConfidence' | 'minActionConfidence' | 'maxSteps'
  > = {}
): TaskRequest {
  return {
    goal,
    profile: TASK_RESEARCH_PROFILE,
    expect: { answer: true },
    ...(options.allowedOrigins === undefined
      ? {}
      : { authorization: { origins: options.allowedOrigins } }),
    options: {
      confidence: {
        completion: options.minConfidence ?? 0.6,
        action: options.minActionConfidence ?? 0,
      },
      budgets: { maxSteps: options.maxSteps ?? 24 },
    },
  };
}

export function toResearchResult(result: TaskResult): ResearchResult {
  const evidence: ResearchEvidence[] = [];
  for (const entry of result.ledger) {
    if (entry.command.command.operation === 'READ' && entry.readback?.kind === 'read') {
      evidence.push({ url: entry.url, text: entry.readback.text });
    }
  }
  const base = { steps: result.steps, evidence };
  if (result.status === 'cancelled') {
    return { ...base, ok: false, status: 'cancelled' };
  }
  if (result.status === 'completed') {
    const answer = result.answer?.value ?? 'UNKNOWN';
    return {
      ...base,
      ok: answer === 'YES',
      status: answer === 'YES' ? 'success' : 'failure',
      answer,
      confidence: result.completion.verifierConfidence,
      ...(result.answer === undefined ? { error: 'No informational answer was produced.' } : {}),
    };
  }
  const error =
    result.status === 'blocked'
      ? result.message
      : result.status === 'failed'
        ? result.error.message
        : result.status === 'needs_input'
          ? 'The investigation needs caller input.'
          : 'The investigation is awaiting approval.';
  return { ...base, ok: false, status: 'failure', answer: 'UNKNOWN', error };
}
