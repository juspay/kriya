import { ActionExecutor } from '@/actions/ActionExecutor';
import { AutomationEngine } from '@/core/AutomationEngine';
import type { ContextCapture } from '@/context/ContextCapture';
import type { FormRegistry } from '@/forms/FormRegistry';
import type {
  ActionCommand,
  AutomationConfig,
  AutomationEvent,
  ExecutionResult,
  MutationGuard,
} from '@/types';
import { DEFAULT_CONFIG } from '@/types';
import { installLayoutStubs, mountHtml, resetDom } from './helpers/domHarness';

type FakeMethod =
  'navigate' | 'click' | 'fill' | 'wait' | 'press' | 'select' | 'setChecked' | 'scroll';
type FakeHandler = (
  options: unknown,
  guard: MutationGuard,
  target: HTMLElement | undefined
) => Promise<unknown>;
type FakeCall = {
  readonly method: FakeMethod;
  readonly options: unknown;
  readonly guard: MutationGuard;
  readonly target: HTMLElement | undefined;
};
type FakeDom = {
  readonly calls: FakeCall[];
  readonly handlers: Partial<Record<FakeMethod, FakeHandler>>;
};

// A DOMActions stand-in that honors the guard exactly as the real strict and legacy paths must:
// checkpoints at await points, one commit immediately before the mutation.
jest.mock('@/actions/DOMActions', () => {
  const fakeDom: FakeDom = { calls: [], handlers: {} };
  const dispatch = async (
    method: FakeMethod,
    options: unknown,
    guard: MutationGuard,
    target?: HTMLElement
  ): Promise<unknown> => {
    fakeDom.calls.push({ method, options, guard, target });
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
    public navigate(options: unknown, guard: MutationGuard): Promise<unknown> {
      return dispatch('navigate', options, guard);
    }
    public click(options: unknown, guard: MutationGuard, target?: HTMLElement): Promise<unknown> {
      return dispatch('click', options, guard, target);
    }
    public fill(options: unknown, guard: MutationGuard, target?: HTMLElement): Promise<unknown> {
      return dispatch('fill', options, guard, target);
    }
    public wait(options: unknown, guard: MutationGuard): Promise<unknown> {
      return dispatch('wait', options, guard);
    }
    public press(options: unknown, guard: MutationGuard, target?: HTMLElement): Promise<unknown> {
      return dispatch('press', options, guard, target);
    }
    public select(options: unknown, guard: MutationGuard, target?: HTMLElement): Promise<unknown> {
      return dispatch('select', options, guard, target);
    }
    public setChecked(
      options: unknown,
      guard: MutationGuard,
      target?: HTMLElement
    ): Promise<unknown> {
      return dispatch('setChecked', options, guard, target);
    }
    public scroll(options: unknown, guard: MutationGuard, target?: HTMLElement): Promise<unknown> {
      return dispatch('scroll', options, guard, target);
    }
  }
  return { DOMActions, __fakeDom: fakeDom };
});

const fakeDom = (jest.requireMock('@/actions/DOMActions') as { __fakeDom: FakeDom }).__fakeDom;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const clickAction = (extra: Partial<ActionCommand> = {}): ActionCommand => ({
  type: 'click',
  parameters: { selector: '#go' },
  ...extra,
});

function makeExecutor(config: Partial<AutomationConfig> = {}): {
  readonly executor: ActionExecutor;
  readonly captureScreenshot: jest.Mock;
} {
  const executor = new ActionExecutor({ ...DEFAULT_CONFIG, screenshotOnError: false, ...config });
  const captureScreenshot = jest.fn(async () => 'data:image/png;base64,AAAA');
  executor.initialize(
    {} as unknown as FormRegistry,
    {
      captureScreenshot,
    } as unknown as ContextCapture
  );
  return { executor, captureScreenshot };
}

beforeEach(() => {
  fakeDom.calls.length = 0;
  for (const key of Object.keys(fakeDom.handlers)) {
    delete fakeDom.handlers[key as FakeMethod];
  }
  document.body.innerHTML = '<button id="go">Go</button>';
});

