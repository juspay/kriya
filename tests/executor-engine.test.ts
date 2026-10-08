import { ActionExecutor } from '@/actions/ActionExecutor';
import { AutomationEngine } from '@/core/AutomationEngine';
import { ContextCapture as RealContextCapture } from '@/context/ContextCapture';
import { createAutomationEngine } from '@/index';
import type { ContextCapture } from '@/context/ContextCapture';
import type { FormRegistry } from '@/forms/FormRegistry';
import type {
  ActionCommand,
  ActionOutcome,
  AutomationConfig,
  AutomationEvent,
  ExecutionOptions,
  ExecutionResult,
  MutationGuard,
  TaskActionExecutor,
  WebAutomataAPI,
} from '@/types';
import { ACTION_TYPES, AutomationError, DEFAULT_CONFIG } from '@/types';
import { WITHHELD_TEXT } from '@/actions/parameters';
import { createRedactor } from '@/utils/redact';

type FakeMethod =
  'navigate' | 'click' | 'fill' | 'wait' | 'press' | 'select' | 'setChecked' | 'scroll';
type FakeHandler = (
  options: unknown,
  guard: MutationGuard,
  target: HTMLElement | undefined
) => Promise<unknown>;
type FakeCall = {
  readonly method: FakeMethod;
  readonly options: Record<string, unknown>;
  readonly guard: MutationGuard;
  readonly target: HTMLElement | undefined;
  readonly extra: unknown;
};
type FakeDom = {
  readonly calls: FakeCall[];
  readonly handlers: Partial<Record<FakeMethod, FakeHandler>>;
};

jest.mock('@/actions/DOMActions', () => {
  const fakeDom: FakeDom = { calls: [], handlers: {} };
  const dispatch = async (
    method: FakeMethod,
    options: Record<string, unknown>,
    guard: MutationGuard,
    target?: HTMLElement,
    extra?: unknown
  ): Promise<unknown> => {
    fakeDom.calls.push({ method, options, guard, target, extra });
    const handler = fakeDom.handlers[method];
    if (handler) {
      return handler(options, guard, target);
    }
    if (method !== 'wait') {
      guard.commit();
    }
    return undefined;
  };
  class DOMActions {
    public initialize(): void {}
    public dispose(): void {}
    public navigate(options: Record<string, unknown>, guard: MutationGuard): Promise<unknown> {
      return dispatch('navigate', options, guard);
    }
    public click(
      options: Record<string, unknown>,
      guard: MutationGuard,
      target?: HTMLElement
    ): Promise<unknown> {
      return dispatch('click', options, guard, target);
    }
    public fill(
      options: Record<string, unknown>,
      guard: MutationGuard,
      target?: HTMLElement,
      sensitive?: boolean
    ): Promise<unknown> {
      return dispatch('fill', options, guard, target, sensitive);
    }
    public wait(options: Record<string, unknown>, guard: MutationGuard): Promise<unknown> {
      return dispatch('wait', options, guard);
    }
    public press(
      options: Record<string, unknown>,
      guard: MutationGuard,
      target?: HTMLElement
    ): Promise<unknown> {
      return dispatch('press', options, guard, target);
    }
    public select(
      options: Record<string, unknown>,
      guard: MutationGuard,
      target?: HTMLElement
    ): Promise<unknown> {
      return dispatch('select', options, guard, target);
    }
    public setChecked(
      options: Record<string, unknown>,
      guard: MutationGuard,
      target?: HTMLElement
    ): Promise<unknown> {
      return dispatch('setChecked', options, guard, target);
    }
    public scroll(
      options: Record<string, unknown>,
      guard: MutationGuard,
      target?: HTMLElement
    ): Promise<unknown> {
      return dispatch('scroll', options, guard, target);
    }
  }
  return { DOMActions, __fakeDom: fakeDom };
});

const fakeDom = (jest.requireMock('@/actions/DOMActions') as { __fakeDom: FakeDom }).__fakeDom;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Compile-time seam checks: both classes satisfy the executor type the in-page host is coded against.
export const engineSeam: TaskActionExecutor = new AutomationEngine();
export const executorSeam: TaskActionExecutor = new ActionExecutor(DEFAULT_CONFIG);

const NEW_TYPE_ROWS: ReadonlyArray<readonly [string, ActionCommand, FakeMethod]> = [
  [
    'setChecked',
    { type: 'setChecked', parameters: { checked: 'true', selector: '#c' } },
    'setChecked',
  ],
  [
    'select',
    { type: 'select', parameters: { matchBy: 'label', option: 'Canada', selector: '#s' } },
    'select',
  ],
  ['scroll', { type: 'scroll', parameters: { direction: 'DOWN' } }, 'scroll'],
];

