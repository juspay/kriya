import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AutomationEngine } from '@/core/AutomationEngine';
import { ContextCapture } from '@/context/ContextCapture';
import { EnhancedFormDetector } from '@/forms/EnhancedFormDetector';
import { FormRegistry } from '@/forms/FormRegistry';
import { createRedactor } from '@/utils/redact';
import type {
  ActionCommand,
  AutomationConfig,
  AutomationEvent,
  EventType,
  ExecutionResult,
  FormLibrary,
  MutationGuard,
  Redactor,
} from '@/types';
import { DEFAULT_CONFIG, TASK_REDACTED } from '@/types';
import { installLayoutStubs, mountHtml, resetDom } from './helpers/domHarness';

type FakeMethod = 'click' | 'fill' | 'wait';
type FakeHandler = (options: unknown, guard: MutationGuard) => Promise<unknown>;
type FakeDom = { readonly handlers: Partial<Record<FakeMethod, FakeHandler>> };
type Recorded = { readonly __recorded: Error[] };

// Every AutomationError the library constructs during a test is recorded, so the thrown messages and
// contexts can be scanned even though the executor never lets them escape.
jest.mock('@/types', () => {
  const actual = jest.requireActual('@/types') as typeof import('@/types');
  const recorded: Error[] = [];
  class RecordingError extends actual.AutomationError {
    constructor(
      message: string,
      code: ConstructorParameters<typeof actual.AutomationError>[1],
      context?: ConstructorParameters<typeof actual.AutomationError>[2]
    ) {
      super(message, code, context);
      recorded.push(this);
    }
  }
  return { ...actual, AutomationError: RecordingError, __recorded: recorded };
});

jest.mock('@/actions/DOMActions', () => {
  const fakeDom: FakeDom = { handlers: {} };
  const dispatch = async (
    method: FakeMethod,
    options: unknown,
    guard: MutationGuard
  ): Promise<unknown> => {
    const handler = fakeDom.handlers[method];
    if (handler) {
      return handler(options, guard);
    }
    if (method !== 'wait') {
      guard.commit();
    }
    return undefined;
  };
  class DOMActions {
    public initialize(): void {}
    public dispose(): void {}
    public click(options: unknown, guard: MutationGuard): Promise<unknown> {
      return dispatch('click', options, guard);
    }
    public fill(options: unknown, guard: MutationGuard): Promise<unknown> {
      return dispatch('fill', options, guard);
    }
    public wait(options: unknown, guard: MutationGuard): Promise<unknown> {
      return dispatch('wait', options, guard);
    }
  }
  return { DOMActions, __fakeDom: fakeDom };
});

const fakeDom = (jest.requireMock('@/actions/DOMActions') as { __fakeDom: FakeDom }).__fakeDom;
const recorded = (jest.requireMock('@/types') as unknown as Recorded).__recorded;

const ALL_EVENTS: readonly EventType[] = [
  'form_registered',
  'form_unregistered',
  'form_filled',
  'form_submitted',
  'action_started',
  'action_completed',
  'action_failed',
  'context_captured',
  'screenshot_taken',
];

const unique = (tag: string): string => `${tag}-${randomBytes(8).toString('hex')}`;

