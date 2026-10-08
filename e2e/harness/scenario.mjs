import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateSensitiveValues } from './sensitive.mjs';

export const FAMILIES = Object.freeze(['catalog', 'settings', 'shipping', 'checkout']);
export const VARIANTS = Object.freeze(['A', 'B', 'C']);
export const KINDS = Object.freeze(['live', 'fault']);
export const TASK_STATUSES = Object.freeze([
  'completed',
  'blocked',
  'needs_input',
  'awaiting_approval',
  'failed',
  'cancelled',
]);
export const PAUSE_STATUSES = Object.freeze(['needs_input', 'awaiting_approval']);
/** The only origin a scenario may name: the runner swaps in the origin of the app it started. */
export const APP_ORIGIN_TOKEN = '$app';

/** Control, bidi and zero-width characters, built from code points so the source holds no invisible characters. */
const HIDDEN_CHARACTERS = new RegExp(
  `[${[
    [0x0000, 0x0008],
    [0x000b, 0x000c],
    [0x000e, 0x001f],
    [0x007f, 0x007f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]
    .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
    .join('')}]`
);

const GOAL_MIN_CHARS = 10;
const GOAL_MAX_BYTES = 1500;
const MAX_CANCEL_AFTER_MS = 600000;

const TOP_LEVEL_KEYS = Object.freeze([
  'id',
  'family',
  'variant',
  'kind',
  'title',
  'goal',
  'inputs',
  'inputDeclarations',
  'authorization',
  'initial',
  'faults',
  'run',
  'resume',
  'inject',
  'expectStatus',
  'expect',
  'forbiddenInstructionText',
]);

// Copies of TASK_HOST_OPERATIONS, TASK_COMMITMENT_EFFECTS and the TaskBudgets keys (src/types/agent.ts):
// the harness never imports from src/, and selftest compares these lists with faults.mjs.
export const HOST_OPERATIONS = Object.freeze([
  'READ',
  'CLICK',
  'NAVIGATE',
  'FILL',
  'SELECT',
  'SET_CHECKED',
  'PRESS',
  'SCROLL',
  'WAIT',
  'SUBMIT',
]);
export const COMMITMENT_EFFECTS = Object.freeze([
  'form_submit',
  'purchase',
  'delete',
  'publish',
  'send',
  'account_change',
  'other_commitment',
]);
export const BUDGET_KEYS = Object.freeze([
  'maxSteps',
  'maxWallTimeMs',
  'maxModelCalls',
  'maxStaleRetries',
  'maxNoProgress',
  'maxUncertainEffects',
  'maxPrematureDone',
  'maxInvalidDecisions',
  'maxRejectedCommands',
  'maxDeciderFailures',
  'maxHostFailures',
]);

export const DECIDER_MODES = Object.freeze([
  'prematureDone',
  'invalidTarget',
  'invalidArgument',
  'slow',
  'throw',
  'noneAppropriate',
]);
export const HOST_MODES = Object.freeze([
  'staleBeforeExecute',
  'contextDestroyed',
  'lostAfterCommit',
  'timeoutAfterCommit',
  'slowObserve',
]);
const DECIDER_KEYS = Object.freeze(['mode', 'atDecision', 'ms', 'style', 'stage']);
const HOST_KEYS = Object.freeze(['mode', 'atExecution', 'ms', 'timing', 'operation']);

export const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isPositiveInteger = value => Number.isSafeInteger(value) && value >= 1;

// ---------------------------------------------------------------------------------------------
// Text rules: what a goal, an input or library instruction text may never contain
// ---------------------------------------------------------------------------------------------

const URL_PATTERN =
  /\b(?:https?|ftp|file|wss?):\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i;
