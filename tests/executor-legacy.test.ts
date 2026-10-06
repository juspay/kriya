import { AutomationEngine } from '@/core/AutomationEngine';
import type { ActionCommand, ExecutionResult } from '@/types';
import { AutomationError } from '@/types';

function makeEngine(debugMode = false): AutomationEngine {
  const engine = new AutomationEngine({ screenshotOnError: false, debugMode });
  engine.initialize();
  return engine;
}

const input = (selector: string): HTMLInputElement =>
  document.querySelector(selector) as HTMLInputElement;

const fillAction = (parameters: Record<string, string>): ActionCommand => ({
  type: 'fill',
  parameters,
});

let engine: AutomationEngine;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  engine?.dispose();
  jest.useRealTimers();
});

describe('legacy fill', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="email" name="email" placeholder="Work email" class="f" value="">
      <textarea id="note" name="note" placeholder="Notes"></textarea>
      <select id="country" name="country">
        <option value="">Choose</option>
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>
      <select id="plan" name="plan">
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </select>`;
    engine = makeEngine();
  });

  test('a selector that is really text still fills, exactly as before', async () => {
    const result = await engine.executeAction(
      fillAction({ selector: 'Work email', value: 'user@example.test' })
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.data).toBeUndefined();
    expect(input('#email').value).toBe('user@example.test');
  });

  test('a CSS selector fill still fails as before (pinned legacy behavior)', async () => {
    for (const selector of ['#email', '.f', 'input[name="email"]']) {
      const result = await engine.executeAction(
        fillAction({ selector, value: 'nope@example.test' })
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('ELEMENT_NOT_FOUND');
      expect(result.error).toBe('Element is not fillable');
    }
    expect(input('#email').value).toBe('');
  });

  test('a blank value now clears an input, a textarea and a select with an empty option', async () => {
    input('#email').value = 'old@example.test';
    (document.getElementById('note') as HTMLTextAreaElement).value = 'old note';
    (document.getElementById('country') as HTMLSelectElement).value = 'ca';

    const email = await engine.executeAction(fillAction({ selector: 'Work email', value: '' }));
    const note = await engine.executeAction(fillAction({ selector: 'Notes', value: '' }));
    const country = await engine.executeAction(fillAction({ selector: 'country', value: '' }));

    expect([email.success, note.success, country.success]).toEqual([true, true, true]);
    expect(input('#email').value).toBe('');
    expect((document.getElementById('note') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('country') as HTMLSelectElement).value).toBe('');
  });

  test('a blank value fires the same input and change events as any other fill', async () => {
    input('#email').value = 'old@example.test';
    const seen: string[] = [];
    input('#email').addEventListener('input', () => seen.push('input'));
    input('#email').addEventListener('change', () => seen.push('change'));

    await engine.executeAction(fillAction({ selector: 'Work email', value: '' }));

    expect(seen).toEqual(['input', 'change']);
  });

  test('a blank value on a select without an empty option fails and the select is unchanged', async () => {
    const result = await engine.executeAction(fillAction({ selector: 'plan', value: '' }));

    expect(result.success).toBe(false);
    expect((document.getElementById('plan') as HTMLSelectElement).value).toBe('a');
  });

  test('a missing value is still rejected with the legacy message and nothing changes', async () => {
    input('#email').value = 'keep@example.test';
    const bad: unknown[] = [undefined, null, 0, false];

    for (const value of bad) {
      const result = await engine.executeAction({
        type: 'fill',
        parameters: { selector: 'Work email', value } as unknown as Record<string, string>,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('VALIDATION_FAILED');
      expect(result.error).toBe('Fill action requires value parameter');
    }
    const absent = await engine.executeAction(fillAction({ selector: 'Work email' }));
    expect(absent.errorCode).toBe('VALIDATION_FAILED');
    expect(input('#email').value).toBe('keep@example.test');
  });

  test('a non-empty value still works after the presence check replaced the truthiness check', async () => {
    const result = await engine.executeAction(fillAction({ selector: 'Work email', value: '0' }));

    expect(result.success).toBe(true);
    expect(input('#email').value).toBe('0');
  });
});

describe('legacy wait honors its condition (G9)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="toggle">Toggle</button>';
    engine = makeEngine();
    jest.useFakeTimers();
  });

  // Runs the action under fake time and reports whether it settled within `ms` of virtual time.
  async function settleWithin(
    action: ActionCommand,
    ms: number
  ): Promise<{ readonly settled: boolean; readonly result: ExecutionResult | undefined }> {
    let result: ExecutionResult | undefined;
    const pending = engine.executeAction(action).then(value => {
      result = value;
    });
    await jest.advanceTimersByTimeAsync(ms);
    const settled = result !== undefined;
    if (!settled) {
      await jest.advanceTimersByTimeAsync(70000);
    }
    await pending;
    return { settled, result };
  }

  test('selector with condition is decided by the condition, not by a one second sleep', async () => {
    const { settled, result } = await settleWithin(
      { type: 'wait', parameters: { selector: '#toggle', condition: 'enabled' }, timeout: 5000 },
      50
    );

    expect(settled).toBe(true);
    expect(result?.success).toBe(true);
  });

  test('a condition that is never met times out instead of reporting success after one second', async () => {
    const { settled, result } = await settleWithin(
      { type: 'wait', parameters: { selector: '#toggle', condition: 'disabled' }, timeout: 250 },
      400
    );

    expect(settled).toBe(true);
    expect(result?.success).toBe(false);
    expect(result?.errorCode).toBe('EXECUTION_TIMEOUT');
  });

  test('a condition that becomes true later ends the wait at that moment', async () => {
    const toggle = document.getElementById('toggle') as HTMLButtonElement;
    toggle.disabled = true;
    let result: ExecutionResult | undefined;
    const pending = engine
      .executeAction({
        type: 'wait',
        parameters: { selector: '#toggle', condition: 'enabled' },
        timeout: 5000,
      })
      .then(value => {
        result = value;
      });

    await jest.advanceTimersByTimeAsync(250);
    expect(result).toBeUndefined();
    toggle.disabled = false;
    await jest.advanceTimersByTimeAsync(200);
    await pending;

    expect(result?.success).toBe(true);
  });

  test('a missing element satisfies hidden but not visible', async () => {
    const hidden = await settleWithin(
      { type: 'wait', parameters: { selector: '#absent-zz', condition: 'hidden' }, timeout: 1000 },
      50
    );
    const visible = await settleWithin(
      { type: 'wait', parameters: { selector: '#absent-zz', condition: 'visible' }, timeout: 200 },
      300
    );

    expect(hidden.result?.success).toBe(true);
    expect(visible.result?.errorCode).toBe('EXECUTION_TIMEOUT');
  });

  test('an explicit duration still wins over a condition', async () => {
    const { settled, result } = await settleWithin(
      {
        type: 'wait',
        parameters: { duration: '20', selector: '#absent-zz', condition: 'visible' },
        timeout: 5000,
      },
      60
    );

    expect(settled).toBe(true);
    expect(result?.success).toBe(true);
  });

  test.each([
    ['a bare wait', {}],
    ['a selector without a condition', { selector: '#toggle' }],
    ['a condition without a selector', { condition: 'visible' }],
  ])('%s keeps the legacy one second default', async (_label, parameters) => {
    let settled = false;
    const result = engine.executeAction({ type: 'wait', parameters, timeout: 5000 }).then(r => {
      settled = true;
      return r;
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect((await result).success).toBe(true);
  });
});

describe('the one-argument executeAction(action) form is unchanged', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="email" placeholder="Work email">';
    engine = makeEngine();
  });

  test('a success has the legacy shape plus the new effect', async () => {
    const result: ExecutionResult = await engine.executeAction(
      fillAction({ selector: 'Work email', value: 'a@b.test' })
    );

    expect(result).toEqual({
      success: true,
      status: 'completed',
      data: undefined,
      timestamp: expect.any(Number),
      effect: 'applied',
    });
  });

  test('a failure has the legacy shape plus the new effect', async () => {
    const result = await engine.executeAction({
      type: 'click',
      parameters: { selector: '#does-not-exist-zz' },
    });

    expect(result).toEqual({
      success: false,
      status: 'failed',
      error: expect.any(String),
      errorCode: 'ELEMENT_NOT_FOUND',
      timestamp: expect.any(Number),
      effect: 'none',
    });
  });

  test('loosely typed and unknown parameters are still accepted in legacy mode', async () => {
    const result = await engine.executeAction(
      fillAction({
        selector: 'Work email',
        value: 'a@b.test',
        clearFirst: 'maybe',
        triggerEvents: 'sometimes',
        somethingElse: 'x',
      })
    );

    expect(result.success).toBe(true);
    expect(input('#email').value).toBe('a@b.test');
  });

  test('screenshot, navigate and press keep their legacy argument handling', async () => {
    const navigate = await engine.executeAction({ type: 'navigate', parameters: {} });
    expect(navigate.errorCode).toBe('VALIDATION_FAILED');
    expect(navigate.error).toBe('Navigate action requires url parameter');

    const press = await engine.executeAction({ type: 'press', parameters: {} });
    expect(press.errorCode).toBe('VALIDATION_FAILED');
    expect(press.error).toBe('Press action requires key parameter');
  });

  test('executeActions still stops at the first failure only in debugMode', async () => {
    const actions: ActionCommand[] = [
      { type: 'click', parameters: { selector: '#nothing-zz' } },
      fillAction({ selector: 'Work email', value: 'x@y.test' }),
    ];

    const lenient = await engine.executeActions(actions);
    engine.dispose();
    engine = makeEngine(true);
    const strictRun = await engine.executeActions(actions);

    expect(lenient.map(result => result.success)).toEqual([false, true]);
    expect(strictRun.map(result => result.success)).toEqual([false]);
  });
});

describe('invalid input converts to a result, except before initialization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    engine = makeEngine();
  });

  test('an unknown action type is a failed result that lists every valid type', async () => {
    const result = await engine.executeAction({
      type: 'teleport',
      parameters: {},
    } as unknown as ActionCommand);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(result.effect).toBe('none');
    for (const type of [
      'navigate',
      'click',
      'fill',
      'fillForm',
      'submitForm',
      'screenshot',
      'wait',
      'press',
      'setChecked',
      'select',
      'scroll',
    ]) {
      expect(result.error).toContain(type);
    }
  });

  test('a missing type or a missing parameters bag is a failed result, not a rejection', async () => {
    const noType = await engine.executeAction({ parameters: {} } as unknown as ActionCommand);
    const noParameters = await engine.executeAction({ type: 'click' } as unknown as ActionCommand);
    const badParameters = await engine.executeAction({
      type: 'click',
      parameters: 'x',
    } as unknown as ActionCommand);

    for (const result of [noType, noParameters, badParameters]) {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('VALIDATION_FAILED');
      expect(result.effect).toBe('none');
    }
  });

  test('using the engine before initialize still throws, as before', async () => {
    const fresh = new AutomationEngine({ screenshotOnError: false });

    await expect(fresh.executeAction({ type: 'click', parameters: {} })).rejects.toBeInstanceOf(
      AutomationError
    );
  });
});

describe('legacy fillForm payload shapes keep working', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="signup">
        <input name="username" type="text">
        <input name="pw" type="password">
      </form>`;
    engine = makeEngine();
  });

  test.each([
    [
      'a nested fields object serialized as JSON',
      { fields: JSON.stringify({ username: 'bob-1' }) },
    ],
    ['a values envelope', { values: JSON.stringify({ username: 'bob-1' }) }],
    ['flat top-level entries', { username: 'bob-1' }],
  ])('fills through %s', async (_label, parameters) => {
    const result = await engine.executeAction({ type: 'fillForm', parameters });

    expect(result.success).toBe(true);
    expect((result.data as { filledFields: string[] }).filledFields).toEqual(['username']);
    expect(input('input[name=username]').value).toBe('bob-1');
  });

  test('an unusable payload is still rejected with the legacy code', async () => {
    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: { formId: 'signup' },
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
  });

  test('an unknown form id still fails with FORM_NOT_FOUND and no mutation is claimed', async () => {
    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: { formId: 'missing-form', fields: JSON.stringify({ username: 'x' }) },
    });

    expect(result.errorCode).toBe('FORM_NOT_FOUND');
    expect(result.effect).toBe('none');
  });
});