function show(value: unknown): string {
  if (value instanceof Element) {
    return value.outerHTML;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ''}\n${show((value as { context?: unknown }).context)}`;
  }
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, inner: unknown) =>
        inner instanceof Error ? show(inner) : inner
      );
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

let consoleSpies: jest.SpyInstance[] = [];
let errorMark = 0;

function consoleText(): string {
  return consoleSpies
    .flatMap(spy => spy.mock.calls as unknown[][])
    .map(call => call.map(show).join(' '))
    .join('\n');
}

function consoleCallCount(): number {
  return consoleSpies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

function thrownText(): string {
  return recorded.slice(errorMark).map(show).join('\n');
}

beforeEach(() => {
  consoleSpies = (['info', 'log', 'warn', 'error', 'debug'] as const).map(method =>
    jest.spyOn(console, method).mockImplementation(() => undefined)
  );
  errorMark = recorded.length;
  for (const key of Object.keys(fakeDom.handlers)) {
    delete fakeDom.handlers[key as FakeMethod];
  }
  document.body.innerHTML = '';
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Mode = { readonly name: string; readonly useRedactor: boolean; readonly declare: boolean };
const MODES: readonly Mode[] = [
  { name: 'with a redactor only', useRedactor: true, declare: false },
  { name: 'with sensitiveParameters only', useRedactor: false, declare: true },
  { name: 'with both', useRedactor: true, declare: true },
];

describe.each(MODES)('executor and engine output $name', mode => {
  let secret: string;
  let redactor: Redactor | undefined;
  let engine: AutomationEngine;
  let events: AutomationEvent[];
  const results: ExecutionResult[] = [];

  const command = (
    type: ActionCommand['type'],
    parameters: Record<string, string>,
    sensitiveNames: readonly string[] = ['value']
  ): ActionCommand => ({
    type,
    parameters,
    ...(mode.declare ? { sensitiveParameters: sensitiveNames } : {}),
  });

  async function run(
    action: ActionCommand,
    options?: Parameters<AutomationEngine['executeAction']>[1]
  ): Promise<ExecutionResult> {
    const result = await engine.executeAction(action, options);
    results.push(result);
    return result;
  }

  function leaks(): string[] {
    const haystacks: Record<string, string> = {
      events: show(events),
      results: show(results),
      console: consoleText(),
      thrown: thrownText(),
    };
    return Object.keys(haystacks).filter(name => (haystacks[name] as string).includes(secret));
  }

  beforeEach(() => {
    secret = unique('Sx9-secret');
    redactor = mode.useRedactor ? createRedactor({ secrets: [secret] }) : undefined;
    const config: Partial<AutomationConfig> = { screenshotOnError: false, redactor };
    engine = new AutomationEngine(config);
    engine.initialize();
    events = [];
    results.length = 0;
    for (const type of ALL_EVENTS) {
      engine.addEventListener(type, event => events.push(event));
    }
    document.body.innerHTML = '<input id="pw" placeholder="Password"><button id="go">Go</button>';
  });

  afterEach(() => {
    engine.dispose();
  });

  test('a successful fill emits the marker instead of the value and keeps the other parameters', async () => {
    const result = await run(
      command('fill', { selector: 'Password', value: secret, description: 'The password box' })
    );

    expect(result.success).toBe(true);
    const started = events.find(event => event.type === 'action_started');
    const parameters = started?.data?.parameters as Record<string, string>;
    expect(parameters.value).toBe(redactor?.replacement ?? TASK_REDACTED);
    expect(parameters.selector).toBe('Password');
    expect(parameters.description).toBe('The password box');
    expect(events.map(event => event.type)).toContain('action_completed');
    expect(leaks()).toEqual([]);
  });

  test('a DOM layer error that echoes the value is scrubbed in the result and in the failure event', async () => {
    fakeDom.handlers.fill = async () => {
      throw new Error(`Option not found in select: ${secret}`);
    };

    const result = await run(command('fill', { selector: 'Password', value: secret }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Option not found in select');
    expect(result.error).not.toContain(secret);
    const failed = events.find(event => event.type === 'action_failed');
    expect(failed?.data?.error).toContain('Option not found in select');
    expect(leaks()).toEqual([]);
  });

  test('a thrown AutomationError with the value in its message is scrubbed too', async () => {
    const { AutomationError } = jest.requireMock('@/types') as typeof import('@/types');
    let thrownByFake: Error | undefined;
    fakeDom.handlers.click = async () => {
      thrownByFake = new AutomationError(`Click failed near ${secret}`, 'EXECUTION_FAILED');
      throw thrownByFake;
    };

    const result = await run(command('click', { selector: '#go', value: secret }));
    // The stand-in layer itself is the one place allowed to hold the value; the library must not copy it.
    recorded.splice(recorded.indexOf(thrownByFake as Error), 1);

    expect(result.errorCode).toBe('EXECUTION_FAILED');
    expect(result.error).toContain('Click failed near');
    expect(result.error).not.toContain(secret);
    expect(leaks()).toEqual([]);
  });

  test('timeout, cancellation, validation and a missing target never echo the value', async () => {
    fakeDom.handlers.fill = async () => {
      await new Promise<void>(resolveSleep => setTimeout(resolveSleep, 150));
    };
    const timedOut = await run({
      ...command('fill', { selector: 'Password', value: secret }),
      timeout: 20,
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(command('fill', { selector: 'Password', value: secret }), {
      signal: controller.signal,
    });
    const noTarget = await run(command('fill', { value: secret, strict: 'true' }));
    const invalid = await run(
      command('click', { strict: 'true', selector: '#go', clickCount: secret }, ['clickCount']),
      { strict: true }
    );
    const strictFill = await run(
      command('fill', { selector: 'Password', value: secret, strict: 'true' }),
      { strict: true }
    );

    expect([
      timedOut.errorCode,
      cancelled.errorCode,
      noTarget.errorCode,
      invalid.errorCode,
    ]).toEqual(['EXECUTION_TIMEOUT', 'EXECUTION_CANCELLED', 'INVALID_ACTION', 'VALIDATION_FAILED']);
    expect(strictFill.success).toBe(true);
    expect(leaks()).toEqual([]);
  });

  test('a missing or malformed argument never carries the action into a message or context', async () => {
    const missingValue = await run(command('fill', { selector: secret }, ['selector']));
    const badPayload = await run(command('fillForm', { fields: `{"pw":"${secret}"` }, ['fields']));
    const noKey = await run(command('press', { selector: secret }, ['selector']));
    const noUrl = await run(command('navigate', { waitForLoad: secret }, ['waitForLoad']));

    for (const result of [missingValue, badPayload, noKey, noUrl]) {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('VALIDATION_FAILED');
    }
    expect(recorded.slice(errorMark).length).toBeGreaterThan(0);
    for (const error of recorded.slice(errorMark)) {
      const contextKeys = Object.keys((error as { context?: object }).context ?? {});
      expect(contextKeys).not.toContain('action');
    }
    expect(leaks()).toEqual([]);
  });

  test('a result string that carries the value is scrubbed in the completion event, large strings are left alone', async () => {
    const capture = jest
      .spyOn(ContextCapture.prototype, 'captureScreenshot')
      .mockResolvedValueOnce(`data:image/png;base64,${secret}`)
      .mockResolvedValueOnce(`data:${'A'.repeat(30000)}`);

    const small = await run(command('screenshot', { value: secret }));
    const large = await run(command('screenshot', { value: secret }));
    const completed = events.filter(event => event.type === 'action_completed');

    expect([small.success, large.success]).toEqual([true, true]);
    expect(show(completed[0]?.data)).not.toContain(secret);
    expect(show(completed[0]?.data)).toContain('data:image/png;base64,');
    expect((completed[1]?.data?.result as string).length).toBe(30005);
    capture.mockRestore();
  });

  test('a parameters bag that is not an object is rejected without echoing it', async () => {
    const noBag = await run({ type: 'fill', parameters: secret } as unknown as ActionCommand);

    expect(noBag).toMatchObject({ success: false, errorCode: 'VALIDATION_FAILED', effect: 'none' });
    expect(leaks()).toEqual([]);
  });
});

describe('FormRegistry and EnhancedFormDetector console output', () => {
  const secret = unique('Fx7-secret');
  const formHtml =
    '<form id="login"><input name="user" type="text"><input name="pw" type="password"></form>';

  function makeEngine(debugMode: boolean, extra: Partial<AutomationConfig> = {}): AutomationEngine {
    const engine = new AutomationEngine({ screenshotOnError: false, debugMode, ...extra });
    engine.initialize();
    return engine;
  }

  test('fillForm without a formId logs nothing at all with debugMode false', async () => {
    document.body.innerHTML = formHtml;
    const engine = makeEngine(false);

    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: { fields: JSON.stringify({ pw: secret }) },
    });

    expect(result.success).toBe(true);
    expect((document.querySelector('input[name=pw]') as HTMLInputElement).value).toBe(secret);
    expect(consoleCallCount()).toBe(0);
    engine.dispose();
  });

  test('fillForm with a formId logs nothing at all with debugMode false', async () => {
    document.body.innerHTML = formHtml;
    const engine = makeEngine(false);

    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: { formId: 'login', fields: JSON.stringify({ pw: secret }) },
    });

    expect(result.success).toBe(true);
    expect(consoleCallCount()).toBe(0);
    engine.dispose();
  });

  test.each([
    ['without a formId', {}],
    ['with a formId', { formId: 'login' }],
  ])(
    'with debugMode true the log is still produced, but without the value (%s)',
    async (_label, extra) => {
      document.body.innerHTML = formHtml;
      const engine = makeEngine(true);

      const result = await engine.executeAction({
        type: 'fillForm',
        parameters: { ...extra, fields: JSON.stringify({ pw: secret }) },
      });

      expect(result.success).toBe(true);
      expect(consoleCallCount()).toBeGreaterThan(0);
      expect(consoleText()).not.toContain(secret);
      engine.dispose();
    }
  );

  test('the registry debug output scrubs known secrets and error messages when a redactor is configured', () => {
    const redactor = createRedactor({ secrets: [secret] });
    const registry = new FormRegistry({ ...DEFAULT_CONFIG, debugMode: true, redactor });
    registry.initialize();
    const log = registry as unknown as { _forceLog(...args: unknown[]): void };

    const before = consoleCallCount();

    log._forceLog(`a line with ${secret}`, new Error(`error with ${secret}`), { note: secret });

    expect(consoleCallCount() - before).toBe(1);
    expect(consoleText()).not.toContain(secret);
  });

  test('the SelectBox and batch paths of the registry mask the value', () => {
    jest.useFakeTimers();
    document.body.innerHTML =
      '<div data-selectbox-value="Plan"><button id="b" data-value="OLD-1234" type="button"><span data-button-text="t"></span></button></div><div data-dropdown="dropdown"><div data-dropdown-value="other">Other</div></div>';
    const registry = new FormRegistry({ ...DEFAULT_CONFIG, debugMode: true });
    registry.initialize();
    const internals = registry as unknown as {
      _fillReScriptSelectBox(element: HTMLElement, value: string): void;
      _batchFillFields(
        api: { change?: (field: string, value: unknown) => void },
        values: Record<string, unknown>
      ): void;
      _filterValidFields(fields: Record<string, unknown>): Record<string, string>;
    };

    internals._fillReScriptSelectBox(document.getElementById('b') as HTMLElement, secret);
    jest.advanceTimersByTime(500);
    internals._batchFillFields({ change: () => undefined }, { pw: secret });
    internals._filterValidFields({ pw: secret, empty: '' });

    expect(consoleCallCount()).toBeGreaterThan(0);
    expect(consoleText()).not.toContain(secret);
    expect(consoleText()).not.toContain('OLD-1234');
  });

  test('the detector masks values on its native, JSON, SelectBox and modified-form paths', () => {
    jest.useFakeTimers();
    document.body.innerHTML = `${formHtml}<div data-component-field-wrapper="plan"><div data-selectbox-value="Plan"><button id="sb" data-value="OLD-5678" type="button"></button></div></div><div data-dropdown="dropdown"><div data-dropdown-value="other">Other</div></div>`;
    const detector = new EnhancedFormDetector({ debugMode: true, autoDetect: true });
    const formId = detector.getForms().find(form => form.formLibrary === 'native')?.id as string;
    const internals = detector as unknown as {
      forms: Map<string, unknown>;
      setReScriptSelectBoxValue(button: HTMLButtonElement, value: string): boolean;
    };

    expect(detector.fillAnyForm({ pw: secret })).toBe(true);
    expect(detector.setFieldValue(formId, 'user', secret)).toBe(true);
    expect(detector.isFormModified(formId)).toBe(true);
    internals.forms.set('rff', {
      id: 'rff',
      formLibrary: 'react-final-form',
      formApi: { change: (): void => undefined },
      fields: new Map([['f', { name: 'f', type: 'text', value: '', initialValue: '' }]]),
    });
    detector.setFieldValue('rff', 'f', `["${secret}"]`);
    detector.setFieldValue('rff', 'f', `{"${secret}`);
    detector.setFieldValue('rff', 'f', secret);
    internals.forms.set('rff-throws', {
      id: 'rff-throws',
      formLibrary: 'react-final-form',
      formApi: {
        change: (): void => {
          throw new Error(`api rejected ${secret}`);
        },
      },
      fields: new Map([['f', { name: 'f', type: 'text', value: '', initialValue: '' }]]),
    });
    detector.setFieldValue('rff-throws', 'f', secret);
    internals.setReScriptSelectBoxValue(document.getElementById('sb') as HTMLButtonElement, secret);
    jest.advanceTimersByTime(500);

    expect(consoleCallCount()).toBeGreaterThan(0);
    expect(consoleText()).not.toContain(secret);
    expect(consoleText()).not.toContain('OLD-5678');
  });

  test('the detector defaults to debugMode true on its own, so the registry must pass its own flag', () => {
    document.body.innerHTML = formHtml;
    const quiet = new FormRegistry({ ...DEFAULT_CONFIG, debugMode: false });
    quiet.initialize();
    const tryDetector = quiet as unknown as {
      _tryEnhancedFormDetector(fields: Record<string, unknown>): unknown;
    };

    tryDetector._tryEnhancedFormDetector({ pw: secret });

    expect(consoleCallCount()).toBe(0);
  });

  test('ContextCapture debug output hides field values and element dumps', () => {
    document.body.innerHTML =
      '<div id="w" data-component-field-wrapper="pay"><label data-form-label="Pay"></label><input name="pay" value="CAP-VALUE-1"><div data-selectbox-value="x"><button data-value="CAP-VALUE-2"><span data-button-text="CAP-VALUE-3"></span></button></div></div>';
    const capture = new ContextCapture({ ...DEFAULT_CONFIG, debugMode: true });
    capture.initialize();
    const internals = capture as unknown as {
      _detectReScriptSelectBoxFields(): unknown[];
      _extractCustomFieldInfo(wrapper: HTMLElement, index: number): unknown;
    };

    expect(internals._detectReScriptSelectBoxFields()).toHaveLength(1);
    expect(
      internals._extractCustomFieldInfo(document.getElementById('w') as HTMLElement, 0)
    ).not.toBeNull();

    expect(consoleCallCount()).toBeGreaterThan(0);
    for (const value of ['CAP-VALUE-1', 'CAP-VALUE-2', 'CAP-VALUE-3']) {
      expect(consoleText()).not.toContain(value);
    }
  });
});

