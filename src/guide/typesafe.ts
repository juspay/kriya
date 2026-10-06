import type {
  ChoiceQuestion,
  GuideDecideResult,
  GuideDecider,
  GuideElementOperation,
  GuideHttp,
  GuideOperation,
  SystemOneRequest,
  TypeSafeDeciderConfig,
} from '@/guide/types';
import { isElementOperation, isGuideOperation } from '@/guide/types';
import { targetQuestionKey } from '@/guide/request';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const PROBABILITY_TOLERANCE = 0.02;

export function createTypeSafeDecider(config: TypeSafeDeciderConfig): GuideDecider {
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  const http = config.http ?? browserHttp;
  const apiKey = config.apiKey.trim();

  return async (request: SystemOneRequest): Promise<GuideDecideResult> => {
    if (apiKey === '') {
      return { ok: false, error: 'TypeSafe API key is empty' };
    }
    let response: Awaited<ReturnType<GuideHttp>>;
    try {
      response = await http(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          state: request.state,
          questions: request.questions,
        }),
      });
    } catch {
      return { ok: false, error: 'TypeSafe request failed' };
    }
    if (!response.ok) {
      return { ok: false, error: `TypeSafe returned HTTP ${String(response.status)}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'TypeSafe returned invalid JSON' };
    }
    return decisionFromBody(body, request);
  };
}

export function decisionFromBody(body: unknown, request: SystemOneRequest): GuideDecideResult {
  const answers = readAnswers(body);
  if (answers === null) {
    return { ok: false, error: 'TypeSafe response has no answers' };
  }
  const operationQuestion = request.questions.operation;
  if (operationQuestion === undefined) {
    return { ok: false, error: 'Guide request is missing the operation question' };
  }
  const operationAnswer = readChoice(answers.operation, operationQuestion.criteria);
  if (!operationAnswer.ok) {
    return operationAnswer;
  }
  if (!isGuideOperation(operationAnswer.choice)) {
    return { ok: false, error: 'TypeSafe chose an operation that was not offered' };
  }
  const operation: GuideOperation = operationAnswer.choice;
  let answerFields: { answer?: 'YES' | 'NO' | 'UNKNOWN'; answerConfidence?: number } = {};
  const answerQuestion = request.questions.answer;
  if (answerQuestion !== undefined) {
    const answer = readChoice(answers.answer, answerQuestion.criteria);
    if (!answer.ok) {
      return answer;
    }
    if (answer.choice !== 'YES' && answer.choice !== 'NO' && answer.choice !== 'UNKNOWN') {
      return { ok: false, error: 'TypeSafe returned an unsupported answer' };
    }
    answerFields = { answer: answer.choice, answerConfidence: answer.confidence };
  }
  if (!isElementOperation(operation)) {
    return { ok: true, operation, confidence: operationAnswer.confidence, ...answerFields };
  }
  const target = readTarget(answers, request, operation);
  if (!target.ok) {
    return target;
  }
  return {
    ok: true,
    operation,
    targetIndex: target.choice,
    confidence: Math.min(operationAnswer.confidence, target.confidence),
    ...answerFields,
  };
}

function readTarget(
  answers: Readonly<Record<string, unknown>>,
  request: SystemOneRequest,
  operation: GuideElementOperation
): { ok: true; choice: string; confidence: number } | { ok: false; error: string } {
  const key = targetQuestionKey(operation);
  const question = request.questions[key];
  if (question === undefined) {
    return { ok: false, error: `No ${key} question was offered` };
  }
  const answer = readChoice(answers[key], question.criteria);
  if (!answer.ok) {
    return answer;
  }
  return { ok: true, choice: answer.choice, confidence: answer.confidence };
}

function readAnswers(body: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof body !== 'object' || body === null || !('answers' in body)) {
    return null;
  }
  const answers = body.answers;
  if (typeof answers !== 'object' || answers === null) {
    return null;
  }
  return answers as Readonly<Record<string, unknown>>;
}

function readChoice(
  value: unknown,
  criteria: ChoiceQuestion['criteria']
): { ok: true; choice: string; confidence: number } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'TypeSafe choice answer is missing' };
  }
  if (!('choice' in value) || !('confidence' in value) || !('probabilities' in value)) {
    return { ok: false, error: 'TypeSafe choice answer is incomplete' };
  }
  const { choice, confidence, probabilities } = value;
  if (typeof choice !== 'string' || typeof confidence !== 'number' || !isProbability(confidence)) {
    return { ok: false, error: 'TypeSafe choice answer has a bad choice or confidence' };
  }
  if (typeof probabilities !== 'object' || probabilities === null) {
    return { ok: false, error: 'TypeSafe choice answer has no probabilities' };
  }
  const allowed = Object.keys(criteria);
  const received = Object.keys(probabilities);
  if (allowed.length !== received.length || allowed.some(key => !received.includes(key))) {
    return { ok: false, error: 'TypeSafe probabilities do not match the offered choices' };
  }
  let total = 0;
  let max = 0;
  for (const key of allowed) {
    const probability = Reflect.get(probabilities, key) as unknown;
    if (typeof probability !== 'number' || !isProbability(probability)) {
      return { ok: false, error: 'TypeSafe returned a probability outside 0..1' };
    }
    total += probability;
    if (probability > max) {
      max = probability;
    }
  }
  if (Math.abs(total - 1) >= PROBABILITY_TOLERANCE) {
    return { ok: false, error: 'TypeSafe probabilities do not sum to 1' };
  }
  const chosen = Reflect.get(probabilities, choice) as unknown;
  if (typeof chosen !== 'number' || chosen < max - 1e-6 || !(choice in criteria)) {
    return { ok: false, error: 'TypeSafe choice is not the most probable offered option' };
  }
  return { ok: true, choice, confidence };
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

async function browserHttp(
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}> {
  const response = await fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: async (): Promise<unknown> => response.json() as Promise<unknown>,
  };
}