afterEach(() => {
  jest.useRealTimers();
  resetDom();
});

describe('abort before the mutation boundary', () => {
  test('an already-aborted signal returns EXECUTION_CANCELLED with effect none and never reaches the DOM layer', async () => {
    const { executor, captureScreenshot } = makeExecutor({ screenshotOnError: true });
    const onCommit = jest.fn();
    const controller = new AbortController();
    controller.abort();

    const result = await executor.executeAction(clickAction(), {
      signal: controller.signal,
      onCommit,
    });

    expect(result).toMatchObject({
      success: false,
      status: 'failed',
      errorCode: 'EXECUTION_CANCELLED',
      effect: 'none',
    });
    expect(typeof result.timestamp).toBe('number');
    expect(fakeDom.calls).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
    expect(captureScreenshot).not.toHaveBeenCalled();
  });

  test('an abort before commit leaves the DOM unchanged, reports none, and answers before the operation ends', async () => {
    const { executor } = makeExecutor();
    const target = document.getElementById('go') as HTMLElement;
    let operationEnded = false;
    fakeDom.handlers.click = async (_options, guard) => {
      await sleep(250);
      operationEnded = true;
      guard.commit();
      target.dataset.clicked = 'yes';
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await executor.executeAction(clickAction(), { signal: controller.signal });
    const endedWhenAnswered = operationEnded;

    expect(result.errorCode).toBe('EXECUTION_CANCELLED');
    expect(result.effect).toBe('none');
    expect(endedWhenAnswered).toBe(false);
    await sleep(400);
    expect(target.dataset.clicked).toBeUndefined();
  });

  test('an abort during the click sleep produces no click event at all', async () => {
    const { executor } = makeExecutor();
    const button = document.getElementById('go') as HTMLButtonElement;
    const onClick = jest.fn();
    button.addEventListener('click', onClick);
    fakeDom.handlers.click = async (_options, guard) => {
      guard.checkpoint();
      await sleep(100);
      guard.commit();
      button.click();
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await executor.executeAction(clickAction(), { signal: controller.signal });
    await sleep(200);

    expect(result.errorCode).toBe('EXECUTION_CANCELLED');
    expect(result.effect).toBe('none');
    expect(onClick).not.toHaveBeenCalled();
  });

  test('a timeout before commit reports EXECUTION_TIMEOUT with effect none', async () => {
    const { executor } = makeExecutor();
    fakeDom.handlers.click = async (_options, guard) => {
      await sleep(200);
      guard.commit();
    };

    const result = await executor.executeAction(clickAction({ timeout: 30 }));

    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_TIMEOUT',
      effect: 'none',
    });
  });
});

describe('abort and timeout after the mutation boundary', () => {
  test('a timeout after commit reports uncertain, never none', async () => {
    const { executor } = makeExecutor();
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      await sleep(300);
    };

    const result = await executor.executeAction(clickAction({ timeout: 40 }));

    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_TIMEOUT',
      effect: 'uncertain',
    });
  });

  test('an abort after commit reports EXECUTION_CANCELLED with effect uncertain', async () => {
    const { executor } = makeExecutor();
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      await sleep(300);
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await executor.executeAction(clickAction(), { signal: controller.signal });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_CANCELLED',
      effect: 'uncertain',
    });
  });

  test('a failure after commit is uncertain, a failure before it is none', async () => {
    const { executor } = makeExecutor();
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      throw new Error('handler blew up after the click');
    };
    const after = await executor.executeAction(clickAction());
    fakeDom.handlers.click = async () => {
      throw new Error('stale before any mutation');
    };
    const before = await executor.executeAction(clickAction());

    expect([after.success, after.effect]).toEqual([false, 'uncertain']);
    expect([before.success, before.effect]).toEqual([false, 'none']);
  });

  test('a success is applied when it committed and none when it never did (strict no-op)', async () => {
    const { executor } = makeExecutor();
    const target = document.getElementById('go') as HTMLElement;
    const strictFill: ActionCommand = { type: 'fill', parameters: { strict: 'true', value: 'x' } };
    fakeDom.handlers.fill = async (_options, guard) => {
      guard.commit();
      return { kind: 'fill', tag: 'input', inputType: 'text', changed: true, matched: true };
    };
    const applied = await executor.executeAction(strictFill, { target });
    fakeDom.handlers.fill = async () => ({
      kind: 'fill',
      tag: 'input',
      inputType: 'text',
      changed: false,
      matched: true,
    });
    const noop = await executor.executeAction(strictFill, { target });

    expect([applied.success, applied.effect]).toEqual([true, 'applied']);
    expect([noop.success, noop.effect]).toEqual([true, 'none']);
  });
});