const MINIMAL_ACTIONS: Readonly<Record<(typeof ACTION_TYPES)[number], ActionCommand>> = {
  navigate: { type: 'navigate', parameters: { url: '#frag' } },
  click: { type: 'click', parameters: { selector: '#go' } },
  fill: { type: 'fill', parameters: { selector: 'x', value: 'v' } },
  fillForm: { type: 'fillForm', parameters: { fields: '{"a":"b"}' } },
  submitForm: { type: 'submitForm', parameters: {} },
  screenshot: { type: 'screenshot', parameters: {} },
  wait: { type: 'wait', parameters: { duration: '5' } },
  press: { type: 'press', parameters: { key: 'Enter' } },
  setChecked: { type: 'setChecked', parameters: { checked: 'true', selector: '#c' } },
  select: { type: 'select', parameters: { matchBy: 'index', option: '1', selector: '#s' } },
  scroll: { type: 'scroll', parameters: { direction: 'TOP' } },
};

let engine: AutomationEngine;
let events: AutomationEvent[];

function startEngine(config: Partial<typeof DEFAULT_CONFIG> = {}): void {
  engine = new AutomationEngine({ screenshotOnError: false, ...config });
  engine.initialize();
  events = [];
  for (const type of ['action_started', 'action_completed', 'action_failed'] as const) {
    engine.addEventListener(type, event => events.push(event));
  }
}

beforeEach(() => {
  fakeDom.calls.length = 0;
  for (const key of Object.keys(fakeDom.handlers)) {
    delete fakeDom.handlers[key as FakeMethod];
  }
  document.body.innerHTML =
    '<button id="go">Go</button><input id="c" type="checkbox"><select id="s"></select>';
  jest
    .spyOn(RealContextCapture.prototype, 'captureScreenshot')
    .mockResolvedValue('data:image/png;base64,AAAA');
  startEngine();
});

