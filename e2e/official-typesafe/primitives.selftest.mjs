import assert from 'node:assert/strict';
import { readAnswer, readResponse, atomicQuestions, atomicVerdict } from './primitives.mjs';

const choice = { type: 'choice', criteria: { yes: 'Matches', no: 'Differs' } };
const score = {
  type: 'score',
  criteria: [{ description: 'None' }, { description: 'Some' }, { description: 'All' }],
};
const response = {
  type: 'choice',
  choice: 'yes',
  confidence: 0.6,
  probabilities: { yes: 0.8, no: 0.2 },
};
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
check(readAnswer(choice, response).ok, 'Valid choice');
check(
  Math.abs(readAnswer(choice, response).computedConfidence - 0.6) < 0.0001,
  'Binary concentration'
);
check(!readAnswer(choice, { ...response, choice: 'unknown' }).ok, 'Unadvertised choice');
check(
  !readAnswer(choice, { ...response, probabilities: { yes: 0.8, no: 0.2, extra: 0 } }).ok,
  'Extra probability'
);
check(
  !readAnswer(choice, { ...response, probabilities: { yes: 0.8, no: 0.1 } }).ok,
  'Probability sum'
);
check(
  !readAnswer(choice, { ...response, probabilities: { yes: 0.2, no: 0.8 } }).ok,
  'Choice must be a maximum'
);
check(readAnswer({ type: 'noul' }, { type: 'noul', noul: 0 }).ok, 'Noul zero is valid');
check(readAnswer({ type: 'noul' }, { type: 'noul', noul: 1 }).ok, 'Noul one is valid');
check(!readAnswer({ type: 'noul' }, { type: 'noul', noul: 1.1 }).ok, 'Noul range');
check(!readAnswer({ type: 'noul' }, { type: 'noul', noul: NaN }).ok, 'Nonfinite Noul');
const rating = {
  type: 'score',
  score: 1.5,
  confidence: 0.25,
  probabilities: { 0: 0, 1: 0.5, 2: 0.5 },
  legend: { 0: score.criteria[0], 1: score.criteria[1], 2: score.criteria[2] },
};
check(readAnswer(score, rating).ok, 'Structured Score legend');
check(!readAnswer(score, { ...rating, score: 2 }).ok, 'Score must equal weighted distribution');
check(
  !readAnswer(score, { ...rating, legend: { ...rating.legend, 1: 'different' } }).ok,
  'Legend preserves descriptions'
);
check(
  !readResponse(
    { questions: { decision: choice } },
    { model: 'other-model', answers: { decision: response } }
  ).ok,
  'Wrong model'
);
check(
  !readResponse({ questions: { decision: choice } }, { model: 'jev-1.13.0', answers: {} }).ok,
  'Missing answer'
);
const signal = value => ({ ok: true, type: 'noul', yesProbability: value });
check(atomicVerdict({ whole_goal: signal(0.99) }), 'Supported whole goal');
check(
  !atomicVerdict({ whole_goal: { ok: true, type: 'choice', choice: 'SATISFIED' } }),
  'A different primitive cannot pass as a Noul'
);
check(
  !atomicVerdict({ whole_goal: signal(0.99), input_required_0: signal(0.99) }),
  'Missing paired evidence fails closed'
);
check(!atomicVerdict({ whole_goal: signal(0.5) }), 'Uncertain whole goal');
check(
  !atomicVerdict({
    whole_goal: signal(0.99),
    input_required_0: signal(0.99),
    input_shown_0: signal(0.01),
  }),
  'A missing required field vetoes a confident whole-goal claim'
);
check(
  !atomicVerdict({
    whole_goal: signal(0.99),
    input_required_0: signal(0.5),
    input_shown_0: signal(0.99),
  }),
  'Uncertain applicability fails closed'
);
check(
  atomicVerdict({
    whole_goal: signal(0.99),
    input_required_0: signal(0.01),
    input_shown_0: signal(0.01),
  }),
  'Unused field does not veto'
);
const goal = 'Use my supplied details to complete the task.';
const questions = atomicQuestions(goal, {
  suppliedFields: [{ path: 'person.phone', value: 'public' }],
  controls: [{ id: 't1' }],
  citedEvidence: [{ id: 't2' }],
});
check(
  Object.values(questions).every(q => q.instructions.goal === goal),
  'Literal goal in every question'
);
check(
  questions.input_shown_0.instructions.question.includes('state.suppliedFields[0]'),
  'Question identifies its subject without relying on its ID'
);
process.stdout.write(`${checks}/${checks} primitive checks passed\n`);