describe('the event of a sensitive parameter hides even its blankness', () => {
  test('a blank sensitive value is emitted as the marker, not as an empty string', async () => {
    document.body.innerHTML = '<input id="pw" placeholder="Password">';
    const engine = new AutomationEngine({ screenshotOnError: false });
    engine.initialize();
    const events: AutomationEvent[] = [];
    engine.addEventListener('action_started', event => events.push(event));

    await engine.executeAction({
      type: 'fill',
      parameters: { selector: 'Password', value: '' },
      sensitiveParameters: ['value'],
    });

    const parameters = events[0]?.data?.parameters as Record<string, string>;
    expect(parameters.value).toBe(TASK_REDACTED);
    expect(parameters.selector).toBe('Password');
    engine.dispose();
  });
});

describe('ContextCapture debug net', () => {
  const secret = unique('Cx3-secret');

  test.each([true, false])(
    'scrubs strings, errors and objects by secret, redactor present: %s',
    withRedactor => {
      const redactor = withRedactor ? createRedactor({ secrets: [secret] }) : undefined;
      const capture = new ContextCapture({ ...DEFAULT_CONFIG, debugMode: true, redactor });
      const log = capture as unknown as {
        _log(...args: unknown[]): void;
        _warn(...args: unknown[]): void;
      };
      document.body.innerHTML = `<input id="dump" value="${secret}">`;
      const element = document.getElementById('dump') as HTMLElement;

      log._log(`text ${secret}`, new Error(`failure ${secret}`), { note: secret }, element);
      log._warn(`warn ${secret}`, new Error(`failure ${secret}`));

      const text = consoleText();
      expect(text).not.toContain('value=');
      expect(text).toContain('<input>');
      // Without a redactor nothing knows the secret, so only the element dump is neutralized.
      expect(text.includes(secret)).toBe(!withRedactor);
    }
  );

  test('logs nothing when debugMode is off', () => {
    const capture = new ContextCapture({ ...DEFAULT_CONFIG, debugMode: false });
    const log = capture as unknown as { _log(...args: unknown[]): void };

    log._log(`text ${secret}`);

    expect(consoleCallCount()).toBe(0);
  });
});

