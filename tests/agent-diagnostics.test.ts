/** @jest-environment node */
import { createTypeSafeTaskDecider } from '@/agent/typesafe';
import { createTaskAgent } from '@/agent/TaskAgent';
import { copyConfidenceProfile } from '@/agent/confidence';
import { TASK_LIMITS, TASK_NONE_APPROPRIATE } from '@/types';
import type { TaskChooseArgumentRequest, TaskHttp, TypeSafeTaskDeciderConfig } from '@/types';
import { makeFakeHost, makeObservation, makeTextField } from './helpers/agent-fixtures';

const goal = 'Enter the supplied city';
const request: TaskChooseArgumentRequest = {
  goal,
  step: 0,
  observation: makeObservation(),
  operation: 'FILL',
  target: makeTextField(),
  slot: 'value',
  candidates: [{ id: 'c1', source: 'input', label: 'city', preview: 'Oslo', sensitive: false }],
  inputs: [],
  history: [],
  maxStateBytes: TASK_LIMITS.modelStateBytes,
};
const context = { goal, step: 0, runId: 'run_000000000001', callIndex: 1 };
const fake = (
  config: Partial<TypeSafeTaskDeciderConfig> = {},
  chosenProbability = 0.75,
  mutate?: (answer: Record<string, unknown>) => void
) => {
  const bodies: string[] = [];
  const responses: Record<string, unknown>[] = [];
  const http: TaskHttp = async (_url, init) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body) as {
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([key, question]) => {
        const names = Object.keys(question.criteria);
        const choice = names.find(name => name !== TASK_NONE_APPROPRIATE);
        if (!choice) {
          throw new Error('missing offered candidate');
        }
        const answer: Record<string, unknown> = {
          type: 'choice',
          choice,
          confidence: 0.43,
          probabilities: Object.fromEntries(
            names.map(name => [
              name,
              name === choice ? chosenProbability : (1 - chosenProbability) / (names.length - 1),
            ])
          ),
        };
        mutate?.(answer);
        responses.push(answer);
        return [key, answer];
      })
    );
    return {
      ok: true,
      status: 200,
      header: () => null,
      json: async () => ({ model: 'jev-1.13.0', answers }),
    };
  };
  const decider = createTypeSafeTaskDecider({
    apiKey: () => 'fake-test-credential-only',
    http,
    retry: { maxRetries: 0 },
    ...config,
  });
  return { decider, bodies, responses, call: () => decider.chooseArgument(request, context) };
};