afterEach(() => {
  engine.dispose();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('ACTION_TYPES drive validation', () => {
  test.each([...ACTION_TYPES])('accepts the %s action type', async type => {
    const result = await engine.executeAction(MINIMAL_ACTIONS[type]);

    expect(result.errorCode).not.toBe('VALIDATION_FAILED');
    expect(result.errorCode).not.toBe('INVALID_ACTION');
    expect(typeof result.timestamp).toBe('number');
    expect(result.effect).toBeDefined();
  });

  test('an unknown type is rejected with a message built from ACTION_TYPES', async () => {
    const result = await engine.executeAction({
      type: 'hover',
      parameters: {},
    } as unknown as ActionCommand);

    expect(result.errorCode).toBe('VALIDATION_FAILED');
    for (const type of ACTION_TYPES) {
      expect(result.error).toContain(type);
    }
    expect(fakeDom.calls).toHaveLength(0);
  });
});

describe('new action types dispatch to the DOMActions methods', () => {
  test.each(NEW_TYPE_ROWS)(
    '%s reaches its method with exact options, a guard and strict semantics',
    async (_name, action, method) => {
      const target = document.getElementById('go') as HTMLElement;

      const result = await engine.executeAction(action, { target });

      expect(fakeDom.calls.map(call => call.method)).toEqual([method]);
      const call = fakeDom.calls[0] as FakeCall;
      expect(call.options.strict).toBe(true);
      expect(call.options.description).toBeUndefined();
      expect(call.target).toBe(target);
      expect(typeof call.guard.commit).toBe('function');
      expect(result.success).toBe(true);
    }
  );

  test('setChecked passes a boolean for both canonical values', async () => {
    await engine.executeAction({
      type: 'setChecked',
      parameters: { checked: 'true', selector: '#c' },
    });
    await engine.executeAction({
      type: 'setChecked',
      parameters: { checked: 'false', selector: '#c' },
    });

    expect(fakeDom.calls.map(call => call.options.checked)).toEqual([true, false]);
    expect(fakeDom.calls.map(call => call.options.selector)).toEqual(['#c', '#c']);
  });

  test('select passes matchBy, option and triggerEvents; without them a native select cannot match a blank option', async () => {
    await engine.executeAction({
      type: 'select',
      parameters: { matchBy: 'value', option: 'ca', selector: '#s', triggerEvents: 'false' },
    });
    await engine.executeAction({ type: 'select', parameters: { selector: '#s' } });
    await engine.executeAction({
      type: 'select',
      parameters: { matchBy: 'index', option: '3', selector: '#s' },
    });

    expect(fakeDom.calls[0]?.options).toMatchObject({
      matchBy: 'value',
      option: 'ca',
      triggerEvents: false,
      selector: '#s',
    });
    expect(fakeDom.calls[1]?.options).toMatchObject({
      matchBy: 'index',
      option: '',
      triggerEvents: true,
    });
    expect(fakeDom.calls[2]?.options).toMatchObject({ matchBy: 'index', option: '3' });
  });

  test('scroll passes the direction and works with neither a selector nor a target', async () => {
    const result = await engine.executeAction({
      type: 'scroll',
      parameters: { direction: 'BOTTOM' },
    });

    expect(result.success).toBe(true);
    expect(fakeDom.calls[0]?.options).toMatchObject({ direction: 'BOTTOM', strict: true });
    expect(fakeDom.calls[0]?.target).toBeUndefined();
  });

  test('element-targeted new types need a selector or a target and are rejected otherwise, value-free', async () => {
    const noTarget = await engine.executeAction({
      type: 'setChecked',
      parameters: { checked: 'true' },
    });
    const noSelect = await engine.executeAction({
      type: 'select',
      parameters: { matchBy: 'index', option: '1' },
    });

    for (const result of [noTarget, noSelect]) {
      expect(result).toMatchObject({ success: false, errorCode: 'INVALID_ACTION', effect: 'none' });
    }
    expect(fakeDom.calls).toHaveLength(0);
  });

  test('the new types validate strictly even when no strict channel is set', async () => {
    const result = await engine.executeAction({
      type: 'setChecked',
      parameters: { checked: 'yes', selector: '#c' },
    });

    expect(result).toMatchObject({ errorCode: 'VALIDATION_FAILED', effect: 'none' });
    expect(fakeDom.calls).toHaveLength(0);
  });
});

describe('ExecutionOptions plumbing and the strict precedence rule', () => {
  const clickParameters = { selector: '#go', description: 'Pay now', clickCount: '01' };

  test('with no strict channel the legacy path runs: loose parameters, description forwarded, no strict flag', async () => {
    const result = await engine.executeAction({ type: 'click', parameters: clickParameters });

    expect(result.success).toBe(true);
    const options = fakeDom.calls[0]?.options as Record<string, unknown>;
    expect(options.strict).not.toBe(true);
    expect(options.description).toBe('Pay now');
    expect(options.selector).toBe('#go');
    expect(fakeDom.calls[0]?.target).toBeUndefined();
  });

  const CHANNELS: ReadonlyArray<
    readonly [string, (target: HTMLElement) => ExecutionOptions, Record<string, string>]
  > = [
    ['options.strict', () => ({ strict: true }), {}],
    ['options.target', target => ({ target }), {}],
    ['parameters.strict', () => ({}), { strict: 'true' }],
  ];

  test.each(CHANNELS)(
    '%s alone selects strict mode: strict validation, strict dispatch, no description',
    async (_channel, makeOptions, extraParameters) => {
      const options = makeOptions(document.getElementById('go') as HTMLElement);

      const rejected = await engine.executeAction(
        { type: 'click', parameters: { ...clickParameters, ...extraParameters } },
        options
      );
      expect(rejected).toMatchObject({ errorCode: 'VALIDATION_FAILED', effect: 'none' });
      expect(fakeDom.calls).toHaveLength(0);

      const accepted = await engine.executeAction(
        {
          type: 'click',
          parameters: { selector: '#go', description: 'Pay now', ...extraParameters },
        },
        options
      );
      expect(accepted.success).toBe(true);
      const sent = fakeDom.calls[0]?.options as Record<string, unknown>;
      expect(sent.strict).toBe(true);
      expect(sent.description).toBeUndefined();
    }
  );

  test.each([
    ['options.strict', { strict: true }, {}],
    ['parameters.strict', {}, { strict: 'true' }],
  ])(
    'strict through %s with neither a target nor a selector fails INVALID_ACTION, value-free, never falling back',
    async (_channel, options, extraParameters) => {
      const result = await engine.executeAction(
        {
          type: 'fill',
          parameters: { value: 'typed-text', description: 'Email', ...extraParameters },
        },
        options
      );

      expect(result).toMatchObject({ success: false, errorCode: 'INVALID_ACTION', effect: 'none' });
      expect(result.error).not.toContain('typed-text');
      expect(fakeDom.calls).toHaveLength(0);
    }
  );

  test('strict with only a target, or only a selector, is dispatched', async () => {
    const target = document.getElementById('go') as HTMLElement;
    const withTarget = await engine.executeAction(
      { type: 'fill', parameters: { value: 'v' } },
      { target }
    );
    const withSelector = await engine.executeAction(
      { type: 'fill', parameters: { value: 'v', selector: '#go' } },
      { strict: true }
    );

    expect([withTarget.success, withSelector.success]).toEqual([true, true]);
    expect(fakeDom.calls.map(call => call.target)).toEqual([target, undefined]);
  });

  test('options.target is forwarded for click, fill, press, select, setChecked and scroll', async () => {
    const target = document.getElementById('go') as HTMLElement;
    const rows: ActionCommand[] = [
      { type: 'click', parameters: {} },
      { type: 'fill', parameters: { value: 'v' } },
      { type: 'press', parameters: { key: 'Enter' } },
      { type: 'select', parameters: {} },
      { type: 'setChecked', parameters: { checked: 'true' } },
      { type: 'scroll', parameters: { direction: 'UP' } },
    ];

    for (const row of rows) {
      const result = await engine.executeAction(row, { target });
      expect(result.success).toBe(true);
    }

    expect(fakeDom.calls.map(call => call.method)).toEqual([
      'click',
      'fill',
      'press',
      'select',
      'setChecked',
      'scroll',
    ]);
    expect(fakeDom.calls.every(call => call.target === target)).toBe(true);
  });

  test('press forwards key, implicitSubmit and strict', async () => {
    const target = document.getElementById('go') as HTMLElement;

    await engine.executeAction(
      { type: 'press', parameters: { key: ' ', implicitSubmit: 'true' } },
      { target }
    );

    expect(fakeDom.calls[0]?.options).toMatchObject({
      key: ' ',
      implicitSubmit: true,
      strict: true,
    });
  });

  test('strict fill accepts a blank value and forwards it as a blank string', async () => {
    const target = document.getElementById('go') as HTMLElement;

    const result = await engine.executeAction(
      { type: 'fill', parameters: { value: '' } },
      { target }
    );

    expect(result.success).toBe(true);
    expect(fakeDom.calls[0]?.options.value).toBe('');
  });

  test('a strict action rejected by validation never calls the DOM layer or the commit callback', async () => {
    const onCommit = jest.fn();

    const result = await engine.executeAction(
      { type: 'wait', parameters: { duration: '10', selector: '#a' } },
      { strict: true, onCommit }
    );

    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(fakeDom.calls).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('effect is always set', () => {
  const failure = (): Promise<never> => Promise.reject(new Error('handler failure'));

  test('success: applied when committed, applied for a legacy success that never reported a commit, none for a strict no-op', async () => {
    const target = document.getElementById('go') as HTMLElement;

    const committed = await engine.executeAction({
      type: 'click',
      parameters: { selector: '#go' },
    });

    fakeDom.handlers.click = async () => undefined;
    const legacyUnreported = await engine.executeAction({
      type: 'click',
      parameters: { selector: '#go' },
    });
    const strictNoop = await engine.executeAction(
      { type: 'click', parameters: { strict: 'true' } },
      { target }
    );

    expect([committed.effect, legacyUnreported.effect, strictNoop.effect]).toEqual([
      'applied',
      'applied',
      'none',
    ]);
  });

  test('failure: none before the boundary, uncertain after it', async () => {
    fakeDom.handlers.fill = failure;
    const before = await engine.executeAction({
      type: 'fill',
      parameters: { selector: 'x', value: 'v' },
    });
    fakeDom.handlers.fill = async (_options, guard) => {
      guard.commit();
      throw new Error('after the write');
    };
    const after = await engine.executeAction({
      type: 'fill',
      parameters: { selector: 'x', value: 'v' },
    });

    expect([before.effect, after.effect]).toEqual(['none', 'uncertain']);
  });

  test('wait and screenshot never claim a mutation', async () => {
    const waited = await engine.executeAction({ type: 'wait', parameters: { duration: '5' } });

    expect(waited.success).toBe(true);
    expect(waited.effect).toBe('none');
  });

  test('every result of a mixed batch carries an effect', async () => {
    fakeDom.handlers.press = failure;
    const results = await engine.executeActions([
      { type: 'click', parameters: { selector: '#go' } },
      { type: 'press', parameters: { key: 'Enter' } },
      { type: 'teleport', parameters: {} } as unknown as ActionCommand,
      { type: 'wait', parameters: { duration: '1' } },
    ]);

    expect(results.map(result => result.effect)).toEqual(['applied', 'none', 'none', 'none']);
  });

  test('events carry the effect and the error code', async () => {
    fakeDom.handlers.press = failure;
    await engine.executeAction({ type: 'click', parameters: { selector: '#go' } });
    await engine.executeAction({ type: 'press', parameters: { key: 'Enter' } });

    const completed = events.find(event => event.type === 'action_completed');
    const failed = events.find(event => event.type === 'action_failed');
    expect(completed?.data).toMatchObject({ action: 'click', effect: 'applied' });
    expect(failed?.data).toMatchObject({
      action: 'press',
      errorCode: 'EXECUTION_FAILED',
      effect: 'none',
    });
    expect(typeof failed?.data?.error).toBe('string');
  });
});

describe('strict results carry the value-free outcome', () => {
  test('the outcome the DOM layer returns is the result data in strict mode and is dropped in legacy mode', async () => {
    const target = document.getElementById('go') as HTMLElement;
    const outcome: ActionOutcome = { kind: 'click', defaultPrevented: false };
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      return outcome;
    };

    const strict = await engine.executeAction({ type: 'click', parameters: {} }, { target });
    const legacy = await engine.executeAction({ type: 'click', parameters: { selector: '#go' } });

    expect(strict.data).toEqual(outcome);
    expect(legacy.data).toBeUndefined();
  });

  test('every new type returns its outcome as data', async () => {
    const outcomes: Readonly<Record<'select' | 'setChecked' | 'scroll', ActionOutcome>> = {
      select: { kind: 'select', control: 'native', index: 2, changed: true, matched: true },
      setChecked: {
        kind: 'setChecked',
        control: 'native',
        before: false,
        after: true,
        changed: true,
        matched: true,
      },
      scroll: {
        kind: 'scroll',
        moved: true,
        before: 0,
        after: 700,
        max: 2000,
        atTop: false,
        atBottom: false,
      },
    };
    for (const method of ['select', 'setChecked', 'scroll'] as const) {
      fakeDom.handlers[method] = async (_options, guard) => {
        guard.commit();
        return outcomes[method];
      };
    }

    for (const [, action, method] of NEW_TYPE_ROWS) {
      const result = await engine.executeAction(action);
      expect(result.data).toEqual(outcomes[method as 'select' | 'setChecked' | 'scroll']);
    }
  });

  test('strict wait reports the time waited as a wait outcome; legacy wait has no data', async () => {
    fakeDom.handlers.wait = async () => {
      await sleep(30);
    };

    const strict = await engine.executeAction({
      type: 'wait',
      parameters: { strict: 'true', duration: '30' },
    });
    const legacy = await engine.executeAction({ type: 'wait', parameters: { duration: '30' } });

    expect(strict.data).toMatchObject({ kind: 'wait' });
    expect((strict.data as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(25);
    expect(legacy.data).toBeUndefined();
    expect(strict.effect).toBe('none');
  });
});

describe('onCommit and signal plumbing through the engine and createAutomationEngine', () => {
  test('the engine forwards onCommit, signal and target', async () => {
    const target = document.getElementById('go') as HTMLElement;
    const onCommit = jest.fn();

    const result = await engine.executeAction(
      { type: 'click', parameters: {} },
      { target, onCommit, signal: new AbortController().signal }
    );

    expect(result.success).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(fakeDom.calls[0]?.target).toBe(target);
  });

  test('createAutomationEngine forwards its optional options argument (decision D3)', async () => {
    const api: WebAutomataAPI = createAutomationEngine({ screenshotOnError: false });
    api.initialize();
    const target = document.getElementById('go') as HTMLElement;
    const onCommit = jest.fn();

    const forwarded = await api.executeAction(
      { type: 'click', parameters: {} },
      { target, onCommit }
    );
    expect(forwarded.success).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(fakeDom.calls[0]?.target).toBe(target);

    const controller = new AbortController();
    controller.abort();
    fakeDom.calls.length = 0;
    const cancelled = await api.executeAction(
      { type: 'click', parameters: { selector: '#go' } },
      { signal: controller.signal }
    );
    expect(cancelled).toMatchObject({ errorCode: 'EXECUTION_CANCELLED', effect: 'none' });
    expect(fakeDom.calls).toHaveLength(0);

    const strict = await api.executeAction({ type: 'click', parameters: {} }, { strict: true });
    expect(strict).toMatchObject({ errorCode: 'INVALID_ACTION', effect: 'none' });

    const legacy = await api.executeAction({ type: 'click', parameters: { selector: '#go' } });
    expect(legacy.success).toBe(true);
    api.dispose();
  });
});

describe('form and screenshot operations through the executor', () => {
  type FakeRegistry = {
    readonly fillForm: jest.Mock;
    readonly fillFormStrict: jest.Mock;
    readonly fillAnyForm: jest.Mock;
    readonly submitForm: jest.Mock;
    readonly submitAnyForm: jest.Mock;
  };

  function makeFormExecutor(): {
    readonly executor: ActionExecutor;
    readonly registry: FakeRegistry;
  } {
    const result = (success: boolean): Record<string, unknown> => ({
      success,
      fieldsCount: 2,
      filledFields: success ? ['a', 'b'] : ['a'],
      failedFields: success ? [] : ['b'],
    });
    const registry: FakeRegistry = {
      fillForm: jest.fn(async () => result(true)),
      fillFormStrict: jest.fn(
        async (_formId: string, _fields: Record<string, unknown>, guard: MutationGuard) => {
          guard.commit();
          return result(true);
        }
      ),
      fillAnyForm: jest.fn(async () => result(false)),
      submitForm: jest.fn(async () => result(true)),
      submitAnyForm: jest.fn(async () => result(true)),
    };
    const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
    executor.initialize(registry as unknown as FormRegistry, {} as unknown as ContextCapture);
    return { executor, registry };
  }

  const fields = JSON.stringify({ a: '1', b: '2' });

  test('legacy fillForm is applied on success and keeps reporting success when some fields failed', async () => {
    const { executor, registry } = makeFormExecutor();

    const named = await executor.executeAction({
      type: 'fillForm',
      parameters: { formId: 'f', fields },
    });
    const partial = await executor.executeAction({ type: 'fillForm', parameters: { fields } });

    expect(registry.fillForm).toHaveBeenCalledWith(
      'f',
      { a: '1', b: '2' },
      expect.objectContaining({ commit: expect.any(Function) }),
      expect.any(AbortSignal)
    );
    expect(registry.fillAnyForm).toHaveBeenCalledWith(
      { a: '1', b: '2' },
      expect.objectContaining({ commit: expect.any(Function) }),
      expect.any(AbortSignal)
    );
    expect([named.success, named.effect]).toEqual([true, 'applied']);
    expect([partial.success, partial.effect]).toEqual([true, 'applied']);
  });

  test('strict fillForm without a selected registered form fails before any registry mutation', async () => {
    const { executor, registry } = makeFormExecutor();

    const result = await executor.executeAction({
      type: 'fillForm',
      parameters: { strict: 'true', fields },
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'INVALID_ACTION',
      effect: 'none',
    });
    expect(registry.fillFormStrict).not.toHaveBeenCalled();
    expect(registry.fillForm).not.toHaveBeenCalled();
    expect(registry.fillAnyForm).not.toHaveBeenCalled();
    expect(result.error).not.toMatch(/"1"|"2"/);
  });

  test('strict fillForm that fully succeeds is a success', async () => {
    const { executor, registry } = makeFormExecutor();

    const result = await executor.executeAction({
      type: 'fillForm',
      parameters: { strict: 'true', formId: 'f', fields },
    });

    expect([result.success, result.effect]).toEqual([true, 'applied']);
    expect(registry.fillFormStrict).toHaveBeenCalledWith(
      'f',
      { a: '1', b: '2' },
      expect.objectContaining({ commit: expect.any(Function) })
    );
  });

  test('a registry that throws FORM_NOT_FOUND claims no mutation, any other throw claims an uncertain one', async () => {
    const { executor, registry } = makeFormExecutor();
    registry.fillForm.mockRejectedValueOnce(new AutomationError('missing form', 'FORM_NOT_FOUND'));
    registry.fillForm.mockRejectedValueOnce(
      new AutomationError('exploded midway', 'EXECUTION_FAILED')
    );

    const missing = await executor.executeAction({
      type: 'fillForm',
      parameters: { formId: 'f', fields },
    });
    const midway = await executor.executeAction({
      type: 'fillForm',
      parameters: { formId: 'f', fields },
    });

    expect([missing.errorCode, missing.effect]).toEqual(['FORM_NOT_FOUND', 'none']);
    expect([midway.errorCode, midway.effect]).toEqual(['EXECUTION_FAILED', 'uncertain']);
  });

  test('submitForm is applied; a registry that is not initialized is rejected without a mutation', async () => {
    const { executor, registry } = makeFormExecutor();
    const submitted = await executor.executeAction({
      type: 'submitForm',
      parameters: { formId: 'f' },
    });
    const any = await executor.executeAction({ type: 'submitForm', parameters: {} });
    expect(registry.submitForm).toHaveBeenCalledWith('f');
    expect(registry.submitAnyForm).toHaveBeenCalledTimes(1);
    expect([submitted.effect, any.effect]).toEqual(['applied', 'applied']);

    const bare = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
    const uninitialized: ExecutionResult = await bare.executeAction({
      type: 'submitForm',
      parameters: {},
    });
    expect(uninitialized).toMatchObject({
      success: false,
      errorCode: 'INVALID_CONFIGURATION',
      effect: 'none',
    });
  });

  test('screenshot is read-only: effect none', async () => {
    const captureScreenshot = jest.fn(async () => 'data:image/png;base64,AAAA');
    const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
    executor.initialize(
      {} as unknown as FormRegistry,
      { captureScreenshot } as unknown as ContextCapture
    );

    const result = await executor.executeAction({
      type: 'screenshot',
      parameters: { fullPage: 'true' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('data:image/png;base64,AAAA');
    expect(result.effect).toBe('none');
  });
});

describe('an executor that breaks its own contract', () => {
  test('an escaped rejection becomes a failed, uncertain, scrubbed result and a failure event', async () => {
    const spy = jest
      .spyOn(ActionExecutor.prototype, 'executeAction')
      .mockRejectedValueOnce(
        new AutomationError('internal fault near hunter2-secret', 'NETWORK_ERROR')
      )
      .mockRejectedValueOnce('not an error object');

    const first = await engine.executeAction({
      type: 'fill',
      parameters: { selector: 'x', value: 'hunter2-secret' },
      sensitiveParameters: ['value'],
    });
    const second = await engine.executeAction({ type: 'click', parameters: { selector: '#go' } });

    expect(first).toMatchObject({
      success: false,
      status: 'failed',
      errorCode: 'NETWORK_ERROR',
      effect: 'uncertain',
    });
    expect(first.error).not.toContain('hunter2-secret');
    expect(second).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_FAILED',
      effect: 'uncertain',
    });
    expect(second.error).toBe('Unknown error');
    const failures = events.filter(event => event.type === 'action_failed');
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).not.toContain('hunter2-secret');
    spy.mockRestore();
  });

  test('events are scrubbed by the engine itself even when the executor hands back an unscrubbed error or data', async () => {
    const secret = 'zz-engine-scrub-secret-5521';
    const spy = jest
      .spyOn(ActionExecutor.prototype, 'executeAction')
      .mockResolvedValueOnce({
        success: false,
        status: 'failed',
        error: `custom executor says ${secret}`,
        errorCode: 'EXECUTION_FAILED',
        timestamp: 1,
        effect: 'none',
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'completed',
        data: `payload ${secret}`,
        timestamp: 2,
        effect: 'applied',
      });
    const withSecret = (type: 'fill' | 'click'): ActionCommand => ({
      type,
      parameters: { selector: '#go', value: secret },
      sensitiveParameters: ['value'],
    });

    await engine.executeAction(withSecret('fill'));
    await engine.executeAction(withSecret('click'));

    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.filter(event => event.type === 'action_failed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'action_completed')).toHaveLength(1);
    spy.mockRestore();
  });

  test('a null action is a failed result, not a TypeError', async () => {
    const result = await engine.executeAction(null as unknown as ActionCommand);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'VALIDATION_FAILED',
      effect: 'none',
    });
  });
});

describe('listener errors never change a result (G13)', () => {
  test('a throwing listener changes nothing even in debugMode', async () => {
    engine.dispose();
    startEngine({ debugMode: true });
    for (const type of ['action_started', 'action_completed', 'action_failed'] as const) {
      engine.addEventListener(type, () => {
        throw new Error(`listener boom ${type}`);
      });
    }
    fakeDom.handlers.press = () => Promise.reject(new Error('press failed'));

    const ok = await engine.executeAction({ type: 'click', parameters: { selector: '#go' } });
    const failed = await engine.executeAction({ type: 'press', parameters: { key: 'Enter' } });

    expect(ok).toMatchObject({ success: true, status: 'completed', effect: 'applied' });
    expect(failed).toMatchObject({ success: false, errorCode: 'EXECUTION_FAILED' });
    expect(failed.error).not.toContain('listener boom');
  });
});

describe('fill tells the DOM layer whether the value is sensitive (R15)', () => {
  const fillCall = (): FakeCall | undefined => fakeDom.calls.find(call => call.method === 'fill');

  test.each([
    ['legacy', {}],
    ['strict', { strict: 'true' }],
  ])('%s fill forwards true exactly when value is declared sensitive', async (_mode, extra) => {
    await engine.executeAction({
      type: 'fill',
      parameters: { selector: '#go', value: 'v', ...extra },
      sensitiveParameters: ['value'],
    });
    expect(fillCall()?.extra).toBe(true);

    fakeDom.calls.length = 0;
    await engine.executeAction({
      type: 'fill',
      parameters: { selector: '#go', value: 'v', ...extra },
      sensitiveParameters: ['selector'],
    });
    expect(fillCall()?.extra).toBe(false);

    fakeDom.calls.length = 0;
    await engine.executeAction({
      type: 'fill',
      parameters: { selector: '#go', value: 'v', ...extra },
    });
    expect(fillCall()?.extra).toBe(false);
  });
});

describe('a fault in the scrubbing or reporting path never changes or hides a result', () => {
  const faulty = (scrubFails: boolean): AutomationConfig['redactor'] => {
    const base = createRedactor({});
    const redactor = {
      ...base,
      scrub: (text: string): string => {
        if (scrubFails) {
          throw new Error('scrub boom');
        }
        return base.scrub(text);
      },
      scrubDeep: <T>(value: T): T => {
        throw new Error('scrubDeep boom');
      },
      redactParameters: (): never => {
        throw new Error('redactParameters boom');
      },
      withSecrets: () => redactor,
    };
    return redactor;
  };

  test('a redactor that throws on every call: the committed action still resolves, the events are withheld not leaked', async () => {
    engine.dispose();
    startEngine({ redactor: faulty(true) });
    const secret = 'zz-faulty-redactor-secret-31';
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      throw new Error(`target rejected ${secret}`);
    };

    const failed = await engine.executeAction({
      type: 'click',
      parameters: { selector: '#go', note: secret },
      sensitiveParameters: ['note'],
    });
    delete fakeDom.handlers.click;
    const succeeded = await engine.executeAction({
      type: 'wait',
      parameters: { duration: '1', strict: 'true' },
    });

    expect(failed).toMatchObject({ success: false, effect: 'uncertain' });
    expect(failed.error).toBe(WITHHELD_TEXT);
    expect(succeeded).toMatchObject({ success: true, effect: 'none' });
    expect(JSON.stringify(events)).not.toContain(secret);
    const started = events.filter(event => event.type === 'action_started');
    expect(started.map(event => event.data?.parameters)).toEqual([{}, {}]);
  });

  test('a result payload the redactor cannot scrub is withheld from the event but still returned', async () => {
    engine.dispose();
    startEngine({ redactor: faulty(false) });
    fakeDom.handlers.wait = async () => ({ kind: 'wait', waitedMs: 3 });

    const result = await engine.executeAction({
      type: 'wait',
      parameters: { duration: '1', strict: 'true' },
    });

    expect(result).toMatchObject({ success: true, data: { kind: 'wait' } });
    const completed = events.find(event => event.type === 'action_completed');
    expect(completed?.data?.result).toBeUndefined();
  });

  test('an executor that never reaches a result because its error has no usable message still answers', async () => {
    const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
    executor.initialize({} as unknown as FormRegistry, {} as unknown as ContextCapture);
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get(): string {
        throw new Error('getter boom');
      },
    });
    const weird = Object.assign(new Error('x'), { message: { toString: () => 'object message' } });

    for (const thrown of [hostile, weird, 'text', null, undefined, 42]) {
      fakeDom.handlers.click = () => Promise.reject(thrown);
      const result = await executor.executeAction({
        type: 'click',
        parameters: { selector: '#go' },
      });
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.errorCode).toBe('EXECUTION_FAILED');
    }
  });

  test('a faulty redactor cannot turn a direct executor failure into a rejection', async () => {
    const executor = new ActionExecutor({
      ...DEFAULT_CONFIG,
      screenshotOnError: false,
      redactor: faulty(true),
    });
    executor.initialize({} as unknown as FormRegistry, {} as unknown as ContextCapture);
    fakeDom.handlers.click = () => Promise.reject(new Error('boom'));

    const result = await executor.executeAction({ type: 'click', parameters: { selector: '#go' } });

    expect(result).toMatchObject({ success: false, error: WITHHELD_TEXT });
  });

  test('a direct executor call without an action object is a failed result with no effect', async () => {
    const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
    executor.initialize({} as unknown as FormRegistry, {} as unknown as ContextCapture);

    for (const bad of [null, undefined, 'click', 5]) {
      const result = await executor.executeAction(bad as unknown as ActionCommand);
      expect(result).toMatchObject({
        success: false,
        errorCode: 'VALIDATION_FAILED',
        effect: 'none',
      });
    }
    expect(fakeDom.calls).toHaveLength(0);
  });
});

describe('a legacy fillForm payload that cannot write anything crosses no boundary', () => {
  test.each(['null', '5', '"text"', 'true'])(
    'fields %s: no commit callback, effect none',
    async fields => {
      const registry = {
        fillForm: jest.fn(async () => {
          throw new AutomationError('Form filling failed: unusable payload', 'EXECUTION_FAILED');
        }),
        fillAnyForm: jest.fn(async () => {
          throw new AutomationError('Form filling failed: unusable payload', 'EXECUTION_FAILED');
        }),
      };
      const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
      executor.initialize(registry as unknown as FormRegistry, {} as unknown as ContextCapture);
      const onCommit = jest.fn();

      const result = await executor.executeAction(
        { type: 'fillForm', parameters: { formId: 'f', fields } },
        { onCommit }
      );

      expect(result).toMatchObject({
        success: false,
        errorCode: 'EXECUTION_FAILED',
        effect: 'none',
      });
      expect(onCommit).not.toHaveBeenCalled();
    }
  );

  test('an object payload still commits before the registry is called, so an abort cannot slip past it', async () => {
    const order: string[] = [];
    const registry = {
      fillAnyForm: jest.fn(async () => {
        order.push('registry');
        return { success: true, fieldsCount: 1, filledFields: ['a'], failedFields: [] };
      }),
    };
    const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false });
    executor.initialize(registry as unknown as FormRegistry, {} as unknown as ContextCapture);

    const result = await executor.executeAction(
      { type: 'fillForm', parameters: { fields: '{"a":"1"}' } },
      { onCommit: () => order.push('commit') }
    );

    expect(order).toEqual(['commit', 'registry']);
    expect(result).toMatchObject({ success: true, effect: 'applied' });
  });
});