const FILE_PATTERN = /(?<![@\w.-])[\w-]+\.(?:html?|php|aspx?|jsp|cgi)\b/i;
const PATH_TOKEN = /(?:^|[\s("'`])\/[\w~-][\w.~-]*(?:\/[\w.~-]*)*(?:[?#]\S*)?/;
const PATH_WHOLE = /^\s*\/[\w~-][\w.~/-]*\s*$/;

const SELECTOR_PATTERNS = [
  /(?:^|[\s,(])#[A-Za-z_][\w-]*/,
  /(?:^|[\s,(])\.[A-Za-z_][\w-]{2,}/,
  /\[[A-Za-z_-][\w-]*\s*(?:[~|^$*]?=|\])/,
  /\b(?:div|span|button|input|form|select|label|li|ul|nav|section|textarea|table|tr|td|img)[.#:[][\w-]/i,
  /:(?:nth-[a-z-]+|first-child|last-child|first-of-type|last-of-type|not|hover|focus|checked|disabled|enabled|has|is|where)\b/i,
  /(?:^|[\s,(])(?:[.#][\w-]+|div|ul|li|form|nav|section|main|header|footer|button)\s*>\s*[.#\w]/i,
  /\b(?:querySelector(?:All)?|getElementsBy\w+|getElementById|xpath|data-testid|css selector)\b/i,
  /(?:^|\s)\/\/[*\w]+\[/,
];
const SELECTOR_WHOLE = /^\s*[#.][A-Za-z_][\w-]*\s*$/;
// Library instruction text is written by the library: words like [DONE], "t12.1" or "state:checked" are
// ordinary there, so only unmistakable selector syntax counts.
const LIBRARY_SELECTOR_PATTERNS = [
  /\[[A-Za-z_-][\w-]*\s*[~|^$*]?=/,
  /\b(?:div|span|button|input|form|select|label|li|ul|nav|section|textarea|table|tr|td|img)[.#[][\w-]/i,
  /[\w\])]:(?:nth-[a-z-]+|first-child|last-child|first-of-type|last-of-type)\b/i,
  /:(?:not|has|is|where)\(/i,
  /(?:^|[\s,(])[.#][\w-]+\s*>\s*[.#\w]/,
  /\b(?:querySelector(?:All)?|getElementsBy\w+|getElementById|xpath|data-testid|css selector)\b/i,
  /(?:^|\s)\/\/[*\w]+\[/,
  /(?:^|[\s,(])#[A-Za-z][A-Za-z0-9]*[-_][\w-]*/,
  /(?:^|[\s,(])\.[A-Za-z][A-Za-z0-9]*-[\w-]+/,
];

const CLICK_GOAL = /\bclick(?:s|ed|ing)?\b(?!\s*(?:-|and|&|n)\s*-?\s*collect)/i;
const CLICK_INPUT = /\bclick(?:s|ed|ing)?\s+(?:on|the|at|each|any|a|that|this|here)\b/i;
const OTHER_INSTRUCTION_PATTERNS = [
  /\btap(?:s|ped|ping)?\s+(?:on|the)\b/i,
  /\bpress(?:es|ed|ing)?\s+(?:the\s+)?(?:["'“‘][^"'”’]{1,40}["'”’]|[\w-]+)\s+(?:button|key)\b/i,
  /\bhit\s+(?:the\s+)?(?:["'“‘][^"'”’]{1,40}["'”’]|[\w-]+)\s+button\b/i,
  /\b(?:button|link|tab|menu|icon|checkbox|toggle|switch|dropdown|radio|field|input)\s+(?:labell?ed|called|named|titled|saying|that\s+says|marked|reading)\b/i,
  /["'“‘][^"'”’]{1,60}["'”’]\s+(?:button|link|tab|icon|checkbox|toggle|switch|dropdown|radio\s+button|menu\s+item)\b/i,
  /\b(?:button|link|tab|checkbox|toggle|switch)\s+["'“‘]/i,
];
const EXPECTED_TEXT_PATTERNS = [
  /\b(?:should|must|will)\s+(?:say|show|display|read|contain|print)\b/i,
  /\b(?:until|till|when)\s+(?:you\s+|it\s+|the\s+page\s+)?(?:see|sees|says?|shows?|displays?)\b/i,
  /\b(?:look(?:ing)?\s+for|find)\s+the\s+(?:text|message|phrase|banner|words?)\b/i,
  /\bexpected\s+(?:text|message|phrase|output|banner|result)\b/i,
  /\bverify\s+(?:that\s+)?(?:the\s+)?(?:page|screen)\s+(?:says?|shows?|displays?)\b/i,
];
const STEP_PATTERNS = [
  /(?:^|\n)\s*(?:\d{1,2}[.)]|[-*•])\s+\S/,
  /\bstep\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  /\bsteps?\s*:/i,
  /\bstep[- ]by[- ]step\b/i,
  /\b(?:first|next|finally|lastly)\s*,/i,
  /(?:->|=>|→|›|»)/,
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:steps?|clicks?)\b/i,
];
const INPUT_STEP_PATTERNS = [
  STEP_PATTERNS[0],
  STEP_PATTERNS[1],
  STEP_PATTERNS[2],
  STEP_PATTERNS[3],
];

const matchesAny = (patterns, text) => patterns.some(pattern => pattern.test(text));
const thenCount = text => (text.match(/\bthen\b/gi) ?? []).length;

/**
 * Problems in a piece of text, as codes with fixed messages (the text itself is never echoed).
 * mode 'goal': the strictest. 'input': data leaves of inputs and resolutions. 'library': instruction text
 * the library wrote (everything except the goal), where a verb like "click" is ordinary wording.
 */
export function findTextProblems(text, mode = 'goal') {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (typeof text !== 'string') {
    return problems;
  }
  if (URL_PATTERN.test(text)) {
    add('url', 'contains a URL or host');
  }
  if (mode !== 'input' && FILE_PATTERN.test(text)) {
    add('file', 'contains a page file name');
  }
  if (mode === 'input' ? PATH_WHOLE.test(text) : PATH_TOKEN.test(text)) {
    add('path', 'contains an absolute path');
  }
  const selectorPatterns = mode === 'library' ? LIBRARY_SELECTOR_PATTERNS : SELECTOR_PATTERNS;
  const selector =
    mode === 'input'
      ? SELECTOR_WHOLE.test(text) || SELECTOR_PATTERNS[2].test(text)
      : matchesAny(selectorPatterns, text);
  if (selector) {
    add('selector', 'contains a CSS selector');
  }
  if (mode === 'library') {
    return problems;
  }
  if ((mode === 'goal' ? CLICK_GOAL : CLICK_INPUT).test(text)) {
    add('click', 'contains a click instruction');
  }
  if (matchesAny(OTHER_INSTRUCTION_PATTERNS, text)) {
    add('control_instruction', 'names a control to operate (button, link, labelled field)');
  }
  if (matchesAny(EXPECTED_TEXT_PATTERNS, text)) {
    add('expected_text', 'states a phrase the agent should find');
  }
  if (mode === 'goal' ? matchesAny(STEP_PATTERNS, text) || thenCount(text) >= 2 : false) {
    add('steps', 'contains a step list or a count of steps');
  }
  if (mode === 'input' && matchesAny(INPUT_STEP_PATTERNS, text)) {
    add('steps', 'contains a step list');
  }
  return problems;
}

function stringLeaves(value, base, out = [], depth = 0) {
  if (typeof value === 'string') {
    out.push({ path: base, text: value });
  } else if (depth < 20 && Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, `${base}.${index}`, out, depth + 1));
  } else if (depth < 20 && isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      stringLeaves(item, base === '' ? key : `${base}.${key}`, out, depth + 1);
    }
  }
  return out;
}

function hasUnsafeKey(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (hasUnsafeKey(value[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with the runner
// ---------------------------------------------------------------------------------------------

/** A value that may be a function of the run-time sensitive values. */
export const resolveWithSensitive = (value, sensitive) =>
  typeof value === 'function' ? value(sensitive) : value;

/** inputDeclarations as the TaskRequest array: an array passes, { path: decl | boolean } is expanded. */
export function normalizeDeclarations(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (isPlainObject(raw)) {
    return Object.entries(raw).map(([declPath, value]) =>
      typeof value === 'boolean'
        ? { path: declPath, sensitive: value }
        : { path: declPath, ...value }
    );
  }
  return undefined;
}

/** Deep copy of `value` with every '$app' string replaced by the app's origin. */
export function substituteAppOrigin(value, origin) {
  if (value === APP_ORIGIN_TOKEN) {
    return origin;
  }
  if (Array.isArray(value)) {
    return value.map(item => substituteAppOrigin(item, origin));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteAppOrigin(item, origin)])
    );
  }
  return value;
}

/** Does the scenario hand sensitive values to the run (function forms, or a declared sensitive path)? */
export function declaresSensitive(scenario) {
  if (
    typeof scenario.inputs === 'function' ||
    typeof scenario.inputDeclarations === 'function' ||
    (scenario.resume ?? []).some(entry => typeof entry?.resolution === 'function')
  ) {
    return true;
  }
  const declarations = normalizeDeclarations(scenario.inputDeclarations) ?? [];
  if (declarations.some(declaration => declaration?.sensitive === true)) {
    return true;
  }
  return (scenario.resume ?? []).some(entry => {
    const resolution = entry?.resolution;
    return (
      isPlainObject(resolution) &&
      (resolution.sensitiveInputs !== undefined ||
        (normalizeDeclarations(resolution.inputDeclarations) ?? []).some(
          declaration => declaration?.sensitive === true
        ))
    );
  });
}

function valueAtPath(value, dotPath) {
  let current = value;
  for (const segment of String(dotPath).split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// validateScenario
// ---------------------------------------------------------------------------------------------

function checkKeys(value, allowed, where, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${where}.${key} is not a known key`);
    }
  }
}

function checkAppOrigins(value, where, errors) {
  if (!Array.isArray(value) || value.some(origin => origin !== APP_ORIGIN_TOKEN)) {
    errors.push(`${where} may only contain "${APP_ORIGIN_TOKEN}" (the origin of the started app)`);
  }
}

function checkDataLeaves(value, where, errors) {
  if (hasUnsafeKey(value)) {
    errors.push(`${where} has an unsafe key (__proto__, constructor or prototype)`);
  }
  for (const leaf of stringLeaves(value, '')) {
    for (const problem of findTextProblems(leaf.text, 'input')) {
      errors.push(`${where}${leaf.path === '' ? '' : `.${leaf.path}`}: ${problem.message}`);
    }
  }
}

function validateGoal(goal, errors) {
  if (typeof goal !== 'string') {
    errors.push('goal must be a string');
    return;
  }
  if (goal.trim().length < GOAL_MIN_CHARS) {
    errors.push(`goal must have at least ${GOAL_MIN_CHARS} characters`);
  }
  if (Buffer.byteLength(goal, 'utf8') > GOAL_MAX_BYTES) {
    errors.push(`goal is longer than ${GOAL_MAX_BYTES} UTF-8 bytes`);
  }
  if (HIDDEN_CHARACTERS.test(goal)) {
    errors.push('goal contains control, bidi or zero-width characters');
  }
  for (const problem of findTextProblems(goal, 'goal')) {
    errors.push(
      `goal ${problem.message} (${problem.code}): a goal is a caller's natural-language wish`
    );
  }
}

function validateInputsField(scenario, sensitive, errors) {
  if (scenario.inputs === undefined) {
    return;
  }
  let resolved = scenario.inputs;
  if (typeof resolved === 'function') {
    try {
      resolved = resolved(sensitive);
    } catch (error) {
      errors.push(`inputs function threw: ${String(error?.message ?? error).slice(0, 120)}`);
      return;
    }
  }
  if (!isPlainObject(resolved)) {
    errors.push('inputs must be an object or a function returning an object');
    return;
  }
  checkDataLeaves(resolved, 'inputs', errors);
}

/** A secret is never a literal in source: sensitive leaves of `inputs` must come from the generated values. */
function validateNoLiteralSecrets(scenario, sensitive, errors) {
  if (!isPlainObject(scenario.inputs)) {
    return;
  }
  let declarations;
  try {
    declarations = normalizeDeclarations(
      resolveWithSensitive(scenario.inputDeclarations, sensitive)
    );
  } catch {
    return;
  }
  for (const declaration of declarations ?? []) {
    if (
      declaration?.sensitive === true &&
      typeof declaration.path === 'string' &&
      valueAtPath(scenario.inputs, declaration.path) !== undefined
    ) {
      errors.push(
        `inputs.${declaration.path} is declared sensitive but written as a literal: make inputs a function of the run-time sensitive values`
      );
    }
  }
}

function validateBind(bind, where, errors) {
  if (!isPlainObject(bind)) {
    errors.push(`${where} must be an object`);
    return;
  }
  checkKeys(
    bind,
    ['origins', 'elementKinds', 'inputTypes', 'requireSensitiveElement'],
    where,
    errors
  );
  if (bind.origins !== undefined) {
    checkAppOrigins(bind.origins, `${where}.origins`, errors);
  }
  for (const key of ['elementKinds', 'inputTypes']) {
    if (
      bind[key] !== undefined &&
      (!Array.isArray(bind[key]) || bind[key].some(item => typeof item !== 'string'))
    ) {
      errors.push(`${where}.${key} must be an array of strings`);
    }
  }
  if (
    bind.requireSensitiveElement !== undefined &&
    typeof bind.requireSensitiveElement !== 'boolean'
  ) {
    errors.push(`${where}.requireSensitiveElement must be a boolean`);
  }
}

function validateDeclarations(raw, sensitive, errors) {
  if (raw === undefined) {
    return;
  }
  let resolved = raw;
  if (typeof resolved === 'function') {
    try {
      resolved = resolved(sensitive);
    } catch (error) {
      errors.push(
        `inputDeclarations function threw: ${String(error?.message ?? error).slice(0, 120)}`
      );
      return;
    }
  }
  const declarations = normalizeDeclarations(resolved);
  if (declarations === undefined) {
    errors.push(
      'inputDeclarations must be an array, an object keyed by path, or a function of those'
    );
    return;
  }
  declarations.forEach((declaration, index) => {
    const where = `inputDeclarations.${index}`;
    if (!isPlainObject(declaration)) {
      errors.push(`${where} must be an object`);
      return;
    }
    checkKeys(declaration, ['path', 'sensitive', 'description', 'bind', 'expose'], where, errors);
    if (typeof declaration.path !== 'string' || declaration.path.length === 0) {
      errors.push(`${where}.path must be a non-empty string`);
    }
    if (typeof declaration.sensitive !== 'boolean') {
      errors.push(`${where}.sensitive must be a boolean`);
    }
    if (declaration.description !== undefined && typeof declaration.description !== 'string') {
      errors.push(`${where}.description must be a string`);
    }
    if (declaration.expose !== undefined && !['label', 'preview'].includes(declaration.expose)) {
      errors.push(`${where}.expose must be 'label' or 'preview'`);
    }
    if (declaration.bind !== undefined) {
      validateBind(declaration.bind, `${where}.bind`, errors);
    }
  });
}

function validateAuthorization(authorization, errors) {
  if (authorization === undefined) {
    return;
  }
  if (!isPlainObject(authorization)) {
    errors.push('authorization must be an object');
    return;
  }
  checkKeys(
    authorization,
    ['operations', 'origins', 'effects', 'assumeUnclassifiedRoutine'],
    'authorization',
    errors
  );
  if (authorization.operations !== undefined) {
    if (
      !Array.isArray(authorization.operations) ||
      authorization.operations.some(operation => !HOST_OPERATIONS.includes(operation))
    ) {
      errors.push(`authorization.operations must be a subset of ${HOST_OPERATIONS.join(', ')}`);
    }
  }
  if (authorization.origins !== undefined) {
    checkAppOrigins(authorization.origins, 'authorization.origins', errors);
  }
  if (
    authorization.assumeUnclassifiedRoutine !== undefined &&
    typeof authorization.assumeUnclassifiedRoutine !== 'boolean'
  ) {
    errors.push('authorization.assumeUnclassifiedRoutine must be a boolean');
  }
  if (authorization.effects === undefined) {
    return;
  }
  if (!Array.isArray(authorization.effects)) {
    errors.push('authorization.effects must be an array');
    return;
  }
  authorization.effects.forEach((entry, index) => {
    const where = `authorization.effects.${index}`;
    if (typeof entry === 'string') {
      if (!COMMITMENT_EFFECTS.includes(entry)) {
        errors.push(`${where} must be one of ${COMMITMENT_EFFECTS.join(', ')}`);
      }
      return;
    }
    if (!isPlainObject(entry)) {
      errors.push(`${where} must be an effect name or a grant object`);
      return;
    }
    checkKeys(entry, ['effect', 'origins', 'maxUses', 'expiresAt', 'signatures'], where, errors);
    if (!COMMITMENT_EFFECTS.includes(entry.effect)) {
      errors.push(`${where}.effect must be one of ${COMMITMENT_EFFECTS.join(', ')}`);
    }
    if (entry.origins !== undefined) {
      checkAppOrigins(entry.origins, `${where}.origins`, errors);
    }
    if (entry.maxUses !== undefined && !isPositiveInteger(entry.maxUses)) {
      errors.push(`${where}.maxUses must be an integer >= 1`);
    }
    if (entry.expiresAt !== undefined && !Number.isFinite(entry.expiresAt)) {
      errors.push(`${where}.expiresAt must be a finite number`);
    }
    if (
      entry.signatures !== undefined &&
      (!Array.isArray(entry.signatures) || entry.signatures.some(item => typeof item !== 'string'))
    ) {
      errors.push(`${where}.signatures must be an array of strings`);
    }
  });
}

function validateRun(run, errors) {
  if (run === undefined) {
    return;
  }
  if (!isPlainObject(run)) {
    errors.push('run must be an object');
    return;
  }
  checkKeys(
    run,
    ['budgets', 'cancelAfterMs', 'cancelWhenFaultFires', 'allowRunLoss'],
    'run',
    errors
  );
  if (run.budgets !== undefined) {
    if (!isPlainObject(run.budgets)) {
      errors.push('run.budgets must be an object');
    } else {
      for (const [key, value] of Object.entries(run.budgets)) {
        if (!BUDGET_KEYS.includes(key)) {
          errors.push(`run.budgets.${key} is not a known budget`);
        } else if (!Number.isSafeInteger(value) || value < 0) {
          errors.push(`run.budgets.${key} must be an integer >= 0`);
        }
      }
    }
  }
  if (
    run.cancelAfterMs !== undefined &&
    (!isPositiveInteger(run.cancelAfterMs) || run.cancelAfterMs > MAX_CANCEL_AFTER_MS)
  ) {
    errors.push(`run.cancelAfterMs must be an integer between 1 and ${MAX_CANCEL_AFTER_MS}`);
  }
  if (run.allowRunLoss !== undefined && typeof run.allowRunLoss !== 'boolean') {
    errors.push('run.allowRunLoss must be a boolean');
  }
  if (run.cancelWhenFaultFires !== undefined && typeof run.cancelWhenFaultFires !== 'boolean') {
    errors.push('run.cancelWhenFaultFires must be a boolean');
  }
  if (run.cancelWhenFaultFires === true && run.cancelAfterMs === undefined) {
    errors.push('run.cancelWhenFaultFires requires cancelAfterMs');
  }
}

const APPROVAL_KEYS = ['kind', 'decision', 'scope', 'maxUses'];

/**
 * The decision part of an approval resolution, whichever way the scenario wrote it: flat
 * { decision, scope, maxUses } or the TaskResolution shape { kind: 'approval', resolution: { decision, ... } }.
 * The runner binds approvalId, nonce, digest and contextDigest from the paused approval.
 */
export function approvalChoice(resolution) {
  if (!isPlainObject(resolution)) {
    return {};
  }
  return isPlainObject(resolution.resolution) ? resolution.resolution : resolution;
}

function validateResolutionShape(on, resolution, where, errors) {
  if (!isPlainObject(resolution)) {
    errors.push(`${where} must be an object or a function returning an object`);
    return;
  }
  checkDataLeaves(resolution, where, errors);
  if (on === 'needs_input') {
    checkKeys(
      resolution,
      ['kind', 'inputs', 'inputDeclarations', 'sensitiveInputs', 'omitSensitivePaths', 'options'],
      where,
      errors
    );
    if (resolution.kind !== undefined && resolution.kind !== 'inputs') {
      errors.push(`${where}.kind must be 'inputs' for a needs_input pause`);
    }
    if (
      resolution.inputs === undefined &&
      resolution.sensitiveInputs === undefined &&
      resolution.omitSensitivePaths === undefined
    ) {
      errors.push(`${where} needs inputs, sensitiveInputs or omitSensitivePaths`);
    }
    for (const key of ['inputs', 'sensitiveInputs']) {
      if (resolution[key] !== undefined && !isPlainObject(resolution[key])) {
        errors.push(`${where}.${key} must be an object`);
      }
    }
    if (
      resolution.omitSensitivePaths !== undefined &&
      (!Array.isArray(resolution.omitSensitivePaths) ||
        resolution.omitSensitivePaths.some(item => typeof item !== 'string'))
    ) {
      errors.push(`${where}.omitSensitivePaths must be an array of strings`);
    }
    if (resolution.inputDeclarations !== undefined) {
      validateDeclarations(resolution.inputDeclarations, undefined, errors);
    }
    return;
  }
  const nested = resolution.resolution !== undefined;
  checkKeys(resolution, nested ? ['kind', 'resolution'] : APPROVAL_KEYS, where, errors);
  if (resolution.kind !== undefined && resolution.kind !== 'approval') {
    errors.push(`${where}.kind must be 'approval' for an awaiting_approval pause`);
  }
  let choice = resolution;
  if (nested) {
    if (!isPlainObject(resolution.resolution)) {
      errors.push(`${where}.resolution must be an object`);
      return;
    }
    choice = resolution.resolution;
    checkKeys(choice, ['decision', 'scope', 'maxUses'], `${where}.resolution`, errors);
  }
  const at = nested ? `${where}.resolution` : where;
  if (!['approve', 'deny'].includes(choice.decision)) {
    errors.push(`${at}.decision must be 'approve' or 'deny'`);
  }
  if (choice.scope !== undefined && !['once', 'run'].includes(choice.scope)) {
    errors.push(`${at}.scope must be 'once' or 'run'`);
  }
  if (choice.maxUses !== undefined && !isPositiveInteger(choice.maxUses)) {
    errors.push(`${at}.maxUses must be an integer >= 1`);
  }
}

function validateResume(resume, sensitive, errors) {
  if (resume === undefined) {
    return;
  }
  if (!Array.isArray(resume)) {
    errors.push('resume must be an array');
    return;
  }
  resume.forEach((entry, index) => {
    const where = `resume.${index}`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} must be an object`);
      return;
    }
    checkKeys(entry, ['on', 'resolution'], where, errors);
    if (!PAUSE_STATUSES.includes(entry.on)) {
      errors.push(`${where}.on must be one of ${PAUSE_STATUSES.join(', ')}`);
      return;
    }
    if (isPlainObject(entry.resolution) && entry.resolution.sensitiveInputs !== undefined) {
      errors.push(
        `${where}.resolution.sensitiveInputs is a literal: make the resolution a function of the run-time sensitive values`
      );
    }
    let resolution = entry.resolution;
    if (typeof resolution === 'function') {
      try {
        resolution = resolution(sensitive);
      } catch (error) {
        errors.push(
          `${where}.resolution function threw: ${String(error?.message ?? error).slice(0, 120)}`
        );
        return;
      }
    }
    validateResolutionShape(entry.on, resolution, `${where}.resolution`, errors);
  });
}

function validateDelay(config, where, errors) {
  if (config.ms === undefined) {
    return;
  }
  if (typeof config.ms !== 'number' || !Number.isFinite(config.ms) || config.ms < 0) {
    errors.push(`${where}.ms must be a finite number >= 0`);
  } else if (config.ms > MAX_CANCEL_AFTER_MS) {
    errors.push(`${where}.ms must be <= ${MAX_CANCEL_AFTER_MS}`);
  }
}

function validateInject(scenario, errors) {
  const { inject } = scenario;
  if (scenario.kind === 'live') {
    if (inject !== undefined) {
      errors.push(
        'inject is only allowed on a scenario of kind fault: a live scenario injects nothing'
      );
    }
    return;
  }
  if (scenario.kind !== 'fault') {
    return;
  }
  if (!isPlainObject(inject)) {
    errors.push('a scenario of kind fault needs an inject object with a decider and/or host block');
    return;
  }
  checkKeys(inject, ['decider', 'host'], 'inject', errors);
  if (inject.decider === undefined && inject.host === undefined) {
    errors.push('inject needs a decider block, a host block, or both');
  }
  const { decider, host } = inject;
  if (decider !== undefined) {
    if (!isPlainObject(decider)) {
      errors.push('inject.decider must be an object');
    } else {
      checkKeys(decider, DECIDER_KEYS, 'inject.decider', errors);
      if (!DECIDER_MODES.includes(decider.mode)) {
        errors.push(`inject.decider.mode must be one of ${DECIDER_MODES.join(', ')}`);
      }
      if (!isPositiveInteger(decider.atDecision)) {
        errors.push('inject.decider.atDecision must be an integer >= 1');
      }
      validateDelay(decider, 'inject.decider', errors);
      if (decider.ms !== undefined && decider.mode !== 'slow') {
        errors.push('inject.decider.ms is only valid for mode slow');
      }
      if (
        decider.style !== undefined &&
        (decider.mode !== 'throw' || !['reject', 'result'].includes(decider.style))
      ) {
        errors.push("inject.decider.style is only valid for mode throw: 'reject' or 'result'");
      }
      if (
        decider.stage !== undefined &&
        (decider.mode !== 'noneAppropriate' || !['action', 'argument'].includes(decider.stage))
      ) {
        errors.push(
          "inject.decider.stage is only valid for mode noneAppropriate: 'action' or 'argument'"
        );
      }
    }
  }
  if (host !== undefined) {
    if (!isPlainObject(host)) {
      errors.push('inject.host must be an object');
    } else {
      checkKeys(host, HOST_KEYS, 'inject.host', errors);
      if (!HOST_MODES.includes(host.mode)) {
        errors.push(`inject.host.mode must be one of ${HOST_MODES.join(', ')}`);
      }
      if (!isPositiveInteger(host.atExecution)) {
        errors.push('inject.host.atExecution must be an integer >= 1');
      }
      if (
        host.operation !== undefined &&
        (!['lostAfterCommit', 'timeoutAfterCommit'].includes(host.mode) ||
          !HOST_OPERATIONS.includes(host.operation) ||
          ['READ', 'WAIT', 'SCROLL', 'NAVIGATE'].includes(host.operation))
      ) {
        errors.push(
          'inject.host.operation is only a mutating target operation for after-commit faults'
        );
      }
      validateDelay(host, 'inject.host', errors);
      if (host.ms !== undefined && host.mode !== 'slowObserve') {
        errors.push('inject.host.ms is only valid for mode slowObserve');
      }
      if (
        host.timing !== undefined &&
        (host.mode !== 'contextDestroyed' || !['before', 'during'].includes(host.timing))
      ) {
        errors.push(
          "inject.host.timing is only valid for mode contextDestroyed: 'before' or 'during'"
        );
      }
    }
  }
}

function validateAppOptions(scenario, apps, errors) {
  for (const key of ['initial', 'faults']) {
    if (scenario[key] !== undefined && !isPlainObject(scenario[key])) {
      errors.push(`${key} must be an object`);
    } else if (scenario[key] !== undefined) {
      checkDataLeaves(scenario[key], key, errors);
    }
  }
  const app = isPlainObject(apps) ? apps[scenario.family] : undefined;
  if (!isPlainObject(app)) {
    return;
  }
  const variants = (app.variants ?? []).map(variant => variant.id);
  if (variants.length > 0 && !variants.includes(scenario.variant)) {
    errors.push(`variant ${String(scenario.variant)} is not offered by the ${scenario.family} app`);
  }
  const faultNames = (app.faults ?? []).map(fault => fault.name);
  const initialNames = (app.initialOptions ?? []).map(option => option.name);
  if (isPlainObject(scenario.faults)) {
    for (const key of Object.keys(scenario.faults)) {
      if (!faultNames.includes(key)) {
        errors.push(`faults.${key} is not a fault of the ${scenario.family} app`);
      }
    }
  }
  if (isPlainObject(scenario.initial)) {
    for (const key of Object.keys(scenario.initial)) {
      if (!initialNames.includes(key)) {
        errors.push(`initial.${key} is not an initial option of the ${scenario.family} app`);
      }
    }
  }
}

/**
 * Strict check of the v1 scenario shape: unknown keys, forbidden goal and input content, kind-specific
 * inject rules, expectStatus, resume entries. With `options.apps` ({ family: describe() }) the app
 * options (initial, faults, variant) are checked against what the app declares.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScenario(scenario, options = {}) {
  try {
    return validateScenarioUnchecked(scenario, options);
  } catch (error) {
    return {
      ok: false,
      errors: [`validation threw: ${String(error?.message ?? error).slice(0, 120)}`],
    };
  }
}

function validateScenarioUnchecked(scenario, options) {
  const errors = [];
  if (!isPlainObject(scenario)) {
    return { ok: false, errors: ['scenario must be an object'] };
  }
  const sensitive = options.sensitive ?? generateSensitiveValues('scenario-validate');
  checkKeys(scenario, TOP_LEVEL_KEYS, 'scenario', errors);

  if (typeof scenario.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id)) {
    errors.push('id must be kebab-case (lowercase letters, digits and single dashes)');
  } else if (scenario.id.length > 80) {
    errors.push('id must be at most 80 characters');
  }
  if (!FAMILIES.includes(scenario.family)) {
    errors.push(`family must be one of ${FAMILIES.join(', ')}`);
  }
  if (!VARIANTS.includes(scenario.variant)) {
    errors.push(`variant must be one of ${VARIANTS.join(', ')}`);
  }
  if (!KINDS.includes(scenario.kind)) {
    errors.push(`kind must be one of ${KINDS.join(', ')}`);
  }
  if (
    typeof scenario.title !== 'string' ||
    scenario.title.trim().length === 0 ||
    /[\r\n]/.test(scenario.title) ||
    scenario.title.length > 160
  ) {
    errors.push('title must be a single line of 1 to 160 characters');
  }

  validateGoal(scenario.goal, errors);
  validateInputsField(scenario, sensitive, errors);
  validateDeclarations(scenario.inputDeclarations, sensitive, errors);
  validateNoLiteralSecrets(scenario, sensitive, errors);
  validateAuthorization(scenario.authorization, errors);
  validateAppOptions(scenario, options.apps, errors);
  validateRun(scenario.run, errors);
  if (
    scenario.run?.cancelWhenFaultFires === true &&
    (scenario.kind !== 'fault' || scenario.inject?.decider?.mode !== 'slow')
  ) {
    errors.push('run.cancelWhenFaultFires requires a slow decider fault');
  }
  validateResume(scenario.resume, sensitive, errors);
  validateInject(scenario, errors);

  const statuses = Array.isArray(scenario.expectStatus)
    ? scenario.expectStatus
    : [scenario.expectStatus];
  if (
    scenario.expectStatus === undefined ||
    statuses.length === 0 ||
    statuses.some(status => !TASK_STATUSES.includes(status)) ||
    new Set(statuses).size !== statuses.length
  ) {
    errors.push(
      `expectStatus must be a status or a non-empty list of distinct statuses (${TASK_STATUSES.join(', ')})`
    );
  }
  if (typeof scenario.expect !== 'function') {
    errors.push('expect must be a function (app, result, page, ctx)');
  }
  if (scenario.forbiddenInstructionText !== undefined) {
    const list = scenario.forbiddenInstructionText;
    if (
      !Array.isArray(list) ||
      list.some(item => typeof item !== 'string' || item.trim().length < 3)
    ) {
      errors.push('forbiddenInstructionText must be an array of strings of at least 3 characters');
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------------------
// Loading scenario files
// ---------------------------------------------------------------------------------------------

const isScenarioFile = name =>
  name.endsWith('.mjs') &&
  !name.endsWith('.controls.mjs') &&
  !name.endsWith('.check.mjs') &&
  !name.startsWith('_') &&
  name !== 'index.mjs';

const looksLikeScenario = value =>
  isPlainObject(value) &&
  ['id', 'family', 'goal', 'expect', 'expectStatus'].some(key => key in value);

function collectScenarios(moduleNamespace) {
  const found = [];
  const seen = new Set();
  const push = value => {
    if (!seen.has(value)) {
      seen.add(value);
      found.push(value);
    }
  };
  for (const [name, value] of Object.entries(moduleNamespace)) {
    const container = name === 'scenarios' || name === 'scenario' || name === 'default';
    if (Array.isArray(value) && (container || value.every(looksLikeScenario)) && value.length > 0) {
      value.forEach(item => push(item));
    } else if (isPlainObject(value) && (container || looksLikeScenario(value))) {
      push(value);
    }
  }
  return found;
}

/**
 * Imports every scenario file of `dir` (*.mjs except *.controls.mjs, *.check.mjs and files starting with
 * an underscore). A file exports scenarios as `scenarios` (array), `scenario`, or any named export that
 * is a scenario object or an array of them. Import failures and files without scenarios come back in
 * `errors`; nothing is validated here.
 *
 * @returns {Promise<{ entries: { file: string, scenario: object }[], errors: { file: string, message: string }[] }>}
 */
export async function loadScenarioFiles(dir) {
  const entries = [];
  const errors = [];
  if (!fs.existsSync(dir)) {
    return { entries, errors: [{ file: dir, message: 'scenario directory does not exist' }] };
  }
  const files = fs.readdirSync(dir).filter(isScenarioFile).sort();
  for (const file of files) {
    try {
      const namespace = await import(pathToFileURL(path.join(dir, file)).href);
      const scenarios = collectScenarios(namespace);
      if (scenarios.length === 0) {
        errors.push({ file, message: 'no scenario export found (export scenarios as an array)' });
      }
      scenarios.forEach(scenario => entries.push({ file, scenario }));
    } catch (error) {
      errors.push({
        file,
        message: `import failed: ${String(error?.message ?? error).split('\n')[0]}`,
      });
    }
  }
  return { entries, errors };
}

/** Scenario ids that occur more than once, with the files that define them. */
export function findDuplicateIds(entries) {
  const byId = new Map();
  for (const { file, scenario } of entries) {
    const id = scenario?.id;
    if (typeof id === 'string') {
      byId.set(id, [...(byId.get(id) ?? []), file]);
    }
  }
  return [...byId].filter(([, files]) => files.length > 1).map(([id, files]) => ({ id, files }));
}

/** Every scenario of `dir`. Throws one Error listing import failures and duplicate ids. */
export async function loadScenarios(dir) {
  const { entries, errors } = await loadScenarioFiles(dir);
  const problems = [
    ...errors.map(error => `${error.file}: ${error.message}`),
    ...findDuplicateIds(entries).map(
      item => `duplicate scenario id ${item.id} in ${item.files.join(', ')}`
    ),
  ];
  if (problems.length > 0) {
    throw new Error(`cannot load scenarios: ${problems.join('; ')}`);
  }
  return entries.map(entry => entry.scenario);
}