describe('no late mutation after the result', () => {
  test('a continuation that wakes after the timeout cannot commit or mutate', async () => {
    const { executor } = makeExecutor();
    const target = document.getElementById('go') as HTMLElement;
    let lateError: unknown;
    fakeDom.handlers.click = async (_options, guard) => {
      await sleep(70);
      try {
        guard.commit();
        target.dataset.late = '1';
      } catch (error) {
        lateError = error;
      }
    };

    const result = await executor.executeAction(clickAction({ timeout: 25 }));
    await sleep(160);

    expect(result.errorCode).toBe('EXECUTION_TIMEOUT');
    expect(target.dataset.late).toBeUndefined();
    expect((lateError as { code?: string } | undefined)?.code).toBe('EXECUTION_CANCELLED');
  });

  test('the timeout aborts the guard BEFORE the result is delivered', async () => {
    const { executor } = makeExecutor();
    let captured: MutationGuard | undefined;
    fakeDom.handlers.click = async (_options, guard) => {
      captured = guard;
      await sleep(400);
    };

    await executor.executeAction(clickAction({ timeout: 25 }));

    expect(captured).toBeDefined();
    expect(() => captured?.checkpoint()).toThrow();
    expect(captured?.committed).toBe(false);
  });

  test('an external abort also aborts the guard before the result is delivered', async () => {
    const { executor } = makeExecutor();
    let captured: MutationGuard | undefined;
    fakeDom.handlers.click = async (_options, guard) => {
      captured = guard;
      await sleep(400);
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);

    await executor.executeAction(clickAction(), { signal: controller.signal });

    expect(() => captured?.checkpoint()).toThrow();
  });
});