describe('static scan: no debug log of the three owned files interpolates a value', () => {
  const FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['src/forms/FormRegistry.ts', ['_forceLog']],
    ['src/forms/EnhancedFormDetector.ts', ['_forceLog']],
    ['src/context/ContextCapture.ts', ['_log', '_warn']],
  ];
  const VALUE_NAMES =
    'value|raw|selectedValue|formStateValue|processedValue|parsed|valueDisplay|currentValue|fieldValue|newText|preview|displayText|stringValue|allInitialValues|fieldInitialValue';

  function callTexts(source: string, logger: string): string[] {
    const texts: string[] = [];
    let from = source.indexOf(`${logger}(`);
    while (from !== -1) {
      let depth = 0;
      let index = from + logger.length;
      let quote = '';
      for (; index < source.length; index += 1) {
        const char = source.charAt(index);
        if (quote) {
          if (char === '\\') {
            index += 1;
          } else if (char === quote) {
            quote = '';
          }
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
        } else if (char === '(') {
          depth += 1;
        } else if (char === ')') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      texts.push(source.slice(from, index + 1));
      from = source.indexOf(`${logger}(`, index);
    }
    return texts;
  }

  function violations(text: string): string[] {
    const unmasked = text.replace(/\w*[mM]ask\w*\([^()]*\)/g, 'MASKED');
    const found: string[] = [];
    if (new RegExp(`\\$\\{[^}]*\\b(${VALUE_NAMES})\\b`).test(unmasked)) {
      found.push('interpolated value');
    }
    if (new RegExp(`,\\s*(${VALUE_NAMES})\\s*[,)]`).test(unmasked)) {
      found.push('value argument');
    }
    if (
      /\b(fieldInitialValue|allInitialValues|fieldValue)\s*:|JSON\.stringify\(field\./.test(
        unmasked
      )
    ) {
      found.push('state dump');
    }
    if (/,\s*(element|button|wrapper|input)\s*\)/.test(unmasked)) {
      found.push('element argument');
    }
    return found;
  }

  test('the scanner flags each known leak shape and passes masked shapes (positive control)', () => {
    expect(violations('this._forceLog(`Setting ${value} now`)')).toContain('interpolated value');
    expect(violations('this._forceLog(`Set to ${String(value)}`)')).toContain('interpolated value');
    expect(violations("this._forceLog('Found initial value:', raw)")).toContain('value argument');
    expect(violations("this._log('Found selectbox:', element)")).toContain('element argument');
    expect(
      violations('this._forceLog(`x`, { fieldInitialValue: state.initialValues?.[name] })')
    ).toContain('state dump');
    expect(violations('this._forceLog(`x ${a} keys: ${Object.keys(initialValues)}`)')).toEqual([]);
    expect(violations('this._forceLog(`Set to ${DOM._mask(value)}`)')).toEqual([]);
    expect(violations("this._forceLog('keys:', Object.keys(values))")).toEqual([]);
    const sample = 'foo(); this._forceLog(`a ${(b)} ${raw}`); bar(); this._forceLog("ok");';
    expect(callTexts(sample, '_forceLog')).toEqual([
      '_forceLog(`a ${(b)} ${raw}`)',
      '_forceLog("ok")',
    ]);
  });

  test.each(FILES)('%s has no value-bearing debug log', (file, loggers) => {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    const calls = loggers.flatMap(logger => callTexts(source, logger));
    expect(calls.length).toBeGreaterThan(10);

    const offenders = calls
      .map(text => ({ text, found: violations(text) }))
      .filter(entry => entry.found.length > 0)
      .map(entry => `${entry.found.join(',')}: ${entry.text.replace(/\s+/g, ' ').slice(0, 140)}`);

    expect(offenders).toEqual([]);
  });
});