describe('validated choice diagnostics and confidence provenance', () => {
  test('opt-in retains numerical evidence without changing the decision or request', async () => {
    const plain = fake();
    const diagnostic = fake({ captureProbabilities: true });
    const a = await plain.call();
    const b = await diagnostic.call();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      throw new Error('expected successful adapter decisions');
    }
    expect(b.decision).toEqual(a.decision);
    expect(diagnostic.bodies).toEqual(plain.bodies);
    const ordinary = Object.values(a.exchange.answers ?? {});
    expect(ordinary.every(answer => !('diagnostics' in answer))).toBe(true);
    const answer = Object.values(b.exchange.answers ?? {})[0];
    expect(answer?.confidence).toBe(0.43);
    expect(answer?.diagnostics?.selectedProbability).toBe(0.75);
    expect(answer?.diagnostics?.runnerUpProbability).toBe(0.25);
    expect(answer?.diagnostics?.margin).toBe(0.5);
    expect(answer?.diagnostics?.noneProbability).toBe(0.25);
    expect(answer?.diagnostics?.entropy).toBeCloseTo(
      -(0.75 * Math.log2(0.75) + 0.25 * Math.log2(0.25))
    );
    expect(Object.keys(answer?.diagnostics?.probabilities ?? {})).toEqual(
      expect.arrayContaining([answer?.choice, TASK_NONE_APPROPRIATE])
    );
    expect(JSON.stringify(b.exchange)).not.toContain('fake-test-credential-only');
    expect(JSON.stringify(b.exchange)).not.toContain('Oslo');
  });
  test.each([0.5, 1])(
    'uniform and certain distributions are finite for probability %s',
    async probability => {
      const result = await fake({ captureProbabilities: true }, probability).call();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected success');
      }
      const diagnostics = Object.values(result.exchange.answers ?? {})[0]?.diagnostics;
      expect(diagnostics?.entropy).toBeCloseTo(probability === 1 ? 0 : 1);
      expect(diagnostics?.margin).toBeCloseTo(probability === 1 ? 1 : 0);
    }
  );
  test('response object mutation cannot alter captured probabilities', async () => {
    const harness = fake({ captureProbabilities: true });
    const result = await harness.call();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    const before = JSON.stringify(result.exchange);
    for (const response of harness.responses) {
      const probabilities = response.probabilities as Record<string, number>;
      for (const key of Object.keys(probabilities)) {
        probabilities[key] = 0;
      }
    }
    expect(JSON.stringify(result.exchange)).toBe(before);
  });
  test('a custom HTTP answer cannot execute a probabilities accessor', async () => {
    const getter = jest.fn(() => ({ c1: 1, NONE_APPROPRIATE: 0 }));
    const harness = fake({ captureProbabilities: true }, 0.75, answer => {
      Object.defineProperty(answer, 'probabilities', { enumerable: true, get: getter });
    });
    const result = await harness.call();
    expect(result.ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    if (result.ok) {
      throw new Error('expected refusal');
    }
    expect(result.error.code).toBe('INVALID_RESPONSE');
  });
  test.each(['nonfinite', 'negative', 'sum', 'extra', 'missing', 'argmax', 'getter'])(
    'rejects invalid distribution %s without publishing it',
    async defect => {
      const harness = fake({ captureProbabilities: true }, 0.75, answer => {
        const probabilities = answer.probabilities as Record<string, number>;
        const chosen = answer.choice as string;
        if (defect === 'nonfinite') {
          probabilities[chosen] = Number.NaN;
        }
        if (defect === 'negative') {
          probabilities[chosen] = -1;
        }
        if (defect === 'sum') {
          probabilities[chosen] = 0.6;
        }
        if (defect === 'extra') {
          probabilities['unoffered-secret-text'] = 0;
        }
        if (defect === 'missing') {
          delete probabilities[chosen];
        }
        if (defect === 'argmax') {
          probabilities[chosen] = 0.25;
          probabilities[TASK_NONE_APPROPRIATE] = 0.75;
        }
        if (defect === 'getter') {
          Object.defineProperty(probabilities, chosen, { enumerable: true, get: () => 0.75 });
        }
      });
      const result = await harness.call();
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected rejection');
      }
      expect(result.error.code).toBe('INVALID_RESPONSE');
      expect(harness.bodies).toHaveLength(1);
      expect(result.exchange?.answers).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('unoffered-secret-text');
    }
  );
  test('explicit confidence profile is copied and recorded without relabeling its numerical scale', async () => {
    const profile = {
      kind: 'normalized_entropy' as const,
      calibrated: false,
      floors: { action: 0.25 },
    };
    const harness = fake({ confidenceProfile: profile });
    profile.floors.action = 0.99;
    const result = await harness.call();
    expect(result.ok).toBe(true);
    expect(harness.decider.confidenceProfile?.floors?.action).toBe(0.25);
    expect(result.exchange?.confidenceKind).toBe('normalized_entropy');
    expect(Object.values(result.exchange?.answers ?? {})[0]?.confidence).toBe(0.43);
    expect(harness.bodies[0]).not.toContain('normalized_entropy');
  });
  test.each([
    { kind: 'unknown', calibrated: false, floors: { completion: -0.1 } },
    { kind: 'vendor_reported', calibrated: false, floors: { action: Number.NaN } },
    { kind: 'credential-text', calibrated: false },
    { kind: 'unknown', calibrated: 'true' },
    { kind: 'unknown', calibrated: false, secret: 'forbidden-metadata' },
  ])('invalid provided profile refuses before HTTP', async profile => {
    const harness = fake({
      confidenceProfile: profile as unknown as TypeSafeTaskDeciderConfig['confidenceProfile'],
    });
    const result = await harness.call();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(harness.bodies).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('forbidden-metadata');
  });
  test('data-only profile validator never executes getters or trusts inherited floors', () => {
    const getter = jest.fn(() => 'unknown');
    expect(
      copyConfidenceProfile({
        get kind() {
          return getter();
        },
        calibrated: false,
      })
    ).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(
      copyConfidenceProfile({
        kind: 'unknown',
        calibrated: false,
        floors: Object.create({ completion: 0 }),
      })
    ).toBeUndefined();
  });
  test('invalid adapter profile propagates initialization refusal before coordinator host access', async () => {
    const harness = fake({
      confidenceProfile: { kind: 'unknown', calibrated: false, floors: { completion: -1 } },
    });
    const host = makeFakeHost();
    const result = await createTaskAgent({ host: host.host, decider: harness.decider }).run({
      goal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      throw new Error('expected init failure');
    }
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(host.calls.order).toHaveLength(0);
    expect(harness.bodies).toHaveLength(0);
  });
  test('adapter rejects inherited and accessor profiles without evaluating their getters', async () => {
    const getter = jest.fn(() => ({ kind: 'vendor_reported' as const, calibrated: false }));
    const accessor = {
      apiKey: 'fake-credential',
      get confidenceProfile() {
        return getter();
      },
    };
    const decider = createTypeSafeTaskDecider(accessor);
    expect(decider.initializationError).toBe('INVALID_CONFIGURATION');
    expect((await decider.chooseArgument(request, context)).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const inherited = Object.assign(
      Object.create({
        confidenceProfile: { kind: 'unknown', calibrated: false },
      }) as TypeSafeTaskDeciderConfig,
      { apiKey: 'fake-credential' }
    );
    expect(createTypeSafeTaskDecider(inherited).initializationError).toBe('INVALID_CONFIGURATION');
  });
});