describe('timers and listeners are released', () => {
  test('dispose clears the pending timeout timer and resolves the in-flight action as cancelled', async () => {
    jest.useFakeTimers();
    const { executor } = makeExecutor();
    fakeDom.handlers.click = () => new Promise<never>(() => undefined);

    const pending = executor.executeAction(clickAction({ timeout: 60000 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    executor.dispose();
    const result = await pending;

    expect(jest.getTimerCount()).toBe(0);
    expect(result).toMatchObject({ success: false, errorCode: 'EXECUTION_CANCELLED' });
    expect(result.effect).toBe('none');
  });

  test('no timeout timer survives a success, a failure or a timeout', async () => {
    jest.useFakeTimers();
    const { executor } = makeExecutor();

    const ok = await executor.executeAction(clickAction({ timeout: 60000 }));
    expect([ok.success, jest.getTimerCount()]).toEqual([true, 0]);

    fakeDom.handlers.click = async () => {
      throw new Error('nope');
    };
    const failed = await executor.executeAction(clickAction({ timeout: 60000 }));
    expect([failed.success, jest.getTimerCount()]).toEqual([false, 0]);

    fakeDom.handlers.click = () => new Promise<never>(() => undefined);
    const pending = executor.executeAction(clickAction({ timeout: 100 }));
    await jest.advanceTimersByTimeAsync(100);
    const timedOut = await pending;
    expect([timedOut.errorCode, jest.getTimerCount()]).toEqual(['EXECUTION_TIMEOUT', 0]);
  });

  test('the caller signal is unlinked after every outcome', async () => {
    const { executor } = makeExecutor();
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, 'addEventListener');
    const remove = jest.spyOn(controller.signal, 'removeEventListener');

    await executor.executeAction(clickAction(), { signal: controller.signal });
    fakeDom.handlers.click = async () => {
      throw new Error('fail');
    };
    await executor.executeAction(clickAction(), { signal: controller.signal });
    fakeDom.handlers.click = () => new Promise<never>(() => undefined);
    await executor.executeAction(clickAction({ timeout: 20 }), { signal: controller.signal });

    expect(add.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
  });

  test('retryAttempts stays unused: a failed or timed-out operation runs exactly once', async () => {
    const { executor } = makeExecutor({ retryAttempts: 3 });
    fakeDom.handlers.click = async () => {
      throw new Error('boom');
    };
    await executor.executeAction(clickAction());
    expect(fakeDom.calls).toHaveLength(1);

    fakeDom.calls.length = 0;
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      await sleep(100);
    };
    const result = await executor.executeAction(clickAction({ timeout: 20 }));
    expect(result.effect).toBe('uncertain');
    expect(fakeDom.calls).toHaveLength(1);
  });
});

describe('onCommit', () => {
  test('fires once, synchronously at the first successful commit, not before and not again', async () => {
    const { executor } = makeExecutor();
    const order: string[] = [];
    fakeDom.handlers.click = async (_options, guard) => {
      order.push('before commit');
      guard.commit();
      order.push('after commit');
      guard.commit();
      order.push('after second commit');
    };

    const result = await executor.executeAction(clickAction(), {
      onCommit: () => order.push('onCommit'),
    });

    expect(result.success).toBe(true);
    expect(order).toEqual(['before commit', 'onCommit', 'after commit', 'after second commit']);
  });

  test('never fires for a strict no-op that does not commit', async () => {
    const { executor } = makeExecutor();
    const onCommit = jest.fn();
    fakeDom.handlers.setChecked = async () => ({
      kind: 'setChecked',
      control: 'native',
      before: true,
      after: true,
      changed: false,
      matched: true,
    });

    const result = await executor.executeAction(
      { type: 'setChecked', parameters: { strict: 'true', checked: 'true', selector: '#go' } },
      { onCommit }
    );

    expect([result.success, result.effect]).toEqual([true, 'none']);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('never fires for a rejection before the boundary (stale target, bad parameters, no target, pre-abort)', async () => {
    const { executor } = makeExecutor();
    const onCommit = jest.fn();
    fakeDom.handlers.click = async () => {
      throw new Error('target went stale');
    };
    await executor.executeAction(clickAction(), { onCommit });
    await executor.executeAction(
      { type: 'click', parameters: { strict: 'true', clickCount: '01', selector: '#go' } },
      { onCommit }
    );
    await executor.executeAction({ type: 'click', parameters: { strict: 'true' } }, { onCommit });
    const aborted = new AbortController();
    aborted.abort();
    await executor.executeAction(clickAction(), { onCommit, signal: aborted.signal });

    expect(onCommit).not.toHaveBeenCalled();
  });

  test('does not fire when the commit itself is refused because the action was aborted', async () => {
    const { executor } = makeExecutor();
    const onCommit = jest.fn();
    const controller = new AbortController();
    fakeDom.handlers.click = async (_options, guard) => {
      controller.abort();
      guard.commit();
    };

    const result = await executor.executeAction(clickAction(), {
      onCommit,
      signal: controller.signal,
    });

    expect(result.errorCode).toBe('EXECUTION_CANCELLED');
    expect(result.effect).toBe('none');
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('a throwing callback is swallowed and the action still completes', async () => {
    const { executor } = makeExecutor();
    const target = document.getElementById('go') as HTMLElement;
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      target.dataset.afterCommit = 'ran';
    };
    const onCommit = jest.fn(() => {
      throw new Error('callback exploded');
    });

    const result = await executor.executeAction(clickAction(), { onCommit });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect([result.success, result.effect]).toEqual([true, 'applied']);
    expect(target.dataset.afterCommit).toBe('ran');
  });
});

describe('the guard and the target reach the DOM layer', () => {
  test('every dispatch receives a live guard and options.target', async () => {
    const { executor } = makeExecutor();
    const target = document.getElementById('go') as HTMLElement;

    await executor.executeAction({ type: 'click', parameters: { strict: 'true' } }, { target });
    await executor.executeAction(
      { type: 'fill', parameters: { strict: 'true', value: 'v' } },
      { target }
    );
    await executor.executeAction(
      { type: 'press', parameters: { strict: 'true', key: 'Enter' } },
      { target }
    );

    expect(fakeDom.calls.map(call => call.method)).toEqual(['click', 'fill', 'press']);
    for (const call of fakeDom.calls) {
      expect(call.target).toBe(target);
      expect(typeof call.guard.checkpoint).toBe('function');
      expect(call.guard.committed).toBe(true);
    }
  });
});

describe('engine level cancellation', () => {
  test('a pre-aborted signal returns the cancelled result and emits no action_started', async () => {
    const engine = new AutomationEngine({ screenshotOnError: false });
    engine.initialize();
    const events: AutomationEvent[] = [];
    for (const type of ['action_started', 'action_completed', 'action_failed'] as const) {
      engine.addEventListener(type, event => events.push(event));
    }
    events.length = 0;
    const controller = new AbortController();
    controller.abort();

    const result: ExecutionResult = await engine.executeAction(clickAction(), {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      success: false,
      status: 'failed',
      errorCode: 'EXECUTION_CANCELLED',
      effect: 'none',
    });
    expect(typeof result.error).toBe('string');
    expect(events.map(event => event.type)).not.toContain('action_started');
    expect(fakeDom.calls).toHaveLength(0);
    engine.dispose();
  });

  test('a live signal passes through and aborting it mid-flight is reported with the right effect', async () => {
    const engine = new AutomationEngine({ screenshotOnError: false });
    engine.initialize();
    fakeDom.handlers.click = async (_options, guard) => {
      guard.commit();
      await sleep(300);
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await engine.executeAction(clickAction(), { signal: controller.signal });

    expect(result).toMatchObject({ errorCode: 'EXECUTION_CANCELLED', effect: 'uncertain' });
    engine.dispose();
  });
});

describe('screenshotOnError (G14)', () => {
  test('a legacy failure still takes the screenshot, as before', async () => {
    const { executor, captureScreenshot } = makeExecutor({ screenshotOnError: true });
    fakeDom.handlers.click = async () => {
      throw new Error('plain failure');
    };

    await executor.executeAction(clickAction());

    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });

  test('a strict failure does not read the page and a cancellation does not wait for html2canvas', async () => {
    const { executor, captureScreenshot } = makeExecutor({ screenshotOnError: true });
    const target = document.getElementById('go') as HTMLElement;
    fakeDom.handlers.click = async () => {
      throw new Error('strict failure');
    };
    await executor.executeAction({ type: 'click', parameters: { strict: 'true' } }, { target });

    fakeDom.handlers.click = async (_options, guard) => {
      await sleep(100);
      guard.checkpoint();
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await executor.executeAction(clickAction(), { signal: controller.signal });

    expect(captureScreenshot).not.toHaveBeenCalled();
  });
});

// The same executor wired to the REAL legacy DOM layer: proves the guard reaches the page-touching code,
// not only the stand-in above.
describe('real DOMActions legacy paths', () => {
  type RealDom = { initialize: () => void };

  function makeRealExecutor(): ActionExecutor {
    const { executor } = makeExecutor();
    const { DOMActions: RealDOMActions } =
      jest.requireActual<typeof import('@/actions/DOMActions')>('@/actions/DOMActions');
    const real: RealDom = new RealDOMActions({ ...DEFAULT_CONFIG, screenshotOnError: false });
    real.initialize();
    (executor as unknown as { _domActions: RealDom })._domActions = real;
    return executor;
  }

  function mountButton(): { readonly button: HTMLButtonElement; readonly clicks: jest.Mock } {
    installLayoutStubs();
    const root = mountHtml('<button id="real-go">Go</button>');
    const button = root.querySelector('#real-go') as HTMLButtonElement;
    const clicks = jest.fn();
    button.addEventListener('click', clicks);
    return { button, clicks };
  }

  test('a click that times out during its sleep never clicks afterwards (the late-click bug of G4)', async () => {
    const executor = makeRealExecutor();
    const { clicks } = mountButton();

    const result = await executor.executeAction({
      type: 'click',
      parameters: { selector: '#real-go' },
      timeout: 20,
    });
    await sleep(350);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_TIMEOUT',
      effect: 'none',
    });
    expect(clicks).not.toHaveBeenCalled();
  });

  test('an abort during the real click sleep produces no click and reports none', async () => {
    const executor = makeRealExecutor();
    const { clicks } = mountButton();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);

    const result = await executor.executeAction(
      { type: 'click', parameters: { selector: '#real-go' } },
      { signal: controller.signal }
    );
    await sleep(350);

    expect(result).toMatchObject({ errorCode: 'EXECUTION_CANCELLED', effect: 'none' });
    expect(clicks).not.toHaveBeenCalled();
  });

  test('without a timeout the real click still happens exactly as before and reports applied', async () => {
    const executor = makeRealExecutor();
    const { clicks } = mountButton();
    const onCommit = jest.fn();

    const result = await executor.executeAction(
      { type: 'click', parameters: { selector: '#real-go' }, timeout: 5000 },
      { onCommit }
    );

    expect([result.success, result.effect]).toEqual([true, 'applied']);
    expect(clicks).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test('a navigate that times out removes its load listener and reports uncertain', async () => {
    const executor = makeRealExecutor();
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const addSpy = jest.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'load' && listener) {
        added.push(listener);
      }
    });
    const removeSpy = jest
      .spyOn(window, 'removeEventListener')
      .mockImplementation((type, listener) => {
        if (type === 'load' && listener) {
          removed.push(listener);
        }
      });

    const result = await executor.executeAction({
      type: 'navigate',
      parameters: { url: '#kriya-nav-timeout', waitForLoad: 'true' },
      timeout: 30,
    });
    await sleep(120);
    addSpy.mockRestore();
    removeSpy.mockRestore();

    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_TIMEOUT',
      effect: 'uncertain',
    });
    expect(window.location.hash).toBe('#kriya-nav-timeout');
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });

  test('a pre-aborted navigate never touches the location', async () => {
    const executor = makeRealExecutor();
    const before = window.location.href;
    const controller = new AbortController();
    controller.abort();

    const result = await executor.executeAction(
      { type: 'navigate', parameters: { url: '#kriya-never' } },
      { signal: controller.signal }
    );

    expect(result).toMatchObject({ errorCode: 'EXECUTION_CANCELLED', effect: 'none' });
    expect(window.location.href).toBe(before);
  });

  test('a legacy fill that fails before writing reports none and one that succeeds reports applied', async () => {
    const executor = makeRealExecutor();
    document.body.innerHTML = '<input id="real-in" placeholder="Name">';
    const field = document.getElementById('real-in') as HTMLInputElement;

    const missing = await executor.executeAction({
      type: 'fill',
      parameters: { selector: 'no-such-field-zz', value: 'v' },
    });
    const filled = await executor.executeAction({
      type: 'fill',
      parameters: { selector: 'Name', value: 'Ada' },
    });

    expect([missing.success, missing.effect, field.value === 'Ada']).toEqual([false, 'none', true]);
    expect([filled.success, filled.effect]).toEqual([true, 'applied']);
  });
});