describe('throwing listeners never flip a result', () => {
  test.each([false, true])('with debugMode %s', async debugMode => {
    document.body.innerHTML = '<input id="pw" placeholder="Password">';
    const engine = new AutomationEngine({ screenshotOnError: false, debugMode });
    engine.initialize();
    for (const type of ALL_EVENTS) {
      engine.addEventListener(type, () => {
        throw new Error(`listener failure for ${type}`);
      });
    }
    fakeDom.handlers.click = async () => {
      throw new Error('click failed');
    };

    const ok = await engine.executeAction({
      type: 'fill',
      parameters: { selector: 'Password', value: 'abc' },
    });
    const failed = await engine.executeAction({ type: 'click', parameters: { selector: '#x' } });

    expect(ok).toMatchObject({ success: true, status: 'completed', effect: 'applied' });
    expect(failed).toMatchObject({
      success: false,
      status: 'failed',
      errorCode: 'EXECUTION_FAILED',
    });
    expect(failed.error).toBe('click failed');
    engine.dispose();
  });

  test('a listener that removes itself or adds another during an emit does not disturb delivery', async () => {
    const engine = new AutomationEngine({ screenshotOnError: false });
    engine.initialize();
    const seen: string[] = [];
    const first = (): void => {
      seen.push('first');
      engine.removeEventListener('action_started', first);
      engine.addEventListener('action_started', () => seen.push('late'));
    };
    engine.addEventListener('action_started', first);
    engine.addEventListener('action_started', () => seen.push('second'));

    await engine.executeAction({ type: 'wait', parameters: { duration: '1' } });

    expect(seen.slice(0, 2)).toEqual(['first', 'second']);
    engine.dispose();
  });
});

describe('R15: a strict fill the command declared sensitive reports no length, through the real DOM layer', () => {
  const { DOMActions: RealDOMActions } =
    jest.requireActual<typeof import('@/actions/DOMActions')>('@/actions/DOMActions');

  function realEngine(): AutomationEngine {
    const engine = new AutomationEngine({ screenshotOnError: false });
    engine.initialize();
    const real = new RealDOMActions({ ...DEFAULT_CONFIG, screenshotOnError: false });
    real.initialize();
    (
      engine as unknown as { _actionExecutor: { _domActions: unknown } }
    )._actionExecutor._domActions = real;
    return engine;
  }

  beforeEach(() => {
    installLayoutStubs();
    mountHtml('<input id="plain" type="text"><input id="other" type="text">');
  });

  afterEach(() => {
    resetDom();
  });

  test('declared sensitive: the outcome and the completion event say empty, never how long', async () => {
    const engine = realEngine();
    const events: AutomationEvent[] = [];
    engine.addEventListener('action_completed', event => events.push(event));
    const secret = unique('Lq4-length-oracle');

    const result = await engine.executeAction({
      type: 'fill',
      parameters: { strict: 'true', selector: '#plain', value: secret },
      sensitiveParameters: ['value'],
    });

    expect(result.success).toBe(true);
    expect((document.getElementById('plain') as HTMLInputElement).value).toBe(secret);
    expect(result.data).toMatchObject({ kind: 'fill', empty: false, changed: true, matched: true });
    expect(Object.keys(result.data as object)).not.toContain('length');
    expect(JSON.stringify(events)).not.toContain('length');
    expect(JSON.stringify(result)).not.toContain(secret);
    engine.dispose();
  });

  test('not declared sensitive: the length is still reported, so the omission is caused by the declaration', async () => {
    const engine = realEngine();

    const result = await engine.executeAction({
      type: 'fill',
      parameters: { strict: 'true', selector: '#other', value: 'abcdef' },
      sensitiveParameters: ['selector'],
    });

    expect(result.data).toMatchObject({ kind: 'fill', length: 6 });
    engine.dispose();
  });
});

describe('every leaf of a declared payload is scrubbed from messages, whatever shape the payload has', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    [
      'a legacy object payload',
      (leaf: string): unknown => ({ pw: leaf, nested: { deep: [leaf] } }),
    ],
    [
      'a JSON payload nested well below four levels',
      (leaf: string): unknown => JSON.stringify({ a: { b: { c: { d: { e: { f: leaf } } } } } }),
    ],
  ])('%s', async (_label, makePayload) => {
    const leaf = unique('Nz5-leaf');
    jest
      .spyOn(FormRegistry.prototype, 'fillAnyForm')
      .mockRejectedValue(new Error(`registry rejected ${leaf}`));
    const engine = new AutomationEngine({ screenshotOnError: false });
    engine.initialize();
    const events: AutomationEvent[] = [];
    for (const type of ALL_EVENTS) {
      engine.addEventListener(type, event => events.push(event));
    }

    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: { fields: makePayload(leaf) as string },
      sensitiveParameters: ['fields'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('registry rejected');
    expect(show(result)).not.toContain(leaf);
    expect(show(events)).not.toContain(leaf);
    engine.dispose();
  });
});

describe('a debug log never prints the message of an error that third-party code wrote', () => {
  const secret = unique('Ew8-echo');

  function libraryThatEchoes(): FormLibrary {
    return {
      isCompatible: () => true,
      getFormAPI: () => ({
        change: (_field: string, value: unknown): void => {
          throw new Error(`rejected value ${String(value)}`);
        },
        getState: () => ({}),
        submit: (): void => undefined,
        reset: (): void => undefined,
        batch: (updates: () => void): void => updates(),
      }),
    } as unknown as FormLibrary;
  }

  test('with sensitiveParameters only (no redactor), the registry logs the error name and nothing else of it', async () => {
    document.body.innerHTML = '<form id="echo"><input name="email"></form>';
    const engine = new AutomationEngine({ screenshotOnError: false, debugMode: true });
    engine.initialize(libraryThatEchoes());

    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: { formId: 'echo', fields: JSON.stringify({ email: secret }) },
      sensitiveParameters: ['fields'],
    });

    expect(result.success).toBe(true);
    expect(consoleCallCount()).toBeGreaterThan(0);
    expect(consoleText()).toContain('Error');
    expect(consoleText()).not.toContain(secret);
    expect(consoleText()).not.toContain('rejected value');
    engine.dispose();
  });

  test.each([
    [
      'FormRegistry',
      (config: AutomationConfig): ((...args: unknown[]) => void) => {
        const registry = new FormRegistry(config);
        return (...args) =>
          (registry as unknown as { _forceLog(...a: unknown[]): void })._forceLog(...args);
      },
    ],
    [
      'ContextCapture',
      (config: AutomationConfig): ((...args: unknown[]) => void) => {
        const capture = new ContextCapture(config);
        return (...args) => (capture as unknown as { _log(...a: unknown[]): void })._log(...args);
      },
    ],
  ])(
    '%s: without a redactor an Error is logged as its name, with one its message is scrubbed',
    (_name, make) => {
      const bare = make({ ...DEFAULT_CONFIG, debugMode: true });
      bare(new Error(`library said ${secret}`));
      expect(consoleText()).not.toContain(secret);
      expect(consoleText()).not.toContain('library said');

      const before = consoleCallCount();
      const guarded = make({
        ...DEFAULT_CONFIG,
        debugMode: true,
        redactor: createRedactor({ secrets: [secret] }),
      });
      guarded(new Error(`library said ${secret}`));
      expect(consoleCallCount() - before).toBe(1);
      expect(consoleText()).toContain('library said');
      expect(consoleText()).not.toContain(secret);
    }
  );
});
